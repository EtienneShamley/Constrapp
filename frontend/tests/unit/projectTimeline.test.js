import { describe, it, expect } from 'vitest'
import {
  ACTIVITY_STATUS, ACTIVITY_STATUS_ORDER, ACTIVITY_STATUS_LABELS, ACTIVITY_STATUS_BADGE,
  CREATABLE_STATUSES, CLOSED_STATUSES,
  isActivityStatus, isClosedStatus, isOpenStatus, isTerminalStatus, isCreatableStatus,
  canTransition, canEditTransition,
  PROGRAMME_READ_ROLES, PROGRAMME_WRITE_ROLES, canReadProgramme, canAuthorProgramme,
  isoToUtcMs, utcMsToIso, isValidIsoDate, daysBetween, addDays,
  activityDuration, actualDuration,
  isOverdue, daysLate, daysUntilDue, isDueWithin,
  ACTIVITY_GROUP, ACTIVITY_GROUP_ORDER, ACTIVITY_GROUP_LABELS,
  activityGroup, groupActivities,
  timelineSummary, DUE_SOON_DAYS,
  compareActivities, sortActivities, nextSortOrder,
  filterActivities, responsibleOptions,
  normaliseActivityDraft, validateActivityDraft, validateCancelReason, LIMITS,
  formatIsoDate, dueLabel, durationLabel,
} from '../../src/lib/projectTimeline'

// ── Project Timeline — pure domain unit tests (ADR-29) ───────────────────────
//
// No emulator, no jsdom, no React. Every date-relative assertion pins the clock
// with an injected `now`, so these tests do not rot as the calendar moves.
//
// NOW is constructed with the LOCAL Date constructor because todayIso() reads
// local calendar parts — this keeps the suite timezone-independent.
const NOW = new Date(2026, 9, 15) // 2026-10-15 local, in every timezone
const TODAY = '2026-10-15'

// A valid activity as the hook stores it.
const activity = (overrides = {}) => ({
  id: 'a1',
  name: 'Ground floor slab',
  description: '',
  isMilestone: false,
  status: ACTIVITY_STATUS.NOT_STARTED,
  plannedStart: '2026-10-20',
  plannedFinish: '2026-10-24',
  actualStart: null,
  actualFinish: null,
  percentComplete: 0,
  responsibleContactId: null,
  responsibleName: '',
  costCodeId: null,
  costCodeName: '',
  sortOrder: 10,
  notes: '',
  ...overrides,
})

// ── Status values ────────────────────────────────────────────────────────────

describe('status values', () => {
  it('exposes exactly the five approved statuses', () => {
    expect(ACTIVITY_STATUS_ORDER).toHaveLength(5)
    expect(new Set(ACTIVITY_STATUS_ORDER)).toEqual(new Set([
      'not_started', 'in_progress', 'on_hold', 'completed', 'cancelled',
    ]))
  })

  it('labels and badge variants cover every status', () => {
    for (const s of ACTIVITY_STATUS_ORDER) {
      expect(typeof ACTIVITY_STATUS_LABELS[s]).toBe('string')
      expect(ACTIVITY_STATUS_LABELS[s].length).toBeGreaterThan(0)
      expect(typeof ACTIVITY_STATUS_BADGE[s]).toBe('string')
    }
  })

  it('recognises only known statuses', () => {
    expect(isActivityStatus('in_progress')).toBe(true)
    expect(isActivityStatus('blocked')).toBe(false)
    expect(isActivityStatus('')).toBe(false)
    expect(isActivityStatus(undefined)).toBe(false)
  })

  it('classifies closed and open statuses', () => {
    expect(CLOSED_STATUSES).toEqual(['completed', 'cancelled'])
    expect(isClosedStatus('completed')).toBe(true)
    expect(isClosedStatus('cancelled')).toBe(true)
    expect(isClosedStatus('on_hold')).toBe(false)
    expect(isOpenStatus('on_hold')).toBe(true)
    expect(isOpenStatus('completed')).toBe(false)
    expect(isOpenStatus('nonsense')).toBe(false)
  })

  it('treats only cancelled as terminal', () => {
    expect(isTerminalStatus('cancelled')).toBe(true)
    expect(isTerminalStatus('completed')).toBe(false)
  })

  it('permits creation in any status except cancelled', () => {
    expect(CREATABLE_STATUSES).not.toContain('cancelled')
    expect(isCreatableStatus('not_started')).toBe(true)
    expect(isCreatableStatus('in_progress')).toBe(true)
    expect(isCreatableStatus('on_hold')).toBe(true)
    expect(isCreatableStatus('completed')).toBe(true)
    expect(isCreatableStatus('cancelled')).toBe(false)
  })
})

