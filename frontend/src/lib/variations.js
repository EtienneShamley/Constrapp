import { PO_STATUS, GST_RATE, roundMoney } from './purchaseOrders'
import { RFI_STATUS } from './rfis'

// ── Variations (commercial change control) ───────────────────────────────────
// One type-discriminated collection joins two commercial realities:
//   • Client Variation   (variationType: 'client')   — a change to CONTRACT REVENUE
//                          (a.k.a. Head Contract Variation). Revenue-side only.
//   • Supplier Variation (variationType: 'supplier')  — a change to a SUPPLIER/
//                          SUBCONTRACT COMMITMENT (a.k.a. Subcontract Variation).
//
// Cost Codes remain the commercial spine: every variation line carries a
// costCodeId and a frozen costCodeName snapshot. All canonical amounts are
// ex-GST; GST is derived per line from the amount and its taxCode. Only
// APPROVED variations count financially, and they are derived at read time —
// variations never write onto Budget Lines and never mutate POs, claims, or
// invoices.

export const VARIATION_TYPE = {
  CLIENT:   'client',
  SUPPLIER: 'supplier',
}

export const VARIATION_TYPE_LABELS = {
  [VARIATION_TYPE.CLIENT]:   'Client Variation',
  [VARIATION_TYPE.SUPPLIER]: 'Supplier Variation',
}

// Help text shown under each type — the industry synonym.
export const VARIATION_TYPE_HELP = {
  [VARIATION_TYPE.CLIENT]:   'Head Contract Variation',
  [VARIATION_TYPE.SUPPLIER]: 'Subcontract Variation',
}

export const VARIATION_STATUS = {
  DRAFT:        'draft',
  SUBMITTED:    'submitted',
  APPROVED:     'approved',
  REJECTED:     'rejected',
  WITHDRAWN:    'withdrawn',
  UNDER_REVIEW: 'under_review', // reserved — no UI transition yet
  DISPUTED:     'disputed',     // reserved — no UI transition yet
  SUPERSEDED:   'superseded',   // reserved — revision workflow, no UI yet
}

export const VARIATION_STATUS_LABELS = {
  [VARIATION_STATUS.DRAFT]:        'Draft',
  [VARIATION_STATUS.SUBMITTED]:    'Submitted',
  [VARIATION_STATUS.APPROVED]:     'Approved',
  [VARIATION_STATUS.REJECTED]:     'Rejected',
  [VARIATION_STATUS.WITHDRAWN]:    'Withdrawn',
  [VARIATION_STATUS.UNDER_REVIEW]: 'Under Review',
  [VARIATION_STATUS.DISPUTED]:     'Disputed',
  [VARIATION_STATUS.SUPERSEDED]:   'Superseded',
}

// Maps each status onto an existing Badge variant — no new colours.
export const VARIATION_BADGE_VARIANTS = {
  [VARIATION_STATUS.DRAFT]:        'soon',
  [VARIATION_STATUS.SUBMITTED]:    'info',
  [VARIATION_STATUS.APPROVED]:     'active',
  [VARIATION_STATUS.REJECTED]:     'danger',
  [VARIATION_STATUS.WITHDRAWN]:    'completed',
  [VARIATION_STATUS.UNDER_REVIEW]: 'pending',
  [VARIATION_STATUS.DISPUTED]:     'danger',
  [VARIATION_STATUS.SUPERSEDED]:   'completed',
}

// Forward-only lifecycle. A submitted request becomes an order through approval
// — these are stages of one document, not separate entities. under_review,
// disputed, and superseded are reserved (defined, no UI transitions into them).
export const VARIATION_TRANSITIONS = {
  [VARIATION_STATUS.DRAFT]:        [VARIATION_STATUS.SUBMITTED, VARIATION_STATUS.WITHDRAWN],
  [VARIATION_STATUS.SUBMITTED]:    [VARIATION_STATUS.APPROVED, VARIATION_STATUS.REJECTED, VARIATION_STATUS.WITHDRAWN],
  [VARIATION_STATUS.APPROVED]:     [],
  [VARIATION_STATUS.REJECTED]:     [],
  [VARIATION_STATUS.WITHDRAWN]:    [],
  [VARIATION_STATUS.UNDER_REVIEW]: [],
  [VARIATION_STATUS.DISPUTED]:     [],
  [VARIATION_STATUS.SUPERSEDED]:   [],
}

export const canTransition = (from, to) => (VARIATION_TRANSITIONS[from] ?? []).includes(to)

// The (at, by) stamp pair each application transition writes (ADR-59). Rules
// require `by == request.auth.uid` and `at == request.time` on that branch and
// admit no other stamp; the reserved statuses have no entry and no path.
export const VARIATION_TRANSITION_STAMPS = {
  [VARIATION_STATUS.SUBMITTED]: { at: 'submittedAt', by: 'submittedBy' },
  [VARIATION_STATUS.APPROVED]:  { at: 'approvedAt',  by: 'approvedBy' },
  [VARIATION_STATUS.REJECTED]:  { at: 'rejectedAt',  by: 'rejectedBy' },
  [VARIATION_STATUS.WITHDRAWN]: { at: 'withdrawnAt', by: 'withdrawnBy' },
}

// Ceiling on embedded variation lines — the rules' `lineItems.size() <= 200`
// (the PO / claim ceiling); an editor cannot author more.
export const VARIATION_MAX_LINES = 200

// The single financial counting point — only approved variations count.
export const VARIATION_APPROVED_STATUSES = [VARIATION_STATUS.APPROVED]

// Live, not-yet-approved variations — pending exposure and the open count.
export const VARIATION_PENDING_STATUSES = [VARIATION_STATUS.DRAFT, VARIATION_STATUS.SUBMITTED]

