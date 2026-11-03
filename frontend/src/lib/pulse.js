import { roundMoney } from './purchaseOrders'
import { safeNumber, isOverBudget } from './forecast'
import { projectForecastRows, projectForecastTotals, computeMargin, isBaselineEstablished } from './margin'
import {
  VARIATION_TYPE, VARIATION_STATUS, VARIATION_PENDING_STATUSES,
  pendingSupplierVariationExposureTotal, pendingClientVariationExposureTotal,
} from './variations'
import { payablesSummary, paymentSummary, apAgeing, isPastDuePayable } from './supplierPayments'
import { releasedByInvoiceId } from './retention'
import { daysPastDue } from './payments'
import { isOverdue, daysLate, timelineSummary, compareActivities, formatIsoDate } from './projectTimeline'
import { dependencyStates } from './ganttDependencies'
import { baselineComparison, baselineSummary } from './ganttBaseline'
import {
  blockedActivityRows, hasRecordedDependencies,
  dependencyReviewRows, dependencyReviewCounts,
  resolveActiveBaseline, BASELINE_PROBLEM_TEXT, activeBaselineLabel, approvedOnIso,
  baselineSlippageRows, baselineSlippageCounts, envelopeText,
} from './pulseSchedule'
import {
  figureState, FIGURE_STATE, FIGURE_DEPENDENCIES, FORECAST_ROW_SOURCES,
  SNAPSHOT_SOURCES, SNAPSHOT_SOURCE_LABELS,
} from './projectSnapshot'
import { resolveBudgetSource, budgetLinesFor, originalApprovedBudgetFor, approvedVersionCaption, BUDGET_SOURCE, BUDGET_SOURCE_LABELS } from './budgetApproval'

// ── Constrapp PULSE™ 1A — objective project health indicators (ADR-47) ────────
//
// A DETERMINISTIC, READ-ONLY layer over the project's existing records. Every
// condition below is decided from the output of an existing authoritative
// selector, carried through unchanged:
//
//   Forecast Final Cost, Variance to Budget, per-cost-code flags
//                          → lib/margin.js  projectForecastRows / projectForecastTotals
//                            (lib/forecast.js composeForecastRow — ADR-43)
//   Forecast Gross Profit, Margin %, Current Contract Sum
//                          → lib/margin.js  computeMargin
//   Remaining payable, past due, unallocated cash
//                          → lib/supplierPayments.js  payablesSummary / apAgeing /
//                            isPastDuePayable / paymentSummary, with
//                            lib/retention.js releasedByInvoiceId
//   Overdue activities     → lib/projectTimeline.js  isOverdue / daysLate
//   Blocked activities,
//   dependencies to review → lib/ganttDependencies.js  dependencyStates (ADR-65),
//                            rows through lib/pulseSchedule.js (PULSE 1C, ADR-67)
//   Later than baseline    → lib/ganttBaseline.js  baselineComparison /
//                            baselineSummary (ADR-66), rows through
//                            lib/pulseSchedule.js
//   Pending variations     → lib/variations.js  pending exposure totals
//
// This module adds NO money arithmetic and NO threshold: it compares existing
// figures with zero at cent resolution, counts records, filters lists and
// attaches availability. There is no health score, no weighting, no severity
// ranking, no history and no prediction — and there must never be. Every
// indicator is ONE project in ONE currency (the caller's resolved project
// currency); nothing is summed across projects.
//
// Since PULSE 1C (ADR-67) three SCHEDULE indicators sit beside the overdue
// one. They are three different measures and are never merged: overdue is
// the CURRENT PLAN (planned finish passed), blocked and dependency review
// are the current plan's DEPENDENCIES (ADR-65 read-time states), and
// baseline slippage is the ACTIVE APPROVED BASELINE (ADR-66 variance). One
// activity may be all four at once; each indicator counts its own condition
// and no cross-indicator total exists. The expensive shared derivations —
// dependencyStates and baselineComparison — run ONCE per evaluation.
//
// Each indicator resolves to exactly one state:
//
//   LOADING      a source it reads has not settled           (render "—")
//   UNAVAILABLE  a source it reads failed                    (never "no issue")
//   NEEDS_DATA   sources settled, but an input the condition needs is missing
//                (no budget, no contract value, an incomplete forecast, …)
//   FINDING      the condition is supported by the records
//   NO_ISSUE     complete, usable records were checked and the condition is
//                absent — a genuine negative, never a default
//
// Availability comes from lib/projectSnapshot.js → figureState: a dependency
// that is loading, failed or missing from `sourceStates` can never produce
// NO_ISSUE. Each indicator declares only the sources its selectors actually
// read (INDICATOR_DEPENDENCIES, perturbation-verified in tests), so one failed
// source never blocks an unrelated indicator.

export const PULSE_STATE = {
  LOADING:     FIGURE_STATE.LOADING,
  UNAVAILABLE: FIGURE_STATE.UNAVAILABLE,
  NEEDS_DATA:  'needs_data',
  FINDING:     'finding',
  NO_ISSUE:    'no_issue',
}

export const PULSE_STATE_ORDER = [
  PULSE_STATE.FINDING, PULSE_STATE.NEEDS_DATA, PULSE_STATE.UNAVAILABLE,
  PULSE_STATE.NO_ISSUE, PULSE_STATE.LOADING,
]

export const PULSE_STATE_LABELS = {
  [PULSE_STATE.FINDING]:     'Findings',
  [PULSE_STATE.NEEDS_DATA]:  'Needs data',
  [PULSE_STATE.UNAVAILABLE]: 'Unavailable',
  [PULSE_STATE.NO_ISSUE]:    'No issue found',
  [PULSE_STATE.LOADING]:     'Loading',
}

export const INDICATOR = {
  FORECAST_OVER_BUDGET:       'forecastOverBudget',
  FORECAST_INCOMPLETE:        'forecastIncomplete',
  NEGATIVE_GROSS_PROFIT:      'negativeGrossProfit',
  OVERDUE_ACTIVITIES:         'overdueActivities',
  // PULSE 1C (ADR-67) — the three schedule indicators.
  BLOCKED_ACTIVITIES:         'blockedActivities',
  DEPENDENCY_REVIEW:          'dependencyReview',
  BASELINE_SLIPPAGE:          'baselineSlippage',
  PAST_DUE_SUPPLIER_INVOICES: 'pastDueSupplierInvoices',
  PENDING_VARIATION_EXPOSURE: 'pendingVariationExposure',
}

// A FIXED presentation order — not a ranking. Nothing here is "worse" than
// anything else; the page groups by state and keeps this order within a group.
// The six ADR-47 indicators keep their relative order; the three ADR-67
// schedule indicators sit together after the overdue one.
export const INDICATOR_ORDER = [
  INDICATOR.FORECAST_OVER_BUDGET,
  INDICATOR.FORECAST_INCOMPLETE,
  INDICATOR.NEGATIVE_GROSS_PROFIT,
  INDICATOR.OVERDUE_ACTIVITIES,
  INDICATOR.BLOCKED_ACTIVITIES,
  INDICATOR.DEPENDENCY_REVIEW,
  INDICATOR.BASELINE_SLIPPAGE,
  INDICATOR.PAST_DUE_SUPPLIER_INVOICES,
  INDICATOR.PENDING_VARIATION_EXPOSURE,
]

