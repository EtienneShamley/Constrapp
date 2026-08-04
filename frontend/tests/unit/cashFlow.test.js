import { describe, it, expect } from 'vitest'
import {
  isMonthKey, monthKeyFromDate, monthLabel, compareMonthKeys, monthKeyRange,
  currentMonthKey, cashInByMonth, cashOutByMonth, cashMonthSpan,
  totalActualCashIn, totalActualCashOut, actualNetCash, buildMonthlyActualRows,
  // Forecast (Branch 2)
  CFL_SOURCE_TYPE, CFL_IN_SOURCE_TYPES, CFL_OUT_SOURCE_TYPES,
  sourceTypesForDirection, isCoverageSourceType, isCostCodedSourceType,
  activeCashFlowLines, voidCashFlowLines, staleCashFlowLines,
  manualForecastByMonth, classifyInvoiceBalances, sumRetentionWithheld,
  buildMonthlyCombinedRows, projectedClosingPosition,
  coverageByType, committedCoverageByCostCode, ctcCoverageByCostCode,
  untimedForecastRevenue, untimedRemainingCommitted, untimedUncommittedCtc,
  revenueCoverage, costCoverage, COMPLETENESS_STATE, completenessState,
  peakFunding, peakFundingSuppression,
  gstSuggestedGross, coverageOverWarning, validateCashFlowLineDraft,
} from '../../src/lib/cashFlow'
import { cashInRows } from '../../src/lib/clientReceipts'
import { cashOutRows } from '../../src/lib/supplierPayments'

// ── Actual Cash Flow — pure-arithmetic unit tests ────────────────────────────
//
// These exercise lib/cashFlow.js plus the two cash-row adapters
// (lib/clientReceipts.js → cashInRows, lib/supplierPayments.js → cashOutRows)
// as plain functions — no React, no Firebase, no emulator. The Firestore Rules
// suite is separate (tests/rules/, npm run test:rules).
//
// Fixtures mirror the stored document shape the hooks write. `createdAt` and
// `postedAt` are deliberately set to MISLEADING months in several fixtures to
// prove that grouping reads receiptDate/paymentDate only.

let nextId = 0
const id = () => `doc${++nextId}`

function receipt(overrides = {}) {
  return {
    id: id(),
    receiptNumber: 'CR-0001',
    status: 'posted',
    docType: 'receipt',
    clientId: 'client1',
    clientName: 'Harbour Homes Pty Ltd',
    receiptDate: '2026-08-05',
    amount: 100,
    allocations: [],
    allocatedTotal: 0,
    unallocatedAmount: 100,
    currency: 'AUD',
    // Entry/commit facts — must never drive grouping.
    createdAt: { seconds: 1780000000 },
    postedAt: { seconds: 1780000001 },
    ...overrides,
  }
}

function payment(overrides = {}) {
  return {
    id: id(),
    paymentNumber: 'SP-0001',
    status: 'posted',
    docType: 'payment',
    supplierId: 'supplier1',
    supplierName: 'BuildCo Pty Ltd',
    paymentDate: '2026-08-10',
    amount: 100,
    allocations: [],
    allocatedTotal: 0,
    unallocatedAmount: 100,
    currency: 'AUD',
    createdAt: { seconds: 1780000000 },
    postedAt: { seconds: 1780000001 },
    ...overrides,
  }
}

const inRows = (receipts) => cashInRows(receipts, { projectId: 'projectA' })
const outRows = (payments) => cashOutRows(payments, { projectId: 'projectA' })

// ── Month-key helpers ────────────────────────────────────────────────────────

describe('month keys', () => {
  it('accepts valid YYYY-MM keys', () => {
    expect(isMonthKey('2026-01')).toBe(true)
    expect(isMonthKey('2026-12')).toBe(true)
  })

  it('rejects malformed keys', () => {
    expect(isMonthKey('2026-13')).toBe(false)
    expect(isMonthKey('2026-00')).toBe(false)
    expect(isMonthKey('2026-1')).toBe(false)
    expect(isMonthKey('202608')).toBe(false)
    expect(isMonthKey('')).toBe(false)
    expect(isMonthKey(null)).toBe(false)
    expect(isMonthKey(202608)).toBe(false)
  })

  it('derives a month key from a YYYY-MM-DD date', () => {
    expect(monthKeyFromDate('2026-08-05')).toBe('2026-08')
    expect(monthKeyFromDate('2026-12-31')).toBe('2026-12')
  })

  it('returns null for a malformed date', () => {
    expect(monthKeyFromDate('')).toBe(null)
    expect(monthKeyFromDate('2026-08')).toBe(null)
    expect(monthKeyFromDate('05/08/2026')).toBe(null)
    expect(monthKeyFromDate(null)).toBe(null)
  })

  it('labels months from a fixed lookup', () => {
    expect(monthLabel('2026-08')).toBe('Aug 2026')
    expect(monthLabel('2027-01')).toBe('Jan 2027')
    expect(monthLabel('bad')).toBe('—')
  })

  it('derives the current month from a supplied clock', () => {
    expect(currentMonthKey(new Date(2026, 7, 4))).toBe('2026-08')
  })
})

// ── Month ordering & dense ranges ────────────────────────────────────────────

