import { describe, it, expect } from 'vitest'
import {
  CLIENT_RECEIPT_COUNTER_ID, CR_DOC_TYPE, formatClientReceiptNumber,
  postedClientReceipts, draftClientReceipts,
  receivedByInvoice, remainingToReconcile, invoiceReconciliation,
  clientInvoiceReconciliationRows, receivablesSummary, overReconciledRows,
  receiptSummary, receiptsForInvoice,
  allocatableInvoices, allocateOldestFirst,
  invoiceOverAllocationWarnings,
  allocationExceptions, ALLOCATION_EXCEPTION_REMEDY,
  arAgeing, isPastDueUnreconciled, AR_RECONCILIATION_NOTICE,
  validateReceiptDraft, postBlockedReason, isFutureDatedReceipt,
  buildAllocations,
  allocatedTotal, allocationTotals, MAX_ALLOCATIONS,
} from '../../src/lib/clientReceipts'
import { RECONCILIATION_STATE, PAYMENT_STATUS } from '../../src/lib/payments'

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// Client "Acme" (c1) with three ISSUED invoices, plus a draft, a void, and one
// invoice belonging to a different client. All amounts are GROSS (inc. GST),
// because gross is what the client was billed and therefore what they pay.
//
//   CI-0001  gross 1100  due 2026-07-06  (45 days past due at NOW)
//   CI-0002  gross 2200  due 2026-09-30  (not yet due)
//   CI-0003  gross  550  no due date
//
const NOW = new Date(2026, 7, 20) // 2026-08-20, local

const inv = (over = {}) => ({
  id: 'i1',
  invoiceNumber: 'CI-0001',
  status: 'issued',
  clientId: 'c1',
  clientName: 'Acme Developments',
  invoiceDate: '2026-06-06',
  dueDate: '2026-07-06',
  subtotal: 1000, gstTotal: 100, grossTotal: 1100,
  ...over,
})

const I1 = inv()
const I2 = inv({ id: 'i2', invoiceNumber: 'CI-0002', invoiceDate: '2026-07-01', dueDate: '2026-09-30', subtotal: 2000, gstTotal: 200, grossTotal: 2200 })
const I3 = inv({ id: 'i3', invoiceNumber: 'CI-0003', invoiceDate: '2026-08-01', dueDate: '', subtotal: 500, gstTotal: 50, grossTotal: 550 })
const I_DRAFT = inv({ id: 'i4', invoiceNumber: 'CI-0004', status: 'draft' })
const I_VOID  = inv({ id: 'i5', invoiceNumber: 'CI-0005', status: 'void' })
const I_OTHER = inv({ id: 'i6', invoiceNumber: 'CI-0006', clientId: 'c2', clientName: 'Beta Group' })

const INVOICES = [I1, I2, I3, I_DRAFT, I_VOID, I_OTHER]

// A receipt. `allocatedTotal`/`unallocatedAmount` are stored at write time (the
// scalar invariant the rules enforce), so fixtures set them consistently.
const receipt = (over = {}) => {
  const allocations = over.allocations ?? []
  const amount = over.amount ?? allocations.reduce((s, a) => s + a.allocatedAmount, 0)
  const allocated = allocations.reduce((s, a) => s + a.allocatedAmount, 0)
  return {
    id: 'r1',
    receiptNumber: 'CR-0001',
    status: PAYMENT_STATUS.POSTED,
    docType: CR_DOC_TYPE.RECEIPT,
    clientId: 'c1',
    clientName: 'Acme Developments',
    receiptDate: '2026-08-10',
    paymentMethod: 'bank_transfer',
    paymentMethodOther: '',
    bankReference: 'FT-9911',
    currency: 'AUD',
    ...over,
    amount,
    allocations,
    allocatedTotal: allocated,
    unallocatedAmount: Math.round((amount - allocated) * 100) / 100,
  }
}

const alloc = (id, invoiceNumber, allocatedAmount) => ({
  clientInvoiceId: id, invoiceNumber, allocatedAmount,
})

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze(v[k])
  }
  return v
}

// ── Numbering & document type ────────────────────────────────────────────────

describe('numbering', () => {
  it('numbers as CR-#### from the company-wide clientReceipts counter', () => {
    expect(CLIENT_RECEIPT_COUNTER_ID).toBe('clientReceipts')
    expect(formatClientReceiptNumber(1)).toBe('CR-0001')
    expect(formatClientReceiptNumber(9999)).toBe('CR-9999')
    expect(formatClientReceiptNumber(10000)).toBe('CR-10000')
  })

  it('reserves `refund` as a distinct document type from voiding a mis-keyed receipt', () => {
    expect(CR_DOC_TYPE.RECEIPT).toBe('receipt')
    expect(CR_DOC_TYPE.REFUND).toBe('refund')
  })

  it('re-exports the shared allocation primitives so pages import ONE module', () => {
    expect(MAX_ALLOCATIONS).toBe(100)
    expect(allocatedTotal([{ allocatedAmount: 0.1 }, { allocatedAmount: 0.2 }])).toBe(0.3)
    expect(allocationTotals(1000, [{ allocatedAmount: 400 }]))
      .toEqual({ allocatedTotal: 400, unallocatedAmount: 600 })
  })
})

// ── A/B/C. Which receipts reconcile ──────────────────────────────────────────

