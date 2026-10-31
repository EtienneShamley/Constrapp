import { describe, it, expect } from 'vitest'
import {
  PREDECESSOR_TYPE, MAX_PREDECESSORS, MAX_LAG_DAYS, DEPENDENCY_STATE, DEPENDENCY_STATE_LABELS,
  UNRESOLVED_STATES, isUnresolvedState, isLagValid,
  predecessorsOf, normalisePredecessorEntry, normalisePredecessors, toStoredPredecessors,
  activitiesById, successorIndex, successorsOf,
  earliestStartAfter, findCycleMembers, wouldCreateCycle,
  dependencyStates, stateFor, EMPTY_DEPENDENCY_STATE,
  predecessorCandidateError, validatePredecessorsDraft, newPredecessorIds,
  draftConflicts, conflictAcknowledgementKey, dependencyLabel, dependencyFlag, conflictDays,
} from '../../src/lib/ganttDependencies'
import { ACTIVITY_STATUS, normaliseActivityDraft, validateActivityDraft, sameActivityVersion, activityRevision } from '../../src/lib/projectTimeline'

// ── Constrapp GANTT™ dependencies (Programme 1A2, ADR-65) ────────────────────
//
// Pure: finish-to-start arithmetic on the inclusive date-only calendar,
// cycles, derived link states, blocked / conflict / review flags against an
// injected clock, editor validation and the accessible text. Nothing here
// touches Firestore or React.

const NOW = new Date(2026, 9, 15) // 2026-10-15 local

const act = (id, overrides = {}) => ({
  id,
  name: `Activity ${id}`,
  isMilestone: false,
  status: ACTIVITY_STATUS.NOT_STARTED,
  plannedStart: '2026-10-05',
  plannedFinish: '2026-10-09',
  actualStart: null,
  actualFinish: null,
  percentComplete: 0,
  sortOrder: 10,
  revision: 1,
  ...overrides,
})
const fs = (activityId, lagDays = 0) => ({ activityId, type: 'FS', lagDays })
const ids = (list) => list.map(a => a.id)

describe('vocabulary and normalisation', () => {
  it('FS only, 20 max, lag 0..365', () => {
    expect(PREDECESSOR_TYPE.FS).toBe('FS')
    expect(MAX_PREDECESSORS).toBe(20)
    expect(MAX_LAG_DAYS).toBe(365)
    expect(isLagValid(0)).toBe(true)
    expect(isLagValid(365)).toBe(true)
    expect(isLagValid(-1)).toBe(false)
    expect(isLagValid(366)).toBe(false)
    expect(isLagValid(1.5)).toBe(false)
    expect(isLagValid('3')).toBe(false)
  })

  it('a document without the key, or with a non-list, reads as no predecessors', () => {
    expect(predecessorsOf(act('a'))).toEqual([])
    expect(predecessorsOf(act('a', { predecessors: null }))).toEqual([])
    expect(predecessorsOf(act('a', { predecessors: 'x' }))).toEqual([])
    expect(predecessorsOf(undefined)).toEqual([])
    expect(predecessorsOf(act('a', { predecessors: [fs('b')] }))).toEqual([fs('b')])
  })

  it('normalises a well-formed entry and marks every malformed shape, never throwing', () => {
    expect(normalisePredecessorEntry(fs('b', 3))).toEqual({ activityId: 'b', type: 'FS', lagDays: 3, malformed: false })
    for (const raw of ['b', null, 42, [], {}, { activityId: '' }, { activityId: 'b' }, { activityId: 'b', type: 'SS', lagDays: 0 },
      { activityId: 'b', type: 'FS', lagDays: -1 }, { activityId: 'b', type: 'FS', lagDays: 400 }, { activityId: 'b', type: 'FS', lagDays: '2' },
      { activityId: 'b', type: 'FS', lagDays: 0, extra: 1 }]) {
      expect(normalisePredecessorEntry(raw).malformed, JSON.stringify(raw)).toBe(true)
    }
    // A malformed entry keeps its id for display.
    expect(normalisePredecessorEntry({ activityId: 'b', type: 'SS', lagDays: 0 }).activityId).toBe('b')
    expect(normalisePredecessors(undefined)).toEqual([])
    expect(toStoredPredecessors([{ activityId: 'b', lagDays: '4' }])).toEqual([fs('b', 4)])
  })

  it('the stored draft shape and the validator refuse the wrong shapes and accept the right ones', () => {
    const base = { name: 'x', status: 'not_started', plannedStart: '2026-10-05', plannedFinish: '2026-10-09', percentComplete: 0, sortOrder: 1 }
    expect(normaliseActivityDraft({ ...base }).predecessors).toEqual([])
    expect(normaliseActivityDraft({ ...base, predecessors: [fs('b', 2)] }).predecessors).toEqual([fs('b', 2)])
    expect(validateActivityDraft({ ...base, predecessors: [fs('b', 2)] })).toBeNull()
    expect(validateActivityDraft({ ...base, predecessors: [fs('b', -1)] })).toMatch(/Lag/)
    expect(validateActivityDraft({ ...base, predecessors: [fs('b', 366)] })).toMatch(/Lag/)
    expect(validateActivityDraft({ ...base, predecessors: [{ activityId: 'b', type: 'SS', lagDays: 0 }] })).toMatch(/finish-to-start/)
    expect(validateActivityDraft({ ...base, predecessors: [{ activityId: '', type: 'FS', lagDays: 0 }] })).toMatch(/malformed/)
    expect(validateActivityDraft({ ...base, predecessors: [fs('b'), fs('b', 1)] })).toMatch(/twice/)
    expect(validateActivityDraft({ ...base, predecessors: Array.from({ length: 21 }, (_, i) => fs(`p${i}`)) })).toMatch(/at most 20/)
    expect(validateActivityDraft({ ...base, predecessors: Array.from({ length: 20 }, (_, i) => fs(`p${i}`)) })).toBeNull()
  })
})

