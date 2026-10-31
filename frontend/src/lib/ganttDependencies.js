import {
  ACTIVITY_STATUS, isValidIsoDate, addDays, daysBetween, formatIsoDate, isOpenStatus,
} from './projectTimeline'
import { todayIso } from './payments'

// ── Constrapp GANTT™ dependencies (Programme 1A2, ADR-65) ────────────────────
//
// PURE. No Firestore, no React, no clock of its own (anything date-relative
// takes an injected `now`). The ONE dependency model of the programme:
//
//   activity.predecessors = [ { activityId, type: 'FS', lagDays } ]   (≤ 20)
//
// stored on the SUCCESSOR only, optional (absent on every pre-1A2 document and
// read as []), never a successor list, never a stored derived state. Only
// finish-to-start, only a non-negative lag in whole calendar days.
//
// FINISH-TO-START, with the ADR-29 inclusive date-only calendar:
//   · an ordinary predecessor OCCUPIES its planned finish day, so the successor
//     may start the day after:   earliest = plannedFinish + 1 + lagDays
//   · a milestone is a point with no working day, so the successor may start
//     ON the milestone day:      earliest = plannedFinish + lagDays
// A schedule CONFLICT is `successor.plannedStart < earliest`. Nothing here
// moves a date: conflicts are surfaced, never resolved, and there is no
// automatic rescheduling, no critical path, no working calendar.
//
// ⚠️ A CANCELLED, MISSING, MALFORMED or CYCLIC predecessor never satisfies a
// dependency (Lead Architect correction, 1A2). The link is retained as
// history and reported as "requires review"; once the successor's planned
// start has arrived it counts as BLOCKED until the user removes or replaces
// the link deliberately. Blocked is TIME-TRIGGERED: an activity whose start
// is still in the future is never "blocked" merely because its predecessors
// are open.
//
// ⚠️ Cycle detection is CLIENT-SIDE (Firestore rules have no graph traversal
// — Deferred Control 41). Everything below tolerates malformed or cyclic data
// written through the SDK: every walk carries a visited set, so nothing loops
// forever and one bad document never takes the programme down.

export const PREDECESSOR_TYPE = { FS: 'FS' }
export const PREDECESSOR_TYPES = [PREDECESSOR_TYPE.FS]
export const PREDECESSOR_TYPE_LABELS = { [PREDECESSOR_TYPE.FS]: 'Finish to start' }

export const MAX_PREDECESSORS = 20
export const MIN_LAG_DAYS = 0
export const MAX_LAG_DAYS = 365

// Per-link states, in precedence order (the first that applies wins).
export const DEPENDENCY_STATE = {
  MALFORMED: 'malformed',   // not a usable entry (shape, type, lag)
  MISSING:   'missing',     // names no activity in this programme
  CANCELLED: 'cancelled',   // the predecessor is cancelled history
  CYCLE:     'cycle',       // the link is part of a dependency cycle
  CONFLICT:  'conflict',    // the successor starts before the earliest start
  VALID:     'valid',       // well-formed; may or may not be finished yet
}

export const DEPENDENCY_STATE_LABELS = {
  [DEPENDENCY_STATE.MALFORMED]: 'Malformed dependency — requires review',
  [DEPENDENCY_STATE.MISSING]:   'Missing predecessor — requires review',
  [DEPENDENCY_STATE.CANCELLED]: 'Predecessor cancelled — requires review',
  [DEPENDENCY_STATE.CYCLE]:     'Dependency cycle — requires review',
  [DEPENDENCY_STATE.CONFLICT]:  'Starts before its predecessor allows',
  [DEPENDENCY_STATE.VALID]:     'Finish to start',
}

// A link that never satisfies a dependency and must be reviewed by a person.
export const UNRESOLVED_STATES = [
  DEPENDENCY_STATE.MALFORMED, DEPENDENCY_STATE.MISSING,
  DEPENDENCY_STATE.CANCELLED, DEPENDENCY_STATE.CYCLE,
]
export const isUnresolvedState = (s) => UNRESOLVED_STATES.includes(s)

// ── Normalisation ────────────────────────────────────────────────────────────

export const isPredecessorType = (t) => PREDECESSOR_TYPES.includes(t)