describe('month ordering and ranges', () => {
  it('orders keys lexicographically (chronological for zero-padded ISO)', () => {
    const keys = ['2027-01', '2026-09', '2026-12', '2026-08']
    expect([...keys].sort(compareMonthKeys)).toEqual(['2026-08', '2026-09', '2026-12', '2027-01'])
  })

  it('builds a dense range within one year', () => {
    expect(monthKeyRange('2026-08', '2026-10')).toEqual(['2026-08', '2026-09', '2026-10'])
  })

  it('crosses the December-to-January boundary', () => {
    expect(monthKeyRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
  })

  it('returns a single month for equal bounds', () => {
    expect(monthKeyRange('2026-08', '2026-08')).toEqual(['2026-08'])
  })

  it('returns empty for inverted or invalid bounds', () => {
    expect(monthKeyRange('2026-10', '2026-08')).toEqual([])
    expect(monthKeyRange('bad', '2026-08')).toEqual([])
    expect(monthKeyRange('2026-08', 'bad')).toEqual([])
  })
})

// ── Cash In grouping ─────────────────────────────────────────────────────────

describe('actual Cash In grouping', () => {
  it('groups one posted receipt into its receiptDate month', () => {
    const rows = inRows([receipt({ receiptDate: '2026-08-05', amount: 1100 })])
    expect(cashInByMonth(rows)).toEqual({ '2026-08': 1100 })
  })

  it('sums two posted receipts in one month', () => {
    const rows = inRows([
      receipt({ receiptDate: '2026-08-05', amount: 1100 }),
      receipt({ receiptDate: '2026-08-20', amount: 550 }),
    ])
    expect(cashInByMonth(rows)).toEqual({ '2026-08': 1650 })
  })

  it('separates receipts across months', () => {
    const rows = inRows([
      receipt({ receiptDate: '2026-08-05', amount: 100 }),
      receipt({ receiptDate: '2026-09-05', amount: 200 }),
      receipt({ receiptDate: '2026-11-05', amount: 300 }),
    ])
    expect(cashInByMonth(rows)).toEqual({ '2026-08': 100, '2026-09': 200, '2026-11': 300 })
  })

  it('keeps the first and last day inside their month', () => {
    const rows = inRows([
      receipt({ receiptDate: '2026-08-01', amount: 10 }),
      receipt({ receiptDate: '2026-08-31', amount: 20 }),
      receipt({ receiptDate: '2026-09-01', amount: 40 }),
    ])
    expect(cashInByMonth(rows)).toEqual({ '2026-08': 30, '2026-09': 40 })
  })

  it('separates December from January across a year boundary', () => {
    const rows = inRows([
      receipt({ receiptDate: '2026-12-31', amount: 100 }),
      receipt({ receiptDate: '2027-01-01', amount: 200 }),
    ])
    expect(cashInByMonth(rows)).toEqual({ '2026-12': 100, '2027-01': 200 })
  })
})

// ── Cash Out grouping ────────────────────────────────────────────────────────

describe('actual Cash Out grouping', () => {
  it('groups one posted payment into its paymentDate month', () => {
    const rows = outRows([payment({ paymentDate: '2026-08-10', amount: 990 })])
    expect(cashOutByMonth(rows)).toEqual({ '2026-08': 990 })
  })

  it('sums two posted payments in one month', () => {
    const rows = outRows([
      payment({ paymentDate: '2026-08-02', amount: 990 }),
      payment({ paymentDate: '2026-08-28', amount: 10 }),
    ])
    expect(cashOutByMonth(rows)).toEqual({ '2026-08': 1000 })
  })

  it('separates payments across months', () => {
    const rows = outRows([
      payment({ paymentDate: '2026-07-15', amount: 50 }),
      payment({ paymentDate: '2026-10-15', amount: 75 }),
    ])
    expect(cashOutByMonth(rows)).toEqual({ '2026-07': 50, '2026-10': 75 })
  })

  it('keeps the first and last day inside their month', () => {
    const rows = outRows([
      payment({ paymentDate: '2026-06-01', amount: 5 }),
      payment({ paymentDate: '2026-06-30', amount: 6 }),
    ])
    expect(cashOutByMonth(rows)).toEqual({ '2026-06': 11 })
  })

  it('separates December from January across a year boundary', () => {
    const rows = outRows([
      payment({ paymentDate: '2026-12-31', amount: 1 }),
      payment({ paymentDate: '2027-01-01', amount: 2 }),
    ])
    expect(cashOutByMonth(rows)).toEqual({ '2026-12': 1, '2027-01': 2 })
  })
})

// ── Statuses ─────────────────────────────────────────────────────────────────

describe('statuses — only posted counts', () => {
  it('counts posted transactions', () => {
    expect(totalActualCashIn(inRows([receipt({ status: 'posted', amount: 100 })]))).toBe(100)
    expect(totalActualCashOut(outRows([payment({ status: 'posted', amount: 200 })]))).toBe(200)
  })

  it('excludes drafts', () => {
    expect(inRows([receipt({ status: 'draft' })])).toEqual([])
    expect(outRows([payment({ status: 'draft' })])).toEqual([])
  })

  it('excludes voids', () => {
    expect(inRows([receipt({ status: 'void', voidReason: 'keyed twice' })])).toEqual([])
    expect(outRows([payment({ status: 'void', voidReason: 'keyed twice' })])).toEqual([])
  })

  it('excludes a payment that was posted and later voided', () => {
    // Voiding a posted payment keeps its postedAt stamp; status alone decides.
    const voided = payment({
      status: 'void',
      postedAt: { seconds: 1780000001 },
      voidedAt: { seconds: 1780500000 },
      voidReason: 'paid the wrong supplier',
    })
    expect(outRows([voided])).toEqual([])
    expect(totalActualCashOut(outRows([voided]))).toBe(0)
  })

  it('mixes statuses correctly', () => {
    const rows = inRows([
      receipt({ status: 'posted', amount: 100 }),
      receipt({ status: 'draft', amount: 999 }),
      receipt({ status: 'void', amount: 999 }),
    ])
    expect(rows).toHaveLength(1)
    expect(totalActualCashIn(rows)).toBe(100)
  })
})

// ── Unallocated cash ─────────────────────────────────────────────────────────

describe('unallocated cash counts its full amount', () => {
  it('counts a fully unallocated receipt in full', () => {
    const rows = inRows([receipt({ amount: 5000, allocatedTotal: 0, unallocatedAmount: 5000 })])
    expect(totalActualCashIn(rows)).toBe(5000)
    expect(cashInByMonth(rows)).toEqual({ '2026-08': 5000 })
  })

  it('counts a partly allocated receipt in full', () => {
    const rows = inRows([receipt({ amount: 5000, allocatedTotal: 3000, unallocatedAmount: 2000 })])
    expect(totalActualCashIn(rows)).toBe(5000)
  })

  it('counts a fully unallocated payment in full', () => {
    const rows = outRows([payment({ amount: 4400, allocatedTotal: 0, unallocatedAmount: 4400 })])
    expect(totalActualCashOut(rows)).toBe(4400)
    expect(cashOutByMonth(rows)).toEqual({ '2026-08': 4400 })
  })

  it('counts a partly allocated payment in full', () => {
    const rows = outRows([payment({ amount: 4400, allocatedTotal: 4000, unallocatedAmount: 400 })])
    expect(totalActualCashOut(rows)).toBe(4400)
  })

  it('never uses allocatedTotal as the cash figure', () => {
    const r = inRows([receipt({ amount: 1000, allocatedTotal: 250, unallocatedAmount: 750 })])
    const p = outRows([payment({ amount: 2000, allocatedTotal: 1, unallocatedAmount: 1999 })])
    expect(totalActualCashIn(r)).toBe(1000)
    expect(totalActualCashOut(p)).toBe(2000)
    // The split still travels alongside for analysis.
    expect(r[0].allocatedTotal).toBe(250)
    expect(r[0].unallocatedAmount).toBe(750)
    expect(p[0].allocatedTotal).toBe(1)
    expect(p[0].unallocatedAmount).toBe(1999)
  })
})

// ── Date discipline ──────────────────────────────────────────────────────────

describe('date discipline — transaction date only', () => {
  it('groups a receipt by receiptDate even when created/posted in another month', () => {
    // createdAt/postedAt land in ~2026-06 epoch seconds; receiptDate is May.
    const rows = inRows([receipt({
      receiptDate: '2026-05-31',
      createdAt: { seconds: 1782000000 },
      postedAt: { seconds: 1782000001 },
    })])
    expect(Object.keys(cashInByMonth(rows))).toEqual(['2026-05'])
  })

  it('groups a payment by paymentDate even when created/posted in another month', () => {
    const rows = outRows([payment({
      paymentDate: '2026-04-01',
      createdAt: { seconds: 1782000000 },
      postedAt: { seconds: 1782000001 },
    })])
    expect(Object.keys(cashOutByMonth(rows))).toEqual(['2026-04'])
  })

  it('backdated transactions land in the backdated month', () => {
    const rows = inRows([receipt({ receiptDate: '2025-01-15', amount: 10 })])
    expect(cashInByMonth(rows)).toEqual({ '2025-01': 10 })
  })
})

// ── Monthly rows: ordering, gaps, span ───────────────────────────────────────

describe('monthly actual rows', () => {
  it('orders months lexically across a year boundary', () => {
    const rows = buildMonthlyActualRows(
      inRows([
        receipt({ receiptDate: '2027-01-10', amount: 100 }),
        receipt({ receiptDate: '2026-11-10', amount: 100 }),
      ]),
      outRows([payment({ paymentDate: '2026-12-10', amount: 50 })]),
    )
    expect(rows.map(r => r.monthKey)).toEqual(['2026-11', '2026-12', '2027-01'])
  })

  it('fills a missing-month gap with a zero row', () => {
    const rows = buildMonthlyActualRows(
      inRows([
        receipt({ receiptDate: '2026-08-01', amount: 100 }),
        receipt({ receiptDate: '2026-10-01', amount: 100 }),
      ]),
      outRows([]),
    )
    expect(rows.map(r => r.monthKey)).toEqual(['2026-08', '2026-09', '2026-10'])
    expect(rows[1]).toEqual({
      monthKey: '2026-09',
      actualCashIn: 0,
      actualCashOut: 0,
      actualNet: 0,
      cumulativePosition: 100,
    })
  })

  it('produces a single row for a one-month range', () => {
    const rows = buildMonthlyActualRows(
      inRows([receipt({ receiptDate: '2026-08-05', amount: 300 })]),
      outRows([payment({ paymentDate: '2026-08-20', amount: 100 })]),
    )
    expect(rows).toEqual([{
      monthKey: '2026-08',
      actualCashIn: 300,
      actualCashOut: 100,
      actualNet: 200,
      cumulativePosition: 200,
    }])
  })

  it('returns an empty array when there is no posted cash', () => {
    expect(buildMonthlyActualRows(inRows([]), outRows([]))).toEqual([])
    expect(buildMonthlyActualRows(
      inRows([receipt({ status: 'draft' })]),
      outRows([payment({ status: 'void', voidReason: 'x' })]),
    )).toEqual([])
  })

  it('spans from the earliest to the latest posted-cash month across directions', () => {
    const span = cashMonthSpan(
      inRows([receipt({ receiptDate: '2026-09-01' })]),
      outRows([payment({ paymentDate: '2026-06-01' }), payment({ paymentDate: '2026-12-01' })]),
    )
    expect(span).toEqual({ earliest: '2026-06', latest: '2026-12' })
    expect(cashMonthSpan(inRows([]), outRows([]))).toBe(null)
  })
})

// ── Cumulative totals ────────────────────────────────────────────────────────

describe('cumulative position (from a zero opening position)', () => {
  it('accumulates a positive sequence', () => {
    const rows = buildMonthlyActualRows(
      inRows([
        receipt({ receiptDate: '2026-08-01', amount: 100 }),
        receipt({ receiptDate: '2026-09-01', amount: 200 }),
      ]),
      outRows([]),
    )
    expect(rows.map(r => r.cumulativePosition)).toEqual([100, 300])
  })

  it('goes negative when cash out leads', () => {
    const rows = buildMonthlyActualRows(
      inRows([receipt({ receiptDate: '2026-09-01', amount: 50 })]),
      outRows([payment({ paymentDate: '2026-08-01', amount: 200 })]),
    )
    expect(rows.map(r => r.actualNet)).toEqual([-200, 50])
    expect(rows.map(r => r.cumulativePosition)).toEqual([-200, -150])
  })

  it('recovers after a negative month', () => {
    const rows = buildMonthlyActualRows(
      inRows([receipt({ receiptDate: '2026-09-01', amount: 500 })]),
      outRows([payment({ paymentDate: '2026-08-01', amount: 200 })]),
    )
    expect(rows.map(r => r.cumulativePosition)).toEqual([-200, 300])
  })

  it('a zero gap month leaves the cumulative unchanged', () => {
    const rows = buildMonthlyActualRows(
      inRows([
        receipt({ receiptDate: '2026-08-01', amount: 100 }),
        receipt({ receiptDate: '2026-10-01', amount: 100 }),
      ]),
      outRows([]),
    )
    expect(rows.map(r => r.cumulativePosition)).toEqual([100, 100, 200])
  })

  it('an empty result carries no cumulative rows', () => {
    expect(buildMonthlyActualRows([], [])).toEqual([])
  })

  it('the first month starts from zero, not from an opening balance', () => {
    const rows = buildMonthlyActualRows(
      inRows([receipt({ receiptDate: '2026-08-01', amount: 40 })]),
      outRows([payment({ paymentDate: '2026-08-02', amount: 100 })]),
    )
    // 0 + (40 − 100) = −60: the opening position is zero by construction.
    expect(rows[0].cumulativePosition).toBe(-60)
  })
})

// ── Totals & net ─────────────────────────────────────────────────────────────

describe('whole-project totals', () => {
  it('computes Actual Net Cash = Cash In − Cash Out', () => {
    expect(actualNetCash(1000, 400)).toBe(600)
    expect(actualNetCash(400, 1000)).toBe(-600)
    expect(actualNetCash(0, 0)).toBe(0)
  })

  it('totals are independent of month grouping', () => {
    const r = inRows([receipt({ amount: 1.05 }), receipt({ amount: 2.1 })])
    expect(totalActualCashIn(r)).toBe(3.15)
  })
})

// ── Rounding ─────────────────────────────────────────────────────────────────

describe('cent arithmetic', () => {
  it('0.10 + 0.20 equals 0.30', () => {
    const rows = inRows([
      receipt({ receiptDate: '2026-08-01', amount: 0.10 }),
      receipt({ receiptDate: '2026-08-02', amount: 0.20 }),
    ])
    expect(cashInByMonth(rows)).toEqual({ '2026-08': 0.30 })
    expect(totalActualCashIn(rows)).toBe(0.30)
  })

  it('repeated cent additions stay cent-correct', () => {
    const receipts = Array.from({ length: 100 }, () => receipt({ receiptDate: '2026-08-15', amount: 0.01 }))
    const rows = inRows(receipts)
    expect(totalActualCashIn(rows)).toBe(1)
    expect(cashInByMonth(rows)).toEqual({ '2026-08': 1 })
  })

  it('applies roundMoney through the cumulative chain', () => {
    const rows = buildMonthlyActualRows(
      inRows([
        receipt({ receiptDate: '2026-08-01', amount: 0.1 }),
        receipt({ receiptDate: '2026-09-01', amount: 0.2 }),
      ]),
      outRows([payment({ paymentDate: '2026-09-02', amount: 0.05 })]),
    )
    expect(rows[0].cumulativePosition).toBe(0.1)
    expect(rows[1].actualNet).toBe(0.15)
    expect(rows[1].cumulativePosition).toBe(0.25)
  })
})

// ── Purity ───────────────────────────────────────────────────────────────────

describe('purity — inputs are never mutated', () => {
  it('adapters and aggregation leave frozen inputs untouched', () => {
    const receipts = [receipt({ receiptDate: '2026-08-01' }), receipt({ status: 'draft' })]
    const payments = [payment({ paymentDate: '2026-09-01' }), payment({ status: 'void', voidReason: 'x' })]
    receipts.forEach(Object.freeze)
    payments.forEach(Object.freeze)
    Object.freeze(receipts)
    Object.freeze(payments)

    const r = cashInRows(receipts, { projectId: 'p' })
    const p = cashOutRows(payments, { projectId: 'p' })
    const rows = buildMonthlyActualRows(r, p)
    Object.freeze(r)
    Object.freeze(p)

    expect(() => buildMonthlyActualRows(r, p)).not.toThrow()
    expect(rows).toHaveLength(2)
    expect(totalActualCashIn(r)).toBe(100)
    expect(totalActualCashOut(p)).toBe(100)
    // The frozen sources are untouched.
    expect(receipts[0].amount).toBe(100)
    expect(payments[0].amount).toBe(100)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// FORECAST CASH FLOW (Branch 2)
// ═════════════════════════════════════════════════════════════════════════════
//
// Fixtures for the forecast layers. `NOW` is a fixed current month so every
// boundary assertion is deterministic. AR/AP rows mirror the shape of
// clientInvoiceReconciliationRows / supplierInvoiceReconciliationRows (only the
// fields the forecast reads); cashFlowLines mirror the stored document shape.

const NOW = '2026-08'

function arRow(overrides = {}) {
  return { id: id(), invoiceNumber: 'CI-0001', dueDate: '2026-09-15', remaining: 1100, ...overrides }
}

function apRow(overrides = {}) {
  return { id: id(), invoiceNumber: 'SI-0001', dueDate: '2026-09-20', remaining: 990, retentionTotal: 0, ...overrides }
}

function line(overrides = {}) {
  return {
    id: id(),
    monthKey: '2026-10',
    direction: 'in',
    basis: 'gross',
    amount: 1100,
    sourceAmountExGst: 1000,
    sourceType: 'contract_revenue',
    sourceRef: '',
    counterpartyName: '',
    costCodeId: null,
    costCodeName: '',
    description: 'Timed remaining contract value',
    notes: '',
    status: 'active',
    voidReason: '',
    ...overrides,
  }
}

const outLine = (overrides = {}) => line({
  direction: 'out',
  sourceType: 'remaining_committed',
  costCodeId: 'cc1',
  costCodeName: '03-100 — Concrete Slab',
  amount: 990,
  sourceAmountExGst: 900,
  description: 'Timed remaining commitment',
  ...overrides,
})

// ── Source-type vocabulary ───────────────────────────────────────────────────

describe('source types', () => {
  it('allows exactly contract_revenue and manual for cash in', () => {
    expect(CFL_IN_SOURCE_TYPES).toEqual(['contract_revenue', 'manual'])
    expect(sourceTypesForDirection('in')).toEqual(CFL_IN_SOURCE_TYPES)
  })

  it('allows exactly the three cost sources plus manual for cash out', () => {
    expect(CFL_OUT_SOURCE_TYPES).toEqual(['uninvoiced_claim', 'remaining_committed', 'uncommitted_ctc', 'manual'])
    expect(sourceTypesForDirection('out')).toEqual(CFL_OUT_SOURCE_TYPES)
  })

  it('reserves no invoice source types — invoices are timed automatically', () => {
    expect(Object.values(CFL_SOURCE_TYPE)).not.toContain('client_invoice')
    expect(Object.values(CFL_SOURCE_TYPE)).not.toContain('supplier_invoice')
  })

  it('classifies coverage and cost-coded types', () => {
    expect(isCoverageSourceType('contract_revenue')).toBe(true)
    expect(isCoverageSourceType('manual')).toBe(false)
    expect(isCostCodedSourceType('remaining_committed')).toBe(true)
    expect(isCostCodedSourceType('uninvoiced_claim')).toBe(true)
    expect(isCostCodedSourceType('uncommitted_ctc')).toBe(true)
    expect(isCostCodedSourceType('contract_revenue')).toBe(false)
    expect(isCostCodedSourceType('manual')).toBe(false)
  })
})

// ── Invoice-based forecast (layer 2) ─────────────────────────────────────────

describe('automatic AR forecast — issued client invoice balances', () => {
  it('times a positive remaining balance to its due month', () => {
    const r = classifyInvoiceBalances([arRow({ dueDate: '2026-09-15', remaining: 1100 })], NOW)
    expect(r.byMonth).toEqual({ '2026-09': 1100 })
    expect(r.pastDue).toBe(0)
    expect(r.noDueDate).toBe(0)
  })

  it('sums two invoices due in one month', () => {
    const r = classifyInvoiceBalances([
      arRow({ dueDate: '2026-09-01', remaining: 100 }),
      arRow({ dueDate: '2026-09-28', remaining: 200 }),
    ], NOW)
    expect(r.byMonth).toEqual({ '2026-09': 300 })
  })

  it('excludes a fully reconciled (zero-remaining) invoice entirely', () => {
    const r = classifyInvoiceBalances([arRow({ remaining: 0 })], NOW)
    expect(r.byMonth).toEqual({})
    expect(r.pastDue).toBe(0)
    expect(r.noDueDate).toBe(0)
    expect(r.overReconciled).toBe(0)
  })

  it('forecasts only the remainder of a partly reconciled invoice', () => {
    // grossTotal 1100, received 400 → remaining 700 is what the caller passes.
    const r = classifyInvoiceBalances([arRow({ remaining: 700 })], NOW)
    expect(r.byMonth).toEqual({ '2026-09': 700 })
  })

  it('excludes over-reconciled balances from every month into a signed total', () => {
    const r = classifyInvoiceBalances([
      arRow({ dueDate: '2026-09-15', remaining: -50 }),
      arRow({ dueDate: '2026-10-15', remaining: 500 }),
    ], NOW)
    expect(r.byMonth).toEqual({ '2026-10': 500 })
    expect(r.overReconciled).toBe(-50)
  })

  it('a negative balance never offsets another invoice in the same month', () => {
    const r = classifyInvoiceBalances([
      arRow({ dueDate: '2026-09-15', remaining: 500 }),
      arRow({ dueDate: '2026-09-20', remaining: -200 }),
    ], NOW)
    expect(r.byMonth).toEqual({ '2026-09': 500 })
    expect(r.overReconciled).toBe(-200)
  })
})

describe('automatic AP forecast — posted supplier invoice payable balances', () => {
  it('times a positive remaining payable to its due month', () => {
    const r = classifyInvoiceBalances([apRow({ dueDate: '2026-10-05', remaining: 990 })], NOW)
    expect(r.byMonth).toEqual({ '2026-10': 990 })
  })

  it('uses the payable remainder supplied by the caller — retention already excluded', () => {
    // payableTotal 990 (gross 1100 − retention 110), paid 490 → remaining 500.
    const r = classifyInvoiceBalances([apRow({ remaining: 500, retentionTotal: 110 })], NOW)
    expect(r.byMonth).toEqual({ '2026-09': 500 })
  })

  it('sums retention withheld across AP rows for the standing warning', () => {
    expect(sumRetentionWithheld([
      apRow({ retentionTotal: 110 }),
      apRow({ retentionTotal: 55 }),
      apRow({ retentionTotal: 0 }),
    ])).toBe(165)
    expect(sumRetentionWithheld([])).toBe(0)
  })
})

describe('due-date grouping', () => {
  it('derives the due month with slice(0,7)', () => {
    const r = classifyInvoiceBalances([
      arRow({ dueDate: '2026-09-01', remaining: 10 }),
      arRow({ dueDate: '2026-09-30', remaining: 20 }),
    ], NOW)
    expect(r.byMonth).toEqual({ '2026-09': 30 })
  })

  it('separates December from January across a year boundary', () => {
    const r = classifyInvoiceBalances([
      arRow({ dueDate: '2026-12-31', remaining: 1 }),
      arRow({ dueDate: '2027-01-01', remaining: 2 }),
    ], NOW)
    expect(r.byMonth).toEqual({ '2026-12': 1, '2027-01': 2 })
  })
})

describe('past-due and no-due-date treatment', () => {
  it('routes a past-due balance to the pastDue bucket, never a month', () => {
    const r = classifyInvoiceBalances([arRow({ dueDate: '2026-07-15', remaining: 800 })], NOW)
    expect(r.byMonth).toEqual({})
    expect(r.pastDue).toBe(800)
  })

  it('is MONTH-level, not day-level: due earlier in the current month is still timed', () => {
    // 2026-08-01 is "past due" day-level by mid-August, but its MONTH is the
    // current month, so it is automatically timed — not stranded.
    const r = classifyInvoiceBalances([arRow({ dueDate: '2026-08-01', remaining: 300 })], NOW)
    expect(r.byMonth).toEqual({ '2026-08': 300 })
    expect(r.pastDue).toBe(0)
  })

  it('routes a blank due date to the noDueDate bucket', () => {
    const r = classifyInvoiceBalances([arRow({ dueDate: '', remaining: 400 })], NOW)
    expect(r.byMonth).toEqual({})
    expect(r.noDueDate).toBe(400)
  })

  it('treats a malformed due date as no due date', () => {
    const r = classifyInvoiceBalances([arRow({ dueDate: '15/09/2026', remaining: 400 })], NOW)
    expect(r.noDueDate).toBe(400)
  })
})

// ── Manual lines (layer 3) ───────────────────────────────────────────────────

describe('manual timing lines', () => {
  it('lands an active in-line in its monthKey', () => {
    expect(manualForecastByMonth([line({ monthKey: '2026-10', amount: 1100 })], 'in', NOW))
      .toEqual({ '2026-10': 1100 })
  })

  it('lands an active out-line in its monthKey', () => {
    expect(manualForecastByMonth([outLine({ monthKey: '2026-11', amount: 990 })], 'out', NOW))
      .toEqual({ '2026-11': 990 })
  })

  it('sums several lines in one month and separates directions', () => {
    const lines = [
      line({ monthKey: '2026-10', amount: 100 }),
      line({ monthKey: '2026-10', amount: 200, sourceType: 'manual', sourceAmountExGst: null }),
      outLine({ monthKey: '2026-10', amount: 50 }),
    ]
    expect(manualForecastByMonth(lines, 'in', NOW)).toEqual({ '2026-10': 300 })
    expect(manualForecastByMonth(lines, 'out', NOW)).toEqual({ '2026-10': 50 })
  })

  it('a current-month line counts', () => {
    expect(manualForecastByMonth([line({ monthKey: NOW, amount: 10 })], 'in', NOW))
      .toEqual({ [NOW]: 10 })
  })

  it('excludes void lines from months and coverage', () => {
    const voided = line({ status: 'void', voidReason: 'superseded' })
    expect(manualForecastByMonth([voided], 'in', NOW)).toEqual({})
    expect(coverageByType([voided], 'contract_revenue')).toBe(0)
    expect(activeCashFlowLines([voided])).toEqual([])
    expect(voidCashFlowLines([voided])).toHaveLength(1)
  })
})

// ── Stale lines & the actual/forecast boundary ───────────────────────────────

describe('stale lines and the boundary rule', () => {
  it('an active line in a past month is stale and contributes to no month', () => {
    const stale = line({ monthKey: '2026-07', amount: 500 })
    expect(manualForecastByMonth([stale], 'in', NOW)).toEqual({})
    expect(staleCashFlowLines([stale], NOW)).toHaveLength(1)
  })

  it('a line becomes stale as the current month advances', () => {
    const l = line({ monthKey: '2026-09' })
    expect(staleCashFlowLines([l], '2026-08')).toHaveLength(0)  // future: counts
    expect(staleCashFlowLines([l], '2026-09')).toHaveLength(0)  // current: counts
    expect(staleCashFlowLines([l], '2026-10')).toHaveLength(1)  // past: stale
    expect(manualForecastByMonth([l], 'in', '2026-10')).toEqual({})
  })

  it('a stale line is excluded from projected totals but never deleted from the list', () => {
    const stale = line({ monthKey: '2026-06', amount: 999 })
    const rows = buildMonthlyCombinedRows({
      inRows: inRows([receipt({ receiptDate: '2026-06-10', amount: 100 })]),
      manualInByMonth: manualForecastByMonth([stale], 'in', NOW),
      nowMonth: NOW,
    })
    const june = rows.find(r => r.monthKey === '2026-06')
    expect(june.forecastCashIn).toBe(0)          // boundary: past months actual-only
    expect(june.actualCashIn).toBe(100)
    expect(activeCashFlowLines([stale])).toHaveLength(1) // still present, just stale
  })

  it('a voided stale line leaves the stale panel', () => {
    const voided = line({ monthKey: '2026-06', status: 'void', voidReason: 'no longer expected' })
    expect(staleCashFlowLines([voided], NOW)).toHaveLength(0)
  })

  it('a retimed stale line re-enters the forecast in its new month', () => {
    const retimed = line({ monthKey: '2026-10' }) // was 2026-06, edited forward
    expect(staleCashFlowLines([retimed], NOW)).toHaveLength(0)
    expect(manualForecastByMonth([retimed], 'in', NOW)).toEqual({ '2026-10': 1100 })
  })
})

// ── Combined monthly rows ────────────────────────────────────────────────────

describe('combined monthly rows (actual + forecast)', () => {
  const actualJunIn = () => inRows([receipt({ receiptDate: '2026-06-10', amount: 1000 })])

  it('past months are actual-only even when forecast maps carry past keys', () => {
    const rows = buildMonthlyCombinedRows({
      inRows: actualJunIn(),
      arForecastByMonth: { '2026-06': 500 }, // defensive: classify never emits past keys
      nowMonth: NOW,
    })
    const june = rows.find(r => r.monthKey === '2026-06')
    expect(june.isPast).toBe(true)
    expect(june.forecastCashIn).toBe(0)
    expect(june.totalCashIn).toBe(1000)
  })

  it('the current month combines actual and forecast', () => {
    const rows = buildMonthlyCombinedRows({
      inRows: inRows([receipt({ receiptDate: '2026-08-02', amount: 100 })]),
      arForecastByMonth: { '2026-08': 400 },
      manualInByMonth: { '2026-08': 50 },
      nowMonth: NOW,
    })
    const current = rows.find(r => r.monthKey === NOW)
    expect(current.isCurrent).toBe(true)
    expect(current.actualCashIn).toBe(100)
    expect(current.forecastCashIn).toBe(450)
    expect(current.totalCashIn).toBe(550)
  })

  it('future months combine automatic and manual forecast', () => {
    const rows = buildMonthlyCombinedRows({
      apForecastByMonth: { '2026-10': 990 },
      manualOutByMonth: { '2026-10': 10 },
      nowMonth: NOW,
    })
    const oct = rows.find(r => r.monthKey === '2026-10')
    expect(oct.forecastCashOut).toBe(1000)
    expect(oct.net).toBe(-1000)
  })

  it('spans densely from earliest actual to latest forecast with zero gap rows', () => {
    const rows = buildMonthlyCombinedRows({
      inRows: actualJunIn(),
      arForecastByMonth: { '2026-11': 700 },
      nowMonth: NOW,
    })
    expect(rows.map(r => r.monthKey)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'])
    const sep = rows.find(r => r.monthKey === '2026-09')
    expect(sep.totalCashIn).toBe(0)
    expect(sep.totalCashOut).toBe(0)
    expect(sep.cumulativePosition).toBe(1000) // gap month leaves cumulative unchanged
  })

  it('always includes the current month when any data exists', () => {
    const rows = buildMonthlyCombinedRows({ inRows: actualJunIn(), nowMonth: NOW })
    expect(rows.map(r => r.monthKey)).toContain(NOW)
  })

  it('returns empty with no data at all', () => {
    expect(buildMonthlyCombinedRows({ nowMonth: NOW })).toEqual([])
    expect(projectedClosingPosition([])).toBe(null)
  })

  it('accumulates the projected cumulative position from zero across the boundary', () => {
    const rows = buildMonthlyCombinedRows({
      inRows: actualJunIn(),                                   // +1000 Jun (actual)
      outRows: outRows([payment({ paymentDate: '2026-07-10', amount: 1500 })]), // −1500 Jul
      arForecastByMonth: { '2026-09': 2000 },                  // +2000 Sep (forecast)
      manualOutByMonth: { '2026-10': 700 },                    // −700 Oct (manual)
      nowMonth: NOW,
    })
    expect(rows.map(r => r.cumulativePosition)).toEqual([1000, -500, -500, 1500, 800])
  })

  it('projected closing position equals the final cumulative value', () => {
    const rows = buildMonthlyCombinedRows({
      inRows: actualJunIn(),
      manualOutByMonth: { '2026-09': 250 },
      nowMonth: NOW,
    })
    expect(projectedClosingPosition(rows)).toBe(750)
    expect(rows[rows.length - 1].cumulativePosition).toBe(750)
  })
})

// ── No double counting ───────────────────────────────────────────────────────

describe('no double counting', () => {
  it('an invoice balance appears exactly once — in its due month', () => {
    const ar = classifyInvoiceBalances([arRow({ dueDate: '2026-09-15', remaining: 1100 })], NOW)
    const total = Object.values(ar.byMonth).reduce((s, v) => s + v, 0)
      + ar.pastDue + ar.noDueDate
    expect(total).toBe(1100)
  })

  it('uninvoiced_claim coverage counts against the SAME committed balance (corrected model)', () => {
    const lines = [
      outLine({ sourceType: 'remaining_committed', costCodeId: 'cc1', sourceAmountExGst: 600 }),
      outLine({ sourceType: 'uninvoiced_claim', costCodeId: 'cc1', sourceAmountExGst: 300 }),
    ]
    expect(committedCoverageByCostCode(lines)).toEqual({ cc1: 900 })
    // Untimed committed subtracts BOTH coverages from ONE denominator.
    expect(untimedRemainingCommitted({ remainingCommittedTotal: 1000, lines })).toBe(100)
  })

  it('uninvoiced-claim cost is never an additive second denominator', () => {
    // D_cost = remainingCommitted + uncommittedCtc — nothing else.
    const r = costCoverage({ remainingCommittedTotal: 1000, uncommittedCtcTotal: 500, lines: [] })
    expect(r.pct).toBe(0)
    const covered = costCoverage({
      remainingCommittedTotal: 1000, uncommittedCtcTotal: 500,
      lines: [
        outLine({ sourceType: 'uninvoiced_claim', costCodeId: 'cc1', sourceAmountExGst: 750 }),
        outLine({ sourceType: 'uncommitted_ctc', costCodeId: 'cc2', sourceAmountExGst: 375 }),
      ],
    })
    expect(covered.pct).toBe(75) // (750 + 375) / 1500
  })

  it('client variations never add a second revenue source — coverage keys on contract_revenue only', () => {
    // A CV-linked line is STILL sourceType contract_revenue (CV is a sourceRef
    // label only), so its coverage counts once against availableToInvoice.
    const lines = [
      line({ sourceAmountExGst: 400, sourceRef: 'CV-0003' }),
      line({ sourceAmountExGst: 600 }),
    ]
    expect(coverageByType(lines, 'contract_revenue')).toBe(1000)
    expect(untimedForecastRevenue({ availableToInvoice: 1000, lines })).toBe(0)
  })
})

// ── Source coverage & untimed values ─────────────────────────────────────────

describe('source coverage', () => {
  it('sums coverage per type across active lines only', () => {
    const lines = [
      line({ sourceAmountExGst: 300 }),
      line({ sourceAmountExGst: 200 }),
      line({ sourceAmountExGst: 999, status: 'void', voidReason: 'x' }),
      line({ sourceType: 'manual', sourceAmountExGst: null }),
    ]
    expect(coverageByType(lines, 'contract_revenue')).toBe(500)
  })

  it('splits one cost code across months while coverage still sums', () => {
    const lines = [
      outLine({ monthKey: '2026-09', sourceAmountExGst: 400 }),
      outLine({ monthKey: '2026-11', sourceAmountExGst: 350 }),
    ]
    expect(committedCoverageByCostCode(lines)).toEqual({ cc1: 750 })
  })

  it('separates ctc coverage from committed coverage', () => {
    const lines = [
      outLine({ sourceType: 'uncommitted_ctc', costCodeId: 'cc9', sourceAmountExGst: 120 }),
      outLine({ costCodeId: 'cc9', sourceAmountExGst: 80 }),
    ]
    expect(ctcCoverageByCostCode(lines)).toEqual({ cc9: 120 })
    expect(committedCoverageByCostCode(lines)).toEqual({ cc9: 80 })
    expect(untimedUncommittedCtc({ uncommittedCtcTotal: 200, lines })).toBe(80)
  })

  it('untimed values floor at zero when coverage exceeds the balance', () => {
    const lines = [line({ sourceAmountExGst: 5000 })]
    expect(untimedForecastRevenue({ availableToInvoice: 1000, lines })).toBe(0)
  })

  it('an over-invoiced contract has no revenue left to time', () => {
    expect(untimedForecastRevenue({ availableToInvoice: -500, lines: [] })).toBe(0)
  })
})

describe('over-coverage warning (warned, never blocked)', () => {
  const balances = {
    availableToInvoice: 1000,
    remainingCommittedByCostCode: { cc1: 800 },
    uncommittedCtcByCostCode: { cc1: 200 },
  }

  it('warns when combined committed + claim coverage exceeds the shared balance', () => {
    const existing = [outLine({ sourceType: 'uninvoiced_claim', costCodeId: 'cc1', sourceAmountExGst: 500 })]
    const w = coverageOverWarning({
      sourceType: 'remaining_committed', costCodeId: 'cc1',
      sourceAmountExGst: 400, lines: existing, balances,
    })
    expect(w).not.toBe(null)
    expect(w.excess).toBe(100) // 500 + 400 − 800
  })

  it('does not warn within the balance, and excludes the line being edited', () => {
    const existing = [outLine({ id: 'editing', costCodeId: 'cc1', sourceAmountExGst: 800 })]
    const w = coverageOverWarning({
      sourceType: 'remaining_committed', costCodeId: 'cc1',
      sourceAmountExGst: 800, lines: existing, excludeLineId: 'editing', balances,
    })
    expect(w).toBe(null)
  })

  it('warns on contract-revenue over-coverage against availableToInvoice', () => {
    const w = coverageOverWarning({
      sourceType: 'contract_revenue', costCodeId: null,
      sourceAmountExGst: 1200, lines: [], balances,
    })
    expect(w.excess).toBe(200)
  })

  it('never warns for manual lines', () => {
    expect(coverageOverWarning({ sourceType: 'manual', sourceAmountExGst: null, lines: [], balances })).toBe(null)
  })
})

// ── Completeness ─────────────────────────────────────────────────────────────

describe('completeness', () => {
  it('revenue coverage is null — never 0% or 100% — without a baseline', () => {
    const r = revenueCoverage({ baselineEstablished: false, availableToInvoice: 1000, lines: [] })
    expect(r.pct).toBe(null)
    expect(r.state).toBe('no_baseline')
  })

  it('revenue coverage is null when the contract is fully or over-invoiced', () => {
    expect(revenueCoverage({ baselineEstablished: true, availableToInvoice: 0, lines: [] }).state).toBe('over_invoiced')
    expect(revenueCoverage({ baselineEstablished: true, availableToInvoice: -100, lines: [] }).pct).toBe(null)
  })

  it('computes revenue coverage percentage', () => {
    const r = revenueCoverage({
      baselineEstablished: true, availableToInvoice: 1000,
      lines: [line({ sourceAmountExGst: 250 })],
    })
    expect(r.pct).toBe(25)
    expect(r.state).toBe('ok')
  })

  it('cost coverage is null with no cost basis', () => {
    const r = costCoverage({ remainingCommittedTotal: 0, uncommittedCtcTotal: 0, lines: [] })
    expect(r.pct).toBe(null)
    expect(r.state).toBe('no_cost_basis')
  })

  it('flags an incomplete cost basis when cost codes remain unforecast', () => {
    const r = costCoverage({ remainingCommittedTotal: 1000, uncommittedCtcTotal: 0, unforecastedCount: 3, lines: [] })
    expect(r.incompleteBasis).toBe(true)
    expect(r.pct).toBe(0)
  })

  it('reports COMPLETE only at full coverage with no untimed invoices and a complete basis', () => {
    const revenue = { pct: 100, state: 'ok' }
    const cost = { pct: 100, state: 'ok', incompleteBasis: false }
    expect(completenessState({ revenue, cost })).toBe(COMPLETENESS_STATE.COMPLETE)
    expect(completenessState({ revenue, cost, untimedAR: 10 })).toBe(COMPLETENESS_STATE.PARTIAL)
    expect(completenessState({ revenue, cost, pastDueAP: 5 })).toBe(COMPLETENESS_STATE.PARTIAL)
    expect(completenessState({ revenue, cost: { ...cost, incompleteBasis: true } })).toBe(COMPLETENESS_STATE.PARTIAL)
  })

  it('reports INCOMPLETE at zero coverage and UNAVAILABLE without a basis', () => {
    const cost = { pct: 0, state: 'ok', incompleteBasis: false }
    expect(completenessState({ revenue: { pct: 0, state: 'ok' }, cost })).toBe(COMPLETENESS_STATE.INCOMPLETE)
    expect(completenessState({ revenue: { pct: null, state: 'no_baseline' }, cost })).toBe(COMPLETENESS_STATE.UNAVAILABLE)
    expect(completenessState({ revenue: { pct: 50, state: 'ok' }, cost: { pct: null, state: 'no_cost_basis' } })).toBe(COMPLETENESS_STATE.UNAVAILABLE)
  })
})

// ── Peak funding ─────────────────────────────────────────────────────────────

describe('peak funding', () => {
  const rowsFrom = (positions) => positions.map((p, i) => ({
    monthKey: `2026-${String(i + 1).padStart(2, '0')}`, cumulativePosition: p,
  }))

  it('finds the trough and its month', () => {
    const r = peakFunding(rowsFrom([100, -400, -250, 300]))
    expect(r.requirement).toBe(400)
    expect(r.monthKey).toBe('2026-02')
    expect(r.negative).toBe(true)
  })

  it('the earliest month wins a tie', () => {
    const r = peakFunding(rowsFrom([-300, 50, -300, 100]))
    expect(r.monthKey).toBe('2026-01')
  })

  it('reports no shortfall — not $0 — when never negative', () => {
    const r = peakFunding(rowsFrom([100, 50, 300]))
    expect(r.requirement).toBe(0)
    expect(r.negative).toBe(false)
    expect(r.monthKey).toBe(null)
    expect(r.lowestPosition).toBe(50)
    expect(r.lowestMonthKey).toBe('2026-02')
  })

  it('handles the empty range', () => {
    expect(peakFunding([]).negative).toBe(false)
    expect(peakFunding([]).lowestPosition).toBe(null)
  })
})

describe('peak-funding suppression', () => {
  it('is unsuppressed when everything is timed and both bases exist', () => {
    expect(peakFundingSuppression({}).suppressed).toBe(false)
  })

  it('each untimed or unavailable condition suppresses independently', () => {
    expect(peakFundingSuppression({ untimedRevenue: 1 }).suppressed).toBe(true)
    expect(peakFundingSuppression({ untimedCommitted: 1 }).suppressed).toBe(true)
    expect(peakFundingSuppression({ untimedCtc: 1 }).suppressed).toBe(true)
    expect(peakFundingSuppression({ untimedAR: 1 }).suppressed).toBe(true)
    expect(peakFundingSuppression({ pastDueAR: 1 }).suppressed).toBe(true)
    expect(peakFundingSuppression({ untimedAP: 1 }).suppressed).toBe(true)
    expect(peakFundingSuppression({ pastDueAP: 1 }).suppressed).toBe(true)
    expect(peakFundingSuppression({ revenueBasisUnavailable: true }).suppressed).toBe(true)
    expect(peakFundingSuppression({ costBasisUnavailable: true }).suppressed).toBe(true)
    expect(peakFundingSuppression({ costBasisIncomplete: true }).suppressed).toBe(true)
  })

  it('unallocated cash and retention are deliberately NOT suppression inputs', () => {
    // They warn but never suppress — the function accepts no such parameters.
    const r = peakFundingSuppression({ unallocatedCashIn: 999, retentionWithheld: 999 })
    expect(r.suppressed).toBe(false)
  })

  it('names every reason', () => {
    const r = peakFundingSuppression({ untimedRevenue: 1, pastDueAP: 1 })
    expect(r.reasons).toHaveLength(2)
  })
})

// ── GST suggestion ───────────────────────────────────────────────────────────

describe('GST suggestion (explicit action only)', () => {
  it('suggests gross = ex-GST × 1.1, rounded', () => {
    expect(gstSuggestedGross(1000)).toBe(1100)
    expect(gstSuggestedGross(1234.56)).toBe(1358.02)
    expect(gstSuggestedGross(null)).toBe(0)
  })
})

// ── Draft validation (client-enforced) ───────────────────────────────────────

describe('validateCashFlowLineDraft', () => {
  const valid = () => ({
    direction: 'in', sourceType: 'contract_revenue', monthKey: '2026-10',
    amount: 1100, sourceAmountExGst: 1000,
    costCodeId: null, costCodeName: '', description: 'Final claim',
  })

  it('accepts a valid draft', () => {
    expect(validateCashFlowLineDraft(valid(), NOW)).toBe(null)
  })

  it('blocks a NEW line in a past month', () => {
    expect(validateCashFlowLineDraft({ ...valid(), monthKey: '2026-07' }, NOW)).toMatch(/past/)
  })

  it('blocks editing/retiming into a past month, allows current and future', () => {
    expect(validateCashFlowLineDraft({ ...valid(), monthKey: '2026-07' }, NOW)).not.toBe(null)
    expect(validateCashFlowLineDraft({ ...valid(), monthKey: NOW }, NOW)).toBe(null)
    expect(validateCashFlowLineDraft({ ...valid(), monthKey: '2027-01' }, NOW)).toBe(null)
  })

  it('rejects invalid month keys and directions', () => {
    expect(validateCashFlowLineDraft({ ...valid(), monthKey: '2026-13' }, NOW)).not.toBe(null)
    expect(validateCashFlowLineDraft({ ...valid(), monthKey: '202610' }, NOW)).not.toBe(null)
    expect(validateCashFlowLineDraft({ ...valid(), direction: 'x' }, NOW)).not.toBe(null)
  })

  it('rejects a source type from the wrong direction', () => {
    expect(validateCashFlowLineDraft({ ...valid(), sourceType: 'remaining_committed' }, NOW)).not.toBe(null)
    expect(validateCashFlowLineDraft({
      ...valid(), direction: 'out', sourceType: 'contract_revenue',
    }, NOW)).not.toBe(null)
  })

  it('requires a positive amount — reductions use the opposite direction', () => {
    expect(validateCashFlowLineDraft({ ...valid(), amount: 0 }, NOW)).not.toBe(null)
    expect(validateCashFlowLineDraft({ ...valid(), amount: -50 }, NOW)).toMatch(/opposite direction/)
  })

  it('requires coverage for coverage types and forbids it for manual', () => {
    expect(validateCashFlowLineDraft({ ...valid(), sourceAmountExGst: null }, NOW)).not.toBe(null)
    expect(validateCashFlowLineDraft({ ...valid(), sourceAmountExGst: -1 }, NOW)).not.toBe(null)
    expect(validateCashFlowLineDraft({
      ...valid(), sourceType: 'manual', sourceAmountExGst: null,
    }, NOW)).toBe(null)
    expect(validateCashFlowLineDraft({
      ...valid(), sourceType: 'manual', sourceAmountExGst: 100,
    }, NOW)).not.toBe(null)
  })

  it('requires a cost code exactly for the cost-coded types', () => {
    expect(validateCashFlowLineDraft({
      ...valid(), direction: 'out', sourceType: 'remaining_committed',
      costCodeId: null,
    }, NOW)).not.toBe(null)
    expect(validateCashFlowLineDraft({
      ...valid(), direction: 'out', sourceType: 'remaining_committed',
      costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab',
    }, NOW)).toBe(null)
    expect(validateCashFlowLineDraft({ ...valid(), costCodeId: 'cc1', costCodeName: 'X' }, NOW)).not.toBe(null)
  })

  it('requires a description', () => {
    expect(validateCashFlowLineDraft({ ...valid(), description: '  ' }, NOW)).not.toBe(null)
  })
})

// ── Forecast rounding & purity ───────────────────────────────────────────────

describe('forecast cent arithmetic', () => {
  it('0.10 + 0.20 equals 0.30 through the forecast chain', () => {
    const ar = classifyInvoiceBalances([
      arRow({ dueDate: '2026-09-01', remaining: 0.10 }),
      arRow({ dueDate: '2026-09-02', remaining: 0.20 }),
    ], NOW)
    expect(ar.byMonth).toEqual({ '2026-09': 0.30 })
  })

  it('coverage sums stay cent-correct over many small lines', () => {
    const lines = Array.from({ length: 100 }, () => line({ sourceAmountExGst: 0.01 }))
    expect(coverageByType(lines, 'contract_revenue')).toBe(1)
  })

  it('the combined cumulative chain stays cent-correct', () => {
    const rows = buildMonthlyCombinedRows({
      arForecastByMonth: { '2026-09': 0.1, '2026-10': 0.2 },
      manualOutByMonth: { '2026-10': 0.05 },
      nowMonth: NOW,
    })
    expect(rows.find(r => r.monthKey === '2026-10').net).toBe(0.15)
    expect(rows[rows.length - 1].cumulativePosition).toBe(0.25)
  })
})

describe('forecast purity — inputs never mutated', () => {
  it('classification, combination, and coverage leave frozen inputs untouched', () => {
    const ar = [arRow(), arRow({ dueDate: '', remaining: 50 })]
    const ap = [apRow({ retentionTotal: 110 })]
    const lines = [line(), outLine(), line({ status: 'void', voidReason: 'x' })]
    ar.forEach(Object.freeze); ap.forEach(Object.freeze); lines.forEach(Object.freeze)
    Object.freeze(ar); Object.freeze(ap); Object.freeze(lines)

    const arC = classifyInvoiceBalances(ar, NOW)
    const apC = classifyInvoiceBalances(ap, NOW)
    expect(() => buildMonthlyCombinedRows({
      arForecastByMonth: arC.byMonth,
      apForecastByMonth: apC.byMonth,
      manualInByMonth: manualForecastByMonth(lines, 'in', NOW),
      manualOutByMonth: manualForecastByMonth(lines, 'out', NOW),
      nowMonth: NOW,
    })).not.toThrow()
    expect(() => coverageByType(lines, 'contract_revenue')).not.toThrow()
    expect(() => sumRetentionWithheld(ap)).not.toThrow()
    expect(ar[0].remaining).toBe(1100)
    expect(lines[0].amount).toBe(1100)
  })
})
