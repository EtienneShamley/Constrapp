import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ACTIVITY_STATUS, ACTIVITY_GROUP,
  DUE_FILTER, DUE_FILTER_OPTIONS, DUE_SOON_DAYS,
  filterActivities, matchesDueFilter, groupActivities, timelineSummary,
  msUntilNextLocalDay, isDifferentLocalDay, MIDNIGHT_MARGIN_MS,
  QUICK_ACTION, planQuickAction, quickActionsFor, quickActionLabel,
  sameActivityVersion, quickActionErrorKind, QUICK_ACTION_ERROR,
  canAuthorProgramme, canReadProgramme,
  nextMilestone,
} from '../../src/lib/projectTimeline'
import { runActivityQuickAction, QuickActionError } from '../../src/lib/activityQuickActions'
import { programmeOverview } from '../../src/lib/dashboardProgramme'

// ── Timeline & Scheduling Enhancements ───────────────────────────────────────
//
// Pure logic for the Timeline filters, the stale-clock fix, the guarded quick
// status actions and the Dashboard's Next Milestone. Plain Node, no jsdom (the
// ADR-26 convention): rendering wiring is pinned structurally at the bottom and
// accepted manually (docs/TESTING.md §15p).

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

const NOW = new Date(2026, 9, 16, 10, 0) // Fri 16 Oct 2026, 10:00 local
const TODAY = '2026-10-16'

// A stored activity, exactly as the hook writes it (audit stamps simplified).
const ts = (s, n = 0) => ({ seconds: s, nanoseconds: n })
function act(overrides = {}) {
  return {
    id: 'a1',
    name: 'Ground floor slab',
    description: '',
    isMilestone: false,
    status: ACTIVITY_STATUS.NOT_STARTED,
    plannedStart: '2026-10-10',
    plannedFinish: '2026-10-20',
    actualStart: null,
    actualFinish: null,
    percentComplete: 0,
    responsibleContactId: null,
    responsibleName: '',
    costCodeId: null,
    costCodeName: '',
    sortOrder: 10,
    notes: '',
    cancelReason: '',
    cancelledAt: null,
    cancelledBy: null,
    revision: 1,
    createdAt: ts(100),
    createdBy: 'u_pm',
    updatedAt: ts(200),
    updatedBy: 'u_pm',
    ...overrides,
  }
}

// ── Filters ──────────────────────────────────────────────────────────────────

const LIST = [
  act({ id: 'late',     name: 'Late open',      status: 'in_progress', actualStart: '2026-10-01', percentComplete: 20, plannedStart: '2026-10-01', plannedFinish: '2026-10-15' }),
  act({ id: 'today',    name: 'Due today',      plannedStart: '2026-10-16', plannedFinish: '2026-10-16' }),
  act({ id: 'edge14',   name: 'Due day 14',     plannedStart: '2026-10-20', plannedFinish: '2026-10-30' }),
  act({ id: 'day15',    name: 'Due day 15',     plannedStart: '2026-10-20', plannedFinish: '2026-10-31' }),
  act({ id: 'doneLate', name: 'Completed late', status: 'completed', actualStart: '2026-09-01', actualFinish: '2026-10-14', percentComplete: 100, plannedStart: '2026-09-01', plannedFinish: '2026-09-10' }),
  act({ id: 'cxLate',   name: 'Cancelled late', status: 'cancelled', cancelReason: 'Descoped', plannedStart: '2026-09-01', plannedFinish: '2026-09-10' }),
  act({ id: 'holdLate', name: 'On hold late',   status: 'on_hold', plannedStart: '2026-09-20', plannedFinish: '2026-10-02', responsibleContactId: 'c1', responsibleName: 'Acme Concrete' }),
  act({ id: 'soonHold', name: 'On hold soon',   status: 'on_hold', plannedStart: '2026-10-17', plannedFinish: '2026-10-18', responsibleContactId: 'c1', responsibleName: 'Acme Concrete' }),
]
const ids = (list) => list.map(a => a.id).sort()

describe('Overdue Only filter', () => {
  it('keeps only OPEN activities whose planned finish is before today', () => {
    expect(ids(filterActivities(LIST, { due: DUE_FILTER.OVERDUE }, NOW))).toEqual(['holdLate', 'late'])
  })

  it('never treats completed or cancelled work as overdue, even with a past finish', () => {
    const out = ids(filterActivities(LIST, { due: DUE_FILTER.OVERDUE }, NOW))
    expect(out).not.toContain('doneLate')
    expect(out).not.toContain('cxLate')
  })

  it('a planned finish of TODAY is not overdue', () => {
    expect(ids(filterActivities(LIST, { due: DUE_FILTER.OVERDUE }, NOW))).not.toContain('today')
  })

  it('agrees exactly with the summary card count', () => {
    expect(filterActivities(LIST, { due: DUE_FILTER.OVERDUE }, NOW)).toHaveLength(timelineSummary(LIST, NOW).overdue)
  })
})

