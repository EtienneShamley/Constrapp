import { useId, useMemo } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip,
  ReferenceLine, ReferenceArea, ReferenceDot, ResponsiveContainer,
} from 'recharts'
import Card from '../../../components/Card'
import { formatCurrency } from '../../../lib/formatters'
import { monthLabel } from '../../../lib/cashFlow'
import {
  toChartRows, chartBoundary, peakMarker, chartMinWidth, chartSummary,
} from '../../../lib/cashFlowChart'

// ── Cash Flow chart (actual + forecast) ──────────────────────────────────────
//
// Presentation only. Every figure arrives pre-derived from lib/cashFlow.js via
// ProjectCashFlow.jsx; every display decision (sign flip, unavailability
// nulling, boundary location, peak-marker eligibility, the summary sentence)
// comes from lib/cashFlowChart.js, where it is unit-tested. This file contains
// no arithmetic — it is Recharts markup.
//
// TWO PANELS, ONE X DOMAIN — never a dual-axis chart (ADR-26). Monthly flow and
// cumulative position differ in magnitude, and a second Y scale would invite
// readers to infer crossings that are artefacts of independent scaling.
//
//   Panel A — monthly movement: diverging stacked bars. Cash In above zero,
//             Cash Out below (negated for plotting ONLY — never shown negative).
//             Hue = direction, texture = actual vs forecast.
//   Panel B — cumulative position: one line from a ZERO opening position, an
//             emphatic zero reference line, and the sub-zero region shaded.
//
// The chart is the overview; CombinedMonthlyTable directly below remains the
// exact numeric record and the accessible equivalent.

// Both panels MUST use identical margins and an identical YAxis width, or their
// plot areas drift apart and the shared boundary line stops lining up.
const CHART_MARGIN = { top: 8, right: 12, left: 0, bottom: 0 }
const Y_AXIS_WIDTH = 86
const PANEL_A_HEIGHT = 210
const PANEL_B_HEIGHT = 140

const AXIS_TICK = { fill: 'var(--color-brand-muted)', fontSize: 10 }

const IN_COLOR = 'var(--color-brand-accent)'
const OUT_COLOR = 'var(--color-brand-purple)'
const LINE_COLOR = 'var(--color-brand-blue)'

// A 45° hatch — the secondary, non-colour channel that marks a bar as forecast.
// Survives greyscale, print and forced-colors, where hue alone does not.
function Hatch({ id, color }) {
  return (
    <pattern
      id={id}
      patternUnits="userSpaceOnUse"
      width="6"
      height="6"
      patternTransform="rotate(45)"
    >
      <rect width="6" height="6" fill={color} fillOpacity="0.18" />
      <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeWidth="3" />
    </pattern>
  )
}

// Legend key. Self-contained SVG so the swatch shows the real texture rather
// than a colour chip that would reintroduce the colour-alone problem.
function Swatch({ color, hatched, patternId }) {
  return (
    <svg width="11" height="11" aria-hidden="true" className="shrink-0">
      {hatched && <defs><Hatch id={patternId} color={color} /></defs>}
      <rect
        width="11"
        height="11"
        rx="2"
        fill={hatched ? `url(#${patternId})` : color}
      />
    </svg>
  )
}