// Every subscription PULSE reads: the Dashboard snapshot's ten, the project
// programme, and (ADR-67) the baseline HEADERS plus the ONE snapshot of the
// active approved baseline. Cost codes are NOT a source — in buildForecastRows
// they supply display names only and change no row or amount (ADR-42
// Decision 3).
export const PULSE_SOURCES = [...SNAPSHOT_SOURCES, 'activities', 'programmeBaselines', 'programmeBaselineSnapshot']

export const PULSE_SOURCE_LABELS = {
  ...SNAPSHOT_SOURCE_LABELS,
  activities: 'Programme Activities',
  programmeBaselines: 'Programme Baselines',
  programmeBaselineSnapshot: 'Programme Baseline Snapshot',
}

// The sources each indicator's selectors read — INCLUDING the sources behind
// its caveats, because a caveat is part of the result. Traced:
//   · over budget      — variance (budget lines + the FFC sources) and the
//                        incomplete-forecast caveat (the whole row union, since
//                        a variation-only cost code with no forecast line counts
//                        as unforecast)
//   · incomplete       — the row union (FORECAST_ROW_SOURCES)
//   · gross profit     — computeMargin (baseline, variations, FFC sources) plus
//                        the same incomplete-forecast caveat (row union)
//   · overdue          — activities only
//   · blocked          — activities only (dependencyStates reads nothing else)
//   · dependency review — activities only
//   · baseline slippage — activities, the baseline headers (which version is
//                        active) and that version's snapshot
//   · past due         — the Remaining Payable composition (ADR-42)
//   · pending exposure — variations only
export const INDICATOR_DEPENDENCIES = {
  [INDICATOR.FORECAST_OVER_BUDGET]:       FORECAST_ROW_SOURCES,
  [INDICATOR.FORECAST_INCOMPLETE]:        FORECAST_ROW_SOURCES,
  [INDICATOR.NEGATIVE_GROSS_PROFIT]:      ['baseline', ...FORECAST_ROW_SOURCES],
  [INDICATOR.OVERDUE_ACTIVITIES]:         ['activities'],
  [INDICATOR.BLOCKED_ACTIVITIES]:         ['activities'],
  [INDICATOR.DEPENDENCY_REVIEW]:          ['activities'],
  [INDICATOR.BASELINE_SLIPPAGE]:          ['activities', 'programmeBaselines', 'programmeBaselineSnapshot'],
  [INDICATOR.PAST_DUE_SUPPLIER_INVOICES]: FIGURE_DEPENDENCIES.remainingPayable,
  [INDICATOR.PENDING_VARIATION_EXPOSURE]: ['variations'],
}

// Where each indicator sends the user to investigate — an existing project
// tab, relative to /projects/:projectId. These are tab-level links: the GANTT
// tab accepts no URL filter (record-level deep links stay deferred, ADR-49 /
// ADR-67), so no query string is invented here.
export const INDICATOR_LINKS = {
  [INDICATOR.FORECAST_OVER_BUDGET]:       { to: 'forecasting',                 label: 'Open Forecast' },
  [INDICATOR.FORECAST_INCOMPLETE]:        { to: 'forecasting',                 label: 'Open Forecast' },
  [INDICATOR.NEGATIVE_GROSS_PROFIT]:      { to: 'commercial',                  label: 'Open Commercial' },
  [INDICATOR.OVERDUE_ACTIVITIES]:         { to: 'timeline',                    label: 'Open GANTT' },
  [INDICATOR.BLOCKED_ACTIVITIES]:         { to: 'timeline',                    label: 'Open GANTT' },
  [INDICATOR.DEPENDENCY_REVIEW]:          { to: 'timeline',                    label: 'Open GANTT' },
  [INDICATOR.BASELINE_SLIPPAGE]:          { to: 'timeline',                    label: 'Open GANTT' },
  [INDICATOR.PAST_DUE_SUPPLIER_INVOICES]: { to: 'commercial/supplier-payments', label: 'Open Supplier Payments' },
  [INDICATOR.PENDING_VARIATION_EXPOSURE]: { to: 'variations',                  label: 'Open Variations' },
}

export const INDICATOR_TITLES = {
  [INDICATOR.FORECAST_OVER_BUDGET]:       'Forecast Final Cost exceeds Approved Budget',
  [INDICATOR.FORECAST_INCOMPLETE]:        'Cost codes not yet forecast',
  [INDICATOR.NEGATIVE_GROSS_PROFIT]:      'Forecast Gross Profit is negative',
  [INDICATOR.OVERDUE_ACTIVITIES]:         'Programme activities overdue',
  [INDICATOR.BLOCKED_ACTIVITIES]:         'Programme activities blocked by predecessors',
  [INDICATOR.DEPENDENCY_REVIEW]:          'Programme dependencies need review',
  [INDICATOR.BASELINE_SLIPPAGE]:          'Programme later than approved baseline',
  [INDICATOR.PAST_DUE_SUPPLIER_INVOICES]: 'Supplier invoices past due',
  [INDICATOR.PENDING_VARIATION_EXPOSURE]: 'Pending variation exposure',
}

// Needs-data reasons, so the page can send the user to the right place.
export const NEEDS_DATA_REASON = {
  NO_BUDGET:            'no_budget',
  NO_COST_CODES:        'no_cost_codes',
  FORECAST_INCOMPLETE:  'forecast_incomplete',
  CONTRACT_NOT_SET:     'contract_not_set',
  NO_PROGRAMME:         'no_programme',
  DUE_DATES_MISSING:    'due_dates_missing',
  // ADR-67: no approved baseline (none, or drafts only) / an approved
  // baseline whose snapshot cannot be compared (an integrity reason).
  NO_APPROVED_BASELINE: 'no_approved_baseline',
  BASELINE_UNUSABLE:    'baseline_unusable',
}

// Evidence column kinds the page knows how to format. Money is formatted by
// the page with the project currency; the engine carries raw numbers.
export const COLUMN = {
  TEXT:  'text',
  MONEY: 'money',
  DATE:  'date',
  INT:   'int',
  DAYS:  'days',
}

// ── Shared helpers (comparisons and counts — no arithmetic) ──────────────────

// Negative at cent resolution — the same test isOverBudget applies to a
// variance (roundMoney(safeNumber(v)) < 0), reused for any money figure.
const isNegativeMoney = (n) => isOverBudget(n)
const isPositiveMoney = (n) => roundMoney(safeNumber(n)) > 0

