import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import Badge from '../../components/Badge'
import { formatCurrency, percent } from '../../lib/formatters'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import { useVariations } from '../../hooks/useVariations'
import { useForecastLines } from '../../hooks/useForecastLines'
import { useProjectCommercial } from '../../hooks/useProjectCommercial'
import { useSupplierPayments } from '../../hooks/useSupplierPayments'
import { useRetentionReleases } from '../../hooks/useRetentionReleases'
import {
  projectSnapshot, displayFigure, FIGURE_STATE, MARGIN_NOT_ESTABLISHED, SNAPSHOT_SOURCE_LABELS,
} from '../../lib/projectSnapshot'
import KpiCard, { KpiLine } from './KpiCard'
import CostPerformanceChart from './CostPerformanceChart'

// ── Dashboard · Project Snapshot (Dashboard v2 — ADR-42, ADR-45) ─────────────
//
// ⚠️ THE ROLE GATE IS THE PARENT, NOT THIS FILE. Dashboard renders this
// component only for financial roles (lib/margin.js → isFinancialRole), so the
// ten project-scoped subscriptions below are never OPENED for subcontractor or
// client users — not opened and hidden, never opened. Firestore rules remain
// the enforced boundary; this is the UX mirror that keeps a non-financial user
// from issuing reads the rules would deny.
//
// Every figure comes from lib/projectSnapshot.js, which only composes existing
// selectors (projectForecastTotals, computeMargin, payablesSummary). Nothing on
// this page adds, subtracts, or re-derives money. Only data, loading and error
// are taken from the hooks — no write callback is consumed here.
//
// Layout (ADR-45): a hero panel with the four headline KPIs and a strip of the
// remaining established figures (nothing from v1 is dropped), then the Budget,
// cost & revenue chart beside the `aside` slot — the Programme panel, which the
// Dashboard passes in behind its OWN role gate. With no aside the chart spans
// the full width.

const pct = (n) => (n === null || n === undefined ? '—' : percent(n))

const failedLabel = (failedSources) =>
  (failedSources ?? []).map(s => SNAPSHOT_SOURCE_LABELS[s] ?? s).join(', ')

// KPI tone from a figure's availability (and, for a ready figure, whether it is
// a genuine negative).
const toneOf = (figure, negative = false) =>
  figure.state === FIGURE_STATE.UNAVAILABLE ? 'unavailable'
    : figure.state === FIGURE_STATE.READY && negative ? 'danger'
      : 'default'

const unavailableLine = (figure) => (
  <KpiLine tone="warning">Could not load: {failedLabel(figure.failedSources)}</KpiLine>
)

// One compact secondary metric (the v1 Metric, restyled).
function Metric({ label, figure, money, help, danger = false }) {
  const unavailable = figure.state === FIGURE_STATE.UNAVAILABLE
  return (
    <div className="min-w-0">
      <p className="m-0 mb-1 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">{label}</p>
      <p className={`m-0 text-[17px] font-bold tabular-nums ${unavailable ? 'text-brand-amber' : danger ? 'text-brand-red' : 'text-brand-text'}`}>
        {displayFigure(figure, money)}
      </p>
      <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">
        {unavailable ? `Could not load: ${failedLabel(figure.failedSources)}` : help}
      </p>
    </div>
  )
}

function MarginCard({ margin, movement, money, projectId }) {
  const label = 'Forecast Gross Profit'
  if (margin.state === MARGIN_NOT_ESTABLISHED) {
    return (
      <KpiCard label={label} value="Contract value not set" tone="muted">
        <Link
          to={`/projects/${projectId}/commercial`}
          className="inline-flex min-h-[44px] items-center text-[12px] text-brand-accent hover:underline"
        >
          Set contract value →
        </Link>
      </KpiCard>
    )
  }
  const ready = margin.state === FIGURE_STATE.READY
  return (
    <KpiCard
      label={label}
      value={displayFigure({ state: margin.state, value: margin.grossProfit }, money)}
      tone={toneOf(margin, ready && margin.grossProfit < 0)}
    >
      {margin.state === FIGURE_STATE.UNAVAILABLE ? unavailableLine(margin) : (
        <>
          <KpiLine tone="soft">Forecast Margin <span className="font-bold text-brand-text">{ready ? pct(margin.marginPct) : '—'}</span></KpiLine>
          {/* Movement against the ORIGINAL PLAN only — never a month-on-month
              trend (no history is stored). Shown only when its inputs exist. */}
          {movement.state === FIGURE_STATE.LOADING && <KpiLine>Movement vs original plan —</KpiLine>}
          {movement.state === FIGURE_STATE.READY && movement.planned && (
            <KpiLine tone={movement.value < 0 ? 'danger' : 'good'}>
              {movement.value < 0 ? '▼' : '▲'} {money(movement.value)} vs original plan
            </KpiLine>
          )}
          {movement.state === FIGURE_STATE.READY && !movement.planned && (
            <KpiLine>Original budget not set — no movement shown</KpiLine>
          )}
        </>
      )}
    </KpiCard>
  )
}

