import { CLAIM_STATUS, CLAIM_STATUS_LABELS, CLAIM_TRANSITION_STAMPS, canTransition } from './progressClaims'

// ── Progress claims — the ONE remaining browser write: SUBMIT ────────────────
//
// Since ADR-93 a progress claim is created, edited, approved and rejected only
// by the trusted backend (`progressClaimOperation`, called through
// lib/supplierFinanceActions.js). Firestore Rules admit exactly one client
// update on a claim: the content-free SUBMIT (draft → submitted; only the
// status, `submittedAt` / `submittedBy`, the revision and the two audit stamps
// may change — frontend/firestore.rules → progressClaims). This module runs
// that one transaction and holds the error type the claims page presents.
//
// The draft-edit and approve / reject transactions the browser used to run
// (ADR-58 / ADR-63) are no longer production code; their exact write shapes
// are kept in tests/fixtures/legacyClientWrites.js only so the Rules suites can
// prove the rules now refuse them.
//
// Firestore SDK functions are INJECTED (`runTransaction`, `serverTimestamp`)
// so this module imports no Firebase code and the emulator suite exercises the
// real transaction against the real rules.

export const CLAIM_WRITE_ERROR = {
  STALE:      'stale',
  MISSING:    'missing',
  INVALID:    'invalid',
  PERMISSION: 'permission',
  OFFLINE:    'offline',
  UNKNOWN:    'unknown',
}

export const CLAIM_WRITE_ERROR_MESSAGES = {
  [CLAIM_WRITE_ERROR.STALE]:      'This progress claim changed since you loaded it. Review the latest version and retry — your entries are kept.',
  [CLAIM_WRITE_ERROR.MISSING]:    'This progress claim no longer exists.',
  [CLAIM_WRITE_ERROR.INVALID]:    'This change is not valid for the progress claim as it stands.',
  [CLAIM_WRITE_ERROR.PERMISSION]: 'You do not have permission to change progress claims on this project.',
  [CLAIM_WRITE_ERROR.OFFLINE]:    'Could not reach the server. Check your connection and try again — nothing was saved.',
  [CLAIM_WRITE_ERROR.UNKNOWN]:    'The change did not complete. Nothing was saved — try again.',
}

export class ClaimWriteError extends Error {
  constructor(kind, message, cause) {
    super(message ?? CLAIM_WRITE_ERROR_MESSAGES[kind] ?? CLAIM_WRITE_ERROR_MESSAGES[CLAIM_WRITE_ERROR.UNKNOWN])
    this.name = 'ClaimWriteError'
    this.kind = kind
    if (cause) this.cause = cause
  }
}

export function claimWriteErrorKind(code) {
  switch (code) {
    case 'permission-denied':  return CLAIM_WRITE_ERROR.PERMISSION
    case 'unavailable':
    case 'deadline-exceeded':  return CLAIM_WRITE_ERROR.OFFLINE
    case 'not-found':          return CLAIM_WRITE_ERROR.MISSING
    default:                   return CLAIM_WRITE_ERROR.UNKNOWN
  }
}

const label = (status) => CLAIM_STATUS_LABELS[status] ?? String(status ?? 'unknown')

// The revision a write must carry: the revision of the copy it was built over,
// plus one. Every claim the app has ever written holds `revision: 1`; a copy
// with no numeric revision reads as 0, exactly as the rules read it
// (`resource.data.get('revision', 0) + 1`).
export const storedRevision = (claim) => {
  const n = Number(claim?.revision)
  return Number.isFinite(n) ? n : 0
}
export const nextRevision = (claim) => storedRevision(claim) + 1

// The stale test shared by both transactions: the server copy must still be in
// the status the user acted on AND at the revision they reviewed.
function staleMessage(seen, live) {
  const name = seen.claimNumber || 'This progress claim'
  if (live.status !== seen.status) {
    return `${name} is now ${label(live.status)}, not ${label(seen.status)}. Review the latest version and retry — your entries are kept.`
  }
  if (storedRevision(live) !== storedRevision(seen)) {
    return `${name} was changed by another user since you loaded it. Review the latest version and retry — your entries are kept.`
  }
  return null
}

// ── Submit ───────────────────────────────────────────────────────────────────

// The exact update a submit writes — nothing else is admitted by the Rules.
export function submitUpdate(live, uid, now) {
  const stamps = CLAIM_TRANSITION_STAMPS[CLAIM_STATUS.SUBMITTED]
  return { status: CLAIM_STATUS.SUBMITTED, [stamps.at]: now, [stamps.by]: uid, revision: nextRevision(live), updatedAt: now, updatedBy: uid }
}

// `nextStatus` is kept in the signature for the hook's call; anything but a
// submit is refused before any read — approve and reject go to the backend.
export async function runTransitionClaim({ db, claimRef, seen, nextStatus, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new ClaimWriteError(CLAIM_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new ClaimWriteError(CLAIM_WRITE_ERROR.MISSING)
  if (nextStatus !== CLAIM_STATUS.SUBMITTED) {
    throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, `A move to ${label(nextStatus)} is made by the server, not by this page.`)
  }
  if (!canTransition(seen.status, nextStatus)) {
    throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, `Cannot move a ${label(seen.status)} progress claim to ${label(nextStatus)}.`)
  }
  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(claimRef)
      if (!snap.exists()) return { kind: CLAIM_WRITE_ERROR.MISSING }
      const live = snap.data()
      const stale = staleMessage(seen, live)
      if (stale) return { kind: CLAIM_WRITE_ERROR.STALE, message: stale }
      if (!canTransition(live.status, nextStatus)) return { kind: CLAIM_WRITE_ERROR.INVALID }
      tx.update(claimRef, submitUpdate(live, uid, serverTimestamp()))
      return { kind: null }
    })
  } catch (err) {
    if (err instanceof ClaimWriteError) throw err
    throw new ClaimWriteError(claimWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new ClaimWriteError(outcome.kind, outcome.message)
  return outcome
}
