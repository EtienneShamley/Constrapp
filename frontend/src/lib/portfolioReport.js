import { marginPercent } from './margin'
import { resolveBudgetSource, budgetSourceState, BUDGET_SOURCE } from './budgetApproval'
import { resolveProjectCurrency, projectHasExplicitCurrency } from './currency'
import { projectStatusCounts } from './projects'
import { FIGURE_STATE, MARGIN_NOT_ESTABLISHED } from './projectSnapshot'
import { buildCommercialReport, FIGURE_KIND, REPORT_SOURCES, REPORT_SOURCE_LABELS } from './commercialReport'
import { evaluatePulse, INDICATOR, PULSE_STATE } from './pulse'

// ── L2-C Portfolio Report (read-time; COMPOSITION ONLY — ADR-78) ─────────────
//
// One row per company project, GROUPED BY THE PROJECT'S OWN CURRENCY. Like
// lib/commercialReport.js this module is NOT a financial engine:
//
//   · every project figure is read out of lib/commercialReport.js →
//     buildCommercialReport (the L2-A Reports tab's own model), by key,
//     unchanged — so a portfolio row and that project's Reports tab cannot
//     disagree;
//   · the risk indicators are lib/pulse.js → evaluatePulse outputs, filtered
//     to the five whose inputs are financial records this page already reads.
//
// What this module ADDS is exactly three things, none of them a new formula:
//
//   1. GROUPING by resolved project currency. Amounts in different currencies
//      are never added, never converted, and `company.baseCurrency` is never a
//      reporting or conversion currency (ADR-78; ADR-42 Decision 2 still binds
//      the Dashboard).
//   2. SUBTOTALS within ONE currency, in integer cents, printed ONLY when
//      every project in the group has a valid figure. Anything else is an
//      explicit INCOMPLETE state carrying the affected-project count — there
//      is no partial sum, and a failed project is never silently left out.
//   3. The group MARGIN, from lib/margin.js → marginPercent over the group's
//      gross-profit and contract-sum subtotals (never an average of project
//      percentages), and only when both subtotals are complete.
//
// Budget figures have one extra rule (ADR-70): a WORKING budget is not an
// Approved Budget. Such a row shows NOT APPROVED (its working figure is carried
// separately, labelled), and it makes the group's budget and variance
// subtotals incomplete.

// ── Scope ────────────────────────────────────────────────────────────────────

// "Open" is every project that is not Completed — including a legacy project
// whose stored status is outside the vocabulary, which must never drop out of
// the default view silently.
export const COMPLETED_STATUS = 'Completed'
export const isOpenProject = (project) => project?.status !== COMPLETED_STATUS

export function portfolioScope(projects, { includeCompleted = false } = {}) {
  const list = Array.isArray(projects) ? projects.filter(p => p && typeof p.id === 'string' && p.id) : []
  const completed = list.filter(p => !isOpenProject(p))
  return {
    includeCompleted: !!includeCompleted,
    inScope: includeCompleted ? list : list.filter(isOpenProject),
    totalCount: list.length,
    completedCount: completed.length,
    excludedCount: includeCompleted ? 0 : completed.length,
  }
}

// ── Figures ──────────────────────────────────────────────────────────────────

// The extra row state: a READY budget figure resting on a WORKING budget.
export const PORTFOLIO_FIGURE_STATE = {
  ...FIGURE_STATE,
  NOT_SET:      MARGIN_NOT_ESTABLISHED,
  NOT_APPROVED: 'not_approved',
}