export const isLagValid = (lag) =>
  Number.isInteger(lag) && lag >= MIN_LAG_DAYS && lag <= MAX_LAG_DAYS

// The stored list, or [] for every document that predates 1A2 or carries a
// non-list. Never throws.
export function predecessorsOf(activity) {
  const p = activity?.predecessors
  return Array.isArray(p) ? p : []
}

// One raw entry → { activityId, type, lagDays, malformed }. A malformed entry
// keeps whatever id it carried (for display) and is never treated as usable.
export function normalisePredecessorEntry(raw) {
  const isMap = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  const id = isMap && typeof raw.activityId === 'string' ? raw.activityId.trim() : ''
  const type = isMap ? raw.type : undefined
  // The stored lag is a NUMBER (rules: `is int`); a string is malformed here —
  // the editor converts its typed value through toStoredPredecessors first.
  const lagRaw = isMap ? raw.lagDays : undefined
  const lag = typeof lagRaw === 'number' ? lagRaw : NaN
  const keysOk = isMap && Object.keys(raw).every(k => ['activityId', 'type', 'lagDays'].includes(k))
  const malformed = !isMap || !keysOk || id === '' || !isPredecessorType(type) || !isLagValid(lag)
  return {
    activityId: id || (isMap && raw.activityId != null ? String(raw.activityId) : ''),
    type: isPredecessorType(type) ? type : PREDECESSOR_TYPE.FS,
    lagDays: isLagValid(lag) ? lag : 0,
    malformed,
  }
}

// EXACTLY the stored shape for a list of entries (what the hook writes).
// Malformed entries are dropped here only by callers that decided so; this
// function itself keeps order and never deduplicates — validation reports
// duplicates rather than hiding them.
export function normalisePredecessors(list) {
  return (Array.isArray(list) ? list : []).map(normalisePredecessorEntry)
}

export const toStoredPredecessors = (entries) =>
  (entries ?? []).map(e => ({ activityId: String(e.activityId), type: PREDECESSOR_TYPE.FS, lagDays: Math.trunc(Number(e.lagDays)) }))

// ── Indexes ──────────────────────────────────────────────────────────────────

export function activitiesById(activities) {
  const m = new Map()
  for (const a of activities ?? []) if (a?.id) m.set(a.id, a)
  return m
}

// predecessorId → [successor activities], in input order. Malformed entries
// and empty ids are skipped.
export function successorIndex(activities) {
  const idx = new Map()
  for (const a of activities ?? []) {
    for (const e of normalisePredecessors(predecessorsOf(a))) {
      if (e.malformed || !e.activityId) continue
      if (!idx.has(e.activityId)) idx.set(e.activityId, [])
      idx.get(e.activityId).push(a)
    }
  }
  return idx
}

export const successorsOf = (activityId, index) => (index?.get(activityId) ?? [])

// ── Finish-to-start arithmetic ───────────────────────────────────────────────

// The earliest planned start a successor may have after ONE predecessor, or
// null when the predecessor has no usable planned finish.
export function earliestStartAfter(predecessor, lagDays = 0) {
  if (!predecessor || !isValidIsoDate(predecessor.plannedFinish)) return null
  const lag = isLagValid(lagDays) ? lagDays : 0
  const gap = predecessor.isMilestone === true ? lag : 1 + lag
  return addDays(predecessor.plannedFinish, gap)
}

// Later of two ISO dates (null-tolerant).
const laterIso = (a, b) => {
  if (!a) return b ?? null
  if (!b) return a
  return a >= b ? a : b
}

// ── Cycles ───────────────────────────────────────────────────────────────────