describe('indexes', () => {
  it('successorIndex is the reverse map, skipping malformed entries', () => {
    const list = [act('a'), act('b', { predecessors: [fs('a')] }), act('c', { predecessors: [fs('a', 2), 'junk', fs('b')] })]
    const idx = successorIndex(list)
    expect(ids(successorsOf('a', idx))).toEqual(['b', 'c'])
    expect(ids(successorsOf('b', idx))).toEqual(['c'])
    expect(successorsOf('c', idx)).toEqual([])
    expect(successorsOf('zzz', undefined)).toEqual([])
    expect(activitiesById(list).get('b').id).toBe('b')
  })
})

describe('finish-to-start arithmetic (inclusive date-only calendar)', () => {
  it('an ordinary predecessor allows the day after its finish, plus the lag', () => {
    const p = act('p', { plannedFinish: '2026-10-09' })
    expect(earliestStartAfter(p, 0)).toBe('2026-10-10')
    expect(earliestStartAfter(p, 1)).toBe('2026-10-11')
    expect(earliestStartAfter(p, 365)).toBe('2027-10-10')
  })

  it('a milestone allows the same day, plus the lag', () => {
    const m = act('m', { isMilestone: true, plannedStart: '2026-10-09', plannedFinish: '2026-10-09' })
    expect(earliestStartAfter(m, 0)).toBe('2026-10-09')
    expect(earliestStartAfter(m, 2)).toBe('2026-10-11')
  })

  it('crosses month and year ends, and is UTC-pure (no DST drift)', () => {
    expect(earliestStartAfter(act('p', { plannedFinish: '2026-10-31' }), 0)).toBe('2026-11-01')
    expect(earliestStartAfter(act('p', { plannedFinish: '2026-12-31' }), 0)).toBe('2027-01-01')
    expect(earliestStartAfter(act('p', { plannedFinish: '2027-02-28' }), 0)).toBe('2027-03-01')
    expect(earliestStartAfter(act('p', { plannedFinish: '2028-02-28' }), 0)).toBe('2028-02-29') // leap year
    // Across the southern DST change (first Sunday of October) and the northern one (late March / early November).
    expect(earliestStartAfter(act('p', { plannedFinish: '2026-10-03' }), 0)).toBe('2026-10-04')
    expect(earliestStartAfter(act('p', { plannedFinish: '2026-03-28' }), 0)).toBe('2026-03-29')
    expect(earliestStartAfter(act('p', { plannedFinish: '2026-10-31' }), 1)).toBe('2026-11-02')
  })

  it('returns null for an unusable predecessor and ignores an invalid lag', () => {
    expect(earliestStartAfter(null, 0)).toBeNull()
    expect(earliestStartAfter(act('p', { plannedFinish: '' }), 0)).toBeNull()
    expect(earliestStartAfter(act('p', { plannedFinish: '2026-10-09' }), -5)).toBe('2026-10-10')
  })
})

