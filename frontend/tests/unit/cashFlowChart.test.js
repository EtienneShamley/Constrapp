import { describe, it, expect } from 'vitest'
import {
  negateForPlot, positiveForDisplay, toChartRows, chartBoundary,
  peakMarker, chartMinWidth, chartSummary,
  MONTH_SLOT_PX, MIN_CHART_WIDTH_PX,
} from '../../src/lib/cashFlowChart'

// ── Cash Flow chart — presentation-transform unit tests ──────────────────────
//
// These cover lib/cashFlowChart.js ONLY: the display sign flip, the
// unavailable-vs-zero rule, boundary location, peak-marker eligibility, layout
// width, and the textual summary.
//
// ⚠️ NO Cash Flow arithmetic is retested here. Cumulative position, peak-funding
// maths, reconciliation, completeness and the month-boundary financial rules are
// covered by tests/unit/cashFlow.test.js and have exactly one home. Fixtures
// below are hand-written rows in the shape buildMonthlyCombinedRows() returns —
// the chart consumes that output and never recomputes it.

// A combined row as lib/cashFlow.js emits it.
function row(overrides = {}) {
  const actualCashIn = overrides.actualCashIn ?? 0
  const actualCashOut = overrides.actualCashOut ?? 0
  const forecastCashIn = overrides.forecastCashIn ?? 0
  const forecastCashOut = overrides.forecastCashOut ?? 0
  const totalCashIn = actualCashIn + forecastCashIn
  const totalCashOut = actualCashOut + forecastCashOut
  return {
    monthKey: '2026-08',
    isPast: false,
    isCurrent: false,
    actualCashIn,
    actualCashOut,
    forecastCashIn,
    forecastCashOut,
    totalCashIn,
    totalCashOut,
    net: totalCashIn - totalCashOut,
    cumulativePosition: 0,
    ...overrides,
  }
}

const pastRow = (o = {}) => row({ monthKey: '2026-06', isPast: true, ...o })
const currentRow = (o = {}) => row({ monthKey: '2026-08', isCurrent: true, ...o })
const futureRow = (o = {}) => row({ monthKey: '2026-09', ...o })

// A representative three-month dataset: one recorded month, the current mixed
// month, one projected month.
const SPAN = [
  pastRow({ actualCashIn: 100, actualCashOut: 40, cumulativePosition: 60 }),
  currentRow({
    actualCashIn: 50, actualCashOut: 20,
    forecastCashIn: 30, forecastCashOut: 10,
    cumulativePosition: 110,
  }),
  futureRow({ forecastCashIn: 200, forecastCashOut: 400, cumulativePosition: -90 }),
]

// ── 1 · Empty input ──────────────────────────────────────────────────────────

describe('empty input', () => {
  it('returns an empty array for an empty dataset', () => {
    expect(toChartRows([])).toEqual([])
  })

  it('returns an empty array for null/undefined rather than throwing', () => {
    expect(toChartRows(null)).toEqual([])
    expect(toChartRows(undefined)).toEqual([])
  })

  it('has no boundary and an empty summary when there are no rows', () => {
    expect(chartBoundary([])).toBeNull()
    expect(chartBoundary(null)).toBeNull()
    expect(chartSummary({ rows: [] })).toBe('')
    expect(chartSummary({})).toBe('')
  })
})

// ── 2 · Purity ───────────────────────────────────────────────────────────────

describe('purity — the financial rows are never mutated', () => {
  it('leaves every input row byte-identical', () => {
    const input = [
      pastRow({ actualCashIn: 100, actualCashOut: 40, cumulativePosition: 60 }),
      currentRow({ forecastCashIn: 30, cumulativePosition: 90 }),
    ]
    const snapshot = JSON.parse(JSON.stringify(input))
    toChartRows(input, { forecastUnavailable: true })
    chartBoundary(toChartRows(input))
    chartSummary({ rows: toChartRows(input) })
    expect(input).toEqual(snapshot)
  })

  it('returns new row objects, never the input references', () => {
    const input = [currentRow()]
    const out = toChartRows(input)
    expect(out[0]).not.toBe(input[0])
  })
})

// ── 3-5 · Display sign ───────────────────────────────────────────────────────