describe('receipt sets — only POSTED receipts move money', () => {
  const posted = receipt({ id: 'rp', status: PAYMENT_STATUS.POSTED })
  const draft  = receipt({ id: 'rd', status: PAYMENT_STATUS.DRAFT, amount: 100 })
  const voided = receipt({ id: 'rv', status: PAYMENT_STATUS.VOID, amount: 100 })

  it('postedClientReceipts selects only posted', () => {
    expect(postedClientReceipts([posted, draft, voided]).map(r => r.id)).toEqual(['rp'])
  })

  it('draftClientReceipts selects only drafts', () => {
    expect(draftClientReceipts([posted, draft, voided]).map(r => r.id)).toEqual(['rd'])
  })

  it('tolerates a null receipt list', () => {
    expect(postedClientReceipts(null)).toEqual([])
    expect(draftClientReceipts(undefined)).toEqual([])
  })
})

describe('receivedByInvoice — the single reconciliation counting point', () => {
  it('(B) a POSTED receipt reconciles its allocated invoice', () => {
    const r = receipt({ allocations: [alloc('i1', 'CI-0001', 400)] })
    expect(receivedByInvoice([r])).toEqual({ i1: 400 })
  })

  it('(A) a DRAFT receipt reconciles NOTHING — it has moved no money', () => {
    const r = receipt({ status: PAYMENT_STATUS.DRAFT, allocations: [alloc('i1', 'CI-0001', 400)] })
    expect(receivedByInvoice([r])).toEqual({})
  })

  it('(C) a VOID receipt reconciles NOTHING — voiding restores the balance with no reversal document', () => {
    const r = receipt({ status: PAYMENT_STATUS.VOID, allocations: [alloc('i1', 'CI-0001', 400)] })
    expect(receivedByInvoice([r])).toEqual({})
  })

  it('(C) voiding a posted receipt restores the invoice balance at the next render', () => {
    const allocations = [alloc('i1', 'CI-0001', 1100)]
    const posted = receipt({ allocations })
    const voided = receipt({ status: PAYMENT_STATUS.VOID, allocations })
    expect(remainingToReconcile(I1, receivedByInvoice([posted]).i1 || 0)).toBe(0)
    expect(remainingToReconcile(I1, receivedByInvoice([voided]).i1 || 0)).toBe(1100)
  })

  it('(D) applies each allocation to the invoice it names, never to a neighbour', () => {
    const r = receipt({
      amount: 900,
      allocations: [alloc('i1', 'CI-0001', 400), alloc('i2', 'CI-0002', 500)],
    })
    expect(receivedByInvoice([r])).toEqual({ i1: 400, i2: 500 })
  })

  it('(D) accumulates several posted receipts against the same invoice', () => {
    const a = receipt({ id: 'ra', allocations: [alloc('i1', 'CI-0001', 400)] })
    const b = receipt({ id: 'rb', allocations: [alloc('i1', 'CI-0001', 300)] })
    expect(receivedByInvoice([a, b])).toEqual({ i1: 700 })
  })

  it('(E) an unallocated receipt reduces NO invoice balance — money on account is not a settlement', () => {
    const r = receipt({ amount: 5000, allocations: [] })
    expect(receivedByInvoice([r])).toEqual({})
    expect(remainingToReconcile(I1, 0)).toBe(1100)
  })

  it('(E) a receipt allocated elsewhere never touches this invoice', () => {
    const elsewhere = receipt({ allocations: [alloc('i2', 'CI-0002', 2200)] })
    expect(receivedByInvoice([elsewhere]).i1).toBeUndefined()
    expect(remainingToReconcile(I1, receivedByInvoice([elsewhere]).i1 || 0)).toBe(1100)
  })

  it('skips an allocation row with no invoice id rather than creating an undefined bucket', () => {
    const r = receipt({ amount: 100, allocations: [{ allocatedAmount: 100 }] })
    expect(receivedByInvoice([r])).toEqual({})
  })

  it('sums to whole cents', () => {
    const a = receipt({ id: 'ra', allocations: [alloc('i1', 'CI-0001', 0.1)] })
    const b = receipt({ id: 'rb', allocations: [alloc('i1', 'CI-0001', 0.2)] })
    expect(receivedByInvoice([a, b])).toEqual({ i1: 0.3 })
  })
})

// ── E. Remaining to reconcile ────────────────────────────────────────────────

describe('remainingToReconcile — measured against GROSS, signed, never clamped', () => {
  it('is the full gross when nothing has been received', () => {
    expect(remainingToReconcile(I1, 0)).toBe(1100)
  })

  it('is the remainder after a partial receipt', () => {
    expect(remainingToReconcile(I1, 400)).toBe(700)
  })

  it('is exactly zero when settled to the cent', () => {
    expect(remainingToReconcile(I1, 1100)).toBe(0)
  })

  it('goes NEGATIVE when over-received and is never clamped to zero', () => {
    expect(remainingToReconcile(I1, 1500)).toBe(-400)
  })

  it('treats a missing invoice or a non-numeric received value as zero', () => {
    expect(remainingToReconcile(undefined, 0)).toBe(0)
    expect(remainingToReconcile(I1, 'abc')).toBe(1100)
  })

  it('derives the full position with a state label', () => {
    expect(invoiceReconciliation(I1, {})).toEqual({
      total: 1100, settled: 0, remaining: 1100, state: RECONCILIATION_STATE.UNRECONCILED,
    })
    expect(invoiceReconciliation(I1, { i1: 400 }).state).toBe(RECONCILIATION_STATE.PARTLY)
    expect(invoiceReconciliation(I1, { i1: 1100 }).state).toBe(RECONCILIATION_STATE.FULLY)
    expect(invoiceReconciliation(I1, { i1: 1500 }).state).toBe(RECONCILIATION_STATE.OVER)
  })
})

