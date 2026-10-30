import { PO_STATUS, GST_RATE, roundMoney, PO_MAX_LINES } from './purchaseOrders'
import { isVariationOriginLine, indexOrNull, sourceLineIdentityError, variationLineCountOf } from './sourceLine'

export const CLAIM_STATUS = {
  DRAFT:        'draft',
  SUBMITTED:    'submitted',
  UNDER_REVIEW: 'under_review', // reserved for the review workflow — no UI path yet
  APPROVED:     'approved',
  REJECTED:     'rejected',
  INVOICED:     'invoiced',     // reserved for the invoices module — no UI path yet
}

export const CLAIM_STATUS_LABELS = {
  [CLAIM_STATUS.DRAFT]:        'Draft',
  [CLAIM_STATUS.SUBMITTED]:    'Submitted',
  [CLAIM_STATUS.UNDER_REVIEW]: 'Under Review',
  [CLAIM_STATUS.APPROVED]:     'Approved',
  [CLAIM_STATUS.REJECTED]:     'Rejected',
  [CLAIM_STATUS.INVOICED]:     'Invoiced',
}

// Maps each status onto an existing Badge variant — no new colours.
export const CLAIM_BADGE_VARIANTS = {
  [CLAIM_STATUS.DRAFT]:        'soon',
  [CLAIM_STATUS.SUBMITTED]:    'info',
  [CLAIM_STATUS.UNDER_REVIEW]: 'pending',
  [CLAIM_STATUS.APPROVED]:     'active',
  [CLAIM_STATUS.REJECTED]:     'danger',
  [CLAIM_STATUS.INVOICED]:     'completed',
}

// Forward-only lifecycle. under_review is reserved (nothing transitions into it
// until the review workflow ships); invoiced is reserved for the invoices module.
// draft → rejected is a withdrawal.
export const CLAIM_TRANSITIONS = {
  [CLAIM_STATUS.DRAFT]:        [CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.SUBMITTED]:    [CLAIM_STATUS.UNDER_REVIEW, CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.UNDER_REVIEW]: [CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.APPROVED]:     [CLAIM_STATUS.INVOICED],
  [CLAIM_STATUS.REJECTED]:     [],
  [CLAIM_STATUS.INVOICED]:     [],
}

export const canTransition = (from, to) => (CLAIM_TRANSITIONS[from] ?? []).includes(to)

// The (at, by) stamp pair each APPLICATION transition writes — and the Firestore
// rules require, with `by == request.auth.uid` and `at == request.time`
// (ADR-58, M2-B2). `under_review` and `invoiced` have NO entry: they are reserved
// (no stamp, no application path) and the rules refuse them as targets, so a
// document can never be stranded in a state the UI shows no action for.
export const CLAIM_TRANSITION_STAMPS = {
  [CLAIM_STATUS.SUBMITTED]: { at: 'submittedAt', by: 'submittedBy' },
  [CLAIM_STATUS.APPROVED]:  { at: 'approvedAt',  by: 'approvedBy' },
  [CLAIM_STATUS.REJECTED]:  { at: 'rejectedAt',  by: 'rejectedBy' },
}

// Ceiling on embedded claim lines — one line per PO line (ADR-37) plus, since
// M3-B2 (ADR-63), one per claimable new-scope variation line; the ceiling stays
// the PO document ceiling, mirrored by Firestore rules (lineItems.size() <= 200).
export const CLAIM_MAX_LINES = PO_MAX_LINES

// A PO may only carry one claim in these statuses at a time — an open claim's
// previouslyApproved snapshots would race against a sibling's assessment.
export const CLAIM_OPEN_STATUSES = [CLAIM_STATUS.DRAFT, CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.UNDER_REVIEW]

// Statuses whose certified value counts toward a budget line's actual cost.
export const CLAIM_APPROVED_STATUSES = [CLAIM_STATUS.APPROVED, CLAIM_STATUS.INVOICED]

// Statuses claimed but not yet certified — pending financial exposure.
export const CLAIM_PENDING_STATUSES = [CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.UNDER_REVIEW]

// Claims are raised against committed POs whose lines are frozen; closed POs
// are complete and take no further claims.
export const CLAIMABLE_PO_STATUSES = [PO_STATUS.SENT]

