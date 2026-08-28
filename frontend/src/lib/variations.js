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
