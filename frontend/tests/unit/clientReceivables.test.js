import { describe, it, expect } from 'vitest'
import {
  receivablePositions, receivableTotals, receivableContext, clientRetentionRows, ledgerExceptions,
} from '../../src/lib/clientReceivables'
import {
  receivableBasis, remainingToReconcile, receivedByInvoice,
  clientInvoiceReconciliationRows, receivablesSummary, arAgeing,
  allocatableInvoices, invoiceOverAllocationWarnings, invoiceReconciliation,
} from '../../src/lib/clientReceipts'
import {
  gstForLine, invoiceTotals, contractControl, invoicedByVariation, ageingByDueDate,
  variationInvoicingRows,
} from '../../src/lib/clientInvoices'
import { buildClientCreditNote } from '../../src/lib/clientCreditNotes'
import { buildClientRetentionRelease } from '../../src/lib/clientRetention'
import { emptyLedger, applyCredit, applyRelease, ledgerDocument } from '../../src/lib/clientLedger'

// ── The ONE receivable contract (ADR-87 / ADR-88) — pure domain tests ────────
//
// The load-bearing properties:
//   1. THE FIGURES DO NOT BLUR. grossTotal is never reduced; credited,
//      retention held, released and the receivable basis are each stated, and
//      receivableBasis = grossTotal − credited − retentionHeld exactly.
//   2. BACKWARD COMPATIBLE. With no retention, no credit notes and no releases,
//      every reconciliation figure is the pre-ADR-87 one, with or without the
//      positions map.
//   3. NEVER CLAMPED. A credit after the money was received leaves a NEGATIVE
//      remaining, reported as owed to the client.
//   4. A CREDIT IS AN INVOICE CORRECTION. Issued falls and Available to Invoice
//      rises by the credited ex-GST amount; the Current Contract Sum is untouched.

// ── Fixtures ─────────────────────────────────────────────────────────────────

const line = (amount, taxCode = 'gst', over = {}) => ({
  description: 'Work', amount, taxCode, gstAmount: gstForLine(amount, taxCode),
  variationId: null, variationNumber: '', costCodeId: null, costCodeName: null, ...over,
})

function invoice(id, lines, retention = 0, over = {}) {
  return {
    id, invoiceNumber: `CI-${id}`, status: 'issued',
    clientId: 'client1', clientName: 'Acme Developments', currency: 'AUD',
    invoiceDate: '2026-10-01', dueDate: '2026-10-31',
    lineItems: lines, ...invoiceTotals(lines, retention), ...over,
  }
}

// An invoice exactly as stored before ADR-88: no retention fields at all.
function legacyInvoice(id, lines, over = {}) {
  const inv = invoice(id, lines, 0, over)
  delete inv.retention
  delete inv.retentionGst
  delete inv.retentionTotal
  delete inv.receivableTotal
  return inv
}

const receipt = (id, allocations, over = {}) => {
  const allocated = allocations.reduce((sum, [, amount]) => sum + amount, 0)
  return {
    id, receiptNumber: `CR-${id}`, status: 'posted', clientId: 'client1', clientName: 'Acme Developments',
    receiptDate: '2026-11-10', amount: allocated, allocatedTotal: allocated, unallocatedAmount: 0,
    allocations: allocations.map(([clientInvoiceId, allocatedAmount]) => ({
      clientInvoiceId, invoiceNumber: `CI-${clientInvoiceId}`, allocatedAmount,
    })),
    ...over,
  }
}

// Posts entries one after another against a running ledger, as the app does.
function post(inv) {
  let ledger = emptyLedger()
  let n = 0
  const creditNotes = []
  const releases = []
  return {
    creditNotes, releases,
    get ledgerDoc() { return { id: inv.id, ...ledgerDocument(ledger) } },
    credit(rows, over = {}) {
      const built = buildClientCreditNote(inv, ledger, rows)
      if (built.error) throw new Error(built.error)
      n += 1
      const cn = {
        id: `${inv.id}-cn${n}`, creditNumber: `CCN-000${n}`, status: 'posted',
        clientInvoiceId: inv.id, invoiceNumber: inv.invoiceNumber,
        clientId: inv.clientId, currency: inv.currency,
        lineItems: built.lineItems, ...built.totals, ledgerSeq: built.ledgerSeq, ...over,
      }
      if (cn.status === 'posted') ledger = applyCredit(ledger, cn)
      creditNotes.push(cn)
      return cn
    },
    release(amount, over = {}) {
      const built = buildClientRetentionRelease(inv, ledger, amount)
      if (built.error) throw new Error(built.error)
      n += 1
      const r = {
        id: `${inv.id}-rr${n}`, releaseNumber: `CRR-000${n}`, status: 'posted',
        clientInvoiceId: inv.id, invoiceNumber: inv.invoiceNumber, ...built, ...over,
      }
      if (r.status === 'posted') ledger = applyRelease(ledger, r)
      releases.push(r)
      return r
    },
  }
}

// ── The contract, figure by figure ───────────────────────────────────────────

