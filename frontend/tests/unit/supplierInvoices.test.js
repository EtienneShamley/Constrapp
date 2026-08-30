import { describe, it, expect } from 'vitest'
import {
  SI_STATUS, SI_STATUS_LABELS, SI_BADGE_VARIANTS, SI_TRANSITIONS, canTransition,
  SI_COUNTING_STATUSES, SI_EDITABLE_STATUSES, isEditableInvoice,
  SI_SOURCE, SI_DOC_TYPE, INVOICEABLE_PO_STATUSES,
  TAX_CODE, TAX_CODES, TAX_CODE_LABELS, gstForLine,
  formatSupplierInvoiceNumber, invoiceTotals, claimReconciliationError,
  normaliseInvoiceRef, duplicateInvoiceWarnings, claimHasActiveInvoice,
  invoicedByCostCode, postedInvoicedByPoLine, postedInvoicedByPo, invoicedClaimIds,
  suggestDueDate, isOverdue,
  isClaimSourced, invoiceLineToForm, buildInvoiceLine, invoiceLineInputCountError,
  validateInvoiceDraft, claimSourcedDriftError,
} from '../../src/lib/supplierInvoices'
import { PO_STATUS, GST_RATE, roundMoney, maturedCommittedByCostCode } from '../../src/lib/purchaseOrders'
import { isPayableInvoice, postedSupplierInvoices, payablesSummary } from '../../src/lib/supplierPayments'
import { isCreditableInvoice } from '../../src/lib/supplierCreditNotes'
import { retentionInvoices, retentionInvoiceRows } from '../../src/lib/retention'
import { actualClaimsByCostCode } from '../../src/lib/progressClaims'

// ─────────────────────────────────────────────────────────────────────────────
// lib/supplierInvoices.js — the FIRST dedicated suite for this module.
//
// Supplier Invoices are the accounts-payable spine: `posted` invoices feed
// Budget Invoiced and Actual, mature Committed against the PO, replace the claim
// side of Actual, and are the only invoices a Supplier Payment may settle, a
// Supplier Credit Note may reduce, or Retention may be held against. None of
// that had unit coverage before ADR-38.
//
// This suite therefore CHARACTERISES the existing model first (lifecycle, GST,
// totals, reconciliation, duplicates, the read-time derivations) and only then
// covers the draft-edit helpers added for ADR-38. Nothing below changes existing
// semantics — where the existing behaviour is quirky (a negative retention is
// not clamped; isOverdue ignores payments) it is pinned AS IT IS, with the
// safety layered on top in validateInvoiceDraft instead.
// ─────────────────────────────────────────────────────────────────────────────

const line = (over = {}) => ({
  poLineIndex: 0, costCodeId: 'cc1', costCodeName: 'Concrete', description: 'Slab',
  amount: 1000, taxCode: TAX_CODE.GST, gstAmount: 100, ...over,
})

const invoice = (over = {}) => ({
  id: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-1',
  status: SI_STATUS.DRAFT, docType: SI_DOC_TYPE.INVOICE, source: SI_SOURCE.DIRECT_PO,
  supplierId: 'sup1', supplierName: 'Acme Concrete',
  poId: 'po1', poNumber: 'PO-0001', progressClaimId: null, claimNumber: null,
  invoiceDate: '2026-08-01', receivedDate: '2026-08-02', dueDate: '2026-08-31',
  paymentTerms: { days: 30, basis: 'invoice' },
  lineItems: [line()],
  ...invoiceTotals([line()], 0),
  currency: 'AUD', revision: 1, notes: '',
  ...over,
})

// ── A. Lifecycle ─────────────────────────────────────────────────────────────

describe('supplier invoice lifecycle', () => {
  it('exposes exactly the statuses the model defines', () => {
    expect(Object.values(SI_STATUS)).toEqual([
      'draft', 'received', 'under_review', 'approved', 'disputed', 'posted', 'paid', 'cancelled',
    ])
  })

  it('labels and badges every status, so a legacy document always renders', () => {
    for (const status of Object.values(SI_STATUS)) {
      expect(SI_STATUS_LABELS[status]).toBeTruthy()
      expect(SI_BADGE_VARIANTS[status]).toBeTruthy()
    }
  })

  it('permits only draft -> approved|cancelled and approved -> posted|cancelled', () => {
    expect(canTransition('draft', 'approved')).toBe(true)
    expect(canTransition('draft', 'cancelled')).toBe(true)
    expect(canTransition('approved', 'posted')).toBe(true)
    expect(canTransition('approved', 'cancelled')).toBe(true)
  })

  it('refuses every reversal and every skipped step', () => {
    expect(canTransition('draft', 'posted')).toBe(false)
    expect(canTransition('approved', 'draft')).toBe(false)
    expect(canTransition('posted', 'approved')).toBe(false)
    expect(canTransition('posted', 'cancelled')).toBe(false)
    expect(canTransition('cancelled', 'draft')).toBe(false)
    expect(canTransition('draft', 'draft')).toBe(false)
    expect(canTransition('nonsense', 'approved')).toBe(false)
  })

  it('makes posted and cancelled terminal', () => {
    expect(SI_TRANSITIONS[SI_STATUS.POSTED]).toEqual([])
    expect(SI_TRANSITIONS[SI_STATUS.CANCELLED]).toEqual([])
  })

  it('leaves the reserved statuses with no transitions in either direction', () => {
    for (const reserved of [SI_STATUS.RECEIVED, SI_STATUS.UNDER_REVIEW, SI_STATUS.DISPUTED]) {
      expect(SI_TRANSITIONS[reserved]).toEqual([])
      for (const from of Object.values(SI_STATUS)) {
        expect(canTransition(from, reserved)).toBe(false)
      }
    }
  })

  it('keeps `paid` unreachable — payment state derives from allocations (ADR-24)', () => {
    expect(SI_TRANSITIONS[SI_STATUS.PAID]).toEqual([])
    for (const from of Object.values(SI_STATUS)) {
      expect(canTransition(from, SI_STATUS.PAID)).toBe(false)
    }
  })

  it('counts posted AND the forgeable legacy `paid` toward the budget figures', () => {
    // Deliberately retained: lifecycle rules are deferred, so a forged `paid`
    // document must stay VISIBLE in Actual rather than silently vanish.
    expect(SI_COUNTING_STATUSES).toEqual([SI_STATUS.POSTED, SI_STATUS.PAID])
  })

  it('makes draft the one and only editable status (the approved freeze point)', () => {
    expect(SI_EDITABLE_STATUSES).toEqual([SI_STATUS.DRAFT])
    expect(isEditableInvoice(invoice({ status: SI_STATUS.DRAFT }))).toBe(true)
    for (const status of ['received', 'under_review', 'approved', 'disputed', 'posted', 'paid', 'cancelled']) {
      expect(isEditableInvoice(invoice({ status }))).toBe(false)
    }
    expect(isEditableInvoice(null)).toBe(false)
    expect(isEditableInvoice(undefined)).toBe(false)
    expect(isEditableInvoice({})).toBe(false)
  })

  it('keeps the authoring freeze point EARLIER than the financial counting point', () => {
    // approved freezes content; posted starts counting. They are different
    // points and editing must never be confused with posting.
    expect(SI_EDITABLE_STATUSES).not.toContain(SI_STATUS.APPROVED)
    expect(SI_COUNTING_STATUSES).not.toContain(SI_STATUS.APPROVED)
    expect(SI_COUNTING_STATUSES).not.toContain(SI_STATUS.DRAFT)
  })

  it('supports exactly two sources and one live docType', () => {
    expect(Object.values(SI_SOURCE)).toEqual(['progress_claim', 'direct_po'])
    expect(SI_DOC_TYPE.INVOICE).toBe('invoice')
    expect(INVOICEABLE_PO_STATUSES).toEqual([PO_STATUS.SENT, PO_STATUS.CLOSED])
  })

  it('identifies claim-sourced invoices, and nothing else', () => {
    expect(isClaimSourced(invoice({ source: SI_SOURCE.PROGRESS_CLAIM }))).toBe(true)
    expect(isClaimSourced(invoice({ source: SI_SOURCE.DIRECT_PO }))).toBe(false)
    expect(isClaimSourced(invoice({ source: undefined }))).toBe(false)
    expect(isClaimSourced(null)).toBe(false)
  })

  it('formats the internal invoice number with four padded digits', () => {
    expect(formatSupplierInvoiceNumber(1)).toBe('SI-0001')
    expect(formatSupplierInvoiceNumber(42)).toBe('SI-0042')
    expect(formatSupplierInvoiceNumber(12345)).toBe('SI-12345')
  })
})

// ── B. gstForLine ────────────────────────────────────────────────────────────