// Every column, in reading order. `from` is the buildCommercialReport section
// the figure is read from and `reportKey` its key there — the ONLY link
// between this page and a number.
//   · budget  — an Approved Budget figure (NOT APPROVED on a working budget)
//   · signed  — a negative value is a genuine adverse figure (shown as such)
//   · pending — not approved, not in any revenue figure
export const PORTFOLIO_FIGURES = [
  { key: 'currentContractSum',     from: 'summary',    reportKey: 'currentContractSum',     label: 'Current Contract Sum',        short: 'Contract sum',      kind: FIGURE_KIND.MONEY },
  { key: 'approvedBudget',         from: 'summary',    reportKey: 'approvedBudget',         label: 'Approved Budget',             short: 'Approved budget',   kind: FIGURE_KIND.MONEY, budget: true },
  { key: 'actual',                 from: 'summary',    reportKey: 'actual',                 label: 'Actual Cost',                 short: 'Actual cost',       kind: FIGURE_KIND.MONEY },
  { key: 'remainingCommitted',     from: 'summary',    reportKey: 'committed',              label: 'Remaining Committed',         short: 'Rem. committed',    kind: FIGURE_KIND.MONEY },
  { key: 'forecastFinalCost',      from: 'summary',    reportKey: 'forecastFinalCost',      label: 'Forecast Final Cost',         short: 'Forecast final cost', kind: FIGURE_KIND.MONEY },
  { key: 'varianceToBudget',       from: 'summary',    reportKey: 'varianceToBudget',       label: 'Variance to Approved Budget', short: 'Variance',          kind: FIGURE_KIND.MONEY, budget: true, signed: true },
  { key: 'forecastGrossProfit',    from: 'summary',    reportKey: 'forecastGrossProfit',    label: 'Forecast Gross Profit',       short: 'Gross profit',      kind: FIGURE_KIND.MONEY, signed: true },
  { key: 'forecastMarginPct',      from: 'summary',    reportKey: 'forecastMarginPct',      label: 'Forecast Margin',             short: 'Margin',            kind: FIGURE_KIND.PERCENT, signed: true },
  { key: 'remainingPayable',       from: 'cash',       reportKey: 'remainingPayable',       label: 'Supplier Invoices Unpaid',    short: 'Payables',          kind: FIGURE_KIND.MONEY },
  { key: 'receivablesOutstanding', from: 'cash',       reportKey: 'receivablesOutstanding', label: 'Client Invoices Outstanding', short: 'Receivables',       kind: FIGURE_KIND.MONEY },
  { key: 'pendingClientVariations', from: 'variations', reportKey: 'pendingClientVariations', label: 'Pending Client Variations',  short: 'Pending client var.', kind: FIGURE_KIND.MONEY, pending: true },
]

export const PORTFOLIO_FIGURE_KEYS = PORTFOLIO_FIGURES.map(f => f.key)

// What each amount is — shown beside the tables and written into the export.
export const PORTFOLIO_FIGURE_NOTES = {
  currentContractSum:      'Original Contract Value + approved client variations',
  approvedBudget:          'The approved budget version (with its approved adjustments). A working budget is not approved and is never shown here',
  actual:                  'Approved claims + posted supplier invoices − posted credit notes',
  remainingCommitted:      'Open commitment on sent/closed POs, net of invoiced and approved-claim amounts — not cost incurred',
  forecastFinalCost:       'Actual + remaining committed + uncommitted cost to complete — a forecast, not an actual',
  varianceToBudget:        'Approved Budget − Forecast Final Cost (negative = over budget)',
  forecastGrossProfit:     'Current Contract Sum − Forecast Final Cost',
  forecastMarginPct:       'Forecast Gross Profit ÷ Current Contract Sum',
  remainingPayable:        'Posted supplier invoices still payable, gross — an invoice balance, not a payment',
  receivablesOutstanding:  'Issued client invoices, less posted credit notes and client retention still held, not yet matched to a receipt, gross — not cash',
  pendingClientVariations: 'Submitted, not approved — NOT included in any contract, revenue or margin figure',
}

function reportFigure(report, spec) {
  const item = (report?.[spec.from] ?? []).find(i => i.key === spec.reportKey)
  const f = item?.figure
  // A figure the report does not carry is a defect, never a zero.
  if (!f) return { state: FIGURE_STATE.UNAVAILABLE, failedSources: [], value: null }
  return { state: f.state, failedSources: f.failedSources ?? [], value: f.state === FIGURE_STATE.READY ? (f.value ?? null) : null }
}