describe('one invoice with retention, a partial credit, a partial release and receipts', () => {
  // INVOICE   subtotal 1000.00 + GST 100.00 = gross 1100.00
  //           retention 100.00 + GST 10.00  = withheld 110.00 → receivable 990.00
  // CREDIT    200.00 + GST 20.00 = 220.00, of which retention 20.00 + 2.00 = 22.00
  // RELEASE   40.00 + GST 4.00 = 44.00
  // RECEIPTS  300.00 + 200.00 = 500.00
  //
  //   retention held  = 110.00 − 44.00 released − 22.00 credited  =  44.00
  //   receivable basis = 1100.00 − 220.00 − 44.00                 = 836.00
  //   remaining        = 836.00 − 500.00                          = 336.00
  const inv = invoice('A', [line(1000)], 100)
  const p = post(inv)
  const cn = p.credit([{ invoiceLineIndex: 0, amount: 200 }])
  const rel = p.release(40)
  const receipts = [
    receipt('r1', [['A', 300]]),
    receipt('r2', [['A', 200]]),
    receipt('r3', [['A', 999]], { status: 'draft' }),
    receipt('r4', [['A', 999]], { status: 'void' }),
  ]
  const positions = receivablePositions([inv], p.creditNotes, p.releases)

  it('the entries carry the hand-computed figures', () => {
    expect(inv).toMatchObject({
      subtotal: 1000, gstTotal: 100, grossTotal: 1100,
      retention: 100, retentionGst: 10, retentionTotal: 110, receivableTotal: 990,
    })
    expect(cn).toMatchObject({
      subtotal: 200, gstTotal: 20, grossTotal: 220,
      retentionAmount: 20, retentionGst: 2, retentionTotal: 22, receivableTotal: 198,
    })
    expect(rel).toMatchObject({ amount: 40, gstAmount: 4, releaseTotal: 44 })
  })

  it('receivablePositions states EVERY figure', () => {
    expect(positions).toEqual({
      A: {
        subtotal: 1000,
        grossTotal: 1100,
        creditedSubtotal: 200,
        creditedGst: 20,
        credited: 220,
        netIssuedSubtotal: 800,
        netIssuedGross: 880,
        retentionTotal: 110,
        releasedTotal: 44,
        creditedRetention: 22,
        retentionHeld: 44,
        retentionHeldExGst: 40,
        receivableBasis: 836,
      },
    })
  })

  it('the figures add up: basis = gross − credited − held; withheld = held + released + credited-retention', () => {
    const a = positions.A
    expect(a.grossTotal - a.credited - a.retentionHeld).toBe(a.receivableBasis)
    expect(a.retentionHeld + a.releasedTotal + a.creditedRetention).toBe(a.retentionTotal)
    expect(a.subtotal - a.creditedSubtotal).toBe(a.netIssuedSubtotal)
  })

  it('the reconciliation row states the same figures plus received and remaining', () => {
    expect(clientInvoiceReconciliationRows([inv], receipts, positions)).toEqual([{
      id: 'A', invoiceNumber: 'CI-A', clientId: 'client1', clientName: 'Acme Developments',
      invoiceDate: '2026-10-01', dueDate: '2026-10-31',
      grossTotal: 1100,
      credited: 220,
      retentionTotal: 110,
      releasedTotal: 44,
      retentionHeld: 44,
      receivableBasis: 836,
      received: 500,
      remaining: 336,
      state: 'partly_reconciled',
    }])
  })

  it('receivableBasis / remainingToReconcile / invoiceReconciliation agree', () => {
    expect(receivedByInvoice(receipts)).toEqual({ A: 500 })
    expect(receivableBasis(inv, positions.A)).toBe(836)
    expect(remainingToReconcile(inv, 500, positions.A)).toBe(336)
    expect(invoiceReconciliation(inv, { A: 500 }, positions)).toEqual({
      total: 836, settled: 500, remaining: 336, state: 'partly_reconciled',
    })
    // Without a position the basis is the invoice's own receivable total.
    expect(receivableBasis(inv)).toBe(990)
    expect(receivableBasis(inv, null)).toBe(990)
    expect(remainingToReconcile(inv, 500)).toBe(490)
  })

  it('the project summary carries them through', () => {
    const s = receivablesSummary([inv], receipts, positions)
    expect(s).toMatchObject({
      issuedGross: 1100, received: 500, remaining: 336, overReconciled: 0,
      credited: 220, retentionHeld: 44, receivable: 836, owedToClient: 0,
    })
    expect(s.rows).toHaveLength(1)
    expect(Object.is(s.owedToClient, -0)).toBe(false)
  })

  it('receivableTotals and receivableContext sum the positions', () => {
    expect(receivableTotals(positions)).toEqual({
      creditedSubtotal: 200, creditedGst: 20, credited: 220,
      retentionTotal: 110, releasedTotal: 44, creditedRetention: 22, retentionHeld: 44,
    })
    const context = receivableContext([inv], p.creditNotes, p.releases)
    expect(context.positions).toEqual(positions)
    expect(context.totals).toEqual(receivableTotals(positions))
    expect(context.creditedByVariation).toEqual({})
    expect(receivableTotals({})).toEqual({
      creditedSubtotal: 0, creditedGst: 0, credited: 0,
      retentionTotal: 0, releasedTotal: 0, creditedRetention: 0, retentionHeld: 0,
    })
    expect(receivableTotals(null).credited).toBe(0)
  })

  it('ageing ages the remaining of the BASIS, not the gross or the un-released receivable', () => {
    const now = new Date(2026, 10, 26) // 26 days past the due date
    const aged = ageingByDueDate([inv], { A: 500 }, now, positions)
    expect(aged.total).toBe(336)
    expect(aged.buckets.d1_30).toEqual({ amount: 336, count: 1 })
    expect(aged.pastDue).toBe(336)
    expect(arAgeing([inv], receipts, now, positions).total).toBe(336)
    // Without positions: the invoice's own receivable total (990.00) less receipts.
    expect(ageingByDueDate([inv], { A: 500 }, now).total).toBe(490)
  })

  it('the allocation picker and the over-allocation warning use the basis', () => {
    expect(allocatableInvoices([inv], 'client1', receipts, { positions })).toEqual([{
      id: 'A', invoiceNumber: 'CI-A', invoiceDate: '2026-10-01', dueDate: '2026-10-31',
      grossTotal: 1100, receivableBasis: 836, received: 500, remaining: 336,
    }])
    expect(allocatableInvoices([inv], 'client2', receipts, { positions })).toEqual([])
    // Editing r2 excludes its own 200.00.
    expect(allocatableInvoices([inv], 'client1', receipts, { positions, excludeReceiptId: 'r2' })[0])
      .toMatchObject({ received: 300, remaining: 536 })

    const allocation = [{ clientInvoiceId: 'A', allocatedAmount: 400 }]
    const warnings = invoiceOverAllocationWarnings(allocation, [inv], receipts, { positions })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ clientInvoiceId: 'A', invoiceNumber: 'CI-A', excess: 64 })
    expect(warnings[0].message).toMatch(/CI-A would be reconciled beyond its remaining balance by 64\.00/)
    expect(invoiceOverAllocationWarnings([{ clientInvoiceId: 'A', allocatedAmount: 336 }], [inv], receipts, { positions }))
      .toEqual([])
    // Without positions 490.00 would still look allocatable — the map matters.
    expect(invoiceOverAllocationWarnings(allocation, [inv], receipts)).toEqual([])
  })

  it('the retention register row', () => {
    expect(clientRetentionRows([inv], positions)).toEqual([{
      id: 'A', invoiceNumber: 'CI-A', clientId: 'client1', clientName: 'Acme Developments', invoiceDate: '2026-10-01',
      retentionTotal: 110, releasedTotal: 44, creditedRetention: 22,
      retentionHeld: 44, retentionHeldExGst: 40, fullyResolved: false,
    }])
  })

  it('drafts and voids of either entry kind change nothing', () => {
    const p2 = post(inv)
    p2.credit([{ invoiceLineIndex: 0, amount: 200 }])
    p2.release(40)
    p2.credit([{ invoiceLineIndex: 0, amount: 50 }], { status: 'draft' })
    p2.credit([{ invoiceLineIndex: 0, amount: 60 }], { status: 'void' })
    p2.release(5, { status: 'draft' })
    p2.release(6, { status: 'void' })
    expect(receivablePositions([inv], p2.creditNotes, p2.releases)).toEqual(positions)
  })
})