describe('gstForLine — only `gst` attracts GST', () => {
  it('charges a flat 10% on a `gst` line', () => {
    expect(GST_RATE).toBe(0.1)
    expect(gstForLine(1000, TAX_CODE.GST)).toBe(100)
    expect(gstForLine(1234.56, TAX_CODE.GST)).toBe(123.46)
  })

  it('zero-rates gst_free and input_taxed', () => {
    expect(gstForLine(1000, TAX_CODE.GST_FREE)).toBe(0)
    expect(gstForLine(1000, TAX_CODE.INPUT_TAXED)).toBe(0)
  })

  it('zero-rates an unknown, missing or malformed code — existing semantics, unchanged', () => {
    // Deliberately NOT tightened for ADR-38: the safe arithmetic answer here is
    // "no GST". Edit rejects an invalid authored code in validateInvoiceDraft
    // instead, so a legacy document is never silently taxed.
    expect(gstForLine(1000, 'vat')).toBe(0)
    expect(gstForLine(1000, null)).toBe(0)
    expect(gstForLine(1000, undefined)).toBe(0)
    expect(gstForLine(1000, '')).toBe(0)
  })

  it('coerces a malformed amount to zero', () => {
    expect(gstForLine('abc', TAX_CODE.GST)).toBe(0)
    expect(gstForLine(null, TAX_CODE.GST)).toBe(0)
    expect(gstForLine('1000', TAX_CODE.GST)).toBe(100)
  })

  it('rounds to cents', () => {
    expect(gstForLine(0.05, TAX_CODE.GST)).toBe(0.01)
    expect(gstForLine(33.33, TAX_CODE.GST)).toBe(3.33)
  })

  it('names every supported code and offers no others', () => {
    expect(TAX_CODES).toEqual(['gst', 'gst_free', 'input_taxed'])
    for (const tc of TAX_CODES) expect(TAX_CODE_LABELS[tc]).toBeTruthy()
  })
})

// ── C. invoiceTotals ─────────────────────────────────────────────────────────

describe('invoiceTotals — gross supply vs payable', () => {
  it('derives the gross figures from the ex-GST lines', () => {
    const t = invoiceTotals([line({ amount: 1000, gstAmount: 100 }), line({ amount: 500, gstAmount: 50 })], 0)
    expect(t.subtotal).toBe(1500)
    expect(t.gstTotal).toBe(150)
    expect(t.grossTotal).toBe(1650)
  })

  it('leaves every retention figure at zero when nothing is withheld', () => {
    const t = invoiceTotals([line()], 0)
    expect(t.retention).toBe(0)
    expect(t.retentionGst).toBe(0)
    expect(t.retentionTotal).toBe(0)
    expect(t.net).toBe(t.subtotal)
    expect(t.payableGst).toBe(t.gstTotal)
    expect(t.payableTotal).toBe(t.grossTotal)
  })

  it('withholds retention with its own GST so the payable reconciles to a claim', () => {
    const t = invoiceTotals([line({ amount: 1000, gstAmount: 100 })], 50)
    expect(t.retention).toBe(50)
    expect(t.retentionGst).toBe(5)
    expect(t.retentionTotal).toBe(55)
    expect(t.net).toBe(950)
    expect(t.payableGst).toBe(95)
    expect(t.payableTotal).toBe(1045)
  })

  it('supports a mixed-tax invoice', () => {
    const t = invoiceTotals([
      line({ amount: 1000, taxCode: TAX_CODE.GST, gstAmount: 100 }),
      line({ amount: 500,  taxCode: TAX_CODE.GST_FREE, gstAmount: 0 }),
      line({ amount: 250,  taxCode: TAX_CODE.INPUT_TAXED, gstAmount: 0 }),
    ], 0)
    expect(t.subtotal).toBe(1750)
    expect(t.gstTotal).toBe(100)
    expect(t.grossTotal).toBe(1850)
  })

  it('CLAMPS retention above the subtotal down to the subtotal', () => {
    const t = invoiceTotals([line({ amount: 1000, gstAmount: 100 })], 5000)
    expect(t.retention).toBe(1000)
    expect(t.net).toBe(0)
    expect(t.payableTotal).toBe(0)
  })

  it('does NOT clamp a NEGATIVE retention — existing behaviour, pinned', () => {
    // Only the UPPER bound is clamped. A negative retention would make the
    // payable EXCEED the gross supply, which is why validateInvoiceDraft
    // rejects it before any write rather than this helper being changed.
    const t = invoiceTotals([line({ amount: 1000, gstAmount: 100 })], -100)
    expect(t.retention).toBe(-100)
    expect(t.net).toBe(1100)
    expect(t.payableTotal).toBe(1210)
    expect(t.payableTotal).toBeGreaterThan(t.grossTotal)
  })

  it('handles empty, null and undefined line sets', () => {
    for (const lines of [[], null, undefined]) {
      const t = invoiceTotals(lines, 0)
      expect(t.subtotal).toBe(0)
      expect(t.gstTotal).toBe(0)
      expect(t.grossTotal).toBe(0)
      expect(t.payableTotal).toBe(0)
    }
  })

  it('coerces malformed line amounts and a malformed retention to zero', () => {
    const t = invoiceTotals([line({ amount: 'abc', gstAmount: null }), line({ amount: '250', gstAmount: '25' })], 'oops')
    expect(t.subtotal).toBe(250)
    expect(t.gstTotal).toBe(25)
    expect(t.retention).toBe(0)
  })

  it('rounds every figure to cents', () => {
    const t = invoiceTotals([line({ amount: 0.1, gstAmount: 0.01 }), line({ amount: 0.2, gstAmount: 0.02 })], 0)
    expect(t.subtotal).toBe(0.3)
    expect(t.grossTotal).toBe(0.33)
  })

  it('defaults retention to zero when omitted', () => {
    expect(invoiceTotals([line()]).retention).toBe(0)
  })
})

// ── D. claimReconciliationError ──────────────────────────────────────────────

describe('claimReconciliationError — the create-time claim guard', () => {
  const totals = invoiceTotals([line({ amount: 1000, gstAmount: 100 })], 50)

  it('passes when the payable figures equal the certified claim figures', () => {
    expect(claimReconciliationError(totals, { approvedGst: 95, approvedTotal: 1045 })).toBeNull()
  })

  it('reports GST drift', () => {
    expect(claimReconciliationError(totals, { approvedGst: 100, approvedTotal: 1045 }))
      .toMatch(/payable GST/)
  })

  it('reports payable-total drift', () => {
    expect(claimReconciliationError(totals, { approvedGst: 95, approvedTotal: 2000 }))
      .toMatch(/payable total/)
  })

  it('refuses a claim missing its certified totals', () => {
    expect(claimReconciliationError(totals, {})).toMatch(/missing certified totals/)
    expect(claimReconciliationError(totals, { approvedGst: 95, approvedTotal: null })).toMatch(/missing certified totals/)
    expect(claimReconciliationError(totals)).toMatch(/missing certified totals/)
  })
})

// ── E. duplicateInvoiceWarnings ──────────────────────────────────────────────

describe('duplicateInvoiceWarnings — warning-only duplicate detection', () => {
  const existing = [
    invoice({ id: 'a', invoiceNumber: 'SI-0001', supplierId: 'sup1', supplierName: 'Acme', supplierInvoiceNumber: 'INV 123' }),
    invoice({ id: 'b', invoiceNumber: 'SI-0002', supplierId: 'sup2', supplierName: 'Other', supplierInvoiceNumber: 'INV 123' }),
  ]

  it('normalises case and whitespace so "INV 123" and "inv123" collide', () => {
    expect(normaliseInvoiceRef('  INV 123 ')).toBe('inv123')
    expect(normaliseInvoiceRef(null)).toBe('')
    const w = duplicateInvoiceWarnings(existing, { supplierId: 'sup1', supplierName: 'Acme', supplierInvoiceNumber: 'inv123' })
    expect(w).toHaveLength(1)
    expect(w[0].field).toBe('supplierInvoiceNumber')
    expect(w[0].message).toMatch(/SI-0001/)
  })

  it('keys on supplierId, so the same reference for a different supplier is fine', () => {
    expect(duplicateInvoiceWarnings(existing, { supplierId: 'sup3', supplierName: 'Third', supplierInvoiceNumber: 'INV 123' })).toEqual([])
  })

  it('falls back to the supplier NAME for legacy supplierId:null documents', () => {
    const legacy = [invoice({ id: 'c', invoiceNumber: 'SI-0009', supplierId: null, supplierName: '  Acme   Concrete ', supplierInvoiceNumber: 'INV-9' })]
    expect(duplicateInvoiceWarnings(legacy, { supplierId: null, supplierName: 'acme concrete', supplierInvoiceNumber: 'inv-9' })).toHaveLength(1)
    expect(duplicateInvoiceWarnings(legacy, { supplierId: null, supplierName: 'Someone Else', supplierInvoiceNumber: 'inv-9' })).toEqual([])
  })

  it('ignores cancelled invoices', () => {
    const cancelled = [invoice({ id: 'd', supplierId: 'sup1', supplierInvoiceNumber: 'INV-5', status: SI_STATUS.CANCELLED })]
    expect(duplicateInvoiceWarnings(cancelled, { supplierId: 'sup1', supplierName: 'Acme', supplierInvoiceNumber: 'INV-5' })).toEqual([])
  })

  it('warns against a DRAFT sibling — a draft still holds the reference', () => {
    const drafts = [invoice({ id: 'e', invoiceNumber: 'SI-0007', supplierId: 'sup1', supplierInvoiceNumber: 'INV-7', status: SI_STATUS.DRAFT })]
    expect(duplicateInvoiceWarnings(drafts, { supplierId: 'sup1', supplierName: 'Acme', supplierInvoiceNumber: 'INV-7' })).toHaveLength(1)
  })

  it('EXCLUDES the invoice being edited, so an untouched draft never warns against itself', () => {
    // ADR-38 D3: the `id` parameter existed from the beginning and the create
    // path never passed it. Edit does.
    const self = [invoice({ id: 'me', invoiceNumber: 'SI-0011', supplierId: 'sup1', supplierInvoiceNumber: 'INV-11' })]
    expect(duplicateInvoiceWarnings(self, { supplierId: 'sup1', supplierName: 'Acme', supplierInvoiceNumber: 'INV-11' })).toHaveLength(1)
    expect(duplicateInvoiceWarnings(self, { id: 'me', supplierId: 'sup1', supplierName: 'Acme', supplierInvoiceNumber: 'INV-11' })).toEqual([])
  })

  it('returns nothing for an empty or whitespace reference', () => {
    expect(duplicateInvoiceWarnings(existing, { supplierId: 'sup1', supplierName: 'Acme', supplierInvoiceNumber: '' })).toEqual([])
    expect(duplicateInvoiceWarnings(existing, { supplierId: 'sup1', supplierName: 'Acme', supplierInvoiceNumber: '   ' })).toEqual([])
    expect(duplicateInvoiceWarnings(existing, {})).toEqual([])
  })

  it('NEVER blocks — it only ever returns warnings', () => {
    const many = duplicateInvoiceWarnings(
      [...existing, invoice({ id: 'f', invoiceNumber: 'SI-0003', supplierId: 'sup1', supplierInvoiceNumber: 'INV123' })],
      { supplierId: 'sup1', supplierName: 'Acme', supplierInvoiceNumber: 'INV 123' },
    )
    expect(many).toHaveLength(2)
    expect(many.every(w => typeof w.message === 'string')).toBe(true)
  })
})

