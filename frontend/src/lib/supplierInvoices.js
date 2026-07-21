import { PO_STATUS, GST_RATE, roundMoney } from './purchaseOrders'

// ── Supplier Invoices (accounts payable) ─────────────────────────────────────
// Supplier invoices are the cost-side "bills" a company receives from its
// suppliers/subcontractors. They are distinct from future client/accounts-
// receivable invoices — the general word "invoices" is reserved for those.
//
// All canonical line amounts are ex-GST; GST is stored per line as gstAmount.
// Financial figures are always derived at read time (like POs/claims) — invoice
// code never writes onto Budget Line documents.

export const SI_STATUS = {
  DRAFT:        'draft',
  RECEIVED:     'received',      // reserved — no UI transition yet
  UNDER_REVIEW: 'under_review',  // reserved — no UI transition yet
  APPROVED:     'approved',
  DISPUTED:     'disputed',      // reserved — no UI transition yet
  POSTED:       'posted',
  PAID:         'paid',          // reserved — arrives with the Payments module
  CANCELLED:    'cancelled',
}

export const SI_STATUS_LABELS = {
  [SI_STATUS.DRAFT]:        'Draft',
  [SI_STATUS.RECEIVED]:     'Received',
  [SI_STATUS.UNDER_REVIEW]: 'Under Review',
  [SI_STATUS.APPROVED]:     'Approved',
  [SI_STATUS.DISPUTED]:     'Disputed',
  [SI_STATUS.POSTED]:       'Posted',
  [SI_STATUS.PAID]:         'Paid',
  [SI_STATUS.CANCELLED]:    'Cancelled',
}

// Maps each status onto an existing Badge variant — no new colours.
export const SI_BADGE_VARIANTS = {
  [SI_STATUS.DRAFT]:        'soon',
  [SI_STATUS.RECEIVED]:     'info',
  [SI_STATUS.UNDER_REVIEW]: 'pending',
  [SI_STATUS.APPROVED]:     'info',
  [SI_STATUS.DISPUTED]:     'danger',
  [SI_STATUS.POSTED]:       'active',
  [SI_STATUS.PAID]:         'completed',
  [SI_STATUS.CANCELLED]:    'danger',
}

// Forward-only lifecycle. received/under_review/disputed are reserved (defined
// but no UI transitions into them); paid is reserved for the Payments module.
// posted is terminal in this foundation — corrections are Credit Notes (future).
export const SI_TRANSITIONS = {
  [SI_STATUS.DRAFT]:        [SI_STATUS.APPROVED, SI_STATUS.CANCELLED],
  [SI_STATUS.RECEIVED]:     [],
  [SI_STATUS.UNDER_REVIEW]: [],
  [SI_STATUS.APPROVED]:     [SI_STATUS.POSTED, SI_STATUS.CANCELLED],
  [SI_STATUS.DISPUTED]:     [],
  [SI_STATUS.POSTED]:       [], // paid transition arrives with Payments — no UI yet
  [SI_STATUS.PAID]:         [],
  [SI_STATUS.CANCELLED]:    [],
}

export const canTransition = (from, to) => (SI_TRANSITIONS[from] ?? []).includes(to)

// Statuses whose value counts toward the budget figures. paid is reserved but
// kept here so it counts once the Payments module can set it — future-proof.
export const SI_COUNTING_STATUSES = [SI_STATUS.POSTED, SI_STATUS.PAID]

// A draft invoice is fully editable; everything from approved onward is frozen
// except valid lifecycle actions (client-enforced, matching PO/claim posture).
export const SI_EDITABLE_STATUSES = [SI_STATUS.DRAFT]

export const SI_SOURCE = {
  PROGRESS_CLAIM: 'progress_claim',
  DIRECT_PO:      'direct_po',
}

export const SI_DOC_TYPE = {
  INVOICE:     'invoice',
  CREDIT_NOTE: 'credit_note', // reserved — Credit Notes are a future module
}

// Only sent/closed POs can be invoiced (draft/cancelled POs are not commitments).
export const INVOICEABLE_PO_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED]

// ── Tax codes ────────────────────────────────────────────────────────────────
// Per-line tax treatment lets one invoice mix taxable, GST-free, and input-taxed
// lines. Only `gst` attracts GST; the others are zero-rated. GST-inclusive entry
// is a UI concern — storage is always ex-GST plus gstAmount per line.
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

