import { describe, it, expect } from 'vitest'
import {
  GANTT_GROUP, GANTT_GROUP_ORDER, GANTT_GROUP_LABELS, isGanttGroup,
  ALL_GROUP_KEY, NO_COST_CODE_KEY, UNASSIGNED_KEY,
  NO_CATEGORY_HINT, CATEGORY_UNAVAILABLE_HINT,
  groupGanttActivities, toggleGroupKey, collapseAllKeys, groupTotals,
} from '../../src/lib/ganttGrouping'
import { buildGanttModel, layoutGanttRows, GANTT_ROW, ROW_HEIGHT_PX } from '../../src/lib/timelineGantt'
import { ACTIVITY_STATUS, sortActivities } from '../../src/lib/projectTimeline'

// ── Constrapp GANTT™ grouping (ADR-64) ───────────────────────────────────────
//
// Pure: groups are a read-time arrangement of the loaded activities over the
// fields they already carry. No field is invented, no category is guessed,
// ordering is deterministic, and a collapsed group hides rows, never counts.

const NOW = new Date(2026, 9, 15) // 2026-10-15 local

const act = (id, overrides = {}) => ({
  id,
  name: `Activity ${id}`,
  isMilestone: false,
  status: ACTIVITY_STATUS.NOT_STARTED,
  plannedStart: '2026-10-05',
  plannedFinish: '2026-10-20',
  actualStart: null,
  actualFinish: null,
  percentComplete: 0,
  responsibleContactId: null,
  responsibleName: '',
  costCodeId: null,
  costCodeName: '',
  sortOrder: 10,
  ...overrides,
})

const COST_CODES = [
  { id: 'cc-slab',  code: '03-100', name: 'Concrete slab',    category: 'Structure', isActive: true },
  { id: 'cc-frame', code: '05-200', name: 'Steel frame',      category: 'Structure', isActive: true },
  { id: 'cc-prelim', code: '01-000', name: 'Preliminaries',   category: 'Prelims',   isActive: true },
  { id: 'cc-nocat', code: '09-900', name: 'Painting',         category: '',          isActive: true },
]

const LIST = [
  act('a', { costCodeId: 'cc-frame', costCodeName: '05-200 — Steel frame', responsibleContactId: 'c-steel', responsibleName: 'Steel Co', sortOrder: 30 }),
  act('b', { costCodeId: 'cc-slab',  costCodeName: '03-100 — Concrete slab', responsibleContactId: 'c-conc', responsibleName: 'ABC Concrete', sortOrder: 10, plannedFinish: '2026-10-09' }), // overdue
  act('c', { costCodeId: 'cc-slab',  costCodeName: '03-100 — Concrete slab', responsibleContactId: 'c-conc', responsibleName: 'ABC Concrete', sortOrder: 20 }),
  act('d', { costCodeId: 'cc-prelim', costCodeName: '01-000 — Preliminaries', sortOrder: 5 }),
  act('e', { costCodeId: 'cc-gone', costCodeName: '99-999 — Retired code', sortOrder: 40 }),         // not in the company list
  act('f', { costCodeId: 'cc-nocat', costCodeName: '09-900 — Painting', sortOrder: 50 }),
  act('g', { sortOrder: 60 }),                                                                        // no cost code, no responsible
]

const ids = (list) => list.map(a => a.id)

describe('vocabulary', () => {
  it('three ways to group, with labels, none first', () => {
    expect(GANTT_GROUP_ORDER).toEqual([GANTT_GROUP.NONE, GANTT_GROUP.COST_CODE, GANTT_GROUP.RESPONSIBLE])
    for (const g of GANTT_GROUP_ORDER) expect(GANTT_GROUP_LABELS[g]).toBeTruthy()
    expect(isGanttGroup('cost_code')).toBe(true)
    expect(isGanttGroup('trade')).toBe(false)
    expect(isGanttGroup(undefined)).toBe(false)
  })
})

describe('ungrouped', () => {
  it('is exactly one group holding every activity in programme order', () => {
    const groups = groupGanttActivities(LIST, GANTT_GROUP.NONE, { now: NOW })
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe(ALL_GROUP_KEY)
    expect(ids(groups[0].activities)).toEqual(ids(sortActivities(LIST)))
    expect(groups[0].count).toBe(7)
    expect(groups[0].overdueCount).toBe(1)
  })

  it('an unknown grouping falls back to ungrouped rather than throwing', () => {
    expect(groupGanttActivities(LIST, 'trade', { now: NOW })).toHaveLength(1)
    expect(groupGanttActivities(undefined, GANTT_GROUP.NONE, { now: NOW })[0].activities).toEqual([])
  })
})