describe('cycles', () => {
  it('finds direct, indirect and self cycles; an acyclic graph has no members', () => {
    const acyclic = [act('a'), act('b', { predecessors: [fs('a')] }), act('c', { predecessors: [fs('a'), fs('b')] })]
    expect(findCycleMembers(acyclic).size).toBe(0)
    const direct = [act('a', { predecessors: [fs('b')] }), act('b', { predecessors: [fs('a')] }), act('c')]
    expect([...findCycleMembers(direct)].sort()).toEqual(['a', 'b'])
    const indirect = [act('a', { predecessors: [fs('c')] }), act('b', { predecessors: [fs('a')] }), act('c', { predecessors: [fs('b')] }), act('d', { predecessors: [fs('a')] })]
    expect([...findCycleMembers(indirect)].sort()).toEqual(['a', 'b', 'c'])
    const self = [act('a', { predecessors: [fs('a')] })]
    expect([...findCycleMembers(self)]).toEqual(['a'])
  })

  it('tolerates malformed and missing references and never loops', () => {
    const list = [act('a', { predecessors: ['junk', fs('ghost'), fs('b')] }), act('b', { predecessors: [{ activityId: 'a', type: 'SS', lagDays: 0 }] })]
    expect(findCycleMembers(list).size).toBe(0) // the SS entry is not an edge
    const big = Array.from({ length: 2000 }, (_, i) => act(`n${i}`, { predecessors: i > 0 ? [fs(`n${i - 1}`)] : [] }))
    big[0].predecessors = [fs('n1999')] // one long ring
    expect(findCycleMembers(big).size).toBe(2000)
    expect(findCycleMembers([]).size).toBe(0)
    expect(findCycleMembers(undefined).size).toBe(0)
  })

  it('wouldCreateCycle refuses self, direct and indirect closure, accepts a safe link, and ignores bad data', () => {
    const list = [act('a'), act('b', { predecessors: [fs('a')] }), act('c', { predecessors: [fs('b')] })]
    expect(wouldCreateCycle(list, 'a', 'a')).toBe(true)
    expect(wouldCreateCycle(list, 'a', 'b')).toBe(true)   // b ← a already; a ← b closes it
    expect(wouldCreateCycle(list, 'a', 'c')).toBe(true)   // c ← b ← a
    expect(wouldCreateCycle(list, 'c', 'a')).toBe(false)
    expect(wouldCreateCycle(activitiesById(list), 'b', 'c')).toBe(true)
    expect(wouldCreateCycle(list, 'a', 'ghost')).toBe(false)
    expect(wouldCreateCycle(list, '', 'a')).toBe(false)
  })
})

