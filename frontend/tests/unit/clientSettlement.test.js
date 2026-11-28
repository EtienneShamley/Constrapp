import { describe, it, expect } from 'vitest'
import {
  readLedger, ledgerDocument, emptyLedger, ledgerRemainingCents, ledgerRefundableCents, ledgerOwedCents,
  netReceivedCents, settlementInvariantError, applyReceipt, applyApplication, applyApplicationVoid,
  applyInvoiceRefund, applyInvoiceRefundVoid, applyCredit, storedLedgerProblem, ledgerStateProblem, LEDGER_KIND,
} from '../../src/lib/clientLedger'
import {
  SETTLEMENT_STATUS, REFUND_SOURCE, requestCents, refundRequestProblem, applicationRequestProblem,
  postedReceiptUnallocatedCents, receiptLedgerProblem, readReceiptLedger, receiptAvailableCents, moveReceiptLedger,
  receiptLedgerStateProblem, settlementByInvoice, settlementByReceipt, refundCashRows, settlementSummary,
  settlementExceptions, buildClientRefund, buildReceiptApplication, clientRefundNumberOf, clientApplicationNumberOf,
  counterAfter, REFUND_REQUEST_KEYS, APPLICATION_REQUEST_KEYS,
} from '../../src/lib/clientSettlement'
import { receivedByInvoice, receivablesSummary, receiptSummary, cashInRows, receiptAvailable, clientInvoiceReconciliationRows } from '../../src/lib/clientReceipts'
import { invoiceTotals } from '../../src/lib/clientInvoices'
import { gstForLine } from '../../src/lib/supplierInvoices'

// ── Phase 2 step 5 (ADR-95) — client refunds and receipt applications ─────
//
// INDEPENDENT ORACLE: every expected figure below is computed here, in integer
// cents parsed from the decimal TEXT of each amount — never by the module
// under test, never by toCents.
const c = (text) => {
  const [w, f = ''] = String(text).replace('-', '').split('.')
  const v = Number(w) * 100 + Number((f + '00').slice(0, 2))
  return String(text).startsWith('-') ? -v : v
}