// A draft is fully editable; everything from submitted onward is frozen except
// valid lifecycle actions (client-enforced, matching the PO/claim/invoice posture).
export const VARIATION_EDITABLE_STATUSES = [VARIATION_STATUS.DRAFT]

// A Supplier Variation may reference one sent/closed PO (or none). draft and
// cancelled POs are not commitments.
export const VARIATION_PO_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED]

export const formatClientVariationNumber   = (n) => `CV-${String(n).padStart(4, '0')}`
export const formatSupplierVariationNumber = (n) => `SV-${String(n).padStart(4, '0')}`

// The counter document backing each type's number sequence.
export const VARIATION_COUNTER_ID = {
  [VARIATION_TYPE.CLIENT]:   'variationsClient',
  [VARIATION_TYPE.SUPPLIER]: 'variationsSupplier',
}

// ── Tax codes ────────────────────────────────────────────────────────────────
// Per-line tax treatment lets one variation mix taxable, GST-free, and
// input-taxed lines. Only `gst` attracts GST; the others are zero-rated. Storage
// is always ex-GST plus a derived gstAmount per line and side (submitted/approved).
export const TAX_CODE = {
  GST:         'gst',
  GST_FREE:    'gst_free',
  INPUT_TAXED: 'input_taxed',
}

export const TAX_CODES = Object.values(TAX_CODE)

export const TAX_CODE_LABELS = {
  [TAX_CODE.GST]:         'GST 10%',
  [TAX_CODE.GST_FREE]:    'GST-free',
  [TAX_CODE.INPUT_TAXED]: 'Input-taxed',
}

// GST for one line: 10% of the ex-GST amount for `gst`, otherwise zero. Signed —
// a negative amount yields a negative GST so credits/omissions reconcile.
export function gstForLine(amount, taxCode) {
  const amt = Number(amount) || 0
  return taxCode === TAX_CODE.GST ? roundMoney(amt * GST_RATE) : 0
}

// ── Reasons (optional, reserved enum) ────────────────────────────────────────
export const VARIATION_REASON = {
  DESIGN_CHANGE:      'design_change',
  SITE_CONDITION:     'site_condition',
  CLIENT_INSTRUCTION: 'client_instruction',
  ERROR_OMISSION:     'error_omission',
  OTHER:              'other',
}

export const VARIATION_REASON_LABELS = {
  [VARIATION_REASON.DESIGN_CHANGE]:      'Design change',
  [VARIATION_REASON.SITE_CONDITION]:     'Site condition',
  [VARIATION_REASON.CLIENT_INSTRUCTION]: 'Client instruction',
  [VARIATION_REASON.ERROR_OMISSION]:     'Error / omission',
  [VARIATION_REASON.OTHER]:              'Other',
}

// ── Header totals (derived from line items) ──────────────────────────────────
// Header subtotal/GST/total always derive from the line items — never a flat
// header rate. `side` selects submitted vs approved amounts. Amounts and GST may
// be negative (credits/omissions) — nothing is clamped here.
export function variationTotals(lineItems, side = 'submitted') {
  const amountKey = side === 'approved' ? 'approvedAmount' : 'submittedAmount'
  const gstKey    = side === 'approved' ? 'approvedGst'    : 'submittedGst'
  const subtotal  = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li[amountKey]) || 0), 0))
  const gst       = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li[gstKey])    || 0), 0))
  return { subtotal, gst, total: roundMoney(subtotal + gst) }
}

// ── Approval assessment ──────────────────────────────────────────────────────

// Whether any approved amount differs from its submitted amount — assessment
// notes are then required.
export function approvalNeedsNotes(lineItems, approvedAmounts) {
  return (lineItems ?? []).some((li, idx) => {
    const approved  = roundMoney(Number(approvedAmounts?.[idx]) || 0)
    const submitted = roundMoney(Number(li.submittedAmount) || 0)
    return approved !== submitted
  })
}

// Whole-assessment check shared by the Assess modal and the approve transition.
// Approved amounts are UNBOUNDED — a variation may be certified above, below,
// equal to, zero, or negative relative to what was submitted (negotiation).
// Only requires finite numbers, matching line count, and notes when values
// differ. Returns null when valid, otherwise the first error.
export function validateApprovedAmounts(lineItems, approvedAmounts, assessmentNotes) {
  const lines = lineItems ?? []
  if (!Array.isArray(approvedAmounts) || approvedAmounts.length !== lines.length) {
    return 'Approval requires an amount for every variation line'
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = approvedAmounts[i] === '' || approvedAmounts[i] == null ? 0 : Number(approvedAmounts[i])
    if (!Number.isFinite(raw)) return `Line ${i + 1}: amount must be a number`
  }
  if (approvalNeedsNotes(lines, approvedAmounts) && !(assessmentNotes || '').trim()) {
    return 'Assessment notes are required when approved amounts differ from submitted amounts'
  }
  return null
}

// Builds the approved line items from raw approved-amount inputs, carrying each
// line's taxCode so approvedGst reconciles per line. Signed throughout.
export function buildApprovedLineItems(lineItems, approvedAmounts) {
  return (lineItems ?? []).map((li, idx) => {
    const amount = roundMoney(Number(approvedAmounts?.[idx]) || 0)
    return {
      ...li,
      approvedAmount: amount,
      approvedGst:    gstForLine(amount, li.taxCode),
    }
  })
}

// ── Read-time derivations (never stored, never written to Budget Lines) ──────

// { costCodeId: approved ex-GST } across APPROVED supplier variations. Feeds the
// Budget page's "Approved Supplier Variations" and "Commitment Exposure" — a
// figure kept separate from the canonical Committed. Negative approved
// variations reduce the total; nothing is clamped to zero.
export function approvedSupplierVariationsByCostCode(variations) {
  const map = {}
  for (const v of variations) {
    if (v.variationType !== VARIATION_TYPE.SUPPLIER) continue
    if (!VARIATION_APPROVED_STATUSES.includes(v.status)) continue
    for (const li of v.lineItems ?? []) {
      if (!li.costCodeId) continue
      map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (Number(li.approvedAmount) || 0))
    }
  }
  return map
}

