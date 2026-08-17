import { describe, it, expect } from 'vitest'
import {
  BOQ_STATUS, BOQ_STATUS_LABELS, BOQ_BADGE_VARIANTS, BOQ_TRANSITIONS, canTransition,
  normalizeRate, isPriced, boqLineAmount,
  activeBoqItems, voidBoqItems,
  boqTotals, budgetedTotal, boqVarianceToBudget,
  boqByCostCode, boqVsBudgetRows,
  sortBoqItems, formatQuantity,
  validateBoqItemDraft,
} from '../../src/lib/boq'

// ── BOQ — pure-arithmetic unit tests ─────────────────────────────────────────
//
// These exercise lib/boq.js as plain functions — no React, no Firebase, no
// emulator. The Firestore Rules suite is separate (tests/rules/boqItems.
// rules.test.js, npm run test:rules).
//
// Fixtures mirror the stored document shape the hook writes. The load-bearing
// contract proved throughout: `null` means UNPRICED — an unpriced item
// contributes nothing to any total, and the BOQ-vs-budget variance is NULL
// (never 0, never a partial figure) whenever the BOQ is empty or incomplete.

let nextId = 0
const id = () => `item${++nextId}`

function item(overrides = {}) {
  return {
    id: id(),
    itemNumber: '1.1',
    section: 'Substructure',
    description: 'Concrete in slab on ground',
    unit: 'm3',
    quantity: 10,
    rate: 100,
    amount: 1000,
    costCodeId: 'cc1',
    costCodeName: '03-100 — Concrete Slab',
    notes: '',
    status: 'active',
    currency: 'AUD',
    revision: 1,
    attachments: [],
    externalRefs: {},
    voidReason: '',
    voidedAt: null,
    voidedBy: null,
    createdAt: { seconds: 1_780_000_000 },
    ...overrides,
  }
}

const unpriced = (overrides = {}) => item({ rate: null, amount: null, ...overrides })

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('defines exactly two states with void terminal', () => {
    expect(BOQ_STATUS).toEqual({ ACTIVE: 'active', VOID: 'void' })
    expect(BOQ_TRANSITIONS).toEqual({ active: ['void'], void: [] })
  })

  it('canTransition permits only active → void', () => {
    expect(canTransition('active', 'void')).toBe(true)
    expect(canTransition('active', 'active')).toBe(false)
    expect(canTransition('void', 'active')).toBe(false)
    expect(canTransition('void', 'void')).toBe(false)
    expect(canTransition('nonsense', 'void')).toBe(false)
  })

  it('labels and badge variants cover both states with existing variants only', () => {
    expect(BOQ_STATUS_LABELS).toEqual({ active: 'Active', void: 'Void' })
    expect(BOQ_BADGE_VARIANTS).toEqual({ active: 'active', void: 'danger' })
  })
})

// ── Pricing primitives ───────────────────────────────────────────────────────

describe('normalizeRate', () => {
  it('maps blank form input to null — never to 0', () => {
    expect(normalizeRate('')).toBe(null)
    expect(normalizeRate(null)).toBe(null)
    expect(normalizeRate(undefined)).toBe(null)
  })

  it('numbers pass through, strings coerce', () => {
    expect(normalizeRate(0)).toBe(0)
    expect(normalizeRate(310.4)).toBe(310.4)
    expect(normalizeRate('310.40')).toBe(310.4)
  })
})

describe('isPriced', () => {
  it('null and undefined are unpriced; 0 IS a price', () => {
    expect(isPriced(null)).toBe(false)
    expect(isPriced(undefined)).toBe(false)
    expect(isPriced(0)).toBe(true)
    expect(isPriced(310.4)).toBe(true)
  })
})

