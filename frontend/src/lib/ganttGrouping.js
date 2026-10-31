import { sortActivities, isOverdue } from './projectTimeline'
import { costCodeDisplayName } from './costCodes'

// ── Constrapp GANTT™ grouping (ADR-64) ───────────────────────────────────────
//
// PURE. Turns the already-FILTERED, already-sorted programme into the groups
// the chart draws. Grouping is a read-time arrangement of the existing
// `activities` documents over fields they already carry — the cost-code spine
// (`costCodeId` + frozen `costCodeName`) and the responsible Contact
// (`responsibleContactId` + frozen `responsibleName`). No field is added, no
// document is written, and nothing here invents a category:
//
//   · COST CODE groups are keyed by `costCodeId`. The label is the LIVE cost
//     code when the company list holds it (the lib/costCodes.js resolution
//     order), else the activity's frozen snapshot, else "Unknown cost code".
//     The cost code's `category` — the trade / stage a contractor files codes
//     under — orders the groups and is shown as the hint; when the lookup
//     cannot supply it the hint says so rather than guessing.
//   · RESPONSIBLE groups are keyed by `responsibleContactId`, labelled by the
//     frozen `responsibleName` (the programme never resolves a user account).
//   · Activities without the grouping field go LAST, under a truthful label.
//
// Ordering is deterministic: groups by (category, label, key), activities
// inside each group by the one programme order (sortActivities), so the chart,
// the table and the cards never disagree about sequence.

export const GANTT_GROUP = {
  NONE:        'none',
  COST_CODE:   'cost_code',
  RESPONSIBLE: 'responsible',
}

export const GANTT_GROUP_ORDER = [GANTT_GROUP.NONE, GANTT_GROUP.COST_CODE, GANTT_GROUP.RESPONSIBLE]

export const GANTT_GROUP_LABELS = {
  [GANTT_GROUP.NONE]:        'No grouping',
  [GANTT_GROUP.COST_CODE]:   'Cost code',
  [GANTT_GROUP.RESPONSIBLE]: 'Responsible',
}

export const isGanttGroup = (g) => GANTT_GROUP_ORDER.includes(g)

// The key of the one group an ungrouped programme renders as, and of the
// trailing "none" group under each real grouping.
export const ALL_GROUP_KEY = '__all__'
export const NO_COST_CODE_KEY = '__no_cost_code__'
export const UNASSIGNED_KEY = '__unassigned__'

export const NO_CATEGORY_HINT = 'No category on this cost code'
export const CATEGORY_UNAVAILABLE_HINT = 'Category unavailable — cost code not in the company list'

const cmpText = (a, b) => {
  const x = String(a ?? '').toLowerCase()
  const y = String(b ?? '').toLowerCase()
  if (x === y) return 0
  return x < y ? -1 : 1
}

function finishGroup(g, now) {
  const activities = sortActivities(g.activities)
  let overdueCount = 0
  for (const a of activities) if (isOverdue(a, now)) overdueCount += 1
  return { ...g, activities, count: activities.length, overdueCount }
}

function groupByCostCode(activities, costCodes, now) {
  const byId = new Map()
  const none = []
  for (const a of activities) {
    const id = a?.costCodeId
    if (!id) { none.push(a); continue }
    if (!byId.has(id)) {
      const live = (costCodes ?? []).find(c => c?.id === id) ?? null
      const snapshot = String(a.costCodeName ?? '').trim()
      const label = live ? costCodeDisplayName(live) : (snapshot || 'Unknown cost code')
      const category = live ? String(live.category ?? '').trim() : null
      byId.set(id, {
        key: id,
        label,
        // Sort category: a real category first (alphabetical), then codes with
        // none, then codes the lookup could not find — never a made-up value.
        sortCategory: category === null ? '￿' : (category || '￾'),
        hint: category === null ? CATEGORY_UNAVAILABLE_HINT : (category || NO_CATEGORY_HINT),
        activities: [],
      })
    }
    byId.get(id).activities.push(a)
  }
  const groups = [...byId.values()]
    .sort((x, y) => cmpText(x.sortCategory, y.sortCategory) || cmpText(x.label, y.label) || cmpText(x.key, y.key))
    .map(g => finishGroup({ key: g.key, label: g.label, hint: g.hint, activities: g.activities }, now))
  if (none.length > 0) {
    groups.push(finishGroup({ key: NO_COST_CODE_KEY, label: 'No cost code', hint: 'Activities without a cost code', activities: none }, now))
  }
  return groups
}

function groupByResponsible(activities, now) {
  const byId = new Map()
  const none = []
  for (const a of activities) {
    const id = a?.responsibleContactId
    if (!id) { none.push(a); continue }
    if (!byId.has(id)) {
      byId.set(id, { key: id, label: String(a.responsibleName ?? '').trim() || id, hint: '', activities: [] })
    }
    byId.get(id).activities.push(a)
  }
  const groups = [...byId.values()]
    .sort((x, y) => cmpText(x.label, y.label) || cmpText(x.key, y.key))
    .map(g => finishGroup(g, now))
  if (none.length > 0) {
    groups.push(finishGroup({ key: UNASSIGNED_KEY, label: 'Unassigned', hint: 'Activities with no responsible contact', activities: none }, now))
  }
  return groups
}

// Returns a NEW array of groups: { key, label, hint, activities, count,
// overdueCount }. Under NONE there is exactly one group holding every activity
// (the component draws no header for it). Never mutates its input.
export function groupGanttActivities(activities, groupBy = GANTT_GROUP.NONE, { costCodes = [], now = new Date() } = {}) {
  const list = activities ?? []
  if (groupBy === GANTT_GROUP.COST_CODE)   return groupByCostCode(list, costCodes, now)
  if (groupBy === GANTT_GROUP.RESPONSIBLE) return groupByResponsible(list, now)
  return [finishGroup({ key: ALL_GROUP_KEY, label: '', hint: '', activities: list }, now)]
}

// Collapse state is a Set of group keys held by the page. These keep the
// arithmetic out of the component.
export function toggleGroupKey(collapsed, key) {
  const next = new Set(collapsed ?? [])
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export const collapseAllKeys = (groups) => new Set((groups ?? []).map(g => g.key))

// Activity totals across the groups — the whole filtered set, whatever is
// collapsed — so a caller can prove collapsing hid rows, not figures.
export function groupTotals(groups) {
  let count = 0
  let overdueCount = 0
  for (const g of groups ?? []) {
    count += g.count ?? 0
    overdueCount += g.overdueCount ?? 0
  }
  return { count, overdueCount, groups: (groups ?? []).length }
}