describe('cash-out plotting sign', () => {
  it('negates cash out so it plots below the zero baseline', () => {
    const [r] = toChartRows([currentRow({ actualCashOut: 250, forecastCashOut: 100 })])
    expect(r.actualOut).toBe(-250)
    expect(r.forecastOut).toBe(-100)
  })

  it('leaves cash in positive', () => {
    const [r] = toChartRows([currentRow({ actualCashIn: 250, forecastCashIn: 100 })])
    expect(r.actualIn).toBe(250)
    expect(r.forecastIn).toBe(100)
  })

  it('keeps zero as +0 and never produces -0', () => {
    const [r] = toChartRows([currentRow({ actualCashOut: 0, forecastCashOut: 0 })])
    expect(Object.is(r.actualOut, -0)).toBe(false)
    expect(Object.is(r.actualOut, 0)).toBe(true)
    expect(Object.is(r.forecastOut, -0)).toBe(false)
    expect(negateForPlot(0)).toBe(0)
    expect(Object.is(negateForPlot(0), -0)).toBe(false)
  })

  it('passes unavailable amounts through as null, never as a plottable 0', () => {
    expect(negateForPlot(null)).toBeNull()
    expect(negateForPlot(undefined)).toBeNull()
    expect(negateForPlot(NaN)).toBeNull()
  })

  it('returns cash out as a POSITIVE amount for display', () => {
    expect(positiveForDisplay(-250)).toBe(250)
    expect(positiveForDisplay(250)).toBe(250)
    expect(positiveForDisplay(0)).toBe(0)
    expect(Object.is(positiveForDisplay(-0), -0)).toBe(false)
    expect(positiveForDisplay(null)).toBeNull()
  })

  it('shows cash out positively in the tooltip even though it plots negative', () => {
    const [r] = toChartRows([currentRow({ actualCashOut: 250, forecastCashOut: 100 })])
    expect(r.actualOut).toBe(-250)
    expect(r.tipActualOut).toBe(250)
    expect(r.tipForecastOut).toBe(100)
  })
})

// ── 6-8 · Past / current / future classification ─────────────────────────────

describe('past rows treat forecast as unavailable', () => {
  it('nulls a past month forecast rather than drawing it as zero', () => {
    const [r] = toChartRows([pastRow({ actualCashIn: 100, actualCashOut: 40 })])
    expect(r.forecastIn).toBeNull()
    expect(r.forecastOut).toBeNull()
    expect(r.tipForecastIn).toBeNull()
    expect(r.tipForecastOut).toBeNull()
  })

  it('keeps past actuals and past totals fully available', () => {
    const [r] = toChartRows([pastRow({ actualCashIn: 100, actualCashOut: 40, cumulativePosition: 60 })])
    expect(r.actualIn).toBe(100)
    expect(r.actualOut).toBe(-40)
    expect(r.tipActualIn).toBe(100)
    expect(r.tipActualOut).toBe(40)
    expect(r.tipTotalIn).toBe(100)
    expect(r.tipTotalOut).toBe(40)
    expect(r.tipCumulative).toBe(60)
  })
})

describe('the current month retains a mixed actual + forecast split', () => {
  it('keeps both actual and forecast on the current month', () => {
    const [r] = toChartRows([currentRow({
      actualCashIn: 50, actualCashOut: 20, forecastCashIn: 30, forecastCashOut: 10,
    })])
    expect(r.isCurrent).toBe(true)
    expect(r.actualIn).toBe(50)
    expect(r.forecastIn).toBe(30)
    expect(r.actualOut).toBe(-20)
    expect(r.forecastOut).toBe(-10)
    expect(r.tipTotalIn).toBe(80)
    expect(r.tipTotalOut).toBe(30)
  })
})

describe('future rows', () => {
  it('keeps a genuine zero actual as a real zero, not null', () => {
    const [r] = toChartRows([futureRow({ forecastCashIn: 200, forecastCashOut: 400 })])
    expect(r.actualIn).toBe(0)
    expect(r.tipActualIn).toBe(0)
    expect(r.forecastIn).toBe(200)
    expect(r.forecastOut).toBe(-400)
  })

  it('carries the month label through for the axis', () => {
    const [r] = toChartRows([futureRow({ monthKey: '2026-09' })])
    expect(r.label).toBe('Sep 2026')
  })
})

// ── 9-11 · forecastUnavailable ───────────────────────────────────────────────