describe('boqLineAmount', () => {
  it('derives quantity × rate', () => {
    expect(boqLineAmount(10, 100)).toBe(1000)
    expect(boqLineAmount(12.5, 310.4)).toBe(3880)
  })

  it('returns null while unpriced — never 0', () => {
    expect(boqLineAmount(10, null)).toBe(null)
    expect(boqLineAmount(10, undefined)).toBe(null)
  })

  it('zero rate and zero quantity both derive a REAL 0', () => {
    expect(boqLineAmount(10, 0)).toBe(0)
    expect(boqLineAmount(0, 100)).toBe(0)
  })

  it('rounds fractional products to the cent', () => {
    // 3.333 × 14.99 = 49.961... → 49.96
    expect(boqLineAmount(3.333, 14.99)).toBe(49.96)
    // 0.1 × 0.3 = 0.030000000000000002 → 0.03 (IEEE-754 crumbs removed)
    expect(boqLineAmount(0.1, 0.3)).toBe(0.03)
  })

  it('rounds exactly the way the rules cents() does — Math.round of the raw product', () => {
    // 1 × 1.005: the float product is 100.49999999999999 cents, which
    // math.round (rules) and Math.round (toCents) both take DOWN to 100.
    // roundMoney's epsilon nudge would give 1.01 — and be REJECTED by rules.
    expect(boqLineAmount(1, 1.005)).toBe(1)
  })

  it('returns null for non-finite inputs rather than NaN', () => {
    expect(boqLineAmount('abc', 100)).toBe(null)
    expect(boqLineAmount(10, 'abc')).toBe(null)
    expect(boqLineAmount(Infinity, 1)).toBe(null)
  })
})

// ── Status filters ───────────────────────────────────────────────────────────

describe('status filters', () => {
  const items = [item(), unpriced(), item({ status: 'void' })]

  it('split by status and never mutate', () => {
    expect(activeBoqItems(items)).toHaveLength(2)
    expect(voidBoqItems(items)).toHaveLength(1)
    expect(items).toHaveLength(3)
  })

  it('tolerate null/undefined input', () => {
    expect(activeBoqItems(null)).toEqual([])
    expect(voidBoqItems(undefined)).toEqual([])
  })
})

// ── Totals ───────────────────────────────────────────────────────────────────

describe('boqTotals', () => {
  it('sums priced ACTIVE items only', () => {
    const totals = boqTotals([
      item({ amount: 1000 }),
      item({ quantity: 5, rate: 20, amount: 100 }),
      unpriced(),
      item({ status: 'void', amount: 99999 }), // void — contributes nothing
    ])
    expect(totals).toEqual({ itemCount: 3, pricedCount: 2, unpricedCount: 1, pricedTotal: 1100 })
  })

  it('an unpriced item contributes NOTHING — not zero-and-counted-as-priced', () => {
    const totals = boqTotals([unpriced(), unpriced()])
    expect(totals.pricedTotal).toBe(0)
    expect(totals.pricedCount).toBe(0)
    expect(totals.unpricedCount).toBe(2)
  })

  it('a zero-priced item IS priced', () => {
    const totals = boqTotals([item({ rate: 0, amount: 0 })])
    expect(totals.pricedCount).toBe(1)
    expect(totals.unpricedCount).toBe(0)
  })

  it('accumulates through cent rounding', () => {
    const totals = boqTotals([
      item({ amount: 0.1 }), item({ amount: 0.2 }),
    ])
    expect(totals.pricedTotal).toBe(0.3) // never 0.30000000000000004
  })

  it('empty and null-ish input give an empty result', () => {
    expect(boqTotals([])).toEqual({ itemCount: 0, pricedCount: 0, unpricedCount: 0, pricedTotal: 0 })
    expect(boqTotals(null).itemCount).toBe(0)
  })
})

describe('budgetedTotal', () => {
  it('sums budgeted across lines, ignoring junk', () => {
    expect(budgetedTotal([{ budgeted: 100 }, { budgeted: 250.5 }, { budgeted: 'x' }, {}])).toBe(350.5)
    expect(budgetedTotal([])).toBe(0)
    expect(budgetedTotal(null)).toBe(0)
  })
})

