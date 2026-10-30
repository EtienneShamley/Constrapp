import {
  CLAIM_STATUS, CLAIM_STATUS_LABELS, CLAIM_TRANSITION_STAMPS, canTransition, claimTotals,
  validateApprovedAmounts, buildClaimLine, claimedToDateCountError, validateClaimDraft,
  claimVariationLineIssue, CLAIM_VARIATION_LINE_ISSUE_LABELS,
} from './progressClaims'
import { roundMoney } from './purchaseOrders'
import { sourceLineIdentityError, isVariationOriginLine, sourceLineLabel } from './sourceLine'
import { classifyCommitmentLines } from './variations'

// ── Variation-origin source validation at CREATE (M3-B2, ADR-63) ─────────────
//
// Run by hooks/useProgressClaims.jsx INSIDE the create transaction over the
// SERVER copies of the PO and of every variation the lines name: each
// variation-origin line must be backed, right now, by a positive new-scope
// line of an approved, applied, scope-committed supplier variation on THIS PO
// with the same cost code and ceiling. Fail closed: the first problem names
// the line and the reason, and nothing is written. Rules cannot read the lines
// (DC40), so this transaction is the only source check these lines get.
export function variationSourceError(lineItems, { po, variations = [], variationIds = [] } = {}) {
  const byId = new Map()
  ;(variations ?? []).forEach((v, i) => { if (v?.id) byId.set(v.id, v); else if (variationIds[i]) byId.set(variationIds[i], null) })
  const lines = Array.isArray(lineItems) ? lineItems : []
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i]
    if (!isVariationOriginLine(li)) continue
    const variation = byId.has(li.variationId) ? byId.get(li.variationId) : null
    const issue = claimVariationLineIssue(li, { variation, po, classify: classifyCommitmentLines })
    if (issue) {
      return `Line ${i + 1} (${sourceLineLabel(li)}): ${CLAIM_VARIATION_LINE_ISSUE_LABELS[issue] ?? issue} on the server, so the claim was not created. Review the variation and try again.`
    }
  }
  return null
}

// ── Guarded progress-claim writes (ADR-58, M2-B2) ────────────────────────────
//
// Two transactions — the DRAFT EDIT and the SUBMIT / APPROVE / REJECT
// transition — on the lib/purchaseOrderActions.js convention:
//
//   1. read the SERVER copy of the claim inside the transaction
//   2. confirm it exists, is still in the status the user acted on AND still
//      holds the revision the user reviewed (STALE otherwise — another user's
//      submit, assessment or edit is never overwritten)
//   3. confirm the move is legal (lib/progressClaims.js → canTransition) and
//      the authored content valid, against the SERVER copy's lines
//   4. write exactly what the rules' branch admits: the authored content, or
//      status + the transition's (at, by) stamps (+ the certified lines, the
//      approved header and the assessment notes on approval), plus the audit
//      stamps and `revision: reviewed + 1`
//
// Firestore rules enforce 2 (partly — `revision == stored + 1`), 3 (legality,
// shape, scalar money) and 4 (stamps, actor == caller, server time)
// independently of this code. The STALE check is rules-ASSISTED, not
// rules-proven: a direct-SDK caller who reads first and writes `stored + 1`
// passes the revision rule — docs/SECURITY.md → Deferred Control 36.
//
// Firestore SDK functions are INJECTED (`runTransaction`, `serverTimestamp`)
// so this module imports no Firebase code and the emulator suite exercises the
// real transactions against the real rules.

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

// ── Draft edit ───────────────────────────────────────────────────────────────

// The exact update a draft edit writes (hooks/useProgressClaims.jsx →
// updateProgressClaim), built over the STORED lines of `live` (ADR-37: the
// stored document is the sole authority for line identity; the caller supplies
// one cumulative claimed-to-date per stored line, in stored order). Exported so
// the unit suite can pin the contract without Firestore; `now` is the injected
// serverTimestamp(). Throws ClaimWriteError(INVALID) with the readable reason.
export function draftUpdate(live, { periodEnding, claimRef, notes, retention, claimedToDate } = {}, uid, now) {
  const countError = claimedToDateCountError(live?.lineItems, claimedToDate)
  if (countError) throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, countError)
  const lineItems = live.lineItems.map((storedLine, idx) =>
    buildClaimLine(storedLine, { claimedToDate: claimedToDate[idx] })
  )
  // Includes the source-line identity check (ADR-63): a stored line whose
  // identity is malformed or duplicated — e.g. one rewritten by a pre-M3-B2
  // client — is REFUSED here rather than re-attributed to PO line 0.
  const draftError = validateClaimDraft({ lineItems, retention, poId: live?.poId })
  if (draftError) throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, draftError)
  const totals = claimTotals(lineItems.map(li => li.claimedThisPeriod), retention)
  return {
    claimRef:        claimRef?.trim() || '',
    periodEnding:    periodEnding || '',
    lineItems,
    retention:       totals.retention,
    claimedSubtotal: totals.subtotal,
    claimedGst:      totals.gst,
    claimedTotal:    totals.total,
    notes:           notes?.trim() || '',
    revision:        nextRevision(live),
    updatedAt:       now,
    updatedBy:       uid,
  }
}

