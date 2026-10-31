import { describe, it, expect } from 'vitest'
import {
  DAY_WIDTH_PX, ROW_HEIGHT_PX,
  monthStart, monthEnd, monthLabel, daysInMonth,
  isDrawable, ganttWindow, monthTicks, weekTicks, buildGanttModel,
  // ADR-64
  GANTT_SCALE, GANTT_SCALE_ORDER, GANTT_SCALE_LABELS, SCALE_DAY_WIDTH_PX, DEFAULT_GANTT_SCALE,
  isGanttScale, dayWidthForScale, dayTicks, shortDayLabel,
  actualSpan, finishVarianceDays, planComparisonLabel, ACTUAL_KIND,
  todayScrollLeft, LABEL_WIDTH_PX, HEADER_HEIGHT_PX,
} from '../../src/lib/timelineGantt'
import { ACTIVITY_STATUS } from '../../src/lib/projectTimeline'

// ── Gantt geometry unit tests (ADR-29) ───────────────────────────────────────
//
// Pure pixel arithmetic — no jsdom, no rendering, no charting library. The
// clock is always injected so the today marker is deterministic.
const NOW = new Date(2026, 9, 15) // 2026-10-15 local, in every timezone

const activity = (overrides = {}) => ({
  id: 'a1',
  name: 'Ground floor slab',
  isMilestone: false,
  status: ACTIVITY_STATUS.NOT_STARTED,
  plannedStart: '2026-10-05',
  plannedFinish: '2026-10-09',
  actualStart: null,
  actualFinish: null,
  percentComplete: 0,
  responsibleName: '',
  costCodeName: '',
  sortOrder: 10,
  ...overrides,
})

// ── Month helpers ────────────────────────────────────────────────────────────

describe('month helpers', () => {
  it('snaps to month boundaries', () => {
    expect(monthStart('2026-10-15')).toBe('2026-10-01')
    expect(monthEnd('2026-10-15')).toBe('2026-10-31')
    expect(monthEnd('2026-11-15')).toBe('2026-11-30')
    expect(monthEnd('2026-02-05')).toBe('2026-02-28')
    expect(monthEnd('2024-02-05')).toBe('2024-02-29') // leap year
    expect(monthStart('rubbish')).toBeNull()
    expect(monthEnd('rubbish')).toBeNull()
  })

  it('counts days in a month', () => {
    expect(daysInMonth(2026, 1)).toBe(31)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 4)).toBe(30)
  })

  it('labels a month without locale drift', () => {
    expect(monthLabel('2026-10-15')).toBe('Oct 2026')
    expect(monthLabel('2027-01-01')).toBe('Jan 2027')
    expect(monthLabel('')).toBe('')
  })
})

// ── Drawability ──────────────────────────────────────────────────────────────

describe('drawability', () => {
  it('needs a usable, correctly ordered planned span', () => {
    expect(isDrawable(activity())).toBe(true)
    expect(isDrawable(activity({ plannedStart: '' }))).toBe(false)
    expect(isDrawable(activity({ plannedFinish: 'x' }))).toBe(false)
    expect(isDrawable(activity({ plannedStart: '2026-10-09', plannedFinish: '2026-10-05' }))).toBe(false)
    expect(isDrawable(null)).toBe(false)
  })
})

// ── Visible window ───────────────────────────────────────────────────────────