// A figure that can enter a subtotal: READY with a finite number.
export const isValidFigure = (figure) =>
  !!figure && figure.state === FIGURE_STATE.READY && typeof figure.value === 'number' && Number.isFinite(figure.value)

// ── Source states ────────────────────────────────────────────────────────────

// A project whose reads have not returned: every source loading.
export function loadingSourceStates() {
  return Object.fromEntries(REPORT_SOURCES.map(s => [s, { loading: true, error: false }]))
}

// The states buildCommercialReport takes, from a settled one-shot result. The
// `approvedBudget` entry is derived from the resolved budget source with the
// SAME call the Reports tab makes (resolveBudgetSource → budgetSourceState),
// so it folds the working register in and reports an inconsistent approved
// record as failed.
export function portfolioSourceStates({ sources = {}, readStates = {}, currencyCode } = {}) {
  const states = {}
  for (const s of REPORT_SOURCES) {
    if (s === 'approvedBudget') continue
    const r = readStates?.[s]
    // Missing state information is a failure, never success (ADR-42 Decision 5).
    states[s] = r && typeof r.loading === 'boolean' && typeof r.error === 'boolean'
      ? { loading: r.loading, error: r.error }
      : { loading: false, error: true }
  }
  const budgetSource = resolveBudgetSource({
    approvedBudget: sources.approvedBudget ?? null,
    budgetLines: sources.budgetLines ?? [],
    budgetLinesLoading: states.budgetLines.loading,
    budgetLinesError: states.budgetLines.error,
    currencyCode,
  })
  states.approvedBudget = budgetSourceState(budgetSource)
  return states
}

// ── Risk indicators (Constrap PULSE™ — the five FINANCIAL ones) ──────────────
//
// Each reads only records this page already loads. The four programme
// indicators need activities and programme baselines, which the Portfolio page
// does not read, so they are not evaluated here at all — never shown as clear.
export const PORTFOLIO_INDICATORS = [
  INDICATOR.FORECAST_OVER_BUDGET,
  INDICATOR.FORECAST_INCOMPLETE,
  INDICATOR.NEGATIVE_GROSS_PROFIT,
  INDICATOR.PAST_DUE_SUPPLIER_INVOICES,
  INDICATOR.PENDING_VARIATION_EXPOSURE,
]

// Three outcomes that must never be confused, plus loading:
//   FINDING       — the condition is confirmed on complete inputs
//   CLEAR         — evaluated on complete inputs; no finding
//   NOT_EVALUATED — inputs missing, incomplete or failed: NOT a healthy state
export const RISK = {
  FINDING:       'finding',
  CLEAR:         'clear',
  NOT_EVALUATED: 'not_evaluated',
  LOADING:       'loading',
}

export const RISK_LABELS = {
  [RISK.FINDING]:       'Finding',
  [RISK.CLEAR]:         'No finding',
  [RISK.NOT_EVALUATED]: 'Not evaluated',
  [RISK.LOADING]:       'Loading',
}

export function riskOf(pulseState) {
  if (pulseState === PULSE_STATE.FINDING) return RISK.FINDING
  if (pulseState === PULSE_STATE.NO_ISSUE) return RISK.CLEAR
  if (pulseState === PULSE_STATE.LOADING) return RISK.LOADING
  // needs_data, unavailable, and anything unrecognised.
  return RISK.NOT_EVALUATED
}