// ── Role helpers (UX only — rules are the boundary) ──────────────────────────

describe('role helpers', () => {
  it('lets the three internal roles READ the programme', () => {
    for (const role of ['company_admin', 'project_manager', 'qs']) {
      expect(canReadProgramme(role)).toBe(true)
    }
    expect(PROGRAMME_READ_ROLES).toHaveLength(3)
  })

  it('lets only company_admin and project_manager AUTHOR it — QS is READ-ONLY', () => {
    expect(canAuthorProgramme('company_admin')).toBe(true)
    expect(canAuthorProgramme('project_manager')).toBe(true)
    expect(canAuthorProgramme('qs')).toBe(false)
    expect(canReadProgramme('qs')).toBe(true)
    expect(PROGRAMME_WRITE_ROLES).toHaveLength(2)
  })

  it('denies subcontractor, client, super_admin and unknown roles entirely', () => {
    for (const role of ['subcontractor', 'client', 'super_admin', '', undefined, null]) {
      expect(canReadProgramme(role)).toBe(false)
      expect(canAuthorProgramme(role)).toBe(false)
    }
  })
})

// ── Transition legality ──────────────────────────────────────────────────────

describe('transition legality', () => {
  it('allows forward movement through the programme', () => {
    expect(canTransition('not_started', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'completed')).toBe(true)
    expect(canTransition('in_progress', 'on_hold')).toBe(true)
  })

  it('ALLOWS BACKWARDS correction — a programme is a plan, not an audit record', () => {
    expect(canTransition('completed', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'not_started')).toBe(true)
    expect(canTransition('on_hold', 'not_started')).toBe(true)
  })

  it('treats cancelled as terminal in both directions', () => {
    expect(canTransition('not_started', 'cancelled')).toBe(true)
    expect(canTransition('completed', 'cancelled')).toBe(true)
    expect(canTransition('cancelled', 'in_progress')).toBe(false)
    expect(canTransition('cancelled', 'completed')).toBe(false)
    expect(canTransition('cancelled', 'cancelled')).toBe(false)
  })

  it('rejects unknown statuses on either side', () => {
    expect(canTransition('blocked', 'completed')).toBe(false)
    expect(canTransition('in_progress', 'archived')).toBe(false)
  })

  it('excludes cancellation from the ordinary edit path', () => {
    expect(canEditTransition('in_progress', 'completed')).toBe(true)
    expect(canEditTransition('in_progress', 'cancelled')).toBe(false)
    expect(canEditTransition('cancelled', 'in_progress')).toBe(false)
  })
})

// ── ISO date validation ──────────────────────────────────────────────────────

describe('ISO date validation', () => {
  it('accepts well-formed real dates', () => {
    expect(isValidIsoDate('2026-10-15')).toBe(true)
    expect(isValidIsoDate('2024-02-29')).toBe(true) // leap year
  })

  it('rejects malformed shapes', () => {
    for (const bad of ['2026-10-5', '26-10-05', '2026/10/05', '2026-10-05T00:00:00', '', null, undefined, 20261005]) {
      expect(isValidIsoDate(bad)).toBe(false)
    }
  })

  it('rejects impossible calendar dates that Date.UTC would roll over', () => {
    expect(isValidIsoDate('2026-02-30')).toBe(false)
    expect(isValidIsoDate('2026-13-01')).toBe(false)
    expect(isValidIsoDate('2026-00-10')).toBe(false)
    expect(isValidIsoDate('2026-04-31')).toBe(false)
    expect(isValidIsoDate('2025-02-29')).toBe(false) // not a leap year
  })

  it('round-trips through UTC milliseconds without timezone drift', () => {
    expect(utcMsToIso(isoToUtcMs('2026-10-15'))).toBe('2026-10-15')
    expect(utcMsToIso(isoToUtcMs('2026-01-01'))).toBe('2026-01-01')
    expect(utcMsToIso(isoToUtcMs('2026-12-31'))).toBe('2026-12-31')
    expect(isoToUtcMs('nope')).toBeNull()
  })

  it('measures whole days between dates, including across DST and year ends', () => {
    expect(daysBetween('2026-10-15', '2026-10-15')).toBe(0)
    expect(daysBetween('2026-10-15', '2026-10-16')).toBe(1)
    expect(daysBetween('2026-10-16', '2026-10-15')).toBe(-1)
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    // Southern-hemisphere DST start (AEDT) and northern DST end both fall here.
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31)
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31)
    expect(daysBetween('bad', '2026-10-15')).toBeNull()
  })

  it('adds and subtracts days', () => {
    expect(addDays('2026-10-15', 1)).toBe('2026-10-16')
    expect(addDays('2026-10-15', -1)).toBe('2026-10-14')
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-10-15', 0)).toBe('2026-10-15')
    expect(addDays('bad', 1)).toBeNull()
  })
})

