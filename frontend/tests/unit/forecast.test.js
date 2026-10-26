import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  isUnforecasted, isOverBudget, safeNumber,
  buildForecastRows, composeForecastRow, forecastRollups,
  forecastCostToComplete, forecastFinalCost, varianceToBudget, remainingBudgetReference,
} from '../../src/lib/forecast'
import { projectForecastTotals } from '../../src/lib/margin'
import {
  costCoverage, completenessState, COMPLETENESS_STATE, peakFundingSuppression,
  CFL_SOURCE_TYPE,
} from '../../src/lib/cashFlow'
import { PO_STATUS } from '../../src/lib/purchaseOrders'

// ── Forecast row composition — ONE definition (ADR-43) ───────────────────────
//
// Before ADR-43 three copies of "the effective forecast row" existed: the
// Forecast page (complete), projectForecastTotals (no flags, no costToComplete)
// and a test helper (no flags). forecastRollups counts rows by their
// `unforecasted` / `overBudget` flags, so the SAVED path reported
// unforecastedCount = overBudgetCount = 0 forever, and Cash Flow — the only
// consumer of that count — could never warn that its cost basis was incomplete,
// never withhold "Complete", and never suppress peak funding for it.
//
// This file pins:
//   1. the two predicates and their boundaries;
//   2. composeForecastRow over every kind of row the cost-code union produces;
//   3. projectForecastTotals carrying the counts (and costToComplete) it never did;
//   4. parity between the Forecast page's no-edits composition and the saved path;
//   5. the count reaching Cash Flow's completeness and suppression functions;
//   6. the source structure that keeps all three callers on the one composer.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

// ── Fixtures: every row shape the cost-code union produces ───────────────────
//
//   cc1  active, budgeted 1000, PO 800, approved claim 300 awaiting invoice,
//        saved CTC 150
//        → Remaining Committed 500 (800 − 300), FFC 950, variance +50 → forecast,
//          NOT over budget. (Pre-ADR-55 this read FFC 1250 / −250 / over budget:
//          the approved claim sat in Actual AND still inside Remaining Committed.)
//   cc2  active, budgeted 500, no activity, saved CTC 0
//        → FFC 0, variance +500 → forecast (ZERO IS A FORECAST), not over budget
//   cc3  INACTIVE, unbudgeted, PO 120 fully certified by an approved claim 120
//        awaiting invoice, no forecast line
//        → actual 120, Remaining Committed 0 → unforecasted, never over budget
//   cc4  MISSING from the cost-code list, forecast line saved null
//        → unforecasted; name falls back to the stored snapshot
//   cc5  active, unbudgeted, PO 200 open, no forecast line
//        → FFC 200 > budget 0 but NOT over budget (unbudgeted); unforecasted
//   cc6  active, variation-only (pending supplier variation 75)
//        → row exists with every money figure 0; unforecasted
//   cc7  active, budget-only 300, nothing else, no forecast line
//        → unforecasted; variance +300, not over budget

const COST_CODES = [
  { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
  { id: 'cc2', code: '03-200', name: 'Formwork', isActive: true },
  { id: 'cc3', code: '04-100', name: 'Legacy Demo', isActive: false },
  { id: 'cc5', code: '05-100', name: 'Steel', isActive: true },
  { id: 'cc6', code: '06-100', name: 'Carpentry', isActive: true },
  { id: 'cc7', code: '07-100', name: 'Roofing', isActive: true },
]

const BUDGET_LINES = [
  { id: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 1000 },
  { id: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 500 },
  { id: 'bl7', costCodeId: 'cc7', costCodeName: '07-100 — Roofing', budgeted: 300 },
]

const PURCHASE_ORDERS = [
  { id: 'po1', status: PO_STATUS.SENT, lineItems: [
    { costCodeId: 'cc1', lineTotal: 800 },
    { costCodeId: 'cc5', lineTotal: 200 },
  ] },
  { id: 'po2', status: PO_STATUS.SENT, lineItems: [{ costCodeId: 'cc3', lineTotal: 120 }] },
  // A draft PO commits nothing.
  { id: 'po9', status: PO_STATUS.DRAFT, lineItems: [{ costCodeId: 'cc1', lineTotal: 99_999 }] },
]

// Claim lines carry `poLineIndex` as every stored claim line does — it is the
// identity Remaining Committed nets by (ADR-55).
const PROGRESS_CLAIMS = [
  { id: 'cl1', status: 'approved', poId: 'po1', lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', approvedThisPeriod: 300 }] },
  { id: 'cl2', status: 'approved', poId: 'po2', lineItems: [{ poLineIndex: 0, costCodeId: 'cc3', approvedThisPeriod: 120 }] },
]

const VARIATIONS = [
  { id: 'sv1', variationType: 'supplier', status: 'submitted', submittedSubtotal: 75,
    lineItems: [{ costCodeId: 'cc6', submittedAmount: 75 }] },
]

const FORECAST_LINES = [
  { id: 'cc1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', uncommittedCostToComplete: 150 },
  { id: 'cc2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', uncommittedCostToComplete: 0 },
  { id: 'cc4', costCodeId: 'cc4', costCodeName: '99-900 — Removed Code', uncommittedCostToComplete: null },
]

const sources = (over = {}) => ({
  costCodes: COST_CODES,
  budgetLines: BUDGET_LINES,
  purchaseOrders: PURCHASE_ORDERS,
  progressClaims: PROGRESS_CLAIMS,
  supplierInvoices: [],
  supplierCreditNotes: [],
  variations: VARIATIONS,
  forecastLines: FORECAST_LINES,
  ...over,
})

const byId = (rows) => Object.fromEntries(rows.map(r => [r.costCodeId, r]))
const savedRows = (src = sources()) =>
  buildForecastRows(src).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete))

