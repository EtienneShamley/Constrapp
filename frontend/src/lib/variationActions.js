import {
  VARIATION_TYPE, VARIATION_STATUS, VARIATION_STATUS_LABELS, VARIATION_TRANSITION_STAMPS,
  canTransition, variationTotals, validateApprovedAmounts, buildApprovedLineItems,
  validateVariationDraft, stripApprovedFromLines, normaliseOriginRfi, isEligibleOriginRfi,
  isPoLinkedSupplierVariation, isCommitmentApplied, shouldApplyOnApproval,
  commitmentApplyEligibility, COMMITMENT_APPLY_BLOCKER,
} from './variations'
import { PO_STATUS_LABELS } from './purchaseOrders'

// ── Guarded variation writes (ADR-59, M2-B3) ─────────────────────────────────
//
// Two transactions — the DRAFT EDIT and the SUBMIT / APPROVE / REJECT /
// WITHDRAW transition — on the lib/progressClaimActions.js convention:
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

// ── Draft edit ───────────────────────────────────────────────────────────────

// The exact update a draft edit writes (hooks/useVariations.jsx →
// updateVariation, ADR-35): the authored content, the re-derived submitted
// header and — only when `originRfi` is passed — the originating-RFI triple.
// The variation TYPE is read from the server copy, never the caller, so the
// external reference always lands on the document's own side and the other
// side stays null. Every line's approved side is forced null (a draft never
// carries certified values). `notes` passes through when omitted. Exported so
// the unit suite can pin the contract without Firestore; `now` is the injected
// serverTimestamp(). Throws VariationWriteError(INVALID) with the readable
// reason.
export function draftUpdate(live, {
  title, description, reason,
  clientRef, supplierRef,
  identifiedDate, responseDueDate, effectiveDate,
  lineItems, notes,
  originRfi,
} = {}, uid, now) {
  const draftError = validateVariationDraft({ title, lineItems })
  if (draftError) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, draftError)
  if (originRfi && !isEligibleOriginRfi(originRfi)) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'Only open, answered or closed RFIs can originate a variation')
  }
  const isClient  = live?.variationType === VARIATION_TYPE.CLIENT
  const lines     = stripApprovedFromLines(lineItems)
  const submitted = variationTotals(lines, 'submitted')
  return {
    ...(originRfi === undefined ? {} : normaliseOriginRfi(originRfi)),
    title:       title?.trim()       || '',
    description: description?.trim() || '',
    reason:      reason || '',
    clientRef:   isClient ? (clientRef?.trim() || '')  : null,
    supplierRef: isClient ? null : (supplierRef?.trim() || ''),
    identifiedDate:  identifiedDate  || '',
    responseDueDate: responseDueDate || '',
    effectiveDate:   effectiveDate   || '',
    lineItems: lines,
    submittedSubtotal: submitted.subtotal,
    submittedGst:      submitted.gst,
    submittedTotal:    submitted.total,
    ...(notes === undefined ? {} : { notes: notes?.trim() || '' }),
    revision:  nextRevision(live),
    updatedAt: now,
    updatedBy: uid,
  }
}