export const formatClaimNumber = (n) => `PC-${String(n).padStart(4, '0')}`

// Retention is withheld ex-GST and clamped to the subtotal; GST applies to the
// net payable amount. All line amounts are ex-GST, matching budget figures.
export function claimTotals(lineAmounts, retention = 0) {
  const subtotal = roundMoney(lineAmounts.reduce((sum, a) => sum + (Number(a) || 0), 0))
  const retained = Math.min(roundMoney(Number(retention) || 0), subtotal)
  const net      = roundMoney(subtotal - retained)
  const gst      = roundMoney(net * GST_RATE)
  return { subtotal, retention: retained, net, gst, total: roundMoney(net + gst) }
}

export const hasOpenClaim = (claims, poId) =>
  claims.some(c => c.poId === poId && CLAIM_OPEN_STATUSES.includes(c.status))

// Certification bounds for one claim line: the approved amount must be a
// number within [0, claimedThisPeriod]. Accepts raw input strings (empty
// counts as 0). Returns null when valid, otherwise a message for display.
export function approvedLineError(line, approvedAmount) {
  const raw = approvedAmount === '' || approvedAmount == null ? 0 : Number(approvedAmount)
  if (!Number.isFinite(raw)) return 'Certified amount must be a number'
  const approved = roundMoney(raw)
  if (approved < 0) return 'Certified amount cannot be negative'
  if (approved > roundMoney(Number(line?.claimedThisPeriod) || 0)) {
    return 'Certified amount cannot exceed the claimed amount'
  }
  return null
}

// Whole-assessment check shared by the Assess modal and the approve
// transition — invalid amounts are rejected even when submitted
// programmatically. Returns null when valid, otherwise the first error.
export function validateApprovedAmounts(lineItems, approvedAmounts) {
  const lines = lineItems ?? []
  if (!Array.isArray(approvedAmounts) || approvedAmounts.length !== lines.length) {
    return 'Approval requires a certified amount for every claim line'
  }
  for (let i = 0; i < lines.length; i++) {
    const err = approvedLineError(lines[i], approvedAmounts[i])
    if (err) return `Line ${i + 1}: ${err}`
  }
  return null
}

// { poLineIndex: approved ex-GST to date } across earlier certified claims on
// one PO — seeds previouslyApproved when the next claim is drafted. PO line
// indexes are stable keys because lines freeze once a PO leaves draft.
export function previouslyApprovedByPoLine(claims, poId) {
  const map = {}
  for (const claim of claims) {
    if (claim.poId !== poId || !CLAIM_APPROVED_STATUSES.includes(claim.status)) continue
    for (const li of claim.lineItems ?? []) {
      // A variation-origin line (poLineIndex null) belongs to the variation
      // map below — it never seeds, or lands on, PO line 0 (ADR-63).
      if (isVariationOriginLine(li) || li.poLineIndex == null) continue
      map[li.poLineIndex] = roundMoney((map[li.poLineIndex] || 0) + (li.approvedThisPeriod || 0))
    }
  }
  return map
}

// { [variationId]: { [variationLineIndex]: approved ex-GST to date } } across
// certified claims — the cumulative seed for a VARIATION-ORIGIN claim line
// (M3-B2, ADR-63), keyed by the stable variation line identity exactly as PO
// lines are keyed by `poLineIndex`. Variation lines freeze at approval
// (ADR-59), so the index is stable. Not filtered by PO: the variation id is
// already unique.
export function previouslyApprovedByVariationLine(claims) {
  const map = {}
  for (const claim of claims ?? []) {
    if (!CLAIM_APPROVED_STATUSES.includes(claim.status)) continue
    for (const li of claim.lineItems ?? []) {
      if (!isVariationOriginLine(li)) continue
      const idx = indexOrNull(li.variationLineIndex)
      if (idx === null) continue
      const forVar = map[li.variationId] ?? (map[li.variationId] = {})
      forVar[idx] = roundMoney((forVar[idx] || 0) + (li.approvedThisPeriod || 0))
    }
  }
  return map
}

// { costCodeId: approved ex-GST } across certified claims. Feeds the budget
// Actual column at read time — never stored on budget lines.
export function approvedByCostCode(claims) {
  const map = {}
  for (const claim of claims) {
    if (!CLAIM_APPROVED_STATUSES.includes(claim.status)) continue
    for (const li of claim.lineItems ?? []) {
      if (!li.costCodeId) continue
      map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (li.approvedThisPeriod || 0))
    }
  }
  return map
}

