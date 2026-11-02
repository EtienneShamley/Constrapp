import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  blockedActivityRows, hasRecordedDependencies,
  REVIEW_STATES, REVIEW_ACTIONS, linkEvidenceKey, dependencyReviewRows, dependencyReviewCounts,
  BASELINE_PROBLEM, BASELINE_PROBLEM_TEXT, resolveActiveBaseline, baselineEvidenceKey, approvedOnIso,
  baselineSlippageRows, baselineSlippageCounts, envelopeText,
} from '../../src/lib/pulseSchedule'
import {
  evaluatePulse, PULSE_STATE, INDICATOR, INDICATOR_ORDER, INDICATOR_DEPENDENCIES, INDICATOR_LINKS, INDICATOR_TITLES,
  PULSE_SOURCES, NEEDS_DATA_REASON, activeBaselineIdFor,
} from '../../src/lib/pulse'
import { evidenceKeysFor, attentionFor, ATTENTION, ATTENTION_REASON, ACK_STATUS } from '../../src/lib/pulseAttention'
import { dependencyStates, DEPENDENCY_STATE, UNRESOLVED_STATES } from '../../src/lib/ganttDependencies'
import { baselineComparison, baselineSummary, activeBaseline, originalBaseline } from '../../src/lib/ganttBaseline'
import { PROJECT_TABS } from '../../src/lib/projectTabs'

// ── Constrapp PULSE™ 1C — schedule intelligence (ADR-67) ─────────────────────
//
// lib/pulseSchedule.js builds the rows and counts of the three schedule
// indicators from the GANTT selectors; lib/pulse.js composes them with the
// same readiness contract as the six ADR-47 indicators. These tests pin:
//
//   1. blocked — the ADR-65 selector decides it: due today, before start,
//      the local-midnight flip, a valid unfinished predecessor, a resolved
//      link, one row per activity however many links, the overdue overlap;
//   2. dependency review — conflict, missing, cancelled, malformed, cycle;
//      open successors only; several links on one activity; links versus
//      unique activities; the collision-safe link key;
//   3. baseline slippage — later milestone, later activity, positive / zero /
//      negative variance, finished-late as history, milestones first, the
//      active (not the original) version, the versioned evidence key;
//   4. readiness — every A–J state of the brief, never zero-risk on a loading
//      or failed read, never a finding without an approved baseline;
//   5. the no-dependencies and empty-programme cases;
//   6. acknowledgement — new evidence after a re-baseline or a new link,
//      stable identity across days, the 200-key limit refuses;
//   7. isolation — the six ADR-47 indicators are byte-identical with and
//      without the schedule sources; a baseline failure blocks nothing else;
//   8. structure — the module is pure, uses no forbidden vocabulary and
//      re-implements no date or dependency arithmetic;
//   9. a 2,000-activity programme evaluates.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

// ── Fixture ──────────────────────────────────────────────────────────────────

const NOW = new Date(2026, 9, 15) // 15 October 2026, local
const TODAY = '2026-10-15'

const act = (id, overrides = {}) => ({
  id, name: id.toUpperCase(), status: 'not_started', isMilestone: false,
  plannedStart: '2026-10-01', plannedFinish: '2026-10-10', percentComplete: 0, sortOrder: 10, revision: 1,
  ...overrides,
})
const fs = (activityId, lagDays = 0) => ({ activityId, type: 'FS', lagDays })

const entryOf = (a, overrides = {}) => ({
  activityId: a.id, name: a.name, isMilestone: a.isMilestone === true,
  plannedStart: a.plannedStart, plannedFinish: a.plannedFinish, status: a.status,
  percentComplete: a.percentComplete ?? 0, revision: a.revision ?? 1, sortOrder: a.sortOrder ?? 0, costCodeId: null,
  ...overrides,
})
const ts = (seconds) => ({ seconds, nanoseconds: 0, toMillis: () => seconds * 1000, toDate: () => new Date(seconds * 1000) })
// 1_791_536_000 s = 2026-10-09T07:33:20Z — 9 October 2026 in every local zone
// from UTC−7 to UTC+14.
const APPROVED_S = 1_791_536_000
const header = (id, overrides = {}) => ({
  id, name: `Programme ${id}`, reason: 'r', status: 'approved', activityCount: 0,
  approvedAt: ts(APPROVED_S), approvedBy: 'u_pm', createdAt: ts(APPROVED_S - 86_400), revision: 2, ...overrides,
})
const snapshotOf = (id, entries, extra = {}) => ({ id, activityCount: entries.length, capturedAt: ts(1), capturedBy: 'u', activities: entries, ...extra })

const settled = (loading = false, error = false) => ({ loading, error })
const allSettled = () => Object.fromEntries(PULSE_SOURCES.map(s => [s, settled()]))
const states = (overrides = {}) => ({ ...allSettled(), ...overrides })

// The financial sources are empty here: the schedule indicators never read
// them, and the six ADR-47 indicators land on needs data / no issue.
const run = (schedule = {}, sourceStates = allSettled(), now = NOW) =>
  evaluatePulse({ sources: { ...schedule }, sourceStates, now, currencyCode: 'AUD' })
const byId = (result) => Object.fromEntries(result.indicators.map(i => [i.id, i]))
const get = (id, schedule, sourceStates, now) => byId(run(schedule, sourceStates, now))[id]