describe('derived states', () => {
  // The programme: p finishes 9 Oct (open); m is a milestone on 12 Oct (reached);
  // done finished; x cancelled.
  const P = act('p', { plannedStart: '2026-10-01', plannedFinish: '2026-10-09', status: ACTIVITY_STATUS.IN_PROGRESS, actualStart: '2026-10-01', percentComplete: 50 })
  const M = act('m', { isMilestone: true, plannedStart: '2026-10-12', plannedFinish: '2026-10-12', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualFinish: '2026-10-12' })
  const DONE = act('done', { plannedStart: '2026-09-01', plannedFinish: '2026-09-05', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualStart: '2026-09-01', actualFinish: '2026-09-05' })
  const X = act('x', { status: ACTIVITY_STATUS.CANCELLED, cancelReason: 'Descoped' })

  it('classifies valid, conflict, missing, cancelled, cycle and malformed links with precedence', () => {
    const list = [P, M, DONE, X,
      act('s1', { plannedStart: '2026-10-20', predecessors: [fs('p'), fs('m', 1), fs('done')] }),             // all valid
      act('s2', { plannedStart: '2026-10-05', predecessors: [fs('p')] }),                                    // conflict: earliest 10 Oct
      act('s3', { plannedStart: '2026-10-20', predecessors: [fs('ghost'), fs('x'), 'junk'] }),               // missing, cancelled, malformed
      act('c1', { plannedStart: '2026-10-20', predecessors: [fs('c2')] }),
      act('c2', { plannedStart: '2026-10-20', predecessors: [fs('c1')] }),                                    // cycle
    ]
    const st = dependencyStates(list, NOW)
    expect(st.get('s1').entries.map(e => e.state)).toEqual(['valid', 'valid', 'valid'])
    expect(st.get('s1').entries.map(e => e.finished)).toEqual([false, true, true])
    expect(st.get('s1').earliestStart).toBe('2026-10-13') // milestone 12 Oct + 1 lag
    expect(st.get('s1')).toMatchObject({ hasConflict: false, needsReview: false, inCycle: false, isBlocked: false, count: 3 })
    expect(st.get('s2').entries[0]).toMatchObject({ state: DEPENDENCY_STATE.CONFLICT, earliestStart: '2026-10-10', name: 'Activity p' })
    expect(st.get('s2').hasConflict).toBe(true)
    expect(st.get('s3').entries.map(e => e.state)).toEqual([DEPENDENCY_STATE.MISSING, DEPENDENCY_STATE.CANCELLED, DEPENDENCY_STATE.MALFORMED])
    expect(st.get('s3')).toMatchObject({ needsReview: true, unresolvedCount: 3, hasConflict: false })
    expect(st.get('c1').entries[0].state).toBe(DEPENDENCY_STATE.CYCLE)
    expect(st.get('c1').inCycle).toBe(true)
    expect(st.get('c2').inCycle).toBe(true)
    for (const e of st.get('s3').entries) expect(e.finished).toBe(false) // unresolved never counts as finished
    expect(st.get('p').count).toBe(0)
    expect(stateFor(st, 'nope')).toBe(EMPTY_DEPENDENCY_STATE)
    for (const s of UNRESOLVED_STATES) expect(isUnresolvedState(s)).toBe(true)
    expect(isUnresolvedState(DEPENDENCY_STATE.CONFLICT)).toBe(false)
    for (const s of Object.values(DEPENDENCY_STATE)) expect(DEPENDENCY_STATE_LABELS[s]).toBeTruthy()
  })

  it('blocked is TIME-TRIGGERED: only when the successor should have started and has not', () => {
    const list = [P, DONE, X,
      act('future', { plannedStart: '2026-11-01', plannedFinish: '2026-11-05', predecessors: [fs('p')] }),     // start not arrived → not blocked
      act('due',    { plannedStart: '2026-10-15', plannedFinish: '2026-10-20', predecessors: [fs('p')] }),     // start today, p open → blocked
      act('past',   { plannedStart: '2026-10-10', plannedFinish: '2026-10-20', predecessors: [fs('done')] }),  // predecessor finished → not blocked
      act('rev',    { plannedStart: '2026-10-10', plannedFinish: '2026-10-20', predecessors: [fs('x')] }),     // cancelled link → blocked (requires review)
      act('miss',   { plannedStart: '2026-10-10', plannedFinish: '2026-10-20', predecessors: [fs('ghost')] }), // missing → blocked
      act('started', { plannedStart: '2026-10-10', plannedFinish: '2026-10-20', status: ACTIVITY_STATUS.IN_PROGRESS, actualStart: '2026-10-10', percentComplete: 10, predecessors: [fs('p')] }), // already started → never blocked
      act('held',   { plannedStart: '2026-10-10', plannedFinish: '2026-10-20', status: ACTIVITY_STATUS.ON_HOLD, actualStart: '2026-10-10', percentComplete: 10, predecessors: [fs('p')] }),
    ]
    const st = dependencyStates(list, NOW)
    expect(st.get('future').isBlocked).toBe(false)
    expect(st.get('due')).toMatchObject({ isBlocked: true, blockedBy: ['p'], unfinishedCount: 1 })
    expect(st.get('past').isBlocked).toBe(false)
    expect(st.get('rev')).toMatchObject({ isBlocked: true, blockedBy: ['x'], needsReview: true })
    expect(st.get('miss')).toMatchObject({ isBlocked: true, blockedBy: ['ghost'] })
    expect(st.get('started').isBlocked).toBe(false)
    expect(st.get('held').isBlocked).toBe(false)
  })

  it('a cancelled predecessor never satisfies the dependency (Lead Architect correction)', () => {
    const cancelledDone = act('xd', { status: ACTIVITY_STATUS.CANCELLED, plannedFinish: '2026-09-01' })
    const list = [cancelledDone, act('s', { plannedStart: '2026-10-10', plannedFinish: '2026-10-20', predecessors: [fs('xd')] })]
    const s = dependencyStates(list, NOW).get('s')
    expect(s.entries[0].state).toBe(DEPENDENCY_STATE.CANCELLED)
    expect(s.entries[0].finished).toBe(false)
    expect(s.isBlocked).toBe(true)
    expect(s.earliestStart).toBeNull() // a cancelled link contributes no earliest start
    expect(dependencyFlag(s)).toBe('Blocked')
  })

  it('flips at local midnight exactly as overdue does, and never blocks a completed or cancelled successor', () => {
    const list = [P, act('s', { plannedStart: '2026-10-16', plannedFinish: '2026-10-20', predecessors: [fs('p')] })]
    expect(dependencyStates(list, new Date(2026, 9, 15, 23, 59, 59)).get('s').isBlocked).toBe(false)
    expect(dependencyStates(list, new Date(2026, 9, 16, 0, 0, 1)).get('s').isBlocked).toBe(true)
    const done = [P, act('s', { plannedStart: '2026-10-01', plannedFinish: '2026-10-02', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualFinish: '2026-10-02', predecessors: [fs('p')] })]
    expect(dependencyStates(done, NOW).get('s').isBlocked).toBe(false)
  })

  it('a cycle member derives no false readiness: the cyclic link is unresolved and blocks when due', () => {
    const list = [act('a', { plannedStart: '2026-10-10', predecessors: [fs('b')] }), act('b', { plannedStart: '2026-10-10', predecessors: [fs('a')] })]
    const st = dependencyStates(list, NOW)
    expect(st.get('a')).toMatchObject({ inCycle: true, needsReview: true, isBlocked: true })
    expect(st.get('a').entries[0].finished).toBe(false)
  })

  it('never mutates its input and tolerates junk', () => {
    const list = [act('a', { predecessors: [null, 5, fs('zzz')] }), { id: null }, undefined]
    const frozen = JSON.stringify(list)
    expect(() => dependencyStates(list, NOW)).not.toThrow()
    expect(JSON.stringify(list)).toBe(frozen)
    expect(dependencyStates(undefined, NOW).size).toBe(0)
  })
})

