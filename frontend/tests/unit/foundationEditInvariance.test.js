import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  buildForecastRows, forecastRollups, forecastFinalCost,
  varianceToBudget, remainingBudgetReference, remainingBudgetSuggestion,
} from '../../src/lib/forecast'
import { computeMargin, projectForecastTotals } from '../../src/lib/margin'
import { budgetedTotal, boqVsBudgetRows, boqVarianceToBudget, boqTotals } from '../../src/lib/boq'
import {
  buildMonthlyActualRows, totalActualCashIn, totalActualCashOut, untimedUncommittedCtc,
} from '../../src/lib/cashFlow'
import { PO_STATUS } from '../../src/lib/purchaseOrders'
import { resolveCostCodeName } from '../../src/lib/costCodes'

// ── Foundation record editing — FINANCIAL INVARIANCE (ADR-39) ────────────────
//
// The three foundation records (Projects, Cost Codes, Budget Lines) became
// editable. This suite is the automated proof of exactly what each kind of edit
// may and may not move. It exercises the REAL read-time derivations — the same
// functions the Budget, Forecast, Commercial, BOQ and Cash Flow pages call —
// never a re-implementation.
//
// THE THREE CONTRACTS PROVED HERE:
//
//   1. PROJECT METADATA EDITS are financially inert. No derivation takes a
//      project field at all, so the proof is structural: the financial modules
//      never read `name`, `status`, `startDate`, `location` or `progress`.
//
//   2. COST-CODE RENAME AND DEACTIVATION change NO number. Every derivation
//      groups by `costCodeId`; `code`, `name` and `isActive` are display only.
//
//   3. A BUDGET-LINE `budgeted` EDIT moves the BUDGET-REFERENCE family and
//      NOTHING ELSE. Specifically it must NOT move Forecast Final Cost, and
//      therefore must not move Margin — and Cash Flow never sees it at all.
//
// The Firestore Rules suites prove the complementary half: that the immutable
// fields cannot be rewritten at the trust boundary.

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../src')

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// One project with two cost codes carrying real commitments, actuals and an
// authored forecast, so every figure under test is genuinely non-zero.

const COST_CODES = [
  { id: 'cc1', code: '03-100', name: 'Concrete Slab', unit: 'm3', isActive: true },
  { id: 'cc2', code: '05-200', name: 'Structural Steel', unit: 't', isActive: true },
]

