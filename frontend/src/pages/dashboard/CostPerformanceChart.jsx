import { Link } from 'react-router-dom'
import {
  performanceLayout, displayFigure, COMPOSITION_SEGMENTS, CONTRACT_ROW_STATE,
  FIGURE_STATE, SNAPSHOT_SOURCE_LABELS,
} from '../../lib/projectSnapshot'

// ── Dashboard · Budget, cost & revenue (Dashboard v2, ADR-45) ────────────────
//
// Three horizontal bars on ONE scale — Current Contract Sum, Approved Budget,
// and Forecast Final Cost stacked as Actual · Remaining Committed · Uncommitted
// Cost to Complete — with the Approved Budget drawn as a reference line across
// the cost bar. Plain SVG with percentage geometry from
// lib/projectSnapshot.js → performanceLayout; no chart library, no inline style
// object, no arithmetic here. Every printed amount is a selector value carried
// through the snapshot, formatted by the caller's `money` (the project's own
// currency). Nothing is drawn from a loading or failed cost source.

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

const failedLabel = (failedSources) =>
  (failedSources ?? []).map(s => SNAPSHOT_SOURCE_LABELS[s] ?? s).join(', ')

// One labelled bar row: the label and exact amount above, the bar beneath — a
// shape that reads the same at 375px and at 1440px.
function BarRow({ label, amount, note, children, ariaLabel }) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[12.5px] font-semibold text-brand-text-soft">{label}</span>
        <span className="text-[13px] font-bold tabular-nums text-brand-text">{amount}</span>
      </div>
      {children && (
        <svg className="block h-4 w-full" role="img" aria-label={ariaLabel}>
          <rect x="0" y="0" width="100%" height="100%" rx="4" className="fill-brand-border/60" />
          {children}
        </svg>
      )}
      {note && <p className="m-0 mt-1 text-[11px] text-brand-muted">{note}</p>}
    </div>
  )
}

function ContractRow({ row, layout, money, projectId }) {
  const label = 'Current Contract Sum'
  if (row.state === CONTRACT_ROW_STATE.NOT_ESTABLISHED) {
    return (
      <div>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-[12.5px] font-semibold text-brand-text-soft">{label}</span>
          <span className="text-[12.5px] font-semibold text-brand-muted">Contract value not set</span>
        </div>
        <Link
          to={`/projects/${projectId}/commercial`}
          className="inline-flex min-h-[44px] items-center text-[12px] text-brand-accent hover:underline"
        >
          Set contract value →
        </Link>
      </div>
    )
  }
  if (row.state === CONTRACT_ROW_STATE.UNAVAILABLE) {
    return (
      <BarRow
        label={label}
        amount={<span className="text-brand-amber">Unavailable</span>}
        note={`Could not load: ${failedLabel(row.failedSources)}. The cost bars below do not depend on it.`}
      />
    )
  }
  if (row.state === CONTRACT_ROW_STATE.NOT_DRAWABLE || !layout.contract) {
    return <BarRow label={label} amount={money(row.value)} note="Zero or negative — not drawn to scale." />
  }
  return (
    <BarRow
      label={label}
      amount={money(row.value)}
      note="Current contract value (original contract + approved client variations) — not a time-phased revenue forecast."
      ariaLabel={`Current Contract Sum ${money(row.value)}`}
    >
      <rect x="0" y="0" width={`${layout.contract.widthPct}%`} height="100%" rx="4" className="fill-brand-text-soft" />
    </BarRow>
  )
}

