import { projectForecastTotals, computeMargin, isBaselineEstablished } from './margin'
import { payablesSummary } from './supplierPayments'
import { releasedByInvoiceId } from './retention'

// ── Dashboard Project Snapshot (read-time; COMPOSITION ONLY) ─────────────────
//
// The Dashboard's financial panel for ONE selected project. This module is NOT
// a financial engine and must never become one: every money figure below is
// the output of an existing domain selector, carried through unchanged —
//
//   Approved Budget, Actual, Remaining Committed, Forecast Final Cost,
//   Variance to Budget, Uncommitted Cost to Complete
//                         → lib/margin.js  projectForecastTotals (forecastRollups)
//   Forecast Gross Profit, Forecast Margin %
//                         → lib/margin.js  computeMargin
//   Remaining Payable     → lib/supplierPayments.js  payablesSummary, with the
//                           released-retention map from lib/retention.js
//                           releasedByInvoiceId (the Supplier Payments page's
//                           exact composition)
//
// What this module adds is AVAILABILITY: which sources each figure depends on,
// and whether those sources are loading, failed, or settled. Loading renders
// "—", a failed source renders "Unavailable", and only a settled figure renders
// its value — so a genuine zero is a zero and a missing read never is (ADR-24,
// ADR-41). A figure that is not READY carries `value: null`, so a caller cannot
// accidentally print an unsettled number.
//
// There is deliberately no portfolio function here. Money from different
// projects may be in different currencies and Constrapp never converts, so a
// snapshot is always ONE project in ONE currency.

// ── Domain-neutral availability ──────────────────────────────────────────────

export const FIGURE_STATE = {
  LOADING:     'loading',
  UNAVAILABLE: 'unavailable',
  READY:       'ready',
}

// The combined state of a figure from the states of the sources it depends on.
// `sourceStates` is { [sourceName]: { loading: boolean, error: boolean } }.
//
//   any dependency failed            → UNAVAILABLE (and names the failures)
//   otherwise any dependency loading → LOADING
//   otherwise                        → READY
//
// A dependency with NO state entry, or one whose flags are not booleans, is
// treated as FAILED: missing error information is never assumed to be success.
// A failure outranks loading — a figure that is already known to be wrong must
// not wait for its other sources before saying so.
export function figureState(dependencies, sourceStates) {
  const failed = []
  let loading = false
  for (const dep of dependencies ?? []) {
    const s = sourceStates?.[dep]
    if (!s || typeof s.loading !== 'boolean' || typeof s.error !== 'boolean' || s.error) {
      failed.push(dep)
      continue
    }
    if (s.loading) loading = true
  }
  if (failed.length > 0) return { state: FIGURE_STATE.UNAVAILABLE, failedSources: failed }
  if (loading) return { state: FIGURE_STATE.LOADING, failedSources: [] }
  return { state: FIGURE_STATE.READY, failedSources: [] }
}

// The text a figure renders as. `format` is applied to READY values only.
export function displayFigure(figure, format) {
  if (!figure || figure.state === FIGURE_STATE.LOADING) return '—'
  if (figure.state !== FIGURE_STATE.READY) return 'Unavailable'
  return format(figure.value)
}

// ── Snapshot sources and dependencies ────────────────────────────────────────

// Every subscription the snapshot reads. Cost codes are deliberately absent:
// in buildForecastRows they supply display NAMES only and change no amount, so
// the snapshot does not subscribe to them.
export const SNAPSHOT_SOURCES = [
  'budgetLines', 'purchaseOrders', 'progressClaims', 'supplierInvoices',
  'supplierCreditNotes', 'variations', 'forecastLines', 'baseline',
  'supplierPayments', 'retentionReleases',
]

export const SNAPSHOT_SOURCE_LABELS = {
  budgetLines:         'Budget Lines',
  purchaseOrders:      'Purchase Orders',
  progressClaims:      'Progress Claims',
  supplierInvoices:    'Supplier Invoices',
  supplierCreditNotes: 'Supplier Credit Notes',
  variations:          'Variations',
  forecastLines:       'Forecast Lines',
  baseline:            'Commercial Baseline',
  supplierPayments:    'Supplier Payments',
  retentionReleases:   'Retention Releases',
}

// The sources each selector output actually reads (traced through
// buildForecastRows / computeMargin / payablesSummary):
//   · Actual        — claims (certified, not superseded), posted invoices,
//                     posted valid-target credit notes
//   · Rem. Committed — sent/closed PO lines matured by posted invoice lines
//                     (credits deliberately do not restore it — ADR-31)
//   · Uncommitted CTC — saved forecast lines
//   · Variations feed only supplier-variation EXPOSURE on the cost side, which
//     is never in Forecast Final Cost; they feed margin through approved client
//     variations (Current Contract Sum).
const FFC_SOURCES = [
  'purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'forecastLines',
]