// Sum of ex-GST subtotals across variations of a type in the given statuses,
// using the submitted or approved side. Signed — not clamped.
function sumSubtotals(variations, type, statuses, side) {
  const key = side === 'approved' ? 'approvedSubtotal' : 'submittedSubtotal'
  let sum = 0
  for (const v of variations) {
    if (v.variationType !== type) continue
    if (!statuses.includes(v.status)) continue
    sum += Number(v[key]) || 0
  }
  return roundMoney(sum)
}

// { costCodeId: submitted ex-GST } across PENDING (draft/submitted) SUPPLIER
// variations — the per-cost-code companion to pendingSupplierVariationExposureTotal
// (and the pending-side mirror of approvedSupplierVariationsByCostCode). Exposure
// only: it never matures against claims/invoices and is NEVER added to any
// forecast total — the Forecast page shows it as separate context. Signed —
// negatives (credits/omissions) are not clamped.
export function pendingSupplierVariationExposureByCostCode(variations) {
  const map = {}
  for (const v of variations) {
    if (v.variationType !== VARIATION_TYPE.SUPPLIER) continue
    if (!VARIATION_PENDING_STATUSES.includes(v.status)) continue
    for (const li of v.lineItems ?? []) {
      if (!li.costCodeId) continue
      map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (Number(li.submittedAmount) || 0))
    }
  }
  return map
}

export const approvedSupplierVariationsTotal = (variations) =>
  sumSubtotals(variations, VARIATION_TYPE.SUPPLIER, VARIATION_APPROVED_STATUSES, 'approved')

export const pendingSupplierVariationExposureTotal = (variations) =>
  sumSubtotals(variations, VARIATION_TYPE.SUPPLIER, VARIATION_PENDING_STATUSES, 'submitted')

export const approvedClientVariationsTotal = (variations) =>
  sumSubtotals(variations, VARIATION_TYPE.CLIENT, VARIATION_APPROVED_STATUSES, 'approved')

export const pendingClientVariationExposureTotal = (variations) =>
  sumSubtotals(variations, VARIATION_TYPE.CLIENT, VARIATION_PENDING_STATUSES, 'submitted')

export const openVariationCount = (variations) =>
  variations.filter(v => VARIATION_PENDING_STATUSES.includes(v.status)).length

// ── Duplicate detection (warning-only, client-enforced) ──────────────────────

const normaliseRef  = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '')
const normaliseName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

// Warns when a variation with the same counterparty and external reference
// already exists. Client: clientId + clientRef, falling back to clientName +
// clientRef. Supplier: supplierId + supplierRef, falling back to poId +
// supplierRef. Only checks when the external reference is non-empty. Rejected
// and withdrawn variations are ignored. Never blocks — server-enforced
// uniqueness is deferred.
export function duplicateVariationWarnings(variations, candidate) {
  const { id = null, variationType } = candidate
  const isClient = variationType === VARIATION_TYPE.CLIENT
  const ref = normaliseRef(isClient ? candidate.clientRef : candidate.supplierRef)
  if (!ref) return []

  const warnings = []
  for (const v of variations) {
    if (id && v.id === id) continue
    if (v.variationType !== variationType) continue
    if (v.status === VARIATION_STATUS.REJECTED || v.status === VARIATION_STATUS.WITHDRAWN) continue

    if (isClient) {
      if (normaliseRef(v.clientRef) !== ref) continue
      const sameParty = candidate.clientId
        ? v.clientId === candidate.clientId
        : (!!candidate.clientName && normaliseName(v.clientName) === normaliseName(candidate.clientName))
      if (sameParty) {
        warnings.push({ field: 'clientRef', message: `Client reference "${candidate.clientRef}" is already recorded on ${v.variationNumber}.` })
      }
    } else {
      if (normaliseRef(v.supplierRef) !== ref) continue
      const sameParty = candidate.supplierId
        ? v.supplierId === candidate.supplierId
        : (!!candidate.poId && v.poId === candidate.poId)
      if (sameParty) {
        warnings.push({ field: 'supplierRef', message: `Supplier reference "${candidate.supplierRef}" is already recorded on ${v.variationNumber}.` })
      }
    }
  }
  return warnings
}

// ── Originating RFI (evidence link, ADR-34) ──────────────────────────────────
// A Variation may record the ONE RFI that originated or materially supports
// it. The Variation OWNS the relationship (originRfiId + two frozen display
// snapshots); the RFI stores nothing back — the reverse view is derived at read
// time by variationsForRfi(). This is EVIDENCE METADATA ONLY: it takes part in
// no amount, GST, budget, forecast, commitment, margin, cash-flow or invoicing
// derivation, and never engages anything the RFI module does.
//
// Unlinked state is the all-null triple. Legacy Variation documents may lack
// the keys entirely — every reader below treats an absent key as unlinked.

// An RFI is eligible ONLY once formally raised and not withdrawn. A draft has
// not been asked yet (and its title is still editable); a cancelled question
// cannot originate work. Eligibility is checked when the link is created or
// changed — an existing link SURVIVES a later cancellation of its RFI.
export const ORIGIN_RFI_STATUSES = [RFI_STATUS.OPEN, RFI_STATUS.ANSWERED, RFI_STATUS.CLOSED]

export const UNLINKED_ORIGIN_RFI = Object.freeze({
  originRfiId:     null,
  originRfiNumber: null,
  originRfiTitle:  null,
})

export const isEligibleOriginRfi = (rfi) =>
  !!rfi && typeof rfi === 'object' && ORIGIN_RFI_STATUSES.includes(rfi.status)

