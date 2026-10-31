import {
  BASELINE_STATUS, validateBaselineDraft, normaliseBaselineDraft, validateWithdrawReason,
  buildCapturePayload, programmeDrift, isSnapshotUsable,
} from './ganttBaseline'
import {
  sameActivityVersion, activityRevision,
  QUICK_ACTION_ERROR, QUICK_ACTION_ERROR_MESSAGES, quickActionErrorKind,
} from './projectTimeline'
import { QuickActionError } from './activityQuickActions'

// ── Programme baseline writes — capture, approve, withdraw (ADR-66) ──────────
//
// Three guarded writes, SDK injected (`runTransaction`, `serverTimestamp`,
// `getDocsFromServer`, the document refs and the programme query), so this
// module imports no Firebase code; the hook passes the app SDK and the
// emulator suite passes the test SDK and exercises the real transactions.
//
// CAPTURE — one FRESH SERVER READ of the programme, then ONE transaction that
// creates the header and the snapshot together:
//
//   1. `getDocsFromServer(activitiesQuery)` — the server copy, never the
//      cache (an offline client fails here rather than snapshotting stale
//      rows; nothing is written).
//   2. buildCapturePayload: every activity projected and validated; a single
//      malformed record or a duplicate id REFUSES the capture with the
//      records named; the payload is sized against the document ceiling.
//   3. tx.set(header, draft) + tx.set(snapshot, payload) in one transaction.
//      Rules require the pair (getAfter in both directions), the same actor
//      and the same server time on both, and `activityCount` to agree.
//
// ⚠️ RESIDUAL RACE, STATED PLAINLY. A single Firestore query is a consistent
// read, and the pair is atomic — but the query and the write are two
// requests. An activity edited between them is captured as the query saw it
// (its revision is stored), and the approver sees it as DRIFT. The
// transaction does not re-read the programme (2,000 reads inside a
// transaction is not a sensible client operation); no claim is made that
// the stored entries equal the live programme at commit time, and the
// immutable snapshot proves what was approved, not that every entry came
// from a genuine source record (Deferred Control 42).
//
// APPROVE — a fresh server read of the programme FIRST (the drift the
// approver must review: changed revisions, added, cancelled-since, missing),
// which must match the drift the approver acknowledged; then ONE transaction
// that reads the header (must exist, be a draft, and be the version the
// reviewer saw — revision AND stamps) and the snapshot (must exist with the
// header's activityCount), and flips the header to approved with the
// caller's stamp and `revision` + 1. The approver accepts the identified
// captured snapshot; nothing certifies that the live programme cannot
// change concurrently, and the snapshot is never touched.
//
// WITHDRAW — the same header guard, status → withdrawn with a reason.
//
// Every callback has NO side effects beyond the transaction: it returns an
// outcome, and the caller (the hook → the dialog) reacts after it settles.
// On any refusal nothing is written.

export const BASELINE_ERROR = {
  ...QUICK_ACTION_ERROR,
  DRIFT:     'drift',       // the programme changed since the approver reviewed it
  OVERSIZED: 'oversized',   // the capture would exceed the document ceiling
}

export const BASELINE_ERROR_MESSAGES = {
  ...QUICK_ACTION_ERROR_MESSAGES,
  [BASELINE_ERROR.PENDING]:    'This baseline is still saving. Wait a moment and try again.',
  [BASELINE_ERROR.MISSING]:    'This baseline no longer exists. Nothing was changed.',
  [BASELINE_ERROR.STALE]:      'Someone else changed this baseline after it was loaded. Nothing was changed — review the latest version and try again.',
  [BASELINE_ERROR.INVALID]:    'This baseline cannot be written as it stands. Nothing was written.',
  [BASELINE_ERROR.PERMISSION]: 'You do not have permission to manage programme baselines. Nothing was changed.',
  [BASELINE_ERROR.OFFLINE]:    'You appear to be offline. The programme must be read from the server to baseline it — nothing was written. Reconnect and try again.',
  [BASELINE_ERROR.UNKNOWN]:    'The baseline could not be written. Nothing was changed.',
  [BASELINE_ERROR.DRIFT]:      'The programme changed again after you reviewed it. Nothing was approved — review the changes and try again.',
  [BASELINE_ERROR.OVERSIZED]:  'This programme is too large for a single baseline. Nothing was written and nothing was truncated.',
}