// A programme exercising every dependency state.
const PRED = act('pred', { plannedStart: '2026-09-20', plannedFinish: '2026-10-05', status: 'in_progress', actualStart: '2026-09-20' })
const DONE = act('done', { plannedStart: '2026-09-01', plannedFinish: '2026-09-10', status: 'completed', percentComplete: 100, actualStart: '2026-09-01', actualFinish: '2026-09-10' })
const GONE = act('gone', { status: 'cancelled' })
const PROGRAMME = [
  PRED, DONE, GONE,
  // Waits on the unfinished PRED, start arrived, and starts before PRED allows → blocked + conflict.
  act('blocked1', { plannedStart: '2026-10-01', plannedFinish: '2026-10-20', predecessors: [fs('pred')] }),
  // Waits on the cancelled GONE → blocked (never satisfied) + review.
  act('blocked2', { plannedStart: '2026-10-10', plannedFinish: '2026-10-12', predecessors: [fs('gone')] }),
  // Start in the future on the same unfinished PRED → NOT blocked, no conflict (starts after the earliest start).
  act('future', { plannedStart: '2026-11-01', plannedFinish: '2026-11-10', predecessors: [fs('pred')] }),
  // Resolved: depends on the completed DONE, start arrived → not blocked, nothing to review.
  act('resolved', { plannedStart: '2026-10-01', plannedFinish: '2026-10-30', predecessors: [fs('done')] }),
  // Missing predecessor, start in the future → review only (not blocked).
  act('orphan', { plannedStart: '2026-12-01', plannedFinish: '2026-12-05', predecessors: [fs('ghost')] }),
  // Malformed entry, in progress → review only (a started activity is never blocked).
  act('mal', { status: 'in_progress', actualStart: '2026-10-01', predecessors: [{ activityId: 'pred', type: 'SS', lagDays: 0 }] }),
  // A cycle, both in the future → review only.
  act('cycA', { plannedStart: '2026-12-01', plannedFinish: '2026-12-02', predecessors: [fs('cycB')] }),
  act('cycB', { plannedStart: '2026-12-01', plannedFinish: '2026-12-02', predecessors: [fs('cycA')] }),
  // A completed successor with a cancelled predecessor — history, never listed.
  act('histDone', { status: 'completed', percentComplete: 100, actualStart: '2026-09-01', actualFinish: '2026-09-05', plannedStart: '2026-09-01', plannedFinish: '2026-09-05', predecessors: [fs('gone')] }),
  // No dependencies at all; overdue.
  act('plain', { plannedStart: '2026-09-01', plannedFinish: '2026-09-30' }),
]
const DEP = dependencyStates(PROGRAMME, NOW)

// ── 1 · Blocked activities ───────────────────────────────────────────────────

describe('blocked activities — the ADR-65 selector decides, one row per activity', () => {
  const rows = blockedActivityRows(PROGRAMME, DEP, NOW)

  it('lists exactly the activities the selector reports as blocked, longest waiting first', () => {
    expect(rows.map(r => r.id)).toEqual(['blocked1', 'blocked2'])
    expect(rows[0].daysWaiting).toBe(14)
    expect(rows[1].daysWaiting).toBe(5)
    expect(rows.every(r => DEP.get(r.id).isBlocked)).toBe(true)
  })

  it('names the unfinished predecessors and, separately, the links that can never satisfy the dependency', () => {
    expect(rows[0]).toMatchObject({ blockedBy: 'PRED', unresolved: '', unfinishedCount: 1, unresolvedCount: 0, overdue: false })
    expect(rows[1]).toMatchObject({ blockedBy: '', unresolved: 'GONE: Predecessor cancelled — requires review', unfinishedCount: 0, unresolvedCount: 1, overdue: true })
  })

  it('a valid unfinished predecessor on a FUTURE start never blocks; a completed predecessor never blocks; a started activity never blocks', () => {
    for (const id of ['future', 'resolved', 'mal', 'pred', 'done', 'gone', 'plain', 'histDone']) {
      expect(rows.map(r => r.id), id).not.toContain(id)
    }
  })

  it('due to start TODAY is blocked (0 days waiting); due to start tomorrow is not — and the local midnight flips it', () => {
    const list = [PRED, act('today', { plannedStart: TODAY, plannedFinish: '2026-10-20', predecessors: [fs('pred')] }), act('tomorrow', { plannedStart: '2026-10-16', plannedFinish: '2026-10-20', predecessors: [fs('pred')] })]
    const today = blockedActivityRows(list, dependencyStates(list, NOW), NOW)
    expect(today.map(r => [r.id, r.daysWaiting])).toEqual([['today', 0]])
    const afterMidnight = new Date(2026, 9, 16, 0, 0, 1)
    const next = blockedActivityRows(list, dependencyStates(list, afterMidnight), afterMidnight)
    expect(next.map(r => [r.id, r.daysWaiting])).toEqual([['today', 1], ['tomorrow', 0]])
    const beforeMidnight = new Date(2026, 9, 15, 23, 59, 59)
    expect(blockedActivityRows(list, dependencyStates(list, beforeMidnight), beforeMidnight).map(r => r.id)).toEqual(['today'])
  })

  it('an activity with several blocking links is ONE row, counted once', () => {
    const list = [PRED, GONE, act('multi', { plannedStart: '2026-10-01', plannedFinish: '2026-10-20', predecessors: [fs('pred'), fs('gone'), fs('nobody')] })]
    const r = blockedActivityRows(list, dependencyStates(list, NOW), NOW)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: 'multi', unfinishedCount: 1, unresolvedCount: 2 })
    expect(r[0].unresolved).toContain('GONE: Predecessor cancelled')
    expect(r[0].unresolved).toContain('nobody: Missing predecessor')
  })

  it('a milestone can be blocked and is labelled as one; responsible is carried through', () => {
    const list = [PRED, act('ms', { isMilestone: true, plannedStart: '2026-10-10', plannedFinish: '2026-10-10', responsibleName: 'Pat', predecessors: [fs('pred')] })]
    const r = blockedActivityRows(list, dependencyStates(list, NOW), NOW)
    expect(r[0]).toMatchObject({ id: 'ms', name: 'MS (milestone)', isMilestone: true, responsibleName: 'Pat' })
  })

  it('hasRecordedDependencies is true once any activity carries a predecessor entry', () => {
    expect(hasRecordedDependencies(PROGRAMME)).toBe(true)
    expect(hasRecordedDependencies([PRED, DONE])).toBe(false)
    expect(hasRecordedDependencies([act('x', { predecessors: [] })])).toBe(false)
    expect(hasRecordedDependencies([act('x', { predecessors: 'junk' })])).toBe(false)
    expect(hasRecordedDependencies(null)).toBe(false)
  })

  it('tolerates junk without throwing and never mutates its input', () => {
    const junk = [null, {}, { id: 'j', predecessors: [null, 7, { activityId: 9 }] }, act('ok', { predecessors: [fs('j')] })]
    const before = JSON.stringify(junk)
    expect(() => blockedActivityRows(junk, dependencyStates(junk, NOW), NOW)).not.toThrow()
    expect(JSON.stringify(junk)).toBe(before)
  })
})

// ── 2 · Dependency review ────────────────────────────────────────────────────