describe('receivablePositions — scope', () => {
  it('covers issued invoices only', () => {
    const issued = invoice('A', [line(100)])
    const draft = invoice('B', [line(100)], 0, { status: 'draft' })
    const voided = invoice('C', [line(100)], 0, { status: 'void' })
    expect(Object.keys(receivablePositions([issued, draft, voided]))).toEqual(['A'])
    expect(receivablePositions([])).toEqual({})
    expect(receivablePositions(null)).toEqual({})
  })

  it('an untouched invoice with no retention has a basis equal to its gross', () => {
    const inv = invoice('A', [line(40.15), line(100, 'gst_free')])
    expect(receivablePositions([inv]).A).toEqual({
      subtotal: 140.15, grossTotal: 144.17,
      creditedSubtotal: 0, creditedGst: 0, credited: 0,
      netIssuedSubtotal: 140.15, netIssuedGross: 144.17,
      retentionTotal: 0, releasedTotal: 0, creditedRetention: 0,
      retentionHeld: 0, retentionHeldExGst: 0,
      receivableBasis: 144.17,
    })
  })

  it('keeps each invoice\'s entries to itself', () => {
    const a = invoice('A', [line(1000)], 100)
    const b = invoice('B', [line(500)], 50)
    const pa = post(a)
    const pb = post(b)
    pa.credit([{ invoiceLineIndex: 0, amount: 200 }])
    pb.release(50)
    const positions = receivablePositions([a, b], [...pa.creditNotes, ...pb.creditNotes], [...pa.releases, ...pb.releases])
    expect(positions.A).toMatchObject({ credited: 220, releasedTotal: 0, retentionHeld: 88, receivableBasis: 792 })
    expect(positions.B).toMatchObject({ credited: 0, releasedTotal: 55, retentionHeld: 0, receivableBasis: 550 })
    expect(receivableTotals(positions)).toEqual({
      creditedSubtotal: 200, creditedGst: 20, credited: 220,
      retentionTotal: 165, releasedTotal: 55, creditedRetention: 22, retentionHeld: 88,
    })
    // Only invoices that withheld retention appear in the register, oldest first.
    const c = invoice('C', [line(100)], 0)
    const rows = clientRetentionRows([b, c, a], receivablePositions([a, b, c], pa.creditNotes, pb.releases))
    expect(rows.map(r => [r.id, r.fullyResolved])).toEqual([['A', false], ['B', true]])
  })

  it('a FULL credit of a retained invoice leaves nothing held and nothing receivable', () => {
    const inv = invoice('A', [line(1000)], 100)
    const p = post(inv)
    p.release(40)
    p.credit([{ invoiceLineIndex: 0, amount: 1000 }])
    const a = receivablePositions([inv], p.creditNotes, p.releases).A
    expect(a).toMatchObject({
      grossTotal: 1100, credited: 1100, netIssuedSubtotal: 0, netIssuedGross: 0,
      retentionTotal: 110, releasedTotal: 44, creditedRetention: 66,
      retentionHeld: 0, retentionHeldExGst: 0, receivableBasis: 0,
    })
    const rows = clientInvoiceReconciliationRows([inv], [], { A: a })
    // Owes nothing and received nothing: fully reconciled, not "unreconciled".
    expect(rows[0]).toMatchObject({ receivableBasis: 0, received: 0, remaining: 0, state: 'fully_reconciled' })
    expect(clientRetentionRows([inv], { A: a })[0].fullyResolved).toBe(true)
  })
})

