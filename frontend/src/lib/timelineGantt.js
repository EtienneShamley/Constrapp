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

// ── Zoom (Constrapp GANTT™, ADR-64) ──────────────────────────────────────────
//
// Three scales, ONE geometry. A scale is nothing but a day width: every offset
// is still `daysBetween(window.start, date) × dayWidth`, so day, week and month
// zoom draw exactly the same stored dates and a one-day activity is always
// exactly one day wide (clamped to a visible minimum by the component). No
// stored date is touched by zooming, and the window is snapped to whole months
// at every scale, so the header never assumes 30-day months.
export const GANTT_SCALE = {
  DAY:   'day',
  WEEK:  'week',
  MONTH: 'month',
}

export const GANTT_SCALE_ORDER = [GANTT_SCALE.DAY, GANTT_SCALE.WEEK, GANTT_SCALE.MONTH]

export const GANTT_SCALE_LABELS = {
  [GANTT_SCALE.DAY]:   'Day',
  [GANTT_SCALE.WEEK]:  'Week',
  [GANTT_SCALE.MONTH]: 'Month',
}

// Day widths: 22px/day (a fortnight fills a laptop), 8px/day (a week is 56px,
// a year ≈ 2,900px), 3px/day (a month ≈ 90px, three years ≈ 3,300px).
export const SCALE_DAY_WIDTH_PX = {
  [GANTT_SCALE.DAY]:   DAY_WIDTH_PX,
  [GANTT_SCALE.WEEK]:  8,
  [GANTT_SCALE.MONTH]: 3,
}

export const DEFAULT_GANTT_SCALE = GANTT_SCALE.WEEK

export const isGanttScale = (s) => GANTT_SCALE_ORDER.includes(s)

export function dayWidthForScale(scale) {
  return SCALE_DAY_WIDTH_PX[scale] ?? DAY_WIDTH_PX
}

// The fixed label column and the two-line header the component draws. Kept
// here so the scroll arithmetic below and the component agree on one value.
export const LABEL_WIDTH_PX = 240
export const HEADER_HEIGHT_PX = 42

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

// 'YYYY-MM-DD' → '5 Oct' — the week-scale header label.
export function shortDayLabel(iso) {
  if (!isValidIsoDate(iso)) return ''
  const m = Number(iso.slice(5, 7))
  return `${Number(iso.slice(8, 10))} ${MONTH_ABBR[m - 1]}`
}

// Gridlines every 7 days from the window start.
//
// ⚠️ Aligned to the WINDOW START, not to Mondays: Constrapp defines no
// week-start convention and no working calendar, so a "Monday" gridline would
// be an invention. These are spacing marks, not working weeks. `label` is the
// tick's own date, shown in the week-scale header.
export function weekTicks(start, end, dayWidth = DAY_WIDTH_PX) {
  if (!isValidIsoDate(start) || !isValidIsoDate(end) || end < start) return []
  const total = daysBetween(start, end) + 1
  const ticks = []
  for (let offsetDays = 0; offsetDays < total; offsetDays += 7) {
    const iso = addDays(start, offsetDays)
    ticks.push({
      iso,
      offsetDays,
      x: offsetDays * dayWidth,
      width: Math.min(7, total - offsetDays) * dayWidth,
      label: shortDayLabel(iso),
    })
  }
  return ticks
}

// One tick per calendar day, labelled with the day of the month. Built ONLY
// for the day scale (the model leaves it empty otherwise), so a year at week
// or month zoom never carries 365 header cells.
export function dayTicks(start, end, dayWidth = DAY_WIDTH_PX) {
  if (!isValidIsoDate(start) || !isValidIsoDate(end) || end < start) return []
  const total = daysBetween(start, end) + 1
  const ticks = []
  for (let offsetDays = 0; offsetDays < total; offsetDays += 1) {
    const iso = addDays(start, offsetDays)
    ticks.push({
      iso,
      offsetDays,
      x: offsetDays * dayWidth,
      width: dayWidth,
      label: String(Number(iso.slice(8, 10))),
    })
  }
  return ticks
}

// ── Actual dates on the chart (ADR-64) ───────────────────────────────────────
//
// The planned bar is the plan; the ACTUAL overlay is what was recorded, drawn
// only from dates that exist. Nothing is invented:
//   · actualStart AND actualFinish (finish ≥ start) → a span
//   · actualStart only                             → a start marker, one day
//   · actualFinish only (a completed activity whose start was never recorded,
//     which rules permit)                          → a finish marker, one day
//   · a milestone with an actualFinish             → a "reached" marker
//   · neither                                      → nothing
// A span is clamped to the window exactly as the planned bar is.
export const ACTUAL_KIND = {
  SPAN:   'span',
  START:  'start',
  FINISH: 'finish',
}