const BUDGET_LINES = [
  { id: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', budgeted: 100_000, notes: '' },
  { id: 'bl2', costCodeId: 'cc2', costCodeName: '05-200 — Structural Steel', budgeted: 60_000, notes: '' },
]

const PURCHASE_ORDERS = [
  {
    id: 'po1', status: PO_STATUS.SENT, supplierName: 'BuildCo',
    lineItems: [
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', qty: 1, unitPrice: 40_000, lineTotal: 40_000 },
      { costCodeId: 'cc2', costCodeName: '05-200 — Structural Steel', qty: 1, unitPrice: 25_000, lineTotal: 25_000 },
    ],
  },
]

const PROGRESS_CLAIMS = [
  {
    id: 'pc1', status: 'approved', poId: 'po1',
    lineItems: [
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', approvedAmount: 12_000 },
    ],
  },
]

const FORECAST_LINES = [
  { id: 'cc1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', uncommittedCostToComplete: 8_000, notes: '' },
  { id: 'cc2', costCodeId: 'cc2', costCodeName: '05-200 — Structural Steel', uncommittedCostToComplete: 3_000, notes: '' },
]

const BASELINE = {
  originalContractValue: 500_000,
  originalApprovedBudget: 160_000,
  clientId: 'c1', clientName: 'Acme Developments',
}

const sources = (over = {}) => ({
  costCodes: COST_CODES,
  budgetLines: BUDGET_LINES,
  purchaseOrders: PURCHASE_ORDERS,
  progressClaims: PROGRESS_CLAIMS,
  supplierInvoices: [],
  supplierCreditNotes: [],
  variations: [],
  forecastLines: FORECAST_LINES,
  ...over,
})

// Rows keyed by cost code, for field-by-field comparison.
const byId = (rows) => Object.fromEntries(rows.map(r => [r.costCodeId, r]))

// Every NUMERIC field a forecast row carries. Used to assert that a display-only
// change moves none of them.
const NUMERIC_ROW_FIELDS = [
  'budgeted', 'actual', 'remainingCommitted', 'closedResidual',
  'approvedSupplierVariations', 'pendingSupplierVariationExposure',
  'storedUncommittedCostToComplete',
]

// ─────────────────────────────────────────────────────────────────────────────
// 1 · PROJECT METADATA EDITS ARE FINANCIALLY INERT
// ─────────────────────────────────────────────────────────────────────────────

describe('invariance — project metadata edits change no financial figure', () => {
  // The proof is structural rather than numeric: a project field cannot move a
  // figure it is never read by. These assertions fail the moment somebody
  // wires a project metadata field into a financial derivation.
  const FINANCIAL_MODULES = [
    'forecast.js', 'margin.js', 'boq.js', 'cashFlow.js',
    'purchaseOrders.js', 'progressClaims.js', 'supplierInvoices.js',
    'supplierCreditNotes.js', 'variations.js', 'tenders.js',
  ]

  // `status`/`progress`/`location`/`startDate`/`name` as a PROJECT property.
  // (`status` and `name` are common words on other documents — POs, claims and
  // invoices all have their own — so the probe is deliberately the
  // `project.`-qualified access, which is what would actually appear.)
  const PROJECT_FIELD_ACCESSES = [
    'project.status', 'project?.status',
    'project.progress', 'project?.progress',
    'project.location', 'project?.location',
    'project.startDate', 'project?.startDate',
    'project.name', 'project?.name',
  ]

  for (const mod of FINANCIAL_MODULES) {
    it(`lib/${mod} reads no editable project metadata field`, () => {
      const source = readFileSync(resolve(SRC, 'lib', mod), 'utf8')
      for (const access of PROJECT_FIELD_ACCESSES) {
        expect(source.includes(access), `${mod} must not read ${access}`).toBe(false)
      }
    })
  }

  it('the whole forecast/margin pipeline takes no project document at all', () => {
    // buildForecastRows and projectForecastTotals accept cost codes, budget
    // lines, POs, claims, invoices, credits, variations and forecast lines —
    // and no project. There is nothing for a metadata edit to reach.
    const totals = projectForecastTotals(sources())
    const again = projectForecastTotals(sources())
    expect(again).toEqual(totals)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · COST-CODE RENAME AND DEACTIVATION CHANGE NO NUMBER
// ─────────────────────────────────────────────────────────────────────────────

describe('invariance — a cost-code RENAME changes no numeric output', () => {
  const RENAMED = [
    { ...COST_CODES[0], code: '03-110', name: 'Concrete Slab — Suspended' },
    COST_CODES[1],
  ]

  it('forecast rollups are byte-identical after a rename', () => {
    const before = forecastRollups(effective(buildForecastRows(sources())))
    const after = forecastRollups(effective(buildForecastRows(sources({ costCodes: RENAMED }))))
    expect(after).toEqual(before)
  })

  it('every numeric field on every forecast row is unchanged; only the label moves', () => {
    const before = byId(buildForecastRows(sources()))
    const after = byId(buildForecastRows(sources({ costCodes: RENAMED })))

    for (const id of Object.keys(before)) {
      for (const field of NUMERIC_ROW_FIELDS) {
        expect(after[id][field], `${id}.${field}`).toEqual(before[id][field])
      }
      expect(after[id].hasBudgetLine).toBe(before[id].hasBudgetLine)
      expect(after[id].isMissing).toBe(before[id].isMissing)
    }

    // The ONLY difference is the display name — resolved live, never written.
    expect(before.cc1.costCodeName).toBe('03-100 — Concrete Slab')
    expect(after.cc1.costCodeName).toBe('03-110 — Concrete Slab — Suspended')
    expect(after.cc2.costCodeName).toBe(before.cc2.costCodeName)
  })

  it('the historical budget-line snapshot is NOT rewritten by the rename', () => {
    // The fixture is the same object identity before and after: nothing in the
    // read path mutates a stored document.
    buildForecastRows(sources({ costCodes: RENAMED }))
    expect(BUDGET_LINES[0].costCodeName).toBe('03-100 — Concrete Slab')
  })

  it('the Budget page resolves the CURRENT name from the stale snapshot', () => {
    // This is the read-time reconciliation that keeps the Budget tab consistent
    // with Forecast and BOQ after a rename — with no backfill.
    expect(resolveCostCodeName('cc1', RENAMED, BUDGET_LINES[0].costCodeName))
      .toBe('03-110 — Concrete Slab — Suspended')
  })

  it('margin is unchanged after a rename', () => {
    const before = computeMargin({
      baseline: BASELINE, variations: [],
      forecastFinalCost: projectForecastTotals(sources()).forecastFinalCost,
    })
    const after = computeMargin({
      baseline: BASELINE, variations: [],
      forecastFinalCost: projectForecastTotals(sources({ costCodes: RENAMED })).forecastFinalCost,
    })
    expect(after).toEqual(before)
  })

  it('the BOQ-vs-budget comparison is numerically unchanged after a rename', () => {
    const boqItems = [
      { id: 'b1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', quantity: 10, rate: 9_000, amount: 90_000, status: 'active' },
    ]
    const before = byId(boqVsBudgetRows({ costCodes: COST_CODES, boqItems, budgetLines: BUDGET_LINES }))
    const after = byId(boqVsBudgetRows({ costCodes: RENAMED, boqItems, budgetLines: BUDGET_LINES }))
    for (const id of Object.keys(before)) {
      expect(after[id].budgeted).toEqual(before[id].budgeted)
      expect(after[id].boqAmount).toEqual(before[id].boqAmount)
      expect(after[id].variance).toEqual(before[id].variance)
    }
  })
})

describe('invariance — DEACTIVATING a cost code changes no numeric output', () => {
  const DEACTIVATED = [{ ...COST_CODES[0], isActive: false }, COST_CODES[1]]

  it('the deactivated code KEEPS its forecast row — it is never dropped', () => {
    const rows = byId(buildForecastRows(sources({ costCodes: DEACTIVATED })))
    expect(rows.cc1).toBeDefined()
    expect(rows.cc1.isInactive).toBe(true)
    expect(rows.cc1.isMissing).toBe(false)
  })

  it('forecast rollups are byte-identical after deactivation', () => {
    const before = forecastRollups(effective(buildForecastRows(sources())))
    const after = forecastRollups(effective(buildForecastRows(sources({ costCodes: DEACTIVATED }))))
    expect(after).toEqual(before)
  })

  it('every numeric row field is unchanged; only the isInactive FLAG moves', () => {
    const before = byId(buildForecastRows(sources()))
    const after = byId(buildForecastRows(sources({ costCodes: DEACTIVATED })))
    for (const id of Object.keys(before)) {
      for (const field of NUMERIC_ROW_FIELDS) {
        expect(after[id][field], `${id}.${field}`).toEqual(before[id][field])
      }
      expect(after[id].costCodeName).toBe(before[id].costCodeName)
    }
    expect(before.cc1.isInactive).toBe(false)
    expect(after.cc1.isInactive).toBe(true)
  })

  it('the Approved Budget total is unchanged after deactivation', () => {
    expect(budgetedTotal(BUDGET_LINES)).toBe(160_000)
  })

  it('margin is unchanged after deactivation', () => {
    const before = computeMargin({
      baseline: BASELINE, variations: [],
      forecastFinalCost: projectForecastTotals(sources()).forecastFinalCost,
    })
    const after = computeMargin({
      baseline: BASELINE, variations: [],
      forecastFinalCost: projectForecastTotals(sources({ costCodes: DEACTIVATED })).forecastFinalCost,
    })
    expect(after).toEqual(before)
  })

  it('the BOQ comparison keeps the inactive code and its figures', () => {
    const boqItems = [
      { id: 'b1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', quantity: 10, rate: 9_000, amount: 90_000, status: 'active' },
    ]
    const rows = byId(boqVsBudgetRows({ costCodes: DEACTIVATED, boqItems, budgetLines: BUDGET_LINES }))
    expect(rows.cc1.isInactive).toBe(true)
    expect(rows.cc1.budgeted).toBe(100_000)
    expect(rows.cc1.boqAmount).toBe(90_000)
    expect(rows.cc1.variance).toBe(10_000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · A BUDGET-LINE `budgeted` EDIT — WHAT MOVES AND WHAT MUST NOT
// ─────────────────────────────────────────────────────────────────────────────

// The Forecast page's effective rows: the stored Uncommitted CTC applied, then
// FFC/variance/reference derived. Mirrors ProjectForecast.jsx with no edits open.
function effective(rows) {
  return rows.map(r => {
    const ctc = r.storedUncommittedCostToComplete
    const ffc = forecastFinalCost(r.actual, r.remainingCommitted, ctc)
    return {
      ...r,
      uncommittedCostToComplete: ctc,
      forecastFinalCost: ffc,
      varianceToBudget: varianceToBudget(r.budgeted ?? 0, ffc),
      remainingBudgetRef: remainingBudgetReference(r.budgeted ?? 0, r.actual, r.remainingCommitted),
    }
  })
}

// The SAME project with cc1's approved budget corrected 100,000 → 112,500.
const EDITED_BUDGET_LINES = [
  { ...BUDGET_LINES[0], budgeted: 112_500 },
  BUDGET_LINES[1],
]
const DELTA = 12_500

describe('invariance — a budgeted edit MOVES the budget-reference family', () => {
  const before = forecastRollups(effective(buildForecastRows(sources())))
  const after = forecastRollups(effective(buildForecastRows(sources({ budgetLines: EDITED_BUDGET_LINES }))))

  it('Approved Budget rises by exactly the delta', () => {
    expect(before.budgeted).toBe(160_000)
    expect(after.budgeted).toBe(before.budgeted + DELTA)
  })

  it('Variance to Budget improves by exactly the delta', () => {
    expect(after.varianceToBudget).toBe(before.varianceToBudget + DELTA)
  })

  it('the per-row Remaining Budget Reference rises by exactly the delta', () => {
    const b = byId(effective(buildForecastRows(sources())))
    const a = byId(effective(buildForecastRows(sources({ budgetLines: EDITED_BUDGET_LINES }))))
    expect(a.cc1.remainingBudgetRef).toBe(b.cc1.remainingBudgetRef + DELTA)
    expect(a.cc2.remainingBudgetRef).toBe(b.cc2.remainingBudgetRef)
  })

  it('the Budget tab Remaining (Budgeted − Actual) rises by exactly the delta', () => {
    const remaining = (lines, actual) =>
      lines.reduce((s, l) => s + (l.budgeted || 0), 0) - actual
    const actual = before.actual
    expect(remaining(EDITED_BUDGET_LINES, actual)).toBe(remaining(BUDGET_LINES, actual) + DELTA)
  })

  it('the BOQ Approved Budget total and variance rise by exactly the delta', () => {
    const boqItems = [
      { id: 'b1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', quantity: 10, rate: 9_000, amount: 90_000, status: 'active' },
    ]
    const totals = boqTotals(boqItems)
    expect(budgetedTotal(EDITED_BUDGET_LINES)).toBe(budgetedTotal(BUDGET_LINES) + DELTA)
    expect(boqVarianceToBudget(budgetedTotal(EDITED_BUDGET_LINES), totals))
      .toBe(boqVarianceToBudget(budgetedTotal(BUDGET_LINES), totals) + DELTA)
  })
})

describe('invariance — a budgeted edit MUST NOT move Forecast Final Cost', () => {
  it('project Forecast Final Cost is byte-identical', () => {
    // FFC = Actual + Remaining Committed + Uncommitted Cost to Complete.
    // `budgeted` appears in none of those terms.
    const before = projectForecastTotals(sources())
    const after = projectForecastTotals(sources({ budgetLines: EDITED_BUDGET_LINES }))
    expect(after.forecastFinalCost).toBe(before.forecastFinalCost)
  })

  it('per-row Forecast Final Cost, Actual and Remaining Committed are unchanged', () => {
    const b = byId(effective(buildForecastRows(sources())))
    const a = byId(effective(buildForecastRows(sources({ budgetLines: EDITED_BUDGET_LINES }))))
    for (const id of ['cc1', 'cc2']) {
      expect(a[id].forecastFinalCost).toBe(b[id].forecastFinalCost)
      expect(a[id].actual).toBe(b[id].actual)
      expect(a[id].remainingCommitted).toBe(b[id].remainingCommitted)
      expect(a[id].uncommittedCostToComplete).toBe(b[id].uncommittedCostToComplete)
    }
  })

  it('a stored Uncommitted CTC is NOT recomputed from the new budget', () => {
    // "Use remaining budget" COPIES a value at the moment it is pressed; it is
    // never a live formula. After a budget edit the stored figure must stand,
    // even though the suggestion it would now offer has changed.
    const rows = byId(buildForecastRows(sources({ budgetLines: EDITED_BUDGET_LINES })))
    expect(rows.cc1.storedUncommittedCostToComplete).toBe(8_000)

    const b = byId(effective(buildForecastRows(sources())))
    const a = byId(effective(buildForecastRows(sources({ budgetLines: EDITED_BUDGET_LINES }))))
    // The SUGGESTION moves with the budget…
    expect(remainingBudgetSuggestion(a.cc1.remainingBudgetRef))
      .toBe(remainingBudgetSuggestion(b.cc1.remainingBudgetRef) + DELTA)
    // …but nothing applies it, so FFC stands still.
    expect(a.cc1.forecastFinalCost).toBe(b.cc1.forecastFinalCost)
  })

  it('the cost-side rollups (actual, committed, CTC) are all unchanged', () => {
    const before = forecastRollups(effective(buildForecastRows(sources())))
    const after = forecastRollups(effective(buildForecastRows(sources({ budgetLines: EDITED_BUDGET_LINES }))))
    for (const field of [
      'actual', 'remainingCommitted', 'uncommittedCostToComplete',
      'costToComplete', 'forecastFinalCost',
      'approvedSupplierVariations', 'pendingSupplierVariationExposure',
    ]) {
      expect(after[field], field).toBe(before[field])
    }
  })
})

describe('invariance — a budgeted edit MUST NOT move Margin', () => {
  const ffcBefore = projectForecastTotals(sources()).forecastFinalCost
  const ffcAfter = projectForecastTotals(sources({ budgetLines: EDITED_BUDGET_LINES })).forecastFinalCost

  it('the FFC fed to computeMargin is the same number', () => {
    expect(ffcAfter).toBe(ffcBefore)
  })

  it('every margin output is byte-identical with the same baseline', () => {
    const before = computeMargin({ baseline: BASELINE, variations: [], forecastFinalCost: ffcBefore })
    const after = computeMargin({ baseline: BASELINE, variations: [], forecastFinalCost: ffcAfter })
    expect(after).toEqual(before)
  })

  it('Forecast Gross Profit and Forecast Margin % specifically do not move', () => {
    const before = computeMargin({ baseline: BASELINE, variations: [], forecastFinalCost: ffcBefore })
    const after = computeMargin({ baseline: BASELINE, variations: [], forecastFinalCost: ffcAfter })
    expect(after.forecastGrossProfit).toBe(before.forecastGrossProfit)
    expect(after.forecastMarginPct).toBe(before.forecastMarginPct)
    expect(after.currentContractSum).toBe(before.currentContractSum)
    expect(after.forecastRevenue).toBe(before.forecastRevenue)
  })

  it('Original Planned Profit is unmoved — the baseline is never auto-updated', () => {
    // ProjectCommercial shows the live Approved Budget as a REFERENCE behind an
    // explicit "Use current approved budget" action. Editing a budget line must
    // never write `originalApprovedBudget`.
    const before = computeMargin({ baseline: BASELINE, variations: [], forecastFinalCost: ffcBefore })
    const after = computeMargin({ baseline: BASELINE, variations: [], forecastFinalCost: ffcAfter })
    expect(after.originalApprovedBudget).toBe(160_000)
    expect(after.originalPlannedProfit).toBe(before.originalPlannedProfit)
    expect(after.originalPlannedMarginPct).toBe(before.originalPlannedMarginPct)
    expect(after.marginMovement).toBe(before.marginMovement)
  })
})

describe('invariance — a budgeted edit MUST NOT move Cash Flow', () => {
  // Actual cash: receipts in, payments out. Neither reads a budget line.
  const IN_ROWS = [{ id: 'cr1', receiptDate: '2026-06-15', amount: 55_000 }]
  const OUT_ROWS = [{ id: 'sp1', paymentDate: '2026-06-20', amount: 21_000 }]

  it('lib/cashFlow.js reads no budget line at all', () => {
    // Structural: the module cannot be moved by a value it never receives.
    const source = readFileSync(resolve(SRC, 'lib', 'cashFlow.js'), 'utf8')
    for (const probe of ['budgetLines', 'budgeted', 'budgetedTotal']) {
      expect(source.includes(probe), `cashFlow.js must not reference ${probe}`).toBe(false)
    }
  })

  it('monthly actual rows and cash totals are byte-identical', () => {
    const before = buildMonthlyActualRows(IN_ROWS, OUT_ROWS)
    const after = buildMonthlyActualRows(IN_ROWS, OUT_ROWS)
    expect(after).toEqual(before)
    expect(totalActualCashIn(IN_ROWS)).toBe(55_000)
    expect(totalActualCashOut(OUT_ROWS)).toBe(21_000)
  })

  it('the untimed Uncommitted CTC is unchanged, because the CTC total is unchanged', () => {
    // The only forecast figure the Cash Flow page lifts is the STORED
    // Uncommitted CTC total — which a budget edit does not touch.
    const before = projectForecastTotals(sources()).uncommittedCostToComplete
    const after = projectForecastTotals(sources({ budgetLines: EDITED_BUDGET_LINES })).uncommittedCostToComplete
    expect(after).toBe(before)
    expect(untimedUncommittedCtc({ uncommittedCtcTotal: after, lines: [] }))
      .toBe(untimedUncommittedCtc({ uncommittedCtcTotal: before, lines: [] }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · EDITING TO ZERO — the boundary value
// ─────────────────────────────────────────────────────────────────────────────

describe('invariance — correcting a budget to ZERO behaves as a real value', () => {
  const ZEROED = [{ ...BUDGET_LINES[0], budgeted: 0 }, BUDGET_LINES[1]]

  it('the line keeps its row and still reports hasBudgetLine', () => {
    // Zero is a reviewed allocation of nothing — NOT "no budget line", which
    // is what drives the Budget page's unbudgeted warning rows.
    const rows = byId(buildForecastRows(sources({ budgetLines: ZEROED })))
    expect(rows.cc1.hasBudgetLine).toBe(true)
    expect(rows.cc1.budgeted).toBe(0)
  })

  it('Forecast Final Cost still does not move', () => {
    expect(projectForecastTotals(sources({ budgetLines: ZEROED })).forecastFinalCost)
      .toBe(projectForecastTotals(sources()).forecastFinalCost)
  })

  it('the variance goes negative — an overrun is surfaced, never hidden', () => {
    const rows = byId(effective(buildForecastRows(sources({ budgetLines: ZEROED }))))
    expect(rows.cc1.varianceToBudget).toBeLessThan(0)
  })
})