// ── Backward compatibility ───────────────────────────────────────────────────

describe('backward compatibility — no retention, no credit notes, no releases', () => {
  const invoices = [
    legacyInvoice('A', [line(1000)]),
    legacyInvoice('B', [line(40.15, 'gst', { gstAmount: 4.01 })]),           // stored one cent low
    legacyInvoice('C', [line(250), line(99.95, 'gst_free')]),
    invoice('D', [line(333.33)]),                                             // new shape, zero retention
    legacyInvoice('E', [line(500)], { status: 'draft' }),
    legacyInvoice('F', [line(700)], { status: 'void' }),
    legacyInvoice('G', [line(80.85)], { dueDate: '' }),
  ]
  const receipts = [
    receipt('r1', [['A', 400], ['B', 44.16]]),      // A part, B in full
    receipt('r2', [['C', 400], ['A', 100.5]]),      // C over-received (owed 374.95)
    receipt('r3', [['D', 100]], { status: 'draft' }),
    receipt('r4', [['G', 10]], { status: 'void' }),
  ]

  it('rows without a positions argument: remaining === grossTotal − received, exactly as before', () => {
    const rows = clientInvoiceReconciliationRows(invoices, receipts)
    expect(rows.map(r => [r.id, r.grossTotal, r.received, r.remaining, r.state])).toEqual([
      ['A', 1100, 500.5, 599.5, 'partly_reconciled'],
      ['B', 44.16, 44.16, 0, 'fully_reconciled'],
      ['C', 374.95, 400, -25.05, 'over_reconciled'],
      ['D', 366.66, 0, 366.66, 'unreconciled'],
      ['G', 88.94, 0, 88.94, 'unreconciled'],
    ])
    for (const r of rows) {
      expect(Math.round(r.remaining * 100)).toBe(Math.round(r.grossTotal * 100) - Math.round(r.received * 100))
      expect(r.receivableBasis).toBe(r.grossTotal)
      expect(r.credited).toBe(0)
      expect(r.retentionTotal).toBe(0)
      expect(r.releasedTotal).toBe(0)
      expect(r.retentionHeld).toBe(0)
    }
  })

  it('passing receivablePositions(...) gives IDENTICAL rows', () => {
    const positions = receivablePositions(invoices)
    expect(clientInvoiceReconciliationRows(invoices, receipts, positions))
      .toEqual(clientInvoiceReconciliationRows(invoices, receipts))
    expect(clientInvoiceReconciliationRows(invoices, receipts, receivablePositions(invoices, [], [])))
      .toEqual(clientInvoiceReconciliationRows(invoices, receipts))
    expect(clientInvoiceReconciliationRows(invoices, receipts, {}))
      .toEqual(clientInvoiceReconciliationRows(invoices, receipts))
  })

  it('summary, ageing, picker and warnings are identical with and without positions', () => {
    const positions = receivablePositions(invoices)
    const now = new Date(2026, 10, 26)
    expect(receivablesSummary(invoices, receipts, positions)).toEqual(receivablesSummary(invoices, receipts))
    expect(arAgeing(invoices, receipts, now, positions)).toEqual(arAgeing(invoices, receipts, now))
    const received = receivedByInvoice(receipts)
    expect(ageingByDueDate(invoices, received, now, positions)).toEqual(ageingByDueDate(invoices, received, now))
    expect(allocatableInvoices(invoices, 'client1', receipts, { positions }))
      .toEqual(allocatableInvoices(invoices, 'client1', receipts))
    const allocation = [{ clientInvoiceId: 'A', allocatedAmount: 600 }, { clientInvoiceId: 'D', allocatedAmount: 366.66 }]
    expect(invoiceOverAllocationWarnings(allocation, invoices, receipts, { positions }))
      .toEqual(invoiceOverAllocationWarnings(allocation, invoices, receipts))
  })

  it('the summary figures are the pre-ADR-87 ones', () => {
    expect(receivablesSummary(invoices, receipts)).toMatchObject({
      issuedGross: 1974.71,        // 1100 + 44.16 + 374.95 + 366.66 + 88.94
      received: 944.66,            // 500.50 + 44.16 + 400
      remaining: 1055.1,           // 599.50 + 366.66 + 88.94 (positive balances only)
      overReconciled: -25.05,
      owedToClient: 25.05,
      credited: 0,
      retentionHeld: 0,
      receivable: 1974.71,
    })
  })

  it('contract control and variation invoicing are unchanged with no credits', () => {
    const context = receivableContext(invoices)
    expect(contractControl(invoices, 100000, context.totals)).toEqual(contractControl(invoices, 100000))
    expect(contractControl(invoices, 100000, null)).toEqual(contractControl(invoices, 100000))
    expect(invoicedByVariation(invoices, context.creditedByVariation)).toEqual(invoicedByVariation(invoices))
  })

  it('a legacy invoice has no retention register row and no ledger exception', () => {
    expect(clientRetentionRows(invoices, receivablePositions(invoices))).toEqual([])
    expect(ledgerExceptions(invoices, [], [], [])).toEqual([])
  })
})

