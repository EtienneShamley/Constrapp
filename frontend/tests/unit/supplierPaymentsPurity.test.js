import { describe, it, expect } from 'vitest'
import {
  paidByInvoice, supplierInvoiceReconciliationRows, payablesSummary,
  allocatableSupplierInvoices, invoiceOverPaymentWarnings, apAgeing,
  paymentSummary, paymentsForInvoice, allocationExceptions,
  allocateOldestFirst, buildAllocations, cashOutRows,
  remainingPayable, payableBasis, isPastDuePayable,
} from '../../src/lib/supplierPayments'
import { SI_STATUS } from '../../src/lib/supplierInvoices'

// ── Supplier Payments — the Supplier Invoice is never written to ─────────────
//
// ADR-24: a payment settles an Actual cost that a POSTED supplier invoice
// already recognised. Nothing on the payment side may stamp the invoice —
// `status` never moves to `paid`, `paidAt` is never set, and no balance,
// reconciliation state, or payment back-reference is ever added. That is also
// why voiding a payment restores every balance for free.
//
// The reconciliation MATHS is already covered by retention.test.js,
// supplierCreditNotes.test.js and retentionCreditNotes.test.js. This file adds
// the one thing those do not assert: that the whole payment-side derivation set
// leaves the supplier invoice byte-identical at runtime.
//
// ⚠️ SCOPE. This proves the read-time derivation layer only. It does NOT prove
// that hooks/useSupplierPayments.jsx writes nothing to Firestore, nor that
// Budgeted/Committed/Claimed/Invoiced/Actual are unmoved on the Budget page —
// those remain manual/integration checks (§15k-xvi).

const NOW = new Date(2026, 7, 20) // 2026-08-20, local

// A posted supplier invoice with retention withheld, carrying the deprecated
// `paid`/`paidAt` fields at their untouched values.
const invoice = (over = {}) => ({
  id: 'si1',
  invoiceNumber: 'SI-0001',
  supplierInvoiceNumber: 'INV-4471',
  status: SI_STATUS.POSTED,
  supplierId: 'sup1',
  supplierName: 'BuildCo',
  invoiceDate: '2026-06-01',
  dueDate: '2026-07-06',
  lineItems: [
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 10_000, taxCode: 'gst', gstAmount: 1000 },
  ],
  subtotal: 10_000, gstTotal: 1000, grossTotal: 11_000,
  retention: 1000, retentionGst: 100, retentionTotal: 1100,
  net: 9000, payableGst: 900, payableTotal: 9900,
  paidAt: null,
  currency: 'AUD',
  ...over,
})

const payment = (over = {}) => {
  const allocations = over.allocations ?? []
  const amount = over.amount ?? allocations.reduce((s, a) => s + a.allocatedAmount, 0)
  const allocated = allocations.reduce((s, a) => s + a.allocatedAmount, 0)
  return {
    id: 'p1',
    paymentNumber: 'SP-0001',
    status: 'posted',
    supplierId: 'sup1',
    supplierName: 'BuildCo',
    paymentDate: '2026-08-10',
    paymentMethod: 'bank_transfer',
    paymentMethodOther: '',
    bankReference: 'FT-77',
    remittanceReference: 'RM-77',
    currency: 'AUD',
    ...over,
    amount,
    allocations,
    allocatedTotal: allocated,
    unallocatedAmount: Math.round((amount - allocated) * 100) / 100,
  }
}

const alloc = (allocatedAmount) => ({
  supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471', allocatedAmount,
})

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze(v[k])
  }
  return v
}