// ── F. claimHasActiveInvoice ─────────────────────────────────────────────────

describe('claimHasActiveInvoice — one active invoice per approved claim', () => {
  it('counts a DRAFT invoice as active', () => {
    const invs = [invoice({ progressClaimId: 'pc1', status: SI_STATUS.DRAFT })]
    expect(claimHasActiveInvoice(invs, 'pc1')).toBe(true)
  })

  it('counts approved and posted invoices as active', () => {
    for (const status of [SI_STATUS.APPROVED, SI_STATUS.POSTED]) {
      expect(claimHasActiveInvoice([invoice({ progressClaimId: 'pc1', status })], 'pc1')).toBe(true)
    }
  })

  it('ignores a cancelled invoice, freeing the claim again', () => {
    expect(claimHasActiveInvoice([invoice({ progressClaimId: 'pc1', status: SI_STATUS.CANCELLED })], 'pc1')).toBe(false)
  })

  it('is false for a null/absent claim id and for an unrelated claim', () => {
    expect(claimHasActiveInvoice([invoice({ progressClaimId: 'pc1' })], null)).toBe(false)
    expect(claimHasActiveInvoice([invoice({ progressClaimId: 'pc1' })], undefined)).toBe(false)
    expect(claimHasActiveInvoice([invoice({ progressClaimId: 'pc1' })], 'pc2')).toBe(false)
    expect(claimHasActiveInvoice([], 'pc1')).toBe(false)
  })
})

// ── G. Read-time budget derivations ──────────────────────────────────────────

describe('read-time derivations exclude drafts and count posted', () => {
  const mk = (status) => invoice({
    id: `i_${status}`, status, poId: 'po1', progressClaimId: 'pc1',
    lineItems: [line({ poLineIndex: 0, costCodeId: 'cc1', amount: 1000 }), line({ poLineIndex: 1, costCodeId: 'cc2', amount: 500 })],
  })

  it('invoicedByCostCode counts posted and legacy paid, never draft/approved/cancelled', () => {
    expect(invoicedByCostCode([mk(SI_STATUS.DRAFT)])).toEqual({})
    expect(invoicedByCostCode([mk(SI_STATUS.APPROVED)])).toEqual({})
    expect(invoicedByCostCode([mk(SI_STATUS.CANCELLED)])).toEqual({})
    expect(invoicedByCostCode([mk(SI_STATUS.POSTED)])).toEqual({ cc1: 1000, cc2: 500 })
    expect(invoicedByCostCode([mk(SI_STATUS.PAID)])).toEqual({ cc1: 1000, cc2: 500 })
  })

  it('invoicedByCostCode sums across invoices and skips lines with no cost code', () => {
    const noCode = invoice({ id: 'x', status: SI_STATUS.POSTED, lineItems: [line({ costCodeId: null, amount: 999 })] })
    expect(invoicedByCostCode([mk(SI_STATUS.POSTED), mk(SI_STATUS.POSTED), noCode])).toEqual({ cc1: 2000, cc2: 1000 })
  })

  it('postedInvoicedByPoLine keys by poId then poLineIndex, drafts excluded', () => {
    expect(postedInvoicedByPoLine([mk(SI_STATUS.DRAFT)])).toEqual({})
    expect(postedInvoicedByPoLine([mk(SI_STATUS.POSTED)])).toEqual({ po1: { 0: 1000, 1: 500 } })
  })

  it('postedInvoicedByPoLine skips a null poId and a null poLineIndex', () => {
    const noPo   = invoice({ id: 'n1', status: SI_STATUS.POSTED, poId: null })
    const noIdx  = invoice({ id: 'n2', status: SI_STATUS.POSTED, poId: 'po2', lineItems: [line({ poLineIndex: null, amount: 42 })] })
    expect(postedInvoicedByPoLine([noPo, noIdx])).toEqual({ po2: {} })
  })

  it('postedInvoicedByPo totals per PO, drafts excluded', () => {
    expect(postedInvoicedByPo([mk(SI_STATUS.DRAFT)])).toEqual({})
    expect(postedInvoicedByPo([mk(SI_STATUS.POSTED)])).toEqual({ po1: 1500 })
  })

  it('invoicedClaimIds excludes a claim only once its invoice is POSTED', () => {
    expect(invoicedClaimIds([mk(SI_STATUS.DRAFT)]).has('pc1')).toBe(false)
    expect(invoicedClaimIds([mk(SI_STATUS.APPROVED)]).has('pc1')).toBe(false)
    expect(invoicedClaimIds([mk(SI_STATUS.POSTED)]).has('pc1')).toBe(true)
    expect(invoicedClaimIds([mk(SI_STATUS.PAID)]).has('pc1')).toBe(true)
  })
})

// ── H. Dates ─────────────────────────────────────────────────────────────────

describe('suggestDueDate', () => {
  it('adds the term days to the invoice date', () => {
    expect(suggestDueDate('2026-08-01', { days: 30, basis: 'invoice' })).toBe('2026-08-31')
  })

  it('adds the term days to the END of the invoice month for `eom`', () => {
    expect(suggestDueDate('2026-08-01', { days: 30, basis: 'eom' })).toBe('2026-09-30')
    expect(suggestDueDate('2026-02-10', { days: 0, basis: 'eom' })).toBe('2026-02-28')
  })

  it('returns an empty string when inputs are insufficient or malformed', () => {
    expect(suggestDueDate('', { days: 30, basis: 'invoice' })).toBe('')
    expect(suggestDueDate('2026-08-01', null)).toBe('')
    expect(suggestDueDate('2026-08-01', { basis: 'invoice' })).toBe('')
    expect(suggestDueDate('not-a-date', { days: 30, basis: 'invoice' })).toBe('')
  })
})

describe('isOverdue — DATE-ONLY, existing documented semantics', () => {
  const now = new Date('2026-08-29T00:00:00')

  it('is true for a past due date on a draft, approved or posted invoice', () => {
    // Payment-unaware BY DESIGN. Badges and figures use isPastDuePayable
    // (lib/supplierPayments.js) instead; this is pinned, not changed.
    for (const status of [SI_STATUS.DRAFT, SI_STATUS.APPROVED, SI_STATUS.POSTED]) {
      expect(isOverdue(invoice({ status, dueDate: '2026-08-01' }), now)).toBe(true)
    }
  })

  it('is false for the vestigial paid guard, for cancelled, and for a future date', () => {
    expect(isOverdue(invoice({ status: SI_STATUS.PAID, dueDate: '2026-08-01' }), now)).toBe(false)
    expect(isOverdue(invoice({ status: SI_STATUS.CANCELLED, dueDate: '2026-08-01' }), now)).toBe(false)
    expect(isOverdue(invoice({ dueDate: '2026-12-01' }), now)).toBe(false)
  })

  it('is false with no due date, a malformed due date, or no invoice', () => {
    expect(isOverdue(invoice({ dueDate: '' }), now)).toBe(false)
    expect(isOverdue(invoice({ dueDate: 'nonsense' }), now)).toBe(false)
    expect(isOverdue(null, now)).toBe(false)
  })
})

// ── I. invoiceLineToForm ─────────────────────────────────────────────────────

