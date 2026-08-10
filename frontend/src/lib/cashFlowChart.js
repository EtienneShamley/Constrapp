import { monthLabel } from './cashFlow'
import { formatCurrency } from './formatters'

// ── Cash Flow chart — PRESENTATION TRANSFORM ONLY ────────────────────────────
//
// ⚠️ THIS MODULE CONTAINS NO FINANCIAL ARITHMETIC. Every monetary figure it
// handles arrives already derived, already summed and already rounded by
// lib/cashFlow.js (ADR-25/ADR-26). Nothing here groups, sorts, sums, rounds,
// re-derives a cumulative position, or re-derives peak funding. It exists for
// one reason: the chart needs a handful of *display* decisions, and those
// decisions must be unit-testable.
//
// The unit suite runs in plain Node (`environment: 'node'`, no jsdom), so logic
// placed inside CashFlowChart.jsx would be untestable. Keeping it here is what
// makes the honesty rules below provable rather than merely intended.
//
// The four display decisions:
//   1 · Cash Out is negated so it plots BELOW the zero baseline.
//   2 · Unavailable figures become `null`, NEVER 0 — Recharts skips a null and
//       draws a 0, so this distinction is the entire honesty contract.
//   3 · The actual/forecast boundary is located for the reference line/region.
//   4 · The peak-funding marker exists only when the figure is authoritative.
//
// ⚠️ THE UNAVAILABILITY RULE mirrors CombinedMonthlyTable exactly:
//       na = forecastUnavailable && !row.isPast
//   A PAST month's forecast is not applicable (the boundary rule makes it
//   structurally zero), and an unavailable month's figures are unknown. Both
//   render as "—". Neither is ever a legitimate $0.

const isNum = (n) => typeof n === 'number' && Number.isFinite(n)

// ── Display sign ─────────────────────────────────────────────────────────────

// Negate a cash-out amount so it plots below the zero baseline.
//
// ⚠️ ZERO STAYS ZERO. `-1 * 0` is `-0` in IEEE-754 — a distinct value that
// compares false under Object.is, can render as "-0", and would place a
// zero-height bar on the wrong side of the baseline. Guarded explicitly.
//
// null/undefined pass through as null: an unavailable amount must never be
// turned into a plottable number.
export function negateForPlot(n) {
  if (!isNum(n)) return null
  return n === 0 ? 0 : -n
}

// A plotted (negative) cash-out value → the positive amount a reader sees in
// the tooltip. Cash Out is a positive sum of money that happens to be drawn
// downward; it is never presented to the user as a negative number.
export function positiveForDisplay(n) {
  if (!isNum(n)) return null
  return n === 0 ? 0 : Math.abs(n)
}

// ── Chart rows ───────────────────────────────────────────────────────────────

// combinedRows → plot rows. Pure: `combinedRows` is never mutated and no row
// object is reused, so the caller's memoised financial data cannot be touched.
//
// Each output row carries two parallel sets of figures:
//   · plot keys   (actualIn/forecastIn/actualOut/forecastOut/cumulative) —
//     cash-out negated, unavailable values null
//   · tooltip keys (tip*) — always POSITIVE money, unavailable values null
//
// Keeping them separate is deliberate: the sign flip is a plotting artefact and
// must never leak into a figure a user reads.
export function toChartRows(combinedRows, { forecastUnavailable = false } = {}) {
  if (!Array.isArray(combinedRows) || combinedRows.length === 0) return []

  return combinedRows.map((row) => {
    // Unavailable applies to CURRENT/FUTURE months only. A past month's figures
    // loaded fine — its forecast is simply not applicable.
    const na = forecastUnavailable && !row.isPast
    const forecastHidden = row.isPast || na

    const tipForecastIn  = forecastHidden ? null : row.forecastCashIn
    const tipForecastOut = forecastHidden ? null : row.forecastCashOut
    const tipTotalIn     = na ? null : row.totalCashIn
    const tipTotalOut    = na ? null : row.totalCashOut
    const tipNet         = na ? null : row.net
    const tipCumulative  = na ? null : row.cumulativePosition

    return {
      monthKey: row.monthKey,
      label: monthLabel(row.monthKey),
      isPast: !!row.isPast,
      isCurrent: !!row.isCurrent,

      // ── plot values ──
      actualIn:    isNum(row.actualCashIn) ? row.actualCashIn : null,
      forecastIn:  tipForecastIn,
      actualOut:   negateForPlot(row.actualCashOut),
      forecastOut: negateForPlot(tipForecastOut),
      cumulative:  tipCumulative,

      // ── tooltip values (positive money; null = unavailable) ──
      tipActualIn:  isNum(row.actualCashIn) ? row.actualCashIn : null,
      tipActualOut: isNum(row.actualCashOut) ? row.actualCashOut : null,
      tipForecastIn,
      tipForecastOut,
      tipTotalIn,
      tipTotalOut,
      tipNet,
      tipCumulative,
    }
  })
}