export function actualSpan(a, window, dayWidth = DAY_WIDTH_PX) {
  if (!a || !window) return null
  const hasStart  = isValidIsoDate(a.actualStart)
  const hasFinish = isValidIsoDate(a.actualFinish)
  let kind
  let from
  let to
  if (a.isMilestone === true) {
    if (!hasFinish) return null
    kind = ACTUAL_KIND.FINISH; from = a.actualFinish; to = a.actualFinish
  } else if (hasStart && hasFinish && a.actualFinish >= a.actualStart) {
    kind = ACTUAL_KIND.SPAN; from = a.actualStart; to = a.actualFinish
  } else if (hasStart) {
    kind = ACTUAL_KIND.START; from = a.actualStart; to = a.actualStart
  } else if (hasFinish) {
    kind = ACTUAL_KIND.FINISH; from = a.actualFinish; to = a.actualFinish
  } else {
    return null
  }
  const span = clampSpan(from, to, window)
  if (!span) return null
  const offsetDays = daysBetween(window.start, span.from)
  const days = daysBetween(span.from, span.to) + 1
  return {
    kind,
    from,
    to,
    offsetDays,
    days,
    x: offsetDays * dayWidth,
    width: days * dayWidth,
    clippedStart: span.clippedStart,
    clippedEnd: span.clippedEnd,
  }
}

// Days the recorded finish differs from the CURRENT planned finish: positive
// when it finished later than the plan as it stands now, negative when earlier,
// null unless BOTH dates are valid. This is a comparison against the current
// plan — Constrapp stores no baseline, so it is never slippage against an
// approved programme, and the label below says so.
export function finishVarianceDays(a) {
  if (!a || !isValidIsoDate(a.actualFinish) || !isValidIsoDate(a.plannedFinish)) return null
  return daysBetween(a.plannedFinish, a.actualFinish)
}

export function planComparisonLabel(a) {
  const v = finishVarianceDays(a)
  if (v === null) return ''
  const what = a?.isMilestone ? 'Reached' : 'Finished'
  if (v === 0) return `${what} on the currently planned day`
  const n = Math.abs(v)
  const days = n === 1 ? '1 day' : `${n} days`
  return v > 0 ? `${what} ${days} after the current plan` : `${what} ${days} before the current plan`
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
  scale = GANTT_SCALE.DAY,
  dayWidth = dayWidthForScale(scale),
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
    scale,
    dayWidth,
    rowHeight,
    canvasWidth: 0,
    canvasHeight: 0,
    months: [],
    weeks: [],
    days: [],
    today: todayIso(now),
    todayOffsetDays: null,
    todayX: null,
    bars: [],
    barsById: new Map(),
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
      costCodeId: a.costCodeId ?? null,
      responsibleContactId: a.responsibleContactId ?? null,
      actualStart: isValidIsoDate(a.actualStart) ? a.actualStart : null,
      actualFinish: isValidIsoDate(a.actualFinish) ? a.actualFinish : null,

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
      // Recorded dates, drawn beneath the plan — only what exists (ADR-64).
      actual: actualSpan(a, window, dayWidth),
      finishVarianceDays: finishVarianceDays(a),
      planComparison: planComparisonLabel(a),
    })
  }

  return {
    window,
    start: window.start,
    end: window.end,
    totalDays,
    scale,
    dayWidth,
    rowHeight,
    canvasWidth,
    canvasHeight: bars.length * rowHeight,
    months: monthTicks(window.start, window.end, dayWidth),
    weeks: weekTicks(window.start, window.end, dayWidth),
    days: scale === GANTT_SCALE.DAY ? dayTicks(window.start, window.end, dayWidth) : [],
    today,
    todayOffsetDays: todayOffset,
    todayX: todayOffset === null ? null : todayOffset * dayWidth,
    bars,
    barsById: new Map(bars.map(b => [b.id, b])),
    excluded,
  }
}

// ── Rows: groups, collapse and vertical positions (ADR-64) ───────────────────
//
// The model above is built ONCE over the whole filtered programme — grouping
// and collapsing never move the window, the ticks or the today line. This
// turns the groups (lib/ganttGrouping.js) into the rows the component draws:
// a header row per group (none when ungrouped) followed by one row per DRAWN
// activity in that group, skipped while the group is collapsed. Every group
// header still carries its counts, so a collapsed group hides rows, never
// figures. Activities the model excluded (no usable planned dates) are not
// rows; the component lists them separately and the table remains the record.
export const GANTT_ROW = {
  GROUP: 'group',
  BAR:   'bar',
}

