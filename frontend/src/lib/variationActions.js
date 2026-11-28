import {
  VARIATION_STATUS, VARIATION_STATUS_LABELS, VARIATION_TRANSITION_STAMPS,
  canTransition, variationTotals, validateApprovedAmounts, buildApprovedLineItems,
  validateVariationDraft, isEligibleOriginRfi,
  isPoLinkedSupplierVariation, isCommitmentApplied, isScopeCommitted, shouldApplyOnApproval,
  commitmentApplyEligibility, COMMITMENT_APPLY_BLOCKER,
  variationCalcVersion,
} from './variations'
import {
  createVariationRequest, createVariationRequestProblem, approvedAmountsProblem,
  updateVariationRequest, updateVariationRequestProblem,
} from './variationProcessing'
import { isCommercialNotActivated, COMMERCIAL_MAINTENANCE_TEXT } from './commercialActivation'

// ── Guarded variation writes (ADR-59, M2-B3 · ADR-90) ────────────────────────
//
// SINCE ADR-90 FOUR OPERATIONS ARE PROCESSED BY THE TRUSTED BACKEND and are
// CALLS here, not transactions: CREATING a variation, EDITING A DRAFT,
// APPROVING one, and the one-time legacy APPLY / COMMIT NEW SCOPE
// (runCreateVariation, runUpdateVariationDraft, runApproveVariation,
// runApplyVariationCommitment at the foot of this file). Security Rules give a
// browser no path to any of them, so no client can write a variation's lines,
// figures, cost codes or commitment stamps. `transitionUpdate` and
// `applyCommitmentUpdate` remain the ONE description of the approve and apply
// writes — the callables run the generated copy of this module.
//
// ONE transaction remains in the browser — the SUBMIT / REJECT / WITHDRAW
// transition, which writes a status and stamps and no content — on the
// lib/progressClaimActions.js convention:
//
//   1. read the SERVER copy of the variation inside the transaction
//   2. confirm it exists, is still in the status the user acted on AND still
//      holds the revision the user reviewed (STALE otherwise — another user's
//      edit, submit or assessment is never overwritten)
//   3. confirm the move is legal (lib/variations.js → canTransition) and the
//      authored content valid; certified amounts are validated against the
//      SERVER copy's lines
//   4. write exactly what the rules' branch admits: the authored content, or
//      status + the transition's (at, by) stamps (+ the certified lines, the
//      SIGNED approved header, the notes and the dates on approval; the
//      submitted date on submit), plus the audit stamps and
//      `revision: reviewed + 1`
//
// Firestore rules enforce 2 (partly — `revision == stored + 1`), 3 (legality,
// shape, scalar money) and 4 (stamps, actor == caller, server time)
// independently of this code. The STALE check is rules-ASSISTED, not
// rules-proven: a direct-SDK caller who reads first and writes `stored + 1`
// passes the revision rule — docs/SECURITY.md → Deferred Control 37.
//
// Firestore SDK functions are INJECTED (`runTransaction`, `serverTimestamp`)
// so this module imports no Firebase code and the emulator suite exercises the
// real transactions against the real rules.

export const VARIATION_WRITE_ERROR = {
  STALE:           'stale',
  MISSING:         'missing',
  INVALID:         'invalid',
  ALREADY_APPLIED: 'already_applied', // M3-B1 — the commitment stamps are already set
  PO_INVALID:      'po_invalid',      // M3-B1 — the linked PO is missing or not sent/closed; approval refused
  PERMISSION:      'permission',
  OFFLINE:         'offline',
  UNAVAILABLE:     'unavailable',     // ADR-90 — the server operation is switched off or not deployed; nothing was saved
  UNCERTAIN:       'uncertain',       // ADR-90 — no typed answer from the server: the change MAY have been saved
  UNKNOWN:         'unknown',
}