describe('dependency review — one row per link needing review on an OPEN successor', () => {
  const rows = dependencyReviewRows(PROGRAMME, DEP)

  it('the review states are conflict plus the four unresolved states; each has a review action', () => {
    expect(REVIEW_STATES).toEqual([DEPENDENCY_STATE.CONFLICT, ...UNRESOLVED_STATES])
    for (const s of REVIEW_STATES) expect(REVIEW_ACTIONS[s], s).toEqual(expect.any(String))
  })

  it('classifies conflict, cancelled, missing, malformed and cycle — in programme order (compareActivities: order, start, finish, name)', () => {
    expect(rows.map(r => [r.activityId, r.predecessorId, r.state])).toEqual([
      ['mal', 'pred', 'malformed'],
      ['blocked1', 'pred', 'conflict'],
      ['blocked2', 'gone', 'cancelled'],
      ['cycA', 'cycB', 'cycle'],
      ['cycB', 'cycA', 'cycle'],
      ['orphan', 'ghost', 'missing'],
    ])
    expect(rows[1]).toMatchObject({ condition: 'Starts before its predecessor allows', plannedStart: '2026-10-01', earliestStart: '2026-10-06', action: REVIEW_ACTIONS.conflict })
    expect(rows[2].earliestStart).toBeNull()
    expect(rows[5].predecessorName).toBe('ghost')
    expect(rows[0].action).toBe(REVIEW_ACTIONS.malformed)
  })

  it('a valid unfinished predecessor, a resolved link and links on completed or cancelled successors are never rows', () => {
    for (const id of ['future', 'resolved', 'histDone', 'done', 'gone']) expect(rows.map(r => r.activityId), id).not.toContain(id)
  })

  it('several links on one activity are several rows, one unique activity — links and activities never merged', () => {
    const list = [PRED, GONE, act('multi', { plannedStart: '2026-11-01', plannedFinish: '2026-11-20', predecessors: [fs('gone'), fs('nobody'), fs('pred', 400)] })]
    const r = dependencyReviewRows(list, dependencyStates(list, NOW))
    expect(r.map(x => x.state)).toEqual(['cancelled', 'missing', 'malformed'])
    expect(r.map(x => x.id)).toEqual(['multi/gone#0', 'multi/nobody#1', 'multi/pred#2'])
    const c = dependencyReviewCounts(r, list, dependencyStates(list, NOW))
    expect(c).toMatchObject({ links: 3, activities: 1, cancelled: 1, missing: 1, malformed: 1, conflict: 0, cycle: 0, checked: 3 })
  })

  it('counts over the fixture: links, unique activities, per condition, links checked on open successors', () => {
    expect(dependencyReviewCounts(rows, PROGRAMME, DEP)).toEqual({
      links: 6, activities: 6, conflict: 1, missing: 1, cancelled: 1, malformed: 1, cycle: 2,
      checked: 8, // every link on an OPEN successor (incl. future and resolved); histDone's link is history
    })
  })

  it('the link key is successor/predecessor — collision-safe because a document id can never contain "/"', () => {
    expect(linkEvidenceKey('a2', 'a1')).toBe('a2/a1')
    expect(rows.map(r => r.linkKey)).toEqual(['mal/pred', 'blocked1/pred', 'blocked2/gone', 'cycA/cycB', 'cycB/cycA', 'orphan/ghost'])
    // 'ab' + 'c' and 'a' + 'bc' cannot collide.
    expect(linkEvidenceKey('ab', 'c')).not.toBe(linkEvidenceKey('a', 'bc'))
    // A malformed entry keeps whatever id it carried, so its key is still distinct per entry.
    const list = [act('m', { plannedStart: '2026-11-01', predecessors: [{ activityId: 9 }, { activityId: '' }] })]
    const r = dependencyReviewRows(list, dependencyStates(list, NOW))
    expect(r.map(x => x.linkKey)).toEqual(['m/9', 'm/'])
  })

  it('never throws on junk and never mutates', () => {
    const junk = [null, { id: 'x', status: 'not_started', predecessors: [undefined, 1, 'y', { type: 'FS' }] }]
    const before = JSON.stringify(junk)
    expect(() => dependencyReviewRows(junk, dependencyStates(junk, NOW))).not.toThrow()
    expect(JSON.stringify(junk)).toBe(before)
  })
})

// ── 3 · Baseline slippage ────────────────────────────────────────────────────

const B_OPEN_LATER   = act('later',    { plannedStart: '2026-10-01', plannedFinish: '2026-10-20' })
const B_MS_LATER     = act('msLater',  { isMilestone: true, plannedStart: '2026-11-10', plannedFinish: '2026-11-10' })
const B_MS_LATER2    = act('msLater2', { isMilestone: true, plannedStart: '2026-11-05', plannedFinish: '2026-11-05' })
const B_UNCHANGED    = act('same',     { plannedStart: '2026-10-01', plannedFinish: '2026-10-10' })
const B_EARLIER      = act('earlier',  { plannedStart: '2026-10-01', plannedFinish: '2026-10-08' })
const B_DONE_LATE    = act('doneLate', { status: 'completed', percentComplete: 100, actualStart: '2026-09-01', actualFinish: '2026-09-20', plannedStart: '2026-09-01', plannedFinish: '2026-09-10' })
const B_DONE_MOVED   = act('doneMoved', { status: 'completed', percentComplete: 100, actualStart: '2026-09-01', actualFinish: '2026-09-09', plannedStart: '2026-09-01', plannedFinish: '2026-09-25' })
const B_ADDED        = act('added',    { plannedStart: '2026-10-01', plannedFinish: '2026-12-31' })
const B_CANCELLED    = act('cancelledSince', { status: 'cancelled', plannedFinish: '2026-12-31' })
const B_WAS_CANCELLED = act('wasCancelled', { status: 'cancelled' })
const B_BAD_DATE     = act('badDate', { plannedFinish: 'not-a-date' })
const BASELINE_ACTIVITIES = [B_OPEN_LATER, B_MS_LATER, B_MS_LATER2, B_UNCHANGED, B_EARLIER, B_DONE_LATE, B_DONE_MOVED, B_ADDED, B_CANCELLED, B_WAS_CANCELLED, B_BAD_DATE]
const ENTRIES = [
  entryOf(B_OPEN_LATER,  { plannedFinish: '2026-10-10' }),  // +10
  entryOf(B_MS_LATER,    { plannedStart: '2026-11-01', plannedFinish: '2026-11-01' }), // +9
  entryOf(B_MS_LATER2,   { plannedStart: '2026-11-01', plannedFinish: '2026-11-01' }), // +4
  entryOf(B_UNCHANGED),                                        // 0
  entryOf(B_EARLIER,     { plannedFinish: '2026-10-10' }),  // −2
  entryOf(B_DONE_LATE),                                        // finished 10 days late — history
  entryOf(B_DONE_MOVED,  { plannedFinish: '2026-09-10' }),  // completed; plan moved later but finished before baseline
  entryOf(B_CANCELLED,   { status: 'not_started', plannedFinish: '2026-10-10' }), // cancelled since
  entryOf(B_WAS_CANCELLED, { status: 'cancelled' }),           // cancelled at capture
  entryOf(B_BAD_DATE,    { plannedFinish: '2026-10-10' }),  // invalid on the live side
]
const ORIGINAL = header('bl1', { name: 'Award', activityCount: ENTRIES.length, approvedAt: ts(APPROVED_S - 30 * 86_400) })
const ACTIVE   = header('bl2', { name: 'Revised', activityCount: ENTRIES.length, approvedAt: ts(APPROVED_S) })
const DRAFT    = header('bl3', { status: 'draft', approvedAt: null, activityCount: 3 })
const HEADERS  = [ORIGINAL, DRAFT, ACTIVE]
const SNAPSHOT = snapshotOf('bl2', ENTRIES)
const COMPARISON = baselineComparison(BASELINE_ACTIVITIES, SNAPSHOT)
const SUMMARY = baselineSummary(BASELINE_ACTIVITIES, SNAPSHOT)