// Every source buildForecastRows reads to decide WHICH cost codes exist (the
// row union) — so the Forecast table, its per-row figures and the
// unforecasted / line counts depend on all of them. Cost codes are absent for
// the same reason as above: they supply names, never a row or an amount.
export const FORECAST_ROW_SOURCES = [
  'budgetLines', 'purchaseOrders', 'progressClaims', 'supplierInvoices',
  'supplierCreditNotes', 'variations', 'forecastLines',
]

export const FIGURE_DEPENDENCIES = {
  approvedBudget:     ['budgetLines'],
  actual:             ['progressClaims', 'supplierInvoices', 'supplierCreditNotes'],
  remainingCommitted: ['purchaseOrders', 'supplierInvoices'],
  forecastFinalCost:  FFC_SOURCES,
  varianceToBudget:   ['budgetLines', ...FFC_SOURCES],
  margin:             ['baseline', 'variations', ...FFC_SOURCES],
  remainingPayable:   ['supplierInvoices', 'supplierPayments', 'supplierCreditNotes', 'retentionReleases'],
  costComposition:    ['budgetLines', ...FFC_SOURCES],
  // ── Project tabs (Forecast, Commercial, Overview — ADR-44) ──
  // Traced through forecastRollups / computeMargin exactly as above:
  //   · supplier variation exposure — approved/pending supplier variations only
  //     (never in FFC)
  //   · forecast rows — the cost-code union; see FORECAST_ROW_SOURCES
  //   · contract baseline — Original Contract Value, Original Approved Budget,
  //     Original Planned Profit / Margin % read the stored baseline only
  //   · client variations — approved / pending client variation totals
  //   · Current Contract Sum (= Forecast Revenue) — baseline + approved client
  //     variations
  //   · Margin Movement — Forecast Gross Profit − Original Planned Profit
  supplierVariationExposure: ['variations'],
  forecastRows:              FORECAST_ROW_SOURCES,
  contractBaseline:          ['baseline'],
  clientVariations:          ['variations'],
  currentContractSum:        ['baseline', 'variations'],
  marginMovement:            ['baseline', 'variations', ...FFC_SOURCES],
}

// The margin figure has one extra, figure-specific state: the commercial
// baseline has settled but no Original Contract Value is set. That is neither
// loading nor a failure nor zero — it is "not established", rendered as a
// prompt to set the contract value.
export const MARGIN_NOT_ESTABLISHED = 'not_established'

// One figure: its availability from FIGURE_DEPENDENCIES[key], and its value
// ONLY when ready — so a caller cannot print an unsettled number. Exported for
// the project tabs, which compose the same selectors as the snapshot.
export const availableFigure = (key, value, sourceStates) => {
  const s = figureState(FIGURE_DEPENDENCIES[key], sourceStates)
  return { ...s, value: s.state === FIGURE_STATE.READY ? value : null }
}
const figure = availableFigure