// Actual, claim side: { costCodeId: approved ex-GST } across certified claims,
// EXCLUDING any claim whose id is in `excludeClaimIds` — those claims have been
// superseded by a posted/paid supplier invoice, so their value now flows through
// the invoice instead (no double-count). The claim document is never mutated;
// exclusion is a read-time set (see supplierInvoices.invoicedClaimIds). Passing
// an empty set makes this identical to approvedByCostCode.
export function actualClaimsByCostCode(claims, excludeClaimIds = new Set()) {
  const map = {}
  for (const claim of claims) {
    if (!CLAIM_APPROVED_STATUSES.includes(claim.status)) continue
    if (excludeClaimIds.has(claim.id)) continue
    for (const li of claim.lineItems ?? []) {
      if (!li.costCodeId) continue
      map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (li.approvedThisPeriod || 0))
    }
  }
  return map
}

// { poId: { poLineIndex: approved ex-GST } } across certified claims NOT yet
// superseded by a posted claim-sourced invoice — the claim value Actual is
// currently recognising on each PO line (ADR-55). Remaining Committed nets
// these amounts off the PO line so an approved claim is never counted in
// Actual AND left inside open commitment at the same time.
//
// `excludeClaimIds` is the SAME supplierInvoices.invoicedClaimIds set that
// actualClaimsByCostCode uses, so the two maps move together: when a claim's
// invoice posts, the claim drops out of this map in the same render that the
// invoice enters postedInvoicedByPoLine, and the PO line's open commitment is
// unchanged. A line with no `poLineIndex` is skipped — it cannot be attributed
// to a PO line, so it reduces no commitment (the pre-ADR-55 reading).
export function recognisedClaimsByPoLine(claims, excludeClaimIds = new Set()) {
  const map = {}
  for (const claim of claims) {
    if (!CLAIM_APPROVED_STATUSES.includes(claim.status)) continue
    if (excludeClaimIds.has(claim.id)) continue
    if (!claim.poId) continue
    const forPo = map[claim.poId] ?? (map[claim.poId] = {})
    for (const li of claim.lineItems ?? []) {
      if (isVariationOriginLine(li) || li.poLineIndex == null) continue
      forPo[li.poLineIndex] = roundMoney((forPo[li.poLineIndex] || 0) + (li.approvedThisPeriod || 0))
    }
  }
  return map
}

// { [variationId]: { [variationLineIndex]: approved ex-GST } } across certified
// claims NOT yet superseded by a posted claim-sourced invoice — the claim value
// Actual is currently recognising on each committed new-scope variation line
// (M3-B2, ADR-63; the variation-line twin of recognisedClaimsByPoLine, with the
// SAME `excludeClaimIds` hand-over set so a claim and its posted invoice are
// never both netted). Remaining Committed on the variation line nets these.
export function recognisedClaimsByVariationLine(claims, excludeClaimIds = new Set()) {
  const map = {}
  for (const claim of claims ?? []) {
    if (!CLAIM_APPROVED_STATUSES.includes(claim.status)) continue
    if (excludeClaimIds.has(claim.id)) continue
    for (const li of claim.lineItems ?? []) {
      if (!isVariationOriginLine(li)) continue
      const idx = indexOrNull(li.variationLineIndex)
      if (idx === null) continue
      const forVar = map[li.variationId] ?? (map[li.variationId] = {})
      forVar[idx] = roundMoney((forVar[idx] || 0) + (li.approvedThisPeriod || 0))
    }
  }
  return map
}

