import {
  ACTIVITY_STATUS_LABELS, isOpenStatus, isOverdue, daysBetween, compareActivities,
} from './projectTimeline'
import { todayIso } from './payments'
import {
  DEPENDENCY_STATE, UNRESOLVED_STATES, isUnresolvedState, stateFor, predecessorsOf,
} from './ganttDependencies'
import {
  VARIANCE_KIND, activeBaseline, approvedBaselines, draftBaselines, isSnapshotUsable,
  baselineVersionLabel, formatDayDelta, varianceFor,
} from './ganttBaseline'

// ── Constrapp PULSE™ 1C — schedule intelligence rows (ADR-67) ────────────────
//
// PURE. No Firestore, no React, no clock of its own (anything date-relative
// takes the injected `now`). This module builds the EVIDENCE ROWS and the
// COUNTS for the three schedule indicators lib/pulse.js composes:
//
//   blockedActivities  — lib/ganttDependencies.js → dependencyStates(...).isBlocked
//   dependencyReview   — the same states, per LINK, on OPEN successors
//   baselineSlippage   — lib/ganttBaseline.js → baselineComparison against the
//                        ACTIVE approved baseline
//
// It re-implements NOTHING: every date is a lib/projectTimeline.js helper,
// every dependency state is the GANTT 1A2 selector's, every variance the
// GANTT 1B selector's. What it adds is filtering, deterministic ordering,
// stable row identity and the sentences a row needs to be acted on. There is
// no critical path, no rescheduling, no delay-in-days for the project, no
// completion forecast and no financial figure — and there must never be.
//
// Readiness (loading / unavailable / needs data) is NOT decided here; that is
// lib/pulse.js through figureState. These helpers only ever see settled
// arrays and tolerate malformed records in them without throwing.

// ── Blocked activities ───────────────────────────────────────────────────────

const activityLabel = (a) => (a?.isMilestone === true ? `${a.name ?? ''} (milestone)` : (a?.name ?? ''))

const entryName = (e) => e.name || e.activityId || 'Unknown activity'

// One row per BLOCKED activity (never one per blocking link): the GANTT
// selector decides blocked — not started, planned start arrived, at least one
// predecessor unfinished or unresolved. `daysWaiting` is calendar days from
// the planned start to the viewer's local day (0 = due to start today).
export function blockedActivityRows(activities, depStates, now = new Date()) {
  const today = todayIso(now)
  const pairs = []
  for (const a of activities ?? []) {
    if (!a?.id) continue
    const s = stateFor(depStates, a.id)
    if (!s.isBlocked) continue
    const unfinished = s.entries.filter(e => !isUnresolvedState(e.state) && !e.finished)
    const unresolved = s.entries.filter(e => isUnresolvedState(e.state))
    pairs.push({
      activity: a,
      row: {
        id: a.id,
        name: activityLabel(a),
        isMilestone: a.isMilestone === true,
        status: a.status,
        plannedStart: a.plannedStart,
        daysWaiting: daysBetween(a.plannedStart, today),
        responsibleName: a.responsibleName || '',
        // The predecessors still to finish, by name.
        blockedBy: unfinished.map(entryName).join('; '),
        // The links that can never satisfy the dependency, with their reason.
        unresolved: unresolved.map(e => `${entryName(e)}: ${e.stateLabel}`).join('; '),
        unfinishedCount: unfinished.length,
        unresolvedCount: unresolved.length,
        overdue: isOverdue(a, now),
      },
    })
  }
  pairs.sort((x, y) => (y.row.daysWaiting - x.row.daysWaiting) || compareActivities(x.activity, y.activity))
  return pairs.map(p => p.row)
}

// True once any activity carries at least one stored predecessor entry — the
// difference between "nothing is blocked" and "nothing could be".
export function hasRecordedDependencies(activities) {
  return (activities ?? []).some(a => predecessorsOf(a).length > 0)
}

// ── Dependency review ────────────────────────────────────────────────────────

// The link states a person must act on: a schedule conflict, plus the four
// states that never satisfy a dependency (ADR-65 correction).
export const REVIEW_STATES = [DEPENDENCY_STATE.CONFLICT, ...UNRESOLVED_STATES]
export const isReviewState = (s) => REVIEW_STATES.includes(s)