// ── The snapshot ─────────────────────────────────────────────────────────────
//
// `sources` holds the live arrays (and the baseline document, or null) from the
// project-scoped hooks; `sourceStates` holds their loading/error flags; and
// `currencyCode` is the project's RESOLVED currency (lib/currency.js →
// resolveProjectCurrency). Every money value is in that one currency.
export function projectSnapshot({ sources = {}, sourceStates = {}, currencyCode }) {
  const {
    budgetLines = [], purchaseOrders = [], progressClaims = [], supplierInvoices = [],
    supplierCreditNotes = [], variations = [], forecastLines = [], baseline = null,
    supplierPayments = [], retentionReleases = [],
  } = sources

  const totals = projectForecastTotals({
    budgetLines, purchaseOrders, progressClaims, supplierInvoices,
    supplierCreditNotes, variations, forecastLines,
  })
  const m = computeMargin({ baseline, variations, forecastFinalCost: totals.forecastFinalCost })
  const payables = payablesSummary(
    supplierInvoices, supplierPayments, supplierCreditNotes, releasedByInvoiceId(retentionReleases),
  )

  // Margin: "not established" only once the baseline itself has settled
  // cleanly — a loading or failed baseline is reported as exactly that.
  const marginState = figureState(FIGURE_DEPENDENCIES.margin, sourceStates)
  const baselineSettled = sourceStates?.baseline?.loading === false && sourceStates?.baseline?.error === false
  const notEstablished = baselineSettled && !isBaselineEstablished(baseline)
  const marginReady = !notEstablished && marginState.state === FIGURE_STATE.READY

  const composition = figureState(FIGURE_DEPENDENCIES.costComposition, sourceStates)
  const compositionReady = composition.state === FIGURE_STATE.READY

  return {
    currencyCode,
    approvedBudget:     figure('approvedBudget', totals.budgeted, sourceStates),
    actual:             figure('actual', totals.actual, sourceStates),
    remainingCommitted: figure('remainingCommitted', totals.remainingCommitted, sourceStates),
    forecastFinalCost:  figure('forecastFinalCost', totals.forecastFinalCost, sourceStates),
    varianceToBudget:   figure('varianceToBudget', totals.varianceToBudget, sourceStates),
    margin: {
      ...marginState,
      state:          notEstablished ? MARGIN_NOT_ESTABLISHED : marginState.state,
      failedSources:  notEstablished ? [] : marginState.failedSources,
      grossProfit:    marginReady ? m.forecastGrossProfit : null,
      marginPct:      marginReady ? m.forecastMarginPct : null,
    },
    remainingPayable:   figure('remainingPayable', payables.remaining, sourceStates),
    costComposition: {
      ...composition,
      actual:                    compositionReady ? totals.actual : null,
      remainingCommitted:        compositionReady ? totals.remainingCommitted : null,
      uncommittedCostToComplete: compositionReady ? totals.uncommittedCostToComplete : null,
      forecastFinalCost:         compositionReady ? totals.forecastFinalCost : null,
      approvedBudget:            compositionReady ? totals.budgeted : null,
    },
  }
}

// ── Cost-composition geometry (presentation only) ────────────────────────────
//
// Positions for the single Dashboard bar. This is LAYOUT, not finance: it
// computes no money figure. The bar's scale is the larger of Forecast Final
// Cost and Approved Budget, both taken as given; segment widths are each
// selector value's share of that scale; the authoritative total that is
// DISPLAYED is always `forecastFinalCost` from the selector — never the sum of
// the segments (per-row rounding means the two may differ by a cent).
//
// Not drawable (the caller shows the figures as a list instead):
//   · 'negative'        — any component is negative (e.g. an over-credited cost
//                         code). A negative bar segment cannot be drawn honestly.
//   · 'no_forecast_cost' — Forecast Final Cost is zero or negative.
const toCents = (n) => Math.round((Number(n) || 0) * 100)

export const COMPOSITION_SEGMENTS = [
  { key: 'actual',                    label: 'Actual' },
  { key: 'remainingCommitted',        label: 'Remaining Committed' },
  { key: 'uncommittedCostToComplete', label: 'Uncommitted Cost to Complete' },
]

export function compositionLayout(c) {
  if (!c) return { drawable: false, reason: 'no_forecast_cost', segments: [], budgetMarkerPct: null }
  if (COMPOSITION_SEGMENTS.some(({ key }) => toCents(c[key]) < 0)) {
    return { drawable: false, reason: 'negative', segments: [], budgetMarkerPct: null }
  }
  if (toCents(c.forecastFinalCost) <= 0) {
    return { drawable: false, reason: 'no_forecast_cost', segments: [], budgetMarkerPct: null }
  }
  const ffc = Number(c.forecastFinalCost)
  const budget = toCents(c.approvedBudget) > 0 ? Number(c.approvedBudget) : null
  const scale = budget !== null && budget > ffc ? budget : ffc

  let offset = 0
  const segments = COMPOSITION_SEGMENTS.map(({ key, label }) => {
    const raw = (Number(c[key]) || 0) / scale * 100
    // Clamp so cent-level rounding can never push the bar past 100%.
    const widthPct = Math.max(0, Math.min(raw, 100 - offset))
    const seg = { key, label, value: c[key], offsetPct: offset, widthPct }
    offset += widthPct
    return seg
  })

  return {
    drawable: true,
    reason: null,
    segments,
    budgetMarkerPct: budget === null ? null : Math.min(100, budget / scale * 100),
  }
}

// ── Project selection (URL `?project=<id>`) ──────────────────────────────────
//
// The requested project when it exists in this company's project list;
// otherwise the first 'In Progress' project in the list's EXISTING order (the
// useProjects subscription order — no new ordering is invented here);
// otherwise the first project; otherwise none.
export function selectSnapshotProjectId(projects, requestedId) {
  if (!Array.isArray(projects) || projects.length === 0) return null
  if (requestedId && projects.some(p => p.id === requestedId)) return requestedId
  const inProgress = projects.find(p => p.status === 'In Progress')
  return (inProgress ?? projects[0]).id
}