describe('Due Within 14 Days filter', () => {
  it('keeps open activities due from today to today + 14 inclusive', () => {
    expect(ids(filterActivities(LIST, { due: DUE_FILTER.DUE_SOON }, NOW))).toEqual(['edge14', 'soonHold', 'today'])
  })

  it('excludes day 15, overdue work, and closed work', () => {
    const out = ids(filterActivities(LIST, { due: DUE_FILTER.DUE_SOON }, NOW))
    for (const id of ['day15', 'late', 'holdLate', 'doneLate', 'cxLate']) expect(out).not.toContain(id)
  })

  it('agrees exactly with the summary card count and the 14-day window', () => {
    expect(DUE_SOON_DAYS).toBe(14)
    expect(filterActivities(LIST, { due: DUE_FILTER.DUE_SOON }, NOW)).toHaveLength(timelineSummary(LIST, NOW).dueSoon)
  })

  it('overdue and due-soon are disjoint — which is why they are one control', () => {
    const o = ids(filterActivities(LIST, { due: DUE_FILTER.OVERDUE }, NOW))
    const s = ids(filterActivities(LIST, { due: DUE_FILTER.DUE_SOON }, NOW))
    expect(o.filter(id => s.includes(id))).toEqual([])
    expect(DUE_FILTER_OPTIONS.map(x => x.value)).toEqual(['', 'overdue', 'due_soon'])
  })

  it('an empty / unknown due value filters nothing', () => {
    expect(filterActivities(LIST, { due: '' }, NOW)).toHaveLength(LIST.length)
    expect(filterActivities(LIST, {}, NOW)).toHaveLength(LIST.length)
    expect(matchesDueFilter(LIST[0], 'nonsense', NOW)).toBe(true)
  })
})

describe('combined filters narrow predictably (logical AND)', () => {
  it('due + responsible', () => {
    expect(ids(filterActivities(LIST, { due: DUE_FILTER.OVERDUE, responsibleContactId: 'c1' }, NOW))).toEqual(['holdLate'])
    expect(ids(filterActivities(LIST, { due: DUE_FILTER.DUE_SOON, responsibleContactId: 'c1' }, NOW))).toEqual(['soonHold'])
  })

  it('due + status', () => {
    expect(ids(filterActivities(LIST, { due: DUE_FILTER.OVERDUE, status: 'on_hold' }, NOW))).toEqual(['holdLate'])
    // A closed status with a date window is empty by definition, not an error.
    expect(filterActivities(LIST, { due: DUE_FILTER.OVERDUE, status: 'completed' }, NOW)).toEqual([])
  })

  it('due + search', () => {
    expect(ids(filterActivities(LIST, { due: DUE_FILTER.DUE_SOON, search: 'today' }, NOW))).toEqual(['today'])
  })

  it('hideClosed changes nothing once a due window is set (windows already exclude closed work)', () => {
    for (const due of [DUE_FILTER.OVERDUE, DUE_FILTER.DUE_SOON]) {
      expect(ids(filterActivities(LIST, { due, hideClosed: true }, NOW)))
        .toEqual(ids(filterActivities(LIST, { due }, NOW)))
    }
  })

  it('adding any filter never grows the list', () => {
    const base = filterActivities(LIST, { due: DUE_FILTER.OVERDUE }, NOW).length
    for (const extra of [{ search: 'late' }, { status: 'in_progress' }, { responsibleContactId: 'c1' }, { hideClosed: true }, { overdueOnly: true }]) {
      expect(filterActivities(LIST, { due: DUE_FILTER.OVERDUE, ...extra }, NOW).length).toBeLessThanOrEqual(base)
    }
  })

  it('the legacy overdueOnly flag still works and ANDs with due', () => {
    expect(ids(filterActivities(LIST, { overdueOnly: true }, NOW))).toEqual(['holdLate', 'late'])
    expect(filterActivities(LIST, { overdueOnly: true, due: DUE_FILTER.DUE_SOON }, NOW)).toEqual([])
  })
})