// ── Reconciliation rows ──────────────────────────────────────────────────────

describe('clientInvoiceReconciliationRows — issued invoices only', () => {
  const receipts = [receipt({ allocations: [alloc('i1', 'CI-0001', 400)] })]

  it('(G) excludes DRAFT and VOID invoices — a draft billed nothing, a void is nothing forever', () => {
    const rows = clientInvoiceReconciliationRows(INVOICES, receipts)
    expect(rows.map(r => r.id)).toEqual(['i1', 'i2', 'i3', 'i6'])
    expect(rows.map(r => r.id)).not.toContain('i4')
    expect(rows.map(r => r.id)).not.toContain('i5')
  })

  it('reports received and remaining per invoice', () => {
    const rows = clientInvoiceReconciliationRows(INVOICES, receipts)
    const r1 = rows.find(r => r.id === 'i1')
    expect(r1).toMatchObject({
      invoiceNumber: 'CI-0001', grossTotal: 1100, received: 400, remaining: 700,
      state: RECONCILIATION_STATE.PARTLY,
    })
  })

  it('(E) leaves every other invoice untouched by that receipt', () => {
    const rows = clientInvoiceReconciliationRows(INVOICES, receipts)
    expect(rows.find(r => r.id === 'i2')).toMatchObject({ received: 0, remaining: 2200 })
    expect(rows.find(r => r.id === 'i3')).toMatchObject({ received: 0, remaining: 550 })
  })

  it('carries the frozen client snapshot so a register row renders without reading contacts', () => {
    const [r1] = clientInvoiceReconciliationRows([I1], [])
    expect(r1.clientId).toBe('c1')
    expect(r1.clientName).toBe('Acme Developments')
    expect(r1.dueDate).toBe('2026-07-06')
  })
})

describe('receivablesSummary', () => {
  it('totals issued gross, received and remaining', () => {
    const s = receivablesSummary([I1, I2, I3], [receipt({ allocations: [alloc('i1', 'CI-0001', 400)] })])
    expect(s.issuedGross).toBe(3850)   // 1100 + 2200 + 550
    expect(s.received).toBe(400)
    expect(s.remaining).toBe(3450)
    expect(s.overReconciled).toBe(0)
  })

  it('(F) reports an over-reconciled balance SEPARATELY so it cannot offset genuine arrears', () => {
    const receipts = [receipt({ amount: 1600, allocations: [alloc('i1', 'CI-0001', 1600)] })]
    const s = receivablesSummary([I1, I2], receipts)
    // i1 is −500; i2 is +2200. A single netted number would read 1700 and hide
    // the over-reconciliation entirely.
    expect(s.remaining).toBe(2200)
    expect(s.overReconciled).toBe(-500)
    expect(s.remaining).not.toBe(1700)
  })

  it('(F) overReconciledRows isolates exactly the over-reconciled invoices', () => {
    const receipts = [receipt({ amount: 1600, allocations: [alloc('i1', 'CI-0001', 1600)] })]
    const s = receivablesSummary([I1, I2], receipts)
    expect(overReconciledRows(s.rows).map(r => r.id)).toEqual(['i1'])
    expect(overReconciledRows([])).toEqual([])
  })

  it('counts a fully reconciled invoice into received but not into remaining', () => {
    const s = receivablesSummary([I1], [receipt({ amount: 1100, allocations: [alloc('i1', 'CI-0001', 1100)] })])
    expect(s.received).toBe(1100)
    expect(s.remaining).toBe(0)
  })
})

// ── Receipt-side summaries ───────────────────────────────────────────────────

describe('receiptSummary — cash recorded, and how much of it is matched', () => {
  const posted     = receipt({ id: 'rp', amount: 1000, allocations: [alloc('i1', 'CI-0001', 400)] })
  const unmatched  = receipt({ id: 'ru', amount: 500, allocations: [] })
  const draft      = receipt({ id: 'rd', status: PAYMENT_STATUS.DRAFT, amount: 250, allocations: [] })
  const voided     = receipt({ id: 'rv', status: PAYMENT_STATUS.VOID, amount: 9999, allocations: [] })

  it('counts posted cash in full, splitting allocated from unallocated', () => {
    const s = receiptSummary([posted, unmatched, draft, voided])
    expect(s.postedCount).toBe(2)
    expect(s.postedAmount).toBe(1500)
    expect(s.allocated).toBe(400)
    expect(s.unallocated).toBe(1100)
  })

  it('reports drafts separately and excludes voids entirely', () => {
    const s = receiptSummary([posted, unmatched, draft, voided])
    expect(s.draftCount).toBe(1)
    expect(s.draftAmount).toBe(250)
    expect(s.postedAmount).not.toBe(1500 + 9999)
  })

  it('zeroes out on an empty set', () => {
    expect(receiptSummary([])).toEqual({
      postedCount: 0, postedAmount: 0, allocated: 0, unallocated: 0, draftCount: 0, draftAmount: 0,
    })
  })
})