export async function runUpdateVariationDraft({ db, variationRef, seen, data, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new VariationWriteError(VARIATION_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new VariationWriteError(VARIATION_WRITE_ERROR.MISSING)
  if (seen.status !== VARIATION_STATUS.DRAFT) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'Only draft variations can be edited')
  }
  // Validate against the copy the user reviewed BEFORE any read, so a plainly
  // invalid edit never opens a transaction; the same validation runs again
  // over the server copy below.
  draftUpdate(seen, data, uid, null)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(variationRef)
      if (!snap.exists()) return { kind: VARIATION_WRITE_ERROR.MISSING }
      const live = snap.data()
      const stale = staleMessage(seen, live)
      if (stale) return { kind: VARIATION_WRITE_ERROR.STALE, message: stale }
      if (live.status !== VARIATION_STATUS.DRAFT) return { kind: VARIATION_WRITE_ERROR.INVALID }
      tx.update(variationRef, draftUpdate(live, data, uid, serverTimestamp()))
      return { kind: null }
    })
  } catch (err) {
    if (err instanceof VariationWriteError) throw err
    throw new VariationWriteError(variationWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new VariationWriteError(outcome.kind, outcome.message)
  return outcome
}

// ── Transitions ──────────────────────────────────────────────────────────────

// The commitment-application stamp pair (M3-B1, ADR-62): rules require
// `commitmentAppliedBy == request.auth.uid` and `commitmentAppliedAt ==
// request.time`, and admit the pair only on the approve branch of a PO-linked
// supplier variation and on the legacy Apply branch.
export const commitmentStamps = (uid, now) => ({ commitmentAppliedAt: now, commitmentAppliedBy: uid })

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
    const validationError = validateApprovedAmounts(live?.lineItems, approvedAmounts, assessmentNotes)
    if (validationError) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, validationError)
    if (applyCommitment && !isPoLinkedSupplierVariation(live)) {
      throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'Only a supplier variation that names a purchase order can be applied to a commitment.')
    }
    const lineItems = buildApprovedLineItems(live.lineItems, approvedAmounts)
    const approved  = variationTotals(lineItems, 'approved')
    return {
      ...base,
      lineItems,
      approvedSubtotal: approved.subtotal,
      approvedGst:      approved.gst,
      approvedTotal:    approved.total,
      assessmentNotes:  assessmentNotes?.trim() || '',
      approvedDate:     live.approvedDate || today,
      effectiveDate:    live.effectiveDate || live.approvedDate || today,
      ...(applyCommitment ? commitmentStamps(uid, now) : {}),
    }
  }
  if (nextStatus === VARIATION_STATUS.REJECTED && assessmentNotes?.trim()) {
    return { ...base, assessmentNotes: assessmentNotes.trim() }
  }
  return base
}