describe('editor validation', () => {
  const list = [
    act('a'), act('b', { predecessors: [fs('a')] }), act('c', { predecessors: [fs('b')] }),
    act('x', { status: ACTIVITY_STATUS.CANCELLED }),
  ]

  it('candidate errors: self, duplicate, missing, cancelled, cycle — and null when allowed', () => {
    expect(predecessorCandidateError(list, 'a', 'a')).toMatch(/itself/)
    expect(predecessorCandidateError(list, 'c', 'b', [fs('b')])).toMatch(/Already/)
    expect(predecessorCandidateError(list, 'c', 'ghost')).toMatch(/not in this project/)
    expect(predecessorCandidateError(list, 'c', 'x')).toMatch(/cancelled/)
    expect(predecessorCandidateError(list, 'a', 'c')).toMatch(/cycle/)
    expect(predecessorCandidateError(list, 'c', 'a')).toBeNull()
    expect(predecessorCandidateError(list, '__new__', 'a')).toBeNull()
    expect(predecessorCandidateError(list, 'c', '')).toMatch(/Choose/)
  })

  it('the draft list: refuses malformed, self, duplicate, bad lag, new-missing, new-cancelled, new-cycle; tolerates RETAINED missing/cancelled links', () => {
    const ok = (entries, extra = {}) => validatePredecessorsDraft(entries, { activities: list, successorId: 'c', ...extra })
    expect(ok([fs('a')])).toBeNull()
    expect(ok([fs('a'), fs('b', 3)])).toBeNull()
    expect(ok(['junk'])).toMatch(/malformed/)
    expect(ok([fs('c')])).toMatch(/itself/)
    expect(ok([fs('a'), fs('a')])).toMatch(/twice/)
    expect(ok([fs('a', 400)])).toMatch(/Lag/)
    expect(ok([fs('ghost')])).toMatch(/not in this project/)
    expect(ok([fs('x')])).toMatch(/cancelled/)
    expect(validatePredecessorsDraft([fs('c')], { activities: list, successorId: 'a' })).toMatch(/cycle/)
    // Retained links that no longer resolve are tolerated so an unrelated edit can save.
    expect(ok([fs('ghost')], { previousIds: ['ghost'] })).toBeNull()
    expect(ok([fs('x')], { previousIds: ['x'] })).toBeNull()
    expect(ok(Array.from({ length: 21 }, (_, i) => fs(`p${i}`)))).toMatch(/at most 20/)
    expect(newPredecessorIds([fs('a'), fs('b'), 'junk'], ['a'])).toEqual(['b'])
  })

  it('draft conflicts and the acknowledgement key', () => {
    const draft = { plannedStart: '2026-10-05', predecessors: [fs('a'), fs('x'), fs('ghost')] } // a finishes 9 Oct → earliest 10 Oct
    const conflicts = draftConflicts(draft, list)
    expect(conflicts).toEqual([{ activityId: 'a', name: 'Activity a', earliestStart: '2026-10-10', lagDays: 0 }])
    expect(draftConflicts({ plannedStart: '2026-10-10', predecessors: [fs('a')] }, list)).toEqual([])
    expect(draftConflicts({ plannedStart: '', predecessors: [fs('a')] }, list)).toEqual([])
    const k1 = conflictAcknowledgementKey(draft)
    expect(conflictAcknowledgementKey({ ...draft, plannedStart: '2026-10-06' })).not.toBe(k1)
    expect(conflictAcknowledgementKey({ ...draft, predecessors: [fs('a', 1), fs('x'), fs('ghost')] })).not.toBe(k1)
    expect(conflictAcknowledgementKey({ plannedStart: '2026-10-05', predecessors: [fs('ghost'), fs('x'), fs('a')] })).toBe(k1) // order-insensitive
  })
})

