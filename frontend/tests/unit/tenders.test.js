import { describe, it, expect } from 'vitest'
import {
  TENDER_STATUS, TENDER_TRANSITIONS, canTenderTransition,
  BID_STATUS, BID_TRANSITIONS, canBidTransition, isBidWritable,
  MAX_PACKAGE_COST_CODES, MAX_BID_LINES,
  formatTenderNumber,
  packageCostCodeIds, bidsForPackage, receivedBidsForPackage,
  validateTenderPackageDraft, validateBidDraft, duplicateActiveBid,
  assessBid, bidTotalExGst,
  approvedBudgetForPackage, buildTenderComparison, costCodeComparisonMatrix,
  awardBlockedReason, awardedBidValue,
} from '../../src/lib/tenders'
import { monetaryLockReasons } from '../../src/lib/currency'

// ── Tender Foundation — pure domain-logic unit tests ─────────────────────────
//
// These exercise lib/tenders.js as plain functions — no React, no Firebase, no
// emulator. The Firestore Rules suites are separate (tests/rules/, npm run
// test:rules). Fixtures mirror the stored document shape the hooks write.
//
// The centre of gravity is the BID VALIDITY GATE: bids store NO bidTotal and
// packages store NO awardTotal (the Credit Notes header-vs-lines decision), so
// every figure passes through assessBid() — and a malformed bid must FAIL
// SAFELY (invalid, total null, excluded from ranking) rather than be summed
// partially, clamped, or treated as $0.

let nextId = 0
const id = () => `doc${++nextId}`

const CC = (n) => ({ costCodeId: `cc${n}`, costCodeName: `0${n}-100 — Trade ${n}` })

function pkg(overrides = {}) {
  return {
    id: id(),
    tenderNumber: 'TP-0001',
    status: TENDER_STATUS.ISSUED,
    name: 'Structural Steel Package',
    description: '',
    scope: 'Supply and install structural steel per drawings.',
    costCodes: [CC(1), CC(2)],
    closingDate: '2026-09-01',
    notes: '',
    awardedBidId: null,
    awardedBidderName: null,
    awardNotes: '',
    cancelReason: '',
    revision: 1,
    ...overrides,
  }
}

function line(overrides = {}) {
  return {
    costCodeId: 'cc1',
    costCodeName: '01-100 — Trade 1',
    description: 'Supply and install',
    amount: 1000,
    ...overrides,
  }
}

function bid(pkgDoc, overrides = {}) {
  return {
    id: id(),
    tenderPackageId: pkgDoc.id,
    tenderNumber: pkgDoc.tenderNumber,
    status: BID_STATUS.RECEIVED,
    bidderContactId: 'contact1',
    bidderName: 'Apex Steel Pty Ltd',
    bidDate: '2026-08-10',
    bidderRef: 'Q-2214',
    lineItems: [line()],
    exclusions: '',
    notes: '',
    currency: 'AUD',
    revision: 1,
    ...overrides,
  }
}

// ── Numbering ────────────────────────────────────────────────────────────────

