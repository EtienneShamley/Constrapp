import { describe, it, expect } from 'vitest'
import {
  RR_STATUS, RR_DOC_TYPE, RR_TRANSITIONS, RR_COUNTING_STATUSES, RR_EDITABLE_STATUSES,
  RETENTION_RELEASE_COUNTER_ID, canTransition, formatRetentionReleaseNumber,
  postedRetentionReleases, draftRetentionReleases, voidRetentionReleases,
  cumulativeRetentionGst, releaseGstAmount, releaseTotals,
  releasedByInvoiceId, releasedExGstByInvoiceId, releasedExGstForInvoice,
  remainingRetentionExGst, retentionInvoices, retentionInvoiceRows,
  retentionBySupplier, retentionSummary, releaseExceptions, overReleasedRows,
  validateReleaseDraft, postBlockedReason,
} from '../../src/lib/retention'
import { invoiceTotals } from '../../src/lib/supplierInvoices'
import {
  payableBasis, remainingPayable, invoiceReconciliation,
  supplierInvoiceReconciliationRows, payablesSummary,
  allocatableSupplierInvoices, invoiceOverPaymentWarnings, apAgeing,
} from '../../src/lib/supplierPayments'
import { sumRetentionHeld, sumRetentionReleased, classifyInvoiceBalances } from '../../src/lib/cashFlow'

// ── Supplier Retention & Retention Release — pure domain tests ───────────────
//
// Companion to tests/rules/retentionReleases.rules.test.js (the trust boundary).
// Everything here is pure: no React, no Firebase, no emulator.
//
// The load-bearing properties proven below:
//   1. GST TELESCOPES. Partial releases sum EXACTLY to the invoice's stored
//      retentionGst / retentionTotal, for any split and any drift-prone value.
//   2. ZERO RELEASES CHANGE NOTHING. Every supplierPayments figure is identical
//      to its pre-ADR-30 value when no release exists.
//   3. NO DOUBLE COUNT. retentionHeld and the released amount inside `remaining`
//      are disjoint: retentionHeld + releasedTotal == retentionTotal.

// A posted supplier invoice carrying retention, built through the REAL
// invoiceTotals() so the fixture can never drift from production arithmetic.
function invoice({ id = 'si1', retention = 1000, subtotal = 10000, ...rest } = {}) {
  const totals = invoiceTotals([{ amount: subtotal, gstAmount: subtotal * 0.1 }], retention)
  return {
    id,
    invoiceNumber: 'SI-0001',
    supplierInvoiceNumber: 'INV-4471',
    status: 'posted',
    supplierId: 'sup1',
    supplierName: 'Bloggs Concreting Pty Ltd',
    invoiceDate: '2026-05-01',
    dueDate: '2026-06-01',
    lineItems: [{ amount: subtotal, gstAmount: subtotal * 0.1, costCodeId: 'cc1' }],
    ...totals,
    ...rest,
  }
}

function release({ id = 'rr1', supplierInvoiceId = 'si1', prev = 0, amount = 400, status = RR_STATUS.POSTED, ...rest } = {}) {
  const money = releaseTotals(prev, amount)
  return {
    id,
    releaseNumber: 'RR-0001',
    status,
    docType: RR_DOC_TYPE,
    supplierInvoiceId,
    invoiceNumber: 'SI-0001',
    supplierInvoiceNumber: 'INV-4471',
    supplierId: 'sup1',
    supplierName: 'Bloggs Concreting Pty Ltd',
    releaseDate: '2026-08-13',
    reason: 'Practical completion',
    notes: '',
    ...money,
    ...rest,
  }
}

const payment = ({ id = 'sp1', status = 'posted', allocations = [], amount = 0 } = {}) => ({
  id, status, amount, allocations,
  allocatedTotal: allocations.reduce((s, a) => s + a.allocatedAmount, 0),
  unallocatedAmount: 0,
  supplierId: 'sup1',
  supplierName: 'Bloggs Concreting Pty Ltd',
})

const alloc = (supplierInvoiceId, allocatedAmount) => ({ supplierInvoiceId, allocatedAmount })

const cents = (n) => Math.round(n * 100)

// ── Constants, numbering, lifecycle ──────────────────────────────────────────

