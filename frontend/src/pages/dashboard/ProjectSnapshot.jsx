import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import Card from '../../components/Card'
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
  projectSnapshot, displayFigure, compositionLayout, COMPOSITION_SEGMENTS,
  FIGURE_STATE, MARGIN_NOT_ESTABLISHED, SNAPSHOT_SOURCE_LABELS,
} from '../../lib/projectSnapshot'

// ── Dashboard · Project Snapshot ─────────────────────────────────────────────
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

const labelCls = 'text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] m-0 mb-1'

const pct = (n) => (n === null || n === undefined ? '—' : percent(n))

const failedLabel = (failedSources) =>
  failedSources.map(s => SNAPSHOT_SOURCE_LABELS[s] ?? s).join(', ')

function Metric({ label, figure, format, help, danger = false }) {
  const unavailable = figure.state === FIGURE_STATE.UNAVAILABLE
  return (
    <div className="min-w-0">
      <p className={labelCls}>{label}</p>
      <p className={`text-lg font-bold m-0 ${unavailable ? 'text-brand-amber' : danger ? 'text-brand-red' : 'text-brand-text'}`}>
        {displayFigure(figure, format)}
      </p>
      <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">
        {unavailable ? `Could not load: ${failedLabel(figure.failedSources)}` : help}
      </p>
    </div>
  )
}