describe('forecastUnavailable', () => {
  const out = () => toChartRows(SPAN, { forecastUnavailable: true })

  it('nulls forecast values on current and future months', () => {
    const [, current, future] = out()
    expect(current.forecastIn).toBeNull()
    expect(current.forecastOut).toBeNull()
    expect(future.forecastIn).toBeNull()
    expect(future.forecastOut).toBeNull()
  })

  it('never converts an unavailable forecast into a zero', () => {
    const [, current] = out()
    expect(current.forecastIn).not.toBe(0)
    expect(current.tipForecastIn).not.toBe(0)
    expect(current.tipForecastIn).toBeNull()
  })

  it('leaves historical actual data completely intact', () => {
    const [past] = out()
    expect(past.actualIn).toBe(100)
    expect(past.actualOut).toBe(-40)
    expect(past.tipTotalIn).toBe(100)
    expect(past.tipTotalOut).toBe(40)
    expect(past.tipCumulative).toBe(60)
  })

  it('keeps actual figures on current/future months even when the forecast failed', () => {
    const [, current] = out()
    expect(current.actualIn).toBe(50)
    expect(current.actualOut).toBe(-20)
    expect(current.tipActualIn).toBe(50)
    expect(current.tipActualOut).toBe(20)
  })

  it('nulls cumulative positions that are no longer publishable', () => {
    const [past, current, future] = out()
    expect(past.cumulative).toBe(60)
    expect(current.cumulative).toBeNull()
    expect(future.cumulative).toBeNull()
  })

  it('nulls unpublishable totals and net', () => {
    const [, current] = out()
    expect(current.tipTotalIn).toBeNull()
    expect(current.tipTotalOut).toBeNull()
    expect(current.tipNet).toBeNull()
  })

  it('publishes every figure when the forecast is available', () => {
    const [, current, future] = toChartRows(SPAN, { forecastUnavailable: false })
    expect(current.cumulative).toBe(110)
    expect(future.cumulative).toBe(-90)
    expect(current.tipNet).toBe(50)
  })

  it('defaults to available when no option object is supplied', () => {
    const [, current] = toChartRows(SPAN)
    expect(current.forecastIn).toBe(30)
  })
})

// ── 12-15 · Boundary location ────────────────────────────────────────────────

describe('actual/forecast boundary', () => {
  it('locates the first non-past month', () => {
    const b = chartBoundary(toChartRows(SPAN))
    expect(b.index).toBe(1)
    expect(b.monthKey).toBe('2026-08')
    expect(b.lastPastMonthKey).toBe('2026-06')
    expect(b.lastMonthKey).toBe('2026-09')
    expect(b.isCurrentMonth).toBe(true)
  })

  it('returns null when every month is past (no forecast region)', () => {
    const rows = toChartRows([
      pastRow({ monthKey: '2026-05' }),
      pastRow({ monthKey: '2026-06' }),
    ])
    expect(chartBoundary(rows)).toBeNull()
  })

  it('anchors at index 0 when every month is current or future', () => {
    const rows = toChartRows([
      currentRow({ monthKey: '2026-08' }),
      futureRow({ monthKey: '2026-09' }),
    ])
    const b = chartBoundary(rows)
    expect(b.index).toBe(0)
    expect(b.monthKey).toBe('2026-08')
    expect(b.lastPastMonthKey).toBeNull()
  })

  it('still finds the boundary when NO row is flagged as the current month', () => {
    // A dataset that jumps a past month straight to a future one — the boundary
    // is driven by isPast, never by a calendar lookup inside the chart.
    const rows = toChartRows([
      pastRow({ monthKey: '2026-06' }),
      futureRow({ monthKey: '2026-09' }),
    ])
    const b = chartBoundary(rows)
    expect(b.index).toBe(1)
    expect(b.monthKey).toBe('2026-09')
    expect(b.isCurrentMonth).toBe(false)
  })
})

// ── 16-19 · Peak-funding marker eligibility ──────────────────────────────────

describe('peak-funding marker', () => {
  const negativePf = { negative: true, monthKey: '2026-09', lowestPosition: -90, requirement: 90 }
  const positivePf = { negative: false, monthKey: null, lowestPosition: 40, requirement: 0 }
  const clear = { suppressed: false, reasons: [] }
  const suppressed = { suppressed: true, reasons: ['untimed remaining committed cost'] }

  it('plots a marker when the figure is authoritative and negative', () => {
    const m = peakMarker({ pf: negativePf, suppression: clear, forecastUnavailable: false })
    expect(m).toEqual({ monthKey: '2026-09', position: -90, requirement: 90 })
  })

  it('plots NO marker when peak funding is suppressed', () => {
    expect(peakMarker({ pf: negativePf, suppression: suppressed, forecastUnavailable: false })).toBeNull()
  })

  it('plots no lower-bound marker even though a negative trough was computed', () => {
    const m = peakMarker({ pf: negativePf, suppression: suppressed })
    expect(m).toBeNull()
  })

  it('plots no marker when the position never goes negative', () => {
    expect(peakMarker({ pf: positivePf, suppression: clear })).toBeNull()
  })

  it('plots no marker when a forecast source failed', () => {
    expect(peakMarker({ pf: negativePf, suppression: clear, forecastUnavailable: true })).toBeNull()
  })

  it('plots no marker on missing or malformed inputs', () => {
    expect(peakMarker({})).toBeNull()
    expect(peakMarker({ pf: null, suppression: null })).toBeNull()
    expect(peakMarker({ pf: { negative: true, lowestPosition: null }, suppression: clear })).toBeNull()
  })
})