describe('constants and numbering', () => {
  it('numbers releases RR-0001 with four-digit padding', () => {
    expect(formatRetentionReleaseNumber(1)).toBe('RR-0001')
    expect(formatRetentionReleaseNumber(42)).toBe('RR-0042')
    expect(formatRetentionReleaseNumber(9999)).toBe('RR-9999')
    // Beyond four digits the number grows rather than truncating.
    expect(formatRetentionReleaseNumber(12345)).toBe('RR-12345')
  })

  it('uses its own company-wide counter and doc type', () => {
    expect(RETENTION_RELEASE_COUNTER_ID).toBe('retentionReleases')
    expect(RR_DOC_TYPE).toBe('retention_release')
  })

  it('counts only posted releases and edits only drafts', () => {
    expect(RR_COUNTING_STATUSES).toEqual([RR_STATUS.POSTED])
    expect(RR_EDITABLE_STATUSES).toEqual([RR_STATUS.DRAFT])
  })

  it('has NO paid status — payment state is derived from Supplier Payments', () => {
    expect(Object.values(RR_STATUS)).toEqual(['draft', 'posted', 'void'])
    expect(Object.values(RR_STATUS)).not.toContain('paid')
  })
})

describe('lifecycle transitions', () => {
  it('moves forward only, with void reachable from draft and posted', () => {
    expect(canTransition(RR_STATUS.DRAFT, RR_STATUS.POSTED)).toBe(true)
    expect(canTransition(RR_STATUS.DRAFT, RR_STATUS.VOID)).toBe(true)
    expect(canTransition(RR_STATUS.POSTED, RR_STATUS.VOID)).toBe(true)
  })

  it('never returns to draft and never un-voids', () => {
    expect(canTransition(RR_STATUS.POSTED, RR_STATUS.DRAFT)).toBe(false)
    expect(canTransition(RR_STATUS.VOID, RR_STATUS.DRAFT)).toBe(false)
    expect(canTransition(RR_STATUS.VOID, RR_STATUS.POSTED)).toBe(false)
    expect(RR_TRANSITIONS[RR_STATUS.VOID]).toEqual([])
  })

  it('rejects unknown statuses without throwing', () => {
    expect(canTransition('nonsense', RR_STATUS.POSTED)).toBe(false)
    expect(canTransition(undefined, undefined)).toBe(false)
  })
})

// ── Release sets ─────────────────────────────────────────────────────────────

describe('release sets', () => {
  const all = [
    release({ id: 'a', status: RR_STATUS.POSTED }),
    release({ id: 'b', status: RR_STATUS.DRAFT }),
    release({ id: 'c', status: RR_STATUS.VOID }),
  ]

  it('separates posted, draft and void', () => {
    expect(postedRetentionReleases(all).map(r => r.id)).toEqual(['a'])
    expect(draftRetentionReleases(all).map(r => r.id)).toEqual(['b'])
    expect(voidRetentionReleases(all).map(r => r.id)).toEqual(['c'])
  })

  it('tolerates null, undefined and malformed entries', () => {
    expect(postedRetentionReleases(null)).toEqual([])
    expect(postedRetentionReleases(undefined)).toEqual([])
    expect(postedRetentionReleases([null, undefined, {}])).toEqual([])
  })
})

// ── GST: the cumulative-snapshot model ───────────────────────────────────────

describe('cumulative GST', () => {
  it('rounds the cumulative figure exactly once', () => {
    expect(cumulativeRetentionGst(1000)).toBe(100)
    expect(cumulativeRetentionGst(100.05)).toBe(10.01)
    expect(cumulativeRetentionGst(0)).toBe(0)
  })

  it('gives a first release the plain rounded GST', () => {
    expect(releaseGstAmount(0, 400)).toBe(40)
    expect(releaseTotals(0, 400)).toEqual({
      previouslyReleasedAmount: 0, amount: 400, gstAmount: 40, releaseTotal: 440,
    })
  })

  it('gives a later release the DELTA, not its own independent rounding', () => {
    // roundMoney(33.35 × 10%) = 3.34, but the second release's true delta is 3.33.
    expect(releaseGstAmount(0, 33.35)).toBe(3.34)
    expect(releaseGstAmount(33.35, 33.35)).toBe(3.33)
    expect(releaseGstAmount(66.70, 33.35)).toBe(3.34)
  })

  it('never produces NaN or a negative from junk input', () => {
    expect(releaseTotals(null, null)).toEqual({
      previouslyReleasedAmount: 0, amount: 0, gstAmount: 0, releaseTotal: 0,
    })
    expect(releaseTotals('x', 'y').gstAmount).toBe(0)
    expect(Number.isFinite(releaseTotals(undefined, 100).releaseTotal)).toBe(true)
  })
})

// Splits an ex-GST retention into `n` contiguous whole-cent parts.
function splitEvenly(retention, n) {
  const totalCents = cents(retention)
  const base = Math.floor(totalCents / n)
  const parts = Array.from({ length: n }, (_, i) => base + (i < totalCents % n ? 1 : 0))
  return parts.map(c => c / 100)
}