export const VARIATION_WRITE_ERROR_MESSAGES = {
  [VARIATION_WRITE_ERROR.STALE]:           'This variation changed since you loaded it. Review the latest version and retry — your entries are kept.',
  [VARIATION_WRITE_ERROR.MISSING]:         'This variation no longer exists.',
  [VARIATION_WRITE_ERROR.INVALID]:         'This change is not valid for the variation as it stands.',
  [VARIATION_WRITE_ERROR.ALREADY_APPLIED]: 'This variation has already been applied to its purchase order commitment. Nothing was changed.',
  [VARIATION_WRITE_ERROR.PO_INVALID]:      'The linked purchase order is missing or is not sent or closed, so this variation cannot be approved. Withdraw or reject it, or raise it again against a current purchase order.',
  [VARIATION_WRITE_ERROR.PERMISSION]:      'You do not have permission to change variations on this project.',
  [VARIATION_WRITE_ERROR.OFFLINE]:         'Could not reach the server. Check your connection and try again — nothing was saved.',
  [VARIATION_WRITE_ERROR.UNAVAILABLE]:     'This action is temporarily unavailable on the server. Nothing was saved.',
  [VARIATION_WRITE_ERROR.UNCERTAIN]:       'The server did not confirm this change, so it may or may not have been saved. Check the variation register before trying again — repeating the same action is safe.',
  [VARIATION_WRITE_ERROR.UNKNOWN]:         'The change did not complete. Nothing was saved — try again.',
}

export class VariationWriteError extends Error {
  constructor(kind, message, cause) {
    super(message ?? VARIATION_WRITE_ERROR_MESSAGES[kind] ?? VARIATION_WRITE_ERROR_MESSAGES[VARIATION_WRITE_ERROR.UNKNOWN])
    this.name = 'VariationWriteError'
    this.kind = kind
    if (cause) this.cause = cause
  }
}

export function variationWriteErrorKind(code) {
  switch (code) {
    case 'permission-denied':  return VARIATION_WRITE_ERROR.PERMISSION
    case 'unavailable':
    case 'deadline-exceeded':  return VARIATION_WRITE_ERROR.OFFLINE
    case 'not-found':          return VARIATION_WRITE_ERROR.MISSING
    default:                   return VARIATION_WRITE_ERROR.UNKNOWN
  }
}

const label = (status) => VARIATION_STATUS_LABELS[status] ?? String(status ?? 'unknown')

