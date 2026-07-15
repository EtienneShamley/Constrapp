import { PO_STATUS, GST_RATE, roundMoney } from './purchaseOrders'

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
      map[li.poLineIndex] = roundMoney((map[li.poLineIndex] || 0) + (li.approvedThisPeriod || 0))
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