// One month, every figure. Unavailable values arrive as null and formatCurrency
// renders null as "—", so a past or unavailable forecast can never surface as
// "$0". Cash Out is shown POSITIVE — the downward plot is a drawing choice.
function ChartTooltip({ active, payload, currencyCode }) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  if (!row) return null
  const money = (n) => formatCurrency(n, currencyCode)

  const pairs = [
    ['Actual In', row.tipActualIn, 'Actual Out', row.tipActualOut],
    ['Forecast In', row.tipForecastIn, 'Forecast Out', row.tipForecastOut],
    ['Total In', row.tipTotalIn, 'Total Out', row.tipTotalOut],
  ]

  return (
    <div className="bg-brand-surface border border-brand-border rounded-lg px-3 py-2 shadow-lg">
      <p className="m-0 mb-1.5 text-[11px] font-bold text-brand-text">
        {row.label}
        {row.isCurrent && <span className="ml-2 text-brand-accent">Current</span>}
        {row.isPast && <span className="ml-2 font-semibold text-brand-muted">Recorded</span>}
      </p>
      <table className="border-collapse">
        <tbody>
          {pairs.map(([lA, vA, lB, vB]) => (
            <tr key={lA}>
              <td className="pr-2 py-[1px] text-[11px] text-brand-muted">{lA}</td>
              <td className="pr-4 py-[1px] text-[11px] text-brand-text tabular-nums text-right">{money(vA)}</td>
              <td className="pr-2 py-[1px] text-[11px] text-brand-muted">{lB}</td>
              <td className="py-[1px] text-[11px] text-brand-text tabular-nums text-right">{money(vB)}</td>
            </tr>
          ))}
          <tr className="border-t border-brand-border">
            <td className="pr-2 pt-1 text-[11px] text-brand-muted">Net</td>
            <td className={`pr-4 pt-1 text-[11px] tabular-nums text-right ${row.tipNet < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
              {money(row.tipNet)}
            </td>
            <td className="pr-2 pt-1 text-[11px] text-brand-muted">Cumulative</td>
            <td className={`pt-1 text-[11px] font-semibold tabular-nums text-right ${row.tipCumulative < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
              {money(row.tipCumulative)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export default function CashFlowChart({
  combinedRows, nowMonth, pf, suppression, forecastUnavailable, currencyCode,
}) {
  // useId namespaces the SVG pattern ids per component instance, so a second
  // mount can never collide on a global id. Colons are stripped — a raw React
  // id is not safe inside a url(#…) reference.
  const rawId = useId()
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, '')
  const hatchInId = `cf-hatch-in-${uid}`
  const hatchOutId = `cf-hatch-out-${uid}`
  const legendInId = `cf-legend-in-${uid}`
  const legendOutId = `cf-legend-out-${uid}`

  const rows = useMemo(
    () => toChartRows(combinedRows, { forecastUnavailable }),
    [combinedRows, forecastUnavailable],
  )
  const boundary = useMemo(() => chartBoundary(rows), [rows])
  const marker = useMemo(
    () => peakMarker({ pf, suppression, forecastUnavailable }),
    [pf, suppression, forecastUnavailable],
  )
  const summary = useMemo(
    () => chartSummary({ rows, forecastUnavailable, pf, suppression, currencyCode }),
    [rows, forecastUnavailable, pf, suppression, currencyCode],
  )

  // The page already renders a purposeful empty state; an empty chart frame
  // would be noise on top of it.
  if (rows.length === 0) return null

  const money = (n) => formatCurrency(n, currencyCode)
  const minWidth = chartMinWidth(rows.length)

  // The forecast REGION is a claim that forecast data loaded. When a forecast
  // source failed it must not be drawn — but the current-month line still is:
  // that is a calendar fact, not a forecast claim.
  const showForecastRegion = !!boundary && !forecastUnavailable

  const legend = [
    { key: 'ai', label: 'Actual In', color: IN_COLOR, hatched: false },
    { key: 'fi', label: 'Forecast In', color: IN_COLOR, hatched: true, patternId: legendInId },
    { key: 'ao', label: 'Actual Out', color: OUT_COLOR, hatched: false },
    { key: 'fo', label: 'Forecast Out', color: OUT_COLOR, hatched: true, patternId: legendOutId },
  ]

  // Shared X-axis configuration — identical on both panels so the month bands,
  // the boundary line and the forecast region stay in register.
  const sharedXAxis = {
    dataKey: 'monthKey',
    axisLine: false,
    tickLine: false,
    interval: 'preserveStartEnd',
  }

  return (
    <Card padding={false} className="mb-3.5">
      {/* ── Header + legend ───────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-3.5 py-3 border-b border-brand-border">
        <p className="text-[13px] font-bold text-brand-text m-0">
          Monthly cash movement and cumulative position
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {legend.map(l => (
            <div key={l.key} className="flex items-center gap-1.5">
              <Swatch color={l.color} hatched={l.hatched} patternId={l.patternId} />
              <span className="text-[10.5px] text-brand-text-soft">{l.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Forecast-source failure — never presented as zero ─────────────── */}
      {forecastUnavailable && (
        <p className="m-0 px-3.5 py-2 text-[11.5px] text-brand-amber border-b border-brand-border">
          Forecast is unavailable — a source failed to load. Only recorded cash is charted; projected
          months are left blank rather than drawn as zero, and the cumulative line stops at the last
          recorded month.
        </p>
      )}

      {/* ── Both panels in ONE scroll container so they scroll together ───── */}
      <div className="overflow-x-auto">
        <div style={{ minWidth }}>
          {/* ── Panel A — monthly movement ─────────────────────────────── */}
          <div
            role="group"
            aria-label={`Monthly cash in and cash out by month, actual and forecast. Current month ${monthLabel(nowMonth)}. Exact figures are in the monthly table below this chart.`}
            className="pt-3"
          >
            <ResponsiveContainer width="100%" height={PANEL_A_HEIGHT}>
              <ComposedChart data={rows} margin={CHART_MARGIN} stackOffset="sign" accessibilityLayer>
                <defs>
                  <Hatch id={hatchInId} color={IN_COLOR} />
                  <Hatch id={hatchOutId} color={OUT_COLOR} />
                </defs>

                {showForecastRegion && (
                  <ReferenceArea
                    x1={boundary.monthKey}
                    x2={boundary.lastMonthKey}
                    fill="var(--color-brand-card)"
                    fillOpacity={0.55}
                  />
                )}

                <XAxis {...sharedXAxis} tick={false} height={4} />
                <YAxis
                  width={Y_AXIS_WIDTH}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => money(v)}
                />

                {/* The zero baseline bars diverge around — emphatic, not a gridline. */}
                <ReferenceLine y={0} stroke="var(--color-brand-border)" strokeWidth={1.5} />

                {boundary && (
                  <ReferenceLine
                    x={boundary.monthKey}
                    stroke="var(--color-brand-accent)"
                    strokeDasharray="3 3"
                    strokeOpacity={0.75}
                  />
                )}

                <Tooltip
                  cursor={{ fill: 'var(--color-brand-card)', fillOpacity: 0.4 }}
                  content={<ChartTooltip currencyCode={currencyCode} />}
                />

                {/* Separate stackIds keep the positive and negative stacks independent. */}
                <Bar dataKey="actualIn" stackId="in" fill={IN_COLOR} name="Actual In"
                  stroke="var(--color-brand-surface)" strokeWidth={0.5} isAnimationActive={false} />
                <Bar dataKey="forecastIn" stackId="in" fill={`url(#${hatchInId})`} name="Forecast In"
                  stroke="var(--color-brand-surface)" strokeWidth={0.5} isAnimationActive={false} />
                <Bar dataKey="actualOut" stackId="out" fill={OUT_COLOR} name="Actual Out"
                  stroke="var(--color-brand-surface)" strokeWidth={0.5} isAnimationActive={false} />
                <Bar dataKey="forecastOut" stackId="out" fill={`url(#${hatchOutId})`} name="Forecast Out"
                  stroke="var(--color-brand-surface)" strokeWidth={0.5} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* ── Panel B — cumulative position ──────────────────────────── */}
          <div
            role="group"
            aria-label={`Cumulative cash position by month, from a zero opening position. Current month ${monthLabel(nowMonth)}. Not a bank balance. Exact figures are in the monthly table below this chart.`}
          >
            <ResponsiveContainer width="100%" height={PANEL_B_HEIGHT}>
              <ComposedChart data={rows} margin={CHART_MARGIN} accessibilityLayer>
                {/* Everything below zero, shaded. No second scale, no gradient.
                    y1 omitted deliberately — the area extends to the axis edge,
                    and the domain below guarantees 0 is always inside it. */}
                <ReferenceArea
                  y2={0}
                  fill="var(--color-brand-red)"
                  fillOpacity={0.07}
                />

                {showForecastRegion && (
                  <ReferenceArea
                    x1={boundary.monthKey}
                    x2={boundary.lastMonthKey}
                    fill="var(--color-brand-card)"
                    fillOpacity={0.55}
                  />
                )}

                <XAxis
                  {...sharedXAxis}
                  tick={AXIS_TICK}
                  tickFormatter={monthLabel}
                  minTickGap={14}
                  height={26}
                />
                <YAxis
                  width={Y_AXIS_WIDTH}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => money(v)}
                  // The zero line must never fall outside the plotted range.
                  domain={[(dataMin) => Math.min(0, dataMin), (dataMax) => Math.max(0, dataMax)]}
                />

                <ReferenceLine
                  y={0}
                  stroke="var(--color-brand-border)"
                  strokeWidth={1.5}
                  label={{ value: '0', position: 'insideLeft', fill: 'var(--color-brand-muted)', fontSize: 10 }}
                />

                {boundary && (
                  <ReferenceLine
                    x={boundary.monthKey}
                    stroke="var(--color-brand-accent)"
                    strokeDasharray="3 3"
                    strokeOpacity={0.75}
                    label={{
                      value: boundary.isCurrentMonth ? 'Current' : 'Forecast',
                      position: 'insideTopRight',
                      fill: 'var(--color-brand-accent)',
                      fontSize: 10,
                    }}
                  />
                )}

                <Tooltip
                  cursor={{ stroke: 'var(--color-brand-border)', strokeWidth: 1 }}
                  content={<ChartTooltip currencyCode={currencyCode} />}
                />

                {/* connectNulls={false}: an unavailable stretch BREAKS the line
                    rather than bridging it with an invented trajectory. */}
                <Line
                  type="monotone"
                  dataKey="cumulative"
                  stroke={LINE_COLOR}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                  isAnimationActive={false}
                  name="Cumulative position"
                />

                {/* Plotted ONLY when peakMarker() judged the figure authoritative. */}
                {marker && (
                  <ReferenceDot
                    x={marker.monthKey}
                    y={marker.position}
                    r={5}
                    fill="var(--color-brand-red)"
                    stroke="var(--color-brand-surface)"
                    strokeWidth={2}
                    label={{
                      value: `Peak funding ${money(marker.requirement)}`,
                      position: 'top',
                      fill: 'var(--color-brand-red)',
                      fontSize: 10,
                      fontWeight: 700,
                    }}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* ── Summary + peak-funding caption ────────────────────────────────── */}
      <div className="px-3.5 py-3 border-t border-brand-border">
        <p className="m-0 text-[11.5px] text-brand-text-soft">{summary}</p>

        {!forecastUnavailable && suppression?.suppressed && (
          <p className="m-0 mt-1 text-[11px] text-brand-amber">
            Peak funding is not shown because the forecast is incomplete. The qualified lower bound is
            stated above — it is deliberately not plotted, because a marker on a chart reads as a
            confirmed figure.
          </p>
        )}
        {!forecastUnavailable && !suppression?.suppressed && !pf?.negative && (
          <p className="m-0 mt-1 text-[11px] text-brand-muted">No funding shortfall projected.</p>
        )}

        <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
          Cash In is drawn above the zero line and Cash Out below it; both are amounts of money, and
          the tooltip shows each as a positive figure. Solid bars are recorded cash, hatched bars are
          forecast. Past months are actual-only, so their forecast is shown as unavailable rather than
          as zero. The cumulative position starts at zero and is net project cash movement — not a bank
          balance. Exact figures are in the monthly table below.
        </p>
      </div>
    </Card>
  )
}