const pad2 = (n) => String(n).padStart(2, '0')
// Today as the human 'YYYY-MM-DD' the date fields hold (local calendar day).
export function todayIso(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// The revision a write must carry: the revision of the copy it was built over,
// plus one. Every variation the app has ever written holds `revision: 1`; a
// copy with no numeric revision reads as 0, exactly as the rules read it
// (`resource.data.get('revision', 0) + 1`).
export const storedRevision = (variation) => {
  const n = Number(variation?.revision)
  return Number.isFinite(n) ? n : 0
}
export const nextRevision = (variation) => storedRevision(variation) + 1

// The stale test shared by both transactions: the server copy must still be in
// the status the user acted on AND at the revision they reviewed.
function staleMessage(seen, live) {
  const name = seen.variationNumber || 'This variation'
  if (live.status !== seen.status) {
    return `${name} is now ${label(live.status)}, not ${label(seen.status)}. Review the latest version and retry — your entries are kept.`
  }
  if (storedRevision(live) !== storedRevision(seen)) {
    return `${name} was changed by another user since you loaded it. Review the latest version and retry — your entries are kept.`
  }
  return null
}

// ── Transitions ──────────────────────────────────────────────────────────────

// The commitment-application stamp pair (M3-B1, ADR-62): rules require
// `commitmentAppliedBy == request.auth.uid` and `commitmentAppliedAt ==
// request.time`, and admit the pair only on the approve branch of a PO-linked
// supplier variation and on the legacy Apply branch.
export const commitmentStamps = (uid, now) => ({ commitmentAppliedAt: now, commitmentAppliedBy: uid })

// The new-scope commitment pair (M3-B2, ADR-63): the SECOND, independent pair,
// written with the applied pair on every PO-linked approve (FINAL rules require
// both) and by the legacy Commit when missing. Same rules posture: actor ==
// caller, time == server, stored value null before the write.
export const scopeStamps = (uid, now) => ({ scopeCommittedAt: now, scopeCommittedBy: uid })

// The exact update a transition writes — status, the transition's (at, by)
// pair, the two audit stamps and the revision; for SUBMIT also the submitted
// date (kept when already set); for APPROVE the certified lines
// (buildApprovedLineItems over the SERVER lines — identity and tax code carried,
// signed amounts in cents, GST per line), the SIGNED approved header, the
// assessment notes, the approved / effective dates and — when `applyCommitment`
// is true (the SERVER copy of the PO is sent/closed, decided inside the
// transaction) — the commitment stamps; for REJECT the notes only when given.
// Exported so the unit suite can pin the contract without Firestore. `today` is
// injectable for tests.
export function transitionUpdate(live, nextStatus, { approvedAmounts, assessmentNotes, applyCommitment = false } = {}, uid, now, today = todayIso()) {
  const stamps = VARIATION_TRANSITION_STAMPS[nextStatus]
  if (!stamps) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, `A move to ${label(nextStatus)} is reserved and has no application path yet.`)
  }
  const base = { status: nextStatus, [stamps.at]: now, [stamps.by]: uid, revision: nextRevision(live), updatedAt: now, updatedBy: uid }

  if (nextStatus === VARIATION_STATUS.SUBMITTED) {
    return { ...base, submittedDate: live?.submittedDate || today }
  }
  if (nextStatus === VARIATION_STATUS.APPROVED) {
    // Certified under the variation's OWN calculation version (ADR-91).
    const version = variationCalcVersion(live)
    if (version === null) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'This variation records a calculation version this version of Constrap does not know.')
    const validationError = validateApprovedAmounts(live?.lineItems, approvedAmounts, assessmentNotes, version)
    if (validationError) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, validationError)
    if (applyCommitment && !isPoLinkedSupplierVariation(live)) {
      throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'Only a supplier variation that names a purchase order can be applied to a commitment.')
    }
    const lineItems = buildApprovedLineItems(live.lineItems, approvedAmounts, version)
    if (lineItems.some(li => li.approvedAmount === null || li.approvedGst === null)) {
      throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'An approved amount is above the largest Constrap supports.')
    }
    const approved  = variationTotals(lineItems, 'approved', version)
    return {
      ...base,
      lineItems,
      approvedSubtotal: approved.subtotal,
      approvedGst:      approved.gst,
      approvedTotal:    approved.total,
      assessmentNotes:  assessmentNotes?.trim() || '',
      approvedDate:     live.approvedDate || today,
      effectiveDate:    live.effectiveDate || live.approvedDate || today,
      // ADR-62 + ADR-63: approve, apply AND commit new scope in ONE write.
      ...(applyCommitment ? { ...commitmentStamps(uid, now), ...scopeStamps(uid, now) } : {}),
    }
  }
  if (nextStatus === VARIATION_STATUS.REJECTED && assessmentNotes?.trim()) {
    return { ...base, assessmentNotes: assessmentNotes.trim() }
  }
  return base
}