// The stored triple for an RFI document, or the unlinked triple for
// null/undefined/anything without a usable id, number and title. Snapshots are
// the EXACT source values — never trimmed, truncated or reformatted — because
// rules compare them to the RFI verbatim. Never mutates its input.
export function normaliseOriginRfi(rfi) {
  if (!rfi || typeof rfi !== 'object') return { ...UNLINKED_ORIGIN_RFI }
  const { id, rfiNumber, title } = rfi
  const usable = (v) => typeof v === 'string' && v.length > 0
  if (!usable(id) || !usable(rfiNumber) || !usable(title)) return { ...UNLINKED_ORIGIN_RFI }
  return { originRfiId: id, originRfiNumber: rfiNumber, originRfiTitle: title }
}

export const hasOriginRfi = (variation) =>
  typeof variation?.originRfiId === 'string' && variation.originRfiId.length > 0

// Current-project RFIs a Variation may link to, in RFI-number order (a new
// array — the input is never reordered).
export function eligibleOriginRfis(rfis) {
  return (rfis ?? [])
    .filter(isEligibleOriginRfi)
    .slice()
    .sort((a, b) =>
      String(a.rfiNumber || '').localeCompare(String(b.rfiNumber || ''))
      || String(a.id || '').localeCompare(String(b.id || '')))
}

// 'RFI-0012 — Revised structural steel connection', or null when unlinked.
export function originRfiLabel(variation) {
  if (!hasOriginRfi(variation)) return null
  const number = variation.originRfiNumber || variation.originRfiId
  return variation.originRfiTitle ? `${number} — ${variation.originRfiTitle}` : number
}

// The link is editable exactly while the Variation itself is — draft only.
// Client-side UX gate; the variations rules block freezes the triple by rules
// once the document leaves draft.
export const canEditOriginRfi = (status) => VARIATION_EDITABLE_STATUSES.includes(status)

// Read-time reverse view: every Variation citing this RFI, in the order given.
export function variationsForRfi(variations, rfiId) {
  if (typeof rfiId !== 'string' || rfiId.length === 0) return []
  return (variations ?? []).filter(v => v?.originRfiId === rfiId)
}

// ── Draft editor line helpers (ADR-35) ───────────────────────────────────────
// Pure mapping between the editor's form state and the stored line model, shared
// by CREATE and EDIT DRAFT so the two modes cannot drift. Form state holds
// strings (input values); the stored line holds the canonical numbers plus the
// frozen costCodeName snapshot. Nothing here mutates its inputs.

// Blank editor line — every form line has exactly these five keys.
export const EMPTY_VARIATION_FORM_LINE = Object.freeze({
  poLineIndex: '', costCodeId: '', description: '', submittedAmount: '', taxCode: TAX_CODE.GST,
})

// Stored draft line → editor form line. poLineIndex null/absent → '' (new
// scope); a numeric index → its string. A PO-inherited line carries no chosen
// costCodeId in the form — the cost code is re-derived from the PO line on
// rebuild, exactly as at create. Legacy / partial lines map to safe defaults.
export function variationLineToForm(line) {
  const li = line && typeof line === 'object' ? line : {}
  const inherited = Number.isInteger(li.poLineIndex) && li.poLineIndex >= 0
  return {
    poLineIndex:     inherited ? String(li.poLineIndex) : '',
    costCodeId:      inherited ? '' : (typeof li.costCodeId === 'string' ? li.costCodeId : ''),
    description:     typeof li.description === 'string' ? li.description : '',
    submittedAmount: li.submittedAmount == null || li.submittedAmount === '' ? '' : String(li.submittedAmount),
    taxCode:         TAX_CODES.includes(li.taxCode) ? li.taxCode : TAX_CODE.GST,
  }
}

// Editor form line → stored draft line. `po` is the Supplier Variation's PO
// document (or null); a form line that names one of its lines INHERITS that
// line's costCodeId/costCodeName and ignores any stale chosen cost code. A
// new-scope line uses the chosen cost code with a fresh "CODE — NAME" snapshot
// (empty when the id is unknown, which validateVariationDraft then rejects).
// Amounts are rounded, GST derives from the tax code, and the approved side is
// ALWAYS null — a draft never carries certified values.
export function buildVariationLineItem(formLine, { po = null, costCodes = [] } = {}) {
  const l = formLine && typeof formLine === 'object' ? formLine : {}
  const poLine = po && l.poLineIndex !== '' && l.poLineIndex != null
    ? ((po.lineItems ?? [])[Number(l.poLineIndex)] ?? null)
    : null

  let costCodeId, costCodeName
  if (poLine) {
    costCodeId   = poLine.costCodeId || ''
    costCodeName = poLine.costCodeName || ''
  } else {
    costCodeId = typeof l.costCodeId === 'string' ? l.costCodeId : ''
    const cc = (costCodes ?? []).find(c => c.id === costCodeId)
    costCodeName = cc ? `${cc.code} — ${cc.name}` : ''
  }

  const amount  = Number(l.submittedAmount) || 0
  const taxCode = TAX_CODES.includes(l.taxCode) ? l.taxCode : TAX_CODE.GST
  return {
    costCodeId,
    costCodeName,
    description:     String(l.description ?? '').trim(),
    submittedAmount: roundMoney(amount),
    submittedGst:    gstForLine(amount, taxCode),
    approvedAmount:  null,
    approvedGst:     null,
    poLineIndex:     poLine ? Number(l.poLineIndex) : null,
    taxCode,
  }
}