// GST for one line: 10% of the ex-GST amount for `gst`, otherwise zero.
export function gstForLine(amount, taxCode) {
  const amt = Number(amount) || 0
  return taxCode === TAX_CODE.GST ? roundMoney(amt * GST_RATE) : 0
}

export const formatSupplierInvoiceNumber = (n) => `SI-${String(n).padStart(4, '0')}`

// Header totals from ex-GST line amounts and per-line GST.
//
// Gross invoice values describe the full taxable supply:
//   subtotal   = Σ line amount (ex-GST, gross certified)
//   gstTotal   = Σ line gstAmount (GST on the gross lines)
//   grossTotal = subtotal + gstTotal
//
// Retention is a header-level ex-GST withholding. It carries its own GST so the
// payable figures reconcile to a Progress Claim, whose GST is computed on the
// net (post-retention) amount. Retention GST is 10% of the retained amount
// (Progress Claims use flat 10%); direct invoices use retention 0, so all
// retention figures fall to 0.
//   retention      = retained ex-GST (clamped to subtotal)
//   retentionGst   = retained × 10%
//   retentionTotal = retention + retentionGst
//
// Payable values are what is actually due this invoice — never the full
// tax-invoice value:
//   net          = subtotal − retention
//   payableGst   = gstTotal − retentionGst   (equals a claim's approvedGst)
//   payableTotal = grossTotal − retentionTotal (equals a claim's approvedTotal)
export function invoiceTotals(lineItems, retention = 0) {
  const subtotal   = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.amount) || 0), 0))
  const gstTotal   = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.gstAmount) || 0), 0))
  const grossTotal = roundMoney(subtotal + gstTotal)
  const retained       = Math.min(roundMoney(Number(retention) || 0), subtotal)
  const retentionGst   = roundMoney(retained * GST_RATE)
  const retentionTotal = roundMoney(retained + retentionGst)
  const net          = roundMoney(subtotal - retained)
  const payableGst   = roundMoney(gstTotal - retentionGst)
  const payableTotal = roundMoney(grossTotal - retentionTotal)
  return { subtotal, gstTotal, grossTotal, retention: retained, retentionGst, retentionTotal, net, payableGst, payableTotal }
}

// Reconciliation guard for the progress_claim path: a claim-sourced invoice must
// pay exactly the approved claim's certified GST and total. Returns null when it
// reconciles, otherwise a clear message (used to block creation). `approvedGst`
// and `approvedTotal` come from the approved claim (which uses flat 10% GST on
// the net); `payableGst`/`payableTotal` are this invoice's post-retention figures.
export function claimReconciliationError(totals, { approvedGst, approvedTotal } = {}) {
  if (approvedGst == null || approvedTotal == null) {
    return 'The approved claim is missing certified totals — cannot reconcile the invoice.'
  }
  if (roundMoney(totals.payableGst) !== roundMoney(approvedGst)) {
    return `Invoice payable GST (${roundMoney(totals.payableGst)}) does not reconcile to the approved claim GST (${roundMoney(approvedGst)}).`
  }
  if (roundMoney(totals.payableTotal) !== roundMoney(approvedTotal)) {
    return `Invoice payable total (${roundMoney(totals.payableTotal)}) does not reconcile to the approved claim total (${roundMoney(approvedTotal)}).`
  }
  return null
}

// ── Duplicate detection (warning-only, client-enforced) ──────────────────────

// Normalise a supplier invoice reference for comparison: trim, lower-case, strip
// all whitespace so "INV 123" and "inv123" collide.
export const normaliseInvoiceRef = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '')
const normaliseName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

// Warns when the same supplier invoice number already exists for the supplier.
// Keys on supplierId when present; falls back to the supplier name snapshot for
// pre-Contacts (supplierId: null) documents. Cancelled invoices are ignored.
// Never blocks — server-enforced uniqueness is deferred.
export function duplicateInvoiceWarnings(invoices, { id = null, supplierId = null, supplierName = '', supplierInvoiceNumber = '' }) {
  const ref = normaliseInvoiceRef(supplierInvoiceNumber)
  if (!ref) return []
  const name = normaliseName(supplierName)
  const warnings = []
  for (const inv of invoices) {
    if (id && inv.id === id) continue
    if (inv.status === SI_STATUS.CANCELLED) continue
    if (normaliseInvoiceRef(inv.supplierInvoiceNumber) !== ref) continue
    const sameSupplier = supplierId
      ? inv.supplierId === supplierId
      : (!inv.supplierId && normaliseName(inv.supplierName) === name)
    if (sameSupplier) {
      warnings.push({ field: 'supplierInvoiceNumber', message: `Invoice ${inv.supplierInvoiceNumber} already recorded for this supplier (${inv.invoiceNumber}).` })
    }
  }
  return warnings
}

