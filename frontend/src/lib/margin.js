import { roundMoney } from './purchaseOrders'
import {
  buildForecastRows,
  composeForecastRow,
  forecastRollups,
  safeNumber,
} from './forecast'
import {
  approvedClientVariationsTotal,
  pendingClientVariationExposureTotal,
  approvedSupplierVariationsTotal,
  pendingSupplierVariationExposureTotal,
} from './variations'

// ── Project Margin (read-time; strictly ex-GST) ──────────────────────────────
//
// The margin layer answers "how much profit and margin do we forecast, and how
// far has it moved from what we originally planned?" It is NOT a new financial
// engine: the cost side (Forecast Final Cost) is the EXACT read-time derivation
// the Budget/Forecast pages already compute, and the revenue side is the
// Original Contract Value (a stored baseline input) plus approved Client
// Variations (already derived). The ONLY stored inputs are the commercial
// baseline fields; every figure below is derived and never written back.
//
// Formulas (all ex-GST):
//
//   Current Contract Sum      = Original Contract Value + Approved Client Variations
//   Forecast Revenue          = Current Contract Sum
//   Forecast Gross Profit     = Forecast Revenue − Forecast Final Cost
//   Forecast Margin %         = Forecast Gross Profit ÷ Forecast Revenue × 100
//   Original Planned Profit   = Original Contract Value − Original Approved Budget
//   Original Planned Margin % = Original Planned Profit ÷ Original Contract Value × 100
//   Margin Movement           = Forecast Gross Profit − Original Planned Profit
//
// Supplier Variation exposure (approved AND pending) is deliberately NEVER added
// into Forecast Final Cost — it does not yet mature against claims/invoices, so
// auto-adding it would double-count once the varied PO is invoiced (see ADR-19).
// Pending Client Variations are separate revenue exposure, never in Forecast
// Revenue. Both are surfaced as context only.

// Roles permitted to read commercial baseline & margin data. This is a UX-only
// mirror of the Firestore rules, which are the ENFORCED boundary — never treat
// this list as a security control. subcontractor/client are intentionally
// excluded (margin and contract value are commercially sensitive).
export const FINANCIAL_ROLES = ['company_admin', 'project_manager', 'qs']
export const isFinancialRole = (role) => FINANCIAL_ROLES.includes(role)

// Project-level Forecast Final Cost (and the supporting totals), composed from
// the EXACT read-time Budget/Forecast derivations — no cost logic is duplicated
// here. Each row goes through the SAME composeForecastRow the Forecast page
// uses, evaluated at the cost code's SAVED uncommittedCostToComplete (this path
// has no unsaved edits), so the rollup carries the same flags and counts the
// Forecast page shows — including unforecastedCount, which Cash Flow reads.
// Returns the full forecast rollup object; the margin caller reads
// `forecastFinalCost` (plus `budgeted` for the current Approved Budget reference).
export function projectForecastTotals(sources) {
  const rows = buildForecastRows(sources).map(
    (r) => composeForecastRow(r, r.storedUncommittedCostToComplete),
  )
  return forecastRollups(rows)
}

// Current Contract Sum = Original Contract Value + Approved Client Variations.
// Signed — negative approved client variations reduce it and are never clamped.
export function currentContractSum(originalContractValue, approvedClientVariations) {
  return roundMoney(safeNumber(originalContractValue) + safeNumber(approvedClientVariations))
}

// Forecast Gross Profit = Forecast Revenue − Forecast Final Cost.
export function forecastGrossProfit(forecastRevenue, forecastFinalCostValue) {
  return roundMoney(safeNumber(forecastRevenue) - safeNumber(forecastFinalCostValue))
}

// Margin % = profit ÷ revenue × 100. Revenue that is zero or negative yields
// `null` (the UI renders "—") — a percentage of non-positive revenue is
// meaningless, and dividing by zero must never produce NaN/Infinity.
export function marginPercent(profit, revenue) {
  const rev = safeNumber(revenue)
  if (rev <= 0) return null
  return roundMoney((safeNumber(profit) / rev) * 100)
}

