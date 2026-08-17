import {
  isValidIsoDate, daysBetween, addDays, isoToUtcMs, utcMsToIso,
  activityDuration, isOverdue, sortActivities,
  ACTIVITY_STATUS, ACTIVITY_STATUS_LABELS,
} from './projectTimeline'
import { todayIso } from './payments'

// ── Gantt presentation transform (ADR-29) ────────────────────────────────────
//
// Pure geometry. This module turns already-validated activities into pixel
// offsets, widths, ticks and a today marker — and does NOTHING else. It holds
// no business rule, no validation, no financial arithmetic, and no clock of its
// own, which is exactly what makes a Gantt testable in the existing Node-only
// unit runner with no jsdom and no charting library.
//
// It is the direct analogue of lib/cashFlowChart.js under ADR-26: the visual
// consumes what the domain module already derived and re-derives nothing. The
// ACTIVITY TABLE remains the exact record and the accessible equivalent — the
// chart is never the only path to the data.
//
// ⚠️ NO CHARTING DEPENDENCY. A Gantt is date arithmetic plus positioned
// rectangles; Recharts (present for Cash Flow) has no range-bar primitive and
// would be more code with less control. Nothing was installed for this.

// One day column. 22px keeps a two-month programme readable on a laptop while
// a multi-year one stays legible inside the horizontal scroller rather than
// compressing to nothing (the fixed-slot approach proven by CashFlowChart).
export const DAY_WIDTH_PX = 22
export const ROW_HEIGHT_PX = 34
export const MILESTONE_SIZE_PX = 12

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

// ── Month helpers (pure string/UTC arithmetic — never a local Date) ──────────

export function monthStart(iso) {
  if (!isValidIsoDate(iso)) return null
  return `${iso.slice(0, 7)}-01`
}

export function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate()
}

export function monthEnd(iso) {
  if (!isValidIsoDate(iso)) return null
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  return `${iso.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, '0')}`
}

export function monthLabel(iso) {
  if (!isValidIsoDate(iso)) return ''
  const y = iso.slice(0, 4)
  const m = Number(iso.slice(5, 7))
  return `${MONTH_ABBR[m - 1]} ${y}`
}

// ── Which dates an activity contributes to the window ────────────────────────
//
// Planned dates drive the bars. ACTUAL dates widen the window when they fall
// outside the plan, so an activity that started early or ran long is never
// drawn off-canvas.
function activityDates(a) {
  const dates = []
  if (isValidIsoDate(a?.plannedStart))  dates.push(a.plannedStart)
  if (isValidIsoDate(a?.plannedFinish)) dates.push(a.plannedFinish)
  if (isValidIsoDate(a?.actualStart))   dates.push(a.actualStart)
  if (isValidIsoDate(a?.actualFinish))  dates.push(a.actualFinish)
  return dates
}

// True when an activity can be drawn at all: it needs a usable, correctly
// ordered planned span. Everything else is reported as excluded rather than
// silently dropped.
export function isDrawable(a) {
  if (!isValidIsoDate(a?.plannedStart) || !isValidIsoDate(a?.plannedFinish)) return false
  return a.plannedFinish >= a.plannedStart
}

// ── Visible window ───────────────────────────────────────────────────────────
//
// Snapped out to whole months so the month header always starts and ends on a
// real month boundary. `today` widens the window ONLY when it already sits
// within one month of the programme — a programme that finished last year must
// not drag a year of empty columns across the canvas just to show a today line.
export function ganttWindow(activities, now = new Date()) {
  const drawable = (activities ?? []).filter(isDrawable)
  if (drawable.length === 0) return null

  let min = null
  let max = null
  for (const a of drawable) {
    for (const iso of activityDates(a)) {
      if (min === null || iso < min) min = iso
      if (max === null || iso > max) max = iso
    }
  }
  if (min === null || max === null) return null

  const today = todayIso(now)
  // Include today when it is at or inside the programme span, so the marker has
  // somewhere to land in the common case.
  if (today >= min && today <= max) {
    // already inside — nothing to widen
  } else if (today > max && daysBetween(max, today) <= 31) {
    max = today
  } else if (today < min && daysBetween(today, min) <= 31) {
    min = today
  }

  return { start: monthStart(min), end: monthEnd(max) }
}

// ── Ticks ────────────────────────────────────────────────────────────────────

// One entry per calendar month in the window, each with its own width, so the
// header never assumes 30-day months.
export function monthTicks(start, end, dayWidth = DAY_WIDTH_PX) {
  if (!isValidIsoDate(start) || !isValidIsoDate(end) || end < start) return []
  const ticks = []
  let cursor = monthStart(start)
  while (cursor && cursor <= end) {
    const last = monthEnd(cursor)
    const visibleStart = cursor < start ? start : cursor
    const visibleEnd   = last > end ? end : last
    const offsetDays   = daysBetween(start, visibleStart)
    const days         = daysBetween(visibleStart, visibleEnd) + 1
    ticks.push({
      key: cursor.slice(0, 7),
      label: monthLabel(cursor),
      offsetDays,
      days,
      x: offsetDays * dayWidth,
      width: days * dayWidth,
    })
    cursor = monthStart(addDays(last, 1))
  }
  return ticks
}

