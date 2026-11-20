import { isOverdue, daysLate } from './projectTimeline'
import { DEPENDENCY_STATE, isUnresolvedState } from './ganttDependencies'
import { blockedActivityRows, dependencyReviewRows, baselineSlippageRows } from './pulseSchedule'

// ── Constrap GANTT™ — schedule attention (GANTT core completion, ADR-79) ─────
//
// PURE. No Firestore, no React, no clock of its own (the one page clock is
// injected as `now`). This module answers ONE question for the programme
// page: which activities need a person's attention, and why.
//
// ⚠️ IT DEFINES NOTHING. Every flag is the output of a selector that already
// exists and that Constrap PULSE™ already reports from:
//
//   overdue             lib/projectTimeline.js → isOverdue
//                       (PULSE "Programme activities overdue")
//   blocked             lib/pulseSchedule.js → blockedActivityRows
//                       (PULSE "Blocked activities")
//   conflict / review   lib/pulseSchedule.js → dependencyReviewRows, split by
//                       the link state lib/ganttDependencies.js assigned
//                       (PULSE "Dependencies needing review")
//   later than baseline lib/pulseSchedule.js → baselineSlippageRows
//                       (PULSE "Later than the approved baseline")
//
// so the filter on the GANTT tab and the indicators on the PULSE tab can
// never disagree about what "blocked" or "later than baseline" means. What
// this module adds is the per-activity index, the counts and the match.
//
// ⚠️ ALWAYS BUILT FROM THE COMPLETE PROGRAMME. `activities` and `depStates`
// are the whole loaded programme and its dependency states — never a
// filtered list — so a predecessor hidden by a filter still blocks its
// successor, and a count never changes because a search box was typed in.
//
// ⚠️ ONE DIFFERENCE FROM PULSE, STATED: PULSE measures slippage against the
// ACTIVE approved baseline; this page lets the user SELECT an approved
// version, and the flag follows that selection (it is the comparison the
// chart, the list and the cards are already showing). With no usable
// selected baseline the flag is NOT EVALUATED — `null`, never zero.
//
// Nothing here moves a date, reschedules, computes a critical path or reads
// a financial record.

export const ATTENTION_FLAG = {
  OVERDUE:             'overdue',
  BLOCKED:             'blocked',
  CONFLICT:            'conflict',
  REVIEW:              'review',
  LATER_THAN_BASELINE: 'later_than_baseline',
}

export const ATTENTION_FLAG_ORDER = [
  ATTENTION_FLAG.OVERDUE,
  ATTENTION_FLAG.BLOCKED,
  ATTENTION_FLAG.CONFLICT,
  ATTENTION_FLAG.REVIEW,
  ATTENTION_FLAG.LATER_THAN_BASELINE,
]

export const ATTENTION_FLAG_LABELS = {
  [ATTENTION_FLAG.OVERDUE]:             'Overdue',
  [ATTENTION_FLAG.BLOCKED]:             'Blocked',
  [ATTENTION_FLAG.CONFLICT]:            'Dependency conflict',
  [ATTENTION_FLAG.REVIEW]:              'Dependency requires review',
  [ATTENTION_FLAG.LATER_THAN_BASELINE]: 'Later than baseline',
}

// One sentence per flag — the definition the user is filtering by.
export const ATTENTION_FLAG_HINTS = {
  [ATTENTION_FLAG.OVERDUE]:
    'Open activities whose planned finish is before today. Completed and cancelled work is never overdue.',
  [ATTENTION_FLAG.BLOCKED]:
    'Not started, planned start has arrived, and at least one predecessor is unfinished or needs review.',
  [ATTENTION_FLAG.CONFLICT]:
    'Open activities planned to start before a predecessor allows.',
  [ATTENTION_FLAG.REVIEW]:
    'Open activities with a predecessor link that is missing, cancelled, malformed or part of a cycle.',
  [ATTENTION_FLAG.LATER_THAN_BASELINE]:
    'Open activities whose current planned finish is later than the selected approved baseline.',
}

// The filter control's values: off, any flag, or exactly one flag.
export const ATTENTION_FILTER = {
  OFF: '',
  ANY: 'any',
  ...ATTENTION_FLAG,
}

export const isAttentionFilter = (v) =>
  v === ATTENTION_FILTER.OFF || v === ATTENTION_FILTER.ANY || ATTENTION_FLAG_ORDER.includes(v)

export const attentionFilterLabel = (filter) =>
  filter === ATTENTION_FILTER.ANY ? 'Any attention flag' : (ATTENTION_FLAG_LABELS[filter] ?? '')