describe('boqVarianceToBudget', () => {
  it('is budget − BOQ (positive ⇒ BOQ under budget) when fully priced', () => {
    expect(boqVarianceToBudget(5000, { itemCount: 2, unpricedCount: 0, pricedTotal: 4400 })).toBe(600)
    expect(boqVarianceToBudget(4000, { itemCount: 2, unpricedCount: 0, pricedTotal: 4400 })).toBe(-400)
  })

  it('is NULL — never 0 or a partial figure — while any item is unpriced', () => {
    expect(boqVarianceToBudget(5000, { itemCount: 3, unpricedCount: 1, pricedTotal: 4400 })).toBe(null)
  })

  it('is NULL for an empty BOQ — an unmeasured project has no variance', () => {
    expect(boqVarianceToBudget(5000, { itemCount: 0, unpricedCount: 0, pricedTotal: 0 })).toBe(null)
    expect(boqVarianceToBudget(5000, null)).toBe(null)
  })
})

// ── Per-cost-code grouping ───────────────────────────────────────────────────

describe('boqByCostCode', () => {
  it('groups priced amounts and counts unpriced per code, active only', () => {
    const map = boqByCostCode([
      item({ costCodeId: 'cc1', amount: 1000 }),
      item({ costCodeId: 'cc1', quantity: 2, rate: 50, amount: 100 }),
      unpriced({ costCodeId: 'cc1' }),
      item({ costCodeId: 'cc2', amount: 700, costCodeName: '05-200 — Roofing' }),
      item({ costCodeId: 'cc2', status: 'void', amount: 99999 }),
    ])
    expect(map.cc1).toMatchObject({ amount: 1100, itemCount: 3, unpricedCount: 1 })
    expect(map.cc2).toMatchObject({ amount: 700, itemCount: 1, unpricedCount: 0, costCodeName: '05-200 — Roofing' })
  })

  it('carries the frozen costCodeName snapshot', () => {
    const map = boqByCostCode([item()])
    expect(map.cc1.costCodeName).toBe('03-100 — Concrete Slab')
  })
})

// ── BOQ vs Budget comparison rows ────────────────────────────────────────────