// Gridlines every 7 days from the window start.
//
// ⚠️ Aligned to the WINDOW START, not to Mondays: Constrapp defines no
// week-start convention and no working calendar, so a "Monday" gridline would
// be an invention. These are spacing marks, not working weeks.
export function weekTicks(start, end, dayWidth = DAY_WIDTH_PX) {
  if (!isValidIsoDate(start) || !isValidIsoDate(end) || end < start) return []
  const total = daysBetween(start, end) + 1
  const ticks = []
  for (let offsetDays = 0; offsetDays < total; offsetDays += 7) {
    ticks.push({
      iso: addDays(start, offsetDays),
      offsetDays,
      x: offsetDays * dayWidth,
    })
  }
  return ticks
}

// ── Bars ─────────────────────────────────────────────────────────────────────

// Clamps a span to the window, reporting which ends were cut so the UI can draw
// a continuation edge rather than implying the work starts/ends at the border.
function clampSpan(startIso, finishIso, window) {
  const clippedStart = startIso  < window.start
  const clippedEnd   = finishIso > window.end
  const from = clippedStart ? window.start : startIso
  const to   = clippedEnd   ? window.end   : finishIso
  if (to < from) return null
  return { from, to, clippedStart, clippedEnd }
}

// ── The model the component renders ──────────────────────────────────────────
//
// Everything the Gantt needs, computed once: window, canvas width, ticks, the
// today marker, and one bar per drawable activity. Rows come back in the SAME
// deterministic order as the activity table (sortActivities), because the two
// are read together.
export function buildGanttModel(activities, {
  now = new Date(),
  dayWidth = DAY_WIDTH_PX,
  rowHeight = ROW_HEIGHT_PX,
  window: explicitWindow = null,
} = {}) {
  const ordered  = sortActivities(activities ?? [])
  const drawable = ordered.filter(isDrawable)
  const excluded = ordered.filter(a => !isDrawable(a))

  const window = explicitWindow ?? ganttWindow(ordered, now)

  const empty = {
    window: null,
    start: null,
    end: null,
    totalDays: 0,
    dayWidth,
    rowHeight,
    canvasWidth: 0,
    canvasHeight: 0,
    months: [],
    weeks: [],
    today: todayIso(now),
    todayOffsetDays: null,
    todayX: null,
    bars: [],
    excluded,
  }

  if (!window || !isValidIsoDate(window.start) || !isValidIsoDate(window.end) || window.end < window.start) {
    return empty
  }

  const totalDays   = daysBetween(window.start, window.end) + 1
  const canvasWidth = totalDays * dayWidth
  const today       = todayIso(now)
  const todayInside = today >= window.start && today <= window.end
  const todayOffset = todayInside ? daysBetween(window.start, today) : null

  const bars = []
  for (const a of drawable) {
    const span = clampSpan(a.plannedStart, a.plannedFinish, window)
    // Entirely outside the window — reported as excluded, never drawn at zero
    // width where it would read as a milestone.
    if (!span) { excluded.push(a); continue }

    const offsetDays = daysBetween(window.start, span.from)
    const days       = daysBetween(span.from, span.to) + 1
    const percent    = Number.isFinite(Number(a.percentComplete))
      ? Math.min(100, Math.max(0, Math.trunc(Number(a.percentComplete))))
      : 0

    bars.push({
      id: a.id,
      name: a.name,
      status: a.status,
      statusLabel: ACTIVITY_STATUS_LABELS[a.status] ?? a.status,
      isMilestone: a.isMilestone === true,
      isOverdue: isOverdue(a, now),
      isCancelled: a.status === ACTIVITY_STATUS.CANCELLED,
      plannedStart: a.plannedStart,
      plannedFinish: a.plannedFinish,
      durationDays: activityDuration(a),
      percentComplete: percent,
      responsibleName: a.responsibleName || '',
      costCodeName: a.costCodeName || '',

      offsetDays,
      days,
      x: offsetDays * dayWidth,
      width: days * dayWidth,
      // Progress fill is a share of the drawn bar. On a clipped bar it is a
      // share of the VISIBLE span — the figure itself is always read from the
      // table, never measured off the chart.
      progressWidth: (days * dayWidth * percent) / 100,
      // A milestone is a point: centred in its single day column.
      milestoneX: offsetDays * dayWidth + dayWidth / 2,
      clippedStart: span.clippedStart,
      clippedEnd: span.clippedEnd,
    })
  }

  return {
    window,
    start: window.start,
    end: window.end,
    totalDays,
    dayWidth,
    rowHeight,
    canvasWidth,
    canvasHeight: bars.length * rowHeight,
    months: monthTicks(window.start, window.end, dayWidth),
    weeks: weekTicks(window.start, window.end, dayWidth),
    today,
    todayOffsetDays: todayOffset,
    todayX: todayOffset === null ? null : todayOffset * dayWidth,
    bars,
    excluded,
  }
}

// Re-exported so the component imports one module for geometry.
export { isValidIsoDate, isoToUtcMs, utcMsToIso }
