import { BOQ_STATUS, boqLineAmount, isPriced, normalizeRate, validateBoqItemDraft } from './boq'

// ── Guarded BOQ item writes (ADR-52) ─────────────────────────────────────────
//
// Two transactions, one discipline — the PULSE 1B / Quant 1A convention
// (lib/pulseAcknowledgementActions.js, lib/quantActions.js):
//
//   1. read the SERVER copy of the item inside the transaction
//   2. confirm it exists and is ACTIVE
//   3. compare it with the copy the user reviewed (`seen`); refuse STALE on
//      any difference, so another user's newer quantity, rate, unit or cost
//      code is never silently overwritten
//   4. derive the amount through lib/boq.js → boqLineAmount (never a second
//      formula), stage the project currency ratchet when the item is PRICED,
//      and write with server stamps
//
// `runUpdateBoqItem` is the existing manual editor's save, now guarded.
// `runApplyBoqQuantity` is Quant 1B's explicit application of a reviewed
// measured total: it writes the item's quantity, its derived amount, the
// `quantApplied` provenance map and the stamps — nothing else.
//
// ⚠️ THE BOQ `revision` IS FROZEN AT 1 BY RULES (ADR-32), so rules cannot
// assist this guard with a +1 counter. The version check is CLIENT-ENFORCED:
// a direct-SDK client can still overwrite blindly (docs/SECURITY.md →
// Deferred Control 33). The transaction re-runs on contention, re-reads, and
// the comparison fails — the write is REFUSED, never re-applied.
//
// ⚠️ NOTHING HERE TOUCHES ANY OTHER COLLECTION. No budget line, forecast line,
// PO, claim, invoice, payment, variation, cash-flow line or baseline is read or
// written. The only document besides the item is the project, through the
// INJECTED `stageLock` (hooks/projectCurrencyLock.js) — the same ratchet every
// other monetary write stages.
//
// Firestore SDK functions are INJECTED (`runTransaction`, `serverTimestamp`,
// `stageLock`) so this module imports no Firebase code and the emulator suite
// exercises the real transactions.

export const BOQ_WRITE_ERROR = {
  STALE:      'stale',
  MISSING:    'missing',
  INVALID:    'invalid',
  PERMISSION: 'permission',
  OFFLINE:    'offline',
  UNKNOWN:    'unknown',
}

export const BOQ_WRITE_ERROR_MESSAGES = {
  [BOQ_WRITE_ERROR.STALE]:      'Another user changed this BOQ item since you loaded it. Reload the page, review it again and retry.',
  [BOQ_WRITE_ERROR.MISSING]:    'This BOQ item no longer exists.',
  [BOQ_WRITE_ERROR.INVALID]:    'This change is not valid for the BOQ item as it stands.',
  [BOQ_WRITE_ERROR.PERMISSION]: 'You do not have permission to change BOQ items on this project.',
  [BOQ_WRITE_ERROR.OFFLINE]:    'Could not reach the server. Check your connection and try again — nothing was saved.',
  [BOQ_WRITE_ERROR.UNKNOWN]:    'The save did not complete. Nothing was saved — try again.',
}

export class BoqWriteError extends Error {
  constructor(kind, message, cause) {
    super(message ?? BOQ_WRITE_ERROR_MESSAGES[kind] ?? BOQ_WRITE_ERROR_MESSAGES[BOQ_WRITE_ERROR.UNKNOWN])
    this.name = 'BoqWriteError'
    this.kind = kind
    if (cause) this.cause = cause
  }
}

export function boqWriteErrorKind(code) {
  switch (code) {
    case 'permission-denied':  return BOQ_WRITE_ERROR.PERMISSION
    case 'unavailable':
    case 'deadline-exceeded':  return BOQ_WRITE_ERROR.OFFLINE
    case 'not-found':          return BOQ_WRITE_ERROR.MISSING
    default:                   return BOQ_WRITE_ERROR.UNKNOWN
  }
}