// ── Variation-origin line source validation (M3-B2, ADR-63) ──────────────────
//
// Why a stored or about-to-be-stored variation-origin claim line is NOT backed
// by a claimable source right now, or null when it is. `variation` is the
// register's (or the server's) copy of the variation the line names, `po` the
// claim's PO. Used fail-closed at create (inside the transaction, over the
// server copies), and by SHIELD check 4 condition H over the live registers.
// Nothing is repaired or re-attributed: a line with an issue is refused (at
// create) or listed (afterwards) and its certified amount stays where the
// claim put it.
export const CLAIM_VARIATION_LINE_ISSUE = {
  VARIATION_MISSING:    'variation_missing',     // no such variation in this project
  NOT_SUPPLIER:         'variation_not_supplier',
  NOT_APPROVED:         'variation_not_approved',
  PO_MISMATCH:          'variation_po_mismatch', // the variation names another PO (or none)
  NOT_APPLIED:          'variation_not_applied',
  NOT_SCOPE_COMMITTED:  'variation_scope_not_committed',
  LINE_MISSING:         'variation_line_missing',  // the line index names no variation line
  NOT_NEW_SCOPE:        'variation_line_not_new_scope', // the line is an existing-line adjustment or invalid against the PO
  NOT_POSITIVE:         'variation_line_not_positive',
  COST_CODE_MISMATCH:   'variation_line_cost_code_mismatch',
  AMOUNT_MISMATCH:      'variation_line_total_mismatch', // the claim line's ceiling snapshot is not the approved amount
}

export const CLAIM_VARIATION_LINE_ISSUE_LABELS = {
  [CLAIM_VARIATION_LINE_ISSUE.VARIATION_MISSING]:   'Variation not found in this project',
  [CLAIM_VARIATION_LINE_ISSUE.NOT_SUPPLIER]:        'Variation is not a supplier variation',
  [CLAIM_VARIATION_LINE_ISSUE.NOT_APPROVED]:        'Variation is not approved',
  [CLAIM_VARIATION_LINE_ISSUE.PO_MISMATCH]:         'Variation does not name this purchase order',
  [CLAIM_VARIATION_LINE_ISSUE.NOT_APPLIED]:         'Variation has not been applied to the PO commitment',
  [CLAIM_VARIATION_LINE_ISSUE.NOT_SCOPE_COMMITTED]: 'Variation new scope has not been committed',
  [CLAIM_VARIATION_LINE_ISSUE.LINE_MISSING]:        'Variation line index does not exist on the variation',
  [CLAIM_VARIATION_LINE_ISSUE.NOT_NEW_SCOPE]:       'Variation line is not valid new scope on this purchase order',
  [CLAIM_VARIATION_LINE_ISSUE.NOT_POSITIVE]:        'Variation line amount is not positive — not claimable',
  [CLAIM_VARIATION_LINE_ISSUE.COST_CODE_MISMATCH]:  'Cost code differs from the variation line',
  [CLAIM_VARIATION_LINE_ISSUE.AMOUNT_MISMATCH]:     'Claim line ceiling differs from the approved variation line amount',
}

// `classify` is lib/variations.js → classifyCommitmentLines, injected to keep
// this module free of a variations import (it is imported by variations'
// consumers). Returns the first issue code, or null.
export function claimVariationLineIssue(line, { variation, po, classify } = {}) {
  if (!isVariationOriginLine(line)) return null
  if (!variation) return CLAIM_VARIATION_LINE_ISSUE.VARIATION_MISSING
  if (variation.variationType !== 'supplier') return CLAIM_VARIATION_LINE_ISSUE.NOT_SUPPLIER
  if (!CLAIM_VARIATION_APPROVED.includes(variation.status)) return CLAIM_VARIATION_LINE_ISSUE.NOT_APPROVED
  if (!po?.id || variation.poId !== po.id) return CLAIM_VARIATION_LINE_ISSUE.PO_MISMATCH
  if (!(variation.commitmentAppliedAt != null && typeof variation.commitmentAppliedBy === 'string' && variation.commitmentAppliedBy.length > 0)) return CLAIM_VARIATION_LINE_ISSUE.NOT_APPLIED
  if (!(variation.scopeCommittedAt != null && typeof variation.scopeCommittedBy === 'string' && variation.scopeCommittedBy.length > 0)) return CLAIM_VARIATION_LINE_ISSUE.NOT_SCOPE_COMMITTED
  const idx = indexOrNull(line.variationLineIndex)
  const vLine = idx === null ? null : (variation.lineItems ?? [])[idx]
  if (!vLine) return CLAIM_VARIATION_LINE_ISSUE.LINE_MISSING
  const classified = typeof classify === 'function' ? classify(variation, po)[idx] : null
  if (classified && classified.kind !== 'new_scope') return CLAIM_VARIATION_LINE_ISSUE.NOT_NEW_SCOPE
  if (!classified && vLine.poLineIndex != null) return CLAIM_VARIATION_LINE_ISSUE.NOT_NEW_SCOPE
  const amount = roundMoney(Number(vLine.approvedAmount) || 0)
  if (!(amount > 0)) return CLAIM_VARIATION_LINE_ISSUE.NOT_POSITIVE
  if ((vLine.costCodeId || '') !== (line.costCodeId || '')) return CLAIM_VARIATION_LINE_ISSUE.COST_CODE_MISMATCH
  if (roundMoney(Number(line.variationLineTotal) || 0) !== amount) return CLAIM_VARIATION_LINE_ISSUE.AMOUNT_MISMATCH
  return null
}
// The variation statuses that count financially — mirrors lib/variations.js →
// VARIATION_APPROVED_STATUSES without importing the module.
const CLAIM_VARIATION_APPROVED = ['approved']