const sortByMoneyAsc = (key) => (a, b) => safeNumber(a[key]) - safeNumber(b[key])

// '3 activities' / '1 activity' — a count with its noun (text, not a figure).
const counted = (n, one, many) => String(n) + ' ' + (n === 1 ? one : many)

// The evaluated-indicator shape. `values` are selector outputs; `evidence`
// rows are records (or selector rows) filtered, never re-derived.
function indicator(id, state, extra = {}) {
  return {
    id,
    title: INDICATOR_TITLES[id],
    link: INDICATOR_LINKS[id],
    state,
    failedSources: [],
    reason: null,
    headline: '',
    explanation: '',
    values: {},
    evidence: [],
    evidenceColumns: [],
    caveats: [],
    ...extra,
  }
}

// One availability check for every indicator: a loading or failed dependency
// short-circuits before the condition is evaluated, so no condition is ever
// judged on partial records.
function gate(id, sourceStates) {
  const s = figureState(INDICATOR_DEPENDENCIES[id], sourceStates)
  if (s.state === FIGURE_STATE.READY) return null
  return indicator(id, s.state, { failedSources: s.failedSources })
}

// The incomplete-forecast caveat shared by the two forecast-dependent money
// indicators. It states what is excluded without claiming a bound: the app
// accepts a forecast input of zero or more, but that is client-validated
// (ADR-43 — rules enforce no type on uncommittedCostToComplete).
const forecastIncompleteCaveat = (count) =>
  `${count} cost ${count === 1 ? 'code has' : 'codes have'} no saved forecast, so Forecast Final Cost ` +
  'carries no Uncommitted Cost to Complete for them. Completing those forecasts will change this figure.'

// ADR-70: the comparison used the editable working register — no budget
// version has been approved yet, so the figure is not an Approved Budget.
const WORKING_BUDGET_CAVEAT =
  'No budget version has been approved for this project, so the comparison uses the editable working budget ' +
  '(not approved). Approve a budget version on the Budget tab to compare against an Approved Budget.'

const PROGRAMME_CAVEAT =
  'The programme is a manually maintained current plan — not an approved baseline, and never a ' +
  'completion percentage or schedule performance measure.'

const RELEASED_RETENTION_CAVEAT =
  'Released retention is aged from the original invoice due date (a release carries no due date of its own), ' +
  'which overstates its age.'

const PAST_DUE_WORDING_CAVEAT =
  'A past-due balance is what remains after posted payment allocations and credits — it is not proof the ' +
  'supplier is unpaid: a payment may be recorded but not yet posted or allocated.'

// ── 1 · Forecast Final Cost exceeds Approved Budget ──────────────────────────

const OVER_BUDGET_COLUMNS = [
  { key: 'costCodeName',      label: 'Cost code',           kind: COLUMN.TEXT },
  { key: 'budgeted',          label: 'Approved Budget',     kind: COLUMN.MONEY },
  { key: 'forecastFinalCost', label: 'Forecast Final Cost', kind: COLUMN.MONEY },
  { key: 'varianceToBudget',  label: 'Variance',            kind: COLUMN.MONEY },
]

// ADR-70: `budgetSource` names WHICH budget the comparison used — the
// approved snapshot (with its version) or the legacy WORKING register, which
// is never presented as approved. The condition itself is unchanged.
function evaluateForecastOverBudget(rows, totals, budgetSource, sourceStates) {
  const id = INDICATOR.FORECAST_OVER_BUDGET
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const approved = budgetSource?.kind === BUDGET_SOURCE.APPROVED
  // ADR-71: the current ADJUSTED approved budget names its adjustments.
  const budgetLabel = approved
    ? `Approved Budget · version ${approvedVersionCaption(budgetSource)}`
    : BUDGET_SOURCE_LABELS[BUDGET_SOURCE.WORKING]
  const values = {
    budgetSource:      budgetLabel,
    approvedBudget:    totals.budgeted,
    forecastFinalCost: totals.forecastFinalCost,
    varianceToBudget:  totals.varianceToBudget,
    unforecastedCount: totals.unforecastedCount,
    overBudgetCount:   totals.overBudgetCount,
  }
  const sourceCaveat = approved ? [] : [WORKING_BUDGET_CAVEAT]

  if (!rows.some(r => r.hasBudgetLine)) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_BUDGET,
      headline: 'No budget to compare against',
      explanation: 'This project has no approved budget version and no budget lines, so Forecast Final Cost cannot be compared with a budget.',
      values,
      link: { to: 'budget', label: 'Open Budget' },
    })
  }

  const overBudgetRows = rows.filter(r => r.overBudget).sort(sortByMoneyAsc('varianceToBudget'))
  // Cost carried on codes with no budget line at all — listed separately
  // because an unbudgeted row is never "over budget" (ADR-43 Decision 2).
  const unbudgetedRows = rows
    .filter(r => !r.hasBudgetLine && isPositiveMoney(r.forecastFinalCost))
    .sort(sortByMoneyAsc('forecastFinalCost')).reverse()
  const caveats = [
    ...sourceCaveat,
    ...(totals.unforecastedCount > 0 ? [forecastIncompleteCaveat(totals.unforecastedCount)] : []),
  ]

  if (isOverBudget(totals.varianceToBudget)) {
    return indicator(id, PULSE_STATE.FINDING, {
      headline: approved ? 'Forecast Final Cost is over the Approved Budget' : 'Forecast Final Cost is over the working budget (not approved)',
      explanation:
        `Variance to Budget (${budgetLabel} − Forecast Final Cost) is negative. Forecast Final Cost = ` +
        'Actual + Remaining Committed + Uncommitted Cost to Complete, ex-GST, derived at read time.',
      values: { ...values, unbudgetedRows },
      evidence: overBudgetRows,
      evidenceColumns: OVER_BUDGET_COLUMNS,
      caveats,
    })
  }

  if (totals.unforecastedCount > 0) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.FORECAST_INCOMPLETE,
      headline: 'Within budget so far — but the forecast is incomplete',
      explanation:
        `Forecast Final Cost does not exceed the ${budgetLabel} on the records saved so far, but cost codes ` +
        'without a saved forecast contribute no Uncommitted Cost to Complete, so this cannot be confirmed yet.',
      values: { ...values, unbudgetedRows },
      evidence: overBudgetRows,
      evidenceColumns: OVER_BUDGET_COLUMNS,
      caveats,
    })
  }

  return indicator(id, PULSE_STATE.NO_ISSUE, {
    headline: approved ? 'Forecast Final Cost is within the Approved Budget' : 'Forecast Final Cost is within the working budget (not approved)',
    explanation: `Every cost code carries a saved forecast and Variance to Budget (${budgetLabel} − Forecast Final Cost) is zero or positive.`,
    values: { ...values, unbudgetedRows },
    evidence: overBudgetRows,
    evidenceColumns: OVER_BUDGET_COLUMNS,
    caveats: sourceCaveat,
  })
}