// Every activity id that lies on a dependency cycle (including a self-loop).
// Iterative Tarjan over the predecessor edges; malformed and missing
// references are not edges. Never recurses, never loops.
export function findCycleMembers(activities) {
  const byId = activitiesById(activities)
  const edges = new Map()
  for (const a of byId.values()) {
    const out = []
    for (const e of normalisePredecessors(predecessorsOf(a))) {
      if (!e.malformed && byId.has(e.activityId)) out.push(e.activityId)
    }
    edges.set(a.id, out)
  }

  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const members = new Set()
  let counter = 0

  for (const root of byId.keys()) {
    if (index.has(root)) continue
    // Explicit stack of [node, nextEdgeIndex] frames.
    const frames = [[root, 0]]
    index.set(root, counter); low.set(root, counter); counter += 1
    stack.push(root); onStack.add(root)
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      const [v] = frame
      const out = edges.get(v) ?? []
      if (frame[1] < out.length) {
        const w = out[frame[1]]
        frame[1] += 1
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter += 1
          stack.push(w); onStack.add(w)
          frames.push([w, 0])
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)))
        }
        continue
      }
      // All edges of v explored.
      if (low.get(v) === index.get(v)) {
        const component = []
        let w
        do {
          w = stack.pop(); onStack.delete(w); component.push(w)
        } while (w !== v)
        const selfLoop = component.length === 1 && (edges.get(v) ?? []).includes(v)
        if (component.length > 1 || selfLoop) for (const id of component) members.add(id)
      }
      frames.pop()
      if (frames.length > 0) {
        const [parent] = frames[frames.length - 1]
        low.set(parent, Math.min(low.get(parent), low.get(v)))
      }
    }
  }
  return members
}

// True when making `predecessorId` a predecessor of `successorId` would close
// a cycle: the successor is reachable from the predecessor by following
// stored predecessors (or the two are the same activity). Breadth-first with
// a visited set, over the loaded programme only — a client-side check
// (DC41); a concurrent edit elsewhere can still close a cycle, which the
// read-time `findCycleMembers` then reports.
export function wouldCreateCycle(activities, successorId, predecessorId) {
  if (!successorId || !predecessorId) return false
  if (successorId === predecessorId) return true
  const byId = activities instanceof Map ? activities : activitiesById(activities)
  const seen = new Set([predecessorId])
  const queue = [predecessorId]
  while (queue.length > 0) {
    const id = queue.shift()
    const a = byId.get(id)
    if (!a) continue
    for (const e of normalisePredecessors(predecessorsOf(a))) {
      if (e.malformed || !e.activityId) continue
      if (e.activityId === successorId) return true
      if (!seen.has(e.activityId)) { seen.add(e.activityId); queue.push(e.activityId) }
    }
  }
  return false
}

// ── Derived states (never stored) ────────────────────────────────────────────
//
// For every activity: each link's state, the earliest permitted start over
// the usable links, conflict / review / blocked flags. `now` is the one page
// clock (useLocalToday), so a blocked state flips at local midnight exactly
// as overdue does.
export function dependencyStates(activities, now = new Date()) {
  const list = activities ?? []
  const byId = activitiesById(list)
  const cycleMembers = findCycleMembers(list)
  const today = todayIso(now)
  const out = new Map()

  for (const a of list) {
    if (!a?.id) continue
    const entries = []
    let earliest = null
    let hasConflict = false
    let needsReview = false
    const unfinished = []
    const unresolved = []

    for (const e of normalisePredecessors(predecessorsOf(a))) {
      const predecessor = e.malformed ? null : (byId.get(e.activityId) ?? null)
      let state
      let earliestStart = null
      if (e.malformed) state = DEPENDENCY_STATE.MALFORMED
      else if (!predecessor) state = DEPENDENCY_STATE.MISSING
      else if (predecessor.status === ACTIVITY_STATUS.CANCELLED) state = DEPENDENCY_STATE.CANCELLED
      else if (cycleMembers.has(a.id) && cycleMembers.has(predecessor.id)) state = DEPENDENCY_STATE.CYCLE
      else {
        earliestStart = earliestStartAfter(predecessor, e.lagDays)
        earliest = laterIso(earliest, earliestStart)
        state = (earliestStart && isValidIsoDate(a.plannedStart) && a.plannedStart < earliestStart)
          ? DEPENDENCY_STATE.CONFLICT
          : DEPENDENCY_STATE.VALID
      }
      const finished = Boolean(predecessor) && predecessor.status === ACTIVITY_STATUS.COMPLETED
        && !isUnresolvedState(state)
      if (state === DEPENDENCY_STATE.CONFLICT) hasConflict = true
      if (isUnresolvedState(state)) { needsReview = true; unresolved.push(e.activityId) }
      else if (!finished) unfinished.push(e.activityId)
      entries.push({
        activityId: e.activityId,
        type: e.type,
        lagDays: e.lagDays,
        state,
        stateLabel: DEPENDENCY_STATE_LABELS[state],
        name: predecessor?.name ?? '',
        isMilestone: predecessor?.isMilestone === true,
        predecessorStatus: predecessor?.status ?? null,
        finished,
        earliestStart,
      })
    }

    // Blocked = the successor should have started by its own plan, has not,
    // and at least one dependency is not yet satisfied — unfinished work or an
    // unresolved link. Completed / cancelled / started activities are never
    // blocked; a future start is never blocked.
    const startArrived = isValidIsoDate(a.plannedStart) && a.plannedStart <= today
    const waiting = a.status === ACTIVITY_STATUS.NOT_STARTED
    const blockedBy = waiting && startArrived ? [...unfinished, ...unresolved] : []
    out.set(a.id, {
      id: a.id,
      entries,
      count: entries.length,
      earliestStart: earliest,
      hasConflict,
      needsReview,
      inCycle: cycleMembers.has(a.id),
      isBlocked: blockedBy.length > 0,
      blockedBy,
      unfinishedCount: unfinished.length,
      unresolvedCount: unresolved.length,
    })
  }
  return out
}

