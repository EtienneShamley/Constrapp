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
// claim is raised. Lines are never added, removed or reordered, and `poLineIndex`
// is the identity every downstream consumer keys off (previouslyApprovedByPoLine,
// supplierInvoices.postedInvoicedByPoLine, the invoice seeding path). The ONLY
// authored per-line value in a draft edit is the cumulative `claimedToDate`.

// Statuses whose authored content (claimed amounts, retention, period, refs,
// notes) may still change. Exactly draft — the freeze point is `submitted`, and
// every later status is frozen at the product level. Enforced in the client hook
// only (rules do not check status — SECURITY.md Deferred Control 2).
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
export function buildClaimLine(source, { claimedToDate, poLineIndex, previouslyApproved } = {}) {
  const src = source && typeof source === 'object' ? source : {}
  const str = (v) => (typeof v === 'string' ? v : '')
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

  const idx    = poLineIndex        ?? src.poLineIndex
  const prev   = num(previouslyApproved ?? src.previouslyApproved)
  // A stored claim line holds `poLineTotal`; a PO line holds `lineTotal`.
  const total  = num(src.poLineTotal ?? src.lineTotal)
  // Cumulative, and deliberately NOT rounded here — the create flow has always
  // stored the raw entered figure; only the derived delta is rounded to cents.
  const toDate = num(claimedToDate)

  return {
    poLineIndex:        num(idx),
    costCodeId:         str(src.costCodeId),
    costCodeName:       str(src.costCodeName),
    description:        str(src.description),
    poLineTotal:        total,
    previouslyApproved: prev,
    claimedToDate:      toDate,
    claimedThisPeriod:  roundMoney(toDate - prev),
    approvedThisPeriod: null,
  }
}

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

// Draft content validation shared by create and edit — the existing product
// rules, unchanged and now enforced in the hook as well as the modal:
//   · at least one line;
//   · no line may be claimed BELOW its previously approved amount;
//   · at least one line must claim something this period.
// Claiming ABOVE a PO line value stays WARN-ONLY (the amber ⚠ in the editor) —
// real claims sometimes exceed the PO pending a variation. There is deliberately
// no aggregate over-PO control. Returns null when valid, else the first error.
export function validateClaimDraft({ lineItems } = {}) {
  const lines = Array.isArray(lineItems) ? lineItems : []
  if (lines.length === 0) return 'A progress claim needs at least one line'
  const backwards = lines.findIndex(li => (Number(li?.claimedThisPeriod) || 0) < 0)
  if (backwards !== -1) {
    return `Line ${backwards + 1}: claimed to date cannot be below the previously approved amount`
  }
  if (!lines.some(li => (Number(li?.claimedThisPeriod) || 0) > 0)) {
    return 'A progress claim must claim an amount on at least one line'
  }
  return null
}