describe('boqVsBudgetRows', () => {
  const costCodes = [
    { id: 'cc1', code: '03-100', name: 'Concrete Slab', isActive: true },
    { id: 'cc2', code: '05-200', name: 'Roofing', isActive: false },
  ]

  it('unions codes appearing in the BOQ OR the budget — a code never disappears', () => {
    const rows = boqVsBudgetRows({
      costCodes,
      boqItems: [item({ costCodeId: 'cc1', amount: 1000 })],
      budgetLines: [{ costCodeId: 'cc2', costCodeName: '05-200 — Roofing', budgeted: 500 }],
    })
    expect(rows.map(r => r.costCodeId).sort()).toEqual(['cc1', 'cc2'])
  })

  it('computes variance = budgeted − boqAmount when both sides exist and the code is fully priced', () => {
    const rows = boqVsBudgetRows({
      costCodes,
      boqItems: [item({ costCodeId: 'cc1', amount: 1000 })],
      budgetLines: [{ costCodeId: 'cc1', budgeted: 1200 }],
    })
    expect(rows[0]).toMatchObject({ boqAmount: 1000, budgeted: 1200, variance: 200 })
  })

  it('BOQ-only code: budgeted null, variance null', () => {
    const [row] = boqVsBudgetRows({ costCodes, boqItems: [item()], budgetLines: [] })
    expect(row.boqAmount).toBe(1000)
    expect(row.budgeted).toBe(null)
    expect(row.variance).toBe(null)
  })

  it('budget-only code: boqAmount null, variance null — never "under budget by everything"', () => {
    const [row] = boqVsBudgetRows({
      costCodes, boqItems: [], budgetLines: [{ costCodeId: 'cc1', budgeted: 1200 }],
    })
    expect(row.boqAmount).toBe(null)
    expect(row.variance).toBe(null)
  })

  it('a code whose items are ALL unpriced shows boqAmount null, variance null', () => {
    const [row] = boqVsBudgetRows({
      costCodes,
      boqItems: [unpriced({ costCodeId: 'cc1' })],
      budgetLines: [{ costCodeId: 'cc1', budgeted: 1200 }],
    })
    expect(row.boqAmount).toBe(null)
    expect(row.variance).toBe(null)
    expect(row.boqUnpricedCount).toBe(1)
  })

  it('a PARTIALLY priced code shows the priced sum but SUPPRESSES the variance', () => {
    const [row] = boqVsBudgetRows({
      costCodes,
      boqItems: [item({ costCodeId: 'cc1', amount: 1000 }), unpriced({ costCodeId: 'cc1' })],
      budgetLines: [{ costCodeId: 'cc1', budgeted: 1200 }],
    })
    expect(row.boqAmount).toBe(1000)
    expect(row.variance).toBe(null) // a partial sum must not be compared as complete
    expect(row.boqUnpricedCount).toBe(1)
  })

  it('sums multiple budget lines on one code', () => {
    const [row] = boqVsBudgetRows({
      costCodes,
      boqItems: [item({ costCodeId: 'cc1', amount: 1000 })],
      budgetLines: [
        { costCodeId: 'cc1', budgeted: 700 },
        { costCodeId: 'cc1', budgeted: 500 },
      ],
    })
    expect(row.budgeted).toBe(1200)
    expect(row.variance).toBe(200)
  })

  it('names resolve live, then fall back to the BOQ snapshot, then the budget snapshot', () => {
    const live = boqVsBudgetRows({ costCodes, boqItems: [item({ costCodeName: 'stale' })], budgetLines: [] })
    expect(live[0].costCodeName).toBe('03-100 — Concrete Slab')

    const snap = boqVsBudgetRows({
      costCodes: [], boqItems: [item({ costCodeId: 'gone', costCodeName: 'Old — Snapshot' })], budgetLines: [],
    })
    expect(snap[0].costCodeName).toBe('Old — Snapshot')
    expect(snap[0].isMissing).toBe(true)

    const budget = boqVsBudgetRows({
      costCodes: [], boqItems: [],
      budgetLines: [{ costCodeId: 'gone2', costCodeName: 'Budget — Snapshot', budgeted: 5 }],
    })
    expect(budget[0].costCodeName).toBe('Budget — Snapshot')
  })

  it('flags inactive codes without hiding them', () => {
    const rows = boqVsBudgetRows({
      costCodes, boqItems: [item({ costCodeId: 'cc2', costCodeName: '05-200 — Roofing', amount: 700 })], budgetLines: [],
    })
    expect(rows[0].isInactive).toBe(true)
  })

  it('void items contribute nothing to any row', () => {
    const rows = boqVsBudgetRows({
      costCodes,
      boqItems: [item({ status: 'void', amount: 99999 })],
      budgetLines: [{ costCodeId: 'cc1', budgeted: 1200 }],
    })
    expect(rows[0].boqAmount).toBe(null)
    expect(rows[0].boqItemCount).toBe(0)
  })

  it('sorts by cost-code name and does not mutate inputs', () => {
    const boqItems = [
      item({ costCodeId: 'cc2', costCodeName: '05-200 — Roofing', amount: 1 }),
      item({ costCodeId: 'cc1', amount: 2 }),
    ]
    const rows = boqVsBudgetRows({ costCodes, boqItems, budgetLines: [] })
    expect(rows.map(r => r.costCodeId)).toEqual(['cc1', 'cc2'])
    expect(boqItems).toHaveLength(2)
  })
})

// ── Register ordering ────────────────────────────────────────────────────────