// Draft content validation shared by create and edit — the existing product
// rules: a title, at least one line (and at most VARIATION_MAX_LINES), and a
// cost code on every line. Amounts are deliberately NOT checked (negative
// credits/omissions are valid).
// Returns null when valid, otherwise the first error message.
export function validateVariationDraft({ title, lineItems } = {}) {
  if (!String(title ?? '').trim()) return 'Title is required'
  const lines = Array.isArray(lineItems) ? lineItems : []
  if (lines.length === 0) return 'At least one line item is required'
  if (lines.length > VARIATION_MAX_LINES) return `A variation may carry at most ${VARIATION_MAX_LINES} line items`
  const missing = lines.findIndex(li => !(typeof li?.costCodeId === 'string' && li.costCodeId.length > 0))
  if (missing !== -1) return `Line ${missing + 1}: a cost code is required`
  return null
}

// Draft-only defence: whatever the editor sends, a draft line never carries
// certified values. Returns new line objects; never mutates the input.
export function stripApprovedFromLines(lineItems) {
  return (lineItems ?? []).map(li => ({ ...li, approvedAmount: null, approvedGst: null }))
}

// ── Commitment application (M3-B1, ADR-62) ───────────────────────────────────
//
// An APPROVED supplier variation that names a PO is the auditable commitment
// adjustment to that PO — the PO document itself is never edited, revised or
// re-issued (ADR-7 / ADR-57). Whether a variation's approved amounts have been
// APPLIED to the PO's commitment is recorded by two optional, rules-stamped
// keys on the variation (actor == caller, time == server, written once):
//
//   commitmentAppliedAt   Timestamp
//   commitmentAppliedBy   uid
//
// A newly approved, PO-linked supplier variation whose PO is still sent/closed
// receives the pair IN THE APPROVE TRANSITION (approval is the financial
// trigger — there is no second approval workflow). A variation approved before
// M3-B1 carries no stamps and stays UNAPPLIED — exposure only, exactly as
// before — until a user explicitly applies it through the one-time, rules-
// idempotent Apply (lib/variationActions.js → runApplyVariationCommitment).
// Manual-mode supplier variations (poId null) and client variations never gain
// the keys and never adjust a PO commitment.
//
// LINE-LEVEL TREATMENT. Each approved line is classified against the PO:
//   · EXISTING_LINE — `poLineIndex` names a PO line whose cost code matches the
//     line's snapshot: the signed approved amount raises or lowers that PO
//     line's contractual value (revised = lineTotal + Σ adjustments) and
//     therefore its Remaining Committed (lib/purchaseOrders.js), attributed to
//     the PO LINE's cost code. Matured once per variation per PO line.
//   · NEW_SCOPE     — `poLineIndex` null: committed work with no claimable PO
//     line identity yet. In B1 it does NOT enter Remaining Committed; it stays
//     visible as unapplied exposure, labelled "awaiting M3-B2", and is never
//     dropped from a total.
//   · INVALID       — the PO is missing from the register or not sent/closed,
//     the index is out of range, the cost code disagrees with the PO line, or
//     the amount is not a finite number. Nothing is counted against a different
//     line or cost code: the amount stays in unapplied exposure and the line is
//     listed as an exception (SHIELD check 4 condition F).
// Everything here is a pure read-time derivation over the two registers; no
// document is written, offset or repaired, and a negative variation never
// becomes a credit note or an Actual-cost offset.

export const VARIATION_COMMITMENT_KEYS = ['commitmentAppliedAt', 'commitmentAppliedBy']

export const isPoLinkedSupplierVariation = (v) =>
  v?.variationType === VARIATION_TYPE.SUPPLIER && typeof v.poId === 'string' && v.poId.length > 0

export const isCommitmentApplied = (v) =>
  v?.commitmentAppliedAt != null
  && typeof v.commitmentAppliedBy === 'string' && v.commitmentAppliedBy.length > 0

// Statuses in which a PO can carry an applied adjustment (the Remaining
// Committed statuses). Mirrors lib/purchaseOrders.js → PO_COMMITTED_STATUSES
// without importing it into the hot path twice.
const COMMITMENT_PO_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED]

export const COMMITMENT_LINE_KIND = {
  EXISTING_LINE: 'existing_line',
  NEW_SCOPE:     'new_scope',
  INVALID:       'invalid',
}

export const COMMITMENT_LINE_ISSUE = {
  PO_MISSING:         'po_missing',          // the variation's PO is not in the register
  PO_NOT_COMMITTED:   'po_not_committed',    // the PO is draft / pending / cancelled
  LINE_OUT_OF_RANGE:  'line_out_of_range',   // poLineIndex names no PO line
  COST_CODE_MISMATCH: 'cost_code_mismatch',  // the line's cost code is not the PO line's
  AMOUNT_INVALID:     'amount_invalid',      // approvedAmount is not a finite number
}

export const COMMITMENT_LINE_ISSUE_LABELS = {
  [COMMITMENT_LINE_ISSUE.PO_MISSING]:         'Purchase order not found in this project',
  [COMMITMENT_LINE_ISSUE.PO_NOT_COMMITTED]:   'Purchase order is not sent or closed',
  [COMMITMENT_LINE_ISSUE.LINE_OUT_OF_RANGE]:  'PO line index does not exist on the purchase order',
  [COMMITMENT_LINE_ISSUE.COST_CODE_MISMATCH]: 'Cost code differs from the referenced PO line',
  [COMMITMENT_LINE_ISSUE.AMOUNT_INVALID]:     'Approved amount is not a valid number',
}

const finiteOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? roundMoney(n) : null
}