// ── Never clamped ────────────────────────────────────────────────────────────

describe('a credit after the money was received', () => {
  const inv = invoice('A', [line(1000)])
  const other = invoice('B', [line(500)])
  const receipts = [receipt('r1', [['A', 1100]])]

  it('before the credit the invoice is fully reconciled', () => {
    const s = receivablesSummary([inv, other], receipts, receivablePositions([inv, other]))
    expect(s.rows[0]).toMatchObject({ remaining: 0, state: 'fully_reconciled' })
    expect(s).toMatchObject({ remaining: 550, overReconciled: 0, owedToClient: 0 })
  })

  it('gives a NEGATIVE remaining and a positive owedToClient — never clamped, never netted', () => {
    const p = post(inv)
    p.credit([{ invoiceLineIndex: 0, amount: 300 }])
    const positions = receivablePositions([inv, other], p.creditNotes, p.releases)
    expect(positions.A.receivableBasis).toBe(770)

    const s = receivablesSummary([inv, other], receipts, positions)
    expect(s.rows[0]).toMatchObject({
      id: 'A', grossTotal: 1100, credited: 330, receivableBasis: 770, received: 1100,
      remaining: -330, state: 'over_reconciled',
    })
    expect(s.rows[0].remaining).toBeLessThan(0)
    expect(s.owedToClient).toBe(330)
    expect(s.owedToClient).toBeGreaterThan(0)
    expect(s.overReconciled).toBe(-330)
    // What the OTHER invoice owes is not reduced by the client's credit balance.
    expect(s.remaining).toBe(550)
    expect(s.receivable).toBe(1320) // 770 + 550
    expect(s.issuedGross).toBe(1650) // gross is never reduced
    expect(remainingToReconcile(inv, 1100, positions.A)).toBe(-330)
  })

  it('the over-settled invoice leaves the ageing buckets and is reported separately', () => {
    const p = post(inv)
    p.credit([{ invoiceLineIndex: 0, amount: 300 }])
    const positions = receivablePositions([inv, other], p.creditNotes, p.releases)
    const aged = arAgeing([inv, other], receipts, new Date(2026, 10, 26), positions)
    expect(aged.total).toBe(550)
    expect(aged.overSettled.map(r => r.id)).toEqual(['A'])
  })

  it('a FULL credit of a fully received invoice owes the whole receipt back', () => {
    const p = post(inv)
    p.credit([{ invoiceLineIndex: 0, amount: 1000 }])
    const positions = receivablePositions([inv], p.creditNotes, p.releases)
    const s = receivablesSummary([inv], receipts, positions)
    expect(s.rows[0]).toMatchObject({ receivableBasis: 0, received: 1100, remaining: -1100, state: 'over_reconciled' })
    expect(s.owedToClient).toBe(1100)
    expect(s.remaining).toBe(0)
  })
})

// ── Two different "negatives" ────────────────────────────────────────────────
//
//   (i)  receivableBasis = gross − credited − retention held. It is what the
//        client owes BEFORE receipts and must NEVER be negative: a negative
//        basis would be a library error (the ledger invariants forbid it).
//   (ii) remaining = receivableBasis − received. It is LEGITIMATELY negative
//        when receipts exceed the basis — money owed back to the client. It is
//        reported as `owedToClient`, never clamped to zero and never netted
//        against what another invoice still owes.

