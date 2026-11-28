import { describe, it, expect } from 'vitest'
import {
  supplierInvoiceFigures, emptySupplierLedger, allocateSupplierCredit, allocateSupplierRelease,
  applySupplierCredit, applySupplierCreditVoid, applySupplierRelease, applySupplierPayment, applySupplierPaymentVoid,
  supplierLedgerProblem, supplierLedgerPosition, paymentAllocationProblem, releaseVoidProblem,
  supplierLedgersFromHistory, storedSupplierLedgerProblem, readSupplierLedger, supplierLedgerDocument,
} from '../../src/lib/supplierLedger'

// ── Independent oracle (integer cents; shares no code with the module) ───────
// share(total, part, whole) = round-half-up(total × part / whole), BigInt.
const share = (t, p, w) => (w <= 0 || p <= 0 || t <= 0 ? 0 : Number((2n * BigInt(t) * BigInt(p) + BigInt(w)) / (2n * BigInt(w))))
const c = (cents) => cents / 100

// An invoice from whole-cent figures: lines [costCodeId, taxCode, amountCents, gstCents].
function invoice({ id = 'inv1', lines, retentionCents = 0, retentionGstCents = 0 }) {
  const S = lines.reduce((s, l) => s + l[2], 0)
  const G = lines.reduce((s, l) => s + l[3], 0)
  return {
    id, invoiceNumber: 'SI-0001', status: 'posted', currency: 'AUD',
    lineItems: lines.map(([cc, tax, a, g]) => ({ poLineIndex: 0, costCodeId: cc, costCodeName: cc.toUpperCase(), description: '', amount: c(a), taxCode: tax, gstAmount: c(g) })),
    subtotal: c(S), gstTotal: c(G), grossTotal: c(S + G),
    retention: c(retentionCents), retentionGst: c(retentionGstCents), retentionTotal: c(retentionCents + retentionGstCents),
    payableTotal: c(S + G - retentionCents - retentionGstCents),
  }
}
const creditDoc = (alloc, id) => ({
  id, subtotal: c(alloc.subtotalCents), gstTotal: c(alloc.gstCents), retentionAmount: c(alloc.retentionCents), retentionGst: c(alloc.retentionGstCents),
  lineItems: alloc.lines.map(l => ({ costCodeId: l.costCodeId, taxCode: l.taxCode, amount: c(l.amountCents), gstAmount: c(l.gstCents) })),
})

describe('supplier invoice figures', () => {
  it('groups lines by cost code and tax code and refuses an invoice that does not reconcile with itself', () => {
    const inv = invoice({ lines: [['a', 'gst', 10000, 1000], ['a', 'gst', 5000, 500], ['a', 'gst_free', 2000, 0], ['b', 'gst', 4015, 402]] })
    const f = supplierInvoiceFigures(inv)
    expect(f.order).toEqual(['a|gst', 'a|gst_free', 'b|gst'])
    expect(f.groups['a|gst']).toMatchObject({ amountCents: 15000, gstCents: 1500 })
    expect(f.P).toBe(21015 + 1902)
    expect(supplierInvoiceFigures({ ...inv, subtotal: 999 }).problem).toMatch(/do not reconcile to its own lines/)
    expect(supplierInvoiceFigures({ ...inv, payableTotal: 1 }).problem).toMatch(/payable total/)
    expect(supplierInvoiceFigures({ ...inv, lineItems: [{ ...inv.lineItems[0], costCodeId: '' }] }).problem).toMatch(/no cost code/)
  })
})