// ── Duration ─────────────────────────────────────────────────────────────────

describe('duration', () => {
  it('counts the finish date INCLUSIVELY', () => {
    expect(activityDuration(activity({ plannedStart: '2026-10-20', plannedFinish: '2026-10-24' }))).toBe(5)
    expect(activityDuration(activity({ plannedStart: '2026-10-20', plannedFinish: '2026-10-20' }))).toBe(1)
  })

  it('reports a milestone as ZERO days, not one', () => {
    expect(activityDuration(activity({
      isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20',
    }))).toBe(0)
  })

  it('returns null for unusable or inverted dates', () => {
    expect(activityDuration(activity({ plannedFinish: 'bad' }))).toBeNull()
    expect(activityDuration(activity({ plannedStart: '2026-10-24', plannedFinish: '2026-10-20' }))).toBeNull()
    expect(activityDuration(null)).toBeNull()
  })

  it('measures actual duration only once both actual dates exist', () => {
    expect(actualDuration(activity({ actualStart: '2026-10-19', actualFinish: '2026-10-26' }))).toBe(8)
    expect(actualDuration(activity({ actualStart: '2026-10-19', actualFinish: null }))).toBeNull()
    expect(actualDuration(activity({ isMilestone: true, actualFinish: '2026-10-20' }))).toBe(0)
  })

  it('counts calendar days — weekends are not modelled', () => {
    // Fri 2026-10-16 → Mon 2026-10-19 is 4 calendar days, not 2 working days.
    expect(activityDuration(activity({ plannedStart: '2026-10-16', plannedFinish: '2026-10-19' }))).toBe(4)
  })
})

// ── Overdue ──────────────────────────────────────────────────────────────────

describe('overdue', () => {
  it('is true only when the planned finish has passed and work is open', () => {
    expect(isOverdue(activity({ plannedFinish: '2026-10-14' }), NOW)).toBe(true)
    expect(isOverdue(activity({ plannedFinish: TODAY }), NOW)).toBe(false)
    expect(isOverdue(activity({ plannedFinish: '2026-10-16' }), NOW)).toBe(false)
  })

  it('is never true for completed or cancelled work', () => {
    expect(isOverdue(activity({ plannedFinish: '2026-01-01', status: ACTIVITY_STATUS.COMPLETED }), NOW)).toBe(false)
    expect(isOverdue(activity({ plannedFinish: '2026-01-01', status: ACTIVITY_STATUS.CANCELLED }), NOW)).toBe(false)
  })

  it('is true for on-hold work that has passed its planned finish', () => {
    expect(isOverdue(activity({ plannedFinish: '2026-10-01', status: ACTIVITY_STATUS.ON_HOLD }), NOW)).toBe(true)
  })

  it('is false when the planned finish is unusable', () => {
    expect(isOverdue(activity({ plannedFinish: '' }), NOW)).toBe(false)
    expect(isOverdue(null, NOW)).toBe(false)
  })

  it('reports days late, and null when not late', () => {
    expect(daysLate(activity({ plannedFinish: '2026-10-14' }), NOW)).toBe(1)
    expect(daysLate(activity({ plannedFinish: '2026-09-15' }), NOW)).toBe(30)
    expect(daysLate(activity({ plannedFinish: TODAY }), NOW)).toBeNull()
  })

  it('is derived from the injected clock only — the same activity flips with now', () => {
    const a = activity({ plannedFinish: '2026-10-20' })
    expect(isOverdue(a, new Date(2026, 9, 19))).toBe(false)
    expect(isOverdue(a, new Date(2026, 9, 20))).toBe(false)
    expect(isOverdue(a, new Date(2026, 9, 21))).toBe(true)
  })
})

// ── Due soon ─────────────────────────────────────────────────────────────────

describe('due soon', () => {
  it('counts days until the planned finish', () => {
    expect(daysUntilDue(activity({ plannedFinish: TODAY }), NOW)).toBe(0)
    expect(daysUntilDue(activity({ plannedFinish: '2026-10-20' }), NOW)).toBe(5)
    expect(daysUntilDue(activity({ plannedFinish: '2026-10-10' }), NOW)).toBe(-5)
    expect(daysUntilDue(activity({ plannedFinish: 'x' }), NOW)).toBeNull()
  })

  it('includes today and the boundary day in the window, excluding the day after', () => {
    expect(isDueWithin(activity({ plannedFinish: TODAY }), 14, NOW)).toBe(true)
    expect(isDueWithin(activity({ plannedFinish: '2026-10-29' }), 14, NOW)).toBe(true)
    expect(isDueWithin(activity({ plannedFinish: '2026-10-30' }), 14, NOW)).toBe(false)
  })

  it('excludes overdue and closed work from the due-soon window', () => {
    expect(isDueWithin(activity({ plannedFinish: '2026-10-14' }), 14, NOW)).toBe(false)
    expect(isDueWithin(activity({ plannedFinish: '2026-10-20', status: ACTIVITY_STATUS.COMPLETED }), 14, NOW)).toBe(false)
  })
})