// ── 2 · Cost codes not yet forecast ──────────────────────────────────────────

const UNFORECAST_COLUMNS = [
  { key: 'costCodeName',       label: 'Cost code',           kind: COLUMN.TEXT },
  { key: 'budgeted',           label: 'Approved Budget',     kind: COLUMN.MONEY },
  { key: 'actual',             label: 'Actual',              kind: COLUMN.MONEY },
  { key: 'remainingCommitted', label: 'Remaining Committed', kind: COLUMN.MONEY },
]

function evaluateForecastIncomplete(rows, totals, sourceStates) {
  const id = INDICATOR.FORECAST_INCOMPLETE
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const values = { unforecastedCount: totals.unforecastedCount, lineCount: totals.lineCount }

  if (rows.length === 0) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_COST_CODES,
      headline: 'No cost codes carry budget, commitment, cost or forecast yet',
      explanation: 'There is nothing to forecast until the project has budget lines, purchase orders, claims or invoices.',
      values,
      link: { to: 'budget', label: 'Open Budget' },
    })
  }

  const unforecastRows = rows.filter(r => r.unforecasted)
  if (unforecastRows.length > 0) {
    return indicator(id, PULSE_STATE.FINDING, {
      headline: `${unforecastRows.length} of ${rows.length} cost ${rows.length === 1 ? 'code has' : 'codes have'} no saved forecast`,
      explanation:
        'A cost code is forecast once an Uncommitted Cost to Complete is saved for it — a saved 0 counts. ' +
        'Until then its Forecast Final Cost is Actual + Remaining Committed only.',
      values,
      evidence: unforecastRows,
      evidenceColumns: UNFORECAST_COLUMNS,
    })
  }

  return indicator(id, PULSE_STATE.NO_ISSUE, {
    headline: `All ${rows.length} cost ${rows.length === 1 ? 'code carries' : 'codes carry'} a saved forecast`,
    explanation: 'Every cost code in the budget, commitment, cost and forecast records has an Uncommitted Cost to Complete saved.',
    values,
  })
}

// ── 3 · Forecast Gross Profit is negative ────────────────────────────────────

function evaluateNegativeGrossProfit(totals, margin, baseline, sourceStates) {
  const id = INDICATOR.NEGATIVE_GROSS_PROFIT
  const gated = gate(id, sourceStates)
  if (gated) return gated

  if (!isBaselineEstablished(baseline)) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.CONTRACT_NOT_SET,
      headline: 'Original Contract Value not set',
      explanation: 'Forecast Gross Profit needs the Original Contract Value on the Commercial tab. Until it is saved there is no revenue figure to compare with cost.',
      values: { forecastFinalCost: totals.forecastFinalCost, unforecastedCount: totals.unforecastedCount },
    })
  }

  const values = {
    currentContractSum:  margin.currentContractSum,
    forecastFinalCost:   margin.forecastFinalCost,
    forecastGrossProfit: margin.forecastGrossProfit,
    forecastMarginPct:   margin.forecastMarginPct,
    unforecastedCount:   totals.unforecastedCount,
  }
  const caveats = totals.unforecastedCount > 0 ? [forecastIncompleteCaveat(totals.unforecastedCount)] : []

  if (isNegativeMoney(margin.forecastGrossProfit)) {
    return indicator(id, PULSE_STATE.FINDING, {
      headline: 'Forecast Final Cost exceeds the Current Contract Sum',
      explanation:
        'Forecast Gross Profit = Current Contract Sum (Original Contract Value + approved client variations) − ' +
        'Forecast Final Cost, ex-GST. Pending variations are not included on either side.',
      values,
      caveats,
    })
  }

  if (totals.unforecastedCount > 0) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.FORECAST_INCOMPLETE,
      headline: 'Profit forecast so far — but the forecast is incomplete',
      explanation:
        'Forecast Gross Profit is zero or positive on the records saved so far, but cost codes without a saved ' +
        'forecast contribute no Uncommitted Cost to Complete, so a positive margin cannot be confirmed yet.',
      values,
      caveats,
    })
  }

  return indicator(id, PULSE_STATE.NO_ISSUE, {
    headline: 'Forecast Gross Profit is zero or positive',
    explanation: 'Every cost code carries a saved forecast and the Current Contract Sum covers Forecast Final Cost.',
    values,
  })
}

// ── 4 · Programme activities overdue ─────────────────────────────────────────

const OVERDUE_COLUMNS = [
  { key: 'name',            label: 'Activity',        kind: COLUMN.TEXT },
  { key: 'plannedFinish',   label: 'Planned finish',  kind: COLUMN.DATE },
  { key: 'daysLate',        label: 'Days late',       kind: COLUMN.DAYS },
  { key: 'responsibleName', label: 'Responsible',     kind: COLUMN.TEXT },
  { key: 'costCodeName',    label: 'Cost code',       kind: COLUMN.TEXT },
]

function evaluateOverdueActivities(activities, now, sourceStates) {
  const id = INDICATOR.OVERDUE_ACTIVITIES
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const list = activities ?? []
  const summary = timelineSummary(list, now)
  const values = { overdue: summary.overdue, open: summary.open, total: summary.total }

  if (list.length === 0) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_PROGRAMME,
      headline: 'No programme activities yet',
      explanation: 'Overdue work can only be identified once the project has activities with planned finish dates on the Timeline.',
      values,
    })
  }

  const overdueRows = list
    .filter(a => isOverdue(a, now))
    .sort(compareActivities)
    .map(a => ({
      id: a.id,
      name: a.isMilestone ? `${a.name} (milestone)` : a.name,
      isMilestone: !!a.isMilestone,
      status: a.status,
      plannedFinish: a.plannedFinish,
      daysLate: daysLate(a, now),
      responsibleName: a.responsibleName || '',
      costCodeName: a.costCodeName || '',
    }))
    .sort((a, b) => b.daysLate - a.daysLate)

  if (overdueRows.length > 0) {
    return indicator(id, PULSE_STATE.FINDING, {
      headline: `${overdueRows.length} open ${overdueRows.length === 1 ? 'activity is' : 'activities are'} past planned finish`,
      explanation: 'An activity is overdue when it is still open (not started, in progress or on hold) and its planned finish is before today, in your local calendar day.',
      values,
      evidence: overdueRows,
      evidenceColumns: OVERDUE_COLUMNS,
      caveats: [PROGRAMME_CAVEAT],
    })
  }

  return indicator(id, PULSE_STATE.NO_ISSUE, {
    headline: `No open activity is past its planned finish (${summary.open} open)`,
    explanation: 'Every open activity has a planned finish of today or later; completed and cancelled work is not assessed.',
    values,
    caveats: [PROGRAMME_CAVEAT],
  })
}