describe('receiptsForInvoice — the linked-receipts table', () => {
  it('lists only POSTED receipts that allocated against this invoice', () => {
    const receipts = [
      receipt({ id: 'ra', receiptNumber: 'CR-0001', allocations: [alloc('i1', 'CI-0001', 400)] }),
      receipt({ id: 'rb', receiptNumber: 'CR-0002', allocations: [alloc('i2', 'CI-0002', 500)] }),
      receipt({ id: 'rc', receiptNumber: 'CR-0003', status: PAYMENT_STATUS.DRAFT, allocations: [alloc('i1', 'CI-0001', 700)] }),
      receipt({ id: 'rd', receiptNumber: 'CR-0004', status: PAYMENT_STATUS.VOID, allocations: [alloc('i1', 'CI-0001', 700)] }),
    ]
    const rows = receiptsForInvoice(receipts, 'i1')
    expect(rows.map(r => r.receiptNumber)).toEqual(['CR-0001'])
    expect(rows[0]).toMatchObject({ allocatedAmount: 400, paymentMethod: 'bank_transfer', bankReference: 'FT-9911' })
  })

  it('returns an empty list when nothing was allocated to it', () => {
    expect(receiptsForInvoice([receipt({ allocations: [alloc('i2', 'CI-0002', 100)] })], 'i1')).toEqual([])
  })
})

// ── Allocation targets ───────────────────────────────────────────────────────

describe('allocatableInvoices — what a receipt may be matched against', () => {
  it('offers only ISSUED invoices belonging to the SELECTED client', () => {
    const rows = allocatableInvoices(INVOICES, 'c1', [])
    expect(rows.map(r => r.invoiceNumber)).toEqual(['CI-0001', 'CI-0002', 'CI-0003'])
  })

  it('excludes another client\'s invoice', () => {
    expect(allocatableInvoices(INVOICES, 'c1', []).map(r => r.id)).not.toContain('i6')
    expect(allocatableInvoices(INVOICES, 'c2', []).map(r => r.id)).toEqual(['i6'])
  })

  it('excludes drafts and voids', () => {
    const ids = allocatableInvoices(INVOICES, 'c1', []).map(r => r.id)
    expect(ids).not.toContain('i4')
    expect(ids).not.toContain('i5')
  })

  it('offers nothing when no client is selected', () => {
    expect(allocatableInvoices(INVOICES, '', [])).toEqual([])
    expect(allocatableInvoices(INVOICES, null, [])).toEqual([])
  })

  it('(I) sorts OLDEST FIRST by invoice date, then invoice number', () => {
    const rows = allocatableInvoices(INVOICES, 'c1', [])
    expect(rows.map(r => r.invoiceDate)).toEqual(['2026-06-06', '2026-07-01', '2026-08-01'])
  })

  it('nets off what other POSTED receipts already reconciled', () => {
    const rows = allocatableInvoices(INVOICES, 'c1', [receipt({ allocations: [alloc('i1', 'CI-0001', 400)] })])
    expect(rows.find(r => r.id === 'i1')).toMatchObject({ received: 400, remaining: 700 })
  })

  it('(E) excludes the receipt being EDITED so a draft never double-counts its own allocations', () => {
    const editing = receipt({ id: 'rEdit', allocations: [alloc('i1', 'CI-0001', 400)] })
    const withSelf    = allocatableInvoices(INVOICES, 'c1', [editing])
    const withoutSelf = allocatableInvoices(INVOICES, 'c1', [editing], { excludeReceiptId: 'rEdit' })
    expect(withSelf.find(r => r.id === 'i1').remaining).toBe(700)
    expect(withoutSelf.find(r => r.id === 'i1').remaining).toBe(1100)
  })
})

// ── I. Allocate oldest first ─────────────────────────────────────────────────

describe('allocateOldestFirst — an explicit PROPOSAL, never automatic', () => {
  const rows = () => allocatableInvoices(INVOICES, 'c1', [])

  it('(I) consumes the rows in the order given, which allocatableInvoices sorts oldest first', () => {
    const out = allocateOldestFirst(1500, rows())
    expect(out.map(a => a.invoiceNumber)).toEqual(['CI-0001', 'CI-0002'])
    expect(out.map(a => a.allocatedAmount)).toEqual([1100, 400])
  })

  it('(I) never allocates more cash than the receipt carries', () => {
    const out = allocateOldestFirst(1500, rows())
    expect(out.reduce((s, a) => s + a.allocatedAmount, 0)).toBe(1500)
  })

  it('(I) never allocates more to an invoice than that invoice still owes', () => {
    const out = allocateOldestFirst(100_000, rows())
    expect(out.map(a => a.allocatedAmount)).toEqual([1100, 2200, 550])
    expect(out.reduce((s, a) => s + a.allocatedAmount, 0)).toBe(3850)
  })

  it('(I) stops as soon as the cash runs out, leaving later invoices untouched', () => {
    const out = allocateOldestFirst(500, rows())
    expect(out).toEqual([{ clientInvoiceId: 'i1', invoiceNumber: 'CI-0001', allocatedAmount: 500 }])
  })

  it('(I) skips an invoice that is already settled or over-settled', () => {
    const settled = allocatableInvoices(INVOICES, 'c1', [
      receipt({ amount: 1100, allocations: [alloc('i1', 'CI-0001', 1100)] }),
    ])
    const out = allocateOldestFirst(1000, settled)
    expect(out.map(a => a.invoiceNumber)).toEqual(['CI-0002'])
  })

  it('proposes nothing for zero cash or an empty row set', () => {
    expect(allocateOldestFirst(0, rows())).toEqual([])
    expect(allocateOldestFirst(1000, [])).toEqual([])
    expect(allocateOldestFirst(1000, null)).toEqual([])
  })

  it('splits to whole cents without a floating-point crumb', () => {
    const out = allocateOldestFirst(0.3, [{ id: 'x', invoiceNumber: 'CI-9', remaining: 0.1 }, { id: 'y', invoiceNumber: 'CI-8', remaining: 0.5 }])
    expect(out.map(a => a.allocatedAmount)).toEqual([0.1, 0.2])
  })

  it('(J) does not mutate the rows it reads', () => {
    const frozen = deepFreeze(rows())
    expect(() => allocateOldestFirst(1500, frozen)).not.toThrow()
    expect(frozen[0].remaining).toBe(1100)
  })
})

