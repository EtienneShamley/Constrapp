import { describe, it, expect } from 'vitest'
import {
  payableBasis, remainingPayable, supplierInvoiceReconciliationRows,
  payablesSummary, allocatableSupplierInvoices, apAgeing, cashOutRows,
} from '../../src/lib/supplierPayments'
import { releasedByInvoiceId } from '../../src/lib/retention'

// ─────────────────────────────────────────────────────────────────────────────
// RETENTION RELEASE × SUPPLIER CREDIT NOTES — the combined payable model.
//
// ADR-30 (retention release) and ADR-31 (supplier credit notes) were built on
// separate branches and both extended the SAME derivation in lib/supplierPayments.js:
//
//     basis     = invoice.payableTotal  +  Σ posted retentionReleases     (ADR-30)
//     settled   = Σ posted allocations  +  Σ posted valid credit notes    (ADR-31)
//     remaining = basis − settled                    (SIGNED, never clamped)
//
// The two adjustments move in OPPOSITE directions. Every other unit suite
// exercises exactly one of them, so nothing else in the repository proves they
// compose. This file is that proof, and it is a REGRESSION GUARD: the two
// features arrived through a merge in which each side had independently claimed
// the same positional argument, and taking either side wholesale would have
// silently deleted the other's effect with no failing test on the survivor.
//
// ⚠️ These tests assert ACCEPTED behaviour, including behaviour that looks like
// a gap (a credit against a retained invoice contributing zero). Nothing here
// may be relaxed to make a future change pass — see the notes on each case.
// ─────────────────────────────────────────────────────────────────────────────

// A posted invoice WITH retention withheld: 10,000 ex-GST + 1,000 GST = 11,000
// gross; 1,000 retention + 100 retention GST = 1,100 withheld; 9,900 payable.
const retained = (over = {}) => ({
  id: 'si1',
  invoiceNumber: 'SI-0001',
  supplierInvoiceNumber: 'INV-100',
  status: 'posted',
  supplierId: 'sup1',
  supplierName: 'Bloggs Concreting Pty Ltd',
  currency: 'AUD',
  invoiceDate: '2026-01-01',
  dueDate: '2026-01-31',
  lineItems: [
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 10000, taxCode: 'gst', gstAmount: 1000 },
  ],
  subtotal: 10000, gstTotal: 1000, grossTotal: 11000,
  retention: 1000, retentionGst: 100, retentionTotal: 1100,
  net: 9000, payableGst: 900, payableTotal: 9900,
  ...over,
})

// The same invoice with NO retention — the only shape a credit note may target
// (ADR-31: retained invoices are uncreditable).
const clean = (over = {}) => retained({
  retention: 0, retentionGst: 0, retentionTotal: 0,
  net: 10000, payableGst: 1000, payableTotal: 11000,
  ...over,
})

const payment = (amount, over = {}) => ({
  id: 'sp1', paymentNumber: 'SP-0001', status: 'posted',
  paymentDate: '2026-02-01', amount, supplierId: 'sup1',
  allocations: [{ supplierInvoiceId: 'si1', allocatedAmount: amount }],
  ...over,
})

// A posted retention release: `prev` ex-GST already released, `amount` ex-GST
// released by this document, with GST carried as the cumulative rounding delta.
const release = ({ prev = 0, amount = 400, status = 'posted' } = {}) => ({
  id: `rr_${prev}_${amount}`, releaseNumber: 'RR-0001', status,
  docType: 'retention_release', supplierInvoiceId: 'si1',
  supplierId: 'sup1', supplierName: 'Bloggs Concreting Pty Ltd', currency: 'AUD',
  previouslyReleasedAmount: prev, amount,
  gstAmount: Math.round((prev + amount) * 10) / 100 - Math.round(prev * 10) / 100,
  releaseTotal: amount + (Math.round((prev + amount) * 10) / 100 - Math.round(prev * 10) / 100),
  releaseDate: '2026-03-01', reason: 'Practical completion',
})