// ── 4b · Programme activities blocked by predecessors (ADR-67) ───────────────
//
// The GANTT 1A2 selector decides "blocked" (lib/ganttDependencies.js): a
// NOT-STARTED activity whose planned start has arrived (viewer's local day)
// while at least one predecessor is unfinished or can never satisfy the link
// (cancelled, missing, malformed, cyclic). A future start is never blocked
// merely because its predecessors are open. One row per activity, however
// many links block it. This is the CURRENT PLAN's dependencies — not overdue
// (the finish), not the baseline.

const OVERLAP_CAVEAT =
  'One activity can be overdue, blocked, in a dependency needing review and later than the approved baseline at ' +
  'the same time. Each indicator counts its own condition; the counts are never added together.'

const BLOCKED_CAVEAT =
  'Blocked is derived from the current plan and the recorded statuses: an activity reads as blocked only once its ' +
  'own planned start has arrived while it is still not started and a predecessor is unfinished or needs review. ' +
  'Work begun on site but not yet marked in progress still reads as blocked. This is not a critical path.'

const DEPENDENCY_CAVEAT =
  'Dependency states are derived at read time from the links as stored. Firestore rules pin only the first and ' +
  'last predecessor entries of an activity, so a cancelled, missing, malformed or cyclic link can exist and is ' +
  'reported for review — it never satisfies a dependency, and nothing is repaired or removed automatically.'

const NO_DEPENDENCIES_EXPLANATION =
  'No dependencies are recorded. Nothing here validates work sequencing: without recorded predecessors on this ' +
  'programme, PULSE cannot tell whether an activity is waiting on another.'

const BLOCKED_COLUMNS = [
  { key: 'name',            label: 'Activity',       kind: COLUMN.TEXT },
  { key: 'plannedStart',    label: 'Planned start',  kind: COLUMN.DATE },
  { key: 'daysWaiting',     label: 'Days waiting',   kind: COLUMN.DAYS },
  { key: 'blockedBy',       label: 'Waiting on',     kind: COLUMN.TEXT },
  { key: 'unresolved',      label: 'Needs review',   kind: COLUMN.TEXT },
  { key: 'responsibleName', label: 'Responsible',    kind: COLUMN.TEXT },
]

function evaluateBlockedActivities(activities, depStates, now, sourceStates) {
  const id = INDICATOR.BLOCKED_ACTIVITIES
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const list = activities ?? []
  const summary = timelineSummary(list, now)
  const base = { open: summary.open, total: summary.total }

  if (list.length === 0) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_PROGRAMME,
      headline: 'No programme activities yet',
      explanation: 'Blocked work can only be identified once the project has activities with predecessors on the GANTT tab.',
      values: base,
    })
  }

  const rows = blockedActivityRows(list, depStates, now)
  const values = { ...base, blocked: rows.length, alsoOverdue: rows.filter(r => r.overdue).length }

  if (rows.length > 0) {
    return indicator(id, PULSE_STATE.FINDING, {
      headline: `${counted(rows.length, 'activity', 'activities')} should have started but ${rows.length === 1 ? 'is' : 'are'} blocked by a predecessor`,
      explanation:
        'An activity is blocked when it is not started, its planned start is today or earlier in your local calendar ' +
        'day, and a predecessor is unfinished or needs review (cancelled, missing, malformed or in a cycle). ' +
        'Days waiting are calendar days since the planned start.',
      values,
      evidence: rows,
      evidenceColumns: BLOCKED_COLUMNS,
      caveats: [BLOCKED_CAVEAT, OVERLAP_CAVEAT, PROGRAMME_CAVEAT],
    })
  }

  if (!hasRecordedDependencies(list)) {
    return indicator(id, PULSE_STATE.NO_ISSUE, {
      headline: 'No dependencies are recorded, so no activity is blocked by a predecessor',
      explanation: NO_DEPENDENCIES_EXPLANATION,
      values,
      caveats: [PROGRAMME_CAVEAT],
    })
  }

  return indicator(id, PULSE_STATE.NO_ISSUE, {
    headline: `No activity that should have started is blocked by a predecessor (${summary.open} open)`,
    explanation:
      'Every not-started activity whose planned start has arrived has all its predecessors finished and resolved, ' +
      'or has no predecessor at all.',
    values,
    caveats: [BLOCKED_CAVEAT, PROGRAMME_CAVEAT],
  })
}

// ── 4c · Programme dependencies need review (ADR-67) ─────────────────────────
//
// One row per LINK on an OPEN successor whose ADR-65 state is a schedule
// conflict (starts before the predecessor allows) or one of the four states
// that never satisfy a dependency. A valid unfinished predecessor is not a
// review item. Links (issues) and unique activities (records) are reported
// apart and never merged.

const DEPENDENCY_REVIEW_COLUMNS = [
  { key: 'name',            label: 'Activity',        kind: COLUMN.TEXT },
  { key: 'predecessorName', label: 'Depends on',      kind: COLUMN.TEXT },
  { key: 'condition',       label: 'Condition',       kind: COLUMN.TEXT },
  { key: 'plannedStart',    label: 'Planned start',   kind: COLUMN.DATE },
  { key: 'earliestStart',   label: 'Earliest start',  kind: COLUMN.DATE },
  { key: 'action',          label: 'Review action',   kind: COLUMN.TEXT },
]

function evaluateDependencyReview(activities, depStates, sourceStates) {
  const id = INDICATOR.DEPENDENCY_REVIEW
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const list = activities ?? []
  if (list.length === 0) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_PROGRAMME,
      headline: 'No programme activities yet',
      explanation: 'Dependencies can only be reviewed once the project has activities with predecessors on the GANTT tab.',
      values: {},
    })
  }

  const rows = dependencyReviewRows(list, depStates)
  const values = dependencyReviewCounts(rows, list, depStates)

  if (rows.length > 0) {
    return indicator(id, PULSE_STATE.FINDING, {
      headline: `${values.links} dependency ${values.links === 1 ? 'link' : 'links'} on ${values.activities} open ${values.activities === 1 ? 'activity needs' : 'activities need'} review`,
      explanation:
        'A link needs review when the activity is planned to start before its predecessor allows (a conflict), or ' +
        'when the predecessor is cancelled, missing from this programme, malformed, or part of a dependency cycle — ' +
        'none of which can ever satisfy the dependency. Only open activities are listed; a link is one row, so an ' +
        'activity with several such links appears once per link.',
      values,
      evidence: rows,
      evidenceColumns: DEPENDENCY_REVIEW_COLUMNS,
      caveats: [DEPENDENCY_CAVEAT, OVERLAP_CAVEAT, PROGRAMME_CAVEAT],
    })
  }

  if (!hasRecordedDependencies(list)) {
    return indicator(id, PULSE_STATE.NO_ISSUE, {
      headline: 'No dependencies are recorded.',
      explanation: NO_DEPENDENCIES_EXPLANATION,
      values,
      caveats: [PROGRAMME_CAVEAT],
    })
  }

  return indicator(id, PULSE_STATE.NO_ISSUE, {
    headline: `No dependency link on an open activity needs review (${counted(values.checked, 'link', 'links')} checked)`,
    explanation:
      'Every predecessor link on an open activity resolves to a live activity in this programme, is not in a cycle, ' +
      'and allows the planned start. Links on completed and cancelled activities are history and are not assessed.',
    values,
    caveats: [DEPENDENCY_CAVEAT, PROGRAMME_CAVEAT],
  })
}