describe('credits — group GST as a share of the stored GST; retention part on a retained invoice (G1)', () => {
  it('partial credits never apply a rate: their GST telescopes to the group’s stored GST exactly', () => {
    // A group whose stored GST (100.03) is not 10% of its amount — whatever produced it, a full credit reverses it.
    const inv = invoice({ lines: [['a', 'gst', 100000, 10003]] })
    const f = supplierInvoiceFigures(inv)
    let L = emptySupplierLedger()
    const parts = [33333, 33333, 33334]
    let credited = 0
    let gstSum = 0
    for (const [i, p] of parts.entries()) {
      const alloc = allocateSupplierCredit(f, L, [{ costCodeId: 'a', taxCode: 'gst', amount: c(p) }])
      credited += p
      const expected = (credited >= 100000 ? 10003 : share(10003, credited, 100000)) - gstSum
      expect(alloc.gstCents, `step ${i}`).toBe(expected)
      gstSum += alloc.gstCents
      L = applySupplierCredit(L, creditDoc(alloc, `c${i}`))
      expect(supplierLedgerProblem(f, L)).toBeNull()
    }
    expect(gstSum).toBe(10003)
    expect(allocateSupplierCredit(f, L, [{ costCodeId: 'a', taxCode: 'gst', amount: 0.01 }]).error).toMatch(/only 0.00 of 1000.00 remains/)
  })

  it('refuses a cost code / tax code the invoice does not carry, a duplicate group, a fraction of a cent and a non-positive amount', () => {
    const f = supplierInvoiceFigures(invoice({ lines: [['a', 'gst', 1000, 100]] }))
    const L = emptySupplierLedger()
    expect(allocateSupplierCredit(f, L, [{ costCodeId: 'b', taxCode: 'gst', amount: 1 }]).error).toMatch(/carries no gst amount/)
    expect(allocateSupplierCredit(f, L, [{ costCodeId: 'a', taxCode: 'gst_free', amount: 1 }]).error).toMatch(/carries no/)
    expect(allocateSupplierCredit(f, L, [{ costCodeId: 'a', taxCode: 'gst', amount: 1 }, { costCodeId: 'a', taxCode: 'gst', amount: 1 }]).error).toMatch(/twice/)
    expect(allocateSupplierCredit(f, L, [{ costCodeId: 'a', taxCode: 'gst', amount: 1.005 }]).error).toMatch(/whole number of cents/)
    expect(allocateSupplierCredit(f, L, [{ costCodeId: 'a', taxCode: 'gst', amount: 0 }]).error).toMatch(/greater than zero/)
    expect(allocateSupplierCredit(f, L, []).error).toMatch(/at least one line/)
  })

  it('a credit on a RETAINED invoice takes the retained share of what it credits; the payable basis falls only by the rest; a full credit clears retention', () => {
    // S 10,000.00 G 1,000.00; retention 500.00 + GST 50.00; payable 10,450.00.
    const inv = invoice({ lines: [['a', 'gst', 1000000, 100000]], retentionCents: 50000, retentionGstCents: 5000 })
    const f = supplierInvoiceFigures(inv)
    let L = emptySupplierLedger()
    const a1 = allocateSupplierCredit(f, L, [{ costCodeId: 'a', taxCode: 'gst', amount: 2000 }])
    // Oracle: retention part = share(held 50,000, 200,000, still billed 1,000,000) = 10,000; its GST = share(5,000, 10,000, 50,000) = 1,000.
    expect(a1).toMatchObject({ subtotalCents: 200000, gstCents: 20000, retentionCents: 10000, retentionGstCents: 1000 })
    L = applySupplierCredit(L, creditDoc(a1, 'c1'))
    const pos = supplierLedgerPosition(f, L)
    expect(pos.retentionHeldExCents).toBe(40000)
    expect(pos.retentionHeldGstCents).toBe(4000)
    // basis = 1,045,000 − (220,000 − 11,000) = 836,000
    expect(pos.payableBasisCents).toBe(836000)
    // The rest, in full: all retention still held goes with it.
    const a2 = allocateSupplierCredit(f, L, [{ costCodeId: 'a', taxCode: 'gst', amount: 8000 }])
    expect(a2).toMatchObject({ subtotalCents: 800000, gstCents: 80000, retentionCents: 40000, retentionGstCents: 4000 })
    L = applySupplierCredit(L, creditDoc(a2, 'c2'))
    expect(supplierLedgerPosition(f, L)).toMatchObject({ retentionHeldExCents: 0, retentionHeldGstCents: 0, payableBasisCents: 0 })
    expect(supplierLedgerProblem(f, L)).toBeNull()
  })

  it('a tiny credit on a retained invoice never raises what is payable (the retained part is rounded down, never above the credit)', () => {
    const inv = invoice({ lines: [['a', 'gst', 100, 10]], retentionCents: 55, retentionGstCents: 6 })
    const f = supplierInvoiceFigures(inv)
    const a = allocateSupplierCredit(f, emptySupplierLedger(), [{ costCodeId: 'a', taxCode: 'gst', amount: 0.01 }])
    expect(a.retentionCents + a.retentionGstCents).toBeLessThanOrEqual(a.subtotalCents + a.gstCents)
  })

  it('voiding a credit reverses exactly what it stored; voiding more than was credited is an inconsistent state', () => {
    const f = supplierInvoiceFigures(invoice({ lines: [['a', 'gst', 1000, 100]] }))
    const a = allocateSupplierCredit(f, emptySupplierLedger(), [{ costCodeId: 'a', taxCode: 'gst', amount: 5 }])
    const L1 = applySupplierCredit(emptySupplierLedger(), creditDoc(a, 'c1'))
    const L0 = applySupplierCreditVoid(L1, creditDoc(a, 'c1'))
    expect(supplierLedgerProblem(f, L0)).toBeNull()
    expect(L0).toMatchObject({ creditedSubtotalCents: 0, creditedGstCents: 0, seq: 2, lastEntryKind: 'credit_void' })
    expect(supplierLedgerProblem(f, applySupplierCreditVoid(L0, creditDoc(a, 'c1')))).toMatch(/whole, non-negative/)
  })
})