export function layoutGanttRows(model, groups, collapsedKeys = new Set(), { ungrouped = false } = {}) {
  const rows = []
  let y = 0
  const rowHeight = model?.rowHeight ?? ROW_HEIGHT_PX
  const barsById = model?.barsById ?? new Map()
  const collapsed = collapsedKeys instanceof Set ? collapsedKeys : new Set(collapsedKeys ?? [])

  for (const g of groups ?? []) {
    const drawn = (g.activities ?? []).map(a => barsById.get(a.id)).filter(Boolean)
    const isCollapsed = !ungrouped && collapsed.has(g.key)
    if (!ungrouped) {
      rows.push({
        type: GANTT_ROW.GROUP,
        key: g.key,
        label: g.label,
        hint: g.hint ?? '',
        count: g.count ?? (g.activities ?? []).length,
        overdueCount: g.overdueCount ?? 0,
        drawnCount: drawn.length,
        collapsed: isCollapsed,
        y,
      })
      y += rowHeight
    }
    if (isCollapsed) continue
    for (const bar of drawn) {
      rows.push({ type: GANTT_ROW.BAR, key: bar.id, bar, groupKey: g.key, y })
      y += rowHeight
    }
  }
  return { rows, height: y }
}

// ── Scroll to today ──────────────────────────────────────────────────────────
//
// The `scrollLeft` that centres the today line in the part of the scroller
// NOT covered by the sticky label column, clamped so the request never
// overshoots either end. null when today is outside the window — the control
// is then disabled rather than scrolling somewhere arbitrary.
export function todayScrollLeft({ todayX, canvasWidth, viewportWidth, labelWidth = LABEL_WIDTH_PX }) {
  if (!Number.isFinite(todayX) || !Number.isFinite(canvasWidth) || !Number.isFinite(viewportWidth)) return null
  const visible = Math.max(0, viewportWidth - labelWidth)
  const total = labelWidth + canvasWidth
  const maxLeft = Math.max(0, total - viewportWidth)
  const wanted = todayX - visible / 2
  return Math.round(Math.min(maxLeft, Math.max(0, wanted)))
}

// Re-exported so the component imports one module for geometry.
export { isValidIsoDate, isoToUtcMs, utcMsToIso }

// ── Dependency arrows (Constrapp GANTT™ 1A2, ADR-65) ─────────────────────────
//
// Pure geometry for the finish-to-start arrows the chart draws in ONE SVG
// overlay behind the bars. An arrow exists only when BOTH its rows are drawn
// (a collapsed group, a filter or an undrawable activity hides the row and
// therefore the arrow — the count of hidden links is reported, never lost).
// At most MAX_ARROWS_DRAWN arrows are produced: beyond that the chart draws
// none and says so, and every link stays readable in the activity detail.
//
// Worst case modelled: 2,000 activities × 20 predecessors = 40,000 links —
// far beyond a sensible SVG; a real programme carries a few hundred.
export const MAX_ARROWS_DRAWN = 1500
export const ARROW_ELBOW_PX = 8

const barEndX = (bar) => (bar.isMilestone ? bar.milestoneX + MILESTONE_SIZE_PX / 2 : bar.x + Math.max(bar.width, 1))
const barStartX = (bar) => (bar.isMilestone ? bar.milestoneX - MILESTONE_SIZE_PX / 2 : bar.x)

// `rows` from layoutGanttRows; `states` from lib/ganttDependencies.js →
// dependencyStates. Returns { arrows, total, hidden, truncated }.
export function dependencyArrows(rows, states, { rowHeight = ROW_HEIGHT_PX, limit = MAX_ARROWS_DRAWN } = {}) {
  const rowById = new Map()
  for (const r of rows ?? []) if (r.type === GANTT_ROW.BAR) rowById.set(r.bar.id, r)
  const arrows = []
  let total = 0
  let hidden = 0
  for (const r of rows ?? []) {
    if (r.type !== GANTT_ROW.BAR) continue
    const state = states?.get(r.bar.id)
    if (!state || state.count === 0) continue
    for (const e of state.entries) {
      total += 1
      const from = e.activityId ? rowById.get(e.activityId) : null
      if (!from) { hidden += 1; continue }
      arrows.push({
        key: `${e.activityId}->${r.bar.id}`,
        fromId: e.activityId,
        toId: r.bar.id,
        state: e.state,
        fromX: barEndX(from.bar),
        fromY: from.y + rowHeight / 2,
        toX: barStartX(r.bar),
        toY: r.y + rowHeight / 2,
      })
    }
  }
  const truncated = arrows.length > limit
  return { arrows: truncated ? [] : arrows, total, hidden, truncated, drawable: arrows.length }
}

// The SVG path for one arrow: out of the predecessor's end, an elbow, into
// the successor's start. When the successor starts at or before the
// predecessor's end (a conflict, or a lag-free same-day milestone), the path
// doubles back below the predecessor row so it never crosses its own bar.
export function arrowPath(a, { rowHeight = ROW_HEIGHT_PX, elbow = ARROW_ELBOW_PX } = {}) {
  const { fromX, fromY, toX, toY } = a
  if (toX >= fromX + elbow * 2) {
    const midX = fromX + elbow
    return `M${fromX} ${fromY} H${midX} V${toY} H${toX}`
  }
  const down = fromY + (toY >= fromY ? rowHeight / 2 : -rowHeight / 2)
  return `M${fromX} ${fromY} H${fromX + elbow} V${down} H${toX - elbow} V${toY} H${toX}`
}