// Classifies every line of `variation` against `po` (the PO document the
// variation names, or null when the register does not hold it). Pure; never
// mutates its inputs. Each row:
//   { lineIndex, kind, issue, poLineIndex, amount, costCodeId, costCodeName,
//     description, poLineCostCodeId }
// `amount` is the SIGNED approved amount in cents (null when not finite);
// `costCodeId` is the PO line's for EXISTING_LINE and the line's own snapshot
// otherwise, so an invalid line is never attributed to a different code.
export function classifyCommitmentLines(variation, po) {
  const poLines = Array.isArray(po?.lineItems) ? po.lineItems : []
  const poProblem = !po
    ? COMMITMENT_LINE_ISSUE.PO_MISSING
    : (!COMMITMENT_PO_STATUSES.includes(po.status) ? COMMITMENT_LINE_ISSUE.PO_NOT_COMMITTED : null)

  return (variation?.lineItems ?? []).map((li, lineIndex) => {
    const amount = finiteOrNull(li?.approvedAmount)
    const base = {
      lineIndex,
      poLineIndex:  Number.isInteger(li?.poLineIndex) ? li.poLineIndex : null,
      amount,
      costCodeId:   typeof li?.costCodeId === 'string' ? li.costCodeId : '',
      costCodeName: typeof li?.costCodeName === 'string' ? li.costCodeName : '',
      description:  typeof li?.description === 'string' ? li.description : '',
      poLineCostCodeId: null,
    }
    if (amount === null) return { ...base, kind: COMMITMENT_LINE_KIND.INVALID, issue: COMMITMENT_LINE_ISSUE.AMOUNT_INVALID }
    if (li?.poLineIndex === null || li?.poLineIndex === undefined) {
      return { ...base, kind: COMMITMENT_LINE_KIND.NEW_SCOPE, issue: null }
    }
    if (poProblem) return { ...base, kind: COMMITMENT_LINE_KIND.INVALID, issue: poProblem }
    if (!Number.isInteger(li.poLineIndex) || li.poLineIndex < 0 || li.poLineIndex >= poLines.length) {
      return { ...base, kind: COMMITMENT_LINE_KIND.INVALID, issue: COMMITMENT_LINE_ISSUE.LINE_OUT_OF_RANGE }
    }
    const poLine = poLines[li.poLineIndex] ?? {}
    const poCode = typeof poLine.costCodeId === 'string' ? poLine.costCodeId : ''
    if (!poCode || poCode !== base.costCodeId) {
      return { ...base, kind: COMMITMENT_LINE_KIND.INVALID, issue: COMMITMENT_LINE_ISSUE.COST_CODE_MISMATCH, poLineCostCodeId: poCode || null }
    }
    return {
      ...base,
      kind: COMMITMENT_LINE_KIND.EXISTING_LINE,
      issue: null,
      poLineCostCodeId: poCode,
      costCodeName: poLine.costCodeName || base.costCodeName,
    }
  })
}

// How much of a variation's approved value has actually reached the PO's
// commitment — decided by the LINE-LEVEL financial treatment, never by the
// process stamp alone (ADR-62 Correction C). A stamped variation whose lines
// are all new scope is "awaiting M3-B2", never "incorporated".
export const INCORPORATION_STATE = {
  NOT_APPLICABLE:   'not_applicable',           // client, or manual-mode supplier — no PO commitment exists
  NOT_APPROVED:     'not_approved',             // draft / submitted / rejected / withdrawn
  UNAPPLIED:        'unapplied',                // approved, PO-linked, no stamps — not yet applied (legacy)
  INCORPORATED:     'incorporated',             // applied; EVERY approved amount is in the revised PO commitment
  PARTIAL:          'partially_incorporated',   // applied; existing-line amounts matured, new-scope amounts remain exposure
  NOT_INCORPORATED: 'not_incorporated',         // applied; new scope only — nothing claimable through a PO line (awaiting M3-B2)
  EXCEPTION:        'exception',                // applied; source integrity or financial conflict on at least one line
}

export const INCORPORATION_STATE_LABELS = {
  [INCORPORATION_STATE.NOT_APPLICABLE]:   'No PO commitment',
  [INCORPORATION_STATE.NOT_APPROVED]:     'Not approved',
  [INCORPORATION_STATE.UNAPPLIED]:        'Not yet applied',
  [INCORPORATION_STATE.INCORPORATED]:     'Fully incorporated',
  [INCORPORATION_STATE.PARTIAL]:          'Partially incorporated',
  [INCORPORATION_STATE.NOT_INCORPORATED]: 'Awaiting M3-B2',
  [INCORPORATION_STATE.EXCEPTION]:        'Invalid — needs review',
}

// One-line explanation per state, for the register and the dialogs.
export const INCORPORATION_STATE_HELP = {
  [INCORPORATION_STATE.NOT_APPLICABLE]:   'A client or no-PO supplier variation adjusts no purchase order commitment.',
  [INCORPORATION_STATE.NOT_APPROVED]:     'Only an approved variation can adjust a commitment.',
  [INCORPORATION_STATE.UNAPPLIED]:        'Approved before M3-B1 — its full approved amount is separate exposure until it is explicitly applied to the PO commitment.',
  [INCORPORATION_STATE.INCORPORATED]:     'Every approved amount is inside the revised PO line commitment.',
  [INCORPORATION_STATE.PARTIAL]:          'Existing-line amounts are inside the revised PO commitment; new-scope amounts remain separate exposure until M3-B2.',
  [INCORPORATION_STATE.NOT_INCORPORATED]: 'Applied, but every line is new scope: nothing is claimable through a PO line yet, so the whole approved amount remains separate exposure until M3-B2.',
  [INCORPORATION_STATE.EXCEPTION]:        'At least one line cannot be incorporated (missing or non-committed PO, PO line not found, cost-code mismatch, invalid amount). Those amounts remain separate exposure and are listed on SHIELD.',
}

const sumAmounts = (rows) => roundMoney(rows.reduce((s, r) => s + (r.amount ?? 0), 0))

// The approved value of a supplier variation, signed, summed from its lines
// (the stored header is not trusted for this — the lines are what mature).
const grossApproved = (variation) =>
  roundMoney((variation?.lineItems ?? []).reduce((s, li) => s + (Number(li?.approvedAmount) || 0), 0))