function portfolioIndicators({ sources, sourceStates, now, currencyCode }) {
  const pulse = evaluatePulse({ sources, sourceStates, now, currencyCode })
  const byId = Object.fromEntries((pulse.indicators ?? []).map(i => [i.id, i]))
  const items = PORTFOLIO_INDICATORS.map(id => {
    const ind = byId[id]
    const risk = riskOf(ind?.state)
    return {
      id,
      title: ind?.title ?? id,
      risk,
      pulseState: ind?.state ?? PULSE_STATE.UNAVAILABLE,
      headline: ind?.headline ?? '',
      failedSources: ind?.failedSources ?? [],
      link: ind?.link ?? null,
    }
  })
  const counts = { [RISK.FINDING]: 0, [RISK.CLEAR]: 0, [RISK.NOT_EVALUATED]: 0, [RISK.LOADING]: 0 }
  for (const i of items) counts[i.risk] += 1
  return { items, counts }
}

// ── Completeness ─────────────────────────────────────────────────────────────

export const COMPLETENESS = {
  LOADING:    'loading',
  COMPLETE:   'complete',
  INCOMPLETE: 'incomplete',
}

// ── One project row ──────────────────────────────────────────────────────────

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

// `result` is one settled hooks/usePortfolioReport.jsx entry
// ({ sources, readStates, loadedAt }) or null while the project is loading.
function buildRow({ project, company, result, now }) {
  const currencyCode = resolveProjectCurrency(project, company)
  const sources = result?.sources ?? {}
  const sourceStates = result
    ? portfolioSourceStates({ sources, readStates: result.readStates, currencyCode })
    : loadingSourceStates()

  // The L2-A report model for this project — the only source of a figure.
  const report = buildCommercialReport({ project, currencyCode, sources, sourceStates })

  const kind = report.budgetSource?.kind ?? BUDGET_SOURCE.UNAVAILABLE
  const working = kind === BUDGET_SOURCE.WORKING

  const figures = {}
  for (const spec of PORTFOLIO_FIGURES) {
    const f = reportFigure(report, spec)
    figures[spec.key] = spec.budget && working && f.state === FIGURE_STATE.READY
      // Never an Approved Budget figure: the working amount is carried apart.
      ? { state: PORTFOLIO_FIGURE_STATE.NOT_APPROVED, failedSources: [], value: null, workingValue: f.value }
      : f
  }

  const loading = report.loading === true
  const failedSources = loading ? [] : (report.failedSources ?? [])
  const completeness = loading
    ? COMPLETENESS.LOADING
    : failedSources.length > 0 ? COMPLETENESS.INCOMPLETE : COMPLETENESS.COMPLETE

  return {
    projectId: project.id,
    projectName: project.name ?? '',
    status: project.status ?? '',
    currencyCode,
    // A legacy project with no stored currency resolves through the company
    // (lib/currency.js). Marked, because that label is inherited, not pinned.
    currencyInherited: !projectHasExplicitCurrency(project),
    budget: {
      kind,
      approved: kind === BUDGET_SOURCE.APPROVED,
      working,
      caption: report.budgetSourceCaption,
      problems: report.budgetSource?.problems ?? [],
    },
    contractNotEstablished: report.contractNotEstablished === true,
    figures,
    indicators: portfolioIndicators({ sources, sourceStates, now, currencyCode }),
    completeness,
    failedSources,
    loadedAt: result?.loadedAt ?? null,
  }
}

// Building a row runs the whole forecast composition, so a settled row is
// remembered against its (immutable) result object: one project settling does
// not rebuild every other row. Purely a cache — same inputs, same row.
const rowCache = new WeakMap()

export function portfolioRow({ project, company = null, result = null, now = new Date() }) {
  if (!result) return buildRow({ project, company, result: null, now })
  const currencyCode = resolveProjectCurrency(project, company)
  const day = dayKey(now)
  const hit = rowCache.get(result)
  if (hit && hit.project === project && hit.currencyCode === currencyCode && hit.day === day) return hit.row
  const row = buildRow({ project, company, result, now })
  rowCache.set(result, { project, currencyCode, day, row })
  return row
}

// ── Subtotals (ONE currency; integer cents; all or nothing) ──────────────────

