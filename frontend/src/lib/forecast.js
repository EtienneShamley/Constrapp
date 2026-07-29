import {
  roundMoney,
  maturedCommittedByCostCode,
  PO_STATUS,
} from './purchaseOrders'
import { actualClaimsByCostCode } from './progressClaims'
import {
  invoicedByCostCode,
  postedInvoicedByPoLine,
  invoicedClaimIds,
} from './supplierInvoices'
import {
  approvedSupplierVariationsByCostCode,
  pendingSupplierVariationExposureByCostCode,
} from './variations'

// ── Forecast Cost to Complete (strictly cost-side) ───────────────────────────
//
// The forecast answers "what do we currently expect this project to cost when
// complete?" It is NOT a new financial engine — every input figure is the exact
// same read-time derivation the Budget page already computes from POs, claims,
// supplier invoices, and variations. The ONLY authored input is a per-cost-code
// `uncommittedCostToComplete`; everything else here is derived and never stored.
//
// Canonical figures and formulas (all ex-GST):
//
//   Cost to Complete      = Remaining Committed + Uncommitted Cost to Complete
//   Forecast Final Cost   = Actual + Remaining Committed + Uncommitted Cost to Complete
//   Variance to Budget    = Budgeted − Forecast Final Cost
//        (positive ⇒ forecast under budget; negative ⇒ forecast over budget)
//
// Supplier Variations (approved and pending) do NOT yet mature against claims or
// invoices, so they are deliberately NOT added into Forecast Final Cost and there
// is intentionally no "FFC including variation exposure" total. They are surfaced
// as separate exposure context; the forecaster consciously folds the still-to-come
// portion into Uncommitted Cost to Complete.