export async function runUpdateClaimDraft({ db, claimRef, seen, data, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new ClaimWriteError(CLAIM_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new ClaimWriteError(CLAIM_WRITE_ERROR.MISSING)
  if (seen.status !== CLAIM_STATUS.DRAFT) {
    throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, 'Only draft claims can be edited')
  }
  // Validate against the copy the user reviewed BEFORE any read, so a plainly
  // invalid edit never opens a transaction; the same validation runs again
  // over the server copy below.
  draftUpdate(seen, data, uid, null)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(claimRef)
      if (!snap.exists()) return { kind: CLAIM_WRITE_ERROR.MISSING }
      const live = snap.data()
      const stale = staleMessage(seen, live)
      if (stale) return { kind: CLAIM_WRITE_ERROR.STALE, message: stale }
      if (live.status !== CLAIM_STATUS.DRAFT) return { kind: CLAIM_WRITE_ERROR.INVALID }
      tx.update(claimRef, draftUpdate(live, data, uid, serverTimestamp()))
      return { kind: null }
    })
  } catch (err) {
    if (err instanceof ClaimWriteError) throw err
    throw new ClaimWriteError(claimWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new ClaimWriteError(outcome.kind, outcome.message)
  return outcome
}

// ── Transitions ──────────────────────────────────────────────────────────────

// Certified amounts normalised to cents — one per line, in line order. The
// stored `claimedThisPeriod` is already whole-cent (buildClaimLine), so the
// per-line bound compares like with like and the approved header the rules
// check (Σ approved <= stored claimed subtotal, in cents) holds by construction.
export const normaliseApprovedAmounts = (approvedAmounts) =>
  (Array.isArray(approvedAmounts) ? approvedAmounts : []).map(a => roundMoney(Number(a) || 0))

// The exact update a transition writes — status, the transition's (at, by)
// pair, the two audit stamps and the revision; for APPROVE also the certified
// lines (every identity field carried from the stored line), the approved
// header (claimTotals over the certified amounts and the STORED retention —
// never rewritten) and the assessment notes; for REJECT the notes only when
// given. Exported so the unit suite can pin the contract without Firestore.
export function transitionUpdate(live, nextStatus, { approvedAmounts, assessmentNotes } = {}, uid, now) {
  const stamps = CLAIM_TRANSITION_STAMPS[nextStatus]
  if (!stamps) {
    throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, `A move to ${label(nextStatus)} is reserved and has no application path yet.`)
  }
  const base = { status: nextStatus, [stamps.at]: now, [stamps.by]: uid, revision: nextRevision(live), updatedAt: now, updatedBy: uid }

  if (nextStatus === CLAIM_STATUS.APPROVED) {
    const amounts = normaliseApprovedAmounts(approvedAmounts)
    const validationError = validateApprovedAmounts(live?.lineItems, amounts)
    if (validationError) throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, validationError)
    // ADR-63: certification freezes the lines forever, so a stored line set
    // whose source identities are malformed or duplicated is refused BEFORE it
    // can enter Actual — withdraw and re-raise the claim instead.
    const identityError = sourceLineIdentityError(live?.lineItems, { poId: live?.poId })
    if (identityError) throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, `${identityError}. Withdraw this claim and raise it again.`)
    const lineItems = live.lineItems.map((li, idx) => ({ ...li, approvedThisPeriod: amounts[idx] }))
    const totals = claimTotals(amounts, live.retention)
    return {
      ...base,
      lineItems,
      approvedSubtotal: totals.subtotal,
      approvedGst:      totals.gst,
      approvedTotal:    totals.total,
      assessmentNotes:  assessmentNotes?.trim() || '',
    }
  }
  if (nextStatus === CLAIM_STATUS.REJECTED && assessmentNotes?.trim()) {
    return { ...base, assessmentNotes: assessmentNotes.trim() }
  }
  return base
}

export async function runTransitionClaim({ db, claimRef, seen, nextStatus, extras = {}, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new ClaimWriteError(CLAIM_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new ClaimWriteError(CLAIM_WRITE_ERROR.MISSING)
  if (!canTransition(seen.status, nextStatus)) {
    throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, `Cannot move a ${label(seen.status)} progress claim to ${label(nextStatus)}.`)
  }
  // A reserved target, or invalid certified amounts, is refused BEFORE any
  // read; the amounts are validated again over the server copy below.
  transitionUpdate(seen, nextStatus, extras, uid, null)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(claimRef)
      if (!snap.exists()) return { kind: CLAIM_WRITE_ERROR.MISSING }
      const live = snap.data()
      const stale = staleMessage(seen, live)
      if (stale) return { kind: CLAIM_WRITE_ERROR.STALE, message: stale }
      if (!canTransition(live.status, nextStatus)) return { kind: CLAIM_WRITE_ERROR.INVALID }
      tx.update(claimRef, transitionUpdate(live, nextStatus, extras, uid, serverTimestamp()))
      return { kind: null }
    })
  } catch (err) {
    if (err instanceof ClaimWriteError) throw err
    throw new ClaimWriteError(claimWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new ClaimWriteError(outcome.kind, outcome.message)
  return outcome
}