// Every VARIATION-ORIGIN line of every claim, with its claim's status — the
// input to SHIELD's variation-source checks (ADR-63): rows
//   { claimId, claimNumber, claimStatus, poId, lineIndex, line }.
// Rejected claims are excluded (they count nothing); drafts are included so a
// line whose source has since become invalid is visible before approval.
export function variationOriginClaimLines(claims) {
  const rows = []
  for (const claim of claims ?? []) {
    if (!claim || claim.status === CLAIM_STATUS.REJECTED) continue
    ;(claim.lineItems ?? []).forEach((li, lineIndex) => {
      if (!isVariationOriginLine(li)) return
      rows.push({ claimId: claim.id ?? null, claimNumber: claim.claimNumber || '', claimStatus: claim.status, poId: claim.poId ?? null, lineIndex, line: li })
    })
  }
  return rows
}

// Claims that OCCUPY a PO line — every non-rejected claim on the PO whose line
// carries any claimed or certified value. Used by the mixed-mode guards
// (lib/poLineRecognition.js): a PO line being claimed must not also be invoiced
// directly, because the two recognition paths cannot be reconciled per line.
// Returns { [poLineIndex]: [claimNumber, …] } for the one PO.
export function claimedPoLines(claims, poId, { excludeClaimId = null } = {}) {
  const map = {}
  for (const claim of claims) {
    if (claim.poId !== poId || claim.status === CLAIM_STATUS.REJECTED) continue
    if (excludeClaimId && claim.id === excludeClaimId) continue
    for (const li of claim.lineItems ?? []) {
      if (isVariationOriginLine(li) || li.poLineIndex == null) continue
      const occupied = (Number(li.claimedToDate) || 0) > 0
        || (Number(li.claimedThisPeriod) || 0) > 0
        || (Number(li.approvedThisPeriod) || 0) > 0
      if (!occupied) continue
      const list = map[li.poLineIndex] ?? (map[li.poLineIndex] = [])
      list.push(claim.claimNumber || claim.id)
    }
  }
  return map
}

// { costCodeId: claimed-not-yet-certified ex-GST } — pending exposure only;
// never counts toward actual cost.
export function claimedPendingByCostCode(claims) {
  const map = {}
  for (const claim of claims) {
    if (!CLAIM_PENDING_STATUSES.includes(claim.status)) continue
    for (const li of claim.lineItems ?? []) {
      if (!li.costCodeId) continue
      map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (li.claimedThisPeriod || 0))
    }
  }
  return map
}

// ── Draft editor helpers (ADR-37) ────────────────────────────────────────────
// Pure mapping between the editor's form state and the stored claim-line model,
// shared by CREATE and EDIT DRAFT so the two modes cannot drift. Form state
// holds strings (input values); the stored line holds the canonical numbers plus
// the frozen PO snapshots. Nothing here mutates its inputs.
//
// A claim's LINE SET IS FIXED: one line per PO line, created one-to-one when the
// claim is raised, followed (since M3-B2, ADR-63) by one line per claimable
// new-scope variation line on that PO. Lines are never added, removed or
// reordered; the SOURCE-LINE IDENTITY (lib/sourceLine.js — `poLineIndex` for a
// PO line, `variationId` + `variationLineIndex` for a variation line) is what
// every downstream consumer keys off (previouslyApprovedBy*, recognisedClaimsBy*,
// supplierInvoices.postedInvoicedBy*, the invoice seeding path). The ONLY
// authored per-line value in a draft edit is the cumulative `claimedToDate`.

