import { roundMoney } from './purchaseOrders'
import { projectForecastRows, computeMargin } from './margin'
import { forecastRollups } from './forecast'
import { claimedPendingByCostCode } from './progressClaims'
import { resolveBudgetSource, budgetLinesFor, originalApprovedBudgetFor, approvedVersionCaption, BUDGET_SOURCE } from './budgetApproval'
import { cashInRows, receivablesSummary } from './clientReceipts'
import { cashOutRows } from './supplierPayments'
import { totalActualCashIn, totalActualCashOut, actualNetCash } from './cashFlow'
import {
  projectSnapshot, figureState, availableFigure, FIGURE_STATE, FIGURE_DEPENDENCIES,
  MARGIN_NOT_ESTABLISHED, SNAPSHOT_SOURCES, SNAPSHOT_SOURCE_LABELS,
} from './projectSnapshot'

// ── L2-A Commercial Report (read-time; COMPOSITION ONLY) ─────────────────────
//
// The report for ONE project in ONE currency. Like lib/projectSnapshot.js this
// module is NOT a financial engine: every money figure is the output of an
// existing selector, carried through unchanged —
//
//   Headline cost / margin figures → lib/projectSnapshot.js projectSnapshot
//                                    (the Dashboard's own composition, so the
//                                    report and Dashboard v2 cannot disagree)
//   Cost-code rows and their totals → lib/margin.js projectForecastRows +
//                                    lib/forecast.js forecastRollups, over the
//                                    SAME resolved budget source (ADR-70/71)
//   Claimed (uncertified)          → lib/progressClaims.js claimedPendingByCostCode
//   Variations                     → lib/margin.js computeMargin outputs
//   Cash                           → lib/cashFlow.js actual totals over
//                                    lib/clientReceipts.js cashInRows and
//                                    lib/supplierPayments.js cashOutRows;
//                                    receivables from receivablesSummary
//
// What this module adds is AVAILABILITY (projectSnapshot's figureState rules:
// failed → UNAVAILABLE, loading → LOADING, else READY with a value) and a
// deterministic row order for export. It never converts currency, never sums
// across projects, and never fills a missing figure with zero: a figure that is
// not READY carries `value: null`.

export const REPORT_SOURCES = [...SNAPSHOT_SOURCES, 'clientInvoices', 'clientReceipts']

export const REPORT_SOURCE_LABELS = {
  ...SNAPSHOT_SOURCE_LABELS,
  clientInvoices: 'Client Invoices',
  clientReceipts: 'Client Receipts',
}

// Dependencies of the figures the report adds beside the snapshot's own.
// Every list is traced through the selector it gates:
//   · costToComplete — Remaining Committed + Uncommitted CTC per row, i.e. the
//     Forecast Final Cost sources (a superset; conservative by design)
//   · costCodeRows — the forecast row union (FORECAST_ROW_SOURCES) plus the
//     claims read for the Claimed column (already in the union)
//   · cash — posted receipts / payments only; receivables also read invoices
export const REPORT_DEPENDENCIES = {
  costToComplete:      FIGURE_DEPENDENCIES.forecastFinalCost,
  costCodeRows:        [...new Set([...FIGURE_DEPENDENCIES.forecastRows, ...FIGURE_DEPENDENCIES.claimedExposure])],
  claimed:             FIGURE_DEPENDENCIES.claimedExposure,
  originalContract:    ['baseline'],
  clientVariations:    FIGURE_DEPENDENCIES.clientVariations,
  supplierVariations:  FIGURE_DEPENDENCIES.supplierVariationExposure,
  cashIn:              ['clientReceipts'],
  cashOut:             ['supplierPayments'],
  netCash:             ['clientReceipts', 'supplierPayments'],
  receivables:         ['clientInvoices', 'clientReceipts'],
}

// Figure kinds — how a READY value is rendered and exported.
export const FIGURE_KIND = { MONEY: 'money', PERCENT: 'percent' }

// A figure gated on an explicit dependency list (same rules as availableFigure).
function gated(dependencies, value, sourceStates) {
  const s = figureState(dependencies, sourceStates)
  return { ...s, value: s.state === FIGURE_STATE.READY ? value : null }
}

// The snapshot's "not established" states carry their value under different
// keys; normalise to { state, failedSources, value }.
const fromSnapshot = (f, valueKey = 'value') => ({
  state: f.state,
  failedSources: f.failedSources ?? [],
  value: f.state === FIGURE_STATE.READY ? (f[valueKey] ?? null) : null,
})

// Same "not established" rule as projectSnapshot, for the figures the report
// reads from computeMargin directly.
function contractGated(dependencies, value, sourceStates, notEstablished) {
  if (notEstablished) return { state: MARGIN_NOT_ESTABLISHED, failedSources: [], value: null }
  return gated(dependencies, value, sourceStates)
}