export default function ProjectSnapshot({ project, currencyCode, aside = null }) {
  const projectId = project.id

  const { budgetLines, budgetLinesLoading, budgetLinesError }                         = useBudgetLines(projectId)
  const { purchaseOrders, purchaseOrdersLoading, purchaseOrdersError }                = usePurchaseOrders(projectId)
  const { progressClaims, progressClaimsLoading, progressClaimsError }                = useProgressClaims(projectId)
  const { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError }          = useSupplierInvoices(projectId)
  const { supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError } = useSupplierCreditNotes(projectId)
  const { variations, variationsLoading, variationsError }                            = useVariations(projectId)
  const { forecastLines, forecastLinesLoading, forecastLinesError }                   = useForecastLines(projectId)
  const { baseline, baselineLoading, baselineError }                                  = useProjectCommercial(projectId)
  const { supplierPayments, supplierPaymentsLoading, supplierPaymentsError }          = useSupplierPayments(projectId)
  const { retentionReleases, retentionReleasesLoading, retentionReleasesError }       = useRetentionReleases(projectId)

  const snapshot = useMemo(() => projectSnapshot({
    currencyCode,
    sources: {
      budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
      variations, forecastLines, baseline, supplierPayments, retentionReleases,
    },
    sourceStates: {
      budgetLines:         { loading: budgetLinesLoading,         error: budgetLinesError },
      purchaseOrders:      { loading: purchaseOrdersLoading,      error: purchaseOrdersError },
      progressClaims:      { loading: progressClaimsLoading,      error: progressClaimsError },
      supplierInvoices:    { loading: supplierInvoicesLoading,    error: supplierInvoicesError },
      supplierCreditNotes: { loading: supplierCreditNotesLoading, error: supplierCreditNotesError },
      variations:          { loading: variationsLoading,          error: variationsError },
      forecastLines:       { loading: forecastLinesLoading,       error: forecastLinesError },
      baseline:            { loading: baselineLoading,            error: baselineError },
      supplierPayments:    { loading: supplierPaymentsLoading,    error: supplierPaymentsError },
      retentionReleases:   { loading: retentionReleasesLoading,   error: retentionReleasesError },
    },
  }), [
    currencyCode,
    budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
    variations, forecastLines, baseline, supplierPayments, retentionReleases,
    budgetLinesLoading, budgetLinesError, purchaseOrdersLoading, purchaseOrdersError,
    progressClaimsLoading, progressClaimsError, supplierInvoicesLoading, supplierInvoicesError,
    supplierCreditNotesLoading, supplierCreditNotesError, variationsLoading, variationsError,
    forecastLinesLoading, forecastLinesError, baselineLoading, baselineError,
    supplierPaymentsLoading, supplierPaymentsError, retentionReleasesLoading, retentionReleasesError,
  ])


  const money = (n) => formatCurrency(n, snapshot.currencyCode)
  const variance = snapshot.varianceToBudget
  const varianceNegative = variance.state === FIGURE_STATE.READY && variance.value < 0

  return (
    <div className="space-y-3.5">
      <div className="relative overflow-hidden rounded-xl border border-brand-border bg-linear-to-br from-brand-surface to-brand-bg p-4 sm:p-5">
        <div className="pointer-events-none absolute -top-24 -right-24 h-56 w-56 rounded-full bg-brand-accent/5" aria-hidden="true" />

        <div className="relative mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="m-0 mb-1 text-[11px] font-bold uppercase tracking-[0.5px] text-brand-accent">Selected project</p>
            <h3 className="m-0 text-[18px] font-bold leading-snug text-brand-text">
              Project Snapshot · {project.name} · {snapshot.currencyCode}
            </h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-brand-muted">
              <Badge label={project.status} sm />
              {project.location && <span>{project.location}</span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4">
            <Link
              to={`/projects/${projectId}/forecasting`}
              className="inline-flex min-h-[44px] items-center text-[12px] text-brand-accent hover:underline"
            >
              Open Forecast →
            </Link>
            <Link
              to={`/projects/${projectId}/commercial`}
              className="inline-flex min-h-[44px] items-center text-[12px] text-brand-accent hover:underline"
            >
              Open Commercial →
            </Link>
          </div>
        </div>

        <div className="relative grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Approved Budget" value={displayFigure(snapshot.approvedBudget, money)} tone={toneOf(snapshot.approvedBudget)}>
            {snapshot.approvedBudget.state === FIGURE_STATE.UNAVAILABLE
              ? unavailableLine(snapshot.approvedBudget)
              : <KpiLine>Σ budget lines · ex-GST</KpiLine>}
          </KpiCard>

          <KpiCard label="Forecast Final Cost" value={displayFigure(snapshot.forecastFinalCost, money)} tone={toneOf(snapshot.forecastFinalCost)}>
            {snapshot.forecastFinalCost.state === FIGURE_STATE.UNAVAILABLE ? unavailableLine(snapshot.forecastFinalCost) : (
              <>
                <KpiLine>Estimate at completion (saved forecast) · ex-GST</KpiLine>
                {variance.state === FIGURE_STATE.READY && (
                  <KpiLine tone={varianceNegative ? 'danger' : 'good'}>
                    {varianceNegative ? 'Over budget' : 'Within budget'} · Variance {money(variance.value)}
                  </KpiLine>
                )}
                {variance.state === FIGURE_STATE.LOADING && <KpiLine>Variance to Budget —</KpiLine>}
                {variance.state === FIGURE_STATE.UNAVAILABLE && unavailableLine(variance)}
              </>
            )}
          </KpiCard>

          <MarginCard margin={snapshot.margin} movement={snapshot.marginMovement} money={money} projectId={projectId} />

          <KpiCard label="Remaining Payable" value={displayFigure(snapshot.remainingPayable, money)} tone={toneOf(snapshot.remainingPayable)}>
            {snapshot.remainingPayable.state === FIGURE_STATE.UNAVAILABLE
              ? unavailableLine(snapshot.remainingPayable)
              : <KpiLine>Posted supplier invoices after payments and credits · <span className="font-semibold text-brand-text-soft">gross</span></KpiLine>}
          </KpiCard>
        </div>

        {/* The remaining established figures — kept visible, not dropped. */}
        <div className="relative mt-4 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-brand-border pt-4 lg:grid-cols-4">
          <Metric label="Actual" figure={snapshot.actual} money={money} help="Cost to date · ex-GST" />
          <Metric label="Remaining Committed" figure={snapshot.remainingCommitted} money={money} help="Open PO commitment not yet invoiced" />
          <Metric label="Uncommitted Cost to Complete" figure={snapshot.uncommittedCostToComplete} money={money} help="Saved forecast inputs" />
          <Metric
            label="Variance to Budget"
            figure={variance}
            money={money}
            help="Approved Budget − Forecast Final Cost"
            danger={varianceNegative}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-3">
        <div className={`min-w-0 rounded-xl border border-brand-border bg-brand-surface p-4 sm:p-5 ${aside ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
          <CostPerformanceChart snapshot={snapshot} money={money} projectId={projectId} />
        </div>
        {aside}
      </div>

      <p className="m-0 text-[11px] text-brand-muted">
        One project, in its own currency ({snapshot.currencyCode}) — Constrapp never converts or sums currencies. Cost and
        margin figures are ex-GST and are the same read-time figures shown on the project&apos;s Forecast and Commercial
        tabs; Remaining Payable is gross, as on Supplier Payments. Unsaved forecast edits are not included.
      </p>
    </div>
  )
}