// The empty state for an activity the map does not hold.
export const EMPTY_DEPENDENCY_STATE = Object.freeze({
  id: null, entries: [], count: 0, earliestStart: null, hasConflict: false,
  needsReview: false, inCycle: false, isBlocked: false, blockedBy: [],
  unfinishedCount: 0, unresolvedCount: 0,
})

export const stateFor = (states, activityId) => states?.get(activityId) ?? EMPTY_DEPENDENCY_STATE

// ── Validation for the editor and the guarded save ───────────────────────────
//
// Why a candidate may NOT be added. `null` means it may. `existing` is the
// list of entries already on the draft; `previousIds` the ids stored on the
// server copy, which may be retained even when they no longer resolve (a
// cancelled or missing link is shown for review, never silently dropped).
export function predecessorCandidateError(activities, successorId, candidateId, existing = []) {
  const byId = activities instanceof Map ? activities : activitiesById(activities)
  if (!candidateId) return 'Choose a predecessor'
  if (candidateId === successorId) return 'An activity cannot depend on itself'
  if ((existing ?? []).some(e => e.activityId === candidateId)) return 'Already a predecessor'
  const target = byId.get(candidateId)
  if (!target) return 'That activity is not in this project\'s programme'
  if (target.status === ACTIVITY_STATUS.CANCELLED) return 'A cancelled activity cannot be a predecessor'
  if (wouldCreateCycle(byId, successorId, candidateId)) return 'This would create a dependency cycle'
  return null
}

// The whole draft list. Returns an error MESSAGE or null. Retained links
// (ids in `previousIds`) that are missing or cancelled are tolerated so an
// unrelated edit never silently repairs the programme; every NEW link must
// resolve to a live, non-cycling activity in this programme. Malformed
// entries and duplicates are always refused — remove or fix them.
export function validatePredecessorsDraft(entries, { activities, successorId, previousIds = [] } = {}) {
  const raw = Array.isArray(entries) ? entries : []
  const list = normalisePredecessors(raw)
  if (list.length > MAX_PREDECESSORS) return `An activity may have at most ${MAX_PREDECESSORS} predecessors`
  const byId = activities instanceof Map ? activities : activitiesById(activities)
  const seen = new Set()
  const retained = new Set(previousIds ?? [])
  for (const [i, e] of list.entries()) {
    // A well-formed entry whose only fault is the lag gets the lag message.
    const r = raw[i]
    const shapeOk = r !== null && typeof r === 'object' && !Array.isArray(r) && typeof r.activityId === 'string' && r.activityId.trim() !== '' && r.type === PREDECESSOR_TYPE.FS
    if (shapeOk && !isLagValid(r.lagDays)) return `Lag must be a whole number of days from ${MIN_LAG_DAYS} to ${MAX_LAG_DAYS}`
    if (e.malformed) return 'A predecessor entry is malformed — remove it and add it again'
    if (e.activityId === successorId) return 'An activity cannot depend on itself'
    if (seen.has(e.activityId)) return 'The same activity is listed twice as a predecessor'
    seen.add(e.activityId)
    const target = byId.get(e.activityId)
    if (retained.has(e.activityId)) continue
    if (!target) return 'A predecessor is not in this project\'s programme'
    if (target.status === ACTIVITY_STATUS.CANCELLED) return 'A cancelled activity cannot be a predecessor'
    if (successorId && wouldCreateCycle(byId, successorId, e.activityId)) return 'A predecessor would create a dependency cycle'
  }
  return null
}