describe('baseline slippage — open activities later than the ACTIVE baseline', () => {
  const rows = baselineSlippageRows(BASELINE_ACTIVITIES, COMPARISON, ACTIVE)

  it('milestones first, then the largest positive variance, then programme order; the key carries the version', () => {
    expect(rows.map(r => [r.id, r.laterBy, r.isMilestone])).toEqual([
      ['msLater', 9, true], ['msLater2', 4, true], ['later', 10, false],
    ])
    expect(rows.map(r => r.evidenceKey)).toEqual(['bl2/msLater', 'bl2/msLater2', 'bl2/later'])
    expect(rows[2]).toMatchObject({ name: 'LATER', baselineFinish: '2026-10-10', plannedFinish: '2026-10-20', statusLabel: 'Not started' })
    expect(rows[0].name).toBe('MSLATER (milestone)')
  })

  it('zero and negative variance, completed work (even finished late), added, cancelled and invalid activities are never rows', () => {
    for (const id of ['same', 'earlier', 'doneLate', 'doneMoved', 'added', 'cancelledSince', 'wasCancelled', 'badDate']) {
      expect(rows.map(r => r.id), id).not.toContain(id)
    }
  })

  it('counts milestones and other activities apart — a milestone is never in both', () => {
    expect(baselineSlippageCounts(rows)).toEqual({ later: 3, milestonesLater: 2, activitiesLater: 1 })
    expect(baselineSlippageCounts([])).toEqual({ later: 0, milestonesLater: 0, activitiesLater: 0 })
  })

  it('finished-late and the envelope are context from baselineSummary, never a row', () => {
    expect(SUMMARY.completedLate).toBe(1)
    expect(SUMMARY.completedCompared).toBe(2)
    expect(SUMMARY.addedAfter).toBe(1)
    expect(SUMMARY.cancelledSince).toBe(1)
    expect(SUMMARY.cancelledAtCapture).toBe(1)
    expect(SUMMARY.invalid).toBe(1)
    expect(SUMMARY.earlier).toBe(1)
    expect(SUMMARY.envelope).toEqual({ baselineFinish: '2026-11-01', currentFinish: '2026-12-31', days: 60 })
    expect(envelopeText(SUMMARY)).toBe('+60 days')
    expect(envelopeText({ envelope: { days: 0 } })).toBe('unchanged')
    expect(envelopeText({ envelope: { days: -3 } })).toBe('−3 days')
    expect(envelopeText({ envelope: null })).toBe('')
    expect(envelopeText(null)).toBe('')
  })

  it('compares the ACTIVE baseline (latest approval), never the original or a draft', () => {
    expect(activeBaseline(HEADERS).id).toBe('bl2')
    expect(originalBaseline(HEADERS).id).toBe('bl1')
    expect(activeBaselineIdFor(HEADERS)).toBe('bl2')
    expect(activeBaselineIdFor([ORIGINAL, DRAFT])).toBe('bl1')
    expect(activeBaselineIdFor([DRAFT])).toBeNull()
    expect(activeBaselineIdFor([])).toBeNull()
    expect(activeBaselineIdFor(null)).toBeNull()
  })

  it('resolveActiveBaseline: usable, no snapshot, wrong version, malformed, count mismatch, and the approval day', () => {
    expect(resolveActiveBaseline(HEADERS, SNAPSHOT)).toMatchObject({ header: ACTIVE, approvedCount: 2, draftCount: 1, usable: true, problem: null })
    expect(resolveActiveBaseline(HEADERS, null)).toMatchObject({ usable: false, problem: BASELINE_PROBLEM.NO_SNAPSHOT })
    expect(resolveActiveBaseline(HEADERS, { ...SNAPSHOT, id: 'bl1' })).toMatchObject({ usable: false, problem: BASELINE_PROBLEM.WRONG_VERSION })
    expect(resolveActiveBaseline(HEADERS, { id: 'bl2', activityCount: 'x', activities: ENTRIES })).toMatchObject({ usable: false, problem: BASELINE_PROBLEM.MALFORMED })
    expect(resolveActiveBaseline(HEADERS, { id: 'bl2', activityCount: 3, activities: 'junk' })).toMatchObject({ usable: false, problem: BASELINE_PROBLEM.MALFORMED })
    expect(resolveActiveBaseline(HEADERS, { ...SNAPSHOT, activityCount: 1 })).toMatchObject({ usable: false, problem: BASELINE_PROBLEM.COUNT_MISMATCH })
    expect(resolveActiveBaseline([DRAFT], null)).toMatchObject({ header: null, approvedCount: 0, draftCount: 1, usable: false, problem: null })
    expect(resolveActiveBaseline([], SNAPSHOT)).toMatchObject({ header: null, usable: false })
    for (const p of Object.values(BASELINE_PROBLEM)) expect(BASELINE_PROBLEM_TEXT[p]).toEqual(expect.any(String))
    expect(approvedOnIso(ACTIVE)).toBe('2026-10-09')
    expect(approvedOnIso({ approvedAt: { seconds: APPROVED_S } })).toBe('2026-10-09')
    expect(approvedOnIso({ approvedAt: null })).toBeNull()
    expect(approvedOnIso(null)).toBeNull()
    expect(baselineEvidenceKey('bl2', 'a1')).toBe('bl2/a1')
  })

  it('never mutates its inputs', () => {
    const before = JSON.stringify([BASELINE_ACTIVITIES, SNAPSHOT, HEADERS])
    baselineSlippageRows(BASELINE_ACTIVITIES, COMPARISON, ACTIVE)
    resolveActiveBaseline(HEADERS, SNAPSHOT)
    expect(JSON.stringify([BASELINE_ACTIVITIES, SNAPSHOT, HEADERS])).toBe(before)
  })
})