// ── F. Over-allocation — warned, never blocked ───────────────────────────────

describe('invoiceOverAllocationWarnings', () => {
  it('is silent while the allocation stays inside the remaining balance', () => {
    expect(invoiceOverAllocationWarnings([alloc('i1', 'CI-0001', 1100)], INVOICES, [])).toEqual([])
  })

  it('warns with the excess when the allocation would over-reconcile', () => {
    const [w] = invoiceOverAllocationWarnings([alloc('i1', 'CI-0001', 1600)], INVOICES, [])
    expect(w.field).toBe('allocation')
    expect(w.clientInvoiceId).toBe('i1')
    expect(w.invoiceNumber).toBe('CI-0001')
    expect(w.excess).toBe(500)
    expect(w.message).toMatch(/allowed/i)
  })

  it('never claims over-allocation is prevented — rules cannot sum sibling documents', () => {
    const [w] = invoiceOverAllocationWarnings([alloc('i1', 'CI-0001', 1600)], INVOICES, [])
    expect(w.message).not.toMatch(/prevent|blocked/i)
  })

  it('counts what OTHER posted receipts already reconciled', () => {
    const existing = [receipt({ allocations: [alloc('i1', 'CI-0001', 1000)] })]
    const [w] = invoiceOverAllocationWarnings([alloc('i1', 'CI-0001', 200)], INVOICES, existing)
    expect(w.excess).toBe(100)
  })

  it('excludes the receipt being edited from the "already received" figure', () => {
    const editing = receipt({ id: 'rEdit', allocations: [alloc('i1', 'CI-0001', 1000)] })
    expect(invoiceOverAllocationWarnings(
      [alloc('i1', 'CI-0001', 1100)], INVOICES, [editing], { excludeReceiptId: 'rEdit' },
    )).toEqual([])
  })

  it('ignores an allocation naming an invoice that is not on this project', () => {
    expect(invoiceOverAllocationWarnings([alloc('nope', 'CI-9999', 999)], INVOICES, [])).toEqual([])
  })
})

// ── Allocation exceptions ────────────────────────────────────────────────────

describe('allocationExceptions — surfaced, never automated', () => {
  it('flags a receipt allocated to an invoice that was VOIDED afterwards', () => {
    const r = receipt({ allocations: [alloc('i5', 'CI-0005', 300)] })
    const [e] = allocationExceptions([r], INVOICES)
    expect(e).toMatchObject({ receiptNumber: 'CR-0001', invoiceNumber: 'CI-0005', allocatedAmount: 300 })
    expect(e.reason).toMatch(/voided after this receipt was posted/i)
  })

  it('flags a receipt allocated to an invoice that is not issued', () => {
    const r = receipt({ allocations: [alloc('i4', 'CI-0004', 300)] })
    expect(allocationExceptions([r], INVOICES)[0].reason).toMatch(/not an issued invoice/i)
  })

  it('flags a receipt allocated to an invoice that no longer exists or cannot be read', () => {
    const r = receipt({ allocations: [alloc('gone', 'CI-9999', 300)] })
    expect(allocationExceptions([r], INVOICES)[0].reason).toMatch(/no longer exists or is not readable/i)
  })

  it('reports nothing for a healthy allocation', () => {
    expect(allocationExceptions([receipt({ allocations: [alloc('i1', 'CI-0001', 400)] })], INVOICES)).toEqual([])
  })

  it('ignores draft and void receipts — only posted cash can strand', () => {
    const draft = receipt({ id: 'rd', status: PAYMENT_STATUS.DRAFT, allocations: [alloc('i5', 'CI-0005', 300)] })
    const voided = receipt({ id: 'rv', status: PAYMENT_STATUS.VOID, allocations: [alloc('i5', 'CI-0005', 300)] })
    expect(allocationExceptions([draft, voided], INVOICES)).toEqual([])
  })

  it('keeps the cash real — the receipt still counts in Receipts Recorded', () => {
    const r = receipt({ amount: 300, allocations: [alloc('i5', 'CI-0005', 300)] })
    expect(allocationExceptions([r], INVOICES)).toHaveLength(1)
    expect(receiptSummary([r]).postedAmount).toBe(300)
  })

  it('documents a manual remedy and promises no automatic reversal', () => {
    expect(ALLOCATION_EXCEPTION_REMEDY).toMatch(/nothing is reversed automatically/i)
    expect(ALLOCATION_EXCEPTION_REMEDY).toMatch(/void the receipt/i)
  })
})

// ── G. Corrected AR ageing ───────────────────────────────────────────────────