// SUBMIT / REJECT / WITHDRAW — the transitions a browser still writes itself.
// APPROVAL is not one of them (ADR-90): it certifies figures and applies a
// commitment, so it is processed by the trusted backend (runApproveVariation
// below) and Security Rules refuse it from any client. Asking this function to
// approve is refused before any read.
export async function runTransitionVariation({ db, variationRef, seen, nextStatus, extras = {}, uid, runTransaction, serverTimestamp, today }) {
  if (!uid) throw new VariationWriteError(VARIATION_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new VariationWriteError(VARIATION_WRITE_ERROR.MISSING)
  if (nextStatus === VARIATION_STATUS.APPROVED) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'A variation is approved by the Constrap server, not by a direct write.')
  }
  if (!canTransition(seen.status, nextStatus)) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, `Cannot move a ${label(seen.status)} variation to ${label(nextStatus)}.`)
  }
  // A reserved target is refused BEFORE any read.
  transitionUpdate(seen, nextStatus, extras, uid, null, today)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(variationRef)
      if (!snap.exists()) return { kind: VARIATION_WRITE_ERROR.MISSING }
      const live = snap.data()
      const stale = staleMessage(seen, live)
      if (stale) return { kind: VARIATION_WRITE_ERROR.STALE, message: stale }
      if (!canTransition(live.status, nextStatus)) return { kind: VARIATION_WRITE_ERROR.INVALID }
      tx.update(variationRef, transitionUpdate(live, nextStatus, extras, uid, serverTimestamp(), today))
      return { kind: null }
    })
  } catch (err) {
    if (err instanceof VariationWriteError) throw err
    throw new VariationWriteError(variationWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new VariationWriteError(outcome.kind, outcome.message)
  return outcome
}

// ── Legacy Apply / Commit new scope (M3-B1 ADR-62 · M3-B2 ADR-63) ────────────
//
// The ONE-TIME application of an already-APPROVED, PO-linked supplier variation
// whose stamp pairs are not all present: approved before M3-B1 (no pair at all)
// or applied under M3-B1 (the ADR-62 pair present, the ADR-63 scope pair
// absent). The write is EXACTLY the MISSING pair(s) + revision + audit stamps,
// nothing else — a present pair is NEVER rewritten, and approved money, lines,
// PO link and every lifecycle stamp stay frozen. Since ADR-90 the write is made
// by the trusted backend (`applyVariationCommitment`), inside a transaction
// that reads the variation and its purchase order; two users or two tabs
// cannot both commit, and Security Rules admit the stamps from no client.

// The exact update the legacy action writes: the pairs the live copy lacks.
// Composed by the callable; exported for the unit suite.
export function applyCommitmentUpdate(live, uid, now) {
  return {
    ...(isCommitmentApplied(live) ? {} : commitmentStamps(uid, now)),
    ...(isScopeCommitted(live) ? {} : scopeStamps(uid, now)),
    revision: nextRevision(live), updatedAt: now, updatedBy: uid,
  }
}

function applyBlockerKind(blocker) {
  return blocker === COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED ? VARIATION_WRITE_ERROR.ALREADY_APPLIED : VARIATION_WRITE_ERROR.INVALID
}

// ── The three server operations: the CALLS (ADR-90) ──────────────────────────
//
// Each takes an INJECTED `call(name, data)` (so this module imports no Firebase
// code) and resolves to the server's answer, or throws a VariationWriteError:
//
//   a TYPED refusal        the server says why; NOTHING WAS WRITTEN
//   a CERTAIN transport    not signed in, App Check refused, function absent —
//   failure                answered before the handler ran; nothing was written
//   UNCERTAIN              no typed answer (timeout, dropped connection,
//                          internal error): the change MAY have been saved.
//                          Never reported as "nothing was saved".
//
// ⚠️ NOTHING HERE RETRIES. A repeat is the user's decision, and it is SAFE:
// creating with the same variation id, approving with the same amounts and
// applying an applied variation are each answered `alreadyApplied` by the
// server with nothing written a second time.

export const VARIATION_CALLABLE = {
  CREATE:  'createVariation',
  UPDATE:  'updateVariationDraft',
  APPROVE: 'approveVariation',
  APPLY:   'applyVariationCommitment',
}

// The browser waits LONGER than the function may run (60 s, functions/src/
// index.js → VARIATION_CALL_OPTIONS), so the server's own answer arrives first.
export const VARIATION_CALL_TIMEOUT_MS = 70000

// details.code (functions/src/lib/errors.js) → kind. The server's own message
// is shown for the refusals whose reason the user can act on.
const TYPED = {
  'variation-processing-disabled': [VARIATION_WRITE_ERROR.UNAVAILABLE, false],
  'variation-forbidden':           [VARIATION_WRITE_ERROR.PERMISSION,  false],
  'no-membership':                 [VARIATION_WRITE_ERROR.PERMISSION,  false],
  'membership-inactive':           [VARIATION_WRITE_ERROR.PERMISSION,  false],
  'unauthenticated':               [VARIATION_WRITE_ERROR.PERMISSION,  true],
  'not-found':                     [VARIATION_WRITE_ERROR.MISSING,     false],
  'invalid-argument':              [VARIATION_WRITE_ERROR.INVALID,     false],
  'variation-invalid':             [VARIATION_WRITE_ERROR.INVALID,     true],
  'variation-id-conflict':         [VARIATION_WRITE_ERROR.INVALID,     true],
  'variation-po-invalid':          [VARIATION_WRITE_ERROR.PO_INVALID,  true],
  'variation-rfi-invalid':         [VARIATION_WRITE_ERROR.INVALID,     true],
  'variation-cost-code-invalid':   [VARIATION_WRITE_ERROR.INVALID,     true],
  'variation-not-submitted':       [VARIATION_WRITE_ERROR.STALE,       true],
  'variation-not-draft':           [VARIATION_WRITE_ERROR.STALE,       true],
  'variation-stale':               [VARIATION_WRITE_ERROR.STALE,       false],
  'variation-figures-inconsistent':[VARIATION_WRITE_ERROR.INVALID,     true],
  'variation-unsupported-record':  [VARIATION_WRITE_ERROR.INVALID,     true],
  'variation-not-applicable':      [VARIATION_WRITE_ERROR.INVALID,     true],
  'variation-amount-out-of-range': [VARIATION_WRITE_ERROR.INVALID,     true],
  'variation-busy':                [VARIATION_WRITE_ERROR.OFFLINE,     true],
  // ADR-96 — approval segregation: the server explains who may approve.
  'approval-segregation-required': [VARIATION_WRITE_ERROR.PERMISSION,  true],
}

// Untyped callable failures whose outcome is nonetheless CERTAIN: each is
// answered before the handler can run.
const CERTAIN_TRANSPORT = {
  'unauthenticated':   [VARIATION_WRITE_ERROR.PERMISSION,  'Your session has ended or this browser could not be verified. Nothing was saved — reload the page, sign in and try again.'],
  'permission-denied': [VARIATION_WRITE_ERROR.PERMISSION,  undefined],
  'not-found':         [VARIATION_WRITE_ERROR.UNAVAILABLE, 'This action is not available on the server yet. Nothing was saved.'],
  'invalid-argument':  [VARIATION_WRITE_ERROR.INVALID,     undefined],
}

export function describeVariationCallFailure(err) {
  if (err instanceof VariationWriteError) return err
  // Phase 2 company activation (lib/commercialActivation.js): CERTAIN — the
  // company is not yet switched over; nothing was written. Decided here, not
  // in TYPED: TYPED is part of the generated server bundle
  // (functions/src/generated/variationCalc.js), this function is not.
  if (isCommercialNotActivated(err)) return new VariationWriteError(VARIATION_WRITE_ERROR.UNAVAILABLE, COMMERCIAL_MAINTENANCE_TEXT, err)
  const typed = TYPED[err?.details?.code]
  if (typed) {
    const message = typed[1] && typeof err?.message === 'string' && err.message.length > 0 ? err.message : undefined
    return new VariationWriteError(typed[0], message, err)
  }
  const code = String(err?.code ?? '').replace(/^functions\//, '')
  const certain = CERTAIN_TRANSPORT[code]
  if (certain) return new VariationWriteError(certain[0], certain[1], err)
  return new VariationWriteError(VARIATION_WRITE_ERROR.UNCERTAIN, undefined, err)
}

async function invoke(call, name, data) {
  let result
  try {
    result = await call(name, data)
  } catch (err) {
    throw describeVariationCallFailure(err)
  }
  // An answer that is not the operation's own says nothing reliable.
  if (!result || typeof result !== 'object' || typeof result.alreadyApplied !== 'boolean') {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.UNCERTAIN)
  }
  return result
}

// CREATE. `variationId` is chosen by the caller ONCE per editor session and
// re-sent on a retry — it is what makes a repeat safe. `data` is what the
// editor produces (the authored fields plus its built `lineItems`); only the
// authored part is sent (lib/variationProcessing.js → createVariationRequest).
// Resolves to { variationId, variationNumber, alreadyApplied }.
export async function runCreateVariation({ call, projectId, variationId, data, uid }) {
  if (!uid) throw new VariationWriteError(VARIATION_WRITE_ERROR.PERMISSION)
  if (data?.originRfi && !isEligibleOriginRfi(data.originRfi)) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'Only open, answered or closed RFIs can originate a variation')
  }
  const draftError = validateVariationDraft({ title: data?.title, lineItems: data?.lineItems })
  if (draftError) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, draftError)
  const request = createVariationRequest({ ...data, projectId, variationId })
  if (createVariationRequestProblem(request)) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'This variation cannot be saved as entered. Check the title, the dates and every line, then try again.')
  }
  return invoke(call, VARIATION_CALLABLE.CREATE, request)
}