// ── 4 · Composition in lib/pulse.js — readiness and the finding contract ─────

const SCHEDULE_SOURCES = {
  activities: [...PROGRAMME, ...BASELINE_ACTIVITIES],
  programmeBaselines: HEADERS,
  programmeBaselineSnapshot: snapshotOf('bl2', [...PROGRAMME.map(a => entryOf(a)), ...ENTRIES]),
}
SCHEDULE_SOURCES.programmeBaselines = HEADERS.map(h => (h.status === 'approved' ? { ...h, activityCount: SCHEDULE_SOURCES.programmeBaselineSnapshot.activityCount } : h))

describe('lib/pulse.js — the three schedule indicators in the registry', () => {
  it('nine ids; the three new ones sit together after overdue; titles, links to the GANTT tab, dependencies', () => {
    expect(Object.values(INDICATOR)).toHaveLength(9)
    expect(INDICATOR_ORDER.slice(3, 7)).toEqual(['overdueActivities', 'blockedActivities', 'dependencyReview', 'baselineSlippage'])
    expect(INDICATOR_TITLES[INDICATOR.BLOCKED_ACTIVITIES]).toBe('Programme activities blocked by predecessors')
    expect(INDICATOR_TITLES[INDICATOR.DEPENDENCY_REVIEW]).toBe('Programme dependencies need review')
    expect(INDICATOR_TITLES[INDICATOR.BASELINE_SLIPPAGE]).toBe('Programme later than approved baseline')
    for (const id of [INDICATOR.BLOCKED_ACTIVITIES, INDICATOR.DEPENDENCY_REVIEW, INDICATOR.BASELINE_SLIPPAGE]) {
      expect(INDICATOR_LINKS[id]).toEqual({ to: 'timeline', label: 'Open GANTT' })
      expect(PROJECT_TABS.map(t => t.to)).toContain('timeline')
    }
    expect(INDICATOR_DEPENDENCIES[INDICATOR.BLOCKED_ACTIVITIES]).toEqual(['activities'])
    expect(INDICATOR_DEPENDENCIES[INDICATOR.DEPENDENCY_REVIEW]).toEqual(['activities'])
    expect(INDICATOR_DEPENDENCIES[INDICATOR.BASELINE_SLIPPAGE]).toEqual(['activities', 'programmeBaselines', 'programmeBaselineSnapshot'])
    // Overdue keeps its current-plan meaning: activities only, never a baseline source.
    expect(INDICATOR_DEPENDENCIES[INDICATOR.OVERDUE_ACTIVITIES]).toEqual(['activities'])
  })

  it('blocked: finding with the rows, the overlap count, and the three caveats', () => {
    const ind = get(INDICATOR.BLOCKED_ACTIVITIES, SCHEDULE_SOURCES)
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.headline).toBe('2 activities should have started but are blocked by a predecessor')
    expect(ind.evidence.map(r => r.id)).toEqual(['blocked1', 'blocked2'])
    expect(ind.values).toMatchObject({ blocked: 2, alsoOverdue: 1 })
    expect(ind.evidenceColumns.map(c => c.key)).toEqual(['name', 'plannedStart', 'daysWaiting', 'blockedBy', 'unresolved', 'responsibleName'])
    expect(ind.caveats.join(' ')).toMatch(/not a critical path/)
    expect(ind.caveats.join(' ')).toMatch(/never added together/)
    expect(evidenceKeysFor(ind)).toEqual(['blocked1', 'blocked2'])
    const one = get(INDICATOR.BLOCKED_ACTIVITIES, { ...SCHEDULE_SOURCES, activities: [PRED, PROGRAMME[3]] })
    expect(one.headline).toBe('1 activity should have started but is blocked by a predecessor')
  })

  it('dependency review: finding names links AND unique activities; the condition and action per row', () => {
    const ind = get(INDICATOR.DEPENDENCY_REVIEW, SCHEDULE_SOURCES)
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.headline).toBe('6 dependency links on 6 open activities need review')
    expect(ind.values).toMatchObject({ links: 6, activities: 6, conflict: 1, cancelled: 1, missing: 1, malformed: 1, cycle: 2 })
    expect(ind.evidenceColumns.map(c => c.key)).toEqual(['name', 'predecessorName', 'condition', 'plannedStart', 'earliestStart', 'action'])
    expect(evidenceKeysFor(ind)).toEqual(['blocked1/pred', 'blocked2/gone', 'cycA/cycB', 'cycB/cycA', 'mal/pred', 'orphan/ghost'])
    const one = get(INDICATOR.DEPENDENCY_REVIEW, { ...SCHEDULE_SOURCES, activities: [GONE, PROGRAMME[4]] })
    expect(one.headline).toBe('1 dependency link on 1 open activity needs review')
  })

  it('baseline slippage: finding leads with milestones, names the active version and its approval date', () => {
    const ind = get(INDICATOR.BASELINE_SLIPPAGE, SCHEDULE_SOURCES)
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.headline).toBe('2 milestones and 1 activity are planned later than Baseline 2 — Revised')
    expect(ind.explanation).toContain('Compared with Baseline 2 — Revised, approved 09/10/2026 (2 approved versions).')
    expect(ind.values).toMatchObject({
      baselineLabel: 'Baseline 2 — Revised', approvedOn: '2026-10-09', approvedVersions: 2, drafts: 1,
      later: 3, milestonesLater: 2, activitiesLater: 1, earlier: 1, addedAfter: 1, cancelledSince: 1, completedLate: 1,
      // The combined programme's latest baseline finish is `orphan` (05/12);
      // the live side's is the added activity (31/12): +26 days, labelled an envelope.
      envelope: '+26 days', envelopeBaselineFinish: '2026-12-05', envelopeCurrentFinish: '2026-12-31',
    })
    expect(ind.evidence.map(r => r.id)).toEqual(['msLater', 'msLater2', 'later'])
    expect(ind.evidenceColumns.map(c => c.key)).toEqual(['name', 'baselineFinish', 'plannedFinish', 'laterBy', 'statusLabel'])
    expect(evidenceKeysFor(ind)).toEqual(['bl2/later', 'bl2/msLater', 'bl2/msLater2'])
    expect(ind.caveats.join(' ')).toMatch(/planning evidence/)
    expect(ind.caveats.join(' ')).toMatch(/not a project delay/)
    expect(ind.caveats.join(' ')).toMatch(/not a critical path/)
    // One milestone only / one activity only.
    const ms = get(INDICATOR.BASELINE_SLIPPAGE, { ...SCHEDULE_SOURCES, activities: [B_MS_LATER, B_UNCHANGED] })
    expect(ms.headline).toBe('1 milestone is planned later than Baseline 2 — Revised')
    const one = get(INDICATOR.BASELINE_SLIPPAGE, { ...SCHEDULE_SOURCES, activities: [B_OPEN_LATER, B_EARLIER] })
    expect(one.headline).toBe('1 activity is planned later than Baseline 2 — Revised')
  })

  it('no issue: a usable baseline with no positive variance, counts shown', () => {
    const ind = get(INDICATOR.BASELINE_SLIPPAGE, { ...SCHEDULE_SOURCES, activities: [B_UNCHANGED, B_EARLIER, B_DONE_LATE, B_ADDED] })
    expect(ind.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(ind.headline).toBe('No open activity is planned later than Baseline 2 — Revised (3 compared)')
    expect(ind.values).toMatchObject({ later: 0, completedLate: 1, addedAfter: 1 })
    expect(evidenceKeysFor(ind)).toEqual([])
  })
})