describe('visible date range', () => {
  it('spans whole months around the programme', () => {
    const w = ganttWindow([
      activity({ plannedStart: '2026-10-05', plannedFinish: '2026-10-09' }),
      activity({ id: 'b', plannedStart: '2026-11-20', plannedFinish: '2026-12-04' }),
    ], NOW)
    expect(w).toEqual({ start: '2026-10-01', end: '2026-12-31' })
  })

  it('widens for actual dates that fall outside the plan', () => {
    const w = ganttWindow([
      activity({ plannedStart: '2026-10-05', plannedFinish: '2026-10-09', actualStart: '2026-09-28', actualFinish: '2026-11-02' }),
    ], NOW)
    expect(w).toEqual({ start: '2026-09-01', end: '2026-11-30' })
  })

  it('returns null when nothing is drawable', () => {
    expect(ganttWindow([], NOW)).toBeNull()
    expect(ganttWindow(undefined, NOW)).toBeNull()
    expect(ganttWindow([activity({ plannedStart: '' })], NOW)).toBeNull()
  })

  it('does not drag a year of empty columns just to show today', () => {
    // Programme finished long ago — the window stays on the programme.
    const w = ganttWindow([activity({ plannedStart: '2024-01-05', plannedFinish: '2024-01-09' })], NOW)
    expect(w).toEqual({ start: '2024-01-01', end: '2024-01-31' })
  })

  it('reaches out to today when the programme ended within a month', () => {
    const w = ganttWindow([activity({ plannedStart: '2026-09-20', plannedFinish: '2026-09-25' })], NOW)
    expect(w).toEqual({ start: '2026-09-01', end: '2026-10-31' })
  })

  it('reaches back to today when the programme starts within a month', () => {
    const w = ganttWindow([activity({ plannedStart: '2026-11-05', plannedFinish: '2026-11-09' })], NOW)
    expect(w).toEqual({ start: '2026-10-01', end: '2026-11-30' })
  })
})

// ── Ticks ────────────────────────────────────────────────────────────────────

describe('month ticks', () => {
  it('gives each calendar month its own real width', () => {
    const ticks = monthTicks('2026-10-01', '2026-12-31', 10)
    expect(ticks.map(t => t.key)).toEqual(['2026-10', '2026-11', '2026-12'])
    expect(ticks.map(t => t.days)).toEqual([31, 30, 31])
    expect(ticks.map(t => t.offsetDays)).toEqual([0, 31, 61])
    expect(ticks.map(t => t.x)).toEqual([0, 310, 610])
    expect(ticks.map(t => t.width)).toEqual([310, 300, 310])
    expect(ticks[0].label).toBe('Oct 2026')
  })

  it('clips a partial first and last month to the window', () => {
    const ticks = monthTicks('2026-10-15', '2026-11-10', 10)
    expect(ticks).toHaveLength(2)
    expect(ticks[0]).toMatchObject({ key: '2026-10', offsetDays: 0, days: 17 })
    expect(ticks[1]).toMatchObject({ key: '2026-11', offsetDays: 17, days: 10 })
  })

  it('handles a single-day window and crosses a year boundary', () => {
    expect(monthTicks('2026-10-15', '2026-10-15', 10)).toHaveLength(1)
    expect(monthTicks('2026-12-01', '2027-01-31', 10).map(t => t.key)).toEqual(['2026-12', '2027-01'])
  })

  it('returns nothing for an invalid or inverted window', () => {
    expect(monthTicks('2026-12-31', '2026-10-01', 10)).toEqual([])
    expect(monthTicks('bad', '2026-10-01', 10)).toEqual([])
  })
})

describe('week ticks', () => {
  it('marks every seventh day from the window start', () => {
    const ticks = weekTicks('2026-10-01', '2026-10-31', 10)
    expect(ticks.map(t => t.offsetDays)).toEqual([0, 7, 14, 21, 28])
    expect(ticks.map(t => t.iso)).toEqual([
      '2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29',
    ])
    expect(ticks.map(t => t.x)).toEqual([0, 70, 140, 210, 280])
  })

  it('always includes the opening tick and never overruns the window', () => {
    const ticks = weekTicks('2026-10-01', '2026-10-03', 10)
    expect(ticks).toHaveLength(1)
    expect(ticks[0].offsetDays).toBe(0)
    expect(weekTicks('2026-10-05', '2026-10-01', 10)).toEqual([])
  })
})

// ── The model ────────────────────────────────────────────────────────────────