// What resolving each condition looks like in the existing editor. Nothing
// here is done for the user: dependencies are never repaired or removed.
export const REVIEW_ACTIONS = {
  [DEPENDENCY_STATE.CONFLICT]:  'Move the planned start to the earliest start, change the lag, or remove the link',
  [DEPENDENCY_STATE.MISSING]:   'Remove the link, or point it at an activity in this programme',
  [DEPENDENCY_STATE.CANCELLED]: 'Remove the link, or replace the cancelled predecessor',
  [DEPENDENCY_STATE.MALFORMED]: 'Remove the link and add it again',
  [DEPENDENCY_STATE.CYCLE]:     'Break the cycle by removing one of its links',
}

// The evidence identity of ONE link: the successor's document id, then the
// stored predecessor id. A Firestore document id can never contain '/', so
// the first '/' always separates the two and no pair of ids can collide with
// another pair. Both halves are stable record ids — never a position, a
// name or a date — so the key is the same on every evaluation.
export const linkEvidenceKey = (successorId, predecessorId) => `${successorId}/${predecessorId}`

// One row per link needing review on an OPEN successor, in programme order
// then stored link order. A completed or cancelled successor's links are
// history and are not listed.
export function dependencyReviewRows(activities, depStates) {
  const ordered = [...(activities ?? [])].sort(compareActivities)
  const rows = []
  for (const a of ordered) {
    if (!a?.id || !isOpenStatus(a.status)) continue
    const s = stateFor(depStates, a.id)
    s.entries.forEach((e, i) => {
      if (!isReviewState(e.state)) return
      rows.push({
        // Unique per row for rendering; the EVIDENCE identity is `linkKey`.
        id: `${a.id}/${e.activityId}#${i}`,
        linkKey: linkEvidenceKey(a.id, e.activityId),
        activityId: a.id,
        name: activityLabel(a),
        predecessorId: e.activityId,
        predecessorName: entryName(e),
        state: e.state,
        condition: e.stateLabel,
        plannedStart: a.plannedStart,
        earliestStart: e.earliestStart ?? null,
        action: REVIEW_ACTIONS[e.state] ?? '',
      })
    })
  }
  return rows
}

// Links (issues) and unique activities (affected records) — reported apart,
// never merged — plus the count per condition and how many links on open
// successors were checked at all.
export function dependencyReviewCounts(rows, activities, depStates) {
  const counts = {
    links: (rows ?? []).length,
    activities: new Set((rows ?? []).map(r => r.activityId)).size,
    conflict: 0, missing: 0, cancelled: 0, malformed: 0, cycle: 0,
    checked: 0,
  }
  for (const r of rows ?? []) if (r.state in counts) counts[r.state] += 1
  for (const a of activities ?? []) {
    if (!a?.id || !isOpenStatus(a.status)) continue
    counts.checked += stateFor(depStates, a.id).count
  }
  return counts
}

// ── Baseline slippage ────────────────────────────────────────────────────────

// Why the active baseline's snapshot cannot be compared, once the reads have
// settled. Every value here is "needs data with an integrity reason" in
// lib/pulse.js — never no issue, never a finding.
export const BASELINE_PROBLEM = {
  NO_SNAPSHOT:    'no_snapshot',     // approved header, no snapshot document
  WRONG_VERSION:  'wrong_version',   // the snapshot read is not the active version's
  MALFORMED:      'malformed',       // not a usable snapshot shape
  COUNT_MISMATCH: 'count_mismatch',  // header and snapshot disagree on activityCount
}

export const BASELINE_PROBLEM_TEXT = {
  [BASELINE_PROBLEM.NO_SNAPSHOT]:    'its snapshot document could not be found',
  [BASELINE_PROBLEM.WRONG_VERSION]:  'the snapshot loaded is not this version\'s',
  [BASELINE_PROBLEM.MALFORMED]:      'its snapshot is not a usable programme capture',
  [BASELINE_PROBLEM.COUNT_MISMATCH]: 'its snapshot and header disagree on the number of activities captured',
}