describe('releases — GST as a share of the STORED retention GST (ADR-91 Decision 4)', () => {
  it('any split of the retention reconciles exactly to the stored retention GST — including a stored figure one cent below 10%', () => {
    // Retention 40.15 with the legacy stored GST 4.01 (not 4.02).
    const f = supplierInvoiceFigures(invoice({ lines: [['a', 'gst', 100000, 10000]], retentionCents: 4015, retentionGstCents: 401 }))
    let L = emptySupplierLedger()
    let gst = 0
    let released = 0
    for (const [i, part] of [1000, 1001, 2014].entries()) {
      const r = allocateSupplierRelease(f, L, c(part))
      released += part
      expect(r.gstCents).toBe((released >= 4015 ? 401 : share(401, released, 4015)) - gst)
      gst += r.gstCents
      L = applySupplierRelease(L, { id: `r${i}`, amount: c(r.amountCents), gstAmount: c(r.gstCents) })
    }
    expect(gst).toBe(401)
    expect(allocateSupplierRelease(f, L, 0.01).error).toMatch(/Only 0.00/)
  })

  it('a release and the retention part of a credit draw on ONE pool', () => {
    const f = supplierInvoiceFigures(invoice({ lines: [['a', 'gst', 1000000, 100000]], retentionCents: 50000, retentionGstCents: 5000 }))
    const a1 = allocateSupplierCredit(f, emptySupplierLedger(), [{ costCodeId: 'a', taxCode: 'gst', amount: 2000 }])
    const L = applySupplierCredit(emptySupplierLedger(), creditDoc(a1, 'c1'))
    expect(allocateSupplierRelease(f, L, 400.01).error).toMatch(/Only 400.00/)
    const r = allocateSupplierRelease(f, L, 400)
    expect(r).toEqual({ amountCents: 40000, gstCents: 4000 })
  })
})

describe('payments — the remaining-payable cap (Deferred Control 18) and dependency-safe voids (G3)', () => {
  const inv = invoice({ lines: [['a', 'gst', 1000000, 100000]], retentionCents: 50000, retentionGstCents: 5000 })
  const f = supplierInvoiceFigures(inv)

  it('an allocation must fit within the payable basis less what is paid; retention held is not payable until released', () => {
    let L = emptySupplierLedger()
    expect(paymentAllocationProblem(f, L, 1045001, 'SI-0001')).toMatch(/Only 10450.00 remains payable on SI-0001/)
    expect(paymentAllocationProblem(f, L, 1045000)).toBeNull()
    L = applySupplierPayment(L, 1045000, 'p1')
    expect(paymentAllocationProblem(f, L, 1)).toMatch(/Only 0.00/)
    // A release raises the basis by its gross.
    const r = allocateSupplierRelease(f, L, 100)
    L = applySupplierRelease(L, { id: 'r1', amount: c(r.amountCents), gstAmount: c(r.gstCents) })
    expect(paymentAllocationProblem(f, L, 11000)).toBeNull()
    expect(paymentAllocationProblem(f, L, 11001)).toMatch(/Only 110.00/)
  })

  it('a release that payments depend on cannot be voided; once the payment is voided it can', () => {
    let L = applySupplierPayment(emptySupplierLedger(), 1045000, 'p1')
    const r = allocateSupplierRelease(f, L, 100)
    const release = { id: 'r1', amount: c(r.amountCents), gstAmount: c(r.gstCents) }
    L = applySupplierRelease(L, release)
    L = applySupplierPayment(L, 11000, 'p2')
    expect(releaseVoidProblem(f, L, release, 'SI-0001')).toMatch(/Payments on SI-0001 depend on this release/)
    L = applySupplierPaymentVoid(L, 11000, 'p2')
    expect(releaseVoidProblem(f, L, release)).toBeNull()
  })

  it('a credit after payment is accepted (money recoverable from the supplier) and blocks further allocation', () => {
    const plain = supplierInvoiceFigures(invoice({ lines: [['a', 'gst', 10000, 1000]] }))
    let L = applySupplierPayment(emptySupplierLedger(), 11000, 'p1')
    const a = allocateSupplierCredit(plain, L, [{ costCodeId: 'a', taxCode: 'gst', amount: 10 }])
    L = applySupplierCredit(L, creditDoc(a, 'c1'))
    expect(supplierLedgerProblem(plain, L)).toBeNull()
    expect(supplierLedgerPosition(plain, L).remainingPayableCents).toBe(-1100)
    expect(paymentAllocationProblem(plain, L, 1)).toMatch(/Only 0.00/)
  })
})