// ── Grouping ─────────────────────────────────────────────────────────────────

describe('grouping', () => {
  it('places activities in the expected rolling windows', () => {
    expect(activityGroup(activity({ plannedFinish: '2026-10-14' }), NOW)).toBe(ACTIVITY_GROUP.OVERDUE)
    expect(activityGroup(activity({ plannedFinish: TODAY }), NOW)).toBe(ACTIVITY_GROUP.THIS_WEEK)
    expect(activityGroup(activity({ plannedFinish: '2026-10-21' }), NOW)).toBe(ACTIVITY_GROUP.THIS_WEEK)
    expect(activityGroup(activity({ plannedFinish: '2026-10-22' }), NOW)).toBe(ACTIVITY_GROUP.UPCOMING)
    expect(activityGroup(activity({ plannedFinish: '2026-11-11' }), NOW)).toBe(ACTIVITY_GROUP.UPCOMING)
    expect(activityGroup(activity({ plannedFinish: '2026-11-12' }), NOW)).toBe(ACTIVITY_GROUP.LATER)
  })

  it('sends completed and cancelled work to the closed group regardless of dates', () => {
    expect(activityGroup(activity({ plannedFinish: '2026-01-01', status: ACTIVITY_STATUS.COMPLETED }), NOW))
      .toBe(ACTIVITY_GROUP.CLOSED)
    expect(activityGroup(activity({ plannedFinish: '2027-01-01', status: ACTIVITY_STATUS.CANCELLED }), NOW))
      .toBe(ACTIVITY_GROUP.CLOSED)
  })

  it('parks an open activity with an unusable finish in Later rather than dropping it', () => {
    expect(activityGroup(activity({ plannedFinish: '' }), NOW)).toBe(ACTIVITY_GROUP.LATER)
  })

  it('always returns every group key, sorted, and loses nothing', () => {
    const list = [
      activity({ id: 'x', plannedFinish: '2026-10-01' }),
      activity({ id: 'y', plannedFinish: '2026-10-16' }),
      activity({ id: 'z', plannedFinish: '2027-06-01' }),
      activity({ id: 'w', status: ACTIVITY_STATUS.CANCELLED }),
    ]
    const groups = groupActivities(list, NOW)
    expect(Object.keys(groups).sort()).toEqual([...ACTIVITY_GROUP_ORDER].sort())
    const total = ACTIVITY_GROUP_ORDER.reduce((n, k) => n + groups[k].length, 0)
    expect(total).toBe(4)
    expect(groups[ACTIVITY_GROUP.OVERDUE].map(a => a.id)).toEqual(['x'])
    expect(groups[ACTIVITY_GROUP.CLOSED].map(a => a.id)).toEqual(['w'])
    expect(ACTIVITY_GROUP_LABELS[ACTIVITY_GROUP.CLOSED]).toBe('Completed / Cancelled')
  })

  it('handles an empty list', () => {
    const groups = groupActivities([], NOW)
    for (const k of ACTIVITY_GROUP_ORDER) expect(groups[k]).toEqual([])
    expect(groupActivities(undefined, NOW)[ACTIVITY_GROUP.LATER]).toEqual([])
  })
})

// ── Summary ──────────────────────────────────────────────────────────────────

describe('summary', () => {
  it('counts overdue, due soon, in progress and remaining milestones', () => {
    const list = [
      activity({ id: '1', plannedFinish: '2026-10-01' }),                                   // overdue
      activity({ id: '2', plannedFinish: '2026-10-20', status: ACTIVITY_STATUS.IN_PROGRESS, actualStart: '2026-10-18' }),
      activity({ id: '3', plannedFinish: '2026-10-20', isMilestone: true, plannedStart: '2026-10-20' }),
      activity({ id: '4', plannedFinish: '2026-12-20' }),                                   // later
      activity({ id: '5', plannedFinish: '2026-09-01', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualFinish: '2026-09-02' }),
      activity({ id: '6', plannedFinish: '2026-10-20', isMilestone: true, plannedStart: '2026-10-20', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualFinish: '2026-10-19' }),
    ]
    const s = timelineSummary(list, NOW)
    expect(s.total).toBe(6)
    expect(s.overdue).toBe(1)
    // ids 2 and 3 only: id 1 is already overdue, id 4 is beyond the window, and
    // the two completed activities are closed.
    expect(s.dueSoon).toBe(2)
    expect(s.inProgress).toBe(1)
    expect(s.milestonesRemaining).toBe(1)
    expect(s.completed).toBe(2)
    expect(s.open).toBe(4)
    expect(s.dueSoonDays).toBe(DUE_SOON_DAYS)
  })

  it('returns zeroes for an empty programme', () => {
    const s = timelineSummary([], NOW)
    expect(s).toMatchObject({ total: 0, open: 0, completed: 0, overdue: 0, dueSoon: 0, inProgress: 0, milestonesRemaining: 0 })
  })
})