// One approved claim may carry only one non-cancelled supplier invoice.
export const claimHasActiveInvoice = (invoices, progressClaimId) =>
  !!progressClaimId && invoices.some(inv => inv.progressClaimId === progressClaimId && inv.status !== SI_STATUS.CANCELLED)

// ── Read-time budget derivations ─────────────────────────────────────────────

// { costCodeId: ex-GST amount } across counting (posted/paid) invoices. Feeds
// the budget Invoiced column and the invoice side of Actual — never stored.
export function invoicedByCostCode(invoices) {
  const map = {}
  for (const inv of invoices) {
    if (!SI_COUNTING_STATUSES.includes(inv.status)) continue
    for (const li of inv.lineItems ?? []) {
      if (!li.costCodeId) continue
      map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (Number(li.amount) || 0))
    }
  }
  return map
}

// { poId: { poLineIndex: ex-GST posted/paid amount } } — invoiced-to-date per PO
// line. Drives Committed maturing (remaining open commitment) in purchaseOrders.
export function postedInvoicedByPoLine(invoices) {
  const map = {}
  for (const inv of invoices) {
    if (!SI_COUNTING_STATUSES.includes(inv.status)) continue
    if (!inv.poId) continue
    const forPo = map[inv.poId] ?? (map[inv.poId] = {})
    for (const li of inv.lineItems ?? []) {
      if (li.poLineIndex == null) continue
      forPo[li.poLineIndex] = roundMoney((forPo[li.poLineIndex] || 0) + (Number(li.amount) || 0))
    }
  }
  return map
}

// { poId: ex-GST posted/paid total } — invoiced-to-date per PO, for the
// over-invoicing warning against the PO total.
export function postedInvoicedByPo(invoices) {
  const map = {}
  for (const inv of invoices) {
    if (!SI_COUNTING_STATUSES.includes(inv.status)) continue
    if (!inv.poId) continue
    for (const li of inv.lineItems ?? []) {
      map[inv.poId] = roundMoney((map[inv.poId] || 0) + (Number(li.amount) || 0))
    }
  }
  return map
}

// Claim ids referenced by a counting (posted/paid) invoice. Those claims are
// excluded from the claim side of Actual so the posted invoice replaces them
// without double-counting — the claim document is never mutated.
export function invoicedClaimIds(invoices) {
  const set = new Set()
  for (const inv of invoices) {
    if (!SI_COUNTING_STATUSES.includes(inv.status)) continue
    if (inv.progressClaimId) set.add(inv.progressClaimId)
  }
  return set
}

// ── Dates ────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0')
const toIsoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

// Suggests a due date from the invoice date and the supplier's payment terms.
// basis 'invoice' → invoiceDate + days; 'eom' → end of invoice month + days.
// Returns a 'YYYY-MM-DD' string, or '' when inputs are insufficient.
export function suggestDueDate(invoiceDate, paymentTerms) {
  if (!invoiceDate || !paymentTerms || !Number.isFinite(Number(paymentTerms.days))) return ''
  const base = new Date(`${invoiceDate}T00:00:00`)
  if (Number.isNaN(base.getTime())) return ''
  const days = Number(paymentTerms.days)
  if (paymentTerms.basis === 'eom') {
    const eom = new Date(base.getFullYear(), base.getMonth() + 1, 0)
    eom.setDate(eom.getDate() + days)
    return toIsoDate(eom)
  }
  base.setDate(base.getDate() + days)
  return toIsoDate(base)
}

// An invoice is overdue when it has a due date in the past and is neither paid
// nor cancelled. Uses a plain date comparison (dueDate is a 'YYYY-MM-DD' string).
export function isOverdue(invoice, now = new Date()) {
  if (!invoice?.dueDate) return false
  if (invoice.status === SI_STATUS.PAID || invoice.status === SI_STATUS.CANCELLED) return false
  const due = new Date(`${invoice.dueDate}T00:00:00`)
  if (Number.isNaN(due.getTime())) return false
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return due < today
}