// ── Actual / forecast boundary ───────────────────────────────────────────────

// Locate the first non-past row — the start of the forecast region and the
// anchor for the "Current" reference line.
//
// Deliberately keyed off `isPast`, which lib/cashFlow.js already stamped from
// the page's single `nowMonth`. The chart therefore needs NO calendar of its
// own — `currentMonthKey()` is the app's one timezone-sensitive value and must
// not be called a second time. Works even when no row is flagged `isCurrent`.
//
// Returns null when every month is past (no forecast region to draw).
export function chartBoundary(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const index = rows.findIndex(r => !r.isPast)
  if (index === -1) return null
  return {
    index,
    monthKey: rows[index].monthKey,
    lastMonthKey: rows[rows.length - 1].monthKey,
    lastPastMonthKey: index > 0 ? rows[index - 1].monthKey : null,
    isCurrentMonth: !!rows[index].isCurrent,
  }
}

// ── Peak funding marker ──────────────────────────────────────────────────────

// Whether the chart may plot a peak-funding marker, using the EXISTING
// peakFunding()/peakFundingSuppression() results. No peak maths happens here.
//
// ⚠️ HONESTY-CRITICAL, AND DELIBERATELY ASYMMETRIC. A plotted point reads as
// authoritative no matter what caption sits beside it, and understating a
// funding requirement is the dangerous direction. So the marker appears ONLY
// when the figure is fully authoritative:
//   · forecast source failed → no marker
//   · suppressed            → no marker (and NO lower-bound marker either — the
//                             qualified lower bound is already stated, properly
//                             hedged, in the peak-funding Card above the chart)
//   · position never negative → no marker (never a "$0" marker)
export function peakMarker({ pf, suppression, forecastUnavailable = false } = {}) {
  if (forecastUnavailable) return null
  if (suppression?.suppressed) return null
  if (!pf?.negative) return null
  if (!isNum(pf.lowestPosition)) return null
  return {
    monthKey: pf.monthKey,
    position: pf.lowestPosition,
    requirement: pf.requirement,
  }
}

// ── Layout ───────────────────────────────────────────────────────────────────

// Each month gets a fixed slot, so bars stay the same readable size on a
// two-year project as on a three-month one; the container scrolls instead of
// compressing. This is why the chart needs no viewport listener, no resize
// state, and no effects.
export const MONTH_SLOT_PX = 44
export const MIN_CHART_WIDTH_PX = 320

export function chartMinWidth(monthCount) {
  const n = isNum(monthCount) && monthCount > 0 ? monthCount : 0
  return Math.max(MIN_CHART_WIDTH_PX, n * MONTH_SLOT_PX)
}

// ── Textual summary ──────────────────────────────────────────────────────────

// A short prose summary rendered visibly beneath the chart. It is the
// screen-reader equivalent of the shapes above, and it helps sighted readers
// too — so it is visible text, not sr-only.
//
// It states no figure the page has not already derived: the month span comes
// from the rows, and the only monetary value it may quote is the peak-funding
// trough — and only when peakMarker() has judged that figure authoritative.
// It degrades honestly in every unavailable/suppressed state.
export function chartSummary({
  rows, forecastUnavailable = false, pf, suppression, currencyCode,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return ''

  const first = rows[0]
  const last = rows[rows.length - 1]
  const parts = [
    `${rows.length} month${rows.length === 1 ? '' : 's'}, ${first.label} – ${last.label}.`,
  ]

  const boundary = chartBoundary(rows)
  if (!boundary) {
    parts.push('All months shown are recorded cash.')
  } else if (boundary.lastPastMonthKey) {
    parts.push(
      `Recorded cash through ${monthLabel(boundary.lastPastMonthKey)}; `
      + `projected from ${monthLabel(boundary.monthKey)}.`,
    )
  } else {
    parts.push(`Projected from ${monthLabel(boundary.monthKey)} onward.`)
  }

  // A failed forecast source ends the summary: with the forecast unavailable,
  // no statement about a projected position could be made honestly.
  if (forecastUnavailable) {
    parts.push('Forecast is unavailable — only recorded cash is charted.')
    return parts.join(' ')
  }

  const marker = peakMarker({ pf, suppression, forecastUnavailable })
  if (marker) {
    parts.push(
      `Lowest projected position ${formatCurrency(marker.position, currencyCode)} `
      + `in ${monthLabel(marker.monthKey)}.`,
    )
  } else if (suppression?.suppressed) {
    parts.push('Peak funding is not shown because the forecast is incomplete.')
  } else {
    parts.push('No funding shortfall projected.')
  }

  return parts.join(' ')
}