export const SUBTOTAL_STATE = {
  COMPLETE:       'complete',       // every project has a valid figure — the sum is shown
  LOADING:        'loading',        // some projects are still loading, none invalid
  INCOMPLETE:     'incomplete',     // at least one settled project has no valid figure
  NOT_CALCULABLE: 'not_calculable', // margin only: the contract-sum subtotal is zero or negative
}

const toCents = (n) => Math.round(Number(n) * 100)

export function subtotalFor(rows, key) {
  const total = rows.length
  let cents = 0
  let included = 0
  let loadingCount = 0
  const reasons = {}
  for (const row of rows) {
    const f = row.figures[key]
    if (isValidFigure(f)) {
      cents += toCents(f.value)
      included += 1
      continue
    }
    const state = f?.state ?? FIGURE_STATE.UNAVAILABLE
    if (state === FIGURE_STATE.LOADING) loadingCount += 1
    // A READY figure with no number (it should not happen for money) is unavailable.
    const reason = state === FIGURE_STATE.READY ? FIGURE_STATE.UNAVAILABLE : state
    reasons[reason] = (reasons[reason] || 0) + 1
  }
  const affected = total - included
  if (affected === 0) {
    return { state: SUBTOTAL_STATE.COMPLETE, value: cents / 100, included, total, affected: 0, reasons: {} }
  }
  return {
    state: affected === loadingCount ? SUBTOTAL_STATE.LOADING : SUBTOTAL_STATE.INCOMPLETE,
    value: null, included, total, affected, reasons,
  }
}

// The group margin: aggregate gross profit over aggregate contract sum, through
// the app's one margin formula. Suppressed unless BOTH inputs are complete.
export function marginSubtotal(rows, grossProfit, contractSum) {
  const total = rows.length
  if (grossProfit.state === SUBTOTAL_STATE.COMPLETE && contractSum.state === SUBTOTAL_STATE.COMPLETE) {
    const pct = marginPercent(grossProfit.value, contractSum.value)
    return pct === null
      ? { state: SUBTOTAL_STATE.NOT_CALCULABLE, value: null, included: total, total, affected: 0, reasons: {} }
      : { state: SUBTOTAL_STATE.COMPLETE, value: pct, included: total, total, affected: 0, reasons: {} }
  }
  const affectedRows = rows.filter(r => !isValidFigure(r.figures.forecastGrossProfit) || !isValidFigure(r.figures.currentContractSum))
  const anyIncomplete = grossProfit.state === SUBTOTAL_STATE.INCOMPLETE || contractSum.state === SUBTOTAL_STATE.INCOMPLETE
  return {
    state: anyIncomplete ? SUBTOTAL_STATE.INCOMPLETE : SUBTOTAL_STATE.LOADING,
    value: null,
    included: total - affectedRows.length,
    total,
    affected: affectedRows.length,
    reasons: { ...grossProfit.reasons, ...contractSum.reasons },
  }
}

function groupSubtotals(rows) {
  const subtotals = {}
  for (const spec of PORTFOLIO_FIGURES) {
    if (spec.kind === FIGURE_KIND.PERCENT) continue
    subtotals[spec.key] = subtotalFor(rows, spec.key)
  }
  subtotals.forecastMarginPct = marginSubtotal(rows, subtotals.forecastGrossProfit, subtotals.currentContractSum)
  return subtotals
}

// Why a subtotal is incomplete, in words: "2 not approved, 1 unavailable".
const REASON_WORDS = {
  [FIGURE_STATE.LOADING]:                  'loading',
  [FIGURE_STATE.UNAVAILABLE]:              'unavailable',
  [PORTFOLIO_FIGURE_STATE.NOT_SET]:        'contract value not set',
  [PORTFOLIO_FIGURE_STATE.NOT_APPROVED]:   'budget not approved',
}
export function subtotalReasonText(subtotal) {
  return Object.entries(subtotal?.reasons ?? {})
    .map(([state, n]) => `${n} ${REASON_WORDS[state] ?? 'unavailable'}`)
    .join(', ')
}