describe('arAgeing — ages the remaining balance after posted receipts', () => {
  it('(G) buckets by due date on the full balance when nothing has been received', () => {
    const a = arAgeing([I1, I2, I3], [], NOW)
    expect(a.buckets.d31_60.amount).toBe(1100)   // CI-0001, 45 days past due
    expect(a.buckets.notYetDue.amount).toBe(2200) // CI-0002
    expect(a.buckets.noDueDate.amount).toBe(550)  // CI-0003
    expect(a.total).toBe(3850)
    expect(a.pastDue).toBe(1100)
  })

  it('(A) a DRAFT receipt reduces no bucket', () => {
    const draft = receipt({ status: PAYMENT_STATUS.DRAFT, allocations: [alloc('i1', 'CI-0001', 1100)] })
    expect(arAgeing([I1], [draft], NOW).buckets.d31_60.amount).toBe(1100)
  })

  it('(B) a POSTED receipt ages only the remainder', () => {
    const r = receipt({ allocations: [alloc('i1', 'CI-0001', 400)] })
    expect(arAgeing([I1], [r], NOW).buckets.d31_60.amount).toBe(700)
  })

  it('(B) a fully reconciled invoice leaves ageing entirely', () => {
    const r = receipt({ amount: 1100, allocations: [alloc('i1', 'CI-0001', 1100)] })
    const a = arAgeing([I1], [r], NOW)
    expect(a.total).toBe(0)
    expect(a.buckets.d31_60.count).toBe(0)
  })

  it('(C) voiding that receipt restores the aged balance', () => {
    const allocations = [alloc('i1', 'CI-0001', 1100)]
    const voided = receipt({ amount: 1100, status: PAYMENT_STATUS.VOID, allocations })
    expect(arAgeing([I1], [voided], NOW).buckets.d31_60.amount).toBe(1100)
  })

  it('(F) EXCLUDES an over-reconciled invoice from the buckets so it cannot offset real arrears', () => {
    const over = receipt({ amount: 1600, allocations: [alloc('i1', 'CI-0001', 1600)] })
    const a = arAgeing([I1, I2], [over], NOW)
    expect(a.buckets.d31_60.amount).toBe(0)
    expect(a.total).toBe(2200)
    expect(a.overSettled.map(r => r.id)).toEqual(['i1'])
  })

  it('(E) an UNALLOCATED receipt appears nowhere in ageing and reduces no balance', () => {
    const onAccount = receipt({ amount: 5000, allocations: [] })
    expect(arAgeing([I1], [onAccount], NOW).buckets.d31_60.amount).toBe(1100)
  })

  it('(G) never ages a draft or void INVOICE', () => {
    expect(arAgeing([I_DRAFT, I_VOID], [], NOW).total).toBe(0)
  })

  it('(J) does not mutate the invoices or receipts it reads', () => {
    const invoices = deepFreeze([inv()])
    const receipts = deepFreeze([receipt({ allocations: [alloc('i1', 'CI-0001', 400)] })])
    expect(() => arAgeing(invoices, receipts, NOW)).not.toThrow()
    expect(invoices[0].grossTotal).toBe(1100)
    expect(receipts[0].allocations[0].allocatedAmount).toBe(400)
  })
})

describe('isPastDueUnreconciled — past its due date AND still owing', () => {
  it('is true when the date has passed and money is still owed', () => {
    expect(isPastDueUnreconciled(I1, 700, NOW)).toBe(true)
  })

  it('is FALSE for a fully reconciled invoice, even though the date has passed', () => {
    // The whole reason this exists alongside the date-only isPastDue.
    expect(isPastDueUnreconciled(I1, 0, NOW)).toBe(false)
  })

  it('is FALSE for an over-reconciled invoice', () => {
    expect(isPastDueUnreconciled(I1, -400, NOW)).toBe(false)
  })

  it('is FALSE before the due date, however much is owed', () => {
    expect(isPastDueUnreconciled(I2, 2200, NOW)).toBe(false)
  })

  it('is FALSE for an invoice with no due date', () => {
    expect(isPastDueUnreconciled(I3, 550, NOW)).toBe(false)
  })

  it('is FALSE for a draft or void invoice', () => {
    expect(isPastDueUnreconciled(I_DRAFT, 1100, NOW)).toBe(false)
    expect(isPastDueUnreconciled(I_VOID, 1100, NOW)).toBe(false)
  })
})

describe('AR_RECONCILIATION_NOTICE — honest about what is NOT enforced', () => {
  it('states that over-allocation is warned but not blocked', () => {
    expect(AR_RECONCILIATION_NOTICE).toMatch(/warns but does not block/i)
  })

  it('states that concurrent allocation is unprotected', () => {
    expect(AR_RECONCILIATION_NOTICE).toMatch(/concurrently/i)
  })

  it('states that unallocated receipts reduce no invoice balance', () => {
    expect(AR_RECONCILIATION_NOTICE).toMatch(/[Uu]nallocated[\s\S]*do not reduce any invoice balance/)
  })

  it('no longer claims receipts are unrecorded — Client Receipts exist', () => {
    expect(AR_RECONCILIATION_NOTICE).not.toMatch(/not recorded/i)
    expect(AR_RECONCILIATION_NOTICE).toMatch(/posted receipts/i)
  })
})

// ── H. Validation ────────────────────────────────────────────────────────────