describe('readiness — the A–J states, never zero risk on a loading, failed or unusable read', () => {
  const S = SCHEDULE_SOURCES
  const B = INDICATOR.BASELINE_SLIPPAGE

  it('A headers loading → loading; B header read failed → unavailable, naming Programme Baselines', () => {
    expect(get(B, S, states({ programmeBaselines: settled(true, false) })).state).toBe(PULSE_STATE.LOADING)
    const failed = get(B, S, states({ programmeBaselines: settled(false, true) }))
    expect(failed.state).toBe(PULSE_STATE.UNAVAILABLE)
    expect(failed.failedSources).toEqual(['programmeBaselines'])
  })

  it('C no approved baseline → needs data; D drafts only → needs data naming the drafts; never a finding, never overdue', () => {
    const none = get(B, { ...S, programmeBaselines: [], programmeBaselineSnapshot: null })
    expect(none.state).toBe(PULSE_STATE.NEEDS_DATA)
    expect(none.reason).toBe(NEEDS_DATA_REASON.NO_APPROVED_BASELINE)
    expect(none.headline).toBe('No approved baseline to compare against')
    expect(none.explanation).toContain('not an overdue finding')
    expect(none.evidence).toEqual([])
    const drafts = get(B, { ...S, programmeBaselines: [DRAFT, header('d2', { status: 'draft', approvedAt: null })], programmeBaselineSnapshot: null })
    expect(drafts.state).toBe(PULSE_STATE.NEEDS_DATA)
    expect(drafts.headline).toBe('No approved baseline — 2 draft baselines are awaiting review')
    expect(drafts.values).toEqual({ approvedVersions: 0, drafts: 2 })
    // A withdrawn draft is nothing.
    const withdrawn = get(B, { ...S, programmeBaselines: [header('w', { status: 'withdrawn', approvedAt: null })], programmeBaselineSnapshot: null })
    expect(withdrawn.headline).toBe('No approved baseline to compare against')
  })

  it('E snapshot loading → loading; F snapshot read failed → unavailable naming the snapshot', () => {
    expect(get(B, S, states({ programmeBaselineSnapshot: settled(true, false) })).state).toBe(PULSE_STATE.LOADING)
    const failed = get(B, S, states({ programmeBaselineSnapshot: settled(false, true) }))
    expect(failed.state).toBe(PULSE_STATE.UNAVAILABLE)
    expect(failed.failedSources).toEqual(['programmeBaselineSnapshot'])
  })

  it('G snapshot missing, the wrong version, malformed or mismatched → needs data with the integrity reason', () => {
    const cases = [
      [null, 'could not be found'],
      [{ ...S.programmeBaselineSnapshot, id: 'bl1' }, 'not this version'],
      [{ id: 'bl2', activityCount: 2, activities: 'junk' }, 'not a usable programme capture'],
      [{ ...S.programmeBaselineSnapshot, activityCount: 1 }, 'disagree on the number of activities'],
    ]
    for (const [snapshot, text] of cases) {
      const ind = get(B, { ...S, programmeBaselineSnapshot: snapshot })
      expect(ind.state, text).toBe(PULSE_STATE.NEEDS_DATA)
      expect(ind.reason).toBe(NEEDS_DATA_REASON.BASELINE_UNUSABLE)
      expect(ind.headline).toContain(text)
      expect(ind.explanation).toContain('not a healthy result')
      expect(ind.values.baselineLabel).toBe('Baseline 2 — Revised')
      expect(ind.evidence).toEqual([])
    }
  })

  it('H activities read failed → all three schedule indicators unavailable; loading → loading', () => {
    for (const id of [INDICATOR.BLOCKED_ACTIVITIES, INDICATOR.DEPENDENCY_REVIEW, B]) {
      expect(get(id, S, states({ activities: settled(false, true) })).state, id).toBe(PULSE_STATE.UNAVAILABLE)
      expect(get(id, S, states({ activities: settled(true, false) })).state, id).toBe(PULSE_STATE.LOADING)
    }
  })

  it('I fully available with no positive variance → no issue; J a positive variance → finding', () => {
    expect(get(B, { ...S, activities: [B_UNCHANGED] }).state).toBe(PULSE_STATE.NO_ISSUE)
    expect(get(B, { ...S, activities: [B_OPEN_LATER] }).state).toBe(PULSE_STATE.FINDING)
  })

  it('an empty programme is needs data (no programme) for all three; a missing baseline source entry is unavailable', () => {
    for (const id of [INDICATOR.BLOCKED_ACTIVITIES, INDICATOR.DEPENDENCY_REVIEW, B]) {
      const ind = get(id, { ...S, activities: [] })
      expect(ind.state, id).toBe(PULSE_STATE.NEEDS_DATA)
      expect(ind.reason).toBe(NEEDS_DATA_REASON.NO_PROGRAMME)
    }
    const missing = states(); delete missing.programmeBaselineSnapshot
    expect(get(B, S, missing).state).toBe(PULSE_STATE.UNAVAILABLE)
  })

  it('a failed or loading baseline source blocks NO other indicator — the six and the two dependency indicators are untouched', () => {
    const base = run(S)
    for (const bad of ['programmeBaselines', 'programmeBaselineSnapshot']) {
      for (const flags of [settled(false, true), settled(true, false)]) {
        const perturbed = run(S, states({ [bad]: flags }))
        for (const ind of perturbed.indicators) {
          if (ind.id === B) continue
          expect(JSON.stringify(ind), `${ind.id} with ${bad}`).toBe(JSON.stringify(base.indicators.find(i => i.id === ind.id)))
        }
      }
    }
  })
})