const line = (amount, taxCode = 'gst') => ({ description: 'Work', amount, taxCode, gstAmount: gstForLine(amount, taxCode), variationId: null, variationNumber: '', costCodeId: null, costCodeName: null })
function invoice(lines, retention = 0, over = {}) {
  return { id: 'inv1', invoiceNumber: 'CI-0001', status: 'issued', clientId: 'client1', clientName: 'Acme', currency: 'AUD', lineItems: lines, ...invoiceTotals(lines, retention), ...over }
}
const receipt = (over = {}) => ({
  id: 'r1', receiptNumber: 'CR-0001', status: 'posted', clientId: 'client1', clientName: 'Acme', currency: 'AUD',
  amount: 1500, allocatedTotal: 1000, unallocatedAmount: 500,
  allocations: [{ clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', allocatedAmount: 1000 }], ...over,
})
const refund = (over = {}) => ({ id: 'f1', refundNumber: 'CRF-0001', status: 'posted', source: 'receipt', receiptId: 'r1', clientInvoiceId: null, clientId: 'client1', currency: 'AUD', amount: 100, refundDate: '2026-11-20', ...over })
const application = (over = {}) => ({ id: 'a1', applicationNumber: 'CRA-0001', status: 'posted', receiptId: 'r1', clientInvoiceId: 'inv2', clientId: 'client1', currency: 'AUD', amount: 200, applicationDate: '2026-11-20', ...over })

describe('the invoice ledger carries refunds (S1) — exactly, and only once one exists', () => {
  it('a ledger that never had a refund stores exactly the document it stored before', () => {
    const doc = ledgerDocument(applyReceipt(readLedger(null), 1000, 'r1'))
    expect('refundedCents' in doc).toBe(false)
    expect(readLedger({ receivedCents: 5 }).refundedPresent).toBe(false)
  })
  it('once a refund touched it, refundedCents is always written — also back at zero after a correction', () => {
    const refunded = applyInvoiceRefund(readLedger(null), 300, 'f1')
    expect(ledgerDocument(refunded).refundedCents).toBe(300)
    const corrected = applyInvoiceRefundVoid(readLedger(ledgerDocument(refunded)), 300, 'f1')
    expect(ledgerDocument(corrected).refundedCents).toBe(0)
    expect(corrected.lastEntryKind).toBe(LEDGER_KIND.REFUND_VOID)
  })
  it('a stored refunded figure that is not whole, non-negative cents is a problem, never zero', () => {
    for (const bad of [-1, 1.5, '3', null]) expect(storedLedgerProblem({ refundedCents: bad }), String(bad)).toMatch(/refundedCents/)
    expect(ledgerStateProblem({ ...emptyLedger(), refundedCents: -1 })).toMatch(/refundedCents/)
    // A state built before step 5 (no key) is zero.
    const { refundedCents: _drop, ...older } = emptyLedger()
    void _drop
    expect(ledgerStateProblem(older)).toBeNull()
  })
  it('net received, remaining, owed and refundable (oracle in integer cents)', () => {
    // Invoice 1,000.00 + GST 100.00 = 1,100.00 receivable.
    const inv = invoice([line(1000)])
    const basis = c('1100.00')
    let L = applyReceipt(readLedger(null), c('1250.00'), 'r1')        // over-allocated by 150.00
    expect(netReceivedCents(L)).toBe(c('1250.00'))
    expect(ledgerRemainingCents(inv, L)).toBe(basis - c('1250.00'))
    expect(ledgerRefundableCents(inv, L)).toBe(c('150.00'))
    expect(ledgerOwedCents(inv, L)).toBe(0)
    L = applyInvoiceRefund(L, c('100.00'), 'f1')
    expect(netReceivedCents(L)).toBe(c('1150.00'))
    expect(ledgerRefundableCents(inv, L)).toBe(c('50.00'))
    expect(settlementInvariantError(inv, L)).toBeNull()
    L = applyInvoiceRefund(L, c('50.00'), 'f2')
    expect(ledgerRemainingCents(inv, L)).toBe(0)
    expect(settlementInvariantError(inv, L)).toBeNull()
  })
  it('S1: once refunded, the invoice must still hold at least what is receivable; unpaid without refunds is fine', () => {
    const inv = invoice([line(1000)])
    expect(settlementInvariantError(inv, applyReceipt(readLedger(null), c('500.00'), 'r1'))).toBeNull()      // simply unpaid
    const over = applyInvoiceRefund(applyReceipt(readLedger(null), c('1100.00'), 'r1'), c('0.01'), 'f1')
    expect(settlementInvariantError(inv, over)).toMatch(/refunded/)
    // A credit note created an overpayment of 110.00 (100 + GST 10), refunded in full …
    const credited = applyCredit(applyReceipt(readLedger(null), c('1100.00'), 'r1'), {
      id: 'cn1', subtotal: 100, gstTotal: 10, retentionAmount: 0, retentionGst: 0, lineItems: [{ invoiceLineIndex: 0, amount: 100, gstAmount: 10 }],
    })
    const settled = applyInvoiceRefund(credited, c('110.00'), 'f1')
    expect(settlementInvariantError(inv, settled)).toBeNull()
    // … then voiding the credit would leave 110.00 refunded that the invoice no longer covers.
    const creditVoided = { ...settled, creditedSubtotalCents: 0, creditedGstCents: 0, lines: {} }
    expect(settlementInvariantError(inv, creditVoided)).toMatch(/refunded/)
  })
  it('an application moves received exactly like a receipt allocation; its correction takes it back', () => {
    const L = applyApplication(readLedger(null), c('200.00'), 'a1')
    expect(L.receivedCents).toBe(c('200.00'))
    expect(L.lastEntryKind).toBe(LEDGER_KIND.APPLICATION)
    expect(applyApplicationVoid(L, c('200.00'), 'a1').receivedCents).toBe(0)
    // Nothing clamps: taking back more than recorded leaves an invalid state the backend refuses.
    expect(ledgerStateProblem(applyApplicationVoid(L, c('200.01'), 'a1'))).toMatch(/receivedCents/)
  })
})

describe('requests: authored content only, whole cents, the D6 vocabulary', () => {
  const ok = { source: 'receipt', receiptId: 'r1', clientInvoiceId: null, amount: 10.5, refundDate: '2026-11-20', method: 'bank_transfer', reference: 'EFT 1', reason: 'Overpaid' }
  it('a valid refund request passes; every authored field is checked', () => {
    expect(refundRequestProblem(ok)).toBeNull()
    expect(refundRequestProblem({ ...ok, source: 'invoice', receiptId: null, clientInvoiceId: 'inv1' })).toBeNull()
    const bad = [
      [{ source: 'wallet' }, 'source'], [{ clientInvoiceId: 'inv1' }, 'receiptId'], [{ source: 'invoice' }, 'clientInvoiceId'],
      [{ amount: 0 }, 'amount'], [{ amount: -5 }, 'amount'], [{ amount: 10.005 }, 'amount'], [{ amount: '10' }, 'amount'],
      [{ amount: 1e16 }, 'amount'], [{ refundDate: '20/11/2026' }, 'refundDate'], [{ method: 'crypto' }, 'method'],
      [{ reference: '   ' }, 'reference'], [{ reference: 'x'.repeat(101) }, 'reference'], [{ reason: '' }, 'reason'],
    ]
    for (const [over, field] of bad) expect(refundRequestProblem({ ...ok, ...over }), JSON.stringify(over)).toBe(field)
  })
  it('a valid application request passes; amount, date and notes are checked', () => {
    const a = { receiptId: 'r1', clientInvoiceId: 'inv2', amount: 0.01, applicationDate: '2026-11-20', notes: '' }
    expect(applicationRequestProblem(a)).toBeNull()
    expect(applicationRequestProblem({ ...a, amount: 0 })).toBe('amount')
    expect(applicationRequestProblem({ ...a, notes: 'x'.repeat(1001) })).toBe('notes')
    expect(applicationRequestProblem({ ...a, applicationDate: '' })).toBe('applicationDate')
  })
  it('the request key sets carry no client, currency, status or derived figure', () => {
    for (const keys of [REFUND_REQUEST_KEYS, APPLICATION_REQUEST_KEYS]) {
      for (const k of ['clientId', 'currency', 'status', 'refundNumber', 'applicationNumber', 'companyId', 'clientName']) expect(keys).not.toContain(k)
    }
  })
  it('requestCents: positive whole cents only', () => {
    expect(requestCents(0.1 + 0.2)).toBeNull()        // 0.30000000000000004 is not a whole-cent number
    expect(requestCents(0.3)).toBe(30)
    expect(requestCents(Number.NaN)).toBeNull()
  })
})

describe('a posted receipt’s unallocated money and its receipt ledger', () => {
  it('derived strictly from amount and allocations (oracle)', () => {
    expect(postedReceiptUnallocatedCents(receipt())).toMatchObject({ cents: c('500.00'), amountCents: c('1500.00'), allocatedCents: c('1000.00') })
    expect(postedReceiptUnallocatedCents(receipt({ allocations: [] }))).toMatchObject({ cents: c('1500.00') })
    expect(postedReceiptUnallocatedCents(receipt({ amount: 1500.001 })).field).toBe('amount')
    expect(postedReceiptUnallocatedCents(receipt({ allocations: [{ clientInvoiceId: 'inv1', allocatedAmount: 2000 }] })).field).toBe('allocations')
    expect(postedReceiptUnallocatedCents(receipt({ allocations: [{ clientInvoiceId: 'inv1', allocatedAmount: -1 }] })).field).toMatch(/allocations/)
  })
  it('the ledger: absent is zero; invalid figures are refused; availability is unallocated − applied − refunded', () => {
    expect(readReceiptLedger(null)).toEqual({ seq: 0, appliedCents: 0, refundedCents: 0 })
    expect(receiptLedgerProblem({ seq: 1, appliedCents: 1.5, refundedCents: 0 })).toMatch(/appliedCents/)
    expect(receiptLedgerProblem({ seq: 1, appliedCents: 0 })).toMatch(/refundedCents/)
    let L = moveReceiptLedger(readReceiptLedger(null), { appliedCents: c('200.00') }, 'application', 'a1')
    L = moveReceiptLedger(L, { refundedCents: c('100.00') }, 'refund', 'f1')
    expect(receiptAvailableCents(c('500.00'), L)).toBe(c('200.00'))
    expect(L).toMatchObject({ seq: 2, lastEntryId: 'f1', lastEntryKind: 'refund' })
    expect(receiptLedgerStateProblem(moveReceiptLedger(L, { refundedCents: -c('100.01') }, 'refund_void', 'f1'))).toMatch(/refundedCents/)
  })
})

describe('read-time selectors: net cash, what invoices hold, what receipts can still settle', () => {
  const invoices = [invoice([line(1000)]), invoice([line(500)], 0, { id: 'inv2', invoiceNumber: 'CI-0002' })]
  const receipts = [receipt()]
  const settlement = {
    refunds: [refund(), refund({ id: 'f2', refundNumber: 'CRF-0002', source: 'invoice', receiptId: null, clientInvoiceId: 'inv1', amount: 50 }), refund({ id: 'f3', status: 'void', amount: 999 })],
    applications: [application(), application({ id: 'a2', status: 'void', amount: 999 })],
  }
  it('without settlement every figure is exactly the receipts-only figure', () => {
    expect(receivedByInvoice(receipts)).toEqual({ inv1: 1000 })
    expect(receivedByInvoice(receipts, { refunds: [], applications: [] })).toEqual({ inv1: 1000 })
  })
  it('received per invoice = allocations + applications − invoice refunds (void records count nowhere)', () => {
    expect(receivedByInvoice(receipts, settlement)).toEqual({ inv1: 950, inv2: 200 })
    const rows = clientInvoiceReconciliationRows(invoices, receipts, {}, settlement)
    expect(rows.find(r => r.id === 'inv1').remaining).toBe((c('1100.00') - c('950.00')) / 100)
    expect(rows.find(r => r.id === 'inv2').remaining).toBe((c('550.00') - c('200.00')) / 100)
    expect(receivablesSummary(invoices, receipts, {}, settlement).received).toBe((c('950.00') + c('200.00')) / 100)
  })
  it('receipt summary: unallocated after applications and receipt refunds; net received = receipts − all refunds', () => {
    const s = receiptSummary(receipts, settlement)
    expect(s.postedAmount).toBe(1500)
    expect(s.unallocated).toBe((c('500.00') - c('200.00') - c('100.00')) / 100)
    expect(s.allocated).toBe((c('1000.00') + c('200.00')) / 100)
    expect(s.refunded).toBe((c('100.00') + c('50.00')) / 100)
    expect(s.netReceived).toBe((c('1500.00') - c('150.00')) / 100)
    expect(receiptAvailable(receipts[0], settlement)).toBe(200)
  })
  it('cash rows: refunds follow as negative rows; an application is never cash', () => {
    const rows = cashInRows(receipts, { projectId: 'p1', refunds: settlement.refunds })
    expect(rows.map(r => r.amount)).toEqual([1500, -100, -50])
    expect(rows.reduce((t, r) => t + c(r.amount.toFixed(2)), 0)).toBe(c('1350.00'))
    expect(cashInRows(receipts, { projectId: 'p1' })).toHaveLength(1)
    expect(refundCashRows(settlement.refunds)).toHaveLength(2)
  })
  it('settlement maps and summary', () => {
    expect(settlementByInvoice(settlement)).toEqual({ inv2: { appliedCents: 20000, refundedCents: 0 }, inv1: { appliedCents: 0, refundedCents: 5000 } })
    expect(settlementByReceipt(settlement)).toEqual({ r1: { appliedCents: 20000, refundedCents: 10000 } })
    expect(settlementSummary(settlement)).toEqual({ refundedCents: 15000, refundedFromReceiptsCents: 10000, refundedFromInvoicesCents: 5000, appliedCents: 20000, refundCount: 2, applicationCount: 1 })
  })
})

describe('integrity exceptions (the Final Account gate)', () => {
  const invoices = [invoice([line(1000)]), invoice([line(500)], 0, { id: 'inv2', invoiceNumber: 'CI-0002' })]
  const receipts = [receipt()]
  it('records the backend wrote are supported', () => {
    expect(settlementExceptions({ refunds: [refund()], applications: [application()], receipts, invoices })).toEqual([])
  })
  it('each unsupported record is named', () => {
    const cases = [
      [{ applications: [application({ receiptId: 'gone' })] }, 'receipt-not-posted'],
      [{ applications: [application({ clientInvoiceId: 'gone' })] }, 'invoice-not-issued'],
      [{ applications: [application({ currency: 'NZD' })] }, 'currency-mismatch'],
      [{ refunds: [refund({ clientId: 'other' })] }, 'client-mismatch'],
      [{ refunds: [refund({ source: 'invoice', receiptId: null, clientInvoiceId: 'inv1', currency: 'USD' })] }, 'currency-mismatch'],
      [{ refunds: [refund({ amount: 400 })], applications: [application({ amount: 200 })] }, 'receipt-over-settled'],
    ]
    for (const [records, problem] of cases) {
      const out = settlementExceptions({ refunds: [], applications: [], receipts, invoices, ...records })
      expect(out.map(e => e.problem), problem).toContain(problem)
    }
  })
})

describe('documents', () => {
  it('a refund names its source, the derived client and currency, and is born posted', () => {
    const doc = buildClientRefund({ refundNumber: clientRefundNumberOf(7), source: REFUND_SOURCE.RECEIPT, receipt: receipt(), clientId: 'client1', clientName: 'Acme', currency: 'AUD', cents: 1050, refundDate: '2026-11-20', method: 'cheque', reference: ' CHQ 9 ', reason: ' Overpaid ', uid: 'u1' })
    expect(doc).toMatchObject({ refundNumber: 'CRF-0007', status: SETTLEMENT_STATUS.POSTED, source: 'receipt', receiptId: 'r1', clientInvoiceId: null, amount: 10.5, reference: 'CHQ 9', reason: 'Overpaid', voidedBy: null })
  })
  it('an application names both ends; numbering', () => {
    const doc = buildReceiptApplication({ applicationNumber: clientApplicationNumberOf(12), receipt: receipt(), invoice: { id: 'inv2', invoiceNumber: 'CI-0002' }, cents: 20000, applicationDate: '2026-11-20', notes: ' n ', uid: 'u1' })
    expect(doc).toMatchObject({ applicationNumber: 'CRA-0012', receiptId: 'r1', clientInvoiceId: 'inv2', clientId: 'client1', currency: 'AUD', amount: 200, notes: 'n' })
    expect(counterAfter(41)).toBe(42)
  })
})