// The entries of a draft that are NEW relative to the server copy — what the
// guarded save re-reads on the server (DC41 part B).
export function newPredecessorIds(entries, previousIds = []) {
  const prev = new Set(previousIds ?? [])
  return normalisePredecessors(entries)
    .filter(e => !e.malformed && e.activityId && !prev.has(e.activityId))
    .map(e => e.activityId)
}

// ── Conflicts for the editor's acknowledgement ───────────────────────────────

// For a DRAFT (dates and predecessors as typed), the links the planned start
// breaks: [{ activityId, name, earliestStart, lagDays }]. Only usable links
// (a live predecessor with a planned finish) can conflict.
export function draftConflicts(draft, activities) {
  const byId = activities instanceof Map ? activities : activitiesById(activities)
  const start = draft?.plannedStart
  if (!isValidIsoDate(start)) return []
  const out = []
  for (const e of normalisePredecessors(draft?.predecessors)) {
    if (e.malformed) continue
    const p = byId.get(e.activityId)
    if (!p || p.status === ACTIVITY_STATUS.CANCELLED) continue
    const earliest = earliestStartAfter(p, e.lagDays)
    if (earliest && start < earliest) out.push({ activityId: e.activityId, name: p.name ?? '', earliestStart: earliest, lagDays: e.lagDays })
  }
  return out
}

// A stable key for the conflict acknowledgement: whenever the planned start
// or any predecessor (id or lag) changes, the key changes and the
// acknowledgement resets (the editor compares keys).
export function conflictAcknowledgementKey(draft) {
  const preds = normalisePredecessors(draft?.predecessors)
    .map(e => `${e.activityId}:${e.lagDays}`)
    .sort()
    .join('|')
  return `${draft?.plannedStart ?? ''}#${preds}`
}

// ── Accessible text ──────────────────────────────────────────────────────────

const lagText = (lag) => (lag > 0 ? ` plus ${lag === 1 ? '1 day' : `${lag} days`}` : '')

// One sentence describing an activity's links, for the chart bar's accessible
// name, the row label tooltip and the detail dialog. Empty when none.
export function dependencyLabel(state) {
  if (!state || state.count === 0) return ''
  const parts = state.entries.map(e => {
    const who = e.name || e.activityId || 'unknown activity'
    if (e.state === DEPENDENCY_STATE.VALID) {
      return `${who} (finish to start${lagText(e.lagDays)}${e.finished ? ', finished' : ''})`
    }
    if (e.state === DEPENDENCY_STATE.CONFLICT) {
      return `${who} (finish to start${lagText(e.lagDays)}, earliest start ${formatIsoDate(e.earliestStart)} — conflict)`
    }
    return `${who} (${e.stateLabel.toLowerCase()})`
  })
  let s = `Depends on ${parts.join('; ')}.`
  if (state.isBlocked) s += ' Blocked: a predecessor is not finished or needs review.'
  else if (state.hasConflict) s += ' Starts before a predecessor allows.'
  else if (state.needsReview) s += ' A dependency requires review.'
  return s
}

// The short badge text for a row / card, or '' when nothing needs saying.
export function dependencyFlag(state) {
  if (!state || state.count === 0) return ''
  if (state.isBlocked) return 'Blocked'
  if (state.hasConflict) return 'Conflict'
  if (state.needsReview) return 'Review'
  return ''
}

// Days between the current planned start and the earliest permitted one
// (positive = starts that many days too early). null when no usable link.
export function conflictDays(activity, state) {
  if (!state?.earliestStart || !isValidIsoDate(activity?.plannedStart)) return null
  const d = daysBetween(activity.plannedStart, state.earliestStart)
  return d > 0 ? d : 0
}

export const isOpenForDependencies = (a) => Boolean(a) && isOpenStatus(a.status)