describe('validateReceiptDraft', () => {
  const ok = {
    clientId: 'c1',
    clientName: 'Acme Developments',
    receiptDate: '2026-08-10',
    amount: 1100,
    paymentMethod: 'bank_transfer',
    paymentMethodOther: '',
    allocations: [alloc('i1', 'CI-0001', 1100)],
  }

  it('accepts a complete draft', () => {
    expect(validateReceiptDraft(ok)).toBeNull()
  })

  it('requires a client and a client display name', () => {
    expect(validateReceiptDraft({ ...ok, clientId: '' })).toBe('Select the client this money was received from.')
    expect(validateReceiptDraft({ ...ok, clientName: '  ' })).toBe('The selected client has no display name.')
  })

  it('requires a well-shaped ISO receipt date', () => {
    const msg = 'Enter the date the money was received.'
    expect(validateReceiptDraft({ ...ok, receiptDate: '01/08/2026' })).toBe(msg)
    expect(validateReceiptDraft({ ...ok, receiptDate: '2026-8-1' })).toBe(msg)
    expect(validateReceiptDraft({ ...ok, receiptDate: '' })).toBe(msg)
  })

  it('(H) requires a strictly positive amount — a receipt is real money', () => {
    expect(validateReceiptDraft({ ...ok, amount: 0 })).toBe('Amount must be greater than zero.')
    expect(validateReceiptDraft({ ...ok, amount: -5 })).toBe('Amount must be greater than zero.')
    expect(validateReceiptDraft({ ...ok, amount: 'abc' })).toBe('Enter the amount as a number.')
  })

  it('(H) requires an explicitly chosen payment method, and a description for `other`', () => {
    expect(validateReceiptDraft({ ...ok, paymentMethod: '' })).toBe('Select how the money was transferred.')
    expect(validateReceiptDraft({ ...ok, paymentMethod: 'carrier_pigeon' })).toBe('Select a payment method from the list.')
    expect(validateReceiptDraft({ ...ok, paymentMethod: 'other' })).toBe('Describe the payment method.')
    expect(validateReceiptDraft({ ...ok, paymentMethod: 'other', paymentMethodOther: 'Contra' })).toBeNull()
  })

  it('(H) rejects an allocation row with no invoice chosen', () => {
    expect(validateReceiptDraft({ ...ok, allocations: [{ allocatedAmount: 100 }] }))
      .toBe('Allocation 1: choose an invoice.')
  })

  it('(H) rejects the same invoice allocated twice', () => {
    expect(validateReceiptDraft({ ...ok, allocations: [alloc('i1', 'CI-0001', 500), alloc('i1', 'CI-0001', 600)] }))
      .toBe('The same invoice is allocated twice — combine those rows instead.')
  })

  it('(H) rejects a zero or non-numeric allocation amount', () => {
    expect(validateReceiptDraft({ ...ok, allocations: [alloc('i1', 'CI-0001', 0)] }))
      .toBe('Allocation 1: amount must be greater than zero.')
    expect(validateReceiptDraft({ ...ok, allocations: [alloc('i1', 'CI-0001', 'x')] }))
      .toBe('Allocation 1: amount must be a number.')
  })

  it('(H) HARD-BLOCKS allocating more than the receipt amount — that money does not exist', () => {
    expect(validateReceiptDraft({ ...ok, amount: 1000, allocations: [alloc('i1', 'CI-0001', 1001)] }))
      .toBe('Allocations exceed the amount of this transaction. Reduce an allocation, or increase the amount.')
  })

  it('(H) rejects more than MAX_ALLOCATIONS rows', () => {
    const many = Array.from({ length: MAX_ALLOCATIONS + 1 }, (_, i) => alloc(`x${i}`, `CI-${i}`, 1))
    expect(validateReceiptDraft({ ...ok, amount: 1000, allocations: many }))
      .toMatch(/cannot carry more than 100 allocations/)
  })

  it('accepts a fully UNALLOCATED receipt — money on account is legitimate', () => {
    expect(validateReceiptDraft({ ...ok, allocations: [] })).toBeNull()
  })

  it('(H) rejects an allocation to an invoice that is not on this project, when invoices are supplied', () => {
    expect(validateReceiptDraft({ ...ok, allocations: [alloc('nope', 'CI-9999', 100)], amount: 100, invoices: INVOICES }))
      .toBe('An allocated invoice could not be found on this project.')
  })

  it('(H) rejects an allocation to a DRAFT or VOID invoice — only issued invoices can be reconciled', () => {
    expect(validateReceiptDraft({ ...ok, allocations: [alloc('i4', 'CI-0004', 100)], amount: 100, invoices: INVOICES }))
      .toBe('CI-0004 is draft — only issued invoices can be reconciled.')
    expect(validateReceiptDraft({ ...ok, allocations: [alloc('i5', 'CI-0005', 100)], amount: 100, invoices: INVOICES }))
      .toBe('CI-0005 is void — only issued invoices can be reconciled.')
  })

  it('(H) rejects an allocation to ANOTHER CLIENT\'s invoice', () => {
    expect(validateReceiptDraft({ ...ok, allocations: [alloc('i6', 'CI-0006', 100)], amount: 100, invoices: INVOICES }))
      .toMatch(/belongs to a different client/)
  })

  it('skips the target checks when no invoice list is supplied', () => {
    expect(validateReceiptDraft({ ...ok, allocations: [alloc('nope', 'CI-9999', 100)], amount: 100 })).toBeNull()
  })
})

describe('postBlockedReason — posting asserts the money has actually arrived', () => {
  it('allows posting a receipt dated today', () => {
    expect(postBlockedReason({ status: PAYMENT_STATUS.DRAFT, receiptDate: '2026-08-20' }, NOW)).toBeNull()
  })

  it('allows BACKDATING — entering last month\'s bank statement is the normal case', () => {
    expect(postBlockedReason({ status: PAYMENT_STATUS.DRAFT, receiptDate: '2026-07-01' }, NOW)).toBeNull()
  })

  it('blocks posting a FUTURE-dated receipt and names the correction', () => {
    const msg = postBlockedReason({ status: PAYMENT_STATUS.DRAFT, receiptDate: '2026-12-01' }, NOW)
    expect(msg).toMatch(/is in the future/)
    expect(msg).toMatch(/2026-08-20/)
  })

  it('blocks posting anything that is not a draft', () => {
    expect(postBlockedReason({ status: PAYMENT_STATUS.POSTED, receiptDate: '2026-08-01' }, NOW))
      .toBe('Only a draft receipt can be posted — this one is posted.')
    expect(postBlockedReason({ status: PAYMENT_STATUS.VOID, receiptDate: '2026-08-01' }, NOW))
      .toBe('Only a draft receipt can be posted — this one is void.')
  })

  it('handles a missing receipt', () => {
    expect(postBlockedReason(null)).toBe('Receipt not found.')
  })

  it('isFutureDatedReceipt agrees, so a draft may be SAVED ahead of settlement', () => {
    expect(isFutureDatedReceipt({ receiptDate: '2026-12-01' }, NOW)).toBe(true)
    expect(isFutureDatedReceipt({ receiptDate: '2026-08-20' }, NOW)).toBe(false)
    expect(isFutureDatedReceipt({ receiptDate: '' }, NOW)).toBe(false)
  })
})