// ── 4d · Programme later than approved baseline (ADR-67) ─────────────────────
//
// Against the ACTIVE approved baseline only (the latest approval — the GANTT
// tab offers the original and every historical version). A finding is an
// OPEN activity, present in that baseline, whose current planned finish is
// later than the captured finish — positive calendar-day variance from
// lib/ganttBaseline.js. Everything else the comparison knows (earlier,
// unchanged, added after, cancelled since, finished late, the envelope) is
// context, never a trigger. A draft is never a baseline.

const BASELINE_EVIDENCE_CAVEAT =
  'An approved programme baseline is planning evidence captured by an authorised user — not independently ' +
  'certified contractual data, an extension-of-time entitlement or a delay determination. Firestore rules pin ' +
  'only the first and last captured entries; the rest are as the capturing client wrote them.'

const BASELINE_MEASURE_CAVEAT =
  'Calendar days against the active (latest approved) baseline; these are counts of activities, not a critical ' +
  'path, not an average delay and not a forecast of project completion. The envelope is the movement of the ' +
  'latest planned finish on each side — not a project delay.'

const BASELINE_SLIPPAGE_COLUMNS = [
  { key: 'name',           label: 'Activity',        kind: COLUMN.TEXT },
  { key: 'baselineFinish', label: 'Baseline finish', kind: COLUMN.DATE },
  { key: 'plannedFinish',  label: 'Planned finish',  kind: COLUMN.DATE },
  { key: 'laterBy',        label: 'Later by',        kind: COLUMN.DAYS },
  { key: 'statusLabel',    label: 'Status',          kind: COLUMN.TEXT },
]

function evaluateBaselineSlippage(activities, baselines, snapshot, comparison, summary, sourceStates) {
  const id = INDICATOR.BASELINE_SLIPPAGE
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const list = activities ?? []
  const active = resolveActiveBaseline(baselines, snapshot)
  const context = { approvedVersions: active.approvedCount, drafts: active.draftCount }

  if (list.length === 0) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_PROGRAMME,
      headline: 'No programme activities yet',
      explanation: 'A baseline comparison needs activities on the GANTT tab and an approved baseline of them.',
      values: context,
    })
  }

  if (!active.header) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_APPROVED_BASELINE,
      headline: active.draftCount > 0
        ? `No approved baseline — ${active.draftCount} draft ${active.draftCount === 1 ? 'baseline is' : 'baselines are'} awaiting review`
        : 'No approved baseline to compare against',
      explanation:
        'Capture and approve a programme baseline on the GANTT tab. A draft is not a baseline until it is approved; ' +
        'until then nothing here is slippage against an approved programme, and this is not an overdue finding.',
      values: context,
      caveats: [BASELINE_EVIDENCE_CAVEAT],
    })
  }

  const label = activeBaselineLabel(baselines, active.header)
  const approvedOn = approvedOnIso(active.header)
  const header = { ...context, baselineLabel: label, approvedOn }

  if (!active.usable) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.BASELINE_UNUSABLE,
      headline: `The active baseline cannot be compared: ${BASELINE_PROBLEM_TEXT[active.problem] ?? 'its snapshot is unusable'}`,
      explanation:
        `${label} is approved but ${BASELINE_PROBLEM_TEXT[active.problem] ?? 'its snapshot is unusable'}. No comparison is ` +
        'made and no slippage is claimed — this is an integrity condition to review on the GANTT tab, not a healthy result.',
      values: header,
      caveats: [BASELINE_EVIDENCE_CAVEAT],
    })
  }

  const rows = baselineSlippageRows(list, comparison, active.header)
  const counts = baselineSlippageCounts(rows)
  const values = {
    ...header,
    ...counts,
    compared: summary.compared,
    earlier: summary.earlier,
    unchanged: summary.unchanged,
    addedAfter: summary.addedAfter,
    cancelledSince: summary.cancelledSince,
    completedCompared: summary.completedCompared,
    completedLate: summary.completedLate,
    envelope: envelopeText(summary),
    envelopeBaselineFinish: summary.envelope?.baselineFinish ?? null,
    envelopeCurrentFinish: summary.envelope?.currentFinish ?? null,
  }
  const versions = `${active.approvedCount} approved ${active.approvedCount === 1 ? 'version' : 'versions'}`
  const basis = `Compared with ${label}, approved ${formatIsoDate(approvedOn)} (${versions}).`

  if (rows.length > 0) {
    const parts = []
    if (counts.milestonesLater > 0) parts.push(counted(counts.milestonesLater, 'milestone', 'milestones'))
    if (counts.activitiesLater > 0) parts.push(counted(counts.activitiesLater, 'activity', 'activities'))
    const subject = parts.join(' and ') + ' ' + (counts.later === 1 ? 'is' : 'are')
    return indicator(id, PULSE_STATE.FINDING, {
      headline: `${subject} planned later than ${label}`,
      explanation:
        `${basis} An open activity is later when its current planned finish is after the finish captured in that ` +
        'baseline, in calendar days. Completed work is compared by its recorded finish and shown as context only; ' +
        'activities added after the capture have no baseline date and are counted, not compared.',
      values,
      evidence: rows,
      evidenceColumns: BASELINE_SLIPPAGE_COLUMNS,
      caveats: [BASELINE_MEASURE_CAVEAT, BASELINE_EVIDENCE_CAVEAT, OVERLAP_CAVEAT],
    })
  }

  return indicator(id, PULSE_STATE.NO_ISSUE, {
    headline: `No open activity is planned later than ${label} (${summary.compared} compared)`,
    explanation:
      `${basis} Every open activity in the baseline has a current planned finish on or before its captured finish; ` +
      'activities added after the capture are counted, not compared.',
    values,
    caveats: [BASELINE_MEASURE_CAVEAT, BASELINE_EVIDENCE_CAVEAT],
  })
}

// ── 5 · Supplier invoices past due ───────────────────────────────────────────

const PAST_DUE_COLUMNS = [
  { key: 'invoiceNumber',         label: 'Invoice',          kind: COLUMN.TEXT },
  { key: 'supplierName',          label: 'Supplier',         kind: COLUMN.TEXT },
  { key: 'supplierInvoiceNumber', label: 'Supplier ref',     kind: COLUMN.TEXT },
  { key: 'dueDate',               label: 'Due',              kind: COLUMN.DATE },
  { key: 'daysPastDue',           label: 'Days past due',    kind: COLUMN.DAYS },
  { key: 'remaining',             label: 'Remaining payable', kind: COLUMN.MONEY },
]