describe('formatTenderNumber', () => {
  it('zero-pads to 4', () => {
    expect(formatTenderNumber(1)).toBe('TP-0001')
    expect(formatTenderNumber(42)).toBe('TP-0042')
    expect(formatTenderNumber(999)).toBe('TP-0999')
    expect(formatTenderNumber(1234)).toBe('TP-1234')
  })

  it('does not truncate beyond 4 digits', () => {
    expect(formatTenderNumber(12345)).toBe('TP-12345')
  })
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('package lifecycle transitions', () => {
  it('draft may issue or cancel; nothing else', () => {
    expect(canTenderTransition('draft', 'issued')).toBe(true)
    expect(canTenderTransition('draft', 'cancelled')).toBe(true)
    expect(canTenderTransition('draft', 'awarded')).toBe(false)
    expect(canTenderTransition('draft', 'draft')).toBe(false)
  })

  it('issued may award or cancel; nothing else', () => {
    expect(canTenderTransition('issued', 'awarded')).toBe(true)
    expect(canTenderTransition('issued', 'cancelled')).toBe(true)
    expect(canTenderTransition('issued', 'draft')).toBe(false)
  })

  it('awarded and cancelled are terminal', () => {
    expect(TENDER_TRANSITIONS.awarded).toEqual([])
    expect(TENDER_TRANSITIONS.cancelled).toEqual([])
    for (const to of Object.values(TENDER_STATUS)) {
      expect(canTenderTransition('awarded', to)).toBe(false)
      expect(canTenderTransition('cancelled', to)).toBe(false)
    }
  })

  it('unknown statuses transition nowhere', () => {
    expect(canTenderTransition('bogus', 'issued')).toBe(false)
    expect(canTenderTransition(undefined, 'issued')).toBe(false)
  })
})

describe('bid lifecycle transitions', () => {
  it('received may void; void is terminal', () => {
    expect(canBidTransition('received', 'void')).toBe(true)
    expect(canBidTransition('void', 'received')).toBe(false)
    expect(canBidTransition('void', 'void')).toBe(false)
    expect(BID_TRANSITIONS.void).toEqual([])
  })

  it('isBidWritable requires received bid AND issued package', () => {
    const p = pkg()
    expect(isBidWritable(bid(p), p)).toBe(true)
    expect(isBidWritable(bid(p, { status: 'void' }), p)).toBe(false)
    expect(isBidWritable(bid(p), pkg({ status: 'awarded' }))).toBe(false)
    expect(isBidWritable(bid(p), pkg({ status: 'cancelled' }))).toBe(false)
    expect(isBidWritable(bid(p), pkg({ status: 'draft' }))).toBe(false)
  })
})

// ── Package validation ───────────────────────────────────────────────────────

describe('validateTenderPackageDraft', () => {
  const valid = { name: 'Steel', costCodes: [CC(1)], closingDate: '2026-09-01' }

  it('accepts a valid draft, with or without a closing date', () => {
    expect(validateTenderPackageDraft(valid)).toBeNull()
    expect(validateTenderPackageDraft({ ...valid, closingDate: '' })).toBeNull()
    expect(validateTenderPackageDraft({ ...valid, closingDate: undefined })).toBeNull()
  })

  it('requires a non-blank name', () => {
    expect(validateTenderPackageDraft({ ...valid, name: '' })).toMatch(/name/i)
    expect(validateTenderPackageDraft({ ...valid, name: '   ' })).toMatch(/name/i)
  })

  it('requires at least one cost code — the spine', () => {
    expect(validateTenderPackageDraft({ ...valid, costCodes: [] })).toMatch(/cost code/i)
    expect(validateTenderPackageDraft({ ...valid, costCodes: null })).toMatch(/cost code/i)
  })

  it('rejects more than the maximum cost codes', () => {
    const many = Array.from({ length: MAX_PACKAGE_COST_CODES + 1 }, (_, i) => CC(i))
    expect(validateTenderPackageDraft({ ...valid, costCodes: many })).toMatch(/100/)
  })

  it('rejects duplicate and malformed cost-code entries', () => {
    expect(validateTenderPackageDraft({ ...valid, costCodes: [CC(1), CC(1)] })).toMatch(/twice/i)
    expect(validateTenderPackageDraft({ ...valid, costCodes: [{ costCodeName: 'x' }] })).toMatch(/reference a cost code/i)
    expect(validateTenderPackageDraft({ ...valid, costCodes: [{ costCodeId: 'cc1', costCodeName: '' }] })).toMatch(/snapshot/i)
    expect(validateTenderPackageDraft({ ...valid, costCodes: [{ costCodeId: 'cc1' }] })).toMatch(/snapshot/i)
  })

  it('rejects a malformed closing date', () => {
    expect(validateTenderPackageDraft({ ...valid, closingDate: '01/09/2026' })).toMatch(/date/i)
    expect(validateTenderPackageDraft({ ...valid, closingDate: 'soon' })).toMatch(/date/i)
  })
})

// ── Bid validation ───────────────────────────────────────────────────────────

describe('validateBidDraft', () => {
  const p = pkg()
  const base = {
    tenderPackage: p,
    bidderContactId: 'contact1',
    bidderName: 'Apex Steel Pty Ltd',
    bidDate: '2026-08-10',
    lineItems: [{ costCodeId: 'cc1', description: '', amount: 1000 }],
  }

  it('accepts a valid bid, including zero amounts', () => {
    expect(validateBidDraft(base)).toBeNull()
    expect(validateBidDraft({ ...base, lineItems: [{ costCodeId: 'cc1', description: '', amount: 0 }] })).toBeNull()
  })

  it('requires an issued package', () => {
    expect(validateBidDraft({ ...base, tenderPackage: null })).toMatch(/package/i)
    expect(validateBidDraft({ ...base, tenderPackage: pkg({ status: 'draft' }) })).toMatch(/issued/i)
    expect(validateBidDraft({ ...base, tenderPackage: pkg({ status: 'awarded' }) })).toMatch(/issued/i)
    expect(validateBidDraft({ ...base, tenderPackage: pkg({ status: 'cancelled' }) })).toMatch(/issued/i)
  })

  it('requires a bidder and its name snapshot', () => {
    expect(validateBidDraft({ ...base, bidderContactId: '' })).toMatch(/bidder/i)
    expect(validateBidDraft({ ...base, bidderName: '  ' })).toMatch(/name/i)
  })

  it('verifies the contact type when contacts are supplied', () => {
    const supplier = { id: 'contact1', contactTypes: ['supplier'], displayName: 'Apex Steel Pty Ltd' }
    const subbie   = { id: 'contact1', contactTypes: ['subcontractor'] }
    const client   = { id: 'contact1', contactTypes: ['client'] }
    expect(validateBidDraft({ ...base, contacts: [supplier] })).toBeNull()
    expect(validateBidDraft({ ...base, contacts: [subbie] })).toBeNull()
    expect(validateBidDraft({ ...base, contacts: [client] })).toMatch(/supplier or subcontractor/i)
    expect(validateBidDraft({ ...base, contacts: [] })).toMatch(/does not exist/i)
  })

  it('requires a well-formed bid date', () => {
    expect(validateBidDraft({ ...base, bidDate: '' })).toMatch(/date/i)
    expect(validateBidDraft({ ...base, bidDate: '10/08/2026' })).toMatch(/date/i)
  })

  it('requires at least one line and bounds the count', () => {
    expect(validateBidDraft({ ...base, lineItems: [] })).toMatch(/at least one/i)
    const many = Array.from({ length: MAX_BID_LINES + 1 }, () => ({ costCodeId: 'cc1', amount: 1 }))
    expect(validateBidDraft({ ...base, lineItems: many })).toMatch(/100/)
  })

  it('requires every line cost code to sit inside the package scope', () => {
    expect(validateBidDraft({ ...base, lineItems: [{ costCodeId: 'cc9', amount: 1 }] })).toMatch(/scope/i)
    expect(validateBidDraft({ ...base, lineItems: [{ costCodeId: '', amount: 1 }] })).toMatch(/cost code/i)
  })

  it('requires finite, non-negative amounts', () => {
    expect(validateBidDraft({ ...base, lineItems: [{ costCodeId: 'cc1', amount: NaN }] })).toMatch(/number/i)
    expect(validateBidDraft({ ...base, lineItems: [{ costCodeId: 'cc1', amount: Infinity }] })).toMatch(/number/i)
    expect(validateBidDraft({ ...base, lineItems: [{ costCodeId: 'cc1', amount: 'a lot' }] })).toMatch(/number/i)
    expect(validateBidDraft({ ...base, lineItems: [{ costCodeId: 'cc1', amount: -5 }] })).toMatch(/negative/i)
  })

  it('blocks a second active bid for the same bidder/package when bids are supplied', () => {
    const existing = bid(p, { bidderContactId: 'contact1' })
    expect(validateBidDraft({ ...base, bids: [existing] })).toMatch(/already has an active bid/i)
    // A VOID bid does not block a replacement.
    const voided = bid(p, { bidderContactId: 'contact1', status: 'void' })
    expect(validateBidDraft({ ...base, bids: [voided] })).toBeNull()
    // Editing the bid itself is not a duplicate of itself.
    expect(validateBidDraft({ ...base, bids: [existing], excludeBidId: existing.id })).toBeNull()
    // Another package's bid does not block.
    const other = bid(pkg(), { bidderContactId: 'contact1' })
    expect(validateBidDraft({ ...base, bids: [other] })).toBeNull()
  })
})

describe('duplicateActiveBid', () => {
  it('finds only received bids on the same package by the same bidder', () => {
    const p = pkg()
    const b = bid(p)
    expect(duplicateActiveBid([b], { tenderPackageId: p.id, bidderContactId: 'contact1' })).toBe(b)
    expect(duplicateActiveBid([b], { tenderPackageId: p.id, bidderContactId: 'contact2' })).toBeNull()
    expect(duplicateActiveBid([b], { tenderPackageId: 'other', bidderContactId: 'contact1' })).toBeNull()
    expect(duplicateActiveBid([bid(p, { status: 'void' })], { tenderPackageId: p.id, bidderContactId: 'contact1' })).toBeNull()
    expect(duplicateActiveBid([b], { tenderPackageId: p.id, bidderContactId: 'contact1', excludeBidId: b.id })).toBeNull()
  })
})

// ── THE validity gate ────────────────────────────────────────────────────────

describe('assessBid — the read-time validity gate', () => {
  const p = pkg()

  it('accepts a well-formed bid and derives its total', () => {
    const b = bid(p, { lineItems: [line({ amount: 1000 }), line({ costCodeId: 'cc2', costCodeName: '02-100 — Trade 2', amount: 500.5 })] })
    const a = assessBid(b, p)
    expect(a.valid).toBe(true)
    expect(a.total).toBe(1500.5)
    expect(a.problems).toEqual([])
  })

  it('accepts zero amounts — zero is a legitimate price', () => {
    const b = bid(p, { lineItems: [line({ amount: 0 })] })
    const a = assessBid(b, p)
    expect(a.valid).toBe(true)
    expect(a.total).toBe(0)
  })

  it('sums cents exactly (0.10 + 0.20 = 0.30)', () => {
    const b = bid(p, { lineItems: [line({ amount: 0.10 }), line({ amount: 0.20 })] })
    expect(assessBid(b, p).total).toBe(0.30)
  })

  it('invalidates a bid with no lines, or a non-array lineItems', () => {
    for (const lineItems of [[], null, undefined, 'lines', { 0: line() }]) {
      const a = assessBid(bid(p, { lineItems }), p)
      expect(a.valid).toBe(false)
      expect(a.total).toBeNull()
    }
  })

  it('invalidates non-object lines', () => {
    for (const badLine of [null, 'line', 42, [line()]]) {
      const a = assessBid(bid(p, { lineItems: [badLine] }), p)
      expect(a.valid).toBe(false)
      expect(a.total).toBeNull()
    }
  })

  it('invalidates a missing/empty costCodeId', () => {
    for (const costCodeId of ['', null, undefined, 7]) {
      const a = assessBid(bid(p, { lineItems: [line({ costCodeId })] }), p)
      expect(a.valid).toBe(false)
      expect(a.total).toBeNull()
    }
  })

  it('invalidates a cost code outside the package scope', () => {
    const a = assessBid(bid(p, { lineItems: [line({ costCodeId: 'cc9' })] }), p)
    expect(a.valid).toBe(false)
    expect(a.lineProblems[0].join(' ')).toMatch(/outside the package scope/)
  })

  it('invalidates non-string costCodeName / description', () => {
    expect(assessBid(bid(p, { lineItems: [line({ costCodeName: null })] }), p).valid).toBe(false)
    expect(assessBid(bid(p, { lineItems: [line({ costCodeName: 7 })] }), p).valid).toBe(false)
    expect(assessBid(bid(p, { lineItems: [line({ description: null })] }), p).valid).toBe(false)
    expect(assessBid(bid(p, { lineItems: [line({ description: 12 })] }), p).valid).toBe(false)
  })

  it('invalidates non-finite, non-number, and negative amounts — never clamped', () => {
    for (const amount of [NaN, Infinity, -Infinity, '1000', null, undefined, -0.01]) {
      const a = assessBid(bid(p, { lineItems: [line({ amount })] }), p)
      expect(a.valid).toBe(false)
      expect(a.total).toBeNull()
    }
  })

  it('ONE malformed line invalidates the WHOLE bid — no partial sum, never $0', () => {
    const b = bid(p, {
      lineItems: [line({ amount: 90000 }), line({ costCodeId: 'cc2', costCodeName: 'x', amount: NaN })],
    })
    const a = assessBid(b, p)
    expect(a.valid).toBe(false)
    expect(a.total).toBeNull()          // NOT 90000, NOT 0
    expect(a.lineProblems[0]).toEqual([])
    expect(a.lineProblems[1].length).toBeGreaterThan(0)
  })

  it('invalidates a bid whose FINITE lines sum beyond representable range', () => {
    // Every line is a finite number ≥ 0, but the total overflows. A non-finite
    // total must never pass the gate: it would otherwise rank, flag LOWEST,
    // produce an -Infinity budget variance, and be awardable.
    for (const lineItems of [
      [line({ amount: 1e308 })],                      // roundMoney(×100) overflows
      [line({ amount: 1e308 }), line({ amount: 1e308 })], // the sum overflows
    ]) {
      const a = assessBid(bid(p, { lineItems }), p)
      expect(a.valid).toBe(false)
      expect(a.total).toBeNull()
      expect(a.problems.join(' ')).toMatch(/beyond the range/i)
    }
  })

  it('an overflowing bid is excluded from ranking, variance, award and awarded value', () => {
    const huge = bid(p, { bidderName: 'Huge', lineItems: [line({ amount: 1e308 }), line({ amount: 1e308 })] })
    const real = bid(p, { bidderName: 'Real', lineItems: [line({ amount: 1000 })] })
    const budgetLines = [{ costCodeId: 'cc1', budgeted: 1500 }]

    const { rows, lowest, rankedCount } = buildTenderComparison({ pkg: p, bids: [huge, real], budgetLines })
    expect(lowest).toBe(1000)
    expect(rankedCount).toBe(1)
    const hugeRow = rows.find(r => r.bidderName === 'Huge')
    expect(hugeRow).toMatchObject({ valid: false, total: null, isLowest: false, varianceToBudget: null, varianceToLowest: null })

    // Alone, it must still not become the lowest bid.
    const solo = buildTenderComparison({ pkg: p, bids: [huge], budgetLines })
    expect(solo.lowest).toBeNull()
    expect(solo.rows[0].isLowest).toBe(false)

    // Not awardable, and no Awarded Bid Value if awarded out of band.
    expect(awardBlockedReason(p, huge)).toMatch(/malformed|range/i)
    const awardedPkg = { ...p, status: TENDER_STATUS.AWARDED, awardedBidId: huge.id }
    expect(awardedBidValue(awardedPkg, [huge])).toMatchObject({ available: false, total: null })

    // And excluded from the per-cost-code matrix columns.
    expect(costCodeComparisonMatrix({ pkg: p, bids: [huge] }).columns).toEqual([])
  })

  it('bidTotalExGst mirrors the gate', () => {
    expect(bidTotalExGst(bid(p), p)).toBe(1000)
    expect(bidTotalExGst(bid(p, { lineItems: [line({ amount: NaN })] }), p)).toBeNull()
  })
})

// ── Approved Budget for a package ────────────────────────────────────────────

describe('approvedBudgetForPackage', () => {
  const p = pkg() // cc1, cc2

  it('sums budget lines on the package cost codes only, including several per code', () => {
    const budgetLines = [
      { costCodeId: 'cc1', budgeted: 1000 },
      { costCodeId: 'cc1', budgeted: 250.25 },
      { costCodeId: 'cc2', budgeted: 500 },
      { costCodeId: 'cc9', budgeted: 99999 }, // outside the package
    ]
    expect(approvedBudgetForPackage(p, budgetLines)).toEqual({ amount: 1750.25, hasBudget: true })
  })

  it('reports NO budget (never zero) when no line matches', () => {
    expect(approvedBudgetForPackage(p, [])).toEqual({ amount: null, hasBudget: false })
    expect(approvedBudgetForPackage(p, [{ costCodeId: 'cc9', budgeted: 5 }])).toEqual({ amount: null, hasBudget: false })
    expect(approvedBudgetForPackage(p, undefined)).toEqual({ amount: null, hasBudget: false })
  })

  it('a matching line with zero budgeted still counts as having budget', () => {
    expect(approvedBudgetForPackage(p, [{ costCodeId: 'cc1', budgeted: 0 }])).toEqual({ amount: 0, hasBudget: true })
  })
})

// ── Tender Comparison ────────────────────────────────────────────────────────

describe('buildTenderComparison', () => {
  const p = pkg()
  const budgetLines = [
    { costCodeId: 'cc1', budgeted: 1000 },
    { costCodeId: 'cc2', budgeted: 500 },
  ] // Approved Budget = 1500

  it('applies the sign convention: Variance to Budget = Approved Budget − Bid', () => {
    const under = bid(p, { bidderName: 'Under', lineItems: [line({ amount: 1200 })] })
    const over  = bid(p, { bidderName: 'Over',  lineItems: [line({ amount: 1800 })] })
    const { rows } = buildTenderComparison({ pkg: p, bids: [under, over], budgetLines })

    const u = rows.find(r => r.bidderName === 'Under')
    const o = rows.find(r => r.bidderName === 'Over')
    expect(u.varianceToBudget).toBe(300)    // POSITIVE = under budget
    expect(o.varianceToBudget).toBe(-300)   // NEGATIVE = over budget
  })

  it('computes variance to lowest and flags the lowest', () => {
    const a = bid(p, { bidderName: 'A', lineItems: [line({ amount: 1000 })] })
    const b = bid(p, { bidderName: 'B', lineItems: [line({ amount: 1250 })] })
    const { rows, lowest } = buildTenderComparison({ pkg: p, bids: [a, b], budgetLines })
    expect(lowest).toBe(1000)
    expect(rows.find(r => r.bidderName === 'A')).toMatchObject({ isLowest: true, varianceToLowest: 0 })
    expect(rows.find(r => r.bidderName === 'B')).toMatchObject({ isLowest: false, varianceToLowest: 250 })
  })

  it('flags EVERY bid tied for lowest', () => {
    const a = bid(p, { bidderName: 'A', lineItems: [line({ amount: 1000 })] })
    const b = bid(p, { bidderName: 'B', lineItems: [line({ amount: 1000 })] })
    const c = bid(p, { bidderName: 'C', lineItems: [line({ amount: 1000.004 })] }) // same cents
    const { rows } = buildTenderComparison({ pkg: p, bids: [a, b, c], budgetLines })
    expect(rows.filter(r => r.isLowest).length).toBe(3)
  })

  it('excludes VOID bids from ranking and lowest, but keeps them visible', () => {
    const a = bid(p, { bidderName: 'Active', lineItems: [line({ amount: 2000 })] })
    const v = bid(p, { bidderName: 'Voided', status: 'void', lineItems: [line({ amount: 100 })] })
    const { rows, lowest } = buildTenderComparison({ pkg: p, bids: [a, v], budgetLines })
    expect(lowest).toBe(2000)               // NOT the void bid's 100
    const voidRow = rows.find(r => r.bidderName === 'Voided')
    expect(voidRow.isVoid).toBe(true)
    expect(voidRow.varianceToBudget).toBeNull()
    expect(voidRow.varianceToLowest).toBeNull()
    expect(voidRow.isLowest).toBe(false)
  })

  it('excludes INVALID bids from ranking and lowest — a malformed bid is never the winner', () => {
    const good = bid(p, { bidderName: 'Good', lineItems: [line({ amount: 5000 })] })
    const bad  = bid(p, { bidderName: 'Bad',  lineItems: [line({ amount: NaN })] })
    const { rows, lowest, rankedCount } = buildTenderComparison({ pkg: p, bids: [good, bad], budgetLines })
    expect(lowest).toBe(5000)
    expect(rankedCount).toBe(1)
    const badRow = rows.find(r => r.bidderName === 'Bad')
    expect(badRow.valid).toBe(false)
    expect(badRow.total).toBeNull()          // never $0
    expect(badRow.varianceToBudget).toBeNull()
    expect(badRow.varianceToLowest).toBeNull()
    expect(badRow.isLowest).toBe(false)
  })

  it('shows budget as unavailable — never compares against zero — when no budget lines match', () => {
    const a = bid(p, { bidderName: 'A', lineItems: [line({ amount: 1000 })] })
    const { rows, budget } = buildTenderComparison({ pkg: p, bids: [a], budgetLines: [] })
    expect(budget.hasBudget).toBe(false)
    expect(budget.amount).toBeNull()
    expect(rows[0].varianceToBudget).toBeNull() // NOT -1000
    expect(rows[0].varianceToLowest).toBe(0)    // lowest still works without budget
  })

  it('orders valid ascending by total, then invalid, then void', () => {
    const hi   = bid(p, { bidderName: 'Hi',   lineItems: [line({ amount: 900 })] })
    const lo   = bid(p, { bidderName: 'Lo',   lineItems: [line({ amount: 100 })] })
    const bad  = bid(p, { bidderName: 'Bad',  lineItems: [line({ amount: NaN })] })
    const gone = bid(p, { bidderName: 'Gone', status: 'void' })
    const { rows } = buildTenderComparison({ pkg: p, bids: [hi, bad, gone, lo], budgetLines })
    expect(rows.map(r => r.bidderName)).toEqual(['Lo', 'Hi', 'Bad', 'Gone'])
  })

  it('marks the awarded bid and surfaces exclusions/notes indicators', () => {
    const won  = bid(p, { bidderName: 'Won', exclusions: 'Excludes cranage', notes: 'call back' })
    const p2   = { ...p, status: TENDER_STATUS.AWARDED, awardedBidId: won.id, awardedBidderName: won.bidderName }
    const { rows } = buildTenderComparison({ pkg: p2, bids: [won], budgetLines })
    expect(rows[0]).toMatchObject({ isAwarded: true, hasExclusions: true, hasNotes: true })
  })

  it('ignores bids belonging to other packages', () => {
    const other = bid(pkg(), { bidderName: 'Other' })
    const { rows } = buildTenderComparison({ pkg: p, bids: [other], budgetLines })
    expect(rows).toEqual([])
  })
})

// ── Per-cost-code matrix ─────────────────────────────────────────────────────

describe('costCodeComparisonMatrix', () => {
  const p = pkg() // cc1, cc2

  it('sums each valid bid per package cost code; unpriced codes are null (not 0)', () => {
    const a = bid(p, {
      bidderName: 'A',
      lineItems: [
        line({ costCodeId: 'cc1', amount: 400 }),
        line({ costCodeId: 'cc1', amount: 100 }), // two lines on one code
        line({ costCodeId: 'cc2', costCodeName: '02-100 — Trade 2', amount: 250 }),
      ],
    })
    const b = bid(p, { bidderName: 'B', lineItems: [line({ costCodeId: 'cc1', amount: 700 })] })
    const m = costCodeComparisonMatrix({ pkg: p, bids: [a, b] })
    expect(m.columns.map(c => c.bidderName)).toEqual(['A', 'B'])
    expect(m.rows[0].amounts[a.id]).toBe(500)
    expect(m.rows[0].amounts[b.id]).toBe(700)
    expect(m.rows[1].amounts[a.id]).toBe(250)
    expect(m.rows[1].amounts[b.id]).toBeNull() // B priced nothing on cc2
  })

  it('excludes invalid and void bids from the columns entirely', () => {
    const bad  = bid(p, { lineItems: [line({ amount: NaN })] })
    const gone = bid(p, { status: 'void' })
    const m = costCodeComparisonMatrix({ pkg: p, bids: [bad, gone] })
    expect(m.columns).toEqual([])
    expect(m.rows.length).toBe(2) // package codes still listed
  })
})

// ── Award ────────────────────────────────────────────────────────────────────

describe('awardBlockedReason', () => {
  const p = pkg()

  it('permits awarding a valid received bid on an issued package', () => {
    expect(awardBlockedReason(p, bid(p))).toBeNull()
  })

  it('blocks non-issued packages', () => {
    expect(awardBlockedReason(pkg({ status: 'draft' }), bid(p))).toMatch(/issued/i)
    expect(awardBlockedReason(pkg({ status: 'awarded' }), bid(p))).toMatch(/issued/i)
    expect(awardBlockedReason(pkg({ status: 'cancelled' }), bid(p))).toMatch(/issued/i)
    expect(awardBlockedReason(null, bid(p))).toMatch(/issued/i)
  })

  it('blocks a missing bid, another package\'s bid, and a void bid', () => {
    expect(awardBlockedReason(p, null)).toMatch(/select/i)
    expect(awardBlockedReason(p, bid(pkg()))).toMatch(/different package/i)
    expect(awardBlockedReason(p, bid(p, { status: 'void' }))).toMatch(/void/i)
  })

  it('blocks a malformed bid — the UI must refuse to award it', () => {
    expect(awardBlockedReason(p, bid(p, { lineItems: [line({ amount: NaN })] }))).toMatch(/malformed/i)
    expect(awardBlockedReason(p, bid(p, { lineItems: [] }))).toMatch(/malformed/i)
  })
})

describe('awardedBidValue', () => {
  it('is unavailable before award, when the bid is missing, and when it is malformed', () => {
    const p = pkg()
    const b = bid(p)
    expect(awardedBidValue(p, [b])).toEqual({ available: false, total: null, bid: null })

    const awardedPkg = { ...p, status: TENDER_STATUS.AWARDED, awardedBidId: b.id }
    expect(awardedBidValue(awardedPkg, [])).toEqual({ available: false, total: null, bid: null })

    const malformed = { ...b, lineItems: [line({ amount: NaN })] }
    const r = awardedBidValue(awardedPkg, [malformed])
    expect(r.available).toBe(false)
    expect(r.total).toBeNull()
  })

  it('derives the awarded value from the frozen bid lines — no stored awardTotal', () => {
    const p = pkg()
    const b = bid(p, { lineItems: [line({ amount: 750.25 }), line({ costCodeId: 'cc2', costCodeName: 'x', amount: 249.75 })] })
    const awardedPkg = { ...p, status: TENDER_STATUS.AWARDED, awardedBidId: b.id }
    expect(awardedBidValue(awardedPkg, [b])).toMatchObject({ available: true, total: 1000 })
  })
})

// ── Helpers ──────────────────────────────────────────────────────────────────

describe('package/bid helpers', () => {
  it('packageCostCodeIds ignores malformed entries', () => {
    const ids = packageCostCodeIds({ costCodes: [CC(1), { costCodeName: 'nameless' }, null] })
    expect([...ids]).toEqual(['cc1'])
  })

  it('bidsForPackage / receivedBidsForPackage filter correctly', () => {
    const p = pkg()
    const a = bid(p)
    const v = bid(p, { status: 'void' })
    const other = bid(pkg())
    expect(bidsForPackage([a, v, other], p.id)).toEqual([a, v])
    expect(receivedBidsForPackage([a, v, other], p.id)).toEqual([a])
  })
})

// ── Purity ───────────────────────────────────────────────────────────────────

describe('purity — derivations never mutate their inputs', () => {
  it('buildTenderComparison and the matrix run on frozen inputs', () => {
    const p = Object.freeze(pkg({ costCodes: Object.freeze([Object.freeze(CC(1)), Object.freeze(CC(2))]) }))
    const frozenBid = Object.freeze(bid(p, {
      lineItems: Object.freeze([Object.freeze(line({ amount: 100 }))]),
    }))
    const frozenBad = Object.freeze(bid(p, {
      lineItems: Object.freeze([Object.freeze(line({ amount: NaN }))]),
    }))
    const budgetLines = Object.freeze([Object.freeze({ costCodeId: 'cc1', budgeted: 500 })])

    expect(() => {
      buildTenderComparison({ pkg: p, bids: [frozenBid, frozenBad], budgetLines })
      costCodeComparisonMatrix({ pkg: p, bids: [frozenBid, frozenBad] })
      assessBid(frozenBid, p)
      approvedBudgetForPackage(p, budgetLines)
      awardedBidValue(p, [frozenBid])
    }).not.toThrow()
  })
})

// ── Currency ratchet evidence ────────────────────────────────────────────────

describe('monetaryLockReasons — tender bids are monetary evidence', () => {
  it('any tender bid locks, including void ones', () => {
    expect(monetaryLockReasons({ tenderBids: [{ status: 'received' }] })).toContain('1 tender bid')
    expect(monetaryLockReasons({ tenderBids: [{ status: 'received' }, { status: 'void' }] })).toContain('2 tender bids')
  })

  it('no tender bids → no tender reason (packages alone never lock: they carry no amounts)', () => {
    expect(monetaryLockReasons({ tenderBids: [] })).toEqual([])
    expect(monetaryLockReasons({})).toEqual([])
  })

  // Regression: Overview rendered "Locked because this project already has ."
  // because the page never subscribed to tender bids, so the ONLY evidence on a
  // bid-only project was missing from the sentence. Pin the exact wording the
  // Overview interpolates for the acceptance scenario, singular and plural.
  it('the Overview sentence for a bid-only project names the bid — never an empty list', () => {
    const currencyTestProject = { budget: 0, currencyLocked: true }
    const one = monetaryLockReasons({ project: currencyTestProject, tenderBids: [{ status: 'received' }] })
    expect(one).toEqual(['1 tender bid'])
    expect(`Locked because this project already has ${one.join(', ')}.`)
      .toBe('Locked because this project already has 1 tender bid.')

    const three = monetaryLockReasons({
      project: currencyTestProject,
      tenderBids: [{ status: 'received' }, { status: 'received' }, { status: 'void' }],
    })
    expect(three).toEqual(['3 tender bids'])
    expect(`Locked because this project already has ${three.join(', ')}.`)
      .toBe('Locked because this project already has 3 tender bids.')
  })

  it('tender PACKAGES are not lock evidence, even when passed as an unknown key', () => {
    // A tender package holds scope and dates, no amounts. Even if a caller
    // hands packages to the predicate, they must contribute nothing.
    expect(monetaryLockReasons({ tenderPackages: [{ status: 'issued' }], tenderBids: [] })).toEqual([])
  })

  it('unavailable bid data (undefined) is not fabricated into a reason', () => {
    expect(monetaryLockReasons({ tenderBids: undefined })).toEqual([])
  })
})