describe('invoiceLineToForm — stored line to editor form values', () => {
  it('renders the amount as a string', () => {
    expect(invoiceLineToForm(line({ amount: 1234.5 })).amount).toBe('1234.5')
    expect(invoiceLineToForm(line({ amount: 0 })).amount).toBe('0')
  })

  it("maps a missing, empty or malformed amount to '0', never ''", () => {
    // '' would render an empty input the user could read as "nothing invoiced".
    for (const amount of [undefined, null, '', 'abc', NaN, Infinity]) {
      expect(invoiceLineToForm(line({ amount })).amount).toBe('0')
    }
  })

  it('accepts a numeric string amount', () => {
    expect(invoiceLineToForm(line({ amount: '250.25' })).amount).toBe('250.25')
  })

  it('preserves every valid tax code and reports it valid', () => {
    for (const tc of TAX_CODES) {
      expect(invoiceLineToForm(line({ taxCode: tc }))).toMatchObject({ taxCode: tc, invalidTaxCode: false })
    }
  })

  it('does NOT silently default an UNKNOWN tax code to gst (ADR-38 D7)', () => {
    // Defaulting would quietly add 10% to a line the supplier never taxed, and
    // once posted that lands in Actual. It must stay visible as invalid.
    const unknown = invoiceLineToForm(line({ taxCode: 'vat' }))
    expect(unknown.taxCode).toBe('vat')
    expect(unknown.invalidTaxCode).toBe(true)
  })

  it("maps a missing or non-string tax code to '' and reports it invalid", () => {
    for (const taxCode of [undefined, null, 7, {}]) {
      const form = invoiceLineToForm(line({ taxCode }))
      expect(form.taxCode).toBe('')
      expect(form.invalidTaxCode).toBe(true)
    }
  })

  it('survives a null, undefined or non-object line', () => {
    for (const bad of [null, undefined, 'nope', 42]) {
      expect(invoiceLineToForm(bad)).toEqual({ amount: '0', taxCode: '', invalidTaxCode: true })
    }
  })

  it('does not mutate the stored line', () => {
    const stored = Object.freeze(line({ amount: 'abc', taxCode: 'vat' }))
    expect(() => invoiceLineToForm(stored)).not.toThrow()
    expect(stored.amount).toBe('abc')
    expect(stored.taxCode).toBe('vat')
  })
})

// ── J. buildInvoiceLine ──────────────────────────────────────────────────────

describe('buildInvoiceLine — identity from the source, money re-derived', () => {
  it('reads all four identity fields from the STORED line in edit mode', () => {
    const stored = line({ poLineIndex: 3, costCodeId: 'cc9', costCodeName: 'Steel', description: 'Rebar' })
    const built = buildInvoiceLine(stored, { amount: 250, taxCode: TAX_CODE.GST })
    expect(built).toEqual({
      poLineIndex: 3, costCodeId: 'cc9', costCodeName: 'Steel', description: 'Rebar',
      amount: 250, taxCode: TAX_CODE.GST, gstAmount: 25,
    })
  })

  it('stores EXACTLY the seven canonical keys and nothing else', () => {
    const built = buildInvoiceLine(line({ extra: 'nope', gstAmount: 999 }), { amount: 100, taxCode: TAX_CODE.GST })
    expect(Object.keys(built).sort()).toEqual(
      ['amount', 'costCodeId', 'costCodeName', 'description', 'gstAmount', 'poLineIndex', 'taxCode'],
    )
  })

  it('A CALLER CANNOT REPOINT poLineIndex through the authored values', () => {
    const stored = line({ poLineIndex: 2 })
    // The only way to set an index is the explicit `poLineIndex` option, which
    // CREATE uses to supply the PO line index. EDIT never passes it.
    expect(buildInvoiceLine(stored, { amount: 1, taxCode: TAX_CODE.GST }).poLineIndex).toBe(2)
    expect(buildInvoiceLine(stored, { amount: 1, taxCode: TAX_CODE.GST, costCodeId: 'evil' }).costCodeId).toBe('cc1')
  })

  it('A CALLER CANNOT change the cost code, its name, or the description', () => {
    const stored = line({ costCodeId: 'cc1', costCodeName: 'Concrete', description: 'Slab' })
    const built = buildInvoiceLine(stored, {
      amount: 1, taxCode: TAX_CODE.GST,
      costCodeId: 'hacked', costCodeName: 'Hacked', description: 'Hacked',
    })
    expect(built.costCodeId).toBe('cc1')
    expect(built.costCodeName).toBe('Concrete')
    expect(built.description).toBe('Slab')
  })

  it('ALWAYS re-derives gstAmount and IGNORES a lying caller value', () => {
    const built = buildInvoiceLine(line(), { amount: 1000, taxCode: TAX_CODE.GST, gstAmount: 99999 })
    expect(built.gstAmount).toBe(100)
  })

  it('IGNORES a stored gstAmount that disagrees with its own amount and tax code', () => {
    const forged = line({ amount: 1000, taxCode: TAX_CODE.GST_FREE, gstAmount: 100 })
    expect(buildInvoiceLine(forged, { amount: forged.amount, taxCode: forged.taxCode }).gstAmount).toBe(0)
  })

  it('BY DEFAULT (the EDIT basis) derives gstAmount from the ROUNDED amount', () => {
    const built = buildInvoiceLine(line(), { amount: 100.005, taxCode: TAX_CODE.GST })
    expect(built.amount).toBe(roundMoney(100.005))
    expect(built.gstAmount).toBe(gstForLine(built.amount, built.taxCode))
  })

  it('preserves an invalid tax code rather than repairing it, and zero-rates it', () => {
    const built = buildInvoiceLine(line(), { amount: 1000, taxCode: 'vat' })
    expect(built.taxCode).toBe('vat')
    expect(built.gstAmount).toBe(0)
  })

  it('coerces a malformed amount, index and identity to safe values', () => {
    const built = buildInvoiceLine({ poLineIndex: 'x', costCodeId: 7, costCodeName: null, description: undefined },
      { amount: 'abc', taxCode: null })
    expect(built).toEqual({
      poLineIndex: 0, costCodeId: '', costCodeName: '', description: '',
      amount: 0, taxCode: '', gstAmount: 0,
    })
  })

  it('accepts a numeric-string amount from a form input', () => {
    expect(buildInvoiceLine(line(), { amount: '250.50', taxCode: TAX_CODE.GST })).toMatchObject({ amount: 250.5, gstAmount: 25.05 })
  })

  it('survives a null/undefined source and missing options', () => {
    expect(buildInvoiceLine(null)).toEqual({
      poLineIndex: 0, costCodeId: '', costCodeName: '', description: '',
      amount: 0, taxCode: '', gstAmount: 0,
    })
    expect(buildInvoiceLine(undefined, undefined).amount).toBe(0)
  })

  it('lets CREATE supply the PO line index the PO line does not carry', () => {
    const poLine = { costCodeId: 'cc1', costCodeName: 'Concrete', description: 'Slab', lineTotal: 5000 }
    expect(buildInvoiceLine(poLine, { poLineIndex: 4, amount: 1000, taxCode: TAX_CODE.GST }).poLineIndex).toBe(4)
  })

  it('inherits poLineIndex from a CLAIM line, which already carries one', () => {
    const claimLine = { poLineIndex: 6, costCodeId: 'cc2', costCodeName: 'Steel', description: 'Beams', approvedThisPeriod: 800 }
    expect(buildInvoiceLine(claimLine, { amount: 800, taxCode: TAX_CODE.GST }).poLineIndex).toBe(6)
  })

  it('ANTI-DRIFT: create and edit produce an identical line for identical money', () => {
    // CREATE builds from a PO line + index; EDIT rebuilds from the stored line.
    // Round-tripping must be a fixed point, or a save would silently move money.
    const poLine = { costCodeId: 'cc1', costCodeName: 'Concrete', description: 'Slab', lineTotal: 5000 }
    const created = buildInvoiceLine(poLine, { poLineIndex: 0, amount: 1234.56, taxCode: TAX_CODE.GST, gstFromUnroundedAmount: true })
    const edited  = buildInvoiceLine(created, { amount: created.amount, taxCode: created.taxCode })
    expect(edited).toEqual(created)
  })

  it('is a fixed point across repeated rebuilds for every tax code', () => {
    for (const tc of TAX_CODES) {
      const once  = buildInvoiceLine(line(), { amount: 987.65, taxCode: tc })
      const twice = buildInvoiceLine(once, { amount: once.amount, taxCode: once.taxCode })
      expect(twice).toEqual(once)
    }
  })

  it('does not mutate its source line', () => {
    const stored = Object.freeze(line())
    expect(() => buildInvoiceLine(stored, { amount: 5, taxCode: TAX_CODE.GST_FREE })).not.toThrow()
    expect(stored.amount).toBe(1000)
    expect(stored.taxCode).toBe(TAX_CODE.GST)
    expect(stored.gstAmount).toBe(100)
  })
})

// ── J2. CREATE arithmetic is preserved byte for byte ─────────────────────────