// Every forecast line SAVED (cc2 explicitly 0, the rest 0 too) — a fully
// forecast project where cc3's open commitment of 120 has been judged complete.
const FULLY_FORECAST_LINES = [
  { id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 150 },
  { id: 'cc2', costCodeId: 'cc2', uncommittedCostToComplete: 0 },
  { id: 'cc3', costCodeId: 'cc3', uncommittedCostToComplete: 0 },
  { id: 'cc4', costCodeId: 'cc4', costCodeName: '99-900 — Removed Code', uncommittedCostToComplete: 0 },
  { id: 'cc5', costCodeId: 'cc5', uncommittedCostToComplete: 0 },
  { id: 'cc6', costCodeId: 'cc6', uncommittedCostToComplete: 0 },
  { id: 'cc7', costCodeId: 'cc7', uncommittedCostToComplete: 0 },
]

// ─────────────────────────────────────────────────────────────────────────────
// 1 · PREDICATES
// ─────────────────────────────────────────────────────────────────────────────

describe('isUnforecasted — null/undefined only; a saved 0 is a forecast', () => {
  it('null and undefined are unforecasted', () => {
    expect(isUnforecasted(null)).toBe(true)
    expect(isUnforecasted(undefined)).toBe(true)
  })

  it('zero, positive and negative numbers are forecast values', () => {
    expect(isUnforecasted(0)).toBe(false)
    expect(isUnforecasted(-0)).toBe(false)
    expect(isUnforecasted(150)).toBe(false)
    expect(isUnforecasted(-1)).toBe(false)
  })

  it('a malformed stored value is NOT unforecasted (pre-existing semantics preserved)', () => {
    // It is not redefined as blank; it simply contributes zero via safeNumber.
    expect(isUnforecasted('abc')).toBe(false)
    expect(isUnforecasted('')).toBe(false)
    expect(isUnforecasted(NaN)).toBe(false)
    expect(safeNumber('abc')).toBe(0)
    expect(safeNumber(NaN)).toBe(0)
    expect(safeNumber('')).toBe(0)
  })
})

