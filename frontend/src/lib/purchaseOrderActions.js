import { PO_STATUS, PO_STATUS_LABELS, PO_TRANSITION_STAMPS, canTransition } from './purchaseOrders'
import { PO_CANCEL_BLOCKER_KIND, poCancellationBlockers, poCancellationReason } from './poCancellation'

// ── Guarded purchase-order transitions (ADR-57, M2-B1) ───────────────────────
//
// One transaction for send, close and cancel — the PULSE 1B / Quant / BOQ
// convention (lib/boqActions.js):
//
//   1. read the SERVER copy of the PO inside the transaction
//   2. confirm it exists and is still in the status the user acted on
//      (STALE otherwise — another user's send or cancel is never overwritten)
//   3. confirm the move is legal (lib/purchaseOrders.js → canTransition)
//   4. for a CANCEL, re-read every linked claim and invoice the caller knew
//      about and re-run the strict cancellation policy against the SERVER
//      copies (lib/poCancellation.js) — BLOCKED if any still counts
//   5. write status + the transition's (at, by) stamps + the audit stamps,
//      nothing else — exactly the shape the rules' transition branches admit
//
// Firestore rules enforce 1–3 and 5 independently of this code (legality,
// stamps, actor == caller, server time). Step 4 is CLIENT-ONLY: rules cannot
// see sibling documents, and the client transaction can only re-read records
// it already knows the ids of (the Web SDK offers no query inside a
// transaction). A claim or invoice created after the subscription snapshot is
// not seen — docs/SECURITY.md → Deferred Control 35.
//
// Firestore SDK functions are INJECTED (`runTransaction`, `serverTimestamp`)
// so this module imports no Firebase code and the emulator suite exercises the
// real transaction against the real rules.

export const PO_WRITE_ERROR = {
  STALE:      'stale',
  MISSING:    'missing',
  INVALID:    'invalid',
  BLOCKED:    'blocked',
  PERMISSION: 'permission',
  OFFLINE:    'offline',
  UNKNOWN:    'unknown',
}

export const PO_WRITE_ERROR_MESSAGES = {
  [PO_WRITE_ERROR.STALE]:      'This purchase order changed since you loaded it. Reload the page, review it again and retry.',
  [PO_WRITE_ERROR.MISSING]:    'This purchase order no longer exists.',
  [PO_WRITE_ERROR.INVALID]:    'This status change is not valid for the purchase order as it stands.',
  [PO_WRITE_ERROR.BLOCKED]:    'This purchase order has linked claims, supplier invoices or supplier variations and cannot be cancelled.',
  [PO_WRITE_ERROR.PERMISSION]: 'You do not have permission to change purchase orders on this project.',
  [PO_WRITE_ERROR.OFFLINE]:    'Could not reach the server. Check your connection and try again — nothing was saved.',
  [PO_WRITE_ERROR.UNKNOWN]:    'The status change did not complete. Nothing was saved — try again.',
}

export class PoWriteError extends Error {
  constructor(kind, message, cause) {
    super(message ?? PO_WRITE_ERROR_MESSAGES[kind] ?? PO_WRITE_ERROR_MESSAGES[PO_WRITE_ERROR.UNKNOWN])
    this.name = 'PoWriteError'
    this.kind = kind
    if (cause) this.cause = cause
  }
}

export function poWriteErrorKind(code) {
  switch (code) {
    case 'permission-denied':  return PO_WRITE_ERROR.PERMISSION
    case 'unavailable':
    case 'deadline-exceeded':  return PO_WRITE_ERROR.OFFLINE
    case 'not-found':          return PO_WRITE_ERROR.MISSING
    default:                   return PO_WRITE_ERROR.UNKNOWN
  }
}

const label = (status) => PO_STATUS_LABELS[status] ?? String(status ?? 'unknown')

// The exact update a transition writes — status, the transition's own two
// stamps and the two audit stamps. Exported so the unit suite can pin the
// contract without Firestore; `now` is the injected serverTimestamp().
export function transitionUpdate(nextStatus, uid, now) {
  const stamps = PO_TRANSITION_STAMPS[nextStatus]
  if (!stamps) throw new PoWriteError(PO_WRITE_ERROR.INVALID, `No stamp is defined for a move to ${label(nextStatus)}`)
  return { status: nextStatus, [stamps.at]: now, [stamps.by]: uid, updatedAt: now, updatedBy: uid }
}

// `linkedRefs` — every claim, invoice and supplier variation the caller's
// subscriptions show against this PO, in ANY status, as [{ kind, ref }] (kind
// ∈ PO_CANCEL_BLOCKER_KIND). Re-read inside the transaction so the decision is
// made on server state; records that have since disappeared are ignored.
export async function runTransitionPurchaseOrder({
  db, poRef, seen, nextStatus, uid, runTransaction, serverTimestamp, linkedRefs = [],
}) {
  if (!uid) throw new PoWriteError(PO_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new PoWriteError(PO_WRITE_ERROR.MISSING)
  if (!canTransition(seen.status, nextStatus)) {
    throw new PoWriteError(PO_WRITE_ERROR.INVALID, `Cannot move a ${label(seen.status)} purchase order to ${label(nextStatus)}.`)
  }
  if (!PO_TRANSITION_STAMPS[nextStatus]) {
    throw new PoWriteError(PO_WRITE_ERROR.INVALID, `A move to ${label(nextStatus)} is reserved and has no application path yet.`)
  }

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(poRef)
      if (!snap.exists()) return { kind: PO_WRITE_ERROR.MISSING }
      const live = snap.data()
      if (live.status !== seen.status) {
        return {
          kind: PO_WRITE_ERROR.STALE,
          message: `${seen.poNumber || 'This purchase order'} is now ${label(live.status)}, not ${label(seen.status)}. Reload the page and review it again.`,
        }
      }
      if (!canTransition(live.status, nextStatus)) return { kind: PO_WRITE_ERROR.INVALID }

      if (nextStatus === PO_STATUS.CANCELLED) {
        // All reads before any write. Server copies decide; a vanished record
        // cannot block.
        const claims = [], invoices = [], variations = []
        for (const { kind, ref } of linkedRefs) {
          const s = await tx.get(ref)
          if (!s.exists()) continue
          const data = { id: s.id, ...s.data() }
          if (kind === PO_CANCEL_BLOCKER_KIND.CLAIM) claims.push(data)
          else if (kind === PO_CANCEL_BLOCKER_KIND.INVOICE) invoices.push(data)
          else if (kind === PO_CANCEL_BLOCKER_KIND.VARIATION) variations.push(data)
        }
        const blockers = poCancellationBlockers(seen.id, { progressClaims: claims, supplierInvoices: invoices, variations })
        if (blockers.length > 0) {
          return { kind: PO_WRITE_ERROR.BLOCKED, message: poCancellationReason(seen.poNumber, blockers), blockers }
        }
      }

      tx.update(poRef, transitionUpdate(nextStatus, uid, serverTimestamp()))
      return { kind: null }
    })
  } catch (err) {
    if (err instanceof PoWriteError) throw err
    throw new PoWriteError(poWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) {
    const e = new PoWriteError(outcome.kind, outcome.message)
    if (outcome.blockers) e.blockers = outcome.blockers
    throw e
  }
  return outcome
}