// Deterministic, locale-pinned order: name, then id (so two codes with the same
// display name never swap between renders or exports).
export function compareReportRows(a, b) {
  const byName = String(a.costCodeName ?? '').localeCompare(String(b.costCodeName ?? ''), 'en')
  if (byName !== 0) return byName
  const ia = String(a.costCodeId ?? '')
  const ib = String(b.costCodeId ?? '')
  return ia < ib ? -1 : ia > ib ? 1 : 0
}

// The budget-source caption shown beside every budget figure.
export function budgetSourceCaption(budgetSource) {
  if (!budgetSource) return ''
  if (budgetSource.kind === BUDGET_SOURCE.APPROVED) return `Approved version ${approvedVersionCaption(budgetSource)}`
  if (budgetSource.kind === BUDGET_SOURCE.WORKING) return 'Working budget (not approved)'
  if (budgetSource.kind === BUDGET_SOURCE.LOADING) return 'Loading'
  return 'Unavailable'
}

// ── The report ───────────────────────────────────────────────────────────────
//
// `sources` / `sourceStates` exactly as projectSnapshot takes them, plus
// `costCodes` (display names only — never a row or an amount), `clientInvoices`
// and `clientReceipts`. `currencyCode` is the project's RESOLVED currency.
export function buildCommercialReport({ project = null, currencyCode, sources = {}, sourceStates = {} } = {}) {
  const {
    budgetLines = [], approvedBudget = null, purchaseOrders = [], progressClaims = [],
    supplierInvoices = [], supplierCreditNotes = [], variations = [], forecastLines = [],
    baseline = null, supplierPayments = [], retentionReleases = [],
    clientInvoices = [], clientReceipts = [], costCodes = [],
  } = sources

  // 1. The Dashboard's composition, unchanged.
  const snapshot = projectSnapshot({
    currencyCode,
    sources: {
      budgetLines, approvedBudget, purchaseOrders, progressClaims, supplierInvoices,
      supplierCreditNotes, variations, forecastLines, baseline, supplierPayments, retentionReleases,
    },
    sourceStates,
  })

  // 2. The same budget source projectSnapshot resolves (identical arguments).
  const budgetSource = resolveBudgetSource({
    approvedBudget, budgetLines,
    budgetLinesLoading: sourceStates?.budgetLines?.loading === true,
    budgetLinesError: sourceStates?.budgetLines?.error === true,
    currencyCode,
  })
  const forecastSources = {
    costCodes, budgetLines: budgetLinesFor(budgetSource), purchaseOrders, progressClaims,
    supplierInvoices, supplierCreditNotes, variations, forecastLines,
  }
  const forecastRows = projectForecastRows(forecastSources)
  const totals = forecastRollups(forecastRows)
  const claimedMap = claimedPendingByCostCode(progressClaims)
  const m = computeMargin({
    baseline, variations, forecastFinalCost: totals.forecastFinalCost, purchaseOrders,
    originalApprovedBudget: originalApprovedBudgetFor(budgetSource),
  })

  // 3. Cost-code rows: every forecast row, plus any code that carries ONLY an
  // uncertified claim (zero in every other column by construction — it is in
  // none of the maps that form the forecast union).
  const rows = forecastRows.map(r => ({
    costCodeId: r.costCodeId,
    costCodeName: r.costCodeName,
    hasBudgetLine: r.hasBudgetLine,
    approvedBudget: r.hasBudgetLine ? r.budgeted : null,
    committed: r.remainingCommitted,
    claimed: claimedMap[r.costCodeId] || 0,
    actual: r.actual,
    forecastFinalCost: r.forecastFinalCost,
    costToComplete: r.costToComplete,
    varianceToBudget: r.hasBudgetLine ? r.varianceToBudget : null,
    unforecasted: r.unforecasted,
    overBudget: r.overBudget,
  }))
  const known = new Set(rows.map(r => r.costCodeId))
  const nameOf = (id) => {
    const cc = costCodes.find(c => c.id === id)
    if (cc) return `${cc.code} — ${cc.name}`
    for (const claim of progressClaims) {
      for (const li of claim.lineItems ?? []) if (li.costCodeId === id && li.costCodeName) return li.costCodeName
    }
    return 'Unknown cost code'
  }
  for (const id of Object.keys(claimedMap)) {
    if (known.has(id)) continue
    rows.push({
      costCodeId: id, costCodeName: nameOf(id), hasBudgetLine: false, approvedBudget: null,
      committed: 0, claimed: claimedMap[id], actual: 0, forecastFinalCost: 0, costToComplete: 0,
      varianceToBudget: null, unforecasted: true, overBudget: false,
    })
  }
  rows.sort(compareReportRows)
  const claimedTotal = roundMoney(rows.reduce((s, r) => s + (Number(r.claimed) || 0), 0))

  const rowsState = figureState(REPORT_DEPENDENCIES.costCodeRows, sourceStates)
  const rowsReady = rowsState.state === FIGURE_STATE.READY
  const costCodeTable = {
    ...rowsState,
    rows: rowsReady ? rows : [],
    totals: rowsReady ? {
      approvedBudget: totals.budgeted,
      committed: totals.remainingCommitted,
      claimed: claimedTotal,
      actual: totals.actual,
      forecastFinalCost: totals.forecastFinalCost,
      costToComplete: totals.costToComplete,
      varianceToBudget: totals.varianceToBudget,
    } : null,
    unforecastedCount: rowsReady ? rows.filter(r => r.unforecasted).length : null,
    unbudgetedCount: rowsReady ? rows.filter(r => !r.hasBudgetLine).length : null,
  }

  // 4. Summary — in reading order.
  const notEstablished = snapshot.margin.state === MARGIN_NOT_ESTABLISHED
  const margin = snapshot.margin
  const marginFigure = (valueKey) => (
    margin.state === MARGIN_NOT_ESTABLISHED
      ? { state: MARGIN_NOT_ESTABLISHED, failedSources: [], value: null }
      : fromSnapshot(margin, valueKey)
  )
  const summary = [
    { key: 'originalContractValue', label: 'Original Contract Value', kind: FIGURE_KIND.MONEY,
      figure: contractGated(REPORT_DEPENDENCIES.originalContract, m.originalContractValue, sourceStates, notEstablished),
      note: 'From the Commercial baseline' },
    { key: 'currentContractSum', label: 'Current Contract Sum', kind: FIGURE_KIND.MONEY,
      figure: fromSnapshot(snapshot.currentContractSum),
      note: 'Original Contract Value + approved client variations' },
    { key: 'forecastRevenue', label: 'Forecast Revenue', kind: FIGURE_KIND.MONEY,
      figure: fromSnapshot(snapshot.currentContractSum),
      note: 'Equals the Current Contract Sum (no separate revenue forecast exists)' },
    { key: 'approvedBudget', label: 'Approved Budget', kind: FIGURE_KIND.MONEY,
      figure: fromSnapshot(snapshot.approvedBudget),
      note: budgetSourceCaption(budgetSource) },
    { key: 'committed', label: 'Committed (remaining open)', kind: FIGURE_KIND.MONEY,
      figure: fromSnapshot(snapshot.remainingCommitted),
      note: 'Open commitment on sent/closed POs, net of invoiced and approved-claim amounts — not cost incurred' },
    { key: 'claimed', label: 'Claimed (awaiting certification)', kind: FIGURE_KIND.MONEY,
      figure: gated(REPORT_DEPENDENCIES.claimed, claimedTotal, sourceStates),
      note: 'Submitted and under-review claims — not in Actual Cost, not a payment' },
    { key: 'actual', label: 'Actual Cost', kind: FIGURE_KIND.MONEY,
      figure: fromSnapshot(snapshot.actual),
      note: 'Approved claims + posted supplier invoices − posted credit notes' },
    { key: 'costToComplete', label: 'Cost to Complete', kind: FIGURE_KIND.MONEY,
      figure: gated(REPORT_DEPENDENCIES.costToComplete, totals.costToComplete, sourceStates),
      note: 'Remaining committed + uncommitted cost to complete' },
    { key: 'forecastFinalCost', label: 'Forecast Final Cost', kind: FIGURE_KIND.MONEY,
      figure: fromSnapshot(snapshot.forecastFinalCost),
      note: 'Actual + cost to complete' },
    { key: 'varianceToBudget', label: 'Variance to Budget', kind: FIGURE_KIND.MONEY,
      figure: fromSnapshot(snapshot.varianceToBudget),
      note: 'Approved Budget − Forecast Final Cost (negative = over budget)' },
    { key: 'forecastGrossProfit', label: 'Forecast Gross Profit', kind: FIGURE_KIND.MONEY,
      figure: marginFigure('grossProfit'),
      note: 'Forecast Revenue − Forecast Final Cost' },
    { key: 'forecastMarginPct', label: 'Forecast Margin', kind: FIGURE_KIND.PERCENT,
      figure: marginFigure('marginPct'),
      note: 'Forecast Gross Profit ÷ Forecast Revenue' },
  ]

  // 5. Variations — approved and pending kept strictly apart.
  const variationFigures = [
    { key: 'approvedClientVariations', label: 'Approved client variations', kind: FIGURE_KIND.MONEY,
      figure: gated(REPORT_DEPENDENCIES.clientVariations, m.approvedClientVariations, sourceStates),
      note: 'Included in the Current Contract Sum' },
    { key: 'pendingClientVariations', label: 'Pending client variations', kind: FIGURE_KIND.MONEY, pending: true,
      figure: gated(REPORT_DEPENDENCIES.clientVariations, m.pendingClientVariationExposure, sourceStates),
      note: 'Submitted, not approved — NOT included in any revenue figure' },
    { key: 'approvedSupplierVariations', label: 'Approved supplier variations', kind: FIGURE_KIND.MONEY,
      figure: gated(REPORT_DEPENDENCIES.supplierVariations, m.approvedSupplierVariations, sourceStates),
      note: 'Gross approved supplier variation value' },
    { key: 'appliedSupplierVariations', label: '… of which applied to POs', kind: FIGURE_KIND.MONEY,
      figure: gated(REPORT_DEPENDENCIES.supplierVariations, m.appliedSupplierVariations, sourceStates),
      note: 'Already inside Committed' },
    { key: 'unappliedSupplierVariations', label: '… of which not yet applied', kind: FIGURE_KIND.MONEY,
      figure: gated(REPORT_DEPENDENCIES.supplierVariations, m.unappliedSupplierVariations, sourceStates),
      note: 'Approved exposure not yet in Committed or Forecast Final Cost' },
    { key: 'pendingSupplierVariations', label: 'Pending supplier variations', kind: FIGURE_KIND.MONEY, pending: true,
      figure: gated(REPORT_DEPENDENCIES.supplierVariations, m.pendingSupplierVariationExposure, sourceStates),
      note: 'Submitted, not approved — NOT included in any cost figure' },
  ]

  // 6. Cash — recorded cash only (gross, incl. GST), never an invoice amount.
  const inRows = cashInRows(clientReceipts, { projectId: project?.id ?? null })
  const outRows = cashOutRows(supplierPayments, { projectId: project?.id ?? null })
  const cashIn = totalActualCashIn(inRows)
  const cashOut = totalActualCashOut(outRows)
  const receivables = receivablesSummary(clientInvoices, clientReceipts)
  const cashFigures = [
    { key: 'cashIn', label: 'Cash received (client receipts)', kind: FIGURE_KIND.MONEY,
      figure: gated(REPORT_DEPENDENCIES.cashIn, cashIn, sourceStates),
      note: 'Posted client receipts, gross' },
    { key: 'cashOut', label: 'Cash paid (supplier payments)', kind: FIGURE_KIND.MONEY,
      figure: gated(REPORT_DEPENDENCIES.cashOut, cashOut, sourceStates),
      note: 'Posted supplier payments, gross' },
    { key: 'netCash', label: 'Net recorded cash', kind: FIGURE_KIND.MONEY,
      figure: gated(REPORT_DEPENDENCIES.netCash, actualNetCash(cashIn, cashOut), sourceStates),
      note: 'Cash received − cash paid on this project; not a bank balance' },
    { key: 'receivablesOutstanding', label: 'Client invoices outstanding', kind: FIGURE_KIND.MONEY,
      figure: gated(REPORT_DEPENDENCIES.receivables, receivables.remaining, sourceStates),
      note: 'Issued client invoices not yet matched to a receipt, gross — not cash' },
    { key: 'remainingPayable', label: 'Supplier invoices unpaid', kind: FIGURE_KIND.MONEY,
      figure: availableFigure('remainingPayable', snapshot.remainingPayable.value, sourceStates),
      note: 'Posted supplier invoices still payable, gross — not cash' },
  ]

  // Whole-report state: loading while anything is loading (no export of a
  // half-loaded report); a failed source never blocks the rest — it shows as
  // Unavailable on exactly the figures that read it.
  const overall = figureState(REPORT_SOURCES, sourceStates)
  const failedSources = REPORT_SOURCES.filter(src => {
    const s = sourceStates?.[src]
    return !s || typeof s.loading !== 'boolean' || typeof s.error !== 'boolean' || s.error
  })
  const loading = REPORT_SOURCES.some(src => sourceStates?.[src]?.loading === true)

  return {
    projectId: project?.id ?? null,
    projectName: project?.name ?? '',
    currencyCode,
    budgetSource: snapshot.budgetSource,
    budgetSourceCaption: budgetSourceCaption(budgetSource),
    contractNotEstablished: notEstablished,
    state: overall.state,
    loading,
    failedSources,
    summary,
    costCodes: costCodeTable,
    variations: variationFigures,
    cash: cashFigures,
  }
}

// True when the report is settled (nothing loading) and can be exported.
export const isReportExportable = (report) => !!report && report.loading === false