describe('no dependencies recorded', () => {
  const NO_DEPS = { ...SCHEDULE_SOURCES, activities: [PRED, DONE, act('plain', { plannedFinish: '2026-09-30' })] }

  it('blocked and dependency review are no issue and say so — never a dependency finding invented, never "sequencing validated"', () => {
    const blocked = get(INDICATOR.BLOCKED_ACTIVITIES, NO_DEPS)
    expect(blocked.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(blocked.headline).toBe('No dependencies are recorded, so no activity is blocked by a predecessor')
    expect(blocked.explanation).toContain('No dependencies are recorded.')
    expect(blocked.explanation).toContain('cannot tell whether an activity is waiting on another')
    const review = get(INDICATOR.DEPENDENCY_REVIEW, NO_DEPS)
    expect(review.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(review.headline).toBe('No dependencies are recorded.')
    expect(review.values).toMatchObject({ links: 0, activities: 0, checked: 0 })
  })

  it('with dependencies recorded but nothing wrong, the wording changes and the links checked are counted', () => {
    const CLEAN = { ...SCHEDULE_SOURCES, activities: [DONE, act('after', { plannedStart: '2026-10-01', plannedFinish: '2026-10-10', predecessors: [fs('done')] })] }
    const blocked = get(INDICATOR.BLOCKED_ACTIVITIES, CLEAN)
    expect(blocked.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(blocked.headline).toBe('No activity that should have started is blocked by a predecessor (1 open)')
    const review = get(INDICATOR.DEPENDENCY_REVIEW, CLEAN)
    expect(review.headline).toBe('No dependency link on an open activity needs review (1 link checked)')
  })
})

// ── 5 · Acknowledgement semantics through the existing attention layer ───────

describe('acknowledgement — the existing evidence-key model carries the schedule indicators', () => {
  const ackOf = (id, keys, overrides = {}) => ({
    id, indicatorId: id, status: ACK_STATUS.ACTIVE, evidenceKeys: keys, note: 'n', reviewBy: '2026-12-01',
    acknowledgedAt: ts(1_760_000_000), acknowledgedBy: 'u', withdrawnAt: null, withdrawnBy: null, revision: 1, ...overrides,
  })
  const settledAck = { loading: false, error: false }

  it('a newly blocked activity reopens attention; a cleared one is reported and the finding resolves normally', () => {
    const list = [PRED, GONE, PROGRAMME[3]]
    const ind = get(INDICATOR.BLOCKED_ACTIVITIES, { activities: list })
    const a = attentionFor({ indicator: ind, ack: ackOf(ind.id, ['blocked1']), ackState: settledAck, now: NOW })
    expect(a.state).toBe(ATTENTION.ACKNOWLEDGED)
    const grown = get(INDICATOR.BLOCKED_ACTIVITIES, { activities: [...list, PROGRAMME[4]] })
    const g = attentionFor({ indicator: grown, ack: ackOf(ind.id, ['blocked1']), ackState: settledAck, now: NOW })
    expect(g.state).toBe(ATTENTION.NEEDS_ATTENTION)
    expect(g.reason).toBe(ATTENTION_REASON.NEW_EVIDENCE)
    expect(g.newKeys).toEqual(['blocked2'])
    // The predecessor finishes: the finding clears, the acknowledgement remains "no longer present".
    const cleared = get(INDICATOR.BLOCKED_ACTIVITIES, { activities: [{ ...PRED, status: 'completed', percentComplete: 100, actualFinish: '2026-10-05' }, PROGRAMME[3]] })
    expect(cleared.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(attentionFor({ indicator: cleared, ack: ackOf(ind.id, ['blocked1']), ackState: settledAck, now: NOW }).state).toBe(ATTENTION.NO_LONGER_PRESENT)
  })

  it('identity never changes merely because the viewer-local day advances', () => {
    for (const id of [INDICATOR.BLOCKED_ACTIVITIES, INDICATOR.DEPENDENCY_REVIEW, INDICATOR.BASELINE_SLIPPAGE]) {
      const k1 = evidenceKeysFor(get(id, SCHEDULE_SOURCES, allSettled(), NOW))
      const k2 = evidenceKeysFor(get(id, SCHEDULE_SOURCES, allSettled(), new Date(2026, 9, 16)))
      expect(k2, id).toEqual(k1)
      // Dates, names and variances are NOT in a key.
      for (const k of k1) expect(k, id).not.toMatch(/\d{4}-\d{2}-\d{2}|LATER|days/)
    }
  })

  it('a slip that grows under the same ids stays acknowledged until review-by (the DC31 limitation, stated)', () => {
    const ind = get(INDICATOR.BASELINE_SLIPPAGE, { ...SCHEDULE_SOURCES, activities: [B_OPEN_LATER] })
    const keys = evidenceKeysFor(ind)
    const worse = get(INDICATOR.BASELINE_SLIPPAGE, { ...SCHEDULE_SOURCES, activities: [{ ...B_OPEN_LATER, plannedFinish: '2026-12-20' }] })
    expect(worse.evidence[0].laterBy).toBeGreaterThan(ind.evidence[0].laterBy)
    expect(attentionFor({ indicator: worse, ack: ackOf(ind.id, keys), ackState: settledAck, now: NOW }).state).toBe(ATTENTION.ACKNOWLEDGED)
    expect(attentionFor({ indicator: worse, ack: ackOf(ind.id, keys, { reviewBy: TODAY }), ackState: settledAck, now: NOW }).reason).toBe(ATTENTION_REASON.REVIEW_DUE)
  })

  it('more than 200 affected records refuses acknowledgement, never truncates', () => {
    const many = Array.from({ length: 201 }, (_, i) => act(`b${String(i).padStart(3, '0')}`, { plannedStart: '2026-10-01', plannedFinish: '2026-10-20', predecessors: [fs('pred')] }))
    const ind = get(INDICATOR.BLOCKED_ACTIVITIES, { activities: [PRED, ...many] })
    expect(ind.evidence).toHaveLength(201)
    expect(evidenceKeysFor(ind)).toHaveLength(201)
  })
})

// ── 6 · Isolation and structure ──────────────────────────────────────────────

describe('isolation — the six ADR-47 indicators and the financial selectors are untouched', () => {
  it('the six are byte-identical with and without the schedule sources, predecessors and baseline', () => {
    const SIX = INDICATOR_ORDER.filter(id => ![INDICATOR.BLOCKED_ACTIVITIES, INDICATOR.DEPENDENCY_REVIEW, INDICATOR.BASELINE_SLIPPAGE].includes(id))
    const stripped = { activities: SCHEDULE_SOURCES.activities.map(({ predecessors, ...a }) => a) } // eslint-disable-line no-unused-vars
    const withSchedule = byId(run(SCHEDULE_SOURCES))
    const without = byId(run(stripped))
    for (const id of SIX) expect(JSON.stringify(withSchedule[id]), id).toBe(JSON.stringify(without[id]))
  })

  it('no financial selector is read by the schedule module, and no financial module imports it', () => {
    const src = stripComments(read('lib/pulseSchedule.js'))
    expect(src).not.toMatch(/margin|forecast|supplierPayments|variations|retention|cashFlow|budget|purchaseOrders|progressClaims|invoice/i)
    for (const f of ['lib/margin.js', 'lib/forecast.js', 'lib/cashFlow.js', 'lib/projectSnapshot.js', 'lib/ganttBaseline.js', 'lib/ganttDependencies.js', 'lib/projectTimeline.js']) {
      expect(read(f), f).not.toMatch(/pulseSchedule|from '\.\/pulse'/)
    }
  })
})

describe('lib/pulseSchedule.js — pure, composition only', () => {
  const src = stripComments(read('lib/pulseSchedule.js'))

  it('imports no Firebase and no React; reuses the GANTT selectors instead of re-implementing them', () => {
    expect(src).not.toMatch(/from 'firebase/)
    expect(src).not.toMatch(/from 'react/)
    expect(src).toMatch(/from '\.\/ganttDependencies'/)
    expect(src).toMatch(/from '\.\/ganttBaseline'/)
    expect(src).toMatch(/from '\.\/projectTimeline'/)
    // No date arithmetic of its own: no Date.UTC, no 86400000, no getTime subtraction.
    expect(src).not.toMatch(/Date\.UTC|86400000|getTime\(\)\s*-|setDate\(/)
    // No dependency walk of its own: states come from dependencyStates (stateFor).
    expect(src).not.toMatch(/findCycleMembers|wouldCreateCycle|earliestStartAfter/)
    expect(src).toMatch(/\bstateFor\(/)
    expect(src).toMatch(/\bvarianceFor\(/)
    expect(src).toMatch(/\bdaysBetween\(/)
  })

  it('no score, severity, threshold, trend, prediction, critical-path or delay-in-days vocabulary', () => {
    for (const word of ['score', 'severity', 'threshold', 'trend', 'predict', 'risk level', 'weight', 'priority', 'critical path', 'likelihood', 'percent']) {
      expect(src.toLowerCase(), word).not.toContain(word)
    }
    for (const f of ['lib/pulse.js', 'lib/pulseSchedule.js']) {
      expect(stripComments(read(f)).toLowerCase()).not.toMatch(/project (is )?delayed by|schedule risk|completion likelihood/)
    }
  })

  it('no money: no currency formatting, no roundMoney, no amount field', () => {
    expect(src).not.toMatch(/formatCurrency|roundMoney|safeNumber|amount|currency/i)
  })
})

// ── 7 · Scale ────────────────────────────────────────────────────────────────

describe('a 2,000-activity programme with dependencies and a baseline evaluates', () => {
  it('every schedule indicator settles with truthful counts', () => {
    const N = 2000
    const activities = Array.from({ length: N }, (_, i) => act(`x${String(i).padStart(4, '0')}`, {
      plannedStart: '2026-10-01', plannedFinish: '2026-10-20', sortOrder: i,
      status: i % 7 === 0 ? 'completed' : 'not_started', percentComplete: i % 7 === 0 ? 100 : 0,
      actualStart: i % 7 === 0 ? '2026-09-01' : undefined, actualFinish: i % 7 === 0 ? '2026-09-10' : undefined,
      predecessors: i > 0 ? [fs(`x${String(i - 1).padStart(4, '0')}`)] : [],
    }))
    const entries = activities.map(a => entryOf(a, { plannedFinish: '2026-10-15' }))
    const sources = {
      activities,
      programmeBaselines: [header('big', { activityCount: N })],
      programmeBaselineSnapshot: snapshotOf('big', entries),
    }
    const started = Date.now()
    const r = byId(run(sources))
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r[INDICATOR.BLOCKED_ACTIVITIES].state).toBe(PULSE_STATE.FINDING)
    expect(r[INDICATOR.BLOCKED_ACTIVITIES].values.blocked).toBe(activities.filter((a, i) => i > 0 && a.status === 'not_started' && activities[i - 1].status !== 'completed').length)
    expect(r[INDICATOR.DEPENDENCY_REVIEW].state).toBe(PULSE_STATE.FINDING) // every chain link conflicts (same start day)
    expect(r[INDICATOR.DEPENDENCY_REVIEW].values.links).toBe(activities.filter((a, i) => i > 0 && a.status === 'not_started').length)
    expect(r[INDICATOR.BASELINE_SLIPPAGE].state).toBe(PULSE_STATE.FINDING)
    expect(r[INDICATOR.BASELINE_SLIPPAGE].values.later).toBe(activities.filter(a => a.status === 'not_started').length)
    expect(r[INDICATOR.OVERDUE_ACTIVITIES].state).toBe(PULSE_STATE.NO_ISSUE)
  })
})