// Statuses whose authored content (claimed amounts, retention, period, refs,
// notes) may still change. Exactly draft — the freeze point is `submitted`, and
// every later status is frozen. RULES-ENFORCED since ADR-58 (M2-B2): the draft
// edit branch admits exactly the draft-editable keys on a `draft`; the client
// check is the UX mirror that gives a readable message.
export const CLAIM_EDITABLE_STATUSES = [CLAIM_STATUS.DRAFT]

// Stored claim line → the editor's per-line form value: the CUMULATIVE
// claimed-to-date figure as a string. Matches the create seed (`String(n || 0)`),
// so a missing, empty or malformed legacy value reads as '0' — never '', which
// would render an empty input the user could mistake for "nothing claimed yet".
export function claimLineToForm(line) {
  const li  = line && typeof line === 'object' ? line : {}
  const raw = li.claimedToDate
  if (raw === '' || raw == null) return '0'
  const n = Number(raw)
  return Number.isFinite(n) ? String(n) : '0'
}

// ONE builder for both modes. `source` supplies the line's IDENTITY and is never
// authored by the user:
//   · CREATE — a PO line (`lineTotal`), with `poLineIndex` and
//     `previouslyApproved` supplied by the caller (the index in the PO's line
//     array and the seed from previouslyApprovedByPoLine).
//   · EDIT   — the STORED claim line, which already carries all six identity
//     fields; the caller supplies nothing but `claimedToDate`, so a draft edit
//     cannot repoint a line at a different PO line or cost code.
// `claimedThisPeriod` is ALWAYS re-derived (a caller-supplied figure is never
// trusted) and `approvedThisPeriod` is ALWAYS forced null — certification is not
// authored, and a draft line must never carry a certified amount.
//
// ⚠️ A NULL `poLineIndex` IS NEVER COERCED TO 0 (M3-B2, ADR-63). A source that
// carries a `variationId` is a VARIATION-ORIGIN line: it keeps `poLineIndex:
// null` and carries `variationId`, `variationNumber`, `variationLineIndex` and
// `variationLineTotal` (its ceiling) instead of `poLineTotal`. A PO-origin
// source with no valid integer index yields `poLineIndex: null` too — which
// validateClaimDraft then REFUSES (sourceLineIdentityError) rather than
// attributing the line to PO line 0.
export function buildClaimLine(source, { claimedToDate, poLineIndex, previouslyApproved } = {}) {
  const src = source && typeof source === 'object' ? source : {}
  const str = (v) => (typeof v === 'string' ? v : '')
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

  const variationOrigin = isVariationOriginLine(src)
  const idx    = variationOrigin ? null : indexOrNull(poLineIndex ?? src.poLineIndex)
  const prev   = num(previouslyApproved ?? src.previouslyApproved)
  // A stored claim line holds `poLineTotal`; a PO line holds `lineTotal`.
  const total  = num(src.poLineTotal ?? src.lineTotal)
  // Cumulative, and deliberately NOT rounded here — the create flow has always
  // stored the raw entered figure; only the derived delta is rounded to cents.
  const toDate = num(claimedToDate)

  const identity = variationOrigin
    ? {
        poLineIndex:        null,
        variationId:        src.variationId,
        variationNumber:    str(src.variationNumber),
        variationLineIndex: indexOrNull(src.variationLineIndex),
        variationLineTotal: num(src.variationLineTotal),
        poLineTotal:        null,
      }
    : { poLineIndex: idx, poLineTotal: total }

  return {
    ...identity,
    costCodeId:         str(src.costCodeId),
    costCodeName:       str(src.costCodeName),
    description:        str(src.description),
    previouslyApproved: prev,
    claimedToDate:      toDate,
    claimedThisPeriod:  roundMoney(toDate - prev),
    approvedThisPeriod: null,
  }
}