describe('the historical baseline', () => {
  const inv = invoice({ id: 'i1', lines: [['a', 'gst', 1000000, 100000]], retentionCents: 50000, retentionGstCents: 5000 })
  const plain = invoice({ id: 'i2', lines: [['a', 'gst', 10000, 1000], ['b', 'gst_free', 5000, 0]] })

  it('sums every POSTED payment allocation, credit and release per invoice at their STORED figures; drafts and voids moved nothing', () => {
    const { ledgers, problem } = supplierLedgersFromHistory({
      invoices: { i1: inv, i2: plain },
      payments: [
        { id: 'p1', paymentNumber: 'SP-0001', status: 'posted', allocations: [{ supplierInvoiceId: 'i1', allocatedAmount: 5000 }, { supplierInvoiceId: 'i2', allocatedAmount: 100 }] },
        { id: 'p2', status: 'void', allocations: [{ supplierInvoiceId: 'i1', allocatedAmount: 999 }] },
        { id: 'p3', status: 'draft', allocations: [{ supplierInvoiceId: 'i1', allocatedAmount: 999 }] },
      ],
      creditNotes: [{ id: 'c1', creditNumber: 'SCN-0001', status: 'posted', supplierInvoiceId: 'i2', subtotal: 50, gstTotal: 5, lineItems: [{ costCodeId: 'a', taxCode: 'gst', amount: 50, gstAmount: 5 }] }],
      releases: [{ id: 'r1', releaseNumber: 'RR-0001', status: 'posted', supplierInvoiceId: 'i1', amount: 100.05, gstAmount: 10 }],
    })
    expect(problem).toBeUndefined()
    expect(ledgers.get('i1')).toMatchObject({ state: 'established', sources: { payments: 1, credits: 0, releases: 1 } })
    expect(ledgers.get('i1').ledger).toMatchObject({ paidCents: 500000, releasedRetentionCents: 10005, releasedRetentionGstCents: 1000, seq: 0 })
    expect(ledgers.get('i2').ledger).toMatchObject({ paidCents: 10000, creditedSubtotalCents: 5000, creditedGstCents: 500, groups: { 'a|gst': { amountCents: 5000, gstCents: 500 } } })
  })

  it('an unattributable posted payment refuses the whole baseline, naming it — never skipped', () => {
    for (const allocations of ['x', [{ supplierInvoiceId: '', allocatedAmount: 1 }], [{ supplierInvoiceId: 'i1', allocatedAmount: 1.005 }], [{ supplierInvoiceId: 'i1', allocatedAmount: -1 }], [{ supplierInvoiceId: 'i1', allocatedAmount: '5' }]]) {
      expect(supplierLedgersFromHistory({ invoices: { i1: inv }, payments: [{ id: 'p9', paymentNumber: 'SP-0009', status: 'posted', allocations }] }).problem, JSON.stringify(allocations)).toMatch(/SP-0009/)
    }
  })

  it('an over-release, an over-credit, a credit on a cost code the invoice does not carry, or a missing invoice make THAT invoice’s ledger inconsistent — others are unaffected; nothing is clamped', () => {
    const { ledgers } = supplierLedgersFromHistory({
      invoices: { i1: inv, i2: plain },
      releases: [
        { id: 'r1', status: 'posted', supplierInvoiceId: 'i1', amount: 300, gstAmount: 30 },
        { id: 'r2', status: 'posted', supplierInvoiceId: 'i1', amount: 300, gstAmount: 30 },  // concurrent over-release (DC24)
      ],
      creditNotes: [
        { id: 'c1', status: 'posted', supplierInvoiceId: 'i2', subtotal: 10, gstTotal: 1, lineItems: [{ costCodeId: 'zz', taxCode: 'gst', amount: 10, gstAmount: 1 }] },
        { id: 'c2', status: 'posted', supplierInvoiceId: 'gone', subtotal: 1, gstTotal: 0, lineItems: [] },
      ],
    })
    expect(ledgers.get('i1')).toMatchObject({ state: 'inconsistent' })
    expect(ledgers.get('i1').problem).toMatch(/exceed the retention withheld/)
    expect(ledgers.get('i1').ledger.releasedRetentionCents).toBe(60000)
    expect(ledgers.get('i2').problem).toMatch(/does not carry/)
    expect(ledgers.get('gone').problem).toMatch(/does not exist/)
  })

  it('an overpaid invoice is a representable historical state, not an inconsistency', () => {
    const { ledgers } = supplierLedgersFromHistory({ invoices: { i2: plain }, payments: [{ id: 'p', status: 'posted', allocations: [{ supplierInvoiceId: 'i2', allocatedAmount: 200 }] }] })
    expect(ledgers.get('i2').state).toBe('established')
  })

  it('stored ledgers: a malformed figure is refused, never read as zero; the document round-trips', () => {
    expect(storedSupplierLedgerProblem({ paidCents: -1 })).toMatch(/paidCents/)
    expect(storedSupplierLedgerProblem({ groups: { x: { amountCents: 1.5, gstCents: 0 } } })).toMatch(/groups.x/)
    const L = applySupplierPayment(emptySupplierLedger(), 5, 'p')
    expect(readSupplierLedger(supplierLedgerDocument(L))).toMatchObject({ paidCents: 5, seq: 1 })
  })
})