describe('GST telescopes exactly to the invoice figures', () => {
  const RETENTIONS = [1000, 100.05, 0.05, 333.33, 1000.03, 87.77, 12345.67, 0.15, 9.99]

  for (const n of [1, 2, 3, 7]) {
    it(`sums to retentionGst and retentionTotal across ${n} contiguous release(s)`, () => {
      for (const retention of RETENTIONS) {
        const inv = invoice({ retention, subtotal: Math.max(retention, 20000) })
        const parts = splitEvenly(inv.retention, n)
        expect(parts.reduce((s, p) => s + cents(p), 0)).toBe(cents(inv.retention))

        let prev = 0
        let gstSum = 0
        let totalSum = 0
        for (const part of parts) {
          const t = releaseTotals(prev, part)
          gstSum += cents(t.gstAmount)
          totalSum += cents(t.releaseTotal)
          prev = cents(prev + part) / 100
        }

        // EXACT, in whole cents — no tolerance.
        expect(gstSum).toBe(cents(inv.retentionGst))
        expect(totalSum).toBe(cents(inv.retentionTotal))
      }
    })
  }

  it('reconciles for a lopsided split, not only an even one', () => {
    const inv = invoice({ retention: 100.05 })
    let prev = 0, gstSum = 0, totalSum = 0
    for (const part of [0.01, 99.99, 0.05]) {
      const t = releaseTotals(prev, part)
      gstSum += cents(t.gstAmount)
      totalSum += cents(t.releaseTotal)
      prev = cents(prev + part) / 100
    }
    expect(gstSum).toBe(cents(inv.retentionGst))
    expect(totalSum).toBe(cents(inv.retentionTotal))
  })

  it('proves a naive per-release rounding would NOT reconcile', () => {
    // The reason the cumulative model exists: independent roundings drift.
    const inv = invoice({ retention: 100.05 })
    const naive = splitEvenly(inv.retention, 3)
      .reduce((s, p) => s + cents(cumulativeRetentionGst(p)), 0)
    expect(naive).not.toBe(cents(inv.retentionGst))
  })

  it('holds on half-cent boundaries — the Rules parity cases', () => {
    expect(cumulativeRetentionGst(50.05)).toBe(5.01)   // 500.5 cents → up
    expect(cumulativeRetentionGst(100.05)).toBe(10.01) // 1000.5 cents → up
    expect(releaseTotals(50.05, 50).gstAmount).toBe(5)
    expect(releaseTotals(0, 0.05).gstAmount).toBe(0.01)
  })
})

// ── Read-time release maps ───────────────────────────────────────────────────

describe('releasedByInvoiceId', () => {
  it('sums posted release totals per invoice', () => {
    expect(releasedByInvoiceId([
      release({ id: 'a', supplierInvoiceId: 'si1', prev: 0, amount: 400 }),
      release({ id: 'b', supplierInvoiceId: 'si1', prev: 400, amount: 100 }),
      release({ id: 'c', supplierInvoiceId: 'si2', prev: 0, amount: 200 }),
    ])).toEqual({ si1: 550, si2: 220 })
  })

  it('EXCLUDES draft and void releases', () => {
    expect(releasedByInvoiceId([
      release({ id: 'a', prev: 0, amount: 400, status: RR_STATUS.POSTED }),
      release({ id: 'b', prev: 0, amount: 400, status: RR_STATUS.DRAFT }),
      release({ id: 'c', prev: 0, amount: 400, status: RR_STATUS.VOID }),
    ])).toEqual({ si1: 440 })
  })

  it('returns an empty map for no releases', () => {
    expect(releasedByInvoiceId([])).toEqual({})
    expect(releasedByInvoiceId(null)).toEqual({})
  })

  it('tracks the ex-GST map separately from the gross map', () => {
    const rs = [release({ prev: 0, amount: 400 })]
    expect(releasedByInvoiceId(rs)).toEqual({ si1: 440 })
    expect(releasedExGstByInvoiceId(rs)).toEqual({ si1: 400 })
  })

  it('excludes one release when asked, so editing a draft never counts itself', () => {
    const rs = [
      release({ id: 'a', prev: 0, amount: 400 }),
      release({ id: 'b', prev: 400, amount: 100 }),
    ]
    expect(releasedExGstForInvoice(rs, 'si1')).toBe(500)
    expect(releasedExGstForInvoice(rs, 'si1', { excludeReleaseId: 'b' })).toBe(400)
  })
})

describe('remaining retention', () => {
  it('is retention minus what has been released', () => {
    expect(remainingRetentionExGst(invoice({ retention: 1000 }), 400)).toBe(600)
    expect(remainingRetentionExGst(invoice({ retention: 1000 }), 1000)).toBe(0)
  })

  it('is clamped at zero when over-released — never offered as headroom', () => {
    expect(remainingRetentionExGst(invoice({ retention: 1000 }), 1500)).toBe(0)
  })
})