// ── The portfolio ────────────────────────────────────────────────────────────
//
// `projects` is the company's project list (hooks/useProjects.jsx, in its
// existing order — no new ordering is invented); `results` maps project id →
// settled one-shot result. A project with no result yet is a LOADING row.
export function buildPortfolioReport({
  projects = [], company = null, results = {}, includeCompleted = false, now = new Date(),
} = {}) {
  const scope = portfolioScope(projects, { includeCompleted })
  const rows = scope.inScope.map(project => portfolioRow({
    project, company, result: results?.[project.id] ?? null, now,
  }))

  // Group by currency code; groups in code order, rows in list order.
  const byCurrency = new Map()
  for (const row of rows) {
    if (!byCurrency.has(row.currencyCode)) byCurrency.set(row.currencyCode, [])
    byCurrency.get(row.currencyCode).push(row)
  }
  const groups = [...byCurrency.keys()].sort().map(currencyCode => {
    const groupRows = byCurrency.get(currencyCode)
    return {
      currencyCode,
      rows: groupRows,
      projectCount: groupRows.length,
      inheritedCount: groupRows.filter(r => r.currencyInherited).length,
      workingBudgetCount: groupRows.filter(r => r.budget.working).length,
      incompleteCount: groupRows.filter(r => r.completeness === COMPLETENESS.INCOMPLETE).length,
      subtotals: groupSubtotals(groupRows),
    }
  })

  const count = (pred) => rows.filter(pred).length
  const loadingCount = count(r => r.completeness === COMPLETENESS.LOADING)
  const incompleteCount = count(r => r.completeness === COMPLETENESS.INCOMPLETE)

  // Non-financial counts — the only thing combined across currencies.
  const indicatorCounts = PORTFOLIO_INDICATORS.map(id => {
    const of = (risk) => count(r => r.indicators.items.find(i => i.id === id)?.risk === risk)
    const sample = rows[0]?.indicators.items.find(i => i.id === id)
    return {
      id,
      title: sample?.title ?? id,
      finding: of(RISK.FINDING),
      clear: of(RISK.CLEAR),
      notEvaluated: of(RISK.NOT_EVALUATED),
      loading: of(RISK.LOADING),
    }
  })

  const loadedTimes = rows.map(r => r.loadedAt).filter(d => d instanceof Date && !Number.isNaN(d.getTime()))
  const loadedFrom = loadedTimes.length ? new Date(Math.min(...loadedTimes.map(d => d.getTime()))) : null
  const loadedTo = loadedTimes.length ? new Date(Math.max(...loadedTimes.map(d => d.getTime()))) : null

  return {
    scope: {
      includeCompleted: scope.includeCompleted,
      projectCount: rows.length,
      totalCount: scope.totalCount,
      completedCount: scope.completedCount,
      excludedCount: scope.excludedCount,
    },
    groups,
    rows,
    currencies: groups.map(g => g.currencyCode),
    counts: {
      projects: rows.length,
      currencies: groups.length,
      loading: loadingCount,
      complete: count(r => r.completeness === COMPLETENESS.COMPLETE),
      incomplete: incompleteCount,
      workingBudget: count(r => r.budget.working),
      contractNotSet: count(r => r.contractNotEstablished),
      inheritedCurrency: count(r => r.currencyInherited),
      withFindings: count(r => r.indicators.counts[RISK.FINDING] > 0),
      status: projectStatusCounts(scope.inScope),
      indicators: indicatorCounts,
    },
    // The page-level claim: never "complete" while anything is loading or failed.
    coverage: loadingCount > 0
      ? COMPLETENESS.LOADING
      : incompleteCount > 0 ? COMPLETENESS.INCOMPLETE : COMPLETENESS.COMPLETE,
    loading: loadingCount > 0,
    loadedFrom,
    loadedTo,
  }
}