// ── Final-batch corrections (ADR-94): corrective voids, malformed entries,
// cumulative allocations ──────────────────────────────────────────────────────
import { supplierLedgerExcess, correctiveVoidProblem, releaseVoidDependency, applySupplierReleaseVoid } from '../../src/lib/supplierLedger'
import { paymentPosting, paymentVoiding, releaseVoiding, creditVoiding } from '../../src/lib/supplierSettlementProcessing'

describe('corrective voids — an inconsistent ledger may only move towards consistency', () => {
  // S 1,000.00 G 100.00, retention 100.00 + 10.00, payable 990.00.
  const inv = invoice({ lines: [['cc1', 'gst', 100000, 10000]], retentionCents: 10000, retentionGstCents: 1000 })
  const figures = supplierInvoiceFigures(inv)
  const rel = (id, cents, gst) => ({ id, amount: c(cents), gstAmount: c(gst) })

  it('the excess measures are zero on a sound ledger and count each breach in cents', () => {
    expect(Object.values(supplierLedgerExcess(figures, emptySupplierLedger())).every(v => v === 0)).toBe(true)
    let L = applySupplierRelease(applySupplierRelease(emptySupplierLedger(), rel('a', 7000, 700)), rel('b', 7000, 700))
    // ORACLE: released 140.00 of 100.00 → 40.00 over; GST 14.00 of 10.00 → 4.00 over.
    expect(supplierLedgerExcess(figures, L)).toMatchObject({ retention: 4000, retentionGst: 400, overpaid: 0 })
    L = applySupplierPayment(L, 120000, 'p')
    // ORACLE: basis 990.00 + 154.00 = 1,144.00; paid 1,200.00 → 56.00 over.
    expect(supplierLedgerExcess(figures, L).overpaid).toBe(5600)
  })

  it('a void that narrows a breach is corrective; one that widens a breach, or leaves a negative figure, is not', () => {
    const over = applySupplierRelease(applySupplierRelease(emptySupplierLedger(), rel('a', 7000, 700)), rel('b', 7000, 700))
    expect(correctiveVoidProblem(figures, over, applySupplierReleaseVoid(over, rel('b', 7000, 700)))).toBeNull()
    // Voiding something larger than what is recorded would go negative.
    expect(correctiveVoidProblem(figures, over, applySupplierReleaseVoid(over, rel('x', 20000, 2000)))).toMatch(/negative/)
    // A paid-out release: voiding it widens the over-payment — refused as a dependency by releaseVoiding.
    const paid = applySupplierPayment(over, 114400, 'p')
    expect(releaseVoidDependency(figures, paid, rel('b', 7000, 700), 'SI-0001')).toMatch(/depend on this release/)
    expect(releaseVoiding({ live: rel('b', 7000, 700), invoice: inv, ledgerEntry: { state: 'inconsistent', ledger: paid } }).problem).toBe('dependency')
    expect(correctiveVoidProblem(figures, paid, applySupplierReleaseVoid(paid, rel('b', 7000, 700)))).toMatch(/overpaid/)
  })

  it('on an ESTABLISHED ledger a void that breaks an invariant is refused; a credit void on an inconsistent ledger must not leave a negative group', () => {
    const one = applySupplierRelease(emptySupplierLedger(), rel('a', 5000, 500))
    expect(releaseVoiding({ live: rel('a', 5000, 500), invoice: inv, ledgerEntry: { state: 'established', ledger: one } }).ledger.releasedRetentionCents).toBe(0)
    const alloc = allocateSupplierCredit(figures, emptySupplierLedger(), [{ costCodeId: 'cc1', taxCode: 'gst', amount: 200 }])
    const credited = applySupplierCredit(emptySupplierLedger(), creditDoc(alloc, 'cn1'))
    // A credit that was never applied to this ledger cannot be voided out of it, in either state.
    const foreign = creditDoc(allocateSupplierCredit(figures, emptySupplierLedger(), [{ costCodeId: 'cc1', taxCode: 'gst', amount: 500 }]), 'cn2')
    expect(creditVoiding({ live: foreign, invoice: inv, ledgerEntry: { state: 'established', ledger: credited } }).problem).toBe('dependency')
    expect(creditVoiding({ live: foreign, invoice: inv, ledgerEntry: { state: 'inconsistent', ledger: credited } }).problem).toBe('dependency')
    expect(creditVoiding({ live: creditDoc(alloc, 'cn1'), invoice: inv, ledgerEntry: { state: 'established', ledger: credited } }).ledger.creditedSubtotalCents).toBe(0)
  })

  it('the baseline names malformed posted entries, so the ledger cannot be restored while one is still posted', () => {
    const { ledgers } = supplierLedgersFromHistory({
      invoices: { inv1: inv },
      releases: [{ id: 'ok', status: 'posted', supplierInvoiceId: 'inv1', amount: 10, gstAmount: 1 }, { id: 'bad', status: 'posted', supplierInvoiceId: 'inv1', amount: 0, gstAmount: 0 }],
    })
    expect(ledgers.get('inv1')).toMatchObject({ state: 'inconsistent', malformedEntryIds: ['bad'], malformedOverflow: false })
    const clean = supplierLedgersFromHistory({ invoices: { inv1: inv }, releases: [{ id: 'ok', status: 'posted', supplierInvoiceId: 'inv1', amount: 10, gstAmount: 1 }] })
    expect(clean.ledgers.get('inv1')).toMatchObject({ state: 'established', malformedEntryIds: [] })
  })
})