export default function CostPerformanceChart({ snapshot, money, projectId }) {
  const layout = performanceLayout({
    costComposition: snapshot.costComposition,
    currentContractSum: snapshot.currentContractSum,
  })
  const c = snapshot.costComposition

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-[15px] font-bold text-brand-text">Budget, cost &amp; revenue</h3>
        <span className="text-[11px] text-brand-muted">ex-GST · {snapshot.currencyCode} · one scale</span>
      </div>

      {layout.state === FIGURE_STATE.LOADING && (
        <div className="space-y-5" aria-busy="true">
          {['Current Contract Sum', 'Approved Budget', 'Forecast Final Cost'].map(l => (
            <div key={l}>
              <div className="mb-1.5 flex justify-between">
                <span className="text-[12.5px] font-semibold text-brand-text-soft">{l}</span>
                <span className="text-[13px] font-bold text-brand-muted">—</span>
              </div>
              <div className="h-4 w-full rounded bg-brand-border/40" />
            </div>
          ))}
        </div>
      )}

      {layout.state === FIGURE_STATE.UNAVAILABLE && (
        <div className="rounded-lg border border-brand-amber/30 bg-brand-amber/5 p-4">
          <p className="m-0 text-[13px] font-semibold text-brand-amber">Chart unavailable</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            Could not load: {failedLabel(layout.failedSources)}. Nothing is drawn from incomplete cost records.
          </p>
        </div>
      )}

      {layout.state === FIGURE_STATE.READY && (
        <div className="space-y-5">
          <ContractRow row={layout.contractRow} layout={layout} money={money} projectId={projectId} />

          {layout.drawable ? (
            <>
              <BarRow
                label="Approved Budget"
                amount={money(c.approvedBudget)}
                note={layout.budget ? null : 'No approved budget yet.'}
                ariaLabel={`Approved Budget ${money(c.approvedBudget)}`}
              >
                {layout.budget && (
                  <rect x="0" y="0" width={`${layout.budget.widthPct}%`} height="100%" rx="4" className="fill-brand-muted" />
                )}
              </BarRow>

              <BarRow
                label="Forecast Final Cost"
                amount={money(c.forecastFinalCost)}
                ariaLabel={`Forecast Final Cost ${money(c.forecastFinalCost)}: ${layout.segments.map(s => `${s.label} ${money(s.value)}`).join(', ')}${layout.budgetMarkerPct !== null ? `; Approved Budget ${money(c.approvedBudget)} marked` : ''}`}
              >
                {layout.segments.map(s => (
                  s.widthPct > 0 && (
                    <rect key={s.key} x={`${s.offsetPct}%`} y="0" width={`${s.widthPct}%`} height="100%" className={SEGMENT_FILL[s.key]} />
                  )
                ))}
                {layout.budgetMarkerPct !== null && (
                  <line
                    x1={`${layout.budgetMarkerPct}%`} x2={`${layout.budgetMarkerPct}%`} y1="0" y2="100%"
                    strokeWidth="2" className="stroke-brand-text"
                  />
                )}
              </BarRow>
            </>
          ) : (
            <p className="m-0 rounded-lg border border-brand-border bg-brand-bg/40 p-3 text-[12px] text-brand-muted">
              {layout.reason === 'negative'
                ? 'Cost bars not drawn to scale — a cost component or the budget is negative (for example, an over-credited cost code). The exact figures are listed below.'
                : 'No budget, cost or contract value recorded yet.'}
            </p>
          )}

          {/* Exact figures — the accessible equivalent of the bars, and the
              record whenever a bar cannot be drawn honestly. */}
          <ul className="m-0 grid list-none grid-cols-1 gap-x-4 gap-y-1.5 border-t border-brand-border p-0 pt-3 sm:grid-cols-2">
            {COMPOSITION_SEGMENTS.map(s => (
              <li key={s.key} className="flex min-w-0 items-center gap-2 text-[12px] text-brand-text-soft">
                <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${SEGMENT_SWATCH[s.key]}`} aria-hidden="true" />
                <span className="truncate">{s.label}</span>
                <span className="ml-auto font-semibold tabular-nums text-brand-text">{money(c[s.key])}</span>
              </li>
            ))}
            {layout.budgetMarkerPct !== null && layout.drawable && (
              <li className="flex items-center gap-2 text-[12px] text-brand-text-soft">
                <span className="inline-block h-3 w-0.5 shrink-0 bg-brand-text" aria-hidden="true" />
                Approved Budget marker
              </li>
            )}
          </ul>

          <p className="m-0 text-[11.5px] text-brand-muted">
            Forecast Gross Profit (contract sum − forecast final cost):{' '}
            <span className="font-semibold text-brand-text">
              {snapshot.margin.state === FIGURE_STATE.READY
                ? money(snapshot.margin.grossProfit)
                : snapshot.margin.state === FIGURE_STATE.UNAVAILABLE ? 'Unavailable'
                  : snapshot.margin.state === FIGURE_STATE.LOADING ? '—' : 'not set'}
            </span>
            {' · '}Variance to Budget:{' '}
            <span className={`font-semibold ${snapshot.varianceToBudget.state === FIGURE_STATE.READY && snapshot.varianceToBudget.value < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
              {displayFigure(snapshot.varianceToBudget, money)}
            </span>
          </p>
        </div>
      )}
    </div>
  )
}