const EMPTY_FLAGS = Object.freeze({
  overdue: false, blocked: false, conflict: false, review: false,
  laterThanBaseline: false, daysLate: null, laterBy: null, flags: Object.freeze([]),
})

// `baseline` is the page's SELECTED approved baseline as already derived for
// the chart: { usable, header, comparison }. Anything else (none approved,
// still loading, failed, unusable snapshot) is "not evaluated".
export function buildProgrammeAttention({ activities, depStates, now = new Date(), baseline = null } = {}) {
  const list = (activities ?? []).filter(a => a?.id)
  const baselineEvaluated = Boolean(baseline?.usable && baseline.comparison)

  const overdue = new Map()
  for (const a of list) if (isOverdue(a, now)) overdue.set(a.id, daysLate(a, now))

  const blocked = new Set(blockedActivityRows(list, depStates, now).map(r => r.id))

  const reviewRows = dependencyReviewRows(list, depStates)
  const conflict = new Set()
  const review = new Set()
  let conflictLinks = 0
  let reviewLinks = 0
  for (const r of reviewRows) {
    if (r.state === DEPENDENCY_STATE.CONFLICT) { conflict.add(r.activityId); conflictLinks += 1 }
    else if (isUnresolvedState(r.state)) { review.add(r.activityId); reviewLinks += 1 }
  }

  const later = new Map()
  if (baselineEvaluated) {
    for (const r of baselineSlippageRows(list, baseline.comparison, baseline.header)) later.set(r.id, r.laterBy)
  }

  const byId = new Map()
  for (const a of list) {
    const entry = {
      overdue: overdue.has(a.id),
      blocked: blocked.has(a.id),
      conflict: conflict.has(a.id),
      review: review.has(a.id),
      laterThanBaseline: later.has(a.id),
      daysLate: overdue.get(a.id) ?? null,
      laterBy: later.get(a.id) ?? null,
    }
    const flags = [
      entry.overdue && ATTENTION_FLAG.OVERDUE,
      entry.blocked && ATTENTION_FLAG.BLOCKED,
      entry.conflict && ATTENTION_FLAG.CONFLICT,
      entry.review && ATTENTION_FLAG.REVIEW,
      entry.laterThanBaseline && ATTENTION_FLAG.LATER_THAN_BASELINE,
    ].filter(Boolean)
    if (flags.length > 0) byId.set(a.id, { ...entry, flags })
  }

  return {
    byId,
    baselineEvaluated,
    counts: {
      // Unique activities carrying at least one flag — each once, however
      // many flags it carries.
      any: byId.size,
      overdue: overdue.size,
      blocked: blocked.size,
      conflict: conflict.size,
      review: review.size,
      // null = NOT EVALUATED (no usable selected baseline). Never zero.
      laterThanBaseline: baselineEvaluated ? later.size : null,
      // Links are reported apart from activities, exactly as PULSE does.
      conflictLinks,
      reviewLinks,
      total: list.length,
    },
  }
}

export const attentionFor = (attention, activityId) => attention?.byId?.get(activityId) ?? EMPTY_FLAGS

// The count behind one filter value (null = not evaluated).
export function attentionCount(attention, filter) {
  const c = attention?.counts
  if (!c) return 0
  switch (filter) {
    case ATTENTION_FILTER.ANY: return c.any
    case ATTENTION_FLAG.OVERDUE: return c.overdue
    case ATTENTION_FLAG.BLOCKED: return c.blocked
    case ATTENTION_FLAG.CONFLICT: return c.conflict
    case ATTENTION_FLAG.REVIEW: return c.review
    case ATTENTION_FLAG.LATER_THAN_BASELINE: return c.laterThanBaseline
    default: return c.total
  }
}

export function matchesAttention(attention, activityId, filter) {
  if (!filter) return true
  const f = attentionFor(attention, activityId)
  if (filter === ATTENTION_FILTER.ANY) return f.flags.length > 0
  return f.flags.includes(filter)
}

// NARROWS a list that the other filters already narrowed. The attention index
// itself is never rebuilt from that list.
export function filterByAttention(activities, attention, filter) {
  if (!filter) return activities ?? []
  return (activities ?? []).filter(a => matchesAttention(attention, a?.id, filter))
}

// Flagged activities that are NOT in `shownActivities` — what a filtered
// view or a filtered export leaves out, so it can say so.
export function attentionOutsideScope(attention, shownActivities) {
  const shown = new Set((shownActivities ?? []).map(a => a?.id))
  let n = 0
  for (const id of attention?.byId?.keys() ?? []) if (!shown.has(id)) n += 1
  return n
}