// ── Register rows ────────────────────────────────────────────────────────────

describe('retention rows', () => {
  it('includes only POSTED invoices that actually hold retention', () => {
    expect(retentionInvoices([
      invoice({ id: 'a' }),
      invoice({ id: 'b', retention: 0 }),
      invoice({ id: 'c', status: 'draft' }),
      invoice({ id: 'd', status: 'cancelled' }),
      invoice({ id: 'e', status: 'approved' }),
    ]).map(i => i.id)).toEqual(['a'])
  })

  it('splits withheld into released and held', () => {
    const [row] = retentionInvoiceRows([invoice()], [release({ prev: 0, amount: 400 })])
    expect(row.retentionTotal).toBe(1100)
    expect(row.releasedExGst).toBe(400)
    expect(row.releasedGst).toBe(40)
    expect(row.releasedTotal).toBe(440)
    expect(row.retentionHeld).toBe(660)
    expect(row.remainingRetentionExGst).toBe(600)
    expect(row.fullyReleased).toBe(false)
  })

  it('holds the invariant retentionHeld + releasedTotal == retentionTotal', () => {
    for (const amount of [0.01, 1, 400, 999.99, 1000]) {
      const [row] = retentionInvoiceRows([invoice()], [release({ prev: 0, amount })])
      expect(cents(row.retentionHeld + row.releasedTotal)).toBe(cents(row.retentionTotal))
    }
  })

  it('reports a fully released invoice as held zero', () => {
    const [row] = retentionInvoiceRows([invoice()], [release({ prev: 0, amount: 1000 })])
    expect(row.releasedTotal).toBe(1100)
    expect(row.retentionHeld).toBe(0)
    expect(row.fullyReleased).toBe(true)
    expect(row.remainingRetentionExGst).toBe(0)
  })

  it('never reports negative held retention when over-released', () => {
    const rows = retentionInvoiceRows([invoice()], [
      release({ id: 'a', prev: 0, amount: 1000 }),
      release({ id: 'b', prev: 0, amount: 1000 }),
    ])
    expect(rows[0].retentionHeld).toBe(0)
    expect(overReleasedRows(rows)).toHaveLength(1)
  })

  it('leaves the retention fields on the invoice untouched', () => {
    const inv = invoice()
    const before = { ...inv }
    retentionInvoiceRows([inv], [release({ prev: 0, amount: 400 })])
    expect(inv).toEqual(before)
    expect(inv.retention).toBe(1000)
    expect(inv.retentionGst).toBe(100)
    expect(inv.retentionTotal).toBe(1100)
  })
})

describe('supplier grouping', () => {
  it('groups by supplierId and totals each supplier', () => {
    const groups = retentionBySupplier(
      [
        invoice({ id: 'a', supplierId: 'sup1', supplierName: 'Alpha' }),
        invoice({ id: 'b', supplierId: 'sup1', supplierName: 'Alpha', retention: 500 }),
        invoice({ id: 'c', supplierId: 'sup2', supplierName: 'Beta' }),
      ],
      [release({ supplierInvoiceId: 'a', prev: 0, amount: 400 })],
    )
    expect(groups).toHaveLength(2)
    const alpha = groups.find(g => g.supplierName === 'Alpha')
    expect(alpha.invoiceCount).toBe(2)
    expect(alpha.retentionTotal).toBe(1650)
    expect(alpha.releasedTotal).toBe(440)
    expect(alpha.retentionHeld).toBe(1210)
  })

  it('groups LEGACY supplierId:null invoices by their frozen name', () => {
    const groups = retentionBySupplier([
      invoice({ id: 'a', supplierId: null, supplierName: 'Legacy  Concreting' }),
      invoice({ id: 'b', supplierId: null, supplierName: 'legacy concreting' }),
    ], [])
    expect(groups).toHaveLength(1)
    expect(groups[0].invoiceCount).toBe(2)
    expect(groups[0].legacyNameMatch).toBe(true)
  })

  it('keeps an id-matched supplier separate from a same-named legacy one', () => {
    expect(retentionBySupplier([
      invoice({ id: 'a', supplierId: 'sup1', supplierName: 'Alpha' }),
      invoice({ id: 'b', supplierId: null, supplierName: 'Alpha' }),
    ], [])).toHaveLength(2)
  })

  it('sorts groups by supplier name and invoices by date', () => {
    const groups = retentionBySupplier([
      invoice({ id: 'a', supplierId: 's2', supplierName: 'Zulu' }),
      invoice({ id: 'b', supplierId: 's1', supplierName: 'Alpha', invoiceDate: '2026-07-01' }),
      invoice({ id: 'c', supplierId: 's1', supplierName: 'Alpha', invoiceDate: '2026-01-01' }),
    ], [])
    expect(groups.map(g => g.supplierName)).toEqual(['Alpha', 'Zulu'])
    expect(groups[0].rows.map(r => r.id)).toEqual(['c', 'b'])
  })
})