// The ACTIVE approved baseline (latest approval — lib/ganttBaseline.js) and
// whether the snapshot the page loaded for it can be compared. `snapshot` is
// the one document the page subscribes to for that header's id, or null.
export function resolveActiveBaseline(headers, snapshot) {
  const header = activeBaseline(headers)
  const base = {
    header,
    approvedCount: approvedBaselines(headers).length,
    draftCount: draftBaselines(headers).length,
    usable: false,
    problem: null,
  }
  if (!header) return base
  if (!snapshot) return { ...base, problem: BASELINE_PROBLEM.NO_SNAPSHOT }
  if (typeof snapshot.id === 'string' && snapshot.id !== header.id) return { ...base, problem: BASELINE_PROBLEM.WRONG_VERSION }
  if (!isSnapshotUsable(snapshot)) return { ...base, problem: BASELINE_PROBLEM.MALFORMED }
  if (Number.isInteger(header.activityCount) && snapshot.activityCount !== header.activityCount) {
    return { ...base, problem: BASELINE_PROBLEM.COUNT_MISMATCH }
  }
  return { ...base, usable: true }
}

// The evidence identity of ONE slipped activity under ONE baseline version:
// the baseline document id, then the activity id ('/' never occurs in either,
// so the pair is collision-safe). A new approved version changes every key,
// which is exactly what reopens attention after a re-baseline — without a
// marker row and without touching the acknowledgement shape.
export const baselineEvidenceKey = (baselineId, activityId) => `${baselineId}/${activityId}`

// "Baseline 2 — name" for the active header.
export const activeBaselineLabel = (headers, header) => baselineVersionLabel(headers, header)

// The approval day as 'YYYY-MM-DD' in the viewer's local calendar, or null
// while a server timestamp is still pending.
export function approvedOnIso(header) {
  const ts = header?.approvedAt
  if (!ts) return null
  if (typeof ts.toDate === 'function') return todayIso(ts.toDate())
  if (typeof ts.seconds === 'number') return todayIso(new Date(ts.seconds * 1000))
  return null
}

// One row per OPEN activity that is in the baseline and whose CURRENT planned
// finish is later than the captured finish (positive calendar-day variance —
// lib/ganttBaseline.js). Milestones first; then the largest variance; then
// the programme's own deterministic order. Completed work is never a row: a
// recorded finish after the baseline is history (`completedLate` below),
// not something a person can still act on.
export function baselineSlippageRows(activities, comparison, header) {
  const pairs = []
  for (const a of activities ?? []) {
    if (!a?.id || !isOpenStatus(a.status)) continue
    const v = varianceFor(comparison, a.id)
    if (v.kind !== VARIANCE_KIND.IN_BASELINE || !(v.finishVariance > 0)) continue
    pairs.push({
      activity: a,
      row: {
        id: a.id,
        evidenceKey: baselineEvidenceKey(header?.id ?? '', a.id),
        name: activityLabel(a),
        isMilestone: a.isMilestone === true,
        status: a.status,
        statusLabel: ACTIVITY_STATUS_LABELS[a.status] ?? String(a.status ?? ''),
        baselineFinish: v.entry.plannedFinish,
        plannedFinish: a.plannedFinish,
        laterBy: v.finishVariance,
      },
    })
  }
  pairs.sort((x, y) =>
    (Number(y.row.isMilestone) - Number(x.row.isMilestone))
    || (y.row.laterBy - x.row.laterBy)
    || compareActivities(x.activity, y.activity))
  return pairs.map(p => p.row)
}

// Milestones and other activities are counted apart; a milestone is never in
// both. `later` is the row count — unique activities, each once.
export function baselineSlippageCounts(rows) {
  const list = rows ?? []
  return {
    later: list.length,
    milestonesLater: list.filter(r => r.isMilestone).length,
    activitiesLater: list.filter(r => !r.isMilestone).length,
  }
}

// '+6 days' / '−2 days' / 'unchanged' — the movement of the latest planned
// finish, the ENVELOPE, never a project delay. '' when either side has no
// usable finish.
export function envelopeText(summary) {
  const e = summary?.envelope
  if (!e || !Number.isFinite(e.days)) return ''
  return formatDayDelta(e.days)
}