// ── Layout ───────────────────────────────────────────────────────────────────

describe('chart minimum width', () => {
  it('scales with the month count so bars never compress', () => {
    expect(chartMinWidth(24)).toBe(24 * MONTH_SLOT_PX)
  })

  it('never drops below the floor for short projects', () => {
    expect(chartMinWidth(1)).toBe(MIN_CHART_WIDTH_PX)
    expect(chartMinWidth(0)).toBe(MIN_CHART_WIDTH_PX)
    expect(chartMinWidth(NaN)).toBe(MIN_CHART_WIDTH_PX)
  })
})

// ── 20-23 · Textual summary ──────────────────────────────────────────────────

describe('textual summary', () => {
  const clear = { suppressed: false, reasons: [] }
  const suppressed = { suppressed: true, reasons: ['untimed remaining committed cost'] }
  const negativePf = { negative: true, monthKey: '2026-09', lowestPosition: -90, requirement: 90 }
  const positivePf = { negative: false, monthKey: null, lowestPosition: 40, requirement: 0 }

  it('describes span, boundary and an authoritative trough', () => {
    const s = chartSummary({
      rows: toChartRows(SPAN), pf: negativePf, suppression: clear, currencyCode: 'AUD',
    })
    expect(s).toContain('3 months, Jun 2026 – Sep 2026.')
    expect(s).toContain('Recorded cash through Jun 2026; projected from Aug 2026.')
    expect(s).toContain('Lowest projected position')
    expect(s).toContain('Sep 2026')
  })

  it('states no shortfall when the position never goes negative', () => {
    const s = chartSummary({ rows: toChartRows(SPAN), pf: positivePf, suppression: clear })
    expect(s).toContain('No funding shortfall projected.')
    expect(s).not.toContain('Lowest projected position')
  })

  it('reports only recorded cash when the dataset is entirely past', () => {
    const rows = toChartRows([
      pastRow({ monthKey: '2026-05', cumulativePosition: 10 }),
      pastRow({ monthKey: '2026-06', cumulativePosition: 60 }),
    ])
    const s = chartSummary({ rows, pf: positivePf, suppression: clear })
    expect(s).toContain('2 months, May 2026 – Jun 2026.')
    expect(s).toContain('All months shown are recorded cash.')
    expect(s).not.toContain('Recorded cash through')
  })

  it('describes a purely forward-looking dataset without claiming recorded history', () => {
    const rows = toChartRows([currentRow({ monthKey: '2026-08' }), futureRow({ monthKey: '2026-09' })])
    const s = chartSummary({ rows, pf: positivePf, suppression: clear })
    expect(s).toContain('Projected from Aug 2026 onward.')
    expect(s).not.toContain('Recorded cash through')
  })

  it('degrades honestly when the forecast is unavailable', () => {
    const s = chartSummary({
      rows: toChartRows(SPAN, { forecastUnavailable: true }),
      forecastUnavailable: true, pf: negativePf, suppression: clear, currencyCode: 'AUD',
    })
    expect(s).toContain('Forecast is unavailable — only recorded cash is charted.')
    expect(s).not.toContain('Lowest projected position')
    expect(s).not.toContain('No funding shortfall projected.')
  })

  it('states suppression instead of quoting a trough when peak funding is suppressed', () => {
    const s = chartSummary({
      rows: toChartRows(SPAN), pf: negativePf, suppression: suppressed, currencyCode: 'AUD',
    })
    expect(s).toContain('Peak funding is not shown because the forecast is incomplete.')
    expect(s).not.toContain('Lowest projected position')
  })

  it('uses a singular month label for a one-month span', () => {
    const s = chartSummary({ rows: toChartRows([currentRow()]), pf: positivePf, suppression: clear })
    expect(s).toContain('1 month, Aug 2026 – Aug 2026.')
  })
})