describe('the supplier invoice is never written to by any payment derivation', () => {
  const invoices = () => deepFreeze([invoice()])
  const payments = () => deepFreeze([payment({ amount: 5000, allocations: [alloc(4000)] })])

  it('runs the whole payment-side derivation set against FROZEN documents without throwing', () => {
    const inv = invoices()
    const pay = payments()
    expect(() => {
      paidByInvoice(pay)
      supplierInvoiceReconciliationRows(inv, pay)
      payablesSummary(inv, pay)
      allocatableSupplierInvoices(inv, 'sup1', 'BuildCo', pay)
      invoiceOverPaymentWarnings([alloc(99_999)], inv, pay)
      apAgeing(inv, pay, [], {}, NOW)
      paymentSummary(pay)
      paymentsForInvoice(pay, 'si1')
      allocationExceptions(pay, inv)
      buildAllocations([{ supplierInvoiceId: 'si1', allocatedAmount: 100 }], inv)
      cashOutRows(pay, { projectId: 'proj1' })
    }).not.toThrow()
  })

  it('leaves the invoice document byte-identical after every derivation', () => {
    const inv = invoices()
    const pay = payments()
    const before = JSON.stringify(inv)
    payablesSummary(inv, pay)
    apAgeing(inv, pay, [], {}, NOW)
    allocatableSupplierInvoices(inv, 'sup1', 'BuildCo', pay)
    allocationExceptions(pay, inv)
    expect(JSON.stringify(inv)).toBe(before)
  })

  it('never moves status to `paid` and never sets paidAt (ADR-24)', () => {
    const inv = invoices()
    payablesSummary(inv, payments())
    apAgeing(inv, payments(), [], {}, NOW)
    expect(inv[0].status).toBe(SI_STATUS.POSTED)
    expect(inv[0].status).not.toBe('paid')
    expect(inv[0].paidAt).toBeNull()
  })

  it('never adds a balance, reconciliation-state, or payment back-reference field', () => {
    const inv = invoices()
    payablesSummary(inv, payments())
    expect(Object.keys(inv[0])).not.toContain('paid')
    expect(Object.keys(inv[0])).not.toContain('remaining')
    expect(Object.keys(inv[0])).not.toContain('remainingPayable')
    expect(Object.keys(inv[0])).not.toContain('reconciliationState')
    expect(Object.keys(inv[0])).not.toContain('paymentIds')
    expect(Object.keys(inv[0])).not.toContain('allocations')
  })

  it('never reduces the immutable retention fields — a payment does not release retention', () => {
    const inv = invoices()
    // Pay the whole net payable.
    payablesSummary(inv, [payment({ amount: 9900, allocations: [alloc(9900)] })])
    expect(inv[0].retention).toBe(1000)
    expect(inv[0].retentionGst).toBe(100)
    expect(inv[0].retentionTotal).toBe(1100)
    expect(inv[0].payableTotal).toBe(9900)
  })

  it('leaves the payment document byte-identical too', () => {
    const pay = payments()
    const before = JSON.stringify(pay)
    payablesSummary(invoices(), pay)
    paymentSummary(pay)
    cashOutRows(pay, { projectId: 'proj1' })
    expect(JSON.stringify(pay)).toBe(before)
  })

  it('is idempotent — the same inputs derive the same figures on every render', () => {
    const inv = invoices()
    const pay = payments()
    expect(payablesSummary(inv, pay)).toEqual(payablesSummary(inv, pay))
    expect(apAgeing(inv, pay, [], {}, NOW)).toEqual(apAgeing(inv, pay, [], {}, NOW))
  })

  it('does not mutate the rows handed to allocateOldestFirst', () => {
    const rows = deepFreeze(allocatableSupplierInvoices(invoices(), 'sup1', 'BuildCo', []))
    expect(() => allocateOldestFirst(5000, rows)).not.toThrow()
    expect(rows[0].remaining).toBe(9900)
  })
})

describe('voiding a payment restores the balance with no reversal document', () => {
  const inv = invoice()

  it('a POSTED payment reduces the remaining payable', () => {
    const paid = paidByInvoice([payment({ amount: 4000, allocations: [alloc(4000)] })])
    expect(paid.si1).toBe(4000)
    expect(remainingPayable(inv, paid.si1)).toBe(5900)
  })

  it('a VOID payment reduces nothing, restoring the full payable at the next render', () => {
    const paid = paidByInvoice([payment({ status: 'void', amount: 4000, allocations: [alloc(4000)] })])
    expect(paid.si1).toBeUndefined()
    expect(remainingPayable(inv, paid.si1 || 0)).toBe(9900)
  })

  it('a DRAFT payment reduces nothing either', () => {
    const paid = paidByInvoice([payment({ status: 'draft', amount: 4000, allocations: [alloc(4000)] })])
    expect(paid.si1).toBeUndefined()
  })

  it('settles the derived payable basis, never grossTotal — retention held is not payable', () => {
    expect(payableBasis(inv)).toBe(9900)
    expect(payableBasis(inv)).not.toBe(inv.grossTotal)
  })

  it('reports past due only while money is still owed', () => {
    expect(isPastDuePayable(inv, 9900, NOW)).toBe(true)
    expect(isPastDuePayable(inv, 0, NOW)).toBe(false)
    expect(isPastDuePayable(invoice({ status: SI_STATUS.DRAFT }), 9900, NOW)).toBe(false)
  })
})