// ── Deterministic sorting ────────────────────────────────────────────────────

describe('deterministic sorting', () => {
  it('orders by sortOrder first', () => {
    const list = [activity({ id: 'b', sortOrder: 20 }), activity({ id: 'a', sortOrder: 10 })]
    expect(sortActivities(list).map(a => a.id)).toEqual(['a', 'b'])
  })

  it('breaks sortOrder TIES deterministically — start, finish, name, id', () => {
    const list = [
      activity({ id: 'd', sortOrder: 10, plannedStart: '2026-10-20', plannedFinish: '2026-10-24', name: 'Zulu' }),
      activity({ id: 'c', sortOrder: 10, plannedStart: '2026-10-20', plannedFinish: '2026-10-24', name: 'Alpha' }),
      activity({ id: 'b', sortOrder: 10, plannedStart: '2026-10-20', plannedFinish: '2026-10-22' }),
      activity({ id: 'a', sortOrder: 10, plannedStart: '2026-10-19' }),
    ]
    expect(sortActivities(list).map(a => a.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('breaks a total tie on document id, so ordering is stable across renders', () => {
    const base = { sortOrder: 10, plannedStart: '2026-10-20', plannedFinish: '2026-10-24', name: 'Same' }
    const one = sortActivities([activity({ id: 'zz', ...base }), activity({ id: 'aa', ...base })])
    const two = sortActivities([activity({ id: 'aa', ...base }), activity({ id: 'zz', ...base })])
    expect(one.map(a => a.id)).toEqual(['aa', 'zz'])
    expect(two.map(a => a.id)).toEqual(['aa', 'zz'])
  })

  it('sorts undated activities last and missing sortOrder to the end', () => {
    const list = [
      activity({ id: 'none', sortOrder: undefined }),
      activity({ id: 'undated', sortOrder: 10, plannedStart: '' }),
      activity({ id: 'dated', sortOrder: 10, plannedStart: '2026-10-01' }),
    ]
    expect(sortActivities(list).map(a => a.id)).toEqual(['dated', 'undated', 'none'])
  })

  it('NEVER sorts the caller list in place', () => {
    const list = [activity({ id: 'b', sortOrder: 20 }), activity({ id: 'a', sortOrder: 10 })]
    const snapshot = list.map(a => a.id)
    sortActivities(list)
    expect(list.map(a => a.id)).toEqual(snapshot)
  })

  it('compareActivities is consistent with sortActivities', () => {
    const a = activity({ id: 'a', sortOrder: 10 })
    const b = activity({ id: 'b', sortOrder: 20 })
    expect(compareActivities(a, b)).toBeLessThan(0)
    expect(compareActivities(b, a)).toBeGreaterThan(0)
    expect(compareActivities(a, a)).toBe(0)
  })

  it('suggests the next sortOrder without claiming uniqueness', () => {
    expect(nextSortOrder([])).toBe(10)
    expect(nextSortOrder(undefined)).toBe(10)
    expect(nextSortOrder([activity({ sortOrder: 10 }), activity({ sortOrder: 30 })])).toBe(40)
    expect(nextSortOrder([activity({ sortOrder: undefined })])).toBe(10)
  })
})

// ── Filtering ────────────────────────────────────────────────────────────────

describe('filtering', () => {
  const list = [
    activity({ id: '1', name: 'Slab pour', responsibleContactId: 'c1', responsibleName: 'ABC Concrete' }),
    activity({ id: '2', name: 'Roof frame', status: ACTIVITY_STATUS.IN_PROGRESS, actualStart: '2026-10-10', responsibleContactId: 'c2', responsibleName: 'Truss Co' }),
    activity({ id: '3', name: 'Handover', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualFinish: '2026-10-01' }),
    activity({ id: '4', name: 'Fitout', status: ACTIVITY_STATUS.CANCELLED, plannedFinish: '2026-10-01' }),
    activity({ id: '5', name: 'Excavation', plannedFinish: '2026-10-01', costCodeName: '02-100 — Earthworks' }),
  ]

  it('returns everything with no filters', () => {
    expect(filterActivities(list, {}, NOW)).toHaveLength(5)
    expect(filterActivities(list, undefined, NOW)).toHaveLength(5)
  })

  it('searches name, description, notes, responsible and cost code', () => {
    expect(filterActivities(list, { search: 'roof' }, NOW).map(a => a.id)).toEqual(['2'])
    expect(filterActivities(list, { search: 'TRUSS' }, NOW).map(a => a.id)).toEqual(['2'])
    expect(filterActivities(list, { search: 'earthworks' }, NOW).map(a => a.id)).toEqual(['5'])
    expect(filterActivities(list, { search: '   ' }, NOW)).toHaveLength(5)
    expect(filterActivities(list, { search: 'nothing here' }, NOW)).toEqual([])
  })

  it('filters by status and by responsible contact', () => {
    expect(filterActivities(list, { status: ACTIVITY_STATUS.IN_PROGRESS }, NOW).map(a => a.id)).toEqual(['2'])
    expect(filterActivities(list, { responsibleContactId: 'c1' }, NOW).map(a => a.id)).toEqual(['1'])
  })

  it('hides completed and cancelled together', () => {
    expect(filterActivities(list, { hideClosed: true }, NOW).map(a => a.id)).toEqual(['1', '2', '5'])
  })

  it('filters to overdue only', () => {
    // id 5 is open and past its planned finish; id 4 is cancelled so never overdue.
    expect(filterActivities(list, { overdueOnly: true }, NOW).map(a => a.id)).toEqual(['5'])
  })

  it('combines filters', () => {
    expect(filterActivities(list, { hideClosed: true, search: 'a' }, NOW).map(a => a.id)).toEqual(['1', '2', '5'])
  })

  it('lists the responsible parties present, de-duplicated and name-sorted', () => {
    expect(responsibleOptions(list)).toEqual([
      { id: 'c1', name: 'ABC Concrete' },
      { id: 'c2', name: 'Truss Co' },
    ])
    expect(responsibleOptions([])).toEqual([])
  })
})

// ── Draft normalisation ──────────────────────────────────────────────────────

describe('draft normalisation', () => {
  it('trims and bounds text, and never mutates the input', () => {
    const draft = {
      name: '  Slab pour  ', description: ' d ', notes: ' n ',
      status: ACTIVITY_STATUS.NOT_STARTED,
      plannedStart: ' 2026-10-20 ', plannedFinish: ' 2026-10-24 ',
      percentComplete: 0, sortOrder: 10,
    }
    const frozen = JSON.stringify(draft)
    const d = normaliseActivityDraft(draft)
    expect(d.name).toBe('Slab pour')
    expect(d.description).toBe('d')
    expect(d.notes).toBe('n')
    expect(d.plannedStart).toBe('2026-10-20')
    expect(JSON.stringify(draft)).toBe(frozen)
  })

  it('caps over-long strings at the documented limits', () => {
    const d = normaliseActivityDraft({
      name: 'x'.repeat(500), description: 'y'.repeat(5000), notes: 'z'.repeat(5000),
      status: ACTIVITY_STATUS.NOT_STARTED, plannedStart: '2026-10-20', plannedFinish: '2026-10-20',
      percentComplete: 0,
    })
    expect(d.name).toHaveLength(LIMITS.name)
    expect(d.description).toHaveLength(LIMITS.description)
    expect(d.notes).toHaveLength(LIMITS.notes)
  })

  it('forces a milestone finish to equal its start', () => {
    const d = normaliseActivityDraft({
      name: 'PC', isMilestone: true, status: ACTIVITY_STATUS.NOT_STARTED,
      plannedStart: '2026-11-30', plannedFinish: '2027-01-01', percentComplete: 0,
    })
    expect(d.plannedFinish).toBe('2026-11-30')
  })

  it('normalises the contact and cost-code pairs to both-null or both-present', () => {
    const none = normaliseActivityDraft({ name: 'a', status: 'not_started', plannedStart: '2026-10-20', plannedFinish: '2026-10-20', percentComplete: 0 })
    expect(none.responsibleContactId).toBeNull()
    expect(none.responsibleName).toBe('')
    expect(none.costCodeId).toBeNull()
    expect(none.costCodeName).toBe('')

    const both = normaliseActivityDraft({
      name: 'a', status: 'not_started', plannedStart: '2026-10-20', plannedFinish: '2026-10-20', percentComplete: 0,
      responsibleContactId: 'c1', responsibleName: ' ABC ', costCodeId: 'cc1', costCodeName: ' 02-100 ',
    })
    expect(both).toMatchObject({ responsibleContactId: 'c1', responsibleName: 'ABC', costCodeId: 'cc1', costCodeName: '02-100' })

    // A name with no id is dropped — the pair can never be half-set.
    const orphan = normaliseActivityDraft({ name: 'a', status: 'not_started', plannedStart: '2026-10-20', plannedFinish: '2026-10-20', percentComplete: 0, responsibleName: 'Ghost' })
    expect(orphan.responsibleName).toBe('')
  })

  it('nulls unusable actual dates and truncates a fractional percentage', () => {
    const d = normaliseActivityDraft({
      name: 'a', status: 'in_progress', plannedStart: '2026-10-20', plannedFinish: '2026-10-24',
      actualStart: '2026-10-20', actualFinish: 'rubbish', percentComplete: 42.7,
    })
    expect(d.actualStart).toBe('2026-10-20')
    expect(d.actualFinish).toBeNull()
    expect(d.percentComplete).toBe(42)
  })
})

// ── Draft validation ─────────────────────────────────────────────────────────

describe('draft validation', () => {
  const good = {
    name: 'Slab pour', description: '', notes: '',
    isMilestone: false, status: ACTIVITY_STATUS.NOT_STARTED,
    plannedStart: '2026-10-20', plannedFinish: '2026-10-24',
    actualStart: null, actualFinish: null,
    percentComplete: 0, sortOrder: 10,
  }

  it('accepts a valid draft', () => {
    expect(validateActivityDraft(good)).toBeNull()
    expect(validateActivityDraft(good, { creating: true })).toBeNull()
  })

  it('requires a name within the limit', () => {
    expect(validateActivityDraft({ ...good, name: '   ' })).toMatch(/name/i)
    expect(validateActivityDraft({ ...good, name: 'x'.repeat(LIMITS.name + 1) })).toMatch(/120 characters/)
  })

  it('requires a known status and refuses cancellation through the edit path', () => {
    expect(validateActivityDraft({ ...good, status: 'blocked' })).toMatch(/status/i)
    expect(validateActivityDraft({ ...good, status: ACTIVITY_STATUS.CANCELLED })).toMatch(/records a reason/)
  })

  it('requires both planned dates in the right order', () => {
    expect(validateActivityDraft({ ...good, plannedStart: '' })).toMatch(/planned start/i)
    expect(validateActivityDraft({ ...good, plannedFinish: '' })).toMatch(/planned finish/i)
    expect(validateActivityDraft({ ...good, plannedStart: '2026-10-24', plannedFinish: '2026-10-20' }))
      .toMatch(/finish cannot be before/i)
    expect(validateActivityDraft({ ...good, plannedStart: '2026-02-30' })).toMatch(/planned start/i)
  })

  it('accepts a same-day activity (finish is inclusive)', () => {
    expect(validateActivityDraft({ ...good, plannedStart: '2026-10-20', plannedFinish: '2026-10-20' })).toBeNull()
  })

  it('enforces the milestone single-day and 0/100 rules', () => {
    expect(validateActivityDraft({ ...good, isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20' })).toBeNull()
    expect(validateActivityDraft({ ...good, isMilestone: true, plannedStart: '', plannedFinish: '' })).toMatch(/milestone date/i)
    expect(validateActivityDraft({
      ...good, isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20', percentComplete: 50,
    })).toMatch(/not reached/)
    expect(validateActivityDraft({
      ...good, isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20',
      status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualFinish: '2026-10-20',
    })).toBeNull()
  })

  it('validates actual date shape and ordering', () => {
    expect(validateActivityDraft({ ...good, status: ACTIVITY_STATUS.IN_PROGRESS, actualStart: 'x' })).toMatch(/actual start/i)
    expect(validateActivityDraft({
      ...good, status: ACTIVITY_STATUS.IN_PROGRESS, actualStart: '2026-10-20', actualFinish: '2026-10-19',
    })).toMatch(/actual finish cannot be before/i)
  })

  it('bounds the percentage and requires a whole number', () => {
    expect(validateActivityDraft({ ...good, percentComplete: -1 })).toMatch(/between 0 and 100/)
    expect(validateActivityDraft({ ...good, percentComplete: 101 })).toMatch(/between 0 and 100/)
    expect(validateActivityDraft({ ...good, percentComplete: 12.5 })).toMatch(/whole number/)
    expect(validateActivityDraft({ ...good, percentComplete: 'abc' })).toMatch(/whole number/)
  })

  it('enforces the not_started invariants', () => {
    expect(validateActivityDraft({ ...good, percentComplete: 10 })).toMatch(/0% complete/)
    expect(validateActivityDraft({ ...good, actualStart: '2026-10-20' })).toMatch(/no actual start/)
    expect(validateActivityDraft({ ...good, actualFinish: '2026-10-20' })).toMatch(/no actual finish/)
  })

  it('enforces the in_progress invariant', () => {
    expect(validateActivityDraft({ ...good, status: ACTIVITY_STATUS.IN_PROGRESS, percentComplete: 40 }))
      .toMatch(/actual start date/)
    expect(validateActivityDraft({
      ...good, status: ACTIVITY_STATUS.IN_PROGRESS, percentComplete: 40, actualStart: '2026-10-20',
    })).toBeNull()
  })

  it('enforces the completed invariants', () => {
    expect(validateActivityDraft({
      ...good, status: ACTIVITY_STATUS.COMPLETED, percentComplete: 90, actualFinish: '2026-10-24',
    })).toMatch(/100% complete/)
    expect(validateActivityDraft({
      ...good, status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100,
    })).toMatch(/actual finish date/)
    expect(validateActivityDraft({
      ...good, status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualFinish: '2026-10-24',
    })).toBeNull()
  })

  it('allows on_hold to keep its progress and actual start', () => {
    expect(validateActivityDraft({
      ...good, status: ACTIVITY_STATUS.ON_HOLD, percentComplete: 45, actualStart: '2026-10-18',
    })).toBeNull()
  })

  it('requires the contact and cost-code pairs to be complete', () => {
    expect(validateActivityDraft({ ...good, responsibleContactId: 'c1', responsibleName: '   ' })).toMatch(/responsible contact/)
    expect(validateActivityDraft({ ...good, costCodeId: 'cc1', costCodeName: '' })).toMatch(/cost code/)
    expect(validateActivityDraft({ ...good, responsibleContactId: 'c1', responsibleName: 'ABC', costCodeId: 'cc1', costCodeName: '02-100' })).toBeNull()
  })

  it('does not mutate the draft it validates', () => {
    const draft = { ...good, name: '  Slab  ' }
    const frozen = JSON.stringify(draft)
    validateActivityDraft(draft)
    expect(JSON.stringify(draft)).toBe(frozen)
  })

  it('validates a cancellation reason', () => {
    expect(validateCancelReason('Descoped by client')).toBeNull()
    expect(validateCancelReason('   ')).toMatch(/reason/i)
    expect(validateCancelReason('')).toMatch(/reason/i)
    expect(validateCancelReason(null)).toMatch(/reason/i)
    expect(validateCancelReason('x'.repeat(LIMITS.cancelReason + 1))).toMatch(/or fewer/)
  })
})

// ── Presentation helpers ─────────────────────────────────────────────────────

describe('presentation helpers', () => {
  it('formats a programme date, and renders an em dash for an unusable one', () => {
    expect(formatIsoDate('2026-10-15')).toBe('15/10/2026')
    expect(formatIsoDate('')).toBe('—')
    expect(formatIsoDate(null)).toBe('—')
  })

  it('describes the due state in plain language', () => {
    expect(dueLabel(activity({ plannedFinish: '2026-10-14' }), NOW)).toBe('1 day late')
    expect(dueLabel(activity({ plannedFinish: '2026-10-05' }), NOW)).toBe('10 days late')
    expect(dueLabel(activity({ plannedFinish: TODAY }), NOW)).toBe('Due today')
    expect(dueLabel(activity({ plannedFinish: '2026-10-16' }), NOW)).toBe('Due tomorrow')
    expect(dueLabel(activity({ plannedFinish: '2026-10-20' }), NOW)).toBe('Due in 5 days')
    expect(dueLabel(activity({ plannedFinish: '' }), NOW)).toBe('No planned finish')
  })

  it('describes closed activities without a due phrase', () => {
    expect(dueLabel(activity({ status: ACTIVITY_STATUS.CANCELLED }), NOW)).toBe('Cancelled')
    expect(dueLabel(activity({ status: ACTIVITY_STATUS.COMPLETED, actualFinish: '2026-10-12' }), NOW))
      .toBe('Finished 12/10/2026')
    expect(dueLabel(activity({ status: ACTIVITY_STATUS.COMPLETED }), NOW)).toBe('Completed')
  })

  it('labels duration in calendar days and marks milestones', () => {
    expect(durationLabel(activity({ plannedStart: '2026-10-20', plannedFinish: '2026-10-20' }))).toBe('1 day')
    expect(durationLabel(activity({ plannedStart: '2026-10-20', plannedFinish: '2026-10-24' }))).toBe('5 days')
    expect(durationLabel(activity({ isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20' }))).toBe('Milestone')
    expect(durationLabel(activity({ plannedFinish: 'x' }))).toBe('—')
  })
})