describe('project summary', () => {
  it('totals withheld, released and held with a supplier count', () => {
    const s = retentionSummary(
      [
        invoice({ id: 'a', supplierId: 'sup1' }),
        invoice({ id: 'b', supplierId: 'sup2', retention: 500 }),
      ],
      [release({ supplierInvoiceId: 'a', prev: 0, amount: 400 })],
    )
    expect(s.totalWithheld).toBe(1650)
    expect(s.releasedToDate).toBe(440)
    expect(s.retentionHeld).toBe(1210)
    expect(s.invoiceCount).toBe(2)
    expect(s.supplierCount).toBe(2)
  })

  it('is all zeroes with no retention anywhere', () => {
    expect(retentionSummary([], [])).toEqual({
      totalWithheld: 0, releasedToDate: 0, retentionHeld: 0, invoiceCount: 0, supplierCount: 0,
    })
  })
})

// ── Release exceptions ───────────────────────────────────────────────────────

describe('release exceptions', () => {
  it('reports a posted release whose invoice was cancelled afterwards', () => {
    const ex = releaseExceptions([release()], [invoice({ status: 'cancelled' })])
    expect(ex).toHaveLength(1)
    expect(ex[0].reason).toMatch(/cancelled/i)
    expect(ex[0].releaseNumber).toBe('RR-0001')
  })

  it('reports a posted release whose invoice is missing', () => {
    expect(releaseExceptions([release()], [])[0].reason).toMatch(/no longer exists/i)
  })

  it('reports a release against a non-posted invoice', () => {
    expect(releaseExceptions([release()], [invoice({ status: 'draft' })])[0].reason)
      .toMatch(/only be released on a posted/i)
  })

  it('reports a release against an invoice holding no retention', () => {
    expect(releaseExceptions([release()], [invoice({ retention: 0 })])[0].reason)
      .toMatch(/holds no retention/i)
  })

  it('reports nothing when everything reconciles', () => {
    expect(releaseExceptions([release()], [invoice()])).toEqual([])
  })

  it('ignores draft and void releases', () => {
    const invs = [invoice({ status: 'cancelled' })]
    expect(releaseExceptions([release({ status: RR_STATUS.DRAFT })], invs)).toEqual([])
    expect(releaseExceptions([release({ status: RR_STATUS.VOID })], invs)).toEqual([])
  })
})

// ── Draft validation — the cumulative cap is HARD-BLOCKED ────────────────────

describe('release draft validation', () => {
  const base = {
    supplierInvoiceId: 'si1', amount: 400,
    releaseDate: '2026-08-13', reason: 'Practical completion',
  }

  it('accepts a valid draft', () => {
    expect(validateReleaseDraft({ ...base, invoices: [invoice()], releases: [] })).toBeNull()
  })

  it('requires an invoice, a positive amount, a date and a reason', () => {
    expect(validateReleaseDraft({ ...base, supplierInvoiceId: null })).toMatch(/Choose the supplier invoice/)
    expect(validateReleaseDraft({ ...base, amount: 0 })).toMatch(/greater than zero/)
    expect(validateReleaseDraft({ ...base, amount: -5 })).toMatch(/greater than zero/)
    expect(validateReleaseDraft({ ...base, amount: 'abc' })).toMatch(/as a number/)
    expect(validateReleaseDraft({ ...base, releaseDate: '13/08/2026' })).toMatch(/date this release was agreed/)
    expect(validateReleaseDraft({ ...base, reason: '   ' })).toMatch(/reason/)
  })

  it('rejects a non-posted or retention-free target invoice', () => {
    expect(validateReleaseDraft({ ...base, invoices: [invoice({ status: 'draft' })], releases: [] }))
      .toMatch(/only be released on a posted/)
    expect(validateReleaseDraft({ ...base, invoices: [invoice({ retention: 0 })], releases: [] }))
      .toMatch(/holds no retention/)
  })

  it('HARD-BLOCKS a release beyond the remaining retention', () => {
    expect(validateReleaseDraft({
      ...base, amount: 700,
      invoices: [invoice()],
      releases: [release({ prev: 0, amount: 400 })],
    })).toMatch(/Only 600\.00 of retention/)
  })

  it('blocks by ONE CENT — the cap is exact', () => {
    expect(validateReleaseDraft({ ...base, amount: 1000.01, invoices: [invoice()], releases: [] }))
      .toMatch(/Only 1000\.00/)
    expect(validateReleaseDraft({ ...base, amount: 1000, invoices: [invoice()], releases: [] })).toBeNull()
  })

  it('ignores draft and void siblings when computing what remains', () => {
    expect(validateReleaseDraft({
      ...base, amount: 1000, invoices: [invoice()],
      releases: [
        release({ id: 'a', prev: 0, amount: 900, status: RR_STATUS.DRAFT }),
        release({ id: 'b', prev: 0, amount: 900, status: RR_STATUS.VOID }),
      ],
    })).toBeNull()
  })

  it('excludes the release being edited from its own cap', () => {
    const releases = [release({ id: 'rr1', prev: 0, amount: 1000 })]
    expect(validateReleaseDraft({ ...base, amount: 1000, invoices: [invoice()], releases }))
      .toMatch(/Only 0\.00/)
    expect(validateReleaseDraft({
      ...base, amount: 1000, invoices: [invoice()], releases, excludeReleaseId: 'rr1',
    })).toBeNull()
  })
})