describe('buildInvoiceLine — gstFromUnroundedAmount preserves pre-ADR-38 CREATE', () => {
  // The exact expression the create modal used BEFORE the shared builder existed:
  //   amount:    roundMoney(entered)
  //   gstAmount: gstForLine(entered, tc)   <- the UNROUNDED figure
  const legacyCreateLine = (src, entered, tc, poLineIndex) => ({
    poLineIndex,
    costCodeId:   src.costCodeId,
    costCodeName: src.costCodeName,
    description:  src.description || '',
    amount:       roundMoney(entered),
    taxCode:      tc,
    gstAmount:    gstForLine(entered, tc),
  })
  const poLine = { costCodeId: 'cc1', costCodeName: 'Concrete', description: 'Slab', lineTotal: 5000 }
  const create = (entered, tc = TAX_CODE.GST) =>
    buildInvoiceLine(poLine, { poLineIndex: 0, amount: entered, taxCode: tc, gstFromUnroundedAmount: true })

  it('the two GST bases genuinely differ for a >2-decimal entry — the regression is real', () => {
    // 1234.045 stores as 1234.05; GST is 123.40 from the raw figure but 123.41
    // from the rounded one. Without the flag CREATE would have shifted a cent.
    expect(gstForLine(1234.045, TAX_CODE.GST)).toBe(123.4)
    expect(gstForLine(roundMoney(1234.045), TAX_CODE.GST)).toBe(123.41)
  })

  it('CREATE output is byte-identical to the old expression for a >2-decimal entry', () => {
    for (const entered of [1234.045, 0.045, 0.145, 99.999, 10.0449]) {
      expect(create(entered)).toEqual(legacyCreateLine(poLine, entered, TAX_CODE.GST, 0))
    }
  })

  it('CREATE keeps the old GST even where it disagrees with the stored amount', () => {
    const built = create(1234.045)
    expect(built.amount).toBe(1234.05)
    expect(built.gstAmount).toBe(123.4)
    expect(built.gstAmount).not.toBe(gstForLine(built.amount, built.taxCode))
  })

  it('CREATE output is unchanged for ordinary <=2-decimal entries', () => {
    for (const entered of [0, 1, 250.5, 1000, 1234.56, 99999.99]) {
      expect(create(entered)).toEqual(legacyCreateLine(poLine, entered, TAX_CODE.GST, 0))
      // At two decimals the two bases coincide, so the flag is a no-op.
      expect(create(entered)).toEqual(
        buildInvoiceLine(poLine, { poLineIndex: 0, amount: entered, taxCode: TAX_CODE.GST }),
      )
    }
  })

  it('CREATE output is unchanged for the zero-rated codes at any precision', () => {
    for (const tc of [TAX_CODE.GST_FREE, TAX_CODE.INPUT_TAXED]) {
      expect(create(1234.045, tc)).toEqual(legacyCreateLine(poLine, 1234.045, tc, 0))
      expect(create(1234.045, tc).gstAmount).toBe(0)
    }
  })

  it('the flag NEVER affects identity, the stored amount, or the key set', () => {
    const withFlag    = create(1234.045)
    const withoutFlag = buildInvoiceLine(poLine, { poLineIndex: 0, amount: 1234.045, taxCode: TAX_CODE.GST })
    expect(Object.keys(withFlag).sort()).toEqual(Object.keys(withoutFlag).sort())
    for (const key of ['poLineIndex', 'costCodeId', 'costCodeName', 'description', 'amount', 'taxCode']) {
      expect(withFlag[key]).toEqual(withoutFlag[key])
    }
  })

  it('the flag NEVER makes a caller-supplied gstAmount trusted', () => {
    expect(create(1000).gstAmount).toBe(100)
    expect(buildInvoiceLine(poLine, {
      poLineIndex: 0, amount: 1000, taxCode: TAX_CODE.GST, gstAmount: 99999, gstFromUnroundedAmount: true,
    }).gstAmount).toBe(100)
  })

  it('the CLAIM create path is unaffected — it already hands in a rounded amount', () => {
    const claimLine = { poLineIndex: 6, costCodeId: 'cc2', costCodeName: 'Steel', description: 'Beams', approvedThisPeriod: 1234.045 }
    const seeded = roundMoney(claimLine.approvedThisPeriod || 0)   // what the modal passes
    expect(buildInvoiceLine(claimLine, { amount: seeded, taxCode: TAX_CODE.GST, gstFromUnroundedAmount: true }))
      .toEqual(buildInvoiceLine(claimLine, { amount: seeded, taxCode: TAX_CODE.GST }))
  })

  it('EDIT does NOT use the flag, so a rebuilt line is always self-consistent', () => {
    const created = create(1234.045)
    const edited  = buildInvoiceLine(created, { amount: created.amount, taxCode: created.taxCode })
    expect(edited.gstAmount).toBe(gstForLine(edited.amount, edited.taxCode))
    expect(edited.gstAmount).toBe(123.41)
    // Identity is still carried straight through from the stored line.
    for (const key of ['poLineIndex', 'costCodeId', 'costCodeName', 'description']) {
      expect(edited[key]).toBe(created[key])
    }
  })
})

// ── K. Positional pairing guard ──────────────────────────────────────────────

describe('invoiceLineInputCountError — exact positional pairing', () => {
  const lines = [line(), line({ poLineIndex: 1 }), line({ poLineIndex: 2 })]

  it('accepts exactly one amount and one tax code per stored line', () => {
    expect(invoiceLineInputCountError(lines, ['1', '2', '3'], [TAX_CODE.GST, TAX_CODE.GST, TAX_CODE.GST])).toBeNull()
  })

  it('REJECTS a shorter amounts array rather than padding it', () => {
    expect(invoiceLineInputCountError(lines, ['1', '2'], [TAX_CODE.GST, TAX_CODE.GST, TAX_CODE.GST]))
      .toBe('An amount is required for every invoice line (expected 3, got 2)')
  })

  it('REJECTS a longer amounts array rather than truncating it', () => {
    expect(invoiceLineInputCountError(lines, ['1', '2', '3', '4'], [TAX_CODE.GST, TAX_CODE.GST, TAX_CODE.GST]))
      .toBe('An amount is required for every invoice line (expected 3, got 4)')
  })

  it('rejects a mismatched tax-code array in both directions', () => {
    expect(invoiceLineInputCountError(lines, ['1', '2', '3'], [TAX_CODE.GST]))
      .toBe('A tax code is required for every invoice line (expected 3, got 1)')
    expect(invoiceLineInputCountError(lines, ['1', '2', '3'], new Array(4).fill(TAX_CODE.GST)))
      .toBe('A tax code is required for every invoice line (expected 3, got 4)')
  })

  it('rejects a missing or non-array input', () => {
    for (const bad of [undefined, null, 'nope', 3]) {
      expect(invoiceLineInputCountError(lines, bad, [TAX_CODE.GST, TAX_CODE.GST, TAX_CODE.GST])).toMatch(/An amount is required/)
      expect(invoiceLineInputCountError(lines, ['1', '2', '3'], bad)).toMatch(/A tax code is required/)
    }
  })

  it('rejects an invoice with no stored lines at all', () => {
    for (const bad of [[], null, undefined, 'x']) {
      expect(invoiceLineInputCountError(bad, [], [])).toBe('This supplier invoice has no line items to edit')
    }
  })
})

// ── L. validateInvoiceDraft ──────────────────────────────────────────────────

describe('validateInvoiceDraft', () => {
  const ok = { lineItems: [line()], supplierInvoiceNumber: 'INV-1', invoiceDate: '2026-08-01', retention: 0 }

  it('passes a well-formed draft', () => {
    expect(validateInvoiceDraft(ok)).toBeNull()
  })

  it("requires the supplier's invoice number", () => {
    expect(validateInvoiceDraft({ ...ok, supplierInvoiceNumber: '' })).toMatch(/invoice number is required/)
    expect(validateInvoiceDraft({ ...ok, supplierInvoiceNumber: '   ' })).toMatch(/invoice number is required/)
    expect(validateInvoiceDraft({ ...ok, supplierInvoiceNumber: null })).toMatch(/invoice number is required/)
  })

  it('requires an invoice date', () => {
    expect(validateInvoiceDraft({ ...ok, invoiceDate: '' })).toMatch(/invoice date is required/)
    expect(validateInvoiceDraft({ ...ok, invoiceDate: undefined })).toMatch(/invoice date is required/)
  })

  it('requires at least one line, and at least one line with a POSITIVE amount', () => {
    expect(validateInvoiceDraft({ ...ok, lineItems: [] })).toMatch(/at least one line/)
    expect(validateInvoiceDraft({ ...ok, lineItems: null })).toMatch(/at least one line/)
    expect(validateInvoiceDraft({ ...ok, lineItems: [line({ amount: 0 }), line({ amount: 0 })] }))
      .toMatch(/amount on at least one line/)
  })

  it('accepts a zeroed line as long as one other line carries an amount', () => {
    // A stored line taken to zero keeps its identity and can be brought back.
    expect(validateInvoiceDraft({ ...ok, lineItems: [line({ amount: 0 }), line({ amount: 500 })] })).toBeNull()
  })

  it('REJECTS an invalid or missing tax code on an authored line (ADR-38 D7)', () => {
    expect(validateInvoiceDraft({ ...ok, lineItems: [line({ taxCode: 'vat' })] })).toMatch(/^Line 1: choose a tax code/)
    expect(validateInvoiceDraft({ ...ok, lineItems: [line({ taxCode: '' })] })).toMatch(/^Line 1: choose a tax code/)
    expect(validateInvoiceDraft({ ...ok, lineItems: [line(), line({ taxCode: null })] })).toMatch(/^Line 2: choose a tax code/)
  })

  it('accepts every valid tax code, including a mixed-tax invoice', () => {
    expect(validateInvoiceDraft({ ...ok, lineItems: TAX_CODES.map(tc => line({ taxCode: tc })) })).toBeNull()
  })

  it('REJECTS a negative retention (ADR-38 D6)', () => {
    expect(validateInvoiceDraft({ ...ok, retention: -1 })).toBe('Retention cannot be negative')
    expect(validateInvoiceDraft({ ...ok, retention: '-0.01' })).toBe('Retention cannot be negative')
  })

  it('rejects a non-numeric retention and accepts a numeric string', () => {
    expect(validateInvoiceDraft({ ...ok, retention: 'abc' })).toBe('Retention must be a number')
    expect(validateInvoiceDraft({ ...ok, retention: '50' })).toBeNull()
    expect(validateInvoiceDraft({ ...ok, retention: 0 })).toBeNull()
  })

  it('ALLOWS a retention above the subtotal — invoiceTotals clamps it, unchanged', () => {
    expect(validateInvoiceDraft({ ...ok, retention: 999999 })).toBeNull()
  })

  it('defaults retention to zero when omitted', () => {
    expect(validateInvoiceDraft({ lineItems: [line()], supplierInvoiceNumber: 'X', invoiceDate: '2026-01-01' })).toBeNull()
  })

  it('SKIPS the tax-code and retention clauses when the lines are not authored', () => {
    // The claim-sourced path: those values are the claim's certified figures and
    // are preserved byte-for-byte, so refusing a HEADER fix over odd legacy tax
    // data would block a correction the user cannot otherwise make.
    // claimSourcedDriftError guards that path instead.
    const legacy = { ...ok, lineItems: [line({ taxCode: 'vat' })], retention: -5, authoredLines: false }
    expect(validateInvoiceDraft(legacy)).toBeNull()
    // Still enforced on that path:
    expect(validateInvoiceDraft({ ...legacy, supplierInvoiceNumber: '' })).toMatch(/invoice number is required/)
    expect(validateInvoiceDraft({ ...legacy, invoiceDate: '' })).toMatch(/invoice date is required/)
    expect(validateInvoiceDraft({ ...legacy, lineItems: [line({ taxCode: 'vat', amount: 0 })] })).toMatch(/amount on at least one line/)
  })

  it('does NOT block a duplicate reference or over-invoicing (D3)', () => {
    // Both stay amber warnings; the validator has no knowledge of either.
    expect(validateInvoiceDraft({ ...ok, lineItems: [line({ amount: 999999 })] })).toBeNull()
    expect(validateInvoiceDraft({ ...ok, supplierInvoiceNumber: 'A-DUPLICATE-REF' })).toBeNull()
  })

  it('survives being called with nothing', () => {
    expect(validateInvoiceDraft()).toMatch(/at least one line/)
  })
})