// EDIT A DRAFT. `seen` is the copy the editor was opened on: its revision
// travels as `expectedRevision`, so an edit can only replace the exact draft
// that was edited (STALE otherwise — the editor keeps the user's entries).
// `data` is what the editor produces; only the authored part is sent, and the
// server derives every line and the header again. Resolves to
// { variationId, alreadyApplied, calcVersion }.
export async function runUpdateVariationDraft({ call, projectId, seen, data, uid }) {
  if (!uid) throw new VariationWriteError(VARIATION_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new VariationWriteError(VARIATION_WRITE_ERROR.MISSING)
  if (seen.status !== VARIATION_STATUS.DRAFT) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'Only draft variations can be edited')
  }
  if (data?.originRfi && !isEligibleOriginRfi(data.originRfi)) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'Only open, answered or closed RFIs can originate a variation')
  }
  const draftError = validateVariationDraft({ title: data?.title, lineItems: data?.lineItems })
  if (draftError) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, draftError)
  const request = updateVariationRequest({ projectId, seen, data })
  if (updateVariationRequestProblem(request)) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'This variation cannot be saved as entered. Check the title, the dates and every line, then try again.')
  }
  return invoke(call, VARIATION_CALLABLE.UPDATE, request)
}

// APPROVE. `seen` is the copy the user assessed: its revision travels as
// `expectedRevision`, so an approval can only land on the exact submitted
// revision that was reviewed. The certified amounts are the approver's input;
// every GST figure, the approved header, the stamps and the commitment
// application are the server's. Resolves to
// { variationId, alreadyApplied, commitmentApplied }.
export async function runApproveVariation({ call, projectId, seen, approvedAmounts, assessmentNotes, uid, today = todayIso() }) {
  if (!uid) throw new VariationWriteError(VARIATION_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new VariationWriteError(VARIATION_WRITE_ERROR.MISSING)
  if (!canTransition(seen.status, VARIATION_STATUS.APPROVED)) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, `Cannot move a ${label(seen.status)} variation to ${label(VARIATION_STATUS.APPROVED)}.`)
  }
  // Refused before any call: a count mismatch, a non-number, or differing
  // amounts without notes. The server validates again over its own copy.
  transitionUpdate(seen, VARIATION_STATUS.APPROVED, { approvedAmounts, assessmentNotes, applyCommitment: false }, uid, null, today)
  const amounts = (approvedAmounts ?? []).map(a => (a === '' || a == null ? 0 : Number(a)))
  if (approvedAmountsProblem(amounts)) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'An approved amount is not a number Constrap can store.')
  }
  return invoke(call, VARIATION_CALLABLE.APPROVE, {
    projectId,
    variationId: seen.id,
    expectedRevision: storedRevision(seen),
    approvedAmounts: amounts,
    assessmentNotes: String(assessmentNotes ?? '').trim(),
    approvedDate: today,
  })
}