// Normalises a possibly null / blank / non-numeric value to a finite number for
// calculation. A forecast line uses `null` to mean "not forecast"; null (and any
// junk) contributes ZERO to totals while the row stays visibly unforecasted in
// the UI. Never throws.
export function safeNumber(value) {
  if (value === null || value === undefined || value === '') return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

// Cost to Complete = Remaining Committed + Uncommitted Cost to Complete.
export function forecastCostToComplete(remainingCommitted, uncommittedCostToComplete) {
  return roundMoney(safeNumber(remainingCommitted) + safeNumber(uncommittedCostToComplete))
}

// Forecast Final Cost (Estimate at Completion) =
//   Actual + Remaining Committed + Uncommitted Cost to Complete.
export function forecastFinalCost(actual, remainingCommitted, uncommittedCostToComplete) {
  return roundMoney(
    safeNumber(actual) + safeNumber(remainingCommitted) + safeNumber(uncommittedCostToComplete),
  )
}

// Variance to Budget (Variance at Completion) = Budgeted − Forecast Final Cost.
// Positive ⇒ under budget; negative ⇒ over budget.
export function varianceToBudget(budgeted, forecastFinalCostValue) {
  return roundMoney(safeNumber(budgeted) - safeNumber(forecastFinalCostValue))
}

// Remaining Budget Reference = Budgeted − Actual − Remaining Committed.
// INFORMATIONAL ONLY. It is never auto-applied — it exists to back the explicit
// "Use remaining budget" action. Remaining budget is a target, not a prediction;
// assuming it equals remaining cost would force Variance to zero and hide overruns.
export function remainingBudgetReference(budgeted, actual, remainingCommitted) {
  return roundMoney(safeNumber(budgeted) - safeNumber(actual) - safeNumber(remainingCommitted))
}

// The value the explicit "Use remaining budget" action copies into Uncommitted
// Cost to Complete: the reference when positive, otherwise 0 (never negative, and
// never automatically prefilled — the user must press the action). Supplier
// variations are intentionally excluded from this suggestion.
export function remainingBudgetSuggestion(reference) {
  const r = roundMoney(safeNumber(reference))
  return r > 0 ? r : 0
}

// A line is "not forecast" while its Uncommitted Cost to Complete is null/undefined.
// Zero is a *forecast* value (reviewed, no further uncommitted cost expected) — it
// is NOT unforecasted.
export function isUnforecasted(uncommittedCostToComplete) {
  return uncommittedCostToComplete === null || uncommittedCostToComplete === undefined
}

// Over budget ⇔ Variance to Budget is negative.
export function isOverBudget(varianceValue) {
  return roundMoney(safeNumber(varianceValue)) < 0
}

// ── Cost-code row union + composition ────────────────────────────────────────
//
// Builds one base row per cost code that appears ANYWHERE relevant, reusing the
// exact Budget-page read-time calculations (imported, not duplicated):
//   • Budget Lines
//   • sent/closed Purchase Order lines (Remaining Committed)
//   • Actual (approved claims not superseded by a posted/paid invoice + posted/paid invoices)
//   • posted/paid Supplier Invoices (folded into Actual)
//   • Approved + Pending Supplier Variations (exposure context)
//   • existing Forecast Lines
//
// A cost code must never disappear merely because it has no budget line, is
// inactive, or has only actual / only a PO / only a variation / only a forecast
// line. Names resolve live from the cost-code list, falling back to the stored
// forecast-line name (then the budget-line name) for missing/inactive codes.
//
// Rows carry FACTS only; the Uncommitted-CTC-dependent outputs (Cost to Complete,
// Forecast Final Cost, Variance, Remaining Budget Reference) are computed by the
// page from the *effective* (possibly-edited) input so the UI updates immediately.
export function buildForecastRows({
  costCodes = [],
  budgetLines = [],
  purchaseOrders = [],
  progressClaims = [],
  supplierInvoices = [],
  variations = [],
  forecastLines = [],
}) {
  // Remaining Committed — identical calculation to the Budget page.
  const invByPoLine = postedInvoicedByPoLine(supplierInvoices)
  const committedMap = maturedCommittedByCostCode(purchaseOrders, invByPoLine)

  // Closed-PO residual open commitment — same formula, restricted to closed POs,
  // so the page can flag uninvoiced commitment sitting on a completed PO for QS
  // judgement. It is NOT removed from Remaining Committed.
  const closedPurchaseOrders = purchaseOrders.filter(po => po.status === PO_STATUS.CLOSED)
  const closedResidualMap = maturedCommittedByCostCode(closedPurchaseOrders, invByPoLine)

  // Actual — approved claims not superseded by a posted/paid invoice + posted/paid
  // invoice lines (the Budget-page composition, no double-count).
  const invoicedMap = invoicedByCostCode(supplierInvoices)
  const claimActualMap = actualClaimsByCostCode(progressClaims, invoicedClaimIds(supplierInvoices))
  const actualMap = {}
  for (const cc of new Set([...Object.keys(claimActualMap), ...Object.keys(invoicedMap)])) {
    actualMap[cc] = roundMoney((claimActualMap[cc] || 0) + (invoicedMap[cc] || 0))
  }

  // Supplier variation exposure — separate context, never added to any total.
  const approvedSVMap = approvedSupplierVariationsByCostCode(variations)
  const pendingSVMap = pendingSupplierVariationExposureByCostCode(variations)

  // Budget lines (a code may in principle have more than one line — sum them).
  const budgetedMap = {}
  const budgetNameMap = {}
  for (const l of budgetLines) {
    if (!l.costCodeId) continue
    budgetedMap[l.costCodeId] = roundMoney((budgetedMap[l.costCodeId] || 0) + (Number(l.budgeted) || 0))
    if (l.costCodeName) budgetNameMap[l.costCodeId] = l.costCodeName
  }

  // Existing forecast lines by cost code (document id === costCodeId).
  const forecastMap = {}
  for (const f of forecastLines) {
    const key = f.costCodeId || f.id
    if (key) forecastMap[key] = f
  }

  const codeMap = {}
  for (const cc of costCodes) codeMap[cc.id] = cc

  // The union of every cost code that appears anywhere.
  const ids = new Set([
    ...Object.keys(budgetedMap),
    ...Object.keys(committedMap),
    ...Object.keys(actualMap),
    ...Object.keys(approvedSVMap),
    ...Object.keys(pendingSVMap),
    ...Object.keys(forecastMap),
  ])

  const rows = []
  for (const id of ids) {
    const cc = codeMap[id]
    const forecast = forecastMap[id] || null
    const costCodeName = cc
      ? `${cc.code} — ${cc.name}`
      : (forecast?.costCodeName || budgetNameMap[id] || 'Unknown cost code')

    rows.push({
      costCodeId: id,
      costCodeName,
      isInactive: !!cc && cc.isActive === false,
      isMissing: !cc,
      hasBudgetLine: Object.prototype.hasOwnProperty.call(budgetedMap, id),
      budgeted: Object.prototype.hasOwnProperty.call(budgetedMap, id) ? budgetedMap[id] : null,
      actual: actualMap[id] || 0,
      remainingCommitted: committedMap[id] || 0,
      closedResidual: closedResidualMap[id] || 0,
      approvedSupplierVariations: approvedSVMap[id] || 0,
      pendingSupplierVariationExposure: pendingSVMap[id] || 0,
      // The stored authored input (number | null); null = not forecast.
      storedUncommittedCostToComplete: forecast
        ? (forecast.uncommittedCostToComplete ?? null)
        : null,
      notes: forecast?.notes || '',
      updatedAt: forecast?.updatedAt || null,
      updatedBy: forecast?.updatedBy || null,
      hasForecastLine: !!forecast,
    })
  }

  rows.sort((a, b) => a.costCodeName.localeCompare(b.costCodeName))
  return rows
}

// Project-level rollups from the effective (possibly-edited) rows. Each row is
// expected to carry `uncommittedCostToComplete` (number | null), `costToComplete`,
// `forecastFinalCost`, and `unforecasted`. Variance is recomputed from the rounded
// project Budgeted and Forecast Final Cost so it reconciles to the headline figures.
export function forecastRollups(rows) {
  const acc = {
    budgeted: 0,
    actual: 0,
    remainingCommitted: 0,
    uncommittedCostToComplete: 0,
    costToComplete: 0,
    forecastFinalCost: 0,
    approvedSupplierVariations: 0,
    pendingSupplierVariationExposure: 0,
    unforecastedCount: 0,
    overBudgetCount: 0,
  }
  for (const r of rows) {
    acc.budgeted += safeNumber(r.budgeted)
    acc.actual += safeNumber(r.actual)
    acc.remainingCommitted += safeNumber(r.remainingCommitted)
    acc.uncommittedCostToComplete += safeNumber(r.uncommittedCostToComplete)
    acc.costToComplete += safeNumber(r.costToComplete)
    acc.forecastFinalCost += safeNumber(r.forecastFinalCost)
    acc.approvedSupplierVariations += safeNumber(r.approvedSupplierVariations)
    acc.pendingSupplierVariationExposure += safeNumber(r.pendingSupplierVariationExposure)
    if (r.unforecasted) acc.unforecastedCount += 1
    if (r.overBudget) acc.overBudgetCount += 1
  }
  const budgeted = roundMoney(acc.budgeted)
  const forecastFinalCostValue = roundMoney(acc.forecastFinalCost)
  return {
    budgeted,
    actual: roundMoney(acc.actual),
    remainingCommitted: roundMoney(acc.remainingCommitted),
    uncommittedCostToComplete: roundMoney(acc.uncommittedCostToComplete),
    costToComplete: roundMoney(acc.costToComplete),
    forecastFinalCost: forecastFinalCostValue,
    varianceToBudget: roundMoney(budgeted - forecastFinalCostValue),
    approvedSupplierVariations: roundMoney(acc.approvedSupplierVariations),
    pendingSupplierVariationExposure: roundMoney(acc.pendingSupplierVariationExposure),
    unforecastedCount: acc.unforecastedCount,
    overBudgetCount: acc.overBudgetCount,
    lineCount: rows.length,
  }
}