describe('by cost code', () => {
  const groups = groupGanttActivities(LIST, GANTT_GROUP.COST_CODE, { costCodes: COST_CODES, now: NOW })

  it('keys groups by costCodeId, ordered by category then label, with the no-cost-code group last', () => {
    expect(groups.map(g => g.key)).toEqual(['cc-prelim', 'cc-slab', 'cc-frame', 'cc-nocat', 'cc-gone', NO_COST_CODE_KEY])
  })

  it('labels from the LIVE cost code when the company list holds it, else the frozen snapshot', () => {
    expect(groups.find(g => g.key === 'cc-slab').label).toBe('03-100 — Concrete slab')
    expect(groups.find(g => g.key === 'cc-gone').label).toBe('99-999 — Retired code')
  })

  it('the category is a hint from the lookup — and says so truthfully when it cannot', () => {
    expect(groups.find(g => g.key === 'cc-slab').hint).toBe('Structure')
    expect(groups.find(g => g.key === 'cc-nocat').hint).toBe(NO_CATEGORY_HINT)
    expect(groups.find(g => g.key === 'cc-gone').hint).toBe(CATEGORY_UNAVAILABLE_HINT)
    expect(groups.find(g => g.key === NO_COST_CODE_KEY).label).toBe('No cost code')
  })

  it('every activity lands in exactly one group, in programme order, with per-group counts', () => {
    const all = groups.flatMap(g => g.activities)
    expect(ids(all).sort()).toEqual(ids(LIST).sort())
    expect(ids(groups.find(g => g.key === 'cc-slab').activities)).toEqual(['b', 'c'])
    expect(groups.find(g => g.key === 'cc-slab')).toMatchObject({ count: 2, overdueCount: 1 })
    expect(groups.find(g => g.key === NO_COST_CODE_KEY).count).toBe(1)
  })

  it('with no cost-code list at all, every group reports its category unavailable and nothing is invented', () => {
    const bare = groupGanttActivities(LIST, GANTT_GROUP.COST_CODE, { now: NOW })
    for (const g of bare.filter(g => g.key !== NO_COST_CODE_KEY)) expect(g.hint).toBe(CATEGORY_UNAVAILABLE_HINT)
    expect(bare.find(g => g.key === 'cc-slab').label).toBe('03-100 — Concrete slab')
    // Missing lookup → no category → alphabetical by label.
    expect(bare.map(g => g.key)).toEqual(['cc-prelim', 'cc-slab', 'cc-frame', 'cc-nocat', 'cc-gone', NO_COST_CODE_KEY])
  })
})

describe('by responsible', () => {
  const groups = groupGanttActivities(LIST, GANTT_GROUP.RESPONSIBLE, { now: NOW })

  it('keys by contact id, labelled by the frozen name, alphabetical, unassigned last', () => {
    expect(groups.map(g => g.key)).toEqual(['c-conc', 'c-steel', UNASSIGNED_KEY])
    expect(groups.map(g => g.label)).toEqual(['ABC Concrete', 'Steel Co', 'Unassigned'])
    expect(groups.find(g => g.key === UNASSIGNED_KEY).count).toBe(4)
  })
})

describe('determinism and purity', () => {
  it('the same input always yields the same order, whatever the input order', () => {
    const a = groupGanttActivities(LIST, GANTT_GROUP.COST_CODE, { costCodes: COST_CODES, now: NOW })
    const b = groupGanttActivities([...LIST].reverse(), GANTT_GROUP.COST_CODE, { costCodes: COST_CODES, now: NOW })
    expect(a.map(g => [g.key, ids(g.activities)])).toEqual(b.map(g => [g.key, ids(g.activities)]))
  })

  it('never mutates the activities or the cost codes', () => {
    const frozen = JSON.stringify([LIST, COST_CODES])
    groupGanttActivities(LIST, GANTT_GROUP.COST_CODE, { costCodes: COST_CODES, now: NOW })
    groupGanttActivities(LIST, GANTT_GROUP.RESPONSIBLE, { now: NOW })
    expect(JSON.stringify([LIST, COST_CODES])).toBe(frozen)
  })
})