// LEGACY APPLY / COMMIT NEW SCOPE. Decided on the reviewed copy first, so a
// plainly ineligible variation never reaches the server; the server decides
// again over its own copies of the variation and the purchase order. Resolves
// to { variationId, alreadyApplied, applied, scopeCommitted }. An answer of
// `alreadyApplied` for stamps this user did not write is the existing
// ALREADY_APPLIED refusal — nothing was changed.
export async function runApplyVariationCommitment({ call, projectId, seen, uid }) {
  if (!uid) throw new VariationWriteError(VARIATION_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new VariationWriteError(VARIATION_WRITE_ERROR.MISSING)
  const pre = commitmentApplyEligibility(seen, [{ id: seen.poId, status: 'sent' }])
  if (!pre.eligible) throw new VariationWriteError(applyBlockerKind(pre.blocker), pre.message)
  const result = await invoke(call, VARIATION_CALLABLE.APPLY, {
    projectId, variationId: seen.id, expectedRevision: storedRevision(seen),
  })
  if (result.alreadyApplied && result.byCaller !== true) throw new VariationWriteError(VARIATION_WRITE_ERROR.ALREADY_APPLIED)
  return result
}

// Kept for callers that decide the approve-time commitment themselves (the
// callable does, over the SERVER copy of the purchase order).
export { shouldApplyOnApproval, isPoLinkedSupplierVariation }