describe('receivableBasis is never negative; remaining may be, and is reported as owed to the client', () => {
  // A: 1000.00 gst + 1000.00 gst_free, FULLY retained → basis 0.00 at issue.
  // B: 1000.00 gst, 10% retained                      → basis 990.00.
  // C: 500.00 gst, no retention                       → basis 550.00.
  const build = () => {
    const a = invoice('A', [line(1000), line(1000, 'gst_free')], 2000)
    const b = invoice('B', [line(1000)], 100)
    const c = invoice('C', [line(500)])
    return { a, b, c, pa: post(a), pb: post(b), pc: post(c) }
  }
  const positionsOf = ({ a, b, c, pa, pb, pc }) => receivablePositions(
    [a, b, c],
    [...pa.creditNotes, ...pb.creditNotes, ...pc.creditNotes],
    [...pa.releases, ...pb.releases, ...pc.releases])

  it('(i) the basis is 0.00 — not negative — through every credit of a fully retained mixed-tax invoice', () => {
    const set = build()
    const basisOfA = () => positionsOf(set).A.receivableBasis
    expect(basisOfA()).toBe(0)
    // The GST-free line: retention 1000.00 and no retention GST → the credit's
    // receivable part is 0.00 (the superseded rule made it −50.00).
    const first = set.pa.credit([{ invoiceLineIndex: 1, amount: 1000 }])
    expect(first).toMatchObject({ retentionAmount: 1000, retentionGst: 0, receivableTotal: 0 })
    expect(basisOfA()).toBe(0)
    expect(Object.is(basisOfA(), -0)).toBe(false)
    const second = set.pa.credit([{ invoiceLineIndex: 0, amount: 1000 }])
    expect(second).toMatchObject({ retentionAmount: 1000, retentionGst: 100, receivableTotal: 0 })
    expect(basisOfA()).toBe(0)
    expect(positionsOf(set).A).toMatchObject({ credited: 2100, retentionHeld: 0, netIssuedGross: 0, receivableBasis: 0 })
  })

  it('(i) no basis is negative at any point of a credit / release sequence, and remaining equals it while nothing is received', () => {
    const set = build()
    const check = () => {
      const positions = positionsOf(set)
      for (const p of Object.values(positions)) {
        expect(Math.round(p.receivableBasis * 100)).toBeGreaterThanOrEqual(0)
        expect(Math.round(p.receivableBasis * 100))
          .toBe(Math.round(p.grossTotal * 100) - Math.round(p.credited * 100) - Math.round(p.retentionHeld * 100))
      }
      const s = receivablesSummary([set.a, set.b, set.c], [], positions)
      expect(s.rows.map(r => r.remaining)).toEqual(s.rows.map(r => r.receivableBasis))
      expect(s.owedToClient).toBe(0)
      expect(s.overReconciled).toBe(0)
      return positions
    }
    check()
    set.pa.credit([{ invoiceLineIndex: 0, amount: 999.99 }]); check()
    set.pa.release(500); check()
    set.pb.credit([{ invoiceLineIndex: 0, amount: 950 }]); check()
    set.pb.release(5); check()
    set.pa.credit([{ invoiceLineIndex: 0, amount: 0.01 }, { invoiceLineIndex: 1, amount: 1000 }]); check()
    set.pb.credit([{ invoiceLineIndex: 0, amount: 50 }]); check()
    set.pc.credit([{ invoiceLineIndex: 0, amount: 500 }])
    const end = check()
    expect([end.A.receivableBasis, end.B.receivableBasis, end.C.receivableBasis]).toEqual([0, 0, 0])
  })

  it('(ii) receipts above the basis give a NEGATIVE remaining per invoice and a positive owedToClient — not clamped, not netted', () => {
    const set = build()
    // B: credit 200.00 (220.00 gross, 22.00 of it retention) → basis 990 − 198 = 792.00.
    set.pb.credit([{ invoiceLineIndex: 0, amount: 200 }])
    // A: release 500.00 (+25.00) → basis 525.00; then credit the taxable line in
    // full (1100.00): retention 1500 × 1000 ÷ 2000 = 750.00 and all 75.00 of GST
    // still held → receivable part 275.00 → basis 250.00.
    set.pa.release(500)
    const cn = set.pa.credit([{ invoiceLineIndex: 0, amount: 1000 }])
    expect(cn).toMatchObject({ retentionAmount: 750, retentionGst: 75, receivableTotal: 275 })
    const positions = positionsOf(set)
    expect([positions.A.receivableBasis, positions.B.receivableBasis, positions.C.receivableBasis]).toEqual([250, 792, 550])

    const receipts = [
      receipt('r1', [['A', 525]]),              // paid when the basis was 525.00 → 275.00 over
      receipt('r2', [['B', 990]]),              // paid the original 990.00       → 198.00 over
      receipt('r3', [['C', 100]]),              // part-paid                      → 450.00 still owed
    ]
    const s = receivablesSummary([set.a, set.b, set.c], receipts, positions)
    expect(s.rows.map(r => [r.id, r.receivableBasis, r.received, r.remaining, r.state])).toEqual([
      ['A', 250, 525, -275, 'over_reconciled'],
      ['B', 792, 990, -198, 'over_reconciled'],
      ['C', 550, 100, 450, 'partly_reconciled'],
    ])
    // The basis itself is not negative on any row — only remaining is.
    for (const r of s.rows) expect(r.receivableBasis).toBeGreaterThanOrEqual(0)
    // Owed to the client: 275.00 + 198.00, both invoices, positive.
    expect(s.owedToClient).toBe(473)
    expect(s.overReconciled).toBe(-473)
    // What C still owes is NOT reduced by the client's credit balance…
    expect(s.remaining).toBe(450)
    // …and the three never collapse into one netted figure (450 − 473 = −23).
    expect(s.remaining - s.owedToClient).toBe(-23)
    expect(s.remaining).not.toBe(0)
    expect(s.receivable).toBe(1592)   // 250 + 792 + 550: bases, before receipts
    expect(s.received).toBe(1615)
    expect(remainingToReconcile(set.a, 525, positions.A)).toBe(-275)
    expect(remainingToReconcile(set.b, 990, positions.B)).toBe(-198)
    // Ageing carries only the genuine arrears; the over-settled rows are listed apart.
    const aged = arAgeing([set.a, set.b, set.c], receipts, new Date(2026, 10, 26), positions)
    expect(aged.total).toBe(450)
    expect(aged.overSettled.map(r => r.id)).toEqual(['A', 'B'])
  })

  it('(ii) a release void after the money was received also leaves remaining negative — the basis falls back, never below zero', () => {
    const set = build()
    const r = set.pa.release(2000)                      // everything: basis 2100.00
    expect(positionsOf(set).A.receivableBasis).toBe(2100)
    const receipts = [receipt('r1', [['A', 2100]])]
    // Voided: the release no longer counts, the basis is 0.00 again.
    const positions = receivablePositions([set.a], [], [{ ...r, status: 'void' }])
    expect(positions.A.receivableBasis).toBe(0)
    const s = receivablesSummary([set.a], receipts, positions)
    expect(s.rows[0]).toMatchObject({ receivableBasis: 0, received: 2100, remaining: -2100, state: 'over_reconciled' })
    expect(s.owedToClient).toBe(2100)
    expect(s.remaining).toBe(0)
  })
})