// Settled (nothing loading) and non-empty — the only state that may be
// exported or printed.
export const isPortfolioExportable = (portfolio) =>
  !!portfolio && portfolio.loading === false && portfolio.rows.length > 0

// The scope, in words — the page header, the print header and the export.
export function portfolioScopeText(scope) {
  if (!scope) return ''
  const n = scope.projectCount
  const projects = `${n} ${n === 1 ? 'project' : 'projects'}`
  if (scope.includeCompleted) return `All projects, including completed (${projects})`
  return scope.excludedCount > 0
    ? `Open projects (${projects}); ${scope.excludedCount} completed not included`
    : `Open projects (${projects})`
}

export const failedSourcesText = (failedSources) =>
  (failedSources ?? []).map(s => REPORT_SOURCE_LABELS[s] ?? s).join(', ')

// ── Display text (pure — the page and print render exactly this) ─────────────
//
//   loading → "—"   failed → "Unavailable"   genuine zero → the formatted 0
//   contract value missing → "Not set"   working budget → "Not approved"
// `formatMoney` / `formatPercent` are applied to READY numbers only.
export function portfolioFigureText(figure, kind, formatMoney, formatPercent) {
  if (!figure || figure.state === FIGURE_STATE.LOADING) return '—'
  if (figure.state === PORTFOLIO_FIGURE_STATE.NOT_APPROVED) return 'Not approved'
  if (figure.state === PORTFOLIO_FIGURE_STATE.NOT_SET) return 'Not set'
  if (figure.state !== FIGURE_STATE.READY) return 'Unavailable'
  if (typeof figure.value !== 'number' || !Number.isFinite(figure.value)) {
    return kind === FIGURE_KIND.PERCENT ? 'Not calculable' : 'Unavailable'
  }
  return kind === FIGURE_KIND.PERCENT ? formatPercent(figure.value) : formatMoney(figure.value)
}

// A subtotal is a number ONLY when complete; otherwise a word.
export function portfolioSubtotalText(subtotal, kind, formatMoney, formatPercent) {
  if (!subtotal || subtotal.state === SUBTOTAL_STATE.LOADING) return '—'
  if (subtotal.state === SUBTOTAL_STATE.NOT_CALCULABLE) return 'Not calculable'
  if (subtotal.state !== SUBTOTAL_STATE.COMPLETE || typeof subtotal.value !== 'number') return 'Incomplete'
  return kind === FIGURE_KIND.PERCENT ? formatPercent(subtotal.value) : formatMoney(subtotal.value)
}

// The line under an incomplete subtotal: "4 of 6 projects — 2 budget not approved".
export function portfolioSubtotalNote(subtotal) {
  if (!subtotal) return ''
  if (subtotal.state === SUBTOTAL_STATE.COMPLETE) {
    return `All ${subtotal.total} ${subtotal.total === 1 ? 'project' : 'projects'}`
  }
  if (subtotal.state === SUBTOTAL_STATE.NOT_CALCULABLE) return 'Contract sum subtotal is zero or negative'
  if (subtotal.state === SUBTOTAL_STATE.LOADING) return 'Loading'
  return `Not totalled — ${subtotal.affected} of ${subtotal.total} ${subtotal.total === 1 ? 'project' : 'projects'}: ${subtotalReasonText(subtotal)}`
}

// "2 findings · 1 not evaluated · 2 no finding" — counts, never a score.
export function riskSummaryText(counts) {
  if (!counts) return ''
  if (counts[RISK.LOADING] > 0) return 'Loading'
  const parts = []
  const f = counts[RISK.FINDING]
  const n = counts[RISK.NOT_EVALUATED]
  const c = counts[RISK.CLEAR]
  if (f > 0) parts.push(`${f} ${f === 1 ? 'finding' : 'findings'}`)
  if (n > 0) parts.push(`${n} not evaluated`)
  if (c > 0) parts.push(`${c} no finding`)
  return parts.join(' · ')
}