// Original Planned Profit = Original Contract Value − Original Approved Budget.
// `null` when the Original Approved Budget baseline has not been established
// (originalApprovedBudget === null) — the UI renders "—".
export function originalPlannedProfit(originalContractValue, originalApprovedBudget) {
  if (originalApprovedBudget === null || originalApprovedBudget === undefined) return null
  return roundMoney(safeNumber(originalContractValue) - safeNumber(originalApprovedBudget))
}

// Margin Movement = Forecast Gross Profit − Original Planned Profit.
// `null` (UI "—") whenever the Original Planned Profit is not established.
export function marginMovement(forecastGrossProfitValue, originalPlannedProfitValue) {
  if (originalPlannedProfitValue === null || originalPlannedProfitValue === undefined) return null
  return roundMoney(safeNumber(forecastGrossProfitValue) - safeNumber(originalPlannedProfitValue))
}

// The client identity a baseline save writes, from the form's selected id
// (ADR-44). A client chosen from the loaded active client contacts snapshots
// its live display name. The baseline's ALREADY-STORED client, when it is not
// among those contacts (contacts still loading, a failed contacts read — which
// useContacts cannot distinguish from an empty list — or a since-archived
// contact), keeps its stored name snapshot: a lookup that did not resolve never
// erases a snapshot. Any other unresolved id is refused (`ok: false`) rather
// than written with no name. No selection clears both.
export function resolveBaselineClient({ clientId, baseline, clientContacts = [] }) {
  if (!clientId) return { ok: true, clientId: null, clientName: null }
  const contact = clientContacts.find(c => c.id === clientId)
  if (contact) return { ok: true, clientId, clientName: contact.displayName ?? null }
  if (baseline?.clientId === clientId) return { ok: true, clientId, clientName: baseline.clientName ?? null }
  return { ok: false, clientId, clientName: null }
}

// A baseline is "established" for margin purposes once it exists and carries a
// numeric Original Contract Value. Everything else on the baseline is optional.
export function isBaselineEstablished(baseline) {
  return !!baseline && typeof baseline.originalContractValue === 'number'
}

// One composite derivation consumed by BOTH the Commercial tab and the Overview
// margin cards, so margin business logic lives in exactly one place. `variations`
// and `forecastFinalCost` are the already-derived read-time figures; `baseline`
// is the stored commercial baseline document (or null when not yet set).
export function computeMargin({ baseline, variations = [], forecastFinalCost = 0 }) {
  const originalContractValue = isBaselineEstablished(baseline)
    ? baseline.originalContractValue
    : null
  const originalApprovedBudget = baseline?.originalApprovedBudget ?? null

  const approvedClientVariations = approvedClientVariationsTotal(variations)
  const pendingClientVariationExposure = pendingClientVariationExposureTotal(variations)
  const approvedSupplierVariations = approvedSupplierVariationsTotal(variations)
  const pendingSupplierVariationExposure = pendingSupplierVariationExposureTotal(variations)

  const ccs = currentContractSum(originalContractValue, approvedClientVariations)
  const revenue = ccs // Forecast Revenue = Current Contract Sum in this foundation
  const ffc = roundMoney(safeNumber(forecastFinalCost))
  const profit = forecastGrossProfit(revenue, ffc)
  const plannedProfit = originalPlannedProfit(originalContractValue, originalApprovedBudget)

  return {
    originalContractValue,
    originalApprovedBudget,
    approvedClientVariations,
    pendingClientVariationExposure,
    approvedSupplierVariations,
    pendingSupplierVariationExposure,
    currentContractSum: ccs,
    forecastRevenue: revenue,
    forecastFinalCost: ffc,
    forecastGrossProfit: profit,
    forecastMarginPct: marginPercent(profit, revenue),
    originalPlannedProfit: plannedProfit,
    originalPlannedMarginPct:
      plannedProfit === null ? null : marginPercent(plannedProfit, originalContractValue),
    marginMovement: marginMovement(profit, plannedProfit),
  }
}