describe('desktop and mobile see the same filtered set', () => {
  it('the mobile groups of a filtered list contain exactly the filtered activities', () => {
    for (const due of [DUE_FILTER.OVERDUE, DUE_FILTER.DUE_SOON, DUE_FILTER.ANY]) {
      const filtered = filterActivities(LIST, { due }, NOW)
      const grouped = Object.values(groupActivities(filtered, NOW)).flat()
      expect(ids(grouped)).toEqual(ids(filtered))
    }
  })

  it('overdue-only lands entirely in the Overdue group; due-soon never does', () => {
    const g = groupActivities(filterActivities(LIST, { due: DUE_FILTER.OVERDUE }, NOW), NOW)
    expect(g[ACTIVITY_GROUP.OVERDUE]).toHaveLength(2)
    const s = groupActivities(filterActivities(LIST, { due: DUE_FILTER.DUE_SOON }, NOW), NOW)
    expect(s[ACTIVITY_GROUP.OVERDUE]).toHaveLength(0)
    expect(s[ACTIVITY_GROUP.CLOSED]).toHaveLength(0)
  })

  it('the page passes the SAME filtered list to the Gantt, the table and the cards', () => {
    const page = stripComments(read('pages/project/ProjectTimeline.jsx'))
    // ADR-64: the chart takes its presentation props on separate lines; the
    // list it draws is still `filtered`, with the one page clock.
    const chart = page.slice(page.indexOf('<TimelineGantt'), page.indexOf('/>', page.indexOf('<TimelineGantt')))
    expect(chart).toContain('activities={filtered}')
    expect(chart).toContain('now={now}')
    expect(page.match(/activities=\{filtered\}/g)).toHaveLength(3)
    expect(page).toContain('hideClosed, due }, now)')
  })
})

// ── Date rollover / stale clock ──────────────────────────────────────────────