// A posted, whole-cent, GST-correct credit note: 500 ex-GST + 50 GST = 550.
// Its cost code must exist on the target invoice or the validity gate rejects it.
const credit = (over = {}) => ({
  id: 'scn1', creditNumber: 'SCN-0001', status: 'posted', docType: 'credit_note',
  supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100',
  supplierId: 'sup1', supplierName: 'Bloggs Concreting Pty Ltd', currency: 'AUD',
  creditDate: '2026-02-15', reason: 'Over-billed slab area',
  subtotal: 500, gstTotal: 50, grossTotal: 550,
  lineItems: [
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Credit', amount: 500, taxCode: 'gst', gstAmount: 50 },
  ],
  ...over,
})

describe('retention release × credit notes — payable basis', () => {
  it('a retained invoice is payable NET of retention withheld', () => {
    const inv = retained()
    expect(payableBasis(inv)).toBe(9900)
    expect(payableBasis(inv, 0)).toBe(9900)
    const [row] = supplierInvoiceReconciliationRows([inv], [])
    expect(row.payableTotal).toBe(9900)
    expect(row.retentionHeld).toBe(1100)
    expect(row.releasedTotal).toBe(0)
    expect(row.remaining).toBe(9900)
  })

  it('a POSTED retention release INCREASES the payable basis', () => {
    const inv = retained()
    const map = releasedByInvoiceId([release({ prev: 0, amount: 400 })])
    expect(map.si1).toBe(440)                       // 400 ex-GST + 40 GST
    expect(payableBasis(inv, map.si1)).toBe(10340)  // 9900 + 440

    const [row] = supplierInvoiceReconciliationRows([inv], [], [], map)
    expect(row.payableTotal).toBe(10340)
    expect(row.releasedTotal).toBe(440)
    expect(row.retentionHeld).toBe(660)             // 1100 − 440, still not payable
    expect(row.remaining).toBe(10340)
    // Held and released are disjoint and sum to the original withholding —
    // this is what makes double-counting retention structurally impossible.
    expect(row.retentionHeld + row.releasedTotal).toBe(row.retentionTotal)
  })

  it('a valid POSTED credit note DECREASES what remains payable', () => {
    const inv = clean()
    const [row] = supplierInvoiceReconciliationRows([inv], [], [credit()])
    expect(row.payableTotal).toBe(11000)            // basis unchanged by a credit
    expect(row.credited).toBe(550)
    expect(row.remaining).toBe(10450)               // 11000 − 550
  })

  it('draft and void credit notes contribute ZERO', () => {
    const inv = clean()
    for (const status of ['draft', 'void']) {
      const [row] = supplierInvoiceReconciliationRows([inv], [], [credit({ status })])
      expect(row.credited).toBe(0)
      expect(row.remaining).toBe(11000)
    }
  })

  it('draft and void retention releases contribute ZERO', () => {
    const inv = retained()
    for (const status of ['draft', 'void']) {
      const map = releasedByInvoiceId([release({ status })])
      const [row] = supplierInvoiceReconciliationRows([inv], [], [], map)
      expect(row.releasedTotal).toBe(0)
      expect(row.payableTotal).toBe(9900)
      expect(row.retentionHeld).toBe(1100)
    }
  })
})