// ── Contract control ─────────────────────────────────────────────────────────

describe('contractControl with credited totals', () => {
  const a = invoice('A', [line(1000)])
  const b = invoice('B', [line(40.15), line(500, 'gst_free')])
  const draft = invoice('D', [line(300)], 0, { status: 'draft' })
  const voided = invoice('V', [line(999)], 0, { status: 'void' })
  const invoices = [a, b, draft, voided]
  const CCS = 100000

  it('with no credits the figures are the invoices\' own', () => {
    const cc = contractControl(invoices, CCS)
    expect(cc.currentContractSum).toBe(100000)
    expect(cc.billed).toEqual({ count: 2, subtotal: 1540.15, gstTotal: 104.02, grossTotal: 1644.17 })
    expect(cc.issued).toEqual(cc.billed)
    expect(cc.credited).toEqual({ subtotal: 0, gstTotal: 0, grossTotal: 0 })
    expect(cc.drafts).toEqual({ count: 1, subtotal: 300, gstTotal: 30, grossTotal: 330 })
    expect(cc.availableToInvoice).toBe(98459.85)
  })

  it('issued FALLS and availableToInvoice RISES by the credited ex-GST amount; the contract sum is unchanged', () => {
    const pa = post(a)
    const pb = post(b)
    pa.credit([{ invoiceLineIndex: 0, amount: 200 }])
    pb.credit([{ invoiceLineIndex: 0, amount: 20.07 }, { invoiceLineIndex: 1, amount: 100 }])
    const context = receivableContext(invoices, [...pa.creditNotes, ...pb.creditNotes], [])
    // Credited ex-GST 200 + 120.07 = 320.07; GST 20.00 + 2.01 = 22.01.
    expect(context.totals).toMatchObject({ creditedSubtotal: 320.07, creditedGst: 22.01, credited: 342.08 })

    const before = contractControl(invoices, CCS)
    const after = contractControl(invoices, CCS, context.totals)
    expect(after.currentContractSum).toBe(before.currentContractSum)
    expect(after.currentContractSum).toBe(100000)
    expect(after.billed).toEqual(before.billed)
    expect(after.drafts).toEqual(before.drafts)
    expect(after.credited).toEqual({ subtotal: 320.07, gstTotal: 22.01, grossTotal: 342.08 })
    expect(after.issued).toEqual({ count: 2, subtotal: 1220.08, gstTotal: 82.01, grossTotal: 1302.09 })
    expect(after.availableToInvoice).toBe(98779.92)
    // Exactly the credited ex-GST amount, in whole cents.
    expect(Math.round(before.issued.subtotal * 100) - Math.round(after.issued.subtotal * 100)).toBe(32007)
    expect(Math.round(after.availableToInvoice * 100) - Math.round(before.availableToInvoice * 100)).toBe(32007)
  })

  it('a full credit re-opens the whole invoice for invoicing', () => {
    const pa = post(a)
    pa.credit([{ invoiceLineIndex: 0, amount: 1000 }])
    const after = contractControl([a], CCS, receivableContext([a], pa.creditNotes).totals)
    expect(after.issued).toEqual({ count: 1, subtotal: 0, gstTotal: 0, grossTotal: 0 })
    expect(after.availableToInvoice).toBe(100000)
  })

  it('retention and releases do not change what is issued', () => {
    const r = invoice('R', [line(1000)], 100)
    const pr = post(r)
    pr.release(40)
    const context = receivableContext([r], pr.creditNotes, pr.releases)
    expect(contractControl([r], CCS, context.totals)).toEqual(contractControl([r], CCS))
    expect(contractControl([r], CCS).issued.subtotal).toBe(1000)
    expect(contractControl([r], CCS).availableToInvoice).toBe(99000)
  })

  it('stays signed when over-invoiced', () => {
    expect(contractControl([a], 600).availableToInvoice).toBe(-400)
    expect(contractControl([a], 600, { creditedSubtotal: 100, creditedGst: 10 }).availableToInvoice).toBe(-300)
  })
})

