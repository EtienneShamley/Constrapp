import { describe, it, expect } from 'vitest'
import {
  isMonthKey, monthKeyFromDate, monthLabel, compareMonthKeys, monthKeyRange,
  currentMonthKey, cashInByMonth, cashOutByMonth, cashMonthSpan,
  totalActualCashIn, totalActualCashOut, actualNetCash, buildMonthlyActualRows,
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