// The incorporation of ONE variation against the PO register.
//   { state, applied, po, lines, gross, matured, outstanding, newScope, invalid,
//     counts: { existing, newScope, invalid } }
// `applied` is the PROCESS stamp (the pair is present); `matured` is the
// signed amount actually inside the revised PO commitment; `outstanding` =
// gross − matured is the signed amount still shown as separate exposure
// (new-scope + invalid lines, or everything while unapplied). The STATE is
// decided by the amounts, never by the stamp alone (Correction C).
export function variationIncorporation(variation, purchaseOrders) {
  const gross = grossApproved(variation)
  const empty = { applied: false, po: null, lines: [], gross, matured: 0, outstanding: gross, newScope: 0, invalid: 0, counts: { existing: 0, newScope: 0, invalid: 0 } }
  if (!isPoLinkedSupplierVariation(variation)) return { state: INCORPORATION_STATE.NOT_APPLICABLE, ...empty }
  if (!VARIATION_APPROVED_STATUSES.includes(variation.status)) return { state: INCORPORATION_STATE.NOT_APPROVED, ...empty, gross: 0, outstanding: 0 }
  const po = (purchaseOrders ?? []).find(p => p?.id === variation.poId) ?? null
  if (!isCommitmentApplied(variation)) return { state: INCORPORATION_STATE.UNAPPLIED, ...empty, po }

  const lines = classifyCommitmentLines(variation, po)
  const existing = lines.filter(l => l.kind === COMMITMENT_LINE_KIND.EXISTING_LINE)
  const newScope = lines.filter(l => l.kind === COMMITMENT_LINE_KIND.NEW_SCOPE)
  const invalid  = lines.filter(l => l.kind === COMMITMENT_LINE_KIND.INVALID)
  const counts = { existing: existing.length, newScope: newScope.length, invalid: invalid.length }
  const matured = sumAmounts(existing)
  const totals = { matured, outstanding: roundMoney(gross - matured), newScope: sumAmounts(newScope), invalid: sumAmounts(invalid) }

  let state
  if (invalid.length > 0) state = INCORPORATION_STATE.EXCEPTION
  else if (existing.length > 0 && newScope.length > 0) state = INCORPORATION_STATE.PARTIAL
  else if (existing.length > 0) state = INCORPORATION_STATE.INCORPORATED
  else state = INCORPORATION_STATE.NOT_INCORPORATED
  return { state, applied: true, po, lines, gross, ...totals, counts }
}

// THE ONE shared adjustment map every commitment consumer reads (Budget,
// Forecast, Commercial, Overview, Dashboard, Cash Flow, PULSE, SHIELD, the
// claim editor). Over APPLIED, approved, PO-linked supplier variations:
//   byPoLine         { [poId]: { [poLineIndex]: Σ signed amount } }  — EXISTING_LINE
//                    lines on a sent/closed PO only; the input to
//                    lib/purchaseOrders.js → remainingCommittedByPoLine
//   byCostCode       the same, grouped by the PO LINE's cost code
//   newScopeByCostCode   applied NEW_SCOPE lines, by the line's own cost code
//   exceptions       one row per INVALID line and per PO line whose revised
//                    value is negative — listed, never counted elsewhere
//   incorporations   { [variationId]: variationIncorporation(...) }
// Lines are aggregated once per variation per PO line; a variation document
// appears once in `incorporations`, so nothing can be applied twice at read
// time regardless of how the register is ordered.
export function appliedSupplierVariationAdjustments(variations, purchaseOrders) {
  const byPoLine = {}
  const byCostCode = {}
  const newScopeByCostCode = {}
  const exceptions = []
  const incorporations = {}
  const seen = new Set()

  for (const v of variations ?? []) {
    if (!v || !isPoLinkedSupplierVariation(v) || !VARIATION_APPROVED_STATUSES.includes(v.status) || !isCommitmentApplied(v)) continue
    if (v.id && seen.has(v.id)) continue
    if (v.id) seen.add(v.id)
    const inc = variationIncorporation(v, purchaseOrders)
    if (v.id) incorporations[v.id] = inc
    for (const l of inc.lines) {
      if (l.kind === COMMITMENT_LINE_KIND.EXISTING_LINE) {
        const forPo = byPoLine[v.poId] ?? (byPoLine[v.poId] = {})
        forPo[l.poLineIndex] = roundMoney((forPo[l.poLineIndex] || 0) + l.amount)
        byCostCode[l.poLineCostCodeId] = roundMoney((byCostCode[l.poLineCostCodeId] || 0) + l.amount)
      } else if (l.kind === COMMITMENT_LINE_KIND.NEW_SCOPE) {
        if (l.costCodeId) newScopeByCostCode[l.costCodeId] = roundMoney((newScopeByCostCode[l.costCodeId] || 0) + l.amount)
      } else {
        exceptions.push({
          kind: 'invalid_line', issue: l.issue, issueLabel: COMMITMENT_LINE_ISSUE_LABELS[l.issue] ?? l.issue,
          variationId: v.id ?? null, variationNumber: v.variationNumber || '',
          poId: v.poId, poNumber: v.poNumber || inc.po?.poNumber || '', poStatus: inc.po?.status ?? null,
          lineIndex: l.lineIndex, poLineIndex: l.poLineIndex, amount: l.amount,
          costCodeId: l.costCodeId, costCodeName: l.costCodeName, poLineCostCodeId: l.poLineCostCodeId,
        })
      }
    }
  }

  // A PO line whose revised contractual value is negative (adjustments below
  // the original line) is a commercial anomaly: Remaining Committed floors it
  // at zero, so it is listed here rather than hidden.
  for (const po of purchaseOrders ?? []) {
    const forPo = byPoLine[po?.id]
    if (!forPo) continue
    ;(po.lineItems ?? []).forEach((li, idx) => {
      if (!(idx in forPo)) return
      const revised = roundMoney((Number(li?.lineTotal) || 0) + forPo[idx])
      if (revised < 0) {
        exceptions.push({
          kind: 'negative_revised_line', issue: 'negative_revised_line', issueLabel: 'Revised PO line value is negative',
          variationId: null, variationNumber: '', poId: po.id, poNumber: po.poNumber || '', poStatus: po.status ?? null,
          lineIndex: null, poLineIndex: idx, amount: revised,
          costCodeId: li?.costCodeId || '', costCodeName: li?.costCodeName || '', poLineCostCodeId: li?.costCodeId || null,
        })
      }
    })
  }

  return { byPoLine, byCostCode, newScopeByCostCode, exceptions, incorporations }
}

