import { useState } from 'react'
import { Link } from 'react-router-dom'
import Card from '../../../components/Card'
import Badge from '../../../components/Badge'
import { formatCurrency, percent } from '../../../lib/formatters'
import { formatIsoDate } from '../../../lib/projectTimeline'
import { PULSE_STATE, PULSE_SOURCE_LABELS, COLUMN, INDICATOR } from '../../../lib/pulse'

// ── PULSE · one indicator card (ADR-47) ──────────────────────────────────────
//
// PRESENTATION ONLY. Everything shown here — state, headline, explanation,
// values, evidence rows and caveats — is the lib/pulse.js evaluation carried
// through unchanged. This file formats; it never compares, sums or decides.
// Money is formatted with the project's resolved currency, dates with the
// Timeline's date-only formatter, and a loading figure is "—".

const STATE_BADGE = {
  [PULSE_STATE.FINDING]:     { label: 'Finding',        variant: 'danger' },
  [PULSE_STATE.NEEDS_DATA]:  { label: 'Needs data',     variant: 'info' },
  [PULSE_STATE.UNAVAILABLE]: { label: 'Unavailable',    variant: 'pending' },
  [PULSE_STATE.NO_ISSUE]:    { label: 'No issue found', variant: 'active' },
  [PULSE_STATE.LOADING]:     { label: 'Loading',        variant: 'soon' },
}

// The key figures each indicator shows above its evidence — selector outputs
// named by the engine; the list only decides which to print and how.
const VALUE_ROWS = {
  [INDICATOR.FORECAST_OVER_BUDGET]: [
    { key: 'approvedBudget',    label: 'Approved Budget',     kind: COLUMN.MONEY },
    { key: 'forecastFinalCost', label: 'Forecast Final Cost', kind: COLUMN.MONEY },
    { key: 'varianceToBudget',  label: 'Variance to Budget',  kind: COLUMN.MONEY, dangerWhenNegative: true },
    { key: 'overBudgetCount',   label: 'Cost codes over their budget', kind: COLUMN.INT },
  ],
  [INDICATOR.FORECAST_INCOMPLETE]: [
    { key: 'unforecastedCount', label: 'Not forecast', kind: COLUMN.INT },
    { key: 'lineCount',         label: 'Cost codes',   kind: COLUMN.INT },
  ],
  [INDICATOR.NEGATIVE_GROSS_PROFIT]: [
    { key: 'currentContractSum',  label: 'Current Contract Sum',  kind: COLUMN.MONEY },
    { key: 'forecastFinalCost',   label: 'Forecast Final Cost',   kind: COLUMN.MONEY },
    { key: 'forecastGrossProfit', label: 'Forecast Gross Profit', kind: COLUMN.MONEY, dangerWhenNegative: true },
    { key: 'forecastMarginPct',   label: 'Forecast Margin',       kind: 'percent' },
  ],
  [INDICATOR.OVERDUE_ACTIVITIES]: [
    { key: 'overdue', label: 'Overdue',         kind: COLUMN.INT },
    { key: 'open',    label: 'Open activities', kind: COLUMN.INT },
    { key: 'total',   label: 'Total',           kind: COLUMN.INT },
  ],
  [INDICATOR.PAST_DUE_SUPPLIER_INVOICES]: [
    { key: 'pastDueCount',        label: 'Invoices past due',       kind: COLUMN.INT },
    { key: 'pastDueTotal',        label: 'Past due (gross)',        kind: COLUMN.MONEY },
    { key: 'remainingPayable',    label: 'Remaining payable (gross)', kind: COLUMN.MONEY },
    { key: 'unallocatedPayments', label: 'Unallocated payments',    kind: COLUMN.MONEY },
  ],
  [INDICATOR.PENDING_VARIATION_EXPOSURE]: [
    { key: 'supplier.exposure',  label: 'Pending supplier exposure (ex-GST)', kind: COLUMN.MONEY },
    { key: 'supplier.submitted', label: '· of which submitted',               kind: COLUMN.MONEY },
    { key: 'client.exposure',    label: 'Pending client exposure (ex-GST)',   kind: COLUMN.MONEY },
    { key: 'client.submitted',   label: '· of which submitted',               kind: COLUMN.MONEY },
  ],
}

const EVIDENCE_PREVIEW = 5