async function guarded(runTransaction, db, body) {
  let outcome
  try {
    outcome = await runTransaction(db, body)
  } catch (err) {
    if (err instanceof BoqWriteError) throw err
    throw new BoqWriteError(boqWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new BoqWriteError(outcome.kind, outcome.message)
  return outcome
}

// ── Version comparison ───────────────────────────────────────────────────────

// Firestore Timestamps compare by value. A plain {seconds, nanoseconds} (a
// snapshot spread into state) is accepted too. Anything else is "not a stamp".
const isStamp = (t) => !!t && typeof t === 'object' && typeof t.seconds === 'number'
export function sameStamp(a, b) {
  if (!isStamp(a) || !isStamp(b)) return false
  if (typeof a.isEqual === 'function') return a.isEqual(b)
  if (typeof b.isEqual === 'function') return b.isEqual(a)
  return a.seconds === b.seconds && (a.nanoseconds ?? 0) === (b.nanoseconds ?? 0)
}

// The fields a stale write could clobber. Compared field by field when a
// usable `updatedAt` is missing on EITHER side — so a legacy or incomplete
// record is still guarded by content, never by nothing.
const GUARDED_FIELDS = ['status', 'quantity', 'unit', 'rate', 'amount', 'costCodeId', 'costCodeName', 'description', 'itemNumber', 'section', 'notes']
const same = (a, b) => (a === null || a === undefined ? b === null || b === undefined : a === b)

// Does the server copy match what the user reviewed?
//   · both carry a comparable `updatedAt` → the stamps must be equal
//   · otherwise → every guarded field must be equal
// Returns false (STALE) rather than true whenever it cannot tell.
export function boqVersionMatches(seen, server) {
  if (!seen || !server) return false
  if (isStamp(seen.updatedAt) && isStamp(server.updatedAt)) return sameStamp(seen.updatedAt, server.updatedAt)
  return GUARDED_FIELDS.every(f => same(seen[f], server[f]))
}

// ── The manual editor's save, guarded ────────────────────────────────────────
//
// `fields` is the hook's normalised content (buildFields): every editable
// field, with `amount` already derived. `seen` is the item document the editor
// opened. Behaviour is the ADR-32 edit unchanged — active-only, full content,
// ratchet when priced — plus the version check.
export async function runUpdateBoqItem({ db, itemRef, seen, fields, uid, runTransaction, serverTimestamp, stageLock }) {
  if (!uid) throw new BoqWriteError(BOQ_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new BoqWriteError(BOQ_WRITE_ERROR.MISSING)
  if (seen.status !== BOQ_STATUS.ACTIVE) throw new BoqWriteError(BOQ_WRITE_ERROR.INVALID, 'Only active BOQ items can be edited')
  const validationError = validateBoqItemDraft(fields)
  if (validationError) throw new BoqWriteError(BOQ_WRITE_ERROR.INVALID, validationError)

  return guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(itemRef)
    if (!snap.exists()) return { kind: BOQ_WRITE_ERROR.MISSING }
    const current = snap.data()
    if (current.status !== BOQ_STATUS.ACTIVE) return { kind: BOQ_WRITE_ERROR.INVALID, message: 'Only active BOQ items can be edited' }
    if (!boqVersionMatches(seen, current)) return { kind: BOQ_WRITE_ERROR.STALE }

    // All reads before any write: the ratchet read is staged here.
    const commitLock = fields.rate === null ? () => {} : await stageLock(tx)
    tx.update(itemRef, { ...fields, updatedAt: serverTimestamp(), updatedBy: uid })
    commitLock()
    return { kind: null }
  })
}

// ── Quant 1B: apply a reviewed measured total ────────────────────────────────
//
// `quantity` is the aggregate the user reviewed and confirmed (already rounded
// once — lib/quantBoq.js); `evidence` is the deterministic fingerprint of the
// eligible measurements that made it (lib/quantBoq.js → evidenceFingerprint),
// persisted so a later read can tell whether the SAME evidence still stands —
// a total and a count alone cannot (5 + 7 and 4 + 8 are both 12 from 2). The
// rate, unit and cost code come from the SERVER copy, which the version check
// has just proven equal to what was reviewed.
export const EVIDENCE_MAX_LENGTH = 128

export async function runApplyBoqQuantity({
  db, itemRef, seen, quantity, measurementCount, evidence, uid, runTransaction, serverTimestamp, stageLock,
}) {
  if (!uid) throw new BoqWriteError(BOQ_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new BoqWriteError(BOQ_WRITE_ERROR.MISSING)
  if (seen.status !== BOQ_STATUS.ACTIVE) throw new BoqWriteError(BOQ_WRITE_ERROR.INVALID, 'Only active BOQ items can receive a measured quantity')
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
    throw new BoqWriteError(BOQ_WRITE_ERROR.INVALID, 'The measured total is not a usable quantity.')
  }
  if (!Number.isInteger(measurementCount) || measurementCount < 1) {
    throw new BoqWriteError(BOQ_WRITE_ERROR.INVALID, 'At least one eligible measurement is required.')
  }
  if (typeof evidence !== 'string' || evidence.length === 0 || evidence.length > EVIDENCE_MAX_LENGTH) {
    throw new BoqWriteError(BOQ_WRITE_ERROR.INVALID, 'The reviewed evidence could not be fingerprinted. Review the measurements again.')
  }

  return guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(itemRef)
    if (!snap.exists()) return { kind: BOQ_WRITE_ERROR.MISSING }
    const current = snap.data()
    if (current.status !== BOQ_STATUS.ACTIVE) return { kind: BOQ_WRITE_ERROR.INVALID, message: 'Only active BOQ items can receive a measured quantity' }
    if (!boqVersionMatches(seen, current)) return { kind: BOQ_WRITE_ERROR.STALE }
    if (Number(current.quantity) === quantity) return { kind: BOQ_WRITE_ERROR.INVALID, message: 'The BOQ quantity already equals the measured total.' }

    const rate = normalizeRate(current.rate)
    const draftError = validateBoqItemDraft({ ...current, quantity, rate })
    if (draftError) return { kind: BOQ_WRITE_ERROR.INVALID, message: draftError }
    const amount = boqLineAmount(quantity, rate)

    const commitLock = isPriced(rate) ? await stageLock(tx) : () => {}
    tx.update(itemRef, {
      quantity,
      amount,
      // Provenance of the LATEST explicit application (ADR-52). Client-
      // authored apart from the actor and the server time (rules verify
      // those, that `quantity` equals the quantity written, and the shape of
      // `evidence`). It is a record of one confirmed action — not an audit
      // certificate.
      quantApplied: { at: serverTimestamp(), by: uid, quantity, measurementCount, evidence },
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    commitLock()
    return { kind: null, quantity, amount }
  })
}