// `poRef` (M3-B1, ADR-62 Correction A) — the document reference of the
// variation's PO, REQUIRED by the hook for an APPROVE of a PO-linked supplier
// variation. It is read INSIDE the transaction, after the variation, so the
// decision is made on the SERVER copy: the PO must exist in this project and be
// sent/closed, and the approve write then carries the commitment stamps
// (approve + apply in ONE write, `commitmentApplied: true`). A missing, draft,
// pending or cancelled PO — or a PO-linked approve with no `poRef` — is REFUSED
// (PO_INVALID) with nothing written; there is NO fallback to an unapplied
// approval. The rules enforce the same: the pair and a sent/closed PO are
// required on every PO-linked approve (FINAL ruleset), and the PO state is
// required even by the Stage-1 transitional ruleset.
export async function runTransitionVariation({ db, variationRef, poRef = null, seen, nextStatus, extras = {}, uid, runTransaction, serverTimestamp, today }) {
  if (!uid) throw new VariationWriteError(VARIATION_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new VariationWriteError(VARIATION_WRITE_ERROR.MISSING)
  if (!canTransition(seen.status, nextStatus)) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, `Cannot move a ${label(seen.status)} variation to ${label(nextStatus)}.`)
  }
  // A reserved target, or invalid certified amounts, is refused BEFORE any
  // read; the amounts are validated again over the server copy below.
  transitionUpdate(seen, nextStatus, { ...extras, applyCommitment: false }, uid, null, today)
  if (nextStatus === VARIATION_STATUS.APPROVED && isPoLinkedSupplierVariation(seen) && !poRef) {
    throw new VariationWriteError(VARIATION_WRITE_ERROR.PO_INVALID, 'The purchase order reference is required to approve a variation that names a purchase order.')
  }

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(variationRef)
      if (!snap.exists()) return { kind: VARIATION_WRITE_ERROR.MISSING }
      const live = snap.data()
      const stale = staleMessage(seen, live)
      if (stale) return { kind: VARIATION_WRITE_ERROR.STALE, message: stale }
      if (!canTransition(live.status, nextStatus)) return { kind: VARIATION_WRITE_ERROR.INVALID }

      // All reads before the write. The PO is read for an approve of a
      // PO-linked supplier variation; its SERVER state decides, and anything
      // but a sent/closed PO refuses the approval outright (Correction A).
      let applyCommitment = false
      if (nextStatus === VARIATION_STATUS.APPROVED && isPoLinkedSupplierVariation(live)) {
        if (!poRef) return { kind: VARIATION_WRITE_ERROR.PO_INVALID, message: 'The purchase order reference is required to approve a variation that names a purchase order.' }
        const poSnap = await tx.get(poRef)
        const po = poSnap.exists() ? { id: poSnap.id, ...poSnap.data() } : null
        const name = live.variationNumber || 'This variation'
        if (!po) {
          return { kind: VARIATION_WRITE_ERROR.PO_INVALID, message: `${live.poNumber || 'The linked purchase order'} could not be found in this project, so ${name} cannot be approved. Withdraw or reject it, or raise it again against a current purchase order.` }
        }
        if (!shouldApplyOnApproval(live, po)) {
          const status = PO_STATUS_LABELS[po.status] ?? String(po.status ?? 'unknown')
          return { kind: VARIATION_WRITE_ERROR.PO_INVALID, message: `${po.poNumber || live.poNumber} is ${status}; a supplier variation can only be approved while its purchase order is sent or closed. Withdraw or reject ${name}, or raise it again against a current purchase order.` }
        }
        applyCommitment = true
      }

      tx.update(variationRef, transitionUpdate(live, nextStatus, { ...extras, applyCommitment }, uid, serverTimestamp(), today))
      return { kind: null, commitmentApplied: applyCommitment }
    })
  } catch (err) {
    if (err instanceof VariationWriteError) throw err
    throw new VariationWriteError(variationWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new VariationWriteError(outcome.kind, outcome.message)
  return outcome
}

// ── Legacy Apply to commitment (M3-B1, ADR-62) ───────────────────────────────
//
// The ONE-TIME application of an already-APPROVED, PO-linked supplier variation
// that carries no commitment stamps (approved before M3-B1, or approved while
// its PO was not sent/closed). The write is the stamp pair + revision + audit
// stamps, nothing else — approved money, lines, PO link and every lifecycle
// stamp stay frozen. Rules admit exactly this write (branch (f)): approved →
// approved, stored stamps null, actor == caller, time == server, revision + 1,
// and the PO sent/closed through get(). The "stored stamps must be null"
// precondition makes a second apply RULES-REFUSED, not merely client-refused,
// so two users or two tabs cannot both apply; the revision guard is, as on
// every other variation write, rules-ASSISTED (DC37).

// The exact update the legacy Apply writes. Exported for the unit suite.
export function applyCommitmentUpdate(live, uid, now) {
  return { ...commitmentStamps(uid, now), revision: nextRevision(live), updatedAt: now, updatedBy: uid }
}

function applyBlockerKind(blocker) {
  return blocker === COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED ? VARIATION_WRITE_ERROR.ALREADY_APPLIED : VARIATION_WRITE_ERROR.INVALID
}

// `poRef` is REQUIRED: the PO is re-read inside the transaction and must be
// sent/closed on the server. `seen` is the copy the user reviewed.
export async function runApplyVariationCommitment({ db, variationRef, poRef, seen, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new VariationWriteError(VARIATION_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new VariationWriteError(VARIATION_WRITE_ERROR.MISSING)
  if (!poRef) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'The purchase order reference is required to apply a variation to its commitment.')
  // Decide on the reviewed copy first (status, type, link, stamps) so a plainly
  // ineligible variation never opens a transaction. The PO is unknown here, so
  // a PO-related refusal can only come from the server read below.
  const pre = commitmentApplyEligibility(seen, [{ id: seen.poId, status: 'sent' }])
  if (!pre.eligible) throw new VariationWriteError(applyBlockerKind(pre.blocker), pre.message)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(variationRef)
      if (!snap.exists()) return { kind: VARIATION_WRITE_ERROR.MISSING }
      const live = { id: snap.id, ...snap.data() }
      if (isCommitmentApplied(live)) return { kind: VARIATION_WRITE_ERROR.ALREADY_APPLIED }
      const stale = staleMessage(seen, live)
      if (stale) return { kind: VARIATION_WRITE_ERROR.STALE, message: stale }
      const poSnap = await tx.get(poRef)
      const po = poSnap.exists() ? { id: poSnap.id, ...poSnap.data() } : null
      const eligibility = commitmentApplyEligibility(live, po ? [po] : [])
      if (!eligibility.eligible) return { kind: applyBlockerKind(eligibility.blocker), message: eligibility.message }
      tx.update(variationRef, applyCommitmentUpdate(live, uid, serverTimestamp()))
      return { kind: null }
    })
  } catch (err) {
    if (err instanceof VariationWriteError) throw err
    throw new VariationWriteError(variationWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new VariationWriteError(outcome.kind, outcome.message)
  return outcome
}