describe('retention release × credit notes — combination without double counting', () => {
  // The arithmetic is asserted on `clean` because it is the only invoice on
  // which BOTH adjustments are legitimate at once (a retained invoice cannot be
  // credited at all — see the safety case below). The formula itself is shared.
  it('release ADDS and credit SUBTRACTS on the same balance — strictly additive', () => {
    const inv = clean()
    const base    = remainingPayable(inv, 0, 0, 0)
    const relOnly = remainingPayable(inv, 0, 0, 440)
    const cnOnly  = remainingPayable(inv, 0, 550, 0)
    const both    = remainingPayable(inv, 0, 550, 440)

    expect(base).toBe(11000)
    expect(relOnly).toBe(11440)
    expect(cnOnly).toBe(10450)
    expect(both).toBe(10890)
    // Neither adjustment is applied twice, and neither swallows the other.
    expect(both).toBe(base + 440 - 550)
    expect(both - relOnly).toBe(cnOnly - base)
  })

  it('payments, credits and releases settle one balance in any order', () => {
    const inv = clean()
    expect(remainingPayable(inv, 1000, 550, 440)).toBe(9890)   // 11000 + 440 − 550 − 1000
    const [row] = supplierInvoiceReconciliationRows(
      [inv], [payment(1000)], [credit()], { si1: 440 },
    )
    // Cash paid and credit reduction stay SEPARATE columns; only their sum settles.
    expect(row.paid).toBe(1000)
    expect(row.credited).toBe(550)
    expect(row.payableTotal).toBe(11440)
    expect(row.remaining).toBe(9890)
  })

  it('the project summary agrees with the rows it is built from', () => {
    const inv = clean()
    const s = payablesSummary([inv], [payment(1000)], [credit()], { si1: 440 })
    expect(s.postedPayable).toBe(11440)
    expect(s.paid).toBe(1000)
    expect(s.credited).toBe(550)
    expect(s.remaining).toBe(9890)
    expect(s.overReconciled).toBe(0)
  })
})

describe('released retention is allocatable through ordinary Supplier Payments', () => {
  it('offers the released amount as payable to the payment picker', () => {
    const inv = retained()
    const map = releasedByInvoiceId([release({ prev: 0, amount: 400 })])
    // Fully paid to the ORIGINAL payable, so only the released slice remains.
    const [target] = allocatableSupplierInvoices(
      [inv], 'sup1', 'Bloggs Concreting Pty Ltd', [payment(9900)],
      { releasedByInvoiceId: map },
    )
    expect(target.invoicePayableTotal).toBe(9900)   // stored, immutable
    expect(target.payableTotal).toBe(10340)         // derived, release-aware
    expect(target.retentionHeld).toBe(660)
    expect(target.remaining).toBe(440)              // exactly the released retention
  })

  it('a payment settles released retention like any other payable', () => {
    const inv = retained()
    const map = releasedByInvoiceId([release({ prev: 0, amount: 400 })])
    const [row] = supplierInvoiceReconciliationRows([inv], [payment(10340)], [], map)
    expect(row.remaining).toBe(0)
    expect(row.state).toBe('fully_reconciled')
  })

  it('a RELEASE IS NOT CASH — Actual Cash Out counts posted payments only', () => {
    const map = releasedByInvoiceId([release({ prev: 0, amount: 400 })])
    expect(map.si1).toBe(440)
    // No payment exists, so no cash moved, however much retention was released.
    expect(cashOutRows([], { projectId: 'p1' })).toEqual([])
    expect(cashOutRows([payment(500)], { projectId: 'p1' })).toHaveLength(1)
    expect(cashOutRows([payment(500)], { projectId: 'p1' })[0].amount).toBe(500)
  })
})

describe('over-reconciliation stays signed, visible, and out of AP ageing', () => {
  it('a credit after full payment leaves a SIGNED negative balance', () => {
    const inv = clean()
    expect(remainingPayable(inv, 11000, 550, 0)).toBe(-550)   // never clamped to 0
    const [row] = supplierInvoiceReconciliationRows([inv], [payment(11000)], [credit()])
    expect(row.credited).toBe(550)
    expect(row.remaining).toBe(-550)                          // recoverable FROM the supplier
    expect(row.state).toBe('over_reconciled')
  })

  it('the negative balance is EXCLUDED from ordinary AP ageing, not netted into it', () => {
    const inv = clean()
    const aged = apAgeing([inv], [payment(11000)], [credit()], {}, new Date('2026-06-01'))
    expect(aged.total).toBe(0)                                // never aged as arrears
    // Reported separately so it can never silently offset genuine arrears.
    const s = payablesSummary([inv], [payment(11000)], [credit()])
    expect(s.overReconciled).toBe(-550)
    expect(s.remaining).toBe(0)
  })

  it('over-reconciliation is never created automatically — no refund, no payment', () => {
    const inv = clean()
    const rows = supplierInvoiceReconciliationRows([inv], [payment(11000)], [credit()])
    // The credit produced no payment document and no refund: cash out is
    // whatever was actually paid, unchanged by the credit.
    expect(cashOutRows([payment(11000)], { projectId: 'p1' })[0].amount).toBe(11000)
    expect(rows).toHaveLength(1)
  })
})