// ── M. Claim-source immutability + reconciliation ────────────────────────────

describe('claimSourcedDriftError — the reconciliation defence in depth', () => {
  // A claim-sourced invoice: gross 1000 + 100 GST, retention 50 + 5, so the
  // payable figures (95 / 1045) equal the approved claim's certified figures.
  const lines = [line({ amount: 1000, taxCode: TAX_CODE.GST, gstAmount: 100 })]
  const claimInv = (over = {}) => invoice({
    source: SI_SOURCE.PROGRESS_CLAIM, progressClaimId: 'pc1', claimNumber: 'PC-0001',
    lineItems: lines, ...invoiceTotals(lines, 50), ...over,
  })
  const rebuild = (inv) => invoiceTotals(
    (inv.lineItems ?? []).map(li => buildInvoiceLine(li, { amount: li.amount, taxCode: li.taxCode })),
    inv.retention,
  )

  it('passes when a rebuild reproduces every stored header total', () => {
    const inv = claimInv()
    expect(claimSourcedDriftError(inv, rebuild(inv))).toBeNull()
    expect(inv.payableGst).toBe(95)
    expect(inv.payableTotal).toBe(1045)
  })

  it('is inert for a direct_po invoice', () => {
    expect(claimSourcedDriftError(invoice({ source: SI_SOURCE.DIRECT_PO }), { payableTotal: -1 })).toBeNull()
    expect(claimSourcedDriftError(null, {})).toBeNull()
  })

  it('REFUSES a stored gstAmount that disagrees with its own amount and tax code', () => {
    // A legacy or forged line: the rebuild would change GST, so the save is
    // refused rather than the document being mutated into agreement.
    const forged = claimInv({ lineItems: [line({ amount: 1000, taxCode: TAX_CODE.GST_FREE, gstAmount: 100 })] })
    const err = claimSourcedDriftError(forged, rebuild(forged))
    expect(err).toMatch(/no longer reconciles to its approved claim/)
    expect(err).toMatch(/SI-0001/)
    expect(err).toMatch(/Cancel it and raise a new invoice/)
  })

  it('names the payable total first when several totals drift', () => {
    const inv = claimInv()
    expect(claimSourcedDriftError(inv, { ...rebuild(inv), payableTotal: 1, payableGst: 2, subtotal: 3 }))
      .toMatch(/payable total/)
  })

  it('reports each individual frozen total when it alone drifts', () => {
    const inv = claimInv()
    const base = rebuild(inv)
    const cases = {
      payableGst: 'payable GST', subtotal: 'subtotal', gstTotal: 'GST total',
      grossTotal: 'gross total', retention: 'retention', retentionGst: 'retention GST',
      retentionTotal: 'retention total', net: 'net',
    }
    for (const [key, label] of Object.entries(cases)) {
      expect(claimSourcedDriftError(inv, { ...base, [key]: base[key] + 1 })).toMatch(new RegExp(label))
    }
  })

  it('REFUSES an invoice missing a stored header total rather than inventing one', () => {
    const inv = claimInv({ payableGst: undefined })
    expect(claimSourcedDriftError(inv, rebuild(inv))).toMatch(/missing its stored payable GST/)
    expect(claimSourcedDriftError(claimInv({ net: 'oops' }), rebuild(claimInv()))).toMatch(/missing its stored net/)
  })

  it('tolerates sub-cent representation noise but not a one-cent discrepancy', () => {
    const inv = claimInv()
    const base = rebuild(inv)
    expect(claimSourcedDriftError(inv, { ...base, payableTotal: base.payableTotal + 0.0001 })).toBeNull()
    expect(claimSourcedDriftError(inv, { ...base, payableTotal: base.payableTotal + 0.01 })).not.toBeNull()
  })

  it('still reconciles to the ORIGINAL claim figures after a rebuild', () => {
    const inv = claimInv()
    expect(claimReconciliationError(rebuild(inv), { approvedGst: 95, approvedTotal: 1045 })).toBeNull()
  })
})

describe('the claim-sourced EDIT contract cannot move certified money', () => {
  // The editor sends { supplierInvoiceNumber, invoiceDate, receivedDate, dueDate,
  // notes } and NOTHING else on this path, and the hook ignores amounts/taxCodes/
  // retention even if supplied. This models that contract as a pure payload
  // builder so the guarantee is asserted, not just described.
  const lines = [line({ amount: 1000, gstAmount: 100 }), line({ poLineIndex: 1, costCodeId: 'cc2', amount: 500, gstAmount: 50 })]
  const stored = invoice({
    source: SI_SOURCE.PROGRESS_CLAIM, progressClaimId: 'pc1', claimNumber: 'PC-0001',
    lineItems: lines, ...invoiceTotals(lines, 100),
  })

  // Mirrors useSupplierInvoices.updateSupplierInvoice on the claim-sourced path.
  const claimUpdatePayload = ({ supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, notes }) => ({
    supplierInvoiceNumber: supplierInvoiceNumber?.trim() || '',
    invoiceDate:  invoiceDate  || '',
    receivedDate: receivedDate || '',
    dueDate:      dueDate      || '',
    notes:        notes?.trim() || '',
  })

  const payload = claimUpdatePayload({
    supplierInvoiceNumber: '  INV-NEW  ', invoiceDate: '2026-09-01',
    receivedDate: '2026-09-02', dueDate: '2026-10-01', notes: '  corrected  ',
    // Everything below is what a hostile or buggy caller might add:
    amounts: ['9999'], taxCodes: [TAX_CODE.GST_FREE], retention: 0,
    lineItems: [line({ amount: 9999 })], status: SI_STATUS.POSTED, supplierId: 'other',
  })

  it('carries EXACTLY the five header authoring fields', () => {
    expect(Object.keys(payload).sort()).toEqual(
      ['dueDate', 'invoiceDate', 'notes', 'receivedDate', 'supplierInvoiceNumber'],
    )
  })

  it('trims the authored strings', () => {
    expect(payload.supplierInvoiceNumber).toBe('INV-NEW')
    expect(payload.notes).toBe('corrected')
  })

  it('carries NO line, tax, retention or total field at all', () => {
    for (const forbidden of [
      'lineItems', 'amounts', 'taxCodes', 'retention', 'retentionGst', 'retentionTotal',
      'subtotal', 'gstTotal', 'grossTotal', 'net', 'payableGst', 'payableTotal',
    ]) {
      expect(payload).not.toHaveProperty(forbidden)
    }
  })

  it('carries NO identity, lifecycle or audit field', () => {
    for (const forbidden of [
      'invoiceNumber', 'status', 'docType', 'source', 'supplierId', 'supplierName',
      'poId', 'poNumber', 'progressClaimId', 'claimNumber', 'paymentTerms',
      'currency', 'revision', 'approvedAt', 'approvedBy', 'postedAt', 'postedBy',
      'cancelledAt', 'paidAt', 'adjustsInvoiceId', 'attachments', 'externalRefs',
      'createdAt', 'createdBy',
    ]) {
      expect(payload).not.toHaveProperty(forbidden)
    }
  })

  it('leaves every certified financial amount byte-identical when merged over the stored document', () => {
    const after = { ...stored, ...payload }
    expect(after.lineItems).toEqual(stored.lineItems)
    expect(after.retention).toBe(stored.retention)
    expect(after.subtotal).toBe(stored.subtotal)
    expect(after.gstTotal).toBe(stored.gstTotal)
    expect(after.grossTotal).toBe(stored.grossTotal)
    expect(after.payableGst).toBe(stored.payableGst)
    expect(after.payableTotal).toBe(stored.payableTotal)
  })

  it('leaves source, supplier, PO and claim identity byte-identical', () => {
    const after = { ...stored, ...payload }
    for (const key of ['source', 'supplierId', 'supplierName', 'poId', 'poNumber', 'progressClaimId', 'claimNumber', 'invoiceNumber', 'status']) {
      expect(after[key]).toBe(stored[key])
    }
  })

  it('keeps reconciling to the approved claim after the header edit', () => {
    const after = { ...stored, ...payload }
    expect(claimReconciliationError(
      invoiceTotals(after.lineItems, after.retention),
      { approvedGst: stored.payableGst, approvedTotal: stored.payableTotal },
    )).toBeNull()
  })
})