describe('accessible text', () => {
  const list = [
    act('p', { plannedFinish: '2026-10-09', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualFinish: '2026-10-09' }),
    act('q', { plannedFinish: '2026-10-09' }),
    // Starts 10 Oct: after p's earliest (10 Oct), before q's (12 Oct, lag 2).
    act('s', { plannedStart: '2026-10-10', plannedFinish: '2026-10-20', predecessors: [fs('p'), fs('q', 2), fs('ghost')] }),
  ]
  const st = dependencyStates(list, NOW)

  it('names every link, its lag, finished state and problem, then the activity-level flag', () => {
    const label = dependencyLabel(st.get('s'))
    expect(label).toContain('Depends on Activity p (finish to start, finished)')
    expect(label).toContain('Activity q (finish to start plus 2 days, earliest start 12/10/2026 — conflict)')
    expect(label).toContain('ghost (missing predecessor — requires review)')
    expect(label).toContain('Blocked: a predecessor is not finished or needs review.')
    expect(dependencyLabel(st.get('p'))).toBe('')
    expect(dependencyLabel(undefined)).toBe('')
    expect(dependencyFlag(st.get('s'))).toBe('Blocked')
    expect(dependencyFlag(st.get('p'))).toBe('')
    expect(conflictDays(list[2], st.get('s'))).toBe(2) // 10 Oct → earliest 12 Oct
  })

  it('a future conflict reads as a conflict, a review-only link as review', () => {
    const future = [act('q', { plannedFinish: '2026-12-09' }), act('s', { plannedStart: '2026-12-05', plannedFinish: '2026-12-20', predecessors: [fs('q')] })]
    const fs1 = dependencyStates(future, NOW).get('s')
    expect(dependencyFlag(fs1)).toBe('Conflict')
    expect(dependencyLabel(fs1)).toContain('Starts before a predecessor allows.')
    const review = [act('s', { plannedStart: '2026-12-05', plannedFinish: '2026-12-20', predecessors: [fs('ghost')] })]
    const rs = dependencyStates(review, NOW).get('s')
    expect(dependencyFlag(rs)).toBe('Review')
    expect(dependencyLabel(rs)).toContain('A dependency requires review.')
  })
})

describe('version helpers (ADR-65)', () => {
  const ts = (s) => ({ seconds: s, nanoseconds: 0, isEqual(o) { return o.seconds === s && o.nanoseconds === 0 } })

  it('activityRevision reads a legacy document as 1', () => {
    expect(activityRevision({})).toBe(1)
    expect(activityRevision({ revision: 3 })).toBe(3)
    expect(activityRevision({ revision: '3' })).toBe(1)
  })

  it('sameActivityVersion needs the revision AND the stamps to match', () => {
    const a = { revision: 2, updatedAt: ts(1), updatedBy: 'u' }
    expect(sameActivityVersion(a, { revision: 2, updatedAt: ts(1), updatedBy: 'u' })).toBe(true)
    expect(sameActivityVersion(a, { revision: 3, updatedAt: ts(1), updatedBy: 'u' })).toBe(false)
    expect(sameActivityVersion(a, { revision: 2, updatedAt: ts(2), updatedBy: 'u' })).toBe(false) // a legacy-session write: revision kept, stamp moved
    expect(sameActivityVersion(a, { revision: 2, updatedAt: ts(1), updatedBy: 'v' })).toBe(false)
    expect(sameActivityVersion({ updatedAt: ts(1), updatedBy: 'u' }, { revision: 1, updatedAt: ts(1), updatedBy: 'u' })).toBe(true) // legacy reads as 1
    expect(sameActivityVersion(null, a)).toBe(false)
  })
})