function evaluatePastDueSupplierInvoices(sources, now, sourceStates) {
  const id = INDICATOR.PAST_DUE_SUPPLIER_INVOICES
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const { supplierInvoices = [], supplierPayments = [], supplierCreditNotes = [], retentionReleases = [] } = sources
  const releasedMap = releasedByInvoiceId(retentionReleases)
  const payables = payablesSummary(supplierInvoices, supplierPayments, supplierCreditNotes, releasedMap)
  const ageing = apAgeing(supplierInvoices, supplierPayments, supplierCreditNotes, releasedMap, now)
  const payments = paymentSummary(supplierPayments)
  const invoiceById = new Map(supplierInvoices.map(inv => [inv.id, inv]))

  const pastDueRows = payables.rows
    .filter(r => isPastDuePayable(invoiceById.get(r.id), r.remaining, now))
    .map(r => ({ ...r, daysPastDue: daysPastDue(r.dueDate, now) }))
    .sort((a, b) => b.daysPastDue - a.daysPastDue)
  const missingDueDateCount = payables.rows.filter(r => !r.dueDate && isPositiveMoney(r.remaining)).length

  const values = {
    pastDueCount:        pastDueRows.length,
    pastDueTotal:        ageing.pastDue,
    remainingPayable:    payables.remaining,
    postedInvoiceCount:  payables.count,
    unallocatedPayments: payments.unallocated,
    missingDueDateCount,
  }

  const caveats = [PAST_DUE_WORDING_CAVEAT]
  if (isPositiveMoney(payments.unallocated)) {
    caveats.push(
      'Posted supplier payments include cash not yet allocated to any invoice; some of these balances may ' +
      'already have been paid on account.',
    )
  }
  if (missingDueDateCount > 0) {
    caveats.push(
      `${missingDueDateCount} posted ${missingDueDateCount === 1 ? 'invoice' : 'invoices'} with a remaining balance ` +
      'have no due date and cannot be assessed as past due.',
    )
  }
  if (pastDueRows.some(r => isPositiveMoney(r.releasedTotal))) caveats.push(RELEASED_RETENTION_CAVEAT)

  if (pastDueRows.length > 0) {
    return indicator(id, PULSE_STATE.FINDING, {
      headline: `${pastDueRows.length} posted supplier ${pastDueRows.length === 1 ? 'invoice is' : 'invoices are'} past due with a remaining payable balance`,
      explanation:
        'Remaining payable is each posted invoice\'s payable basis (retention withheld excluded, posted retention ' +
        'releases included) less posted payment allocations and posted credit notes. Fully settled invoices are not listed.',
      values,
      evidence: pastDueRows,
      evidenceColumns: PAST_DUE_COLUMNS,
      caveats,
    })
  }

  if (missingDueDateCount > 0) {
    return indicator(id, PULSE_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.DUE_DATES_MISSING,
      headline: 'Open balances exist but have no due date',
      explanation: 'No dated invoice is past due, but balances without a due date cannot be assessed.',
      values,
      caveats,
    })
  }

  return indicator(id, PULSE_STATE.NO_ISSUE, {
    headline: payables.count === 0
      ? 'No posted supplier invoices'
      : 'No posted supplier invoice with a remaining balance is past its due date',
    explanation: 'Checked against posted supplier invoices, posted payment allocations, posted credit notes and posted retention releases.',
    values,
    caveats: caveats.length > 1 ? caveats : [],
  })
}

// ── 6 · Pending variation exposure ───────────────────────────────────────────

// `submittedSubtotal` is the stored ex-GST subtotal of the variation's line
// items on their "submitted side" (the requested amounts, as opposed to the
// approved side). The hook writes it at DRAFT creation and on every draft edit;
// the submit transition changes status only. It is therefore the entered
// amount of a draft as much as of a submitted variation — so the column is
// labelled neutrally, and "formally submitted" is a STATUS distinction carried
// by the Status column and the draft / submitted split in `values`.
const PENDING_VARIATION_COLUMNS = [
  { key: 'variationNumber',   label: 'Variation',        kind: COLUMN.TEXT },
  { key: 'title',             label: 'Title',            kind: COLUMN.TEXT },
  { key: 'typeLabel',         label: 'Type',             kind: COLUMN.TEXT },
  { key: 'statusLabel',       label: 'Status',           kind: COLUMN.TEXT },
  { key: 'counterparty',      label: 'Counterparty',     kind: COLUMN.TEXT },
  { key: 'submittedSubtotal', label: 'Amount (ex-GST)',  kind: COLUMN.MONEY },
]

const TYPE_LABEL   = { [VARIATION_TYPE.CLIENT]: 'Client', [VARIATION_TYPE.SUPPLIER]: 'Supplier' }
const STATUS_LABEL = { [VARIATION_STATUS.DRAFT]: 'Draft', [VARIATION_STATUS.SUBMITTED]: 'Submitted' }

function evaluatePendingVariationExposure(variations, sourceStates) {
  const id = INDICATOR.PENDING_VARIATION_EXPOSURE
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const list = variations ?? []
  const pending = list.filter(v => VARIATION_PENDING_STATUSES.includes(v.status))
  const byStatus = (status) => pending.filter(v => v.status === status)
  const ofType = (type) => pending.filter(v => v.variationType === type)

  // Draft and submitted exposure come from the SAME pending-exposure selectors
  // applied to a status-filtered list, so draft + submitted = pending by
  // construction and no amount is summed here.
  const values = {
    pendingCount:   pending.length,
    supplier: {
      count:          ofType(VARIATION_TYPE.SUPPLIER).length,
      draftCount:     byStatus(VARIATION_STATUS.DRAFT).filter(v => v.variationType === VARIATION_TYPE.SUPPLIER).length,
      submittedCount: byStatus(VARIATION_STATUS.SUBMITTED).filter(v => v.variationType === VARIATION_TYPE.SUPPLIER).length,
      exposure:       pendingSupplierVariationExposureTotal(list),
      draft:          pendingSupplierVariationExposureTotal(byStatus(VARIATION_STATUS.DRAFT)),
      submitted:      pendingSupplierVariationExposureTotal(byStatus(VARIATION_STATUS.SUBMITTED)),
    },
    client: {
      count:          ofType(VARIATION_TYPE.CLIENT).length,
      draftCount:     byStatus(VARIATION_STATUS.DRAFT).filter(v => v.variationType === VARIATION_TYPE.CLIENT).length,
      submittedCount: byStatus(VARIATION_STATUS.SUBMITTED).filter(v => v.variationType === VARIATION_TYPE.CLIENT).length,
      exposure:       pendingClientVariationExposureTotal(list),
      draft:          pendingClientVariationExposureTotal(byStatus(VARIATION_STATUS.DRAFT)),
      submitted:      pendingClientVariationExposureTotal(byStatus(VARIATION_STATUS.SUBMITTED)),
    },
  }

  const caveats = [
    'Exposure, not an error: a pending variation is not overdue or wrong. Pending supplier amounts are NOT in ' +
    'Forecast Final Cost and pending client amounts are NOT in the Current Contract Sum — nothing here is ' +
    'double-counted with the forecast or margin indicators.',
  ]

  if (pending.length === 0) {
    return indicator(id, PULSE_STATE.NO_ISSUE, {
      headline: 'No draft or submitted variations',
      explanation: 'Every variation on this project is approved, rejected, withdrawn or otherwise closed.',
      values,
    })
  }

  const evidence = pending
    .map(v => ({
      id: v.id,
      variationNumber: v.variationNumber || '',
      title: v.title || '',
      variationType: v.variationType,
      typeLabel: TYPE_LABEL[v.variationType] ?? v.variationType,
      status: v.status,
      statusLabel: STATUS_LABEL[v.status] ?? v.status,
      counterparty: v.variationType === VARIATION_TYPE.CLIENT ? (v.clientName || '') : (v.supplierName || ''),
      submittedSubtotal: v.submittedSubtotal ?? null,
    }))
    .sort((a, b) => a.variationNumber.localeCompare(b.variationNumber))

  return indicator(id, PULSE_STATE.FINDING, {
    headline: `${pending.length} pending ${pending.length === 1 ? 'variation' : 'variations'} — ` +
      `${values.supplier.count} supplier, ${values.client.count} client`,
    explanation:
      'Draft and submitted variations are commercial exposure awaiting a decision. Supplier exposure is cost ' +
      'that may still be committed; client exposure is revenue not yet agreed. Each amount is the variation\'s ' +
      'entered ex-GST subtotal — a draft\'s amount has not yet been formally submitted.',
    values,
    evidence,
    evidenceColumns: PENDING_VARIATION_COLUMNS,
    caveats,
  })
}