describe('post blocking', () => {
  it('allows posting a valid draft', () => {
    const draft = release({ status: RR_STATUS.DRAFT, prev: 0, amount: 400 })
    expect(postBlockedReason(draft, [invoice()], [draft])).toBeNull()
  })

  it('refuses anything but a draft', () => {
    expect(postBlockedReason(release({ status: RR_STATUS.POSTED }))).toMatch(/Only a draft/)
    expect(postBlockedReason(release({ status: RR_STATUS.VOID }))).toMatch(/Only a draft/)
    expect(postBlockedReason(null)).toMatch(/not found/)
  })

  it('refuses when the target invoice is cancelled or missing', () => {
    const draft = release({ status: RR_STATUS.DRAFT })
    expect(postBlockedReason(draft, [invoice({ status: 'cancelled' })], [draft]))
      .toMatch(/only be released on a posted/)
    expect(postBlockedReason(draft, [], [draft])).toMatch(/could not be found/)
  })

  it('refuses a STALE snapshot after a sibling posted first', () => {
    const draft = release({ id: 'rr2', status: RR_STATUS.DRAFT, prev: 0, amount: 400 })
    const sibling = release({ id: 'rr1', status: RR_STATUS.POSTED, prev: 0, amount: 400 })
    expect(postBlockedReason(draft, [invoice()], [draft, sibling]))
      .toMatch(/since this draft was prepared/)
  })

  it('refuses when the amount now exceeds what remains', () => {
    const draft = release({ id: 'rr2', status: RR_STATUS.DRAFT, prev: 700, amount: 400 })
    const sibling = release({ id: 'rr1', status: RR_STATUS.POSTED, prev: 0, amount: 700 })
    expect(postBlockedReason(draft, [invoice()], [draft, sibling])).toMatch(/Only 300\.00/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SUPPLIER PAYMENTS INTEGRATION — behavioural regression
// ═════════════════════════════════════════════════════════════════════════════

describe('zero releases reproduce the pre-ADR-30 figures exactly', () => {
  const inv = invoice()
  const pays = [payment({ allocations: [alloc('si1', 4900)], amount: 4900 })]

  it('payableBasis is the stored payableTotal', () => {
    expect(payableBasis(inv)).toBe(inv.payableTotal)
    expect(payableBasis(inv, 0)).toBe(inv.payableTotal)
    expect(payableBasis(inv, undefined)).toBe(inv.payableTotal)
  })

  it('remainingPayable, reconciliation and rows are unchanged', () => {
    expect(remainingPayable(inv, 4900)).toBe(inv.payableTotal - 4900)
    expect(invoiceReconciliation(inv, { si1: 4900 }).total).toBe(inv.payableTotal)
    const [row] = supplierInvoiceReconciliationRows([inv], pays)
    expect(row.payableTotal).toBe(inv.payableTotal)
    expect(row.invoicePayableTotal).toBe(inv.payableTotal)
    expect(row.releasedTotal).toBe(0)
    expect(row.retentionHeld).toBe(inv.retentionTotal)
    expect(row.remaining).toBe(inv.payableTotal - 4900)
  })

  it('summary, allocatable list and ageing are unchanged', () => {
    expect(payablesSummary([inv], pays).postedPayable).toBe(inv.payableTotal)
    const [target] = allocatableSupplierInvoices([inv], 'sup1', 'Bloggs Concreting Pty Ltd', pays)
    expect(target.payableTotal).toBe(inv.payableTotal)
    expect(apAgeing([inv], pays).total).toBe(inv.payableTotal - 4900)
  })

  it('an explicitly empty released map behaves identically to omitting it', () => {
    expect(supplierInvoiceReconciliationRows([inv], pays, {}))
      .toEqual(supplierInvoiceReconciliationRows([inv], pays))
    expect(payablesSummary([inv], pays, {})).toEqual(payablesSummary([inv], pays))
    expect(apAgeing([inv], pays, {})).toEqual(apAgeing([inv], pays))
  })
})

describe('a posted release raises the payable exactly once', () => {
  const inv = invoice()
  const map = releasedByInvoiceId([release({ prev: 0, amount: 400 })]) // releaseTotal 440
  const pays = [payment({ allocations: [alloc('si1', 9900)], amount: 9900 })]

  it('raises payableBasis by the release TOTAL, not the ex-GST amount', () => {
    expect(payableBasis(inv, map.si1)).toBe(inv.payableTotal + 440)
  })

  it('raises Remaining Payable on a fully-settled invoice back above zero', () => {
    const [row] = supplierInvoiceReconciliationRows([inv], pays, map)
    expect(row.invoicePayableTotal).toBe(9900)
    expect(row.payableTotal).toBe(10340)
    expect(row.paid).toBe(9900)
    expect(row.remaining).toBe(440)
    expect(row.state).toBe('partly_reconciled')
  })

  it('reduces retention HELD by the same amount it added to payable', () => {
    const [row] = supplierInvoiceReconciliationRows([inv], pays, map)
    expect(row.retentionHeld).toBe(1100 - 440)
    expect(row.releasedTotal).toBe(440)
  })

  it('makes the released amount ALLOCATABLE to a payment', () => {
    const [target] = allocatableSupplierInvoices(
      [inv], 'sup1', 'Bloggs Concreting Pty Ltd', pays, { releasedByInvoiceId: map },
    )
    expect(target.remaining).toBe(440)
    expect(target.retentionHeld).toBe(660)
    expect(target.payableTotal).toBe(10340)
    expect(target.invoicePayableTotal).toBe(9900)
  })

  it('raises the project payables summary', () => {
    const before = payablesSummary([inv], pays)
    const after = payablesSummary([inv], pays, map)
    expect(before.remaining).toBe(0)
    expect(after.remaining).toBe(440)
    expect(after.postedPayable).toBe(before.postedPayable + 440)
  })

  it('puts the released balance into AP ageing', () => {
    expect(apAgeing([inv], pays).total).toBe(0)
    expect(apAgeing([inv], pays, map).total).toBe(440)
  })

  it('uses the new basis for over-payment warnings', () => {
    // 440 is now legitimately payable, so no warning; 441 exceeds it.
    expect(invoiceOverPaymentWarnings([alloc('si1', 440)], [inv], pays, { releasedByInvoiceId: map })).toEqual([])
    const warn = invoiceOverPaymentWarnings([alloc('si1', 441)], [inv], pays, { releasedByInvoiceId: map })
    expect(warn).toHaveLength(1)
    expect(warn[0].excess).toBe(1)
    // Without the release the whole 440 would have been an over-payment.
    expect(invoiceOverPaymentWarnings([alloc('si1', 440)], [inv], pays)).toHaveLength(1)
  })

  it('never mutates the invoice document', () => {
    const target = invoice()
    const before = JSON.stringify(target)
    supplierInvoiceReconciliationRows([target], pays, map)
    payablesSummary([target], pays, map)
    apAgeing([target], pays, map)
    expect(JSON.stringify(target)).toBe(before)
  })
})

describe('voiding a release restores the original numbers', () => {
  const inv = invoice()
  const pays = [payment({ allocations: [alloc('si1', 9900)], amount: 9900 })]

  it('returns every figure to its pre-release value', () => {
    const posted = [release({ prev: 0, amount: 400, status: RR_STATUS.POSTED })]
    const voided = [release({ prev: 0, amount: 400, status: RR_STATUS.VOID })]

    const withRelease = supplierInvoiceReconciliationRows([inv], pays, releasedByInvoiceId(posted))[0]
    const afterVoid   = supplierInvoiceReconciliationRows([inv], pays, releasedByInvoiceId(voided))[0]
    const never       = supplierInvoiceReconciliationRows([inv], pays)[0]

    expect(withRelease.remaining).toBe(440)
    expect(afterVoid).toEqual(never)
    expect(afterVoid.remaining).toBe(0)
    expect(afterVoid.retentionHeld).toBe(1100)
    expect(payablesSummary([inv], pays, releasedByInvoiceId(voided)))
      .toEqual(payablesSummary([inv], pays))
  })
})

describe('releasing the full retention makes the whole gross payable', () => {
  it('payable basis reaches grossTotal exactly', () => {
    const inv = invoice()
    const map = releasedByInvoiceId([release({ prev: 0, amount: 1000 })])
    expect(payableBasis(inv, map.si1)).toBe(inv.grossTotal)
    const [row] = supplierInvoiceReconciliationRows([inv], [], map)
    expect(row.retentionHeld).toBe(0)
    expect(row.payableTotal).toBe(11000)
  })

  it('holds across a 7-way split of a drift-prone retention', () => {
    const inv = invoice({ retention: 100.05, subtotal: 20000 })
    const parts = splitEvenly(inv.retention, 7)
    let prev = 0
    const releases = parts.map((part, i) => {
      const r = release({ id: `r${i}`, prev, amount: part })
      prev = cents(prev + part) / 100
      return r
    })
    expect(payableBasis(inv, releasedByInvoiceId(releases).si1)).toBe(inv.grossTotal)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// CASH FLOW INTEGRATION — the double-count proof
// ═════════════════════════════════════════════════════════════════════════════

describe('cash flow retention semantics', () => {
  const inv = invoice()
  const pays = [payment({ allocations: [alloc('si1', 9900)], amount: 9900 })]
  const NOW = '2026-08'

  it('sums retention HELD, never retentionTotal', () => {
    const rows = supplierInvoiceReconciliationRows(
      [inv], pays, releasedByInvoiceId([release({ prev: 0, amount: 400 })]),
    )
    expect(sumRetentionHeld(rows)).toBe(660)
    expect(sumRetentionReleased(rows)).toBe(440)
  })

  it('NO DOUBLE COUNT: held and classified AP are disjoint and sum to the withholding', () => {
    const map = releasedByInvoiceId([release({ prev: 0, amount: 400 })])
    const rows = supplierInvoiceReconciliationRows([inv], pays, map)
    const held = sumRetentionHeld(rows)
    const cls = classifyInvoiceBalances(rows, NOW)
    const classified = cls.pastDue + cls.noDueDate
      + Object.values(cls.byMonth).reduce((s, v) => s + v, 0)

    // The released 440 appears in the AP classification ONCE and is absent from
    // the held figure.
    expect(classified).toBe(440)
    expect(held).toBe(660)
    expect(held + classified).toBe(inv.retentionTotal)
  })

  it('reports zero held once retention is fully released', () => {
    const map = releasedByInvoiceId([release({ prev: 0, amount: 1000 })])
    const rows = supplierInvoiceReconciliationRows([inv], pays, map)
    expect(sumRetentionHeld(rows)).toBe(0)
    expect(sumRetentionReleased(rows)).toBe(1100)
  })

  it('with zero releases reports the full withholding as held', () => {
    const rows = supplierInvoiceReconciliationRows([inv], pays)
    // The pre-ADR-30 figure was Σ retentionTotal — identical when nothing is released.
    expect(sumRetentionHeld(rows)).toBe(inv.retentionTotal)
    expect(sumRetentionHeld(rows)).toBe(1100)
    expect(sumRetentionReleased(rows)).toBe(0)
  })

  it('tolerates empty and malformed row sets', () => {
    expect(sumRetentionHeld([])).toBe(0)
    expect(sumRetentionHeld(null)).toBe(0)
    expect(sumRetentionReleased([{}])).toBe(0)
  })
})

// ── Purity ───────────────────────────────────────────────────────────────────

describe('purity', () => {
  it('never mutates its inputs', () => {
    const invs = [invoice()]
    const rels = [release({ prev: 0, amount: 400 })]
    const invBefore = JSON.stringify(invs)
    const relBefore = JSON.stringify(rels)

    retentionInvoiceRows(invs, rels)
    retentionBySupplier(invs, rels)
    retentionSummary(invs, rels)
    releasedByInvoiceId(rels)
    releasedExGstByInvoiceId(rels)
    releaseExceptions(rels, invs)
    validateReleaseDraft({
      supplierInvoiceId: 'si1', amount: 1, releaseDate: '2026-08-13',
      reason: 'x', invoices: invs, releases: rels,
    })

    expect(JSON.stringify(invs)).toBe(invBefore)
    expect(JSON.stringify(rels)).toBe(relBefore)
  })

  it('never throws on null/undefined/garbage input', () => {
    expect(() => retentionInvoiceRows(null, null)).not.toThrow()
    expect(() => retentionBySupplier(undefined, undefined)).not.toThrow()
    expect(() => retentionSummary([{}], [{}])).not.toThrow()
    expect(() => releaseExceptions(null, null)).not.toThrow()
    expect(() => overReleasedRows(null)).not.toThrow()
    expect(() => releasedByInvoiceId([{ status: 'posted' }])).not.toThrow()
  })
})