describe('isOverBudget — strictly negative variance, at cent resolution', () => {
  it('negative is over budget; zero and positive are not', () => {
    expect(isOverBudget(-0.01)).toBe(true)
    expect(isOverBudget(-250)).toBe(true)
    expect(isOverBudget(0)).toBe(false)
    expect(isOverBudget(0.01)).toBe(false)
    expect(isOverBudget(500)).toBe(false)
  })

  it('a sub-cent negative rounds to zero and is NOT over budget', () => {
    expect(isOverBudget(-0.004)).toBe(false)
    expect(isOverBudget(-0.005)).toBe(false) // rounds to −0.00
    expect(isOverBudget(-0.006)).toBe(true)  // rounds to −0.01
  })

  it('null, undefined and junk are never over budget', () => {
    expect(isOverBudget(null)).toBe(false)
    expect(isOverBudget(undefined)).toBe(false)
    expect(isOverBudget('abc')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · composeForecastRow
// ─────────────────────────────────────────────────────────────────────────────

describe('composeForecastRow — figures come from the authoritative functions only', () => {
  const base = { costCodeId: 'x', hasBudgetLine: true, budgeted: 1000, actual: 300, remainingCommitted: 800 }

  it('attaches every input-dependent output, each equal to its named function', () => {
    const r = composeForecastRow(base, 150)
    expect(r.uncommittedCostToComplete).toBe(150)
    expect(r.costToComplete).toBe(forecastCostToComplete(800, 150))
    expect(r.forecastFinalCost).toBe(forecastFinalCost(300, 800, 150))
    expect(r.varianceToBudget).toBe(varianceToBudget(1000, r.forecastFinalCost))
    expect(r.remainingBudgetRef).toBe(remainingBudgetReference(1000, 300, 800))
    expect(r.costToComplete).toBe(950)
    expect(r.forecastFinalCost).toBe(1250)
    expect(r.varianceToBudget).toBe(-250)
    expect(r.remainingBudgetRef).toBe(-100)
    expect(r.unforecasted).toBe(false)
    expect(r.overBudget).toBe(true)
  })

  it('preserves every base-row field (spread, not rebuilt)', () => {
    const r = composeForecastRow({ ...base, costCodeName: 'N', isInactive: true, notes: 'n' }, 1)
    expect(r.costCodeName).toBe('N')
    expect(r.isInactive).toBe(true)
    expect(r.notes).toBe('n')
    expect(r.budgeted).toBe(1000)
  })

  it('null → unforecasted and contributes zero; 0 → forecast and contributes zero', () => {
    const n = composeForecastRow(base, null)
    const z = composeForecastRow(base, 0)
    const u = composeForecastRow(base, undefined)
    expect(n.unforecasted).toBe(true)
    expect(u.unforecasted).toBe(true)
    expect(z.unforecasted).toBe(false)
    for (const r of [n, z, u]) {
      expect(r.costToComplete).toBe(800)
      expect(r.forecastFinalCost).toBe(1100)
      expect(r.varianceToBudget).toBe(-100)
    }
    expect(n.uncommittedCostToComplete).toBe(null)
    expect(z.uncommittedCostToComplete).toBe(0)
  })

  it('a malformed stored value contributes zero and is NOT reported as unforecasted', () => {
    const r = composeForecastRow(base, 'abc')
    expect(r.unforecasted).toBe(false)
    expect(r.forecastFinalCost).toBe(1100)
    expect(r.uncommittedCostToComplete).toBe('abc') // carried, never coerced
  })

  it('overBudget requires a budget line — an unbudgeted row with cost is never over budget', () => {
    const unbudgeted = { costCodeId: 'u', hasBudgetLine: false, budgeted: null, actual: 300, remainingCommitted: 800 }
    const r = composeForecastRow(unbudgeted, 150)
    expect(r.forecastFinalCost).toBe(1250)
    expect(r.varianceToBudget).toBe(-1250) // informational, against a 0 budget
    expect(r.overBudget).toBe(false)
  })

  it('exact budget is NOT over budget; one cent over is', () => {
    const exact = composeForecastRow({ ...base, budgeted: 1250 }, 150)
    expect(exact.varianceToBudget).toBe(0)
    expect(exact.overBudget).toBe(false)
    const cent = composeForecastRow({ ...base, budgeted: 1249.99 }, 150)
    expect(cent.varianceToBudget).toBe(-0.01)
    expect(cent.overBudget).toBe(true)
  })

  it('rounding boundary: a sub-cent overrun is not an overrun', () => {
    const r = composeForecastRow({ ...base, budgeted: 1250 }, 150.004)
    expect(r.forecastFinalCost).toBe(1250)
    expect(r.overBudget).toBe(false)
    const over = composeForecastRow({ ...base, budgeted: 1250 }, 150.006)
    expect(over.forecastFinalCost).toBe(1250.01)
    expect(over.overBudget).toBe(true)
  })

  it('a negative actual (over-credited code) flows through unclamped', () => {
    const r = composeForecastRow({ costCodeId: 'c', hasBudgetLine: true, budgeted: 100, actual: -40, remainingCommitted: 0 }, null)
    expect(r.forecastFinalCost).toBe(-40)
    expect(r.varianceToBudget).toBe(140)
    expect(r.overBudget).toBe(false)
    expect(r.unforecasted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · THE COST-CODE UNION, ROW BY ROW
// ─────────────────────────────────────────────────────────────────────────────

describe('composition over the full cost-code union', () => {
  const rows = byId(savedRows())

  it('builds exactly the seven union rows', () => {
    expect(Object.keys(rows).sort()).toEqual(['cc1', 'cc2', 'cc3', 'cc4', 'cc5', 'cc6', 'cc7'])
  })

  it('cc1 — budgeted, PO 800, approved claim 300 awaiting invoice, forecast 150 → FFC 950, under budget (ADR-55)', () => {
    expect(rows.cc1.actual).toBe(300)
    expect(rows.cc1.remainingCommitted).toBe(500)          // 800 − 300 recognised on the line
    expect(rows.cc1.approvedClaimsAwaitingInvoice).toBe(300)
    expect(rows.cc1.costToComplete).toBe(650)              // 500 + 150
    expect(rows.cc1.forecastFinalCost).toBe(950)           // 300 + 500 + 150 — the 300 counted ONCE
    expect(rows.cc1.varianceToBudget).toBe(50)
    expect(rows.cc1.unforecasted).toBe(false)
    expect(rows.cc1.overBudget).toBe(false)
  })

  it('cc2 — saved ZERO is a completed forecast, not unforecasted', () => {
    expect(rows.cc2.storedUncommittedCostToComplete).toBe(0)
    expect(rows.cc2.unforecasted).toBe(false)
    expect(rows.cc2.overBudget).toBe(false)
    expect(rows.cc2.varianceToBudget).toBe(500)
  })

  it('cc3 — INACTIVE, PO fully certified: Remaining Committed 0, unforecasted, never over budget', () => {
    expect(rows.cc3.isInactive).toBe(true)
    expect(rows.cc3.hasBudgetLine).toBe(false)
    expect(rows.cc3.actual).toBe(120)
    expect(rows.cc3.remainingCommitted).toBe(0)            // the 120 PO line is wholly recognised by the claim
    expect(rows.cc3.forecastFinalCost).toBe(120)
    expect(rows.cc3.unforecasted).toBe(true)
    expect(rows.cc3.overBudget).toBe(false)
  })

  it('cc4 — MISSING cost code with a null forecast line: unforecasted, snapshot name kept', () => {
    expect(rows.cc4.isMissing).toBe(true)
    expect(rows.cc4.costCodeName).toBe('99-900 — Removed Code')
    expect(rows.cc4.hasForecastLine).toBe(true)
    expect(rows.cc4.unforecasted).toBe(true)
    expect(rows.cc4.forecastFinalCost).toBe(0)
  })

  it('cc5 — unbudgeted with an open PO: unforecasted, NOT over budget despite FFC > 0', () => {
    expect(rows.cc5.hasBudgetLine).toBe(false)
    expect(rows.cc5.forecastFinalCost).toBe(200)
    expect(rows.cc5.varianceToBudget).toBe(-200)
    expect(rows.cc5.overBudget).toBe(false)
    expect(rows.cc5.unforecasted).toBe(true)
  })

  it('cc6 — variation-only: a row with zero money, unforecasted', () => {
    expect(rows.cc6.pendingSupplierVariationExposure).toBe(75)
    expect(rows.cc6.forecastFinalCost).toBe(0)
    expect(rows.cc6.costToComplete).toBe(0)
    expect(rows.cc6.unforecasted).toBe(true)
    expect(rows.cc6.overBudget).toBe(false)
  })

  it('cc7 — budget-only: unforecasted, under budget', () => {
    expect(rows.cc7.forecastFinalCost).toBe(0)
    expect(rows.cc7.varianceToBudget).toBe(300)
    expect(rows.cc7.unforecasted).toBe(true)
    expect(rows.cc7.overBudget).toBe(false)
  })
})

describe('an over-credited cost code carries a NEGATIVE actual through the composition', () => {
  // A posted, retention-free invoice with two cost codes, and a posted credit
  // note against cc8 for more than cc8's line — valid at the central gate
  // (the credit total is within the target's payableTotal and cc8 is on it).
  const invoice = {
    id: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-1', status: 'posted',
    supplierId: 'sup1', supplierName: 'Ace', currency: 'AUD',
    lineItems: [
      { costCodeId: 'cc8', costCodeName: '08 — A', description: 'a', amount: 60, taxCode: 'gst', gstAmount: 6 },
      { costCodeId: 'cc9', costCodeName: '09 — B', description: 'b', amount: 60, taxCode: 'gst', gstAmount: 6 },
    ],
    retention: 0, retentionGst: 0, retentionTotal: 0,
    subtotal: 120, gstTotal: 12, grossTotal: 132, net: 120, payableGst: 12, payableTotal: 132,
  }
  const credit = {
    id: 'cn1', creditNumber: 'SCN-0001', status: 'posted', docType: 'credit_note',
    supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-1',
    supplierId: 'sup1', supplierName: 'Ace', currency: 'AUD', creditDate: '2026-02-01', reason: 'r',
    lineItems: [{ costCodeId: 'cc8', costCodeName: '08 — A', description: 'c', amount: 100, taxCode: 'gst', gstAmount: 10 }],
    subtotal: 100, gstTotal: 10, grossTotal: 110,
  }
  const src = sources({
    costCodes: [], budgetLines: [{ id: 'b', costCodeId: 'cc8', budgeted: 50 }], purchaseOrders: [],
    progressClaims: [], variations: [], forecastLines: [],
    supplierInvoices: [invoice], supplierCreditNotes: [credit],
  })
  const rows = byId(savedRows(src))

  it('the credit is subtracted signed and never clamped', () => {
    expect(rows.cc8.actual).toBe(-40)
    expect(rows.cc9.actual).toBe(60)
  })

  it('a negative FFC is under budget, not over, and the row is unforecasted', () => {
    expect(rows.cc8.forecastFinalCost).toBe(-40)
    expect(rows.cc8.varianceToBudget).toBe(90)
    expect(rows.cc8.overBudget).toBe(false)
    expect(rows.cc8.unforecasted).toBe(true)
  })

  it('project totals carry the negative actual and both codes in the count', () => {
    const t = projectForecastTotals(src)
    expect(t.actual).toBe(20)
    expect(t.forecastFinalCost).toBe(20)
    expect(t.lineCount).toBe(2)
    expect(t.unforecastedCount).toBe(2)
    expect(t.overBudgetCount).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · projectForecastTotals — the counts it never carried
// ─────────────────────────────────────────────────────────────────────────────

describe('projectForecastTotals carries the per-row flags into the rollup counts', () => {
  const t = projectForecastTotals(sources())

  it('counts the five unforecast codes (cc3, cc4, cc5, cc6, cc7) and not the saved zero (cc2)', () => {
    expect(t.lineCount).toBe(7)
    expect(t.unforecastedCount).toBe(5)
  })

  it('counts no over-budget code — cc1 is under budget once its claim is counted once (ADR-55)', () => {
    expect(t.overBudgetCount).toBe(0)
  })

  it('costToComplete is the real figure (it was a silent 0 before ADR-43), net of recognised claims (ADR-55)', () => {
    // Remaining Committed (800 − 300) + (120 − 120) + 200 = 700; Uncommitted CTC 150.
    expect(t.remainingCommitted).toBe(700)
    expect(t.approvedClaimsAwaitingInvoice).toBe(420)
    expect(t.uncommittedCostToComplete).toBe(150)
    expect(t.costToComplete).toBe(850)
  })

  it('the headline figures count each approved claim exactly once', () => {
    expect(t.budgeted).toBe(1800)
    expect(t.actual).toBe(420)
    expect(t.forecastFinalCost).toBe(1270)      // 420 + 700 + 150  (pre-ADR-55: 1690 = 420 + 1120 + 150)
    expect(t.varianceToBudget).toBe(530)        // 1800 − 1270
    expect(t.pendingSupplierVariationExposure).toBe(75)
    expect(t.approvedSupplierVariations).toBe(0)
  })

  it('a project with NO activity reports zero counts and zero lines', () => {
    const empty = projectForecastTotals(sources({
      costCodes: COST_CODES, budgetLines: [], purchaseOrders: [], progressClaims: [], variations: [], forecastLines: [],
    }))
    expect(empty.lineCount).toBe(0)
    expect(empty.unforecastedCount).toBe(0)
    expect(empty.overBudgetCount).toBe(0)
  })

  it('a fully forecast project (every code saved, zeros included) reports unforecastedCount 0', () => {
    const full = projectForecastTotals(sources({ forecastLines: FULLY_FORECAST_LINES }))
    expect(full.lineCount).toBe(7)
    expect(full.unforecastedCount).toBe(0)
    expect(full.overBudgetCount).toBe(0)
    // Saving zeros moved no headline figure.
    expect(full.forecastFinalCost).toBe(t.forecastFinalCost)
    expect(full.budgeted).toBe(t.budgeted)
    expect(full.actual).toBe(t.actual)
  })

  it('a budget edit can move overBudgetCount but never the cost side', () => {
    const raised = projectForecastTotals(sources({
      budgetLines: BUDGET_LINES.map(l => (l.costCodeId === 'cc1' ? { ...l, budgeted: 949.99 } : l)),
    }))
    expect(raised.overBudgetCount).toBe(1)        // cc1 (FFC 950) now one cent over budget
    expect(raised.unforecastedCount).toBe(t.unforecastedCount)
    expect(raised.forecastFinalCost).toBe(t.forecastFinalCost)
    expect(raised.actual).toBe(t.actual)
    expect(raised.remainingCommitted).toBe(t.remainingCommitted)
  })

  it('a cost-code rename or deactivation moves neither count', () => {
    const renamed = projectForecastTotals(sources({
      costCodes: COST_CODES.map(c => ({ ...c, name: `${c.name} (renamed)`, isActive: false })),
    }))
    expect(renamed.unforecastedCount).toBe(t.unforecastedCount)
    expect(renamed.overBudgetCount).toBe(t.overBudgetCount)
    expect(renamed.lineCount).toBe(t.lineCount)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 · PARITY: the Forecast page with no edits ≡ the saved path
// ─────────────────────────────────────────────────────────────────────────────

// ProjectForecast.jsx cannot be imported (JSX), so its no-edits overlay is
// reproduced here EXACTLY: stored → string → parse → composeForecastRow, with
// the one page-specific rule that an invalid entry is "invalid", not "Not
// forecast". If the page's overlay changes, the structural test in §6 and this
// reproduction must change together.
const storedCtcString = (v) => (v === null || v === undefined ? '' : String(v))
const pageRows = (src) => buildForecastRows(src).map(row => {
  const ctcStr = storedCtcString(row.storedUncommittedCostToComplete)
  const trimmed = ctcStr.trim()
  const parsed = trimmed === '' ? null : Number(trimmed)
  const ctcInvalid = parsed !== null && !Number.isFinite(parsed)
  const ctcForCalc = ctcInvalid ? null : parsed
  const composed = composeForecastRow(row, ctcForCalc)
  return { ...composed, unforecasted: composed.unforecasted && trimmed === '', ctcInvalid }
})

describe('parity — Forecast page (no edits) and projectForecastTotals agree', () => {
  it('every rollup field is identical, counts included', () => {
    expect(forecastRollups(pageRows(sources()))).toEqual(projectForecastTotals(sources()))
  })

  it('…and for a fully forecast project', () => {
    const src = sources({ forecastLines: FULLY_FORECAST_LINES })
    expect(forecastRollups(pageRows(src))).toEqual(projectForecastTotals(src))
  })

  it('…and per row: the same flags and figures for null, 0, positive', () => {
    const page = byId(pageRows(sources()))
    const saved = byId(savedRows())
    for (const id of Object.keys(saved)) {
      for (const f of ['unforecasted', 'overBudget', 'costToComplete', 'forecastFinalCost', 'varianceToBudget', 'remainingBudgetRef']) {
        expect(page[id][f], `${id}.${f}`).toBe(saved[id][f])
      }
    }
  })

  it('a malformed stored value: both paths say "not unforecasted" and contribute zero', () => {
    const src = sources({ forecastLines: [
      ...FORECAST_LINES.filter(f => f.id !== 'cc1'),
      { id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 'abc' },
    ] })
    const page = byId(pageRows(src))
    const saved = byId(savedRows(src))
    expect(page.cc1.ctcInvalid).toBe(true)
    expect(page.cc1.unforecasted).toBe(false)
    expect(saved.cc1.unforecasted).toBe(false)
    expect(page.cc1.forecastFinalCost).toBe(800)   // 300 actual + 500 remaining committed, junk CTC → 0 (ADR-55: was 1100)
    expect(saved.cc1.forecastFinalCost).toBe(800)
    const t = projectForecastTotals(src)
    expect(forecastRollups(pageRows(src))).toEqual(t)
    expect(t.unforecastedCount).toBe(5) // cc1 is invalid, not unforecast — unchanged
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 · END TO END: the count reaches Cash Flow's completeness and suppression
// ─────────────────────────────────────────────────────────────────────────────

const ctcLine = (sourceType, sourceAmountExGst, costCodeId = 'cc1') => ({
  id: `${sourceType}-${costCodeId}-${sourceAmountExGst}`, status: 'active', monthKey: '2026-11',
  direction: 'out', basis: 'gross', amount: sourceAmountExGst * 1.1, sourceAmountExGst,
  sourceType, costCodeId, costCodeName: '', description: 'd',
})

// The exact wiring ProjectCashFlow.jsx performs with the totals (ADR-55: the
// approved claims awaiting invoice are their own cash basis).
const cashFlowCost = (t, lines = []) => costCoverage({
  remainingCommittedTotal: t.remainingCommitted,
  uninvoicedClaimTotal: t.approvedClaimsAwaitingInvoice,
  uncommittedCtcTotal: t.uncommittedCostToComplete,
  unforecastedCount: t.unforecastedCount,
  lines,
})
const REVENUE_OK = { pct: 100, state: 'ok' }

describe('end to end — unforecast codes now reach Cash Flow (they never could before)', () => {
  const t = projectForecastTotals(sources())
  const fullCover = [
    ctcLine(CFL_SOURCE_TYPE.REMAINING_COMMITTED, t.remainingCommitted),
    ctcLine(CFL_SOURCE_TYPE.UNINVOICED_CLAIM, t.approvedClaimsAwaitingInvoice),
    ctcLine(CFL_SOURCE_TYPE.UNCOMMITTED_CTC, t.uncommittedCostToComplete),
  ]

  it('costCoverage flags the incomplete basis', () => {
    const c = cashFlowCost(t)
    expect(c.incompleteBasis).toBe(true)
    expect(c.state).toBe('ok')
    expect(c.pct).toBe(0)
  })

  it('…and the timed percentage itself is unchanged by the flag (no funding arithmetic touched)', () => {
    expect(cashFlowCost(t, fullCover).pct).toBe(100)
  })

  it('completenessState refuses COMPLETE even at 100% coverage', () => {
    expect(completenessState({ revenue: REVENUE_OK, cost: cashFlowCost(t, fullCover) }))
      .toBe(COMPLETENESS_STATE.PARTIAL)
  })

  it('peakFundingSuppression suppresses with the incomplete-basis reason', () => {
    const c = cashFlowCost(t, fullCover)
    const s = peakFundingSuppression({ costBasisUnavailable: c.pct === null, costBasisIncomplete: !!c.incompleteBasis })
    expect(s.suppressed).toBe(true)
    expect(s.reasons).toEqual(['Cost to Complete is incomplete (unforecast cost codes)'])
  })

  it('a FULLY forecast project (zeros saved) is COMPLETE at full coverage and not suppressed', () => {
    const full = projectForecastTotals(sources({ forecastLines: FULLY_FORECAST_LINES }))
    const cover = [
      ctcLine(CFL_SOURCE_TYPE.REMAINING_COMMITTED, full.remainingCommitted),
      ctcLine(CFL_SOURCE_TYPE.UNINVOICED_CLAIM, full.approvedClaimsAwaitingInvoice),
      ctcLine(CFL_SOURCE_TYPE.UNCOMMITTED_CTC, full.uncommittedCostToComplete),
    ]
    const c = cashFlowCost(full, cover)
    expect(c.incompleteBasis).toBe(false)
    expect(c.pct).toBe(100)
    expect(completenessState({ revenue: REVENUE_OK, cost: c })).toBe(COMPLETENESS_STATE.COMPLETE)
    expect(peakFundingSuppression({ costBasisUnavailable: c.pct === null, costBasisIncomplete: !!c.incompleteBasis }).suppressed).toBe(false)
  })

  it('a zero basis made of unforecast codes is INCOMPLETE and UNAVAILABLE — both reasons, never "nothing to time"', () => {
    // Budget-only and variation-only codes, nothing forecast, nothing committed.
    const src = sources({ purchaseOrders: [], progressClaims: [], forecastLines: [] })
    const z = projectForecastTotals(src)
    expect(z.costToComplete).toBe(0)
    expect(z.unforecastedCount).toBe(4) // cc1, cc2, cc6, cc7
    const c = cashFlowCost(z)
    expect(c.state).toBe('no_cost_basis')
    expect(c.pct).toBe(null)
    expect(c.incompleteBasis).toBe(true)
    expect(completenessState({ revenue: REVENUE_OK, cost: c })).toBe(COMPLETENESS_STATE.UNAVAILABLE)
    const s = peakFundingSuppression({ costBasisUnavailable: c.pct === null, costBasisIncomplete: !!c.incompleteBasis })
    expect(s.reasons).toEqual([
      'cost basis unavailable',
      'Cost to Complete is incomplete (unforecast cost codes)',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7 · STRUCTURE: three callers, one composer
// ─────────────────────────────────────────────────────────────────────────────

describe('structure — every effective-row composition goes through composeForecastRow', () => {
  const margin = read('lib/margin.js')
  const page = read('pages/project/ProjectForecast.jsx')
  const invariance = readFileSync(fileURLToPath(new URL('./foundationEditInvariance.test.js', import.meta.url)), 'utf8')

  it('projectForecastTotals composes through the shared helper and no longer re-derives FFC', () => {
    expect(margin).toContain('composeForecastRow(r, r.storedUncommittedCostToComplete)')
    expect(margin).not.toContain('rowForecastFinalCost')
  })

  it('the Forecast page composes through the shared helper and keeps only its input overlay', () => {
    expect(page).toContain('composeForecastRow(row, ctcForCalc)')
    expect(page).toContain("unforecasted: composed.unforecasted && trimmed === ''")
    // None of the pieces are CALLED on the page any more (they remain as row
    // property names) — there is nothing left that could drift from the composer.
    for (const piece of ['forecastCostToComplete', 'forecastFinalCost', 'varianceToBudget', 'remainingBudgetReference', 'isUnforecasted', 'isOverBudget']) {
      expect(page, `${piece}(`).not.toMatch(new RegExp(`\\b${piece}\\(`))
    }
    const importLine = page.match(/import \{([^}]*)\} from '\.\.\/\.\.\/lib\/forecast'/)[1]
    expect(importLine.replace(/\s+/g, ' ').trim())
      .toBe('buildForecastRows, composeForecastRow, forecastRollups, remainingBudgetSuggestion,')
  })

  it('the invariance suite composes through the shared helper (no fourth copy)', () => {
    expect(invariance).toContain('composeForecastRow(r, r.storedUncommittedCostToComplete)')
    expect(invariance).not.toMatch(/\bforecastFinalCost\(/)
  })

  it('the Cash Flow page feeds the count straight into costCoverage, with the approved-claim basis (ADR-55)', () => {
    const cf = read('pages/project/ProjectCashFlow.jsx')
    expect(cf).toContain('unforecastedCount: forecastTotals.unforecastedCount')
    expect(cf).toContain('uninvoicedClaimTotal: forecastTotals.approvedClaimsAwaitingInvoice')
    expect(cf).toContain('untimedUninvoicedClaims: untimedClaims')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8 · ADR-55 — an approved claim is counted ONCE between Actual and Remaining Committed
// ─────────────────────────────────────────────────────────────────────────────
//
// The confirmed defect: Actual recognised an approved claim while Remaining
// Committed matured only on POSTED invoicing, so between approval and the
// posting of the claim-sourced invoice Forecast Final Cost carried the claim
// twice. The architect-approved recognition policy is unchanged — Actual still
// recognises the approved claim, the claim is still replaced by its posted
// invoice — and Remaining Committed now nets the recognised claim per PO line.

const PO = { id: 'po', poNumber: 'PO-0001', status: PO_STATUS.SENT, lineItems: [
  { costCodeId: 'c', costCodeName: 'C', description: 'Slab', lineTotal: 800 },
  { costCodeId: 'd', costCodeName: 'D', description: 'Steel', lineTotal: 500 },
] }
const claim = (id, status, lines) => ({ id, claimNumber: id.toUpperCase(), status, poId: 'po', lineItems: lines })
const cline = (idx, approved, costCodeId = 'c') => ({ poLineIndex: idx, costCodeId, approvedThisPeriod: approved, claimedToDate: approved })
const inv = (id, over) => ({
  id, invoiceNumber: id.toUpperCase(), status: 'posted', poId: 'po', source: 'direct_po', progressClaimId: null, ...over,
})
const onePo = (over = {}) => ({
  costCodes: [{ id: 'c', code: 'C', name: 'C', isActive: true }, { id: 'd', code: 'D', name: 'D', isActive: true }],
  budgetLines: [{ id: 'b', costCodeId: 'c', budgeted: 1000 }],
  purchaseOrders: [PO], progressClaims: [], supplierInvoices: [], supplierCreditNotes: [], variations: [],
  forecastLines: [{ id: 'c', costCodeId: 'c', uncommittedCostToComplete: 150 }],
  ...over,
})
const rowC = (src) => byId(savedRows(src)).c

describe('ADR-55 — the 1250 / 950 case and its neighbours', () => {
  it('the audited case: PO 800, approved claim 300, CTC 150 → FFC 950, not 1250', () => {
    const r = rowC(onePo({ progressClaims: [claim('cl1', 'approved', [cline(0, 300)])] }))
    expect(r.actual).toBe(300)
    expect(r.remainingCommitted).toBe(500)
    expect(r.forecastFinalCost).toBe(950)
    expect(r.varianceToBudget).toBe(50)
    expect(r.overBudget).toBe(false)
  })

  it('a claim that is only SUBMITTED moves nothing: FFC is 950 before approval too', () => {
    const r = rowC(onePo({ progressClaims: [claim('cl1', 'submitted', [{ poLineIndex: 0, costCodeId: 'c', claimedThisPeriod: 300, approvedThisPeriod: null }])] }))
    expect(r.actual).toBe(0)
    expect(r.remainingCommitted).toBe(800)
    expect(r.forecastFinalCost).toBe(950)
  })

  it('approving the claim moves 300 from Remaining Committed INTO Actual — FFC unchanged', () => {
    const before = rowC(onePo({ progressClaims: [claim('cl1', 'submitted', [{ poLineIndex: 0, costCodeId: 'c', claimedThisPeriod: 300 }])] }))
    const after  = rowC(onePo({ progressClaims: [claim('cl1', 'approved', [cline(0, 300)])] }))
    expect(after.actual - before.actual).toBe(300)
    expect(before.remainingCommitted - after.remainingCommitted).toBe(300)
    expect(after.forecastFinalCost).toBe(before.forecastFinalCost)
  })

  it('converting the approved claim into a POSTED claim-sourced invoice leaves every figure where it was', () => {
    const claimed  = onePo({ progressClaims: [claim('cl1', 'approved', [cline(0, 300)])] })
    const invoiced = onePo({
      progressClaims: claimed.progressClaims,
      supplierInvoices: [inv('si1', { source: 'progress_claim', progressClaimId: 'cl1', lineItems: [{ poLineIndex: 0, costCodeId: 'c', amount: 300 }] })],
    })
    const a = rowC(claimed), b = rowC(invoiced)
    expect(b.actual).toBe(a.actual)                                 // 300: the invoice replaces the claim
    expect(b.remainingCommitted).toBe(a.remainingCommitted)         // 500: invoiced-to-date replaces the recognised claim
    expect(b.approvedClaimsAwaitingInvoice).toBe(0)
    expect(a.approvedClaimsAwaitingInvoice).toBe(300)
    expect(b.forecastFinalCost).toBe(950)
    // A DRAFT or APPROVED (not posted) claim-sourced invoice changes nothing yet.
    for (const status of ['draft', 'approved']) {
      const pending = onePo({ progressClaims: claimed.progressClaims, supplierInvoices: [{ ...invoiced.supplierInvoices[0], status }] })
      expect(rowC(pending)).toEqual(a)
    }
  })

  it('partial and multiple claims on one line net cumulatively; a second line is independent', () => {
    const src = onePo({ progressClaims: [
      claim('cl1', 'approved', [cline(0, 200), cline(1, 100, 'd')]),
      claim('cl2', 'approved', [cline(0, 100), cline(1, 0, 'd')]),
    ] })
    const rows = byId(savedRows(src))
    expect(rows.c.actual).toBe(300)
    expect(rows.c.remainingCommitted).toBe(500)
    expect(rows.c.forecastFinalCost).toBe(950)
    expect(rows.d.actual).toBe(100)
    expect(rows.d.remainingCommitted).toBe(400)
    expect(rows.d.forecastFinalCost).toBe(500)
    // Partially invoicing one of the two claims swaps its share exactly.
    const half = onePo({ progressClaims: src.progressClaims, supplierInvoices: [
      inv('si1', { source: 'progress_claim', progressClaimId: 'cl2', lineItems: [{ poLineIndex: 0, costCodeId: 'c', amount: 100 }] }),
    ] })
    expect(rowC(half).remainingCommitted).toBe(500)
    expect(rowC(half).actual).toBe(300)
    expect(rowC(half).approvedClaimsAwaitingInvoice).toBe(200)
  })

  it('a claim above the PO line value floors Remaining Committed at zero — never negative', () => {
    const r = rowC(onePo({ progressClaims: [claim('cl1', 'approved', [cline(0, 900)])] }))
    expect(r.actual).toBe(900)
    expect(r.remainingCommitted).toBe(0)
    expect(r.forecastFinalCost).toBe(1050)
  })

  it('a DIRECT invoice and an approved claim on the SAME line both reach Actual (the mixed-mode conflict)', () => {
    // The guards block this at authoring; SHIELD lists it when it exists. The
    // derivation is NOT repaired: Actual carries both and Remaining Committed
    // nets both, so the overstatement sits in Actual, exactly as the records say.
    const r = rowC(onePo({
      progressClaims: [claim('cl1', 'approved', [cline(0, 300)])],
      supplierInvoices: [inv('si1', { lineItems: [{ poLineIndex: 0, costCodeId: 'c', amount: 200 }] })],
    }))
    expect(r.actual).toBe(500)              // 300 claim + 200 direct — the overlap, visible
    expect(r.remainingCommitted).toBe(300)  // 800 − 200 − 300
    expect(r.forecastFinalCost).toBe(950)
  })

  it('a legacy claim line with no poLineIndex nets no commitment (pre-ADR-55 reading, never a guess)', () => {
    const r = rowC(onePo({ progressClaims: [claim('cl1', 'approved', [{ costCodeId: 'c', approvedThisPeriod: 300 }])] }))
    expect(r.actual).toBe(300)
    expect(r.remainingCommitted).toBe(800)
    expect(r.forecastFinalCost).toBe(1250)
  })

  it('a CLOSED PO nets exactly as a sent one and reports the residual; a CANCELLED PO commits nothing', () => {
    const closed = rowC(onePo({ purchaseOrders: [{ ...PO, status: PO_STATUS.CLOSED }], progressClaims: [claim('cl1', 'approved', [cline(0, 300)])] }))
    expect(closed.remainingCommitted).toBe(500)
    expect(closed.closedResidual).toBe(500)
    expect(closed.forecastFinalCost).toBe(950)
    const cancelled = rowC(onePo({ purchaseOrders: [{ ...PO, status: PO_STATUS.CANCELLED }], progressClaims: [claim('cl1', 'approved', [cline(0, 300)])] }))
    expect(cancelled.remainingCommitted).toBe(0)
    expect(cancelled.actual).toBe(300)                  // cost against an uncommitted PO — SHIELD condition A
    expect(cancelled.forecastFinalCost).toBe(450)
  })

  it('a REJECTED claim and a cancelled invoice net nothing', () => {
    const r = rowC(onePo({
      progressClaims: [claim('cl1', 'rejected', [cline(0, 300)])],
      supplierInvoices: [inv('si1', { status: 'cancelled', lineItems: [{ poLineIndex: 0, costCodeId: 'c', amount: 200 }] })],
    }))
    expect(r.actual).toBe(0)
    expect(r.remainingCommitted).toBe(800)
    expect(r.forecastFinalCost).toBe(950)
  })

  it('the rollup carries closedResidual and approvedClaimsAwaitingInvoice without adding either to FFC', () => {
    const t = projectForecastTotals(onePo({ purchaseOrders: [{ ...PO, status: PO_STATUS.CLOSED }], progressClaims: [claim('cl1', 'approved', [cline(0, 300)])] }))
    expect(t.closedResidual).toBe(1000)                  // 500 on line c + 500 on line d
    expect(t.approvedClaimsAwaitingInvoice).toBe(300)
    expect(t.forecastFinalCost).toBe(300 + 1000 + 150)
  })
})