// ── The evaluation ───────────────────────────────────────────────────────────
//
// `sources` holds the live arrays (and the commercial baseline document, or
// null; and since ADR-67 the programme baseline HEADERS and the active
// version's snapshot document, or null) from the project-scoped hooks;
// `sourceStates` their loading/error flags in the Dashboard snapshot's shape;
// `now` the viewer's local day (useLocalToday); `currencyCode` the project's
// RESOLVED currency, carried through so the page formats every amount in it.
export function evaluatePulse({ sources = {}, sourceStates = {}, now = new Date(), currencyCode } = {}) {
  const {
    budgetLines = [], purchaseOrders = [], progressClaims = [], supplierInvoices = [],
    supplierCreditNotes = [], variations = [], forecastLines = [], baseline = null,
    activities = [], programmeBaselines = [], programmeBaselineSnapshot = null,
    approvedBudget = null,
  } = sources

  // THE budget source (ADR-70): the approved snapshot's lines when a version
  // is approved, the working lines until then — the same adapter the Dashboard
  // snapshot and every project tab use. `sourceStates.approvedBudget` gates
  // the budget indicators (it folds the working register's state in).
  const budgetSource = resolveBudgetSource({
    approvedBudget, budgetLines,
    budgetLinesLoading: sourceStates?.budgetLines?.loading === true,
    budgetLinesError: sourceStates?.budgetLines?.error === true,
    currencyCode,
  })
  const forecastSources = {
    budgetLines: budgetLinesFor(budgetSource), purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines,
  }
  const rows = projectForecastRows(forecastSources)
  const totals = projectForecastTotals(forecastSources)
  const margin = computeMargin({
    baseline, variations, forecastFinalCost: totals.forecastFinalCost, purchaseOrders,
    originalApprovedBudget: originalApprovedBudgetFor(budgetSource),
  })

  // The shared schedule derivations, ONCE per evaluation (ADR-67): the
  // dependency states feed two indicators; the baseline comparison and its
  // summary feed one. Both tolerate malformed records without throwing.
  const depStates = dependencyStates(activities, now)
  const activeBaselineState = resolveActiveBaseline(programmeBaselines, programmeBaselineSnapshot)
  const comparisonSnapshot = activeBaselineState.usable ? programmeBaselineSnapshot : null
  const comparison = baselineComparison(activities, comparisonSnapshot)
  const slippageSummary = baselineSummary(activities, comparisonSnapshot)

  const byId = {
    [INDICATOR.FORECAST_OVER_BUDGET]:       evaluateForecastOverBudget(rows, totals, budgetSource, sourceStates),
    [INDICATOR.FORECAST_INCOMPLETE]:        evaluateForecastIncomplete(rows, totals, sourceStates),
    [INDICATOR.NEGATIVE_GROSS_PROFIT]:      evaluateNegativeGrossProfit(totals, margin, baseline, sourceStates),
    [INDICATOR.OVERDUE_ACTIVITIES]:         evaluateOverdueActivities(activities, now, sourceStates),
    [INDICATOR.BLOCKED_ACTIVITIES]:         evaluateBlockedActivities(activities, depStates, now, sourceStates),
    [INDICATOR.DEPENDENCY_REVIEW]:          evaluateDependencyReview(activities, depStates, sourceStates),
    [INDICATOR.BASELINE_SLIPPAGE]:          evaluateBaselineSlippage(
      activities, programmeBaselines, programmeBaselineSnapshot, comparison, slippageSummary, sourceStates),
    [INDICATOR.PAST_DUE_SUPPLIER_INVOICES]: evaluatePastDueSupplierInvoices(sources, now, sourceStates),
    [INDICATOR.PENDING_VARIATION_EXPOSURE]: evaluatePendingVariationExposure(variations, sourceStates),
  }
  const indicators = INDICATOR_ORDER.map(id => byId[id])

  return { currencyCode, indicators, summary: summarisePulse(indicators) }
}

// The id of the ACTIVE approved baseline among the headers, or null — what
// the page hands useProgrammeBaselineSnapshot so that ONE snapshot document
// is subscribed and the hook stays idle when no approved baseline exists.
// A selection, not a figure: the page computes nothing from it.
export const activeBaselineIdFor = (headers) => resolveActiveBaseline(headers, null).header?.id ?? null

// Counts of indicators in each state. COUNTS ONLY — never combined into a
// score, never weighted, never compared with a threshold.
export function summarisePulse(indicators) {
  const counts = {}
  for (const s of PULSE_STATE_ORDER) counts[s] = 0
  for (const ind of indicators ?? []) {
    if (ind && Object.prototype.hasOwnProperty.call(counts, ind.state)) counts[ind.state] += 1
  }
  return { counts, total: (indicators ?? []).length }
}

// Indicators grouped by state for the page, in INDICATOR_ORDER within a group.
export function groupIndicators(indicators) {
  const groups = {}
  for (const s of PULSE_STATE_ORDER) groups[s] = []
  for (const ind of indicators ?? []) {
    if (ind && groups[ind.state]) groups[ind.state].push(ind)
  }
  return groups
}