function MarginMetric({ margin, money, projectId }) {
  if (margin.state === MARGIN_NOT_ESTABLISHED) {
    return (
      <div className="min-w-0">
        <p className={labelCls}>Forecast Gross Profit · Margin</p>
        <p className="text-[13px] font-semibold text-brand-muted m-0 mt-1.5">Contract value not set</p>
        <Link
          to={`/projects/${projectId}/commercial`}
          className="inline-flex items-center min-h-[44px] text-[12px] text-brand-accent hover:underline"
        >
          Set contract value →
        </Link>
      </div>
    )
  }
  const ready = margin.state === FIGURE_STATE.READY
  const unavailable = margin.state === FIGURE_STATE.UNAVAILABLE
  return (
    <div className="min-w-0">
      <p className={labelCls}>Forecast Gross Profit · Margin</p>
      <p className={`text-lg font-bold m-0 ${unavailable ? 'text-brand-amber' : ready && margin.grossProfit < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
        {displayFigure({ state: margin.state, value: margin.grossProfit }, money)}
      </p>
      <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">
        {unavailable
          ? `Could not load: ${failedLabel(margin.failedSources)}`
          : ready
            ? `Forecast Margin ${pct(margin.marginPct)}`
            : 'Forecast Margin —'}
      </p>
    </div>
  )
}

// Fill classes for the three composition segments — existing tokens only.
const SEGMENT_FILL = {
  actual:                    'fill-brand-accent',
  remainingCommitted:        'fill-brand-blue',
  uncommittedCostToComplete: 'fill-brand-purple',
}
const SEGMENT_SWATCH = {
  actual:                    'bg-brand-accent',
  remainingCommitted:        'bg-brand-blue',
  uncommittedCostToComplete: 'bg-brand-purple',
}

// The ONE Dashboard visual. Plain SVG with percentage geometry — no chart
// library, no inline style object. The displayed total is the selector's
// Forecast Final Cost, never the sum of the drawn segments.
function CostComposition({ composition, money }) {
  if (composition.state !== FIGURE_STATE.READY) {
    return (
      <p className="m-0 text-[12px] text-brand-muted">
        {composition.state === FIGURE_STATE.LOADING
          ? 'Cost composition —'
          : `Cost composition unavailable — could not load: ${failedLabel(composition.failedSources)}`}
      </p>
    )
  }

  const layout = compositionLayout(composition)

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <p className={labelCls}>Forecast Final Cost composition</p>
        <p className="m-0 text-[12px] text-brand-text-soft">
          Forecast Final Cost <span className="font-bold text-brand-text">{money(composition.forecastFinalCost)}</span>
          {composition.approvedBudget > 0 && (
            <> · Approved Budget <span className="font-bold text-brand-text">{money(composition.approvedBudget)}</span></>
          )}
        </p>
      </div>

      {layout.drawable ? (
        <svg
          className="block w-full h-7"
          role="img"
          aria-label={`Forecast Final Cost ${money(composition.forecastFinalCost)}: ${layout.segments.map(s => `${s.label} ${money(s.value)}`).join(', ')}${layout.budgetMarkerPct !== null ? `; Approved Budget ${money(composition.approvedBudget)}` : ''}`}
        >
          <rect x="0" y="4" width="100%" height="16" rx="3" className="fill-brand-border" />
          {layout.segments.map(s => (
            s.widthPct > 0 && (
              <rect key={s.key} x={`${s.offsetPct}%`} y="4" width={`${s.widthPct}%`} height="16" className={SEGMENT_FILL[s.key]} />
            )
          ))}
          {layout.budgetMarkerPct !== null && (
            <line
              x1={`${layout.budgetMarkerPct}%`} x2={`${layout.budgetMarkerPct}%`} y1="0" y2="24"
              strokeWidth="2" className="stroke-brand-text"
            />
          )}
        </svg>
      ) : (
        <p className="m-0 text-[12px] text-brand-muted">
          {layout.reason === 'negative'
            ? 'Not drawn to scale — a cost component is negative (for example, an over-credited cost code). Figures below are exact.'
            : 'No forecast cost yet.'}
        </p>
      )}

      <ul className="m-0 mt-2 p-0 list-none flex flex-wrap gap-x-4 gap-y-1">
        {layout.drawable || layout.reason === 'negative'
          ? COMPOSITION_SEGMENTS.map(s => (
              <li key={s.key} className="flex items-center gap-1.5 text-[11.5px] text-brand-text-soft">
                <span className={`inline-block w-2.5 h-2.5 rounded-sm ${SEGMENT_SWATCH[s.key]}`} aria-hidden="true" />
                {s.label} <span className="font-semibold text-brand-text">{money(composition[s.key])}</span>
              </li>
            ))
          : null}
        {layout.budgetMarkerPct !== null && (
          <li className="flex items-center gap-1.5 text-[11.5px] text-brand-text-soft">
            <span className="inline-block w-0.5 h-3 bg-brand-text" aria-hidden="true" />
            Approved Budget marker
          </li>
        )}
      </ul>
    </div>
  )
}

export default function ProjectSnapshot({ project, currencyCode }) {
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
  const varianceNegative = snapshot.varianceToBudget.state === FIGURE_STATE.READY && snapshot.varianceToBudget.value < 0

  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 mb-4">
        <h3 className="text-[15px] font-bold text-brand-text m-0">
          Project Snapshot · {project.name} · {snapshot.currencyCode}
        </h3>
        <Link
          to={`/projects/${projectId}/forecasting`}
          className="inline-flex items-center min-h-[44px] text-[12px] text-brand-accent hover:underline"
        >
          Open Forecast →
        </Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-3.5 gap-y-4">
        <Metric label="Approved Budget"     figure={snapshot.approvedBudget}     format={money} help="Σ budget lines" />
        <Metric label="Actual"              figure={snapshot.actual}             format={money} help="Cost to date" />
        <Metric label="Remaining Committed" figure={snapshot.remainingCommitted} format={money} help="Open PO commitment not yet invoiced" />
        <Metric label="Forecast Final Cost" figure={snapshot.forecastFinalCost}  format={money} help="Estimate at Completion (saved forecast)" />
        <Metric
          label="Variance to Budget"
          figure={snapshot.varianceToBudget}
          format={money}
          help="Approved Budget − Forecast Final Cost"
          danger={varianceNegative}
        />
        <MarginMetric margin={snapshot.margin} money={money} projectId={projectId} />
        <Metric
          label="Remaining Payable"
          figure={snapshot.remainingPayable}
          format={money}
          help="Posted supplier invoices, after posted payments and credit notes · gross"
        />
      </div>

      <div className="mt-5 pt-4 border-t border-brand-border">
        <CostComposition composition={snapshot.costComposition} money={money} />
      </div>

      <p className="m-0 mt-4 text-[11px] text-brand-muted">
        One project, in its own currency ({snapshot.currencyCode}) — Constrapp never converts or sums currencies. Cost and
        margin figures are ex-GST and are the same read-time figures shown on the project&apos;s Forecast and Commercial
        tabs; Remaining Payable is gross, as on Supplier Payments. Unsaved forecast edits are not included.
      </p>
    </Card>
  )
}
