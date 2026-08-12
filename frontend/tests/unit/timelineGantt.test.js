import { describe, it, expect } from 'vitest'
import {
  DAY_WIDTH_PX, ROW_HEIGHT_PX,
  monthStart, monthEnd, monthLabel, daysInMonth,
  isDrawable, ganttWindow, monthTicks, weekTicks, buildGanttModel,
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