// Dotted-path lookup into `indicator.values` (e.g. 'supplier.exposure').
function pick(obj, path) {
  let cur = obj
  for (const k of path.split('.')) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

function formatValue(value, kind, currencyCode) {
  if (value === null || value === undefined || value === '') return '—'
  switch (kind) {
    case COLUMN.MONEY: return formatCurrency(value, currencyCode)
    case COLUMN.DATE:  return formatIsoDate(value)
    case COLUMN.DAYS:  return value === 1 ? '1 day' : `${value} days`
    case COLUMN.INT:   return String(value)
    case 'percent':    return percent(value)
    default:           return String(value)
  }
}

const failedLabel = (failedSources) =>
  (failedSources ?? []).map(s => PULSE_SOURCE_LABELS[s] ?? s).join(', ')

function Values({ indicator, currencyCode }) {
  const rows = VALUE_ROWS[indicator.id] ?? []
  const shown = rows.filter(r => pick(indicator.values, r.key) !== undefined)
  if (shown.length === 0) return null
  return (
    <dl className="m-0 mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
      {shown.map(r => {
        const v = pick(indicator.values, r.key)
        const danger = r.dangerWhenNegative && typeof v === 'number' && v < 0
        return (
          <div key={r.key} className="min-w-0">
            <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">{r.label}</dt>
            <dd className={`m-0 mt-0.5 text-[15px] font-bold tabular-nums ${danger ? 'text-brand-red' : 'text-brand-text'}`}>
              {formatValue(v, r.kind, currencyCode)}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

function Evidence({ indicator, currencyCode }) {
  const [showAll, setShowAll] = useState(false)
  const rows = indicator.evidence ?? []
  const cols = indicator.evidenceColumns ?? []
  if (rows.length === 0 || cols.length === 0) return null
  const visible = showAll ? rows : rows.slice(0, EVIDENCE_PREVIEW)

  return (
    <div className="mt-3">
      <p className="m-0 mb-1.5 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted">
        Source records · {rows.length}
      </p>
      {/* The scroller wraps the table so the Card's overflow-hidden clips
          nothing at a narrow width (betaSurfaces convention). */}
      <div className="overflow-x-auto rounded-lg border border-brand-border">
        <table className="w-full min-w-[560px] border-collapse">
          <thead>
            <tr className="bg-brand-bg/60">
              {cols.map(c => (
                <th key={c.key} className={`px-3 py-2 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted whitespace-nowrap ${c.kind === COLUMN.MONEY || c.kind === COLUMN.DAYS || c.kind === COLUMN.INT ? 'text-right' : 'text-left'}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={row.id ?? row.costCodeId ?? i} className="border-t border-brand-border">
                {cols.map(c => {
                  const v = row[c.key]
                  const numeric = c.kind === COLUMN.MONEY || c.kind === COLUMN.DAYS || c.kind === COLUMN.INT
                  const danger = c.kind === COLUMN.MONEY && typeof v === 'number' && v < 0 && c.key === 'varianceToBudget'
                  return (
                    <td key={c.key} className={`px-3 py-2 text-[12.5px] whitespace-nowrap ${numeric ? 'text-right tabular-nums' : 'text-left'} ${danger ? 'text-brand-red' : 'text-brand-text'}`}>
                      {formatValue(v, c.kind, currencyCode)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > EVIDENCE_PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll(s => !s)}
          className="mt-1 inline-flex min-h-[44px] items-center text-[12px] font-semibold text-brand-accent hover:underline"
        >
          {showAll ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  )
}

export default function IndicatorCard({ indicator, projectId, currencyCode }) {
  const badge = STATE_BADGE[indicator.state] ?? STATE_BADGE[PULSE_STATE.LOADING]
  const unavailable = indicator.state === PULSE_STATE.UNAVAILABLE
  const loading = indicator.state === PULSE_STATE.LOADING
  const unbudgeted = indicator.values?.unbudgetedRows ?? []

  return (
    <Card className="mb-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-[14px] font-bold text-brand-text">{indicator.title}</h3>
            <Badge label={badge.label} variant={badge.variant} sm />
          </div>
          {loading && <p className="m-0 mt-1 text-[12.5px] text-brand-muted">Waiting for records…</p>}
          {unavailable && (
            <p className="m-0 mt-1 text-[12.5px] text-brand-amber">
              Could not load: {failedLabel(indicator.failedSources)}. This indicator was not assessed.
            </p>
          )}
          {!loading && !unavailable && (
            <>
              <p className="m-0 mt-1 text-[13px] font-semibold text-brand-text">{indicator.headline}</p>
              {indicator.explanation && (
                <p className="m-0 mt-1 text-[12px] text-brand-text-soft">{indicator.explanation}</p>
              )}
            </>
          )}
        </div>
        <Link
          to={`/projects/${projectId}/${indicator.link.to}`}
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg border border-brand-border px-3 text-[12px] font-semibold text-brand-accent hover:bg-brand-card"
        >
          {indicator.link.label} →
        </Link>
      </div>

      {!loading && !unavailable && (
        <>
          <Values indicator={indicator} currencyCode={currencyCode} />
          <Evidence indicator={indicator} currencyCode={currencyCode} />
          {unbudgeted.length > 0 && (
            <p className="m-0 mt-2 text-[11.5px] text-brand-text-soft">
              {unbudgeted.length} cost {unbudgeted.length === 1 ? 'code carries' : 'codes carry'} forecast cost with no
              budget line ({unbudgeted.map(r => r.costCodeName).slice(0, 3).join(', ')}{unbudgeted.length > 3 ? ', …' : ''}) —
              never counted as over budget.
            </p>
          )}
          {(indicator.caveats ?? []).length > 0 && (
            <ul className="m-0 mt-3 list-disc space-y-1 pl-4">
              {indicator.caveats.map((c, i) => (
                <li key={i} className="text-[11.5px] text-brand-muted">{c}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}