// ── N. The direct_po update payload / immutable contract ─────────────────────

describe('the direct_po EDIT contract writes only authored and derived money', () => {
  const storedLines = [
    line({ poLineIndex: 0, costCodeId: 'cc1', amount: 1000, gstAmount: 100 }),
    line({ poLineIndex: 1, costCodeId: 'cc2', amount: 500, gstAmount: 50 }),
  ]
  const stored = invoice({ lineItems: storedLines, ...invoiceTotals(storedLines, 0) })

  // Mirrors useSupplierInvoices.updateSupplierInvoice on the direct_po path.
  function directUpdatePayload(inv, { supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, notes, amounts, taxCodes, retention }) {
    const storedLines = Array.isArray(inv.lineItems) ? inv.lineItems : []
    const countError = invoiceLineInputCountError(storedLines, amounts, taxCodes)
    if (countError) throw new Error(countError)
    const lineItems = storedLines.map((li, idx) => buildInvoiceLine(li, { amount: amounts[idx], taxCode: taxCodes[idx] }))
    const draftError = validateInvoiceDraft({ lineItems, supplierInvoiceNumber, invoiceDate, retention })
    if (draftError) throw new Error(draftError)
    const totals = invoiceTotals(lineItems, retention)
    return {
      supplierInvoiceNumber: supplierInvoiceNumber?.trim() || '',
      invoiceDate: invoiceDate || '', receivedDate: receivedDate || '', dueDate: dueDate || '',
      notes: notes?.trim() || '',
      lineItems,
      retention: totals.retention, retentionGst: totals.retentionGst, retentionTotal: totals.retentionTotal,
      subtotal: totals.subtotal, gstTotal: totals.gstTotal, grossTotal: totals.grossTotal,
      net: totals.net, payableGst: totals.payableGst, payableTotal: totals.payableTotal,
    }
  }

  const edited = directUpdatePayload(stored, {
    supplierInvoiceNumber: 'INV-2', invoiceDate: '2026-09-01', receivedDate: '2026-09-02',
    dueDate: '2026-10-01', notes: 'fixed',
    amounts: ['2000', '0'], taxCodes: [TAX_CODE.GST_FREE, TAX_CODE.GST], retention: '100',
  })

  it('carries no identity, lifecycle or audit field', () => {
    for (const forbidden of [
      'invoiceNumber', 'status', 'docType', 'source', 'supplierId', 'supplierName',
      'poId', 'poNumber', 'progressClaimId', 'claimNumber', 'paymentTerms',
      'currency', 'revision', 'approvedAt', 'approvedBy', 'postedAt', 'postedBy',
      'cancelledAt', 'paidAt', 'adjustsInvoiceId', 'attachments', 'externalRefs',
      'createdAt', 'createdBy',
    ]) {
      expect(edited).not.toHaveProperty(forbidden)
    }
  })

  it('leaves every immutable field untouched when merged over the stored document', () => {
    const after = { ...stored, ...edited }
    for (const key of ['invoiceNumber', 'status', 'docType', 'source', 'supplierId', 'supplierName',
      'poId', 'poNumber', 'progressClaimId', 'claimNumber', 'currency', 'revision']) {
      expect(after[key]).toBe(stored[key])
    }
    expect(after.paymentTerms).toEqual(stored.paymentTerms)
  })

  it('keeps the line SET and every line IDENTITY fixed', () => {
    expect(edited.lineItems).toHaveLength(stored.lineItems.length)
    edited.lineItems.forEach((li, idx) => {
      expect(li.poLineIndex).toBe(stored.lineItems[idx].poLineIndex)
      expect(li.costCodeId).toBe(stored.lineItems[idx].costCodeId)
      expect(li.costCodeName).toBe(stored.lineItems[idx].costCodeName)
      expect(li.description).toBe(stored.lineItems[idx].description)
    })
  })

  it('applies the authored amounts and tax codes, re-deriving GST', () => {
    expect(edited.lineItems[0]).toMatchObject({ amount: 2000, taxCode: TAX_CODE.GST_FREE, gstAmount: 0 })
    expect(edited.lineItems[1]).toMatchObject({ amount: 0, taxCode: TAX_CODE.GST, gstAmount: 0 })
  })

  it('re-derives every header total from the rebuilt lines', () => {
    expect(edited.subtotal).toBe(2000)
    expect(edited.gstTotal).toBe(0)
    expect(edited.grossTotal).toBe(2000)
    expect(edited.retention).toBe(100)
    expect(edited.retentionGst).toBe(10)
    expect(edited.net).toBe(1900)
    expect(edited.payableTotal).toBe(1890)
  })

  it('refuses a mispaired call before building anything', () => {
    expect(() => directUpdatePayload(stored, {
      supplierInvoiceNumber: 'X', invoiceDate: '2026-01-01', amounts: ['1'], taxCodes: [TAX_CODE.GST], retention: 0,
    })).toThrow(/expected 2, got 1/)
  })

  it('refuses a negative retention, a blank reference, a blank date and an invalid tax code', () => {
    const base = { supplierInvoiceNumber: 'X', invoiceDate: '2026-01-01', amounts: ['1', '1'], taxCodes: [TAX_CODE.GST, TAX_CODE.GST], retention: 0 }
    expect(() => directUpdatePayload(stored, { ...base, retention: -1 })).toThrow(/Retention cannot be negative/)
    expect(() => directUpdatePayload(stored, { ...base, supplierInvoiceNumber: ' ' })).toThrow(/invoice number is required/)
    expect(() => directUpdatePayload(stored, { ...base, invoiceDate: '' })).toThrow(/invoice date is required/)
    expect(() => directUpdatePayload(stored, { ...base, taxCodes: ['vat', TAX_CODE.GST] })).toThrow(/Line 1: choose a tax code/)
    expect(() => directUpdatePayload(stored, { ...base, amounts: ['0', '0'] })).toThrow(/amount on at least one line/)
  })

  it('lets a zeroed stored line be brought back, because its identity stayed stored', () => {
    const zeroed = { ...stored, ...directUpdatePayload(stored, {
      supplierInvoiceNumber: 'X', invoiceDate: '2026-01-01', amounts: ['1000', '0'], taxCodes: [TAX_CODE.GST, TAX_CODE.GST], retention: 0,
    }) }
    expect(zeroed.lineItems).toHaveLength(2)
    expect(zeroed.lineItems[1].amount).toBe(0)
    expect(zeroed.lineItems[1].costCodeId).toBe('cc2')
    const restored = directUpdatePayload(zeroed, {
      supplierInvoiceNumber: 'X', invoiceDate: '2026-01-01', amounts: ['1000', '750'], taxCodes: [TAX_CODE.GST, TAX_CODE.GST], retention: 0,
    })
    expect(restored.lineItems[1]).toMatchObject({ amount: 750, costCodeId: 'cc2', poLineIndex: 1 })
  })

  it('is idempotent — saving an untouched draft changes nothing', () => {
    const untouched = directUpdatePayload(stored, {
      supplierInvoiceNumber: stored.supplierInvoiceNumber, invoiceDate: stored.invoiceDate,
      receivedDate: stored.receivedDate, dueDate: stored.dueDate, notes: stored.notes,
      amounts: stored.lineItems.map(li => invoiceLineToForm(li).amount),
      taxCodes: stored.lineItems.map(li => invoiceLineToForm(li).taxCode),
      retention: stored.retention,
    })
    expect({ ...stored, ...untouched }).toEqual(stored)
  })
})

// ── O. Financial regression ──────────────────────────────────────────────────

