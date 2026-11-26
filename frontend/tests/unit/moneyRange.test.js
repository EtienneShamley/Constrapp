import { describe, it, expect } from 'vitest'
import { MAX_SUPPORTED_AMOUNT_CENTS, MAX_SUPPORTED_AMOUNT_TEXT, MAX_SUPPORTED_RECEIPT_CENTS, toCents, fromCents, isWholeCents } from '../../src/lib/money'
import { validateInvoiceDraft } from '../../src/lib/clientInvoices'

// ── The documented supported monetary range (ADR-86, final pass) ─────────────
//
// 999,999,999,999.99 per client invoice (ex-GST). The exactness evidence is in
// money.test.js and clientLedger.test.js; this file pins the limit itself and
// that the invoice editor refuses, with a plain reason, an amount above it.

const draft = (amount) => ({
  clientId: 'c1', clientName: 'Owner', invoiceDate: '2026-11-26',
  lineItems: [{ description: 'Works', amount, taxCode: 'gst', gstAmount: 0 }],
})

describe('supported monetary range', () => {
  it('is 999,999,999,999.99, stated the same way in cents and in words', () => {
    expect(MAX_SUPPORTED_AMOUNT_CENTS).toBe(99_999_999_999_999)
    expect(fromCents(MAX_SUPPORTED_AMOUNT_CENTS)).toBe(999999999999.99)
    expect(toCents(999999999999.99)).toBe(MAX_SUPPORTED_AMOUNT_CENTS)
    expect(MAX_SUPPORTED_AMOUNT_TEXT).toBe('999,999,999,999.99')
    expect(Number.isSafeInteger(MAX_SUPPORTED_AMOUNT_CENTS * 80)).toBe(true)
  })

  it('an invoice AT the maximum is accepted; one cent above is refused with the reason', () => {
    expect(validateInvoiceDraft(draft(999999999999.99))).toBeNull()
    expect(validateInvoiceDraft(draft(1000000000000))).toMatch(/cannot exceed 999,999,999,999\.99/)
    expect(validateInvoiceDraft({ ...draft(500000000000), lineItems: [draft(1).lineItems[0], { description: 'a', amount: 500000000000, taxCode: 'gst', gstAmount: 0 }, { description: 'b', amount: 500000000000, taxCode: 'gst', gstAmount: 0 }] }))
      .toMatch(/cannot exceed/)
  })

  it('the limit is far below where an amount stops converting to cents exactly (2^45)', () => {
    expect(fromCents(MAX_SUPPORTED_AMOUNT_CENTS) * 35).toBeLessThan(2 ** 45)
  })

  // The SERVER is the authority for both limits (functions/src/clientFinance/
  // agreement.js → invoiceRangeProblem; lib/clientReceiptPosting.js →
  // deriveReceiptTotals) — proven through the callables in
  // tests/functions/clientReceiptBaseline.test.js.
  it('a receipt may be ten maximum invoices: 9,999,999,999,999.90, exact in cents and far inside the safe-integer range', () => {
    expect(MAX_SUPPORTED_RECEIPT_CENTS).toBe(10 * MAX_SUPPORTED_AMOUNT_CENTS)
    expect(MAX_SUPPORTED_RECEIPT_CENTS).toBe(999_999_999_999_990)
    expect(fromCents(MAX_SUPPORTED_RECEIPT_CENTS)).toBe(9999999999999.9)
    expect(toCents(9999999999999.9)).toBe(MAX_SUPPORTED_RECEIPT_CENTS)
    expect(isWholeCents(9999999999999.9)).toBe(true)
    // One cent either side is a different, exact number of cents.
    expect(toCents(9999999999999.91)).toBe(MAX_SUPPORTED_RECEIPT_CENTS + 1)
    expect(toCents(9999999999999.89)).toBe(MAX_SUPPORTED_RECEIPT_CENTS - 1)
    expect(fromCents(MAX_SUPPORTED_RECEIPT_CENTS)).toBeLessThan(2 ** 45)
    expect(Number.isSafeInteger(MAX_SUPPORTED_RECEIPT_CENTS * 9)).toBe(true)
    expect(Number.isSafeInteger(MAX_SUPPORTED_RECEIPT_CENTS * 10)).toBe(false)   // …which is why every ledger total is range-checked when written
  })
})