describe('date rollover', () => {
  it('the same activity becomes overdue when the day changes, with no other change', () => {
    const a = act({ plannedFinish: '2026-10-16', plannedStart: '2026-10-16' })
    const before = new Date(2026, 9, 16, 23, 59, 59)
    const after  = new Date(2026, 9, 17, 0, 0, 1)
    expect(filterActivities([a], { due: DUE_FILTER.OVERDUE }, before)).toHaveLength(0)
    expect(filterActivities([a], { due: DUE_FILTER.DUE_SOON }, before)).toHaveLength(1)
    expect(filterActivities([a], { due: DUE_FILTER.OVERDUE }, after)).toHaveLength(1)
    expect(filterActivities([a], { due: DUE_FILTER.DUE_SOON }, after)).toHaveLength(0)
  })

  it('msUntilNextLocalDay targets the next local midnight plus the margin', () => {
    expect(msUntilNextLocalDay(new Date(2026, 9, 16, 23, 59, 0))).toBe(60_000 + MIDNIGHT_MARGIN_MS)
    expect(msUntilNextLocalDay(new Date(2026, 9, 16, 0, 0, 0))).toBe(86_400_000 + MIDNIGHT_MARGIN_MS)
    // Firing the timer lands on the next calendar day.
    const t = new Date(2026, 9, 16, 15, 30)
    const fired = new Date(t.getTime() + msUntilNextLocalDay(t))
    expect(isDifferentLocalDay(t, fired)).toBe(true)
    expect(fired.getDate()).toBe(17)
  })

  it('month and year ends roll over', () => {
    const nye = new Date(2026, 11, 31, 22, 0)
    const fired = new Date(nye.getTime() + msUntilNextLocalDay(nye))
    expect([fired.getFullYear(), fired.getMonth(), fired.getDate()]).toEqual([2027, 0, 1])
  })

  it('isDifferentLocalDay compares calendar days, not elapsed time', () => {
    expect(isDifferentLocalDay(new Date(2026, 9, 16, 0, 1), new Date(2026, 9, 16, 23, 59))).toBe(false)
    expect(isDifferentLocalDay(new Date(2026, 9, 16, 23, 59), new Date(2026, 9, 17, 0, 1))).toBe(true)
  })

  it('the Timeline and the panel no longer freeze `now` at mount', () => {
    const page = stripComments(read('pages/project/ProjectTimeline.jsx'))
    const panel = stripComments(read('pages/dashboard/ProgrammePanel.jsx'))
    expect(page).not.toMatch(/useMemo\(\(\) => new Date\(\)/)
    expect(page).toContain('const now = useLocalToday()')
    expect(panel).toContain('const now = useLocalToday()')
  })

  it('useLocalToday re-arms at midnight and re-checks on focus/visibility, with cleanup', () => {
    const hook = stripComments(read('hooks/useLocalToday.jsx'))
    expect(hook).toContain('msUntilNextLocalDay(new Date())')
    expect(hook).toContain("addEventListener('visibilitychange', onVisible)")
    expect(hook).toContain("addEventListener('focus', refresh)")
    expect(hook).toContain('clearTimeout(timer)')
    expect(hook).toContain("removeEventListener('visibilitychange', onVisible)")
    expect(hook).toContain("removeEventListener('focus', refresh)")
    // Only a NEW calendar day replaces the value, so memos stay stable within a day.
    expect(hook).toContain('isDifferentLocalDay(prev, fresh) ? fresh : prev')
    expect(hook).not.toContain('onSnapshot')
  })
})

// ── Quick actions: planner ───────────────────────────────────────────────────

const plan = (a, action) => planQuickAction(a, action, NOW)

describe('quick action: Start', () => {
  it('not_started → in_progress records TODAY as actual start', () => {
    expect(plan(act(), QUICK_ACTION.START)).toEqual({ ok: true, changes: { status: 'in_progress', actualStart: TODAY } })
  })

  it('on_hold with a recorded start resumes WITHOUT rewriting the actual start', () => {
    const a = act({ status: 'on_hold', actualStart: '2026-10-01', percentComplete: 40 })
    expect(plan(a, QUICK_ACTION.START)).toEqual({ ok: true, changes: { status: 'in_progress' } })
    expect(quickActionLabel(QUICK_ACTION.START, a)).toBe('Resume')
  })

  it('on_hold that never started records today on start', () => {
    expect(plan(act({ status: 'on_hold' }), QUICK_ACTION.START).changes).toEqual({ status: 'in_progress', actualStart: TODAY })
  })

  it('refused from in_progress, completed, cancelled', () => {
    expect(plan(act({ status: 'in_progress', actualStart: '2026-10-01' }), QUICK_ACTION.START).ok).toBe(false)
    expect(plan(act({ status: 'completed', actualStart: '2026-10-01', actualFinish: '2026-10-10', percentComplete: 100 }), QUICK_ACTION.START).ok).toBe(false)
    expect(plan(act({ status: 'cancelled' }), QUICK_ACTION.START).ok).toBe(false)
  })

  it('refused when an actual finish is already recorded (history edit → full editor)', () => {
    const r = plan(act({ status: 'on_hold', actualStart: '2026-10-01', actualFinish: '2026-10-05' }), QUICK_ACTION.START)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/use Edit/)
  })

  it('refused for a milestone', () => {
    expect(plan(act({ isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20' }), QUICK_ACTION.START).ok).toBe(false)
  })
})

describe('quick action: Put on hold', () => {
  it('not_started and in_progress → on_hold, touching nothing else', () => {
    expect(plan(act(), QUICK_ACTION.HOLD)).toEqual({ ok: true, changes: { status: 'on_hold' } })
    expect(plan(act({ status: 'in_progress', actualStart: '2026-10-01', percentComplete: 30 }), QUICK_ACTION.HOLD))
      .toEqual({ ok: true, changes: { status: 'on_hold' } })
  })

  it('refused from on_hold, completed, cancelled, and for milestones', () => {
    expect(plan(act({ status: 'on_hold' }), QUICK_ACTION.HOLD).ok).toBe(false)
    expect(plan(act({ status: 'completed', actualStart: '2026-10-01', actualFinish: '2026-10-10', percentComplete: 100 }), QUICK_ACTION.HOLD).ok).toBe(false)
    expect(plan(act({ status: 'cancelled' }), QUICK_ACTION.HOLD).ok).toBe(false)
    expect(plan(act({ isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20' }), QUICK_ACTION.HOLD).ok).toBe(false)
  })
})

describe('quick action: Complete', () => {
  it('in_progress → completed with 100% and TODAY as actual finish; start untouched', () => {
    const a = act({ status: 'in_progress', actualStart: '2026-10-01', percentComplete: 60 })
    expect(plan(a, QUICK_ACTION.COMPLETE)).toEqual({
      ok: true, changes: { status: 'completed', percentComplete: 100, actualFinish: TODAY },
    })
  })

  it('on_hold with a recorded start may complete', () => {
    expect(plan(act({ status: 'on_hold', actualStart: '2026-10-01' }), QUICK_ACTION.COMPLETE).ok).toBe(true)
  })

  it('NEVER invents an actual start: no recorded start → full editor', () => {
    for (const status of ['not_started', 'on_hold']) {
      const r = plan(act({ status }), QUICK_ACTION.COMPLETE)
      expect(r.ok).toBe(false)
      expect(r.reason).toMatch(/Edit/)
    }
  })

  it('refused when the recorded actual start is after today', () => {
    const r = plan(act({ status: 'in_progress', actualStart: '2026-10-20' }), QUICK_ACTION.COMPLETE)
    expect(r.ok).toBe(false)
  })

  it('refused when already completed or cancelled', () => {
    expect(plan(act({ status: 'completed', actualStart: '2026-10-01', actualFinish: '2026-10-10', percentComplete: 100 }), QUICK_ACTION.COMPLETE).ok).toBe(false)
    expect(plan(act({ status: 'cancelled' }), QUICK_ACTION.COMPLETE).ok).toBe(false)
  })

  it('refused when an actual finish already exists (never overwritten)', () => {
    expect(plan(act({ status: 'on_hold', actualStart: '2026-10-01', actualFinish: '2026-10-05' }), QUICK_ACTION.COMPLETE).ok).toBe(false)
  })
})

describe('milestones: Mark reached', () => {
  const ms = (o = {}) => act({ isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20', ...o })

  it('not_started milestone → completed, 100%, actual finish today; no actual start invented', () => {
    const r = plan(ms(), QUICK_ACTION.COMPLETE)
    expect(r).toEqual({ ok: true, changes: { status: 'completed', percentComplete: 100, actualFinish: TODAY } })
    expect(r.changes).not.toHaveProperty('actualStart')
    expect(quickActionLabel(QUICK_ACTION.COMPLETE, ms())).toBe('Mark reached today')
  })

  it('the only quick action offered for an open milestone is Mark reached', () => {
    expect(quickActionsFor(ms(), NOW).map(x => x.action)).toEqual([QUICK_ACTION.COMPLETE])
    expect(quickActionsFor(ms({ status: 'on_hold' }), NOW).map(x => x.action)).toEqual([QUICK_ACTION.COMPLETE])
  })

  it('the merged milestone satisfies the 0/100 and same-day rules', () => {
    const merged = { ...ms(), ...plan(ms(), QUICK_ACTION.COMPLETE).changes }
    expect(merged.percentComplete).toBe(100)
    expect(merged.plannedFinish).toBe(merged.plannedStart)
  })
})

describe('quick actions: offered set and invariants', () => {
  it('offers exactly the actions the planner accepts', () => {
    const cases = [
      [act(), ['start', 'hold']],
      [act({ status: 'in_progress', actualStart: '2026-10-01' }), ['hold', 'complete']],
      [act({ status: 'on_hold', actualStart: '2026-10-01' }), ['start', 'complete']],
      [act({ status: 'on_hold' }), ['start']],
      [act({ status: 'completed', actualStart: '2026-10-01', actualFinish: '2026-10-10', percentComplete: 100 }), []],
      [act({ status: 'cancelled' }), []],
      [act({ status: 'legacy' }), []],
    ]
    for (const [a, expected] of cases) expect(quickActionsFor(a, NOW).map(x => x.action)).toEqual(expected)
  })

  it('never writes audit, identity, cancellation or content fields', () => {
    const FORBIDDEN = ['name', 'description', 'isMilestone', 'plannedStart', 'plannedFinish', 'responsibleContactId',
      'responsibleName', 'costCodeId', 'costCodeName', 'sortOrder', 'notes', 'cancelReason', 'cancelledAt',
      'cancelledBy', 'revision', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']
    const states = [act(), act({ status: 'in_progress', actualStart: '2026-10-01' }), act({ status: 'on_hold', actualStart: '2026-10-01' })]
    for (const a of states) {
      for (const action of Object.values(QUICK_ACTION)) {
        const r = plan(a, action)
        if (!r.ok) continue
        for (const k of FORBIDDEN) expect(r.changes).not.toHaveProperty(k)
      }
    }
  })

  it('every accepted plan produces a status / progress / actual-date consistent activity', () => {
    const states = [act(), act({ status: 'in_progress', actualStart: '2026-10-01', percentComplete: 30 }),
      act({ status: 'on_hold', actualStart: '2026-10-01', percentComplete: 30 }), act({ status: 'on_hold' })]
    for (const a of states) {
      for (const action of Object.values(QUICK_ACTION)) {
        const r = plan(a, action)
        if (!r.ok) continue
        const m = { ...a, ...r.changes }
        if (m.status === 'in_progress') expect(m.actualStart).toBeTruthy()
        if (m.status === 'completed') { expect(m.percentComplete).toBe(100); expect(m.actualFinish).toBeTruthy() }
        if (m.actualStart && m.actualFinish) expect(m.actualFinish >= m.actualStart).toBe(true)
        // Only today may be introduced as a new date.
        for (const k of ['actualStart', 'actualFinish']) if (r.changes[k]) expect(r.changes[k]).toBe(TODAY)
      }
    }
  })

  it('a stored activity that is already invalid is sent to the editor, not patched', () => {
    const r = plan(act({ plannedStart: '2026-02-30', plannedFinish: '2026-03-02' }), QUICK_ACTION.HOLD)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/use Edit/)
  })

  it('a missing activity and an unknown action are refused', () => {
    expect(planQuickAction(null, QUICK_ACTION.START, NOW).ok).toBe(false)
    expect(plan(act(), 'reopen').ok).toBe(false)
  })
})

describe('roles: quick actions are author-only (UX mirror of the rules)', () => {
  it('only company_admin and project_manager author; QS reads only', () => {
    expect(canAuthorProgramme('company_admin')).toBe(true)
    expect(canAuthorProgramme('project_manager')).toBe(true)
    for (const r of ['qs', 'subcontractor', 'client', 'super_admin', undefined]) expect(canAuthorProgramme(r)).toBe(false)
    expect(canReadProgramme('qs')).toBe(true)
  })

  it('the quick buttons render only inside the canWrite branches of table and cards', () => {
    const table = stripComments(read('pages/project/timeline/ActivityTable.jsx'))
    const cards = stripComments(read('pages/project/timeline/ActivityCards.jsx'))
    for (const src of [table, cards]) {
      const at = src.indexOf('<ActivityQuickActions')
      expect(at).toBeGreaterThan(-1)
      expect(src.lastIndexOf('canWrite &&', at)).toBeGreaterThan(-1)
    }
    // Cancelled rows show no quick action (terminal).
    expect(table.indexOf('<ActivityQuickActions')).toBeGreaterThan(table.indexOf('a.status === ACTIVITY_STATUS.CANCELLED ? ('))
    expect(cards).toContain("canWrite && a.status !== ACTIVITY_STATUS.CANCELLED && (")
  })

  it('table and cards derive the offered actions from one shared component', () => {
    const shared = stripComments(read('pages/project/timeline/ActivityQuickActions.jsx'))
    expect(shared).toContain('quickActionsFor(activity, now)')
  })
})

// ── Quick actions: the guarded transaction ───────────────────────────────────

// A fake Firestore transaction. `reads` is the sequence of server copies the
// callback sees on each attempt (a second entry simulates Firestore re-running
// the callback after contention). `fail` throws a FirestoreError-like code.
function fakeFirestore({ reads, fail } = {}) {
  const writes = []
  let attempt = 0
  return {
    writes,
    get attempts() { return attempt },
    serverTimestamp: () => 'SERVER_TS',
    runTransaction: async (_db, fn) => {
      if (fail) { const e = new Error(fail); e.code = fail; throw e }
      let result
      for (const server of reads) {
        attempt += 1
        const pending = []
        const tx = {
          get: async () => ({
            id: server?.id ?? 'a1',
            exists: () => server !== null,
            data: () => server,
          }),
          update: (ref, data) => pending.push({ ref, data }),
        }
        result = await fn(tx)
        if (pending.length) { writes.push(...pending); break }
        if (result?.kind !== undefined) break
      }
      return result
    },
  }
}

const run = (fs, seen, action, extra = {}) => runActivityQuickAction({
  db: {}, ref: 'REF', seen, action, uid: 'u_pm', now: NOW,
  runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp, ...extra,
})

describe('guarded quick action transaction', () => {
  it('writes ONLY the planned keys plus the two audit stamps', async () => {
    const seen = act()
    const fs = fakeFirestore({ reads: [seen] })
    await run(fs, seen, QUICK_ACTION.START)
    expect(fs.writes).toHaveLength(1)
    expect(fs.writes[0].data).toEqual({ status: 'in_progress', actualStart: TODAY, updatedAt: 'SERVER_TS', updatedBy: 'u_pm' })
  })

  it('refuses a STALE action: the server copy changed since the UI loaded it', async () => {
    const seen = act()
    const server = act({ updatedAt: ts(300), updatedBy: 'u_admin', name: 'Renamed' })
    const fs = fakeFirestore({ reads: [server] })
    await expect(run(fs, seen, QUICK_ACTION.START)).rejects.toMatchObject({ kind: QUICK_ACTION_ERROR.STALE })
    expect(fs.writes).toHaveLength(0)
  })

  it('same updatedAt but a different writer is still stale', async () => {
    const fs = fakeFirestore({ reads: [act({ updatedBy: 'u_admin' })] })
    await expect(run(fs, act(), QUICK_ACTION.HOLD)).rejects.toMatchObject({ kind: QUICK_ACTION_ERROR.STALE })
  })

  it('never silently re-applies after contention: a re-run that sees a change is refused', async () => {
    const seen = act()
    // Attempt 1 reads an unchanged copy but (simulated) loses the commit race,
    // attempt 2 sees the competing write.
    const fs = {
      writes: [],
      serverTimestamp: () => 'SERVER_TS',
      runTransaction: async (_db, fn) => {
        const mk = (server) => ({
          get: async () => ({ id: 'a1', exists: () => true, data: () => server }),
          update: () => {},
        })
        await fn(mk(seen))                                     // discarded attempt
        return fn(mk(act({ updatedAt: ts(999), status: 'on_hold' })))  // re-run
      },
    }
    await expect(run(fs, seen, QUICK_ACTION.START)).rejects.toMatchObject({ kind: QUICK_ACTION_ERROR.STALE })
  })

  it('re-validates the transition against the SERVER copy', async () => {
    // The UI copy says not_started, but the server copy (same version stamps —
    // e.g. a status changed by an unconditioned path that preserved stamps in a
    // test double) is completed: the action must be refused, not forced.
    const seen = act()
    const server = act({ status: 'completed', actualStart: '2026-10-01', actualFinish: '2026-10-10', percentComplete: 100 })
    const fs = fakeFirestore({ reads: [server] })
    const err = await run(fs, seen, QUICK_ACTION.START).catch(e => e)
    expect(err).toBeInstanceOf(QuickActionError)
    expect(err.kind).toBe(QUICK_ACTION_ERROR.INVALID)
    expect(fs.writes).toHaveLength(0)
  })

  it('a missing / deleted activity is refused', async () => {
    const fs = fakeFirestore({ reads: [null] })
    await expect(run(fs, act(), QUICK_ACTION.START)).rejects.toMatchObject({ kind: QUICK_ACTION_ERROR.MISSING })
  })

  it('a locally pending activity (no server updatedAt yet) is refused before any read', async () => {
    const fs = fakeFirestore({ reads: [act()] })
    await expect(run(fs, act({ updatedAt: null }), QUICK_ACTION.START)).rejects.toMatchObject({ kind: QUICK_ACTION_ERROR.PENDING })
    expect(fs.attempts).toBe(0)
  })

  it('permission failures surface as PERMISSION, nothing written', async () => {
    const fs = fakeFirestore({ fail: 'permission-denied' })
    await expect(run(fs, act(), QUICK_ACTION.START)).rejects.toMatchObject({ kind: QUICK_ACTION_ERROR.PERMISSION })
    await expect(run(fakeFirestore({ reads: [act()] }), act(), QUICK_ACTION.START, { uid: null }))
      .rejects.toMatchObject({ kind: QUICK_ACTION_ERROR.PERMISSION })
  })

  it('offline failures surface as OFFLINE (transactions fail rather than queue)', async () => {
    for (const code of ['unavailable', 'deadline-exceeded']) {
      const err = await run(fakeFirestore({ fail: code }), act(), QUICK_ACTION.START).catch(e => e)
      expect(err.kind).toBe(QUICK_ACTION_ERROR.OFFLINE)
      expect(err.message).toMatch(/offline/i)
    }
  })

  it('maps Firestore codes to error kinds', () => {
    expect(quickActionErrorKind('aborted')).toBe(QUICK_ACTION_ERROR.STALE)
    expect(quickActionErrorKind('failed-precondition')).toBe(QUICK_ACTION_ERROR.STALE)
    expect(quickActionErrorKind('not-found')).toBe(QUICK_ACTION_ERROR.MISSING)
    expect(quickActionErrorKind('unauthenticated')).toBe(QUICK_ACTION_ERROR.PERMISSION)
    expect(quickActionErrorKind('internal')).toBe(QUICK_ACTION_ERROR.UNKNOWN)
    expect(quickActionErrorKind(undefined)).toBe(QUICK_ACTION_ERROR.UNKNOWN)
  })

  it('sameActivityVersion compares server timestamps and the writer', () => {
    expect(sameActivityVersion(act(), act())).toBe(true)
    expect(sameActivityVersion(act(), act({ updatedAt: ts(200, 1) }))).toBe(false)
    expect(sameActivityVersion(act({ updatedAt: null }), act())).toBe(false)
    const withIsEqual = { isEqual: (o) => o === withIsEqual }
    expect(sameActivityVersion({ updatedAt: withIsEqual, updatedBy: 'x' }, { updatedAt: withIsEqual, updatedBy: 'x' })).toBe(true)
  })

  it('the transaction callback has no UI side effects; the page reacts after it settles', () => {
    const lib = stripComments(read('lib/activityQuickActions.js'))
    expect(lib).not.toMatch(/from 'firebase/)
    expect(lib).not.toMatch(/\bset[A-Z]\w*\(/)
    const page = stripComments(read('pages/project/ProjectTimeline.jsx'))
    const handler = page.slice(page.indexOf('async function handleQuickAction'))
    expect(handler.indexOf('await quickUpdateActivity(activity, action)'))
      .toBeLessThan(handler.indexOf("setQuickNotice({ tone: 'ok'"))
  })

  it('the full editor path is unchanged (still an unconditioned update) — documented, not claimed fixed', () => {
    const hook = stripComments(read('hooks/useProjectActivities.jsx'))
    expect(hook).toContain('await updateDoc(ref, {')
    expect(hook).toContain('runActivityQuickAction({')
  })
})

// ── Dashboard: Next milestone ────────────────────────────────────────────────

const M = (id, date, o = {}) => act({ id, name: `M ${id}`, isMilestone: true, plannedStart: date, plannedFinish: date, ...o })

describe('nextMilestone', () => {
  it('picks the nearest upcoming open milestone (today counts as upcoming)', () => {
    const r = nextMilestone([M('far', '2026-12-01'), M('near', '2026-10-20'), M('now', '2026-10-16')], NOW)
    expect(r.kind).toBe('upcoming')
    expect(r.milestone.id).toBe('now')
    expect(r.daysUntil).toBe(0)
  })

  it('upcoming wins over overdue, but the overdue count is still reported', () => {
    const r = nextMilestone([M('late', '2026-10-01'), M('near', '2026-10-20')], NOW)
    expect(r.kind).toBe('upcoming')
    expect(r.milestone.id).toBe('near')
    expect(r.overdueCount).toBe(1)
  })

  it('falls back to the OLDEST overdue milestone when none is upcoming', () => {
    const r = nextMilestone([M('l2', '2026-10-10'), M('l1', '2026-09-01')], NOW)
    expect(r.kind).toBe('overdue')
    expect(r.milestone.id).toBe('l1')
    expect(r.daysLate).toBe(45)
    expect(r.overdueCount).toBe(2)
  })

  it('equal dates break ties deterministically (sortOrder, then name, then id)', () => {
    const a = M('b', '2026-10-20', { sortOrder: 20, name: 'Alpha' })
    const b = M('a', '2026-10-20', { sortOrder: 10, name: 'Zulu' })
    expect(nextMilestone([a, b], NOW).milestone.id).toBe('a')
    expect(nextMilestone([b, a], NOW).milestone.id).toBe('a')
    const c = M('y', '2026-10-20', { sortOrder: 10, name: 'Same' })
    const d = M('x', '2026-10-20', { sortOrder: 10, name: 'Same' })
    expect(nextMilestone([c, d], NOW).milestone.id).toBe('x')
    expect(nextMilestone([d, c], NOW).milestone.id).toBe('x')
  })

  it('excludes completed and cancelled milestones, and non-milestones', () => {
    const r = nextMilestone([
      M('done', '2026-10-17', { status: 'completed', actualFinish: '2026-10-15', percentComplete: 100 }),
      M('cx', '2026-10-17', { status: 'cancelled' }),
      act({ id: 'task', plannedFinish: '2026-10-17' }),
      M('open', '2026-11-01'),
    ], NOW)
    expect(r.milestone.id).toBe('open')
  })

  it('no open milestone → kind null (not an error, not zero progress)', () => {
    expect(nextMilestone([], NOW)).toEqual({ kind: null, milestone: null, daysUntil: null, daysLate: null, overdueCount: 0 })
    expect(nextMilestone(undefined, NOW).kind).toBe(null)
    expect(nextMilestone([M('bad', '2026-02-30')], NOW).kind).toBe(null)
  })

  it('moves across midnight: due today becomes overdue tomorrow', () => {
    const list = [M('m', '2026-10-16')]
    expect(nextMilestone(list, new Date(2026, 9, 16, 23, 0)).kind).toBe('upcoming')
    expect(nextMilestone(list, new Date(2026, 9, 17, 0, 1)).kind).toBe('overdue')
  })

  it('programmeOverview carries it unchanged', () => {
    const list = [M('near', '2026-10-20')]
    expect(programmeOverview(list, NOW).nextMilestone).toEqual(nextMilestone(list, NOW))
  })
})

describe('Programme panel: next milestone presentation', () => {
  const panel = stripComments(read('pages/dashboard/ProgrammePanel.jsx'))

  it('loading shows a "—" placeholder; failure keeps the single Unavailable state', () => {
    expect(panel).toContain('<Fact label="Next milestone" value="—" tone="text-brand-muted" />')
    expect(panel).toContain('Programme unavailable')
    // Next milestone renders only in the READY branch with activities.
    const ready = panel.indexOf('availability.state === FIGURE_STATE.READY && s.total > 0')
    expect(panel.indexOf('<NextMilestone next={overview.nextMilestone} />')).toBeGreaterThan(ready)
  })

  it('distinguishes overdue in words and states when none is open', () => {
    expect(panel).toContain("'Overdue milestone' : 'Next milestone'")
    expect(panel).toContain('No open milestones on the programme.')
    expect(panel).toContain('No upcoming milestone is planned.')
  })

  it('computes no percentage', () => {
    expect(panel).not.toMatch(/\* ?100|percent|%\}/i)
  })

  it('project switching stays isolated: one keyed panel, one keyed subscription', () => {
    const dashboard = stripComments(read('pages/Dashboard.jsx'))
    expect(dashboard).toContain('<ProgrammePanel key={selectedProject.id} projectId={selectedProject.id} />')
    expect(panel).toContain('useProjectActivities(projectId)')
  })
})