describe('payments — allocations naming one invoice more than once are cumulative', () => {
  const inv = { ...invoice({ lines: [['cc1', 'gst', 100000, 10000]] }), supplierId: 's1', supplierName: 'S' } // payable 1,100.00
  const entry = () => ({ state: 'established', ledger: emptySupplierLedger() })
  const pay = (allocations) => ({
    id: 'p1', supplierId: 's1', supplierName: 'S', paymentDate: '2026-11-28',
    amount: allocations.reduce((s, a) => s + a, 0), allocatedTotal: allocations.reduce((s, a) => s + a, 0), unallocatedAmount: 0,
    allocations: allocations.map(a => ({ supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', allocatedAmount: a })),
  })
  const nowMillis = Date.parse('2026-11-28T00:00:00Z')

  it('600 + 600 against 1,100.00 payable is refused — each allocation alone would have fitted', () => {
    const out = paymentPosting({ live: pay([600, 600]), invoices: new Map([['inv1', inv]]), ledgers: new Map([['inv1', entry()]]), nowMillis })
    expect(out.problem).toBe('cap-exceeded')
  })

  it('600 + 500 posts 1,100.00 in total; its void takes 1,100.00 back', () => {
    const posted = paymentPosting({ live: pay([600, 500]), invoices: new Map([['inv1', inv]]), ledgers: new Map([['inv1', entry()]]), nowMillis })
    expect(posted.ledgers.get('inv1').paidCents).toBe(110000)
    const voided = paymentVoiding({ live: pay([600, 500]), ledgers: new Map([['inv1', { state: 'established', ledger: posted.ledgers.get('inv1') }]]) })
    expect(voided.ledgers.get('inv1').paidCents).toBe(0)
  })
})