describe('invoicedByVariation with variation-linked credits', () => {
  const inv = invoice('A', [
    line(1000),
    line(400, 'gst', { variationId: 'v1', variationNumber: 'CV-0001' }),
    line(250, 'gst_free', { variationId: 'v2', variationNumber: 'CV-0002' }),
  ])
  const second = invoice('B', [line(100, 'gst', { variationId: 'v1', variationNumber: 'CV-0001' })])

  it('falls by exactly the credits on variation lines', () => {
    expect(invoicedByVariation([inv, second])).toEqual({ v1: 500, v2: 250 })
    const p = post(inv)
    p.credit([{ invoiceLineIndex: 0, amount: 300 }, { invoiceLineIndex: 1, amount: 150 }])
    p.credit([{ invoiceLineIndex: 1, amount: 0.05 }])
    const context = receivableContext([inv, second], p.creditNotes, [])
    expect(context.creditedByVariation).toEqual({ v1: 150.05 })
    expect(invoicedByVariation([inv, second], context.creditedByVariation)).toEqual({ v1: 349.95, v2: 250 })
  })

  it('the variation regains that amount to invoice', () => {
    const variations = [
      { id: 'v1', variationNumber: 'CV-0001', variationType: 'client', status: 'approved', approvedSubtotal: 600, lineItems: [] },
    ]
    const p = post(inv)
    p.credit([{ invoiceLineIndex: 1, amount: 150 }])
    const credited = receivableContext([inv, second], p.creditNotes, []).creditedByVariation
    const before = variationInvoicingRows(variations, [inv, second])
    const after = variationInvoicingRows(variations, [inv, second], credited)
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ approved: 600, invoiced: 500, remaining: 100 })
    expect(after[0]).toMatchObject({ approved: 600, invoiced: 350, remaining: 250 })
  })

  it('a credit on a non-variation line changes no variation', () => {
    const p = post(inv)
    p.credit([{ invoiceLineIndex: 0, amount: 300 }])
    const credited = receivableContext([inv], p.creditNotes, []).creditedByVariation
    expect(credited).toEqual({})
    expect(invoicedByVariation([inv], credited)).toEqual({ v1: 400, v2: 250 })
  })
})

// ── Ledger cross-check ───────────────────────────────────────────────────────

describe('ledgerExceptions', () => {
  const a = invoice('A', [line(1000)], 100)
  const b = invoice('B', [line(500)])

  it('is silent when there is no ledger and nothing has been posted', () => {
    expect(ledgerExceptions([a, b], [], [], [])).toEqual([])
    expect(ledgerExceptions([a, b], null)).toEqual([])
    expect(ledgerExceptions(null, null, null, null)).toEqual([])
  })

  it('is silent when every ledger equals its posted documents', () => {
    const pa = post(a)
    pa.credit([{ invoiceLineIndex: 0, amount: 200 }])
    pa.release(40)
    const pb = post(b)
    pb.credit([{ invoiceLineIndex: 0, amount: 50 }])
    const creditNotes = [...pa.creditNotes, ...pb.creditNotes]
    expect(ledgerExceptions([a, b], [pa.ledgerDoc, pb.ledgerDoc], creditNotes, pa.releases)).toEqual([])
  })

  it('drafts and voids are not expected in the ledger', () => {
    const pa = post(a)
    pa.credit([{ invoiceLineIndex: 0, amount: 200 }])
    pa.credit([{ invoiceLineIndex: 0, amount: 10 }], { status: 'draft' })
    pa.credit([{ invoiceLineIndex: 0, amount: 20 }], { status: 'void' })
    pa.release(5, { status: 'draft' })
    expect(ledgerExceptions([a], [pa.ledgerDoc], pa.creditNotes, pa.releases)).toEqual([])
  })

  it('flags a ledger that disagrees with the posted documents', () => {
    const pa = post(a)
    pa.credit([{ invoiceLineIndex: 0, amount: 200 }])
    pa.release(40)
    const tampered = { ...pa.ledgerDoc, creditedSubtotalCents: 10000, releasedRetentionGstCents: 0 }
    expect(ledgerExceptions([a, b], [tampered], pa.creditNotes, pa.releases)).toEqual([{
      invoiceId: 'A', invoiceNumber: 'CI-A',
      keys: ['creditedSubtotalCents', 'releasedRetentionGstCents'],
      seq: 2,
      reason: 'The ledger of CI-A does not equal the credit notes and retention releases posted against it.',
    }])
  })

  it('flags a posted entry with NO ledger, and a ledger with no entries', () => {
    const pa = post(a)
    pa.credit([{ invoiceLineIndex: 0, amount: 200 }])
    const missing = ledgerExceptions([a], [], pa.creditNotes, [])
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({
      invoiceId: 'A', seq: 0,
      keys: ['creditedSubtotalCents', 'creditedGstCents', 'creditedRetentionCents', 'creditedRetentionGstCents'],
    })
    // The document was altered (un-posted) outside the app: the ledger still counts it.
    const orphaned = ledgerExceptions([a], [pa.ledgerDoc], [{ ...pa.creditNotes[0], status: 'void' }], [])
    expect(orphaned).toHaveLength(1)
    expect(orphaned[0].seq).toBe(1)
  })

  it('the FIGURES still follow the documents, never the ledger', () => {
    const pa = post(a)
    pa.credit([{ invoiceLineIndex: 0, amount: 200 }])
    // receivablePositions takes no ledger at all.
    expect(receivablePositions([a], pa.creditNotes, []).A.credited).toBe(220)
  })
})