describe('sortBoqItems', () => {
  it('orders by section, then NATURAL item number, then entry order', () => {
    const items = [
      item({ section: 'Substructure', itemNumber: '2.10', createdAt: { seconds: 3 } }),
      item({ section: 'Roof',         itemNumber: '9',    createdAt: { seconds: 1 } }),
      item({ section: 'Substructure', itemNumber: '2.9',  createdAt: { seconds: 2 } }),
      item({ section: 'Substructure', itemNumber: '',     createdAt: { seconds: 5 } }),
      item({ section: 'Substructure', itemNumber: '',     createdAt: { seconds: 4 } }),
    ]
    const sorted = sortBoqItems(items)
    expect(sorted.map(i => `${i.section}|${i.itemNumber}|${i.createdAt.seconds}`)).toEqual([
      'Roof|9|1',
      'Substructure||4',   // blank item numbers first within a section, entry order
      'Substructure||5',
      'Substructure|2.9|2', // natural: 2.9 before 2.10
      'Substructure|2.10|3',
    ])
    expect(items[0].itemNumber).toBe('2.10') // input untouched
  })

  it('tolerates missing fields and null input', () => {
    expect(sortBoqItems(null)).toEqual([])
    expect(sortBoqItems([{ id: 'a' }, { id: 'b' }])).toHaveLength(2)
  })
})

// ── Display ──────────────────────────────────────────────────────────────────

describe('formatQuantity', () => {
  it('formats measurements up to three decimals with grouping', () => {
    expect(formatQuantity(12.5)).toBe('12.5')
    expect(formatQuantity(1234.5678)).toBe('1,234.568')
    expect(formatQuantity(0)).toBe('0')
  })

  it('renders junk as "—", never NaN', () => {
    expect(formatQuantity(null)).toBe('—')
    expect(formatQuantity(undefined)).toBe('—')
    expect(formatQuantity('')).toBe('—')
    expect(formatQuantity('abc')).toBe('—')
    expect(formatQuantity(Infinity)).toBe('—')
  })
})

// ── Draft validation ─────────────────────────────────────────────────────────

describe('validateBoqItemDraft', () => {
  const valid = {
    description: 'Concrete in slab', quantity: '12.5', unit: 'm3',
    rate: '310.40', costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab',
  }

  it('accepts a fully priced draft and an unpriced draft (blank rate)', () => {
    expect(validateBoqItemDraft(valid)).toBe(null)
    expect(validateBoqItemDraft({ ...valid, rate: '' })).toBe(null)
    expect(validateBoqItemDraft({ ...valid, rate: null })).toBe(null)
  })

  it('accepts zero quantity and zero rate', () => {
    expect(validateBoqItemDraft({ ...valid, quantity: '0' })).toBe(null)
    expect(validateBoqItemDraft({ ...valid, rate: '0' })).toBe(null)
  })

  it('requires the cost-code spine', () => {
    expect(validateBoqItemDraft({ ...valid, costCodeId: '' })).toMatch(/cost code/i)
    expect(validateBoqItemDraft({ ...valid, costCodeName: '  ' })).toMatch(/display name/i)
  })

  it('requires description and unit', () => {
    expect(validateBoqItemDraft({ ...valid, description: '  ' })).toMatch(/description/i)
    expect(validateBoqItemDraft({ ...valid, unit: '' })).toMatch(/unit/i)
  })

  it('requires a numeric non-negative quantity', () => {
    expect(validateBoqItemDraft({ ...valid, quantity: '' })).toMatch(/quantity/i)
    expect(validateBoqItemDraft({ ...valid, quantity: 'abc' })).toMatch(/quantity/i)
    expect(validateBoqItemDraft({ ...valid, quantity: '-1' })).toMatch(/negative/i)
  })

  it('rejects a junk or negative rate but allows blank', () => {
    expect(validateBoqItemDraft({ ...valid, rate: 'abc' })).toMatch(/rate/i)
    expect(validateBoqItemDraft({ ...valid, rate: '-5' })).toMatch(/negative/i)
  })
})