describe('SAFETY: retained invoices remain uncreditable, even after release', () => {
  // ⚠️ ACCEPTED ADR-31 BOUNDARY — DO NOT RELAX TO MAKE A CHANGE PASS.
  // Crediting a retained invoice is ambiguous (does the credit reduce the
  // payable slice or the retained slice?). ADR-30 does NOT resolve that
  // ambiguity, so releasing retention must never become a back door into
  // crediting a retained invoice. The gate reads the STORED, IMMUTABLE
  // `retentionTotal`, never a release-aware figure.
  it('a credit against a retained invoice contributes ZERO', () => {
    const inv = retained()
    const [row] = supplierInvoiceReconciliationRows([inv], [], [credit()])
    expect(row.credited).toBe(0)
    expect(row.remaining).toBe(9900)      // unreduced
  })

  it('still ZERO when the retention has been FULLY released', () => {
    const inv = retained()
    const map = releasedByInvoiceId([release({ prev: 0, amount: 1000 })])
    expect(map.si1).toBe(1100)            // the whole withholding released
    const [row] = supplierInvoiceReconciliationRows([inv], [], [credit()], map)
    expect(row.retentionHeld).toBe(0)     // nothing held any more...
    expect(row.payableTotal).toBe(11000)  // ...and the basis rose accordingly
    expect(row.credited).toBe(0)          // ...but the credit STILL counts zero
    expect(row.remaining).toBe(11000)
  })

  it('the release does not silently rewrite the invoice retention fields', () => {
    const inv = retained()
    const before = JSON.stringify(inv)
    supplierInvoiceReconciliationRows([inv], [payment(9900)], [], { si1: 1100 })
    expect(JSON.stringify(inv)).toBe(before)          // input purity
    expect(inv.retentionTotal).toBe(1100)             // immutable for life
  })
})

describe('REGRESSION GUARD: empty adjustments reproduce previous behaviour exactly', () => {
  it('an invoice with neither release nor credit is byte-identical to pre-ADR-30/31', () => {
    const inv = retained()
    const pays = [payment(4900)]
    expect(payableBasis(inv)).toBe(inv.payableTotal)
    expect(remainingPayable(inv, 4900)).toBe(inv.payableTotal - 4900)
    // Every arity produces the same rows: defaults must not change any figure.
    const twoArg   = supplierInvoiceReconciliationRows([inv], pays)
    expect(supplierInvoiceReconciliationRows([inv], pays, [])).toEqual(twoArg)
    expect(supplierInvoiceReconciliationRows([inv], pays, [], {})).toEqual(twoArg)
    expect(payablesSummary([inv], pays, [], {})).toEqual(payablesSummary([inv], pays))
    expect(apAgeing([inv], pays, [], {})).toEqual(apAgeing([inv], pays))
  })

  it('one feature being unused never suppresses the other', () => {
    const inv = clean()
    const pays = [payment(1000)]
    // Credits only, no releases.
    const [creditsOnly] = supplierInvoiceReconciliationRows([inv], pays, [credit()], {})
    expect(creditsOnly.credited).toBe(550)
    expect(creditsOnly.releasedTotal).toBe(0)
    // Releases only, no credits.
    const [releasesOnly] = supplierInvoiceReconciliationRows([inv], pays, [], { si1: 440 })
    expect(releasesOnly.credited).toBe(0)
    expect(releasesOnly.releasedTotal).toBe(440)
  })
})