describe('FINANCIAL REGRESSION — a draft edit moves nothing until the invoice posts', () => {
  // A representative project: one posted invoice already counting, one DRAFT
  // being edited, one posted claim-sourced invoice, plus the retention and
  // payment fixtures every downstream consumer reads.
  const postedLines = [line({ poLineIndex: 0, costCodeId: 'cc1', amount: 4000, gstAmount: 400 })]
  const posted = invoice({
    id: 'posted1', invoiceNumber: 'SI-0001', status: SI_STATUS.POSTED, supplierInvoiceNumber: 'P-1',
    poId: 'po1', lineItems: postedLines, ...invoiceTotals(postedLines, 0),
  })

  const draftLines = [
    line({ poLineIndex: 1, costCodeId: 'cc2', costCodeName: 'Steel', amount: 1000, taxCode: TAX_CODE.GST, gstAmount: 100 }),
    line({ poLineIndex: 2, costCodeId: 'cc3', costCodeName: 'Formwork', amount: 500, taxCode: TAX_CODE.GST, gstAmount: 50 }),
  ]
  const draft = invoice({
    id: 'draft1', invoiceNumber: 'SI-0002', status: SI_STATUS.DRAFT, supplierInvoiceNumber: 'D-1',
    poId: 'po1', lineItems: draftLines, ...invoiceTotals(draftLines, 0),
  })

  const purchaseOrders = [{
    id: 'po1', poNumber: 'PO-0001', status: PO_STATUS.SENT, supplierId: 'sup1', supplierName: 'Acme Concrete',
    subtotal: 20000,
    lineItems: [
      { costCodeId: 'cc1', costCodeName: 'Concrete', lineTotal: 10000 },
      { costCodeId: 'cc2', costCodeName: 'Steel',    lineTotal: 6000 },
      { costCodeId: 'cc3', costCodeName: 'Formwork', lineTotal: 4000 },
    ],
  }]
  const progressClaims = [{
    id: 'pc1', claimNumber: 'PC-0001', status: 'approved', poId: 'po1',
    lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', approvedThisPeriod: 900 }],
  }]

  // The large draft edit: both amounts changed, both tax codes changed, and
  // retention introduced.
  const editedLines = [
    buildInvoiceLine(draftLines[0], { amount: 7777, taxCode: TAX_CODE.GST_FREE }),
    buildInvoiceLine(draftLines[1], { amount: 3333, taxCode: TAX_CODE.INPUT_TAXED }),
  ]
  const editedDraft = { ...draft, lineItems: editedLines, ...invoiceTotals(editedLines, 250) }

  // Every downstream figure this project can produce from the invoice list.
  const snapshot = (invoices) => ({
    invoicedByCostCode: invoicedByCostCode(invoices),
    committedMatured:   maturedCommittedByCostCode(purchaseOrders, postedInvoicedByPoLine(invoices)),
    postedByPoLine:     postedInvoicedByPoLine(invoices),
    postedByPo:         postedInvoicedByPo(invoices),
    invoicedClaims:     [...invoicedClaimIds(invoices)],
    claimActual:        actualClaimsByCostCode(progressClaims, invoicedClaimIds(invoices)),
    payable:            postedSupplierInvoices(invoices).map(i => i.payableTotal),
    payables:           payablesSummary(invoices, [], [], {}),
    creditable:         invoices.filter(isCreditableInvoice).map(i => i.id),
    retentionRows:      retentionInvoiceRows(invoices, []),
    retentionHolders:   retentionInvoices(invoices).map(i => i.id),
  })

  const before = snapshot([posted, draft])
  const after  = snapshot([posted, editedDraft])

  it('the edit really did change the draft document', () => {
    expect(editedDraft.subtotal).toBe(11110)
    expect(editedDraft.gstTotal).toBe(0)
    expect(editedDraft.retention).toBe(250)
    expect(editedDraft.subtotal).not.toBe(draft.subtotal)
    expect(editedDraft.payableTotal).not.toBe(draft.payableTotal)
  })

  it('moves NO downstream figure — every derivation is byte-identical', () => {
    expect(after).toEqual(before)
  })

  it('leaves Budget Invoiced and Actual on the posted invoice alone', () => {
    expect(before.invoicedByCostCode).toEqual({ cc1: 4000 })
    expect(after.invoicedByCostCode).toEqual({ cc1: 4000 })
  })

  it('leaves Committed maturing unchanged', () => {
    expect(after.committedMatured).toEqual(before.committedMatured)
    expect(after.committedMatured.cc2).toBe(6000)   // the draft matured nothing
    expect(after.committedMatured.cc3).toBe(4000)
  })

  it('leaves PO remaining / invoiced-to-date unchanged', () => {
    expect(after.postedByPo).toEqual({ po1: 4000 })
    expect(after.postedByPoLine).toEqual({ po1: { 0: 4000 } })
  })

  it('leaves the payables summary, credit eligibility and retention unchanged', () => {
    expect(after.payables).toEqual(before.payables)
    expect(after.creditable).toEqual(['posted1'])
    expect(after.retentionHolders).toEqual([])
    expect(after.retentionRows).toEqual(before.retentionRows)
  })

  it('keeps the draft out of every payment and credit gate', () => {
    expect(isPayableInvoice(editedDraft)).toBe(false)
    expect(isCreditableInvoice(editedDraft)).toBe(false)
    expect(retentionInvoices([editedDraft])).toEqual([])
    expect(postedSupplierInvoices([editedDraft])).toEqual([])
  })

  it('APPROVING the edited draft still posts nothing', () => {
    const approved = { ...editedDraft, status: SI_STATUS.APPROVED }
    expect(snapshot([posted, approved])).toEqual(before)
    expect(isPayableInvoice(approved)).toBe(false)
    expect(isCreditableInvoice(approved)).toBe(false)
  })

  it('POSTING it brings the EDITED values into every counting point, exactly', () => {
    const postedEdited = { ...editedDraft, status: SI_STATUS.POSTED }
    const now = snapshot([posted, postedEdited])
    expect(now.invoicedByCostCode).toEqual({ cc1: 4000, cc2: 7777, cc3: 3333 })
    expect(now.postedByPoLine).toEqual({ po1: { 0: 4000, 1: 7777, 2: 3333 } })
    expect(now.postedByPo).toEqual({ po1: 15110 })
    // cc2's 6000 commitment is over-invoiced at 7777, so it matures fully and is
    // DROPPED from the map rather than going negative (maturedCommittedByCostCode
    // floors at zero and omits an exhausted line — existing behaviour, pinned).
    // cc3 keeps 4000 - 3333 = 667 of open commitment.
    expect(now.committedMatured).not.toHaveProperty('cc2')
    expect(now.committedMatured.cc3).toBe(667)
    expect(isPayableInvoice(postedEdited)).toBe(true)
    expect(now.retentionHolders).toEqual(['draft1'])
    expect(now.retentionRows.find(r => r.id === 'draft1').retentionTotal).toBe(275)
  })

  it('a claim-sourced posted invoice removes its claim from the claim side of Actual', () => {
    const claimLines = [line({ poLineIndex: 0, costCodeId: 'cc1', amount: 900, gstAmount: 90 })]
    const claimInv = invoice({
      id: 'ci', status: SI_STATUS.POSTED, source: SI_SOURCE.PROGRESS_CLAIM,
      progressClaimId: 'pc1', lineItems: claimLines, ...invoiceTotals(claimLines, 0),
    })
    expect(actualClaimsByCostCode(progressClaims, invoicedClaimIds([]))).toEqual({ cc1: 900 })
    expect(actualClaimsByCostCode(progressClaims, invoicedClaimIds([claimInv]))).toEqual({})
  })
})

describe('FINANCIAL REGRESSION — a claim-sourced header edit moves nothing at all', () => {
  const lines = [line({ poLineIndex: 0, costCodeId: 'cc1', amount: 2000, gstAmount: 200 })]
  const stored = invoice({
    id: 'ci1', status: SI_STATUS.DRAFT, source: SI_SOURCE.PROGRESS_CLAIM,
    progressClaimId: 'pc1', claimNumber: 'PC-0001', poId: 'po1',
    lineItems: lines, ...invoiceTotals(lines, 200),
  })
  // The whole claim-sourced edit contract.
  const after = { ...stored, supplierInvoiceNumber: 'CORRECTED', invoiceDate: '2026-09-09', receivedDate: '2026-09-10', dueDate: '2026-10-09', notes: 'fixed' }

  it('changes only the five header fields', () => {
    const changed = Object.keys(after).filter(k => after[k] !== stored[k])
    expect(changed.sort()).toEqual(['dueDate', 'invoiceDate', 'notes', 'receivedDate', 'supplierInvoiceNumber'])
  })

  it('leaves every certified amount and the reconciliation byte-identical', () => {
    expect(after.lineItems).toBe(stored.lineItems)
    expect(invoiceTotals(after.lineItems, after.retention)).toEqual(invoiceTotals(stored.lineItems, stored.retention))
    expect(after.payableGst).toBe(180)
    expect(after.payableTotal).toBe(1980)
  })

  it('leaves every downstream derivation byte-identical, before and after posting', () => {
    // The retention row deliberately carries DISPLAY columns (invoiceDate,
    // supplierInvoiceNumber) that a header edit is meant to change — compare the
    // financial columns, which must not move.
    const retentionMoney = (inv) => retentionInvoiceRows([inv], []).map(r => ({
      id: r.id, retention: r.retention, retentionGst: r.retentionGst,
      retentionTotal: r.retentionTotal, retentionHeld: r.retentionHeld,
      releasedTotal: r.releasedTotal, remainingRetentionExGst: r.remainingRetentionExGst,
    }))
    const snap = (inv) => ({
      invoiced: invoicedByCostCode([inv]), byPoLine: postedInvoicedByPoLine([inv]),
      byPo: postedInvoicedByPo([inv]), claims: [...invoicedClaimIds([inv])],
      retention: retentionMoney(inv),
    })
    expect(snap(after)).toEqual(snap(stored))
    expect(snap({ ...after, status: SI_STATUS.POSTED })).toEqual(snap({ ...stored, status: SI_STATUS.POSTED }))
  })
})
