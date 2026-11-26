import { formatCurrency } from '../../../lib/formatters'
import { figureText, figurePresentation, FIGURE_VIEW, NOT_RECORDED_NOTE } from '../../../lib/finalAccountDisplay'
import {
  FINAL_ACCOUNT_FIGURES, FIGURE_GROUP, FIGURE_GROUP_LABELS, figureRecorded,
} from '../../../lib/finalAccount'

// ── Final Account figures and cost-code rows (presentation only) ─────────────
//
// Renders ONE figure set — a stored revision's frozen `figures` / `rows`, or
// the live proposal from lib/finalAccount.js — and nothing else. It formats;
// it never adds, subtracts or re-derives an amount. A missing figure is
// "Unavailable" (never a zero), a figure that cannot be calculated is "Not
// calculable", and a genuine zero is a formatted zero. Ex-GST and gross
// figures sit in separate, labelled groups and are never totalled together.
// A figure a stored revision does not carry (it was introduced after the
// revision was written) is "Not recorded" — not Unavailable, not an
// outstanding balance, and never filled from live records.
//
// `differences` (optional) is finalAccountDifferences output: figures and
// rows that differ from a comparison set are marked and the other value shown.

const GROUP_ORDER = [FIGURE_GROUP.CONTRACT, FIGURE_GROUP.COST, FIGURE_GROUP.RESULT, FIGURE_GROUP.BALANCES]

const thCls = 'px-3 py-2.5 text-right text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'
const tdCls = 'px-3 py-2.5 text-right text-[12.5px] text-brand-text tabular-nums whitespace-nowrap'

// `view` decides the WORDING only (lib/finalAccountDisplay.js): a stored
// revision keeps the finalised labels; the live position is labelled as a
// forecast and never as "final".
export function FinalAccountFigures({ figures, currencyCode, differences = null, comparisonLabel = 'Current records', pending = false, idPrefix = 'fa', view = FIGURE_VIEW.REVISION }) {
  const changed = new Map((differences?.figures ?? []).map(d => [d.key, d]))
  return (
    <div className="flex flex-col gap-5">
      {GROUP_ORDER.map(group => {
        const items = FINAL_ACCOUNT_FIGURES.filter(f => f.group === group)
        const headingId = `${idPrefix}-${group}`
        return (
          <section key={group} aria-labelledby={headingId} className="report-section">
            <h3 id={headingId} className="text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted m-0 mb-3">
              {FIGURE_GROUP_LABELS[group]}
            </h3>
            <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              {items.map(def => {
                const value = figures?.[def.key]
                const unrecorded = !pending && Boolean(figures) && !figureRecorded(figures, def.key)
                const missing = !pending && !unrecorded && (value === null || value === undefined) && !def.nullable
                const negative = typeof value === 'number' && value < 0
                const diff = changed.get(def.key)
                const text = figurePresentation(def, view)
                return (
                  <div key={def.key} className="report-figure min-w-0 border-b border-brand-border pb-2">
                    <dt className="text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted">
                      {text.label}
                      {def.open && !unrecorded && <span className="ml-2 normal-case tracking-normal font-semibold text-brand-amber">Outstanding balance</span>}
                    </dt>
                    <dd className={`m-0 mt-0.5 text-[17px] font-bold tabular-nums ${unrecorded ? 'text-brand-muted' : missing ? 'text-brand-amber' : negative ? 'text-brand-red' : 'text-brand-text'}`}>
                      {figureText(value, def.basis, currencyCode, { nullable: def.nullable, pending, unrecorded })}
                    </dd>
                    {diff && (
                      <dd className="m-0 mt-0.5 text-[12px] font-semibold text-brand-amber">
                        {comparisonLabel}: {figureText(diff.live, def.basis, currencyCode, { nullable: def.nullable })}
                      </dd>
                    )}
                    <dd className="m-0 mt-0.5 text-[11px] text-brand-muted">{unrecorded ? NOT_RECORDED_NOTE : text.note}</dd>
                  </div>
                )
              })}
            </dl>
          </section>
        )
      })}
    </div>
  )
}

export function FinalAccountRows({ rows, currencyCode, differences = null, pending = false }) {
  const fmt = (n) => formatCurrency(n, currencyCode, { precise: true })
  const changed = new Set((differences?.rows ?? []).map(r => r.costCodeId))
  if (pending) return <p className="text-[13px] text-brand-muted m-0">Loading cost codes…</p>
  if (!rows || rows.length === 0) {
    return <p className="text-[13px] text-brand-muted m-0">No cost code carries a budget or a cost on this project.</p>
  }
  const cell = (v) => (v === null || v === undefined ? <span className="text-brand-muted">No budget line</span> : fmt(v))
  return (
    <div className="overflow-x-auto report-table-wrap">
      <table className="w-full border-collapse report-table">
        <caption className="sr-only">
          Cost-code breakdown in {currencyCode}, ex-GST. Variance is approved budget minus actual cost; negative means over budget.
        </caption>
        <thead>
          <tr className="border-b border-brand-border">
            <th scope="col" className={`${thCls} text-left`}>Cost code</th>
            <th scope="col" className={thCls}>Approved budget</th>
            <th scope="col" className={thCls}>Actual cost</th>
            <th scope="col" className={thCls}>Variance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.costCodeId} className="border-b border-brand-border/60">
              <th scope="row" className={`${tdCls} text-left font-semibold whitespace-normal min-w-[180px]`}>
                {row.costCodeName}
                {changed.has(row.costCodeId) && <span className="block text-[10.5px] font-semibold text-brand-amber">Differs from current records</span>}
              </th>
              <td className={tdCls}>{cell(row.approvedBudget)}</td>
              <td className={tdCls}>{fmt(row.actualCost)}</td>
              <td className={`${tdCls} ${typeof row.variance === 'number' && row.variance < 0 ? 'text-brand-red font-semibold' : ''}`}>{cell(row.variance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