describe('collapse state helpers', () => {
  it('toggles a key in a NEW set', () => {
    const s0 = new Set()
    const s1 = toggleGroupKey(s0, 'x')
    expect(s1.has('x')).toBe(true)
    expect(s0.has('x')).toBe(false)
    expect(toggleGroupKey(s1, 'x').has('x')).toBe(false)
    expect(toggleGroupKey(undefined, 'y').has('y')).toBe(true)
  })

  it('collapseAllKeys names every group', () => {
    const groups = groupGanttActivities(LIST, GANTT_GROUP.RESPONSIBLE, { now: NOW })
    expect([...collapseAllKeys(groups)]).toEqual(['c-conc', 'c-steel', UNASSIGNED_KEY])
  })

  it('groupTotals sums the whole filtered set, independent of collapse', () => {
    const groups = groupGanttActivities(LIST, GANTT_GROUP.COST_CODE, { costCodes: COST_CODES, now: NOW })
    expect(groupTotals(groups)).toEqual({ count: 7, overdueCount: 1, groups: 6 })
  })
})

describe('rows: groups + collapse over ONE model', () => {
  const model = buildGanttModel(LIST, { now: NOW, scale: 'week' })
  const groups = groupGanttActivities(LIST, GANTT_GROUP.COST_CODE, { costCodes: COST_CODES, now: NOW })

  it('ungrouped: one row per drawn bar, no header rows, in model order', () => {
    const one = groupGanttActivities(LIST, GANTT_GROUP.NONE, { now: NOW })
    const { rows, height } = layoutGanttRows(model, one, new Set(), { ungrouped: true })
    expect(rows.every(r => r.type === GANTT_ROW.BAR)).toBe(true)
    expect(rows.map(r => r.bar.id)).toEqual(model.bars.map(b => b.id))
    expect(height).toBe(model.bars.length * ROW_HEIGHT_PX)
    expect(rows.map(r => r.y)).toEqual(rows.map((_, i) => i * ROW_HEIGHT_PX))
  })

  it('grouped: a header row per group followed by its bars, with y positions stacked', () => {
    const { rows, height } = layoutGanttRows(model, groups, new Set())
    expect(rows.filter(r => r.type === GANTT_ROW.GROUP)).toHaveLength(6)
    expect(rows.filter(r => r.type === GANTT_ROW.BAR)).toHaveLength(7)
    expect(height).toBe(13 * ROW_HEIGHT_PX)
    const slab = rows.findIndex(r => r.type === GANTT_ROW.GROUP && r.key === 'cc-slab')
    expect(rows[slab + 1].bar.id).toBe('b')
    expect(rows[slab + 2].bar.id).toBe('c')
    expect(rows[slab]).toMatchObject({ count: 2, overdueCount: 1, drawnCount: 2, collapsed: false, hint: 'Structure' })
  })

  it('collapsing hides a group\'s rows but keeps its counts and never changes the model', () => {
    const { rows, height } = layoutGanttRows(model, groups, new Set(['cc-slab']))
    expect(rows.filter(r => r.type === GANTT_ROW.BAR).map(r => r.bar.id)).not.toContain('b')
    expect(rows.find(r => r.key === 'cc-slab')).toMatchObject({ collapsed: true, count: 2, overdueCount: 1 })
    expect(height).toBe(11 * ROW_HEIGHT_PX)
    // The window and today line are the model's — untouched by collapsing.
    expect(model.bars).toHaveLength(7)
    expect(model.todayX).not.toBeNull()
  })

  it('an activity the model excluded is not a row, but still counts in its group', () => {
    const list = [...LIST, act('z', { costCodeId: 'cc-slab', costCodeName: 'x', plannedStart: '', plannedFinish: '' })]
    const m = buildGanttModel(list, { now: NOW, scale: 'week' })
    const g = groupGanttActivities(list, GANTT_GROUP.COST_CODE, { costCodes: COST_CODES, now: NOW })
    const { rows } = layoutGanttRows(m, g, new Set())
    const slab = rows.find(r => r.type === GANTT_ROW.GROUP && r.key === 'cc-slab')
    expect(slab).toMatchObject({ count: 3, drawnCount: 2 })
    expect(m.excluded.map(a => a.id)).toEqual(['z'])
  })

  it('accepts an array of collapsed keys as well as a Set', () => {
    const { rows } = layoutGanttRows(model, groups, ['cc-slab', 'cc-frame'])
    expect(rows.filter(r => r.type === GANTT_ROW.BAR)).toHaveLength(4)
  })
})