// Approved supplier-variation value NOT inside Remaining Committed, by cost
// code: every line of an unapplied variation, plus the new-scope and invalid
// lines of an applied one. Signed, never clamped. By construction
//   approvedSupplierVariationsByCostCode == applied.byCostCode + this map
// (per cost code), so nothing is counted twice and nothing disappears.
export function unappliedSupplierVariationsByCostCode(variations, purchaseOrders) {
  const map = {}
  const add = (costCodeId, amount) => {
    if (!costCodeId) return
    map[costCodeId] = roundMoney((map[costCodeId] || 0) + (amount ?? 0))
  }
  for (const v of variations ?? []) {
    if (!v || v.variationType !== VARIATION_TYPE.SUPPLIER || !VARIATION_APPROVED_STATUSES.includes(v.status)) continue
    const applied = isPoLinkedSupplierVariation(v) && isCommitmentApplied(v)
    if (!applied) {
      for (const li of v.lineItems ?? []) add(li?.costCodeId, Number(li?.approvedAmount) || 0)
      continue
    }
    const inc = variationIncorporation(v, purchaseOrders)
    for (const l of inc.lines) {
      if (l.kind === COMMITMENT_LINE_KIND.EXISTING_LINE) continue
      add(l.costCodeId, l.amount ?? 0)
    }
  }
  return map
}

const sumMap = (map) => roundMoney(Object.values(map).reduce((s, v) => s + (Number(v) || 0), 0))

export const unappliedSupplierVariationsTotal = (variations, purchaseOrders) =>
  sumMap(unappliedSupplierVariationsByCostCode(variations, purchaseOrders))

export const appliedSupplierVariationsTotal = (variations, purchaseOrders) =>
  sumMap(appliedSupplierVariationAdjustments(variations, purchaseOrders).byCostCode)

// ── Apply eligibility (legacy Apply and the approve-time decision) ───────────

export const COMMITMENT_APPLY_BLOCKER = {
  NOT_SUPPLIER:     'not_supplier',
  MANUAL_MODE:      'manual_mode',
  NOT_APPROVED:     'not_approved',
  ALREADY_APPLIED:  'already_applied',
  PO_MISSING:       'po_missing',
  PO_NOT_COMMITTED: 'po_not_committed',
}

export const COMMITMENT_APPLY_BLOCKER_MESSAGES = {
  [COMMITMENT_APPLY_BLOCKER.NOT_SUPPLIER]:     'Only supplier variations adjust a purchase order commitment.',
  [COMMITMENT_APPLY_BLOCKER.MANUAL_MODE]:      'This variation names no purchase order, so there is no commitment to adjust.',
  [COMMITMENT_APPLY_BLOCKER.NOT_APPROVED]:     'Only an approved variation can be applied to a commitment.',
  [COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED]:  'This variation has already been applied to its purchase order commitment.',
  [COMMITMENT_APPLY_BLOCKER.PO_MISSING]:       'The linked purchase order could not be found in this project.',
  [COMMITMENT_APPLY_BLOCKER.PO_NOT_COMMITTED]: 'The linked purchase order is not sent or closed, so the variation cannot be applied to its commitment.',
}

// Whether `variation` may be applied to its PO's commitment right now, against
// the PO register. `po` is the resolved PO (or null). Pure; the transaction in
// lib/variationActions.js re-runs the same decision against the SERVER copies.
export function commitmentApplyEligibility(variation, purchaseOrders) {
  const po = (purchaseOrders ?? []).find(p => p?.id === variation?.poId) ?? null
  const refuse = (blocker) => ({ eligible: false, blocker, message: COMMITMENT_APPLY_BLOCKER_MESSAGES[blocker], po })
  if (variation?.variationType !== VARIATION_TYPE.SUPPLIER) return refuse(COMMITMENT_APPLY_BLOCKER.NOT_SUPPLIER)
  if (!isPoLinkedSupplierVariation(variation)) return refuse(COMMITMENT_APPLY_BLOCKER.MANUAL_MODE)
  if (!VARIATION_APPROVED_STATUSES.includes(variation.status)) return refuse(COMMITMENT_APPLY_BLOCKER.NOT_APPROVED)
  if (isCommitmentApplied(variation)) return refuse(COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED)
  if (!po) return refuse(COMMITMENT_APPLY_BLOCKER.PO_MISSING)
  if (!COMMITMENT_PO_STATUSES.includes(po.status)) return refuse(COMMITMENT_APPLY_BLOCKER.PO_NOT_COMMITTED)
  return { eligible: true, blocker: null, message: null, po }
}

// The approve-time decision over the SERVER copy of the PO: a PO-linked
// supplier variation may be approved — and is applied in the same write — iff
// its PO exists and is sent/closed. Anything else REFUSES the approval
// (ADR-62 Correction A; the variation is withdrawn or rejected instead).
export const shouldApplyOnApproval = (variation, po) =>
  isPoLinkedSupplierVariation(variation) && !!po && COMMITMENT_PO_STATUSES.includes(po.status)