// The CREATE seed for a variation-origin claim line (ADR-63): `row` is one
// lib/variations.js → claimableNewScopeLines(…) row (a positive new-scope line
// of a scope-committed variation on this PO). Identity and snapshots come from
// the variation line; the caller supplies the cumulative seed and the authored
// claimed-to-date, exactly as for a PO line.
export function buildVariationClaimLine(row, { previouslyApproved, claimedToDate } = {}) {
  const r = row && typeof row === 'object' ? row : {}
  return buildClaimLine({
    variationId:        typeof r.variationId === 'string' ? r.variationId : '',
    variationNumber:    r.variationNumber,
    variationLineIndex: r.lineIndex,
    variationLineTotal: r.amount,
    costCodeId:         r.costCodeId,
    costCodeName:       r.costCodeName,
    description:        r.description,
  }, { previouslyApproved, claimedToDate })
}

// The over-claim WARNING ceiling of one claim line: a PO line's revised value
// (PO line + applied existing-line adjustments), or a variation line's approved
// amount. Warn-only everywhere, never a block.
export function claimLineCeiling(line, adjustment = 0) {
  if (isVariationOriginLine(line)) return roundMoney(Number(line?.variationLineTotal) || 0)
  return roundMoney((Number(line?.poLineTotal) || 0) + (Number(adjustment) || 0))
}

// Number of variation-origin lines in a claim's line set — the header
// `variationLineCount` the rules pin the line count to (PO lines + this).
export const claimVariationLineCount = (lineItems) => variationLineCountOf(lineItems)

// Positional-pairing guard for the draft-edit contract: the caller supplies one
// claimed-to-date value per STORED line, in stored order. A length mismatch
// would silently pair values with the wrong lines, so it is refused outright
// rather than padded or truncated. Returns null when the pairing is exact.
export function claimedToDateCountError(lineItems, claimedToDate) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return 'This progress claim has no line items to edit'
  }
  if (!Array.isArray(claimedToDate) || claimedToDate.length !== lineItems.length) {
    const got = Array.isArray(claimedToDate) ? claimedToDate.length : 0
    return `A claimed-to-date value is required for every claim line (expected ${lineItems.length}, got ${got})`
  }
  return null
}

// Retention floor (ADR-58, the ADR-40 posture applied to claims). `claimTotals`
// clamps only the UPPER bound, so a negative retention would flow into the
// stored document and RAISE the payable above the claim; the editor's `min="0"`
// is browser constraint validation, not a control. Blank / null is 0 (not
// required); anything else must be a finite number >= 0. Mirrored by Firestore
// rules (`retention >= 0`, whole cents) on create and draft edit. Returns null
// when valid, otherwise a message for display.
export function claimRetentionError(retention) {
  if (retention === '' || retention == null) return null
  const n = Number(retention)
  if (!Number.isFinite(n)) return 'Retention must be a number'
  if (n < 0) return 'Retention cannot be negative'
  return null
}

// Draft content validation shared by create and edit — the existing product
// rules, unchanged and now enforced in the hook as well as the modal:
//   · at least one line, and at most CLAIM_MAX_LINES;
//   · every line has exactly one well-formed source identity and no source
//     line appears twice (ADR-63 — a malformed or duplicated identity is
//     REFUSED, never repaired or re-attributed);
//   · no line may be claimed BELOW its previously approved amount;
//   · at least one line must claim something this period;
//   · the retention, when given, is a non-negative number (ADR-58).
// Claiming ABOVE a PO line value stays WARN-ONLY (the amber ⚠ in the editor) —
// real claims sometimes exceed the PO pending a variation. There is deliberately
// no aggregate over-PO control. Returns null when valid, else the first error.
export function validateClaimDraft({ lineItems, retention, poId } = {}) {
  const lines = Array.isArray(lineItems) ? lineItems : []
  if (lines.length === 0) return 'A progress claim needs at least one line'
  if (lines.length > CLAIM_MAX_LINES) return `A progress claim can carry at most ${CLAIM_MAX_LINES} lines`
  const identityError = sourceLineIdentityError(lines, { poId })
  if (identityError) return identityError
  const backwards = lines.findIndex(li => (Number(li?.claimedThisPeriod) || 0) < 0)
  if (backwards !== -1) {
    return `Line ${backwards + 1}: claimed to date cannot be below the previously approved amount`
  }
  if (!lines.some(li => (Number(li?.claimedThisPeriod) || 0) > 0)) {
    return 'A progress claim must claim an amount on at least one line'
  }
  return claimRetentionError(retention)
}