describe('gantt model', () => {
  it('computes canvas width from whole days at the day width', () => {
    const m = buildGanttModel([activity()], { now: NOW, dayWidth: 10 })
    expect(m.start).toBe('2026-10-01')
    expect(m.end).toBe('2026-10-31')
    expect(m.totalDays).toBe(31)
    expect(m.canvasWidth).toBe(310)
    expect(m.canvasHeight).toBe(ROW_HEIGHT_PX)
  })

  it('places a bar at its offset with an inclusive width', () => {
    const m = buildGanttModel([activity({ plannedStart: '2026-10-05', plannedFinish: '2026-10-09' })], { now: NOW, dayWidth: 10 })
    const [bar] = m.bars
    expect(bar.offsetDays).toBe(4)
    expect(bar.x).toBe(40)
    expect(bar.days).toBe(5)      // 5th to 9th inclusive
    expect(bar.width).toBe(50)
    expect(bar.durationDays).toBe(5)
  })

  it('draws a single-day activity one column wide', () => {
    const m = buildGanttModel([activity({ plannedStart: '2026-10-05', plannedFinish: '2026-10-05' })], { now: NOW, dayWidth: 10 })
    expect(m.bars[0]).toMatchObject({ days: 1, width: 10 })
  })

  it('fills progress as a share of the drawn bar', () => {
    const m = buildGanttModel([activity({ percentComplete: 50 })], { now: NOW, dayWidth: 10 })
    expect(m.bars[0].progressWidth).toBe(25)   // 50% of a 50px bar
    const none = buildGanttModel([activity({ percentComplete: 0 })], { now: NOW, dayWidth: 10 })
    expect(none.bars[0].progressWidth).toBe(0)
  })

  it('clamps a nonsense percentage rather than drawing outside the bar', () => {
    const over  = buildGanttModel([activity({ percentComplete: 400 })], { now: NOW, dayWidth: 10 })
    const under = buildGanttModel([activity({ percentComplete: -50 })], { now: NOW, dayWidth: 10 })
    const nan   = buildGanttModel([activity({ percentComplete: 'x' })], { now: NOW, dayWidth: 10 })
    expect(over.bars[0].progressWidth).toBe(50)
    expect(under.bars[0].progressWidth).toBe(0)
    expect(nan.bars[0].percentComplete).toBe(0)
  })

  it('centres a milestone in its single day column', () => {
    const m = buildGanttModel([
      activity({ isMilestone: true, plannedStart: '2026-10-05', plannedFinish: '2026-10-05' }),
    ], { now: NOW, dayWidth: 10 })
    expect(m.bars[0].isMilestone).toBe(true)
    expect(m.bars[0].milestoneX).toBe(45)     // 4 days in, plus half a column
    expect(m.bars[0].durationDays).toBe(0)
  })

  it('marks today when it falls inside the window, and not when it does not', () => {
    const inside = buildGanttModel([activity()], { now: NOW, dayWidth: 10 })
    expect(inside.today).toBe('2026-10-15')
    expect(inside.todayOffsetDays).toBe(14)
    expect(inside.todayX).toBe(140)

    const outside = buildGanttModel([
      activity({ plannedStart: '2024-01-05', plannedFinish: '2024-01-09' }),
    ], { now: NOW, dayWidth: 10 })
    expect(outside.todayOffsetDays).toBeNull()
    expect(outside.todayX).toBeNull()
  })

  it('clips a bar to an explicit window and reports which end was cut', () => {
    const m = buildGanttModel([
      activity({ plannedStart: '2026-09-20', plannedFinish: '2026-11-10' }),
    ], { now: NOW, dayWidth: 10, window: { start: '2026-10-01', end: '2026-10-31' } })
    const [bar] = m.bars
    expect(bar.clippedStart).toBe(true)
    expect(bar.clippedEnd).toBe(true)
    expect(bar.x).toBe(0)
    expect(bar.days).toBe(31)
    expect(bar.width).toBe(310)
  })

  it('excludes a bar that falls entirely outside the window instead of drawing it at zero width', () => {
    const m = buildGanttModel([
      activity({ id: 'in',  plannedStart: '2026-10-05', plannedFinish: '2026-10-09' }),
      activity({ id: 'out', plannedStart: '2027-05-01', plannedFinish: '2027-05-09' }),
    ], { now: NOW, dayWidth: 10, window: { start: '2026-10-01', end: '2026-10-31' } })
    expect(m.bars.map(b => b.id)).toEqual(['in'])
    expect(m.excluded.map(a => a.id)).toEqual(['out'])
  })

  it('reports undrawable activities rather than silently dropping them', () => {
    const m = buildGanttModel([
      activity({ id: 'ok' }),
      activity({ id: 'nodates', plannedStart: '', plannedFinish: '' }),
      activity({ id: 'inverted', plannedStart: '2026-10-09', plannedFinish: '2026-10-05' }),
    ], { now: NOW, dayWidth: 10 })
    expect(m.bars.map(b => b.id)).toEqual(['ok'])
    expect(m.excluded.map(a => a.id).sort()).toEqual(['inverted', 'nodates'])
  })

  it('returns a safe empty model for an empty programme', () => {
    const m = buildGanttModel([], { now: NOW })
    expect(m.bars).toEqual([])
    expect(m.months).toEqual([])
    expect(m.weeks).toEqual([])
    expect(m.totalDays).toBe(0)
    expect(m.canvasWidth).toBe(0)
    expect(m.canvasHeight).toBe(0)
    expect(m.todayX).toBeNull()
    expect(m.window).toBeNull()
    expect(buildGanttModel(undefined, { now: NOW }).bars).toEqual([])
  })

  it('handles a single activity', () => {
    const m = buildGanttModel([activity()], { now: NOW })
    expect(m.bars).toHaveLength(1)
    expect(m.months).toHaveLength(1)
    expect(m.dayWidth).toBe(DAY_WIDTH_PX)
  })

  it('handles a programme made entirely of milestones', () => {
    const m = buildGanttModel([
      activity({ id: 'm1', isMilestone: true, plannedStart: '2026-10-05', plannedFinish: '2026-10-05', sortOrder: 10 }),
      activity({ id: 'm2', isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20', sortOrder: 20 }),
    ], { now: NOW, dayWidth: 10 })
    expect(m.bars.every(b => b.isMilestone)).toBe(true)
    expect(m.bars.every(b => b.days === 1)).toBe(true)
    expect(m.bars.map(b => b.milestoneX)).toEqual([45, 195])
  })

  it('orders rows exactly as the activity table does', () => {
    const m = buildGanttModel([
      activity({ id: 'second', sortOrder: 20 }),
      activity({ id: 'first',  sortOrder: 10 }),
    ], { now: NOW })
    expect(m.bars.map(b => b.id)).toEqual(['first', 'second'])
  })

  it('carries the labels the row needs, so status is never colour-only', () => {
    const m = buildGanttModel([
      activity({ status: ACTIVITY_STATUS.IN_PROGRESS, responsibleName: 'ABC Concrete', costCodeName: '02-100' }),
    ], { now: NOW })
    expect(m.bars[0].statusLabel).toBe('In progress')
    expect(m.bars[0].responsibleName).toBe('ABC Concrete')
    expect(m.bars[0].costCodeName).toBe('02-100')
  })

  it('flags overdue bars from the injected clock', () => {
    const late = buildGanttModel([activity({ plannedFinish: '2026-10-09' })], { now: NOW })
    expect(late.bars[0].isOverdue).toBe(true)
    const done = buildGanttModel([
      activity({ plannedFinish: '2026-10-09', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualFinish: '2026-10-09' }),
    ], { now: NOW })
    expect(done.bars[0].isOverdue).toBe(false)
    expect(done.bars[0].isCancelled).toBe(false)
  })

  it('never mutates the activities it is given', () => {
    const list = [activity({ id: 'b', sortOrder: 20 }), activity({ id: 'a', sortOrder: 10 })]
    const frozen = JSON.stringify(list)
    buildGanttModel(list, { now: NOW })
    expect(JSON.stringify(list)).toBe(frozen)
  })
})

// ── Constrapp GANTT™ (ADR-64): zoom, recorded dates, rows, scroll ────────────

describe('zoom scales — one geometry, three day widths', () => {
  it('day, week and month, each a day width; week is the default', () => {
    expect(GANTT_SCALE_ORDER).toEqual(['day', 'week', 'month'])
    expect(SCALE_DAY_WIDTH_PX).toEqual({ day: DAY_WIDTH_PX, week: 8, month: 3 })
    expect(DEFAULT_GANTT_SCALE).toBe(GANTT_SCALE.WEEK)
    for (const s of GANTT_SCALE_ORDER) expect(GANTT_SCALE_LABELS[s]).toBeTruthy()
    expect(isGanttScale('week')).toBe(true)
    expect(isGanttScale('year')).toBe(false)
    expect(dayWidthForScale('month')).toBe(3)
    expect(dayWidthForScale('nonsense')).toBe(DAY_WIDTH_PX)
  })

  it('every scale draws exactly the same dates: offsets scale with the day width and nothing else', () => {
    const list = [
      activity({ id: 'a', plannedStart: '2026-10-05', plannedFinish: '2026-10-09' }),
      activity({ id: 'm', isMilestone: true, plannedStart: '2026-11-20', plannedFinish: '2026-11-20', sortOrder: 20 }),
    ]
    const models = GANTT_SCALE_ORDER.map(scale => buildGanttModel(list, { now: NOW, scale }))
    for (const m of models) {
      expect(m.window).toEqual({ start: '2026-10-01', end: '2026-11-30' })
      expect(m.totalDays).toBe(61)
      expect(m.bars.map(b => b.offsetDays)).toEqual([4, 50])
      expect(m.bars[0].days).toBe(5)
      expect(m.todayOffsetDays).toBe(14)
      expect(m.canvasWidth).toBe(61 * m.dayWidth)
      expect(m.bars[0].x).toBe(4 * m.dayWidth)
      expect(m.bars[0].width).toBe(5 * m.dayWidth)
      expect(m.bars[1].milestoneX).toBe(50 * m.dayWidth + m.dayWidth / 2)
      expect(m.todayX).toBe(14 * m.dayWidth)
    }
    expect(models.map(m => m.scale)).toEqual(['day', 'week', 'month'])
    expect(models.map(m => m.dayWidth)).toEqual([22, 8, 3])
  })

  it('a single-day activity is one day wide at every scale', () => {
    for (const scale of GANTT_SCALE_ORDER) {
      const m = buildGanttModel([activity({ plannedStart: '2026-10-05', plannedFinish: '2026-10-05' })], { now: NOW, scale })
      expect(m.bars[0]).toMatchObject({ days: 1, width: m.dayWidth })
    }
  })

  it('day ticks exist only at day zoom; week ticks carry a date label; the model is otherwise identical', () => {
    const day   = buildGanttModel([activity()], { now: NOW, scale: 'day' })
    const week  = buildGanttModel([activity()], { now: NOW, scale: 'week' })
    const month = buildGanttModel([activity()], { now: NOW, scale: 'month' })
    expect(day.days).toHaveLength(31)
    expect(day.days[0]).toMatchObject({ iso: '2026-10-01', offsetDays: 0, x: 0, width: 22, label: '1' })
    expect(day.days[30]).toMatchObject({ iso: '2026-10-31', label: '31' })
    expect(week.days).toEqual([])
    expect(month.days).toEqual([])
    expect(week.weeks[0]).toMatchObject({ iso: '2026-10-01', label: '1 Oct', width: 56 })
    expect(week.weeks[4]).toMatchObject({ iso: '2026-10-29', width: 3 * 8 }) // the last partial week
    expect(shortDayLabel('2027-01-05')).toBe('5 Jan')
    expect(shortDayLabel('x')).toBe('')
  })

  it('day ticks cross a month and a year boundary with real month lengths', () => {
    const ticks = dayTicks('2026-12-30', '2027-01-02', 10)
    expect(ticks.map(t => t.label)).toEqual(['30', '31', '1', '2'])
    expect(ticks.map(t => t.x)).toEqual([0, 10, 20, 30])
    expect(dayTicks('2026-10-05', '2026-10-01', 10)).toEqual([])
  })

  it('zooming never touches the activities', () => {
    const list = [activity()]
    const frozen = JSON.stringify(list)
    for (const scale of GANTT_SCALE_ORDER) buildGanttModel(list, { now: NOW, scale })
    expect(JSON.stringify(list)).toBe(frozen)
  })
})

describe('recorded (actual) dates — drawn only from what exists', () => {
  const W = { start: '2026-10-01', end: '2026-10-31' }

  it('start and finish → a span, clamped like a planned bar', () => {
    const s = actualSpan(activity({ actualStart: '2026-10-06', actualFinish: '2026-10-12' }), W, 10)
    expect(s).toMatchObject({ kind: ACTUAL_KIND.SPAN, from: '2026-10-06', to: '2026-10-12', offsetDays: 5, days: 7, x: 50, width: 70, clippedStart: false, clippedEnd: false })
    const clipped = actualSpan(activity({ actualStart: '2026-09-20', actualFinish: '2026-10-03' }), W, 10)
    expect(clipped).toMatchObject({ kind: ACTUAL_KIND.SPAN, x: 0, days: 3, clippedStart: true })
  })

  it('start only → a one-day start marker; no finish is ever invented', () => {
    const s = actualSpan(activity({ actualStart: '2026-10-06' }), W, 10)
    expect(s).toMatchObject({ kind: ACTUAL_KIND.START, from: '2026-10-06', to: '2026-10-06', days: 1, x: 50, width: 10 })
  })

  it('finish only (a completed activity whose start was never recorded) → a finish marker', () => {
    const s = actualSpan(activity({ actualFinish: '2026-10-12', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100 }), W, 10)
    expect(s).toMatchObject({ kind: ACTUAL_KIND.FINISH, from: '2026-10-12', to: '2026-10-12', days: 1 })
  })

  it('a milestone draws a reached marker from its actual finish, and nothing from an actual start alone', () => {
    const reached = actualSpan(activity({ isMilestone: true, plannedStart: '2026-10-05', plannedFinish: '2026-10-05', actualFinish: '2026-10-07' }), W, 10)
    expect(reached).toMatchObject({ kind: ACTUAL_KIND.FINISH, from: '2026-10-07' })
    expect(actualSpan(activity({ isMilestone: true, actualStart: '2026-10-07' }), W, 10)).toBeNull()
  })

  it('nothing recorded, an invalid date, an inverted pair, or a span outside the window → nothing', () => {
    expect(actualSpan(activity(), W, 10)).toBeNull()
    expect(actualSpan(activity({ actualStart: '2026-02-30' }), W, 10)).toBeNull()
    // Inverted: the start is still a real recorded fact, the pair is not a span.
    expect(actualSpan(activity({ actualStart: '2026-10-12', actualFinish: '2026-10-06' }), W, 10)).toMatchObject({ kind: ACTUAL_KIND.START })
    expect(actualSpan(activity({ actualStart: '2027-03-01', actualFinish: '2027-03-05' }), W, 10)).toBeNull()
    expect(actualSpan(null, W, 10)).toBeNull()
    expect(actualSpan(activity({ actualStart: '2026-10-06' }), null, 10)).toBeNull()
  })

  it('the model carries the overlay and widens the window for it', () => {
    const m = buildGanttModel([activity({ actualStart: '2026-10-06', actualFinish: '2026-11-02' })], { now: NOW, dayWidth: 10 })
    expect(m.end).toBe('2026-11-30')
    expect(m.bars[0].actual).toMatchObject({ kind: ACTUAL_KIND.SPAN, days: 28 })
    expect(m.bars[0].actualStart).toBe('2026-10-06')
    expect(m.bars[0].actualFinish).toBe('2026-11-02')
    expect(buildGanttModel([activity()], { now: NOW }).bars[0].actual).toBeNull()
  })
})

describe('plan comparison — against the CURRENT plan, never a baseline', () => {
  it('needs BOTH a valid actual finish and a valid planned finish', () => {
    expect(finishVarianceDays(activity())).toBeNull()
    expect(finishVarianceDays(activity({ actualStart: '2026-10-05' }))).toBeNull()
    expect(finishVarianceDays(activity({ actualFinish: 'x' }))).toBeNull()
    expect(finishVarianceDays(activity({ plannedFinish: '', actualFinish: '2026-10-09' }))).toBeNull()
    expect(planComparisonLabel(activity())).toBe('')
  })

  it('measures late (positive), early (negative) and on the day', () => {
    expect(finishVarianceDays(activity({ actualFinish: '2026-10-12' }))).toBe(3)
    expect(finishVarianceDays(activity({ actualFinish: '2026-10-08' }))).toBe(-1)
    expect(finishVarianceDays(activity({ actualFinish: '2026-10-09' }))).toBe(0)
  })

  it('labels say "current plan", with singular and plural days, and "Reached" for a milestone', () => {
    expect(planComparisonLabel(activity({ actualFinish: '2026-10-12' }))).toBe('Finished 3 days after the current plan')
    expect(planComparisonLabel(activity({ actualFinish: '2026-10-08' }))).toBe('Finished 1 day before the current plan')
    expect(planComparisonLabel(activity({ actualFinish: '2026-10-09' }))).toBe('Finished on the currently planned day')
    expect(planComparisonLabel(activity({ isMilestone: true, plannedStart: '2026-10-05', plannedFinish: '2026-10-05', actualFinish: '2026-10-07' })))
      .toBe('Reached 2 days after the current plan')
    for (const a of [activity({ actualFinish: '2026-10-12' }), activity({ actualFinish: '2026-10-08' })]) {
      expect(planComparisonLabel(a)).not.toMatch(/baseline|slip/i)
    }
  })

  it('the model carries the comparison on each bar', () => {
    const m = buildGanttModel([activity({ actualStart: '2026-10-05', actualFinish: '2026-10-12', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100 })], { now: NOW })
    expect(m.bars[0].finishVarianceDays).toBe(3)
    expect(m.bars[0].planComparison).toBe('Finished 3 days after the current plan')
  })
})

describe('scroll to today', () => {
  it('centres the today line in the canvas area beside the sticky label column', () => {
    // 1000px viewport, 240px labels → 760px of canvas visible; today at 2000px.
    expect(todayScrollLeft({ todayX: 2000, canvasWidth: 5000, viewportWidth: 1000 })).toBe(2000 - 380)
    expect(LABEL_WIDTH_PX).toBe(240)
    expect(HEADER_HEIGHT_PX).toBe(42)
  })

  it('clamps at both ends and never scrolls past the content', () => {
    expect(todayScrollLeft({ todayX: 100, canvasWidth: 5000, viewportWidth: 1000 })).toBe(0)
    // total = 240 + 5000 = 5240; max scrollLeft = 4240.
    expect(todayScrollLeft({ todayX: 4990, canvasWidth: 5000, viewportWidth: 1000 })).toBe(4240)
    // Content narrower than the viewport → nothing to scroll.
    expect(todayScrollLeft({ todayX: 100, canvasWidth: 300, viewportWidth: 1000 })).toBe(0)
  })

  it('is null when today is outside the window or the inputs are unusable', () => {
    expect(todayScrollLeft({ todayX: null, canvasWidth: 5000, viewportWidth: 1000 })).toBeNull()
    expect(todayScrollLeft({ todayX: 10, canvasWidth: NaN, viewportWidth: 1000 })).toBeNull()
    const m = buildGanttModel([activity({ plannedStart: '2024-01-05', plannedFinish: '2024-01-09' })], { now: NOW })
    expect(todayScrollLeft({ todayX: m.todayX, canvasWidth: m.canvasWidth, viewportWidth: 1000 })).toBeNull()
  })
})

describe('the model as the chart reads it', () => {
  it('indexes bars by id and carries the join keys grouping needs', () => {
    const m = buildGanttModel([activity({ costCodeId: 'cc1', responsibleContactId: 'c1' })], { now: NOW })
    expect(m.barsById.get('a1')).toBe(m.bars[0])
    expect(m.bars[0]).toMatchObject({ costCodeId: 'cc1', responsibleContactId: 'c1' })
    expect(buildGanttModel([], { now: NOW }).barsById.size).toBe(0)
  })

  it('the legacy call shape (dayWidth only) still works and defaults to the day scale', () => {
    const m = buildGanttModel([activity()], { now: NOW, dayWidth: 10 })
    expect(m.scale).toBe('day')
    expect(m.dayWidth).toBe(10)
    expect(m.days).toHaveLength(31)
  })
})