export class BaselineWriteError extends QuickActionError {
  constructor(kind, message, cause, details = null) {
    super(kind, message ?? BASELINE_ERROR_MESSAGES[kind] ?? BASELINE_ERROR_MESSAGES[BASELINE_ERROR.UNKNOWN], cause)
    this.name = 'BaselineWriteError'
    // Structured extras for the dialog: the capture errors, or the drift.
    if (details) this.details = details
  }
}

// ── Server reads ─────────────────────────────────────────────────────────────

// The programme as the SERVER holds it right now. `getDocsFromServer` throws
// when the server cannot be reached — never falls back to the cache.
export async function readProgrammeFromServer({ activitiesQuery, getDocsFromServer }) {
  let snap
  try {
    snap = await getDocsFromServer(activitiesQuery)
  } catch (err) {
    throw new BaselineWriteError(quickActionErrorKind(err?.code) === BASELINE_ERROR.PERMISSION
      ? BASELINE_ERROR.PERMISSION
      : BASELINE_ERROR.OFFLINE, undefined, err)
  }
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

// ── Transaction wrapper ──────────────────────────────────────────────────────

async function guarded(runTransaction, db, body) {
  let outcome
  try {
    outcome = await runTransaction(db, body)
  } catch (err) {
    throw new BaselineWriteError(quickActionErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) {
    throw new BaselineWriteError(
      outcome.kind,
      outcome.reason ? `${BASELINE_ERROR_MESSAGES[outcome.kind]} ${outcome.reason}` : undefined,
      undefined,
      outcome.details ?? null,
    )
  }
  return outcome
}

// ── CAPTURE ──────────────────────────────────────────────────────────────────

// Returns { id, counts, bytes }. `headerRef` and `snapshotRef` share one
// random id (the hook mints it); `activitiesQuery` is the project's whole
// programme.
export async function runBaselineCapture({
  db, headerRef, snapshotRef, activitiesQuery, getDocsFromServer,
  input, uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new BaselineWriteError(BASELINE_ERROR.PERMISSION)
  const draftError = validateBaselineDraft(input)
  if (draftError) throw new BaselineWriteError(BASELINE_ERROR.INVALID, `${BASELINE_ERROR_MESSAGES[BASELINE_ERROR.INVALID]} ${draftError}`)
  const { name, reason } = normaliseBaselineDraft(input)

  // 1. The server copy of the programme — never the listener, never the cache.
  const activities = await readProgrammeFromServer({ activitiesQuery, getDocsFromServer })

  // 2. Project, validate, size. Refuses — with the records named — rather
  //    than excluding or truncating anything.
  const payload = buildCapturePayload(activities, { capturedBy: uid })
  if (!payload.ok) {
    const kind = payload.errors.length === 0 && payload.entries.length > 0 ? BASELINE_ERROR.OVERSIZED : BASELINE_ERROR.INVALID
    throw new BaselineWriteError(kind, payload.refusal, undefined, { errors: payload.errors, counts: payload.counts, bytes: payload.bytes })
  }

  // 3. The pair, in one transaction. No reads: the id is fresh and random,
  //    and rules verify the pair with getAfter() in both directions.
  await guarded(runTransaction, db, async (tx) => {
    tx.set(headerRef, {
      name,
      reason,
      status: BASELINE_STATUS.DRAFT,
      activityCount: payload.entries.length,
      approvedAt: null,
      approvedBy: null,
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawReason: '',
      revision: 1,
      createdAt: serverTimestamp(),
      createdBy: uid,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    tx.set(snapshotRef, {
      activityCount: payload.entries.length,
      capturedAt: serverTimestamp(),
      capturedBy: uid,
      activities: payload.entries,
    })
    return { kind: null }
  })
  return { id: headerRef.id, counts: payload.counts, bytes: payload.bytes }
}

// ── DRIFT CHECK (read-only) ──────────────────────────────────────────────────

// The programme drift against a draft's snapshot, from a FRESH SERVER READ.
// The approve dialog calls this when it opens; the approve action calls it
// again and compares keys.
export async function checkBaselineDrift({ activitiesQuery, getDocsFromServer, snapshot }) {
  if (!isSnapshotUsable(snapshot)) {
    throw new BaselineWriteError(BASELINE_ERROR.INVALID, `${BASELINE_ERROR_MESSAGES[BASELINE_ERROR.INVALID]} The captured snapshot cannot be read.`)
  }
  const activities = await readProgrammeFromServer({ activitiesQuery, getDocsFromServer })
  return programmeDrift(activities, snapshot)
}

// ── Header guard (shared by approve and withdraw) ────────────────────────────

// Reads the header on the server and refuses MISSING, STALE (revision OR the
// (updatedAt, updatedBy) pair differs from `seen`) and a non-draft status.
async function readDraftHeader(tx, headerRef, seen) {
  const snap = await tx.get(headerRef)
  if (!snap.exists()) return { kind: BASELINE_ERROR.MISSING }
  const current = { id: snap.id, ...snap.data() }
  if (!sameActivityVersion(seen, current)) return { kind: BASELINE_ERROR.STALE }
  if (current.status !== BASELINE_STATUS.DRAFT) {
    return { kind: BASELINE_ERROR.INVALID, reason: `This baseline is already ${current.status}.` }
  }
  return { kind: null, current }
}

// ── APPROVE ──────────────────────────────────────────────────────────────────

// `seen` is the header the reviewer opened; `snapshot` its loaded payload;
// `acknowledgedDriftKey` the key of the drift the reviewer explicitly
// reviewed ('' when they reviewed "no changes"). Returns the new revision.
export async function runBaselineApprove({
  db, headerRef, snapshotRef, activitiesQuery, getDocsFromServer,
  seen, snapshot, acknowledgedDriftKey = '', uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new BaselineWriteError(BASELINE_ERROR.PERMISSION)
  if (!seen?.updatedAt) throw new BaselineWriteError(BASELINE_ERROR.PENDING)

  // Fresh server read: the drift as it stands NOW must be the drift the
  // approver acknowledged. A programme that changed again is refused.
  const drift = await checkBaselineDrift({ activitiesQuery, getDocsFromServer, snapshot })
  if (drift.key !== (acknowledgedDriftKey ?? '')) {
    throw new BaselineWriteError(BASELINE_ERROR.DRIFT, undefined, undefined, { drift })
  }

  const outcome = await guarded(runTransaction, db, async (tx) => {
    const header = await readDraftHeader(tx, headerRef, seen)
    if (header.kind) return header
    // The immutable snapshot must be there and agree with the header.
    const payload = await tx.get(snapshotRef)
    if (!payload.exists()) return { kind: BASELINE_ERROR.INVALID, reason: 'The captured snapshot is missing.' }
    if (payload.data()?.activityCount !== header.current.activityCount) {
      return { kind: BASELINE_ERROR.INVALID, reason: 'The captured snapshot does not match this baseline.' }
    }
    const revision = activityRevision(header.current) + 1
    tx.update(headerRef, {
      status: BASELINE_STATUS.APPROVED,
      approvedAt: serverTimestamp(),
      approvedBy: uid,
      revision,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null, revision }
  })
  return outcome.revision
}

// ── WITHDRAW ─────────────────────────────────────────────────────────────────

export async function runBaselineWithdraw({
  db, headerRef, seen, reason, uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new BaselineWriteError(BASELINE_ERROR.PERMISSION)
  if (!seen?.updatedAt) throw new BaselineWriteError(BASELINE_ERROR.PENDING)
  const reasonError = validateWithdrawReason(reason)
  if (reasonError) throw new BaselineWriteError(BASELINE_ERROR.INVALID, `${BASELINE_ERROR_MESSAGES[BASELINE_ERROR.INVALID]} ${reasonError}`)

  const outcome = await guarded(runTransaction, db, async (tx) => {
    const header = await readDraftHeader(tx, headerRef, seen)
    if (header.kind) return header
    const revision = activityRevision(header.current) + 1
    tx.update(headerRef, {
      status: BASELINE_STATUS.WITHDRAWN,
      withdrawnAt: serverTimestamp(),
      withdrawnBy: uid,
      withdrawReason: String(reason).trim(),
      revision,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null, revision }
  })
  return outcome.revision
}