// ── Allocation builder ───────────────────────────────────────────────────────

describe('buildAllocations — what is actually stored', () => {
  it('freezes the invoice-number snapshot so a register row renders without reading invoices', () => {
    expect(buildAllocations([{ clientInvoiceId: 'i1', allocatedAmount: 400 }], INVOICES))
      .toEqual([{ clientInvoiceId: 'i1', invoiceNumber: 'CI-0001', allocatedAmount: 400 }])
  })

  it('drops empty and zero-amount editor rows rather than storing them', () => {
    expect(buildAllocations([
      { clientInvoiceId: 'i1', allocatedAmount: 400 },
      { clientInvoiceId: '',   allocatedAmount: 900 },
      { clientInvoiceId: 'i2', allocatedAmount: 0 },
      { clientInvoiceId: 'i2', allocatedAmount: '' },
    ], INVOICES)).toEqual([{ clientInvoiceId: 'i1', invoiceNumber: 'CI-0001', allocatedAmount: 400 }])
  })

  it('rounds the stored amount to the cent', () => {
    const [a] = buildAllocations([{ clientInvoiceId: 'i1', allocatedAmount: 400.005 }], INVOICES)
    expect(a.allocatedAmount).toBe(400.01)
  })

  it('stores ONLY the three allocation fields — no balance is ever stamped onto the invoice', () => {
    const [a] = buildAllocations([{ clientInvoiceId: 'i1', allocatedAmount: 400 }], INVOICES)
    expect(Object.keys(a).sort()).toEqual(['allocatedAmount', 'clientInvoiceId', 'invoiceNumber'])
  })

  it('falls back to the row\'s own snapshot when the invoice cannot be read', () => {
    expect(buildAllocations([{ clientInvoiceId: 'gone', invoiceNumber: 'CI-9999', allocatedAmount: 10 }], INVOICES))
      .toEqual([{ clientInvoiceId: 'gone', invoiceNumber: 'CI-9999', allocatedAmount: 10 }])
  })

  it('(J) does not mutate the invoices it reads', () => {
    const invoices = deepFreeze([inv()])
    expect(() => buildAllocations([{ clientInvoiceId: 'i1', allocatedAmount: 400 }], invoices)).not.toThrow()
    expect(invoices[0].grossTotal).toBe(1100)
  })
})

// ── J. Purity — the invoice document is never written to ─────────────────────

describe('purity — every AR derivation leaves the Client Invoice untouched', () => {
  // The AR position is a FUNCTION of receipt documents, recomputed per render.
  // Nothing here may stamp a balance, a reconciliation state, a `paid` status,
  // or a receipt back-reference onto an invoice (ADR-22 / ADR-3 / ADR-4).
  const invoices = () => deepFreeze([inv(), inv({ id: 'i2', invoiceNumber: 'CI-0002', grossTotal: 2200, clientId: 'c1' })])
  const receipts = () => deepFreeze([receipt({ amount: 900, allocations: [alloc('i1', 'CI-0001', 400), alloc('i2', 'CI-0002', 500)] })])

  it('runs every read-time derivation against frozen documents without throwing', () => {
    const i = invoices()
    const r = receipts()
    expect(() => {
      receivedByInvoice(r)
      clientInvoiceReconciliationRows(i, r)
      receivablesSummary(i, r)
      arAgeing(i, r, NOW)
      allocatableInvoices(i, 'c1', r)
      invoiceOverAllocationWarnings([alloc('i1', 'CI-0001', 9999)], i, r)
      allocationExceptions(r, i)
      receiptsForInvoice(r, 'i1')
      receiptSummary(r)
    }).not.toThrow()
  })

  it('leaves the invoice document byte-identical — no balance or reference field is added', () => {
    const i = invoices()
    const before = JSON.stringify(i)
    receivablesSummary(i, receipts())
    arAgeing(i, receipts(), NOW)
    expect(JSON.stringify(i)).toBe(before)
    // The authored invoice shape is unchanged: no `received`, no `remaining`,
    // no `reconciliationState`, no `receiptIds`, no `paid`, no `paidAt`.
    expect(Object.keys(i[0]).sort()).toEqual([
      'clientId', 'clientName', 'dueDate', 'grossTotal', 'gstTotal',
      'id', 'invoiceDate', 'invoiceNumber', 'status', 'subtotal',
    ])
  })

  it('leaves the receipt document byte-identical', () => {
    const r = receipts()
    const before = JSON.stringify(r)
    receivablesSummary(invoices(), r)
    receiptSummary(r)
    expect(JSON.stringify(r)).toBe(before)
  })

  it('is idempotent — the same inputs derive the same figures every render', () => {
    const i = invoices()
    const r = receipts()
    expect(receivablesSummary(i, r)).toEqual(receivablesSummary(i, r))
    expect(arAgeing(i, r, NOW)).toEqual(arAgeing(i, r, NOW))
  })
})
