import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ATTENTION_FLAG, ATTENTION_FLAG_ORDER, ATTENTION_FLAG_LABELS, ATTENTION_FLAG_HINTS, ATTENTION_FILTER,
  isAttentionFilter, attentionFilterLabel,
  buildProgrammeAttention, attentionFor, attentionCount, matchesAttention, filterByAttention, attentionOutsideScope,
} from '../../src/lib/programmeAttention'
import { sortActivities, filterActivities, isOverdue } from '../../src/lib/projectTimeline'
import { dependencyStates, DEPENDENCY_STATE } from '../../src/lib/ganttDependencies'
import { baselineComparison } from '../../src/lib/ganttBaseline'
import { blockedActivityRows, dependencyReviewRows, baselineSlippageRows } from '../../src/lib/pulseSchedule'
import { evaluatePulse, INDICATOR, PULSE_SOURCES } from '../../src/lib/pulse'

// ── GANTT core completion G1 — the schedule attention filter (ADR-79) ────────
//
// lib/programmeAttention.js indexes which activities need attention and why.
// It must DEFINE nothing: every flag is a selector Constrap PULSE™ already
// reports from. These tests pin
//
//   1. each flag, the combined flags and the counts;
//   2. cancelled and completed work;
//   3. the baseline flag with and without a usable selected baseline;
//   4. the WHOLE-programme rule: a predecessor a filter hides still blocks;
//   5. equality with the PULSE schedule indicators on the same records;
//   6. the page wiring (source contracts — the unit runner has no DOM).

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ── Fixture: 20 November 2026, local ─────────────────────────────────────────

const NOW = new Date(2026, 10, 20, 12)

const act = (id, overrides = {}) => ({
  id, name: id, status: 'not_started', isMilestone: false,
  plannedStart: '2026-12-01', plannedFinish: '2026-12-10', percentComplete: 0, sortOrder: 10, revision: 1,
  ...overrides,
})
const fs = (activityId, lagDays = 0) => ({ activityId, type: 'FS', lagDays })
const entryOf = (a, overrides = {}) => ({
  activityId: a.id, name: a.name, isMilestone: a.isMilestone === true,
  plannedStart: a.plannedStart, plannedFinish: a.plannedFinish, status: a.status,
  percentComplete: a.percentComplete ?? 0, revision: 1, sortOrder: a.sortOrder ?? 0, costCodeId: null,
  ...overrides,
})
const ts = (seconds) => ({ seconds, nanoseconds: 0, toMillis: () => seconds * 1000, toDate: () => new Date(seconds * 1000) })
const snapshotOf = (id, entries) => ({ id, activityCount: entries.length, capturedAt: ts(1), capturedBy: 'u', activities: entries })

// excavation  in progress, finish passed                → overdue; later than baseline (+2)
// footings    not started, start arrived, waits on excavation, finish passed → blocked + overdue
// slab        not started, starts before footings allow, start arrived       → conflict + blocked
// frame       future, predecessor id names nothing      → review
// roof        future, predecessor cancelled             → review
// oldScope    cancelled, dates long past                → nothing
// survey      completed late against plan and baseline  → nothing (history)
// fitout      in progress, unchanged from baseline      → nothing
// handover    open milestone, 5 days later than baseline → later than baseline
const EXCAVATION = act('excavation', { sortOrder: 10, status: 'in_progress', plannedStart: '2026-11-01', plannedFinish: '2026-11-10', actualStart: '2026-11-01', percentComplete: 60 })
const FOOTINGS   = act('footings',   { sortOrder: 20, plannedStart: '2026-11-11', plannedFinish: '2026-11-18', predecessors: [fs('excavation')] })
const SLAB       = act('slab',       { sortOrder: 30, plannedStart: '2026-11-15', plannedFinish: '2026-11-30', predecessors: [fs('footings')] })
const FRAME      = act('frame',      { sortOrder: 40, plannedStart: '2026-12-01', plannedFinish: '2026-12-20', predecessors: [fs('ghost')] })
const ROOF       = act('roof',       { sortOrder: 50, plannedStart: '2026-12-21', plannedFinish: '2026-12-31', predecessors: [fs('oldScope')] })
const OLD_SCOPE  = act('oldScope',   { sortOrder: 60, status: 'cancelled', plannedStart: '2026-10-01', plannedFinish: '2026-10-05' })
const SURVEY     = act('survey',     { sortOrder: 70, status: 'completed', plannedStart: '2026-10-01', plannedFinish: '2026-10-05', actualStart: '2026-10-01', actualFinish: '2026-10-09', percentComplete: 100 })
const FITOUT     = act('fitout',     { sortOrder: 80, status: 'in_progress', plannedStart: '2026-11-19', plannedFinish: '2026-12-10', actualStart: '2026-11-19', percentComplete: 5 })
const HANDOVER   = act('handover',   { sortOrder: 90, isMilestone: true, plannedStart: '2027-01-15', plannedFinish: '2027-01-15' })

const PROGRAMME = sortActivities([EXCAVATION, FOOTINGS, SLAB, FRAME, ROOF, OLD_SCOPE, SURVEY, FITOUT, HANDOVER])

const HEADER = { id: 'b1', name: 'Contract programme', status: 'approved', approvedAt: ts(1_791_536_000), activityCount: 7 }
// slab was added after the baseline; survey's baseline finish is 5 Oct.
const SNAPSHOT = snapshotOf('b1', [
  entryOf(EXCAVATION, { plannedFinish: '2026-11-08' }),
  entryOf(FOOTINGS), entryOf(FRAME), entryOf(ROOF), entryOf(OLD_SCOPE), entryOf(SURVEY), entryOf(FITOUT),
  entryOf(HANDOVER, { plannedStart: '2027-01-10', plannedFinish: '2027-01-10' }),
])

const DEP = dependencyStates(PROGRAMME, NOW)
const COMPARISON = baselineComparison(PROGRAMME, SNAPSHOT)
const WITH_BASELINE = { usable: true, header: HEADER, comparison: COMPARISON }

const build = (baseline = WITH_BASELINE, activities = PROGRAMME, depStates = DEP) =>
  buildProgrammeAttention({ activities, depStates, now: NOW, baseline })
const flagsOf = (attention, id) => attentionFor(attention, id).flags

// ── 1. Each flag, combined flags, counts ─────────────────────────────────────

describe('each flag is the existing selector\'s answer', () => {
  const attention = build()

  it('overdue: open and planned finish before today', () => {
    expect(flagsOf(attention, 'excavation')).toContain(ATTENTION_FLAG.OVERDUE)
    expect(attentionFor(attention, 'excavation').daysLate).toBe(10)
    expect(attentionFor(attention, 'fitout').overdue).toBe(false)
  })

  it('blocked: not started, start arrived, a predecessor unfinished', () => {
    expect(attentionFor(attention, 'footings').blocked).toBe(true)
    // A future start is never blocked merely because its predecessor is open.
    expect(attentionFor(attention, 'frame').blocked).toBe(false)
  })

  it('conflict: planned to start before a predecessor allows', () => {
    expect(DEP.get('slab').entries[0].state).toBe(DEPENDENCY_STATE.CONFLICT)
    expect(attentionFor(attention, 'slab').conflict).toBe(true)
    expect(attentionFor(attention, 'slab').review).toBe(false)
  })

  it('requires review: a missing or cancelled predecessor — never reported as a conflict', () => {
    expect(DEP.get('frame').entries[0].state).toBe(DEPENDENCY_STATE.MISSING)
    expect(DEP.get('roof').entries[0].state).toBe(DEPENDENCY_STATE.CANCELLED)
    for (const id of ['frame', 'roof']) {
      expect(flagsOf(attention, id)).toEqual([ATTENTION_FLAG.REVIEW])
    }
  })

  it('later than the selected approved baseline: open, in the baseline, planned finish later', () => {
    expect(attentionFor(attention, 'excavation')).toMatchObject({ laterThanBaseline: true, laterBy: 2 })
    expect(attentionFor(attention, 'handover')).toMatchObject({ laterThanBaseline: true, laterBy: 5 })
    // Unchanged from baseline, and added after it: neither is "later".
    expect(attentionFor(attention, 'fitout').laterThanBaseline).toBe(false)
    expect(attentionFor(attention, 'slab').laterThanBaseline).toBe(false)
  })

  it('combined flags: one activity carries several, in a fixed order, and is counted once', () => {
    expect(flagsOf(attention, 'excavation')).toEqual([ATTENTION_FLAG.OVERDUE, ATTENTION_FLAG.LATER_THAN_BASELINE])
    expect(flagsOf(attention, 'footings')).toEqual([ATTENTION_FLAG.OVERDUE, ATTENTION_FLAG.BLOCKED])
    expect(flagsOf(attention, 'slab')).toEqual([ATTENTION_FLAG.BLOCKED, ATTENTION_FLAG.CONFLICT])
    expect(attention.counts).toEqual({
      any: 6, overdue: 2, blocked: 2, conflict: 1, review: 2, laterThanBaseline: 2,
      conflictLinks: 1, reviewLinks: 2, total: 9,
    })
    // 9 flags over 6 activities — `any` is unique activities, not the sum.
    const sum = ATTENTION_FLAG_ORDER.reduce((n, f) => n + attentionCount(attention, f), 0)
    expect(sum).toBe(9)
    expect(attentionCount(attention, ATTENTION_FILTER.ANY)).toBe(6)
  })

  it('an unflagged or unknown activity reads as no flags, without throwing', () => {
    expect(attentionFor(attention, 'fitout')).toMatchObject({ flags: [], overdue: false, daysLate: null, laterBy: null })
    expect(attentionFor(attention, 'nope').flags).toEqual([])
    expect(attentionFor(null, 'x').flags).toEqual([])
    expect(attention.byId.has('fitout')).toBe(false)
  })

  it('every flag has a label and a definition sentence', () => {
    for (const f of ATTENTION_FLAG_ORDER) {
      expect(ATTENTION_FLAG_LABELS[f]).toBeTruthy()
      expect(ATTENTION_FLAG_HINTS[f]).toBeTruthy()
    }
    expect(attentionFilterLabel(ATTENTION_FILTER.ANY)).toBe('Any attention flag')
    expect(attentionFilterLabel(ATTENTION_FLAG.BLOCKED)).toBe('Blocked')
  })
})

// ── 2. Cancelled and completed work ──────────────────────────────────────────

describe('cancelled and completed activities never need attention', () => {
  const attention = build()

  it('a cancelled activity with long-past dates carries no flag', () => {
    expect(isOverdue(OLD_SCOPE, NOW)).toBe(false)
    expect(flagsOf(attention, 'oldScope')).toEqual([])
  })

  it('work completed after its baseline finish is history, not a flag', () => {
    expect(COMPARISON.get('survey').completedLate).toBe(true)
    expect(flagsOf(attention, 'survey')).toEqual([])
  })

  it('cancelling a flagged activity removes every one of its flags', () => {
    const cancelled = PROGRAMME.map(a => (a.id === 'slab' ? { ...a, status: 'cancelled' } : a))
    const again = build(
      { usable: true, header: HEADER, comparison: baselineComparison(cancelled, SNAPSHOT) },
      cancelled, dependencyStates(cancelled, NOW),
    )
    expect(flagsOf(again, 'slab')).toEqual([])
    expect(again.counts.conflict).toBe(0)
    expect(again.counts.blocked).toBe(1)
  })

  it('a dependency problem on a CLOSED successor is history and is not counted', () => {
    const done = PROGRAMME.map(a => (a.id === 'frame'
      ? { ...a, status: 'completed', actualStart: '2026-11-01', actualFinish: '2026-11-02', percentComplete: 100 } : a))
    const again = build({ usable: false }, done, dependencyStates(done, NOW))
    expect(flagsOf(again, 'frame')).toEqual([])
    expect(again.counts.review).toBe(1)
  })
})

// ── 3. With and without a baseline ───────────────────────────────────────────

describe('no usable selected baseline: the flag is NOT EVALUATED, never zero', () => {
  for (const [name, baseline] of [
    ['no baseline argument', null],
    ['no approved baseline', { usable: false, header: null, comparison: null }],
    ['a header whose snapshot is unusable', { usable: false, header: HEADER, comparison: COMPARISON }],
    ['usable flag without a comparison', { usable: true, header: HEADER, comparison: null }],
  ]) {
    it(name, () => {
      const attention = build(baseline)
      expect(attention.baselineEvaluated).toBe(false)
      expect(attention.counts.laterThanBaseline).toBeNull()
      expect(attentionCount(attention, ATTENTION_FLAG.LATER_THAN_BASELINE)).toBeNull()
      expect(attentionFor(attention, 'handover').laterThanBaseline).toBe(false)
      // The milestone had ONLY that flag, so it leaves the "any" set …
      expect(attention.counts.any).toBe(5)
      // … and the other four flags are exactly as before.
      expect(attention.counts).toMatchObject({ overdue: 2, blocked: 2, conflict: 1, review: 2 })
      expect(filterByAttention(PROGRAMME, attention, ATTENTION_FLAG.LATER_THAN_BASELINE)).toEqual([])
    })
  }

  it('the flag follows the SELECTED version: an older baseline gives a different answer', () => {
    const older = snapshotOf('b0', [entryOf(EXCAVATION), entryOf(HANDOVER)])
    const attention = build({ usable: true, header: { ...HEADER, id: 'b0' }, comparison: baselineComparison(PROGRAMME, older) })
    expect(attention.counts.laterThanBaseline).toBe(0)
    expect(attention.baselineEvaluated).toBe(true)
  })
})

// ── 4. Filtering, and the whole-programme rule ───────────────────────────────

describe('filtering narrows the displayed list; evaluation always uses the whole programme', () => {
  const attention = build()
  const ids = (list) => list.map(a => a.id)

  it('each filter value returns exactly its activities, in programme order', () => {
    expect(ids(filterByAttention(PROGRAMME, attention, ATTENTION_FILTER.ANY))).toEqual(['excavation', 'footings', 'slab', 'frame', 'roof', 'handover'])
    expect(ids(filterByAttention(PROGRAMME, attention, ATTENTION_FLAG.OVERDUE))).toEqual(['excavation', 'footings'])
    expect(ids(filterByAttention(PROGRAMME, attention, ATTENTION_FLAG.BLOCKED))).toEqual(['footings', 'slab'])
    expect(ids(filterByAttention(PROGRAMME, attention, ATTENTION_FLAG.CONFLICT))).toEqual(['slab'])
    expect(ids(filterByAttention(PROGRAMME, attention, ATTENTION_FLAG.REVIEW))).toEqual(['frame', 'roof'])
    expect(ids(filterByAttention(PROGRAMME, attention, ATTENTION_FLAG.LATER_THAN_BASELINE))).toEqual(['excavation', 'handover'])
  })

  it('off returns the list untouched; the size of each filtered list is its count', () => {
    expect(filterByAttention(PROGRAMME, attention, ATTENTION_FILTER.OFF)).toBe(PROGRAMME)
    for (const f of [ATTENTION_FILTER.ANY, ...ATTENTION_FLAG_ORDER]) {
      expect(filterByAttention(PROGRAMME, attention, f)).toHaveLength(attentionCount(attention, f))
    }
    expect(matchesAttention(attention, 'fitout', ATTENTION_FILTER.OFF)).toBe(true)
    expect(matchesAttention(attention, 'fitout', ATTENTION_FILTER.ANY)).toBe(false)
  })

  it('only the six known values are filters', () => {
    for (const v of ['', 'any', ...ATTENTION_FLAG_ORDER]) expect(isAttentionFilter(v)).toBe(true)
    for (const v of ['critical', 'late', null, undefined, 0]) expect(isAttentionFilter(v)).toBe(false)
  })

  it('a predecessor hidden by another filter STILL blocks its successor', () => {
    // The search shows only the slab; footings (its unfinished predecessor)
    // is not in the displayed list.
    const shown = filterActivities(PROGRAMME, { search: 'slab' }, NOW)
    expect(ids(shown)).toEqual(['slab'])
    expect(ids(filterByAttention(shown, attention, ATTENTION_FLAG.BLOCKED))).toEqual(['slab'])
    expect(ids(filterByAttention(shown, attention, ATTENTION_FLAG.CONFLICT))).toEqual(['slab'])
    // The counts did not move because a search was typed.
    expect(attention.counts.blocked).toBe(2)
  })

  it('the trap this avoids: states built from the FILTERED list would lose the block', () => {
    const shown = filterActivities(PROGRAMME, { search: 'slab' }, NOW)
    const wrong = buildProgrammeAttention({ activities: shown, depStates: dependencyStates(shown, NOW), now: NOW, baseline: WITH_BASELINE })
    // Footings would read as a MISSING predecessor: a different flag entirely.
    expect(attentionFor(wrong, 'slab')).toMatchObject({ conflict: false, review: true })
    expect(attentionFor(attention, 'slab')).toMatchObject({ conflict: true, review: false, blocked: true })
  })

  it('hiding completed work does not un-block: a hidden COMPLETED predecessor still satisfies, a hidden open one still blocks', () => {
    const shown = filterActivities(PROGRAMME, { hideClosed: true, status: 'not_started' }, NOW)
    expect(ids(shown)).not.toContain('excavation')
    expect(ids(filterByAttention(shown, attention, ATTENTION_FLAG.BLOCKED))).toEqual(['footings', 'slab'])
  })

  it('flagged activities a filter leaves out are counted, so a filtered view can say so', () => {
    expect(attentionOutsideScope(attention, PROGRAMME)).toBe(0)
    expect(attentionOutsideScope(attention, [SLAB])).toBe(5)
    expect(attentionOutsideScope(attention, [])).toBe(6)
    expect(attentionOutsideScope(null, [SLAB])).toBe(0)
  })

  it('the blocked state flips with the injected day, exactly as the GANTT selector does', () => {
    const earlier = new Date(2026, 10, 10, 12) // footings starts tomorrow
    const attentionEarlier = buildProgrammeAttention({ activities: PROGRAMME, depStates: dependencyStates(PROGRAMME, earlier), now: earlier, baseline: null })
    expect(attentionFor(attentionEarlier, 'footings').blocked).toBe(false)
    expect(attentionFor(attentionEarlier, 'excavation').overdue).toBe(false)
  })

  it('malformed records are tolerated: no id, null list, no states', () => {
    expect(() => buildProgrammeAttention()).not.toThrow()
    const odd = buildProgrammeAttention({ activities: [null, {}, { name: 'no id' }, EXCAVATION], depStates: null, now: NOW })
    expect(odd.counts).toMatchObject({ total: 1, overdue: 1, blocked: 0, laterThanBaseline: null })
    expect(filterByAttention(null, odd, ATTENTION_FILTER.ANY)).toEqual([])
  })
})

// ── 5. Consistency with the PULSE schedule indicators ────────────────────────

describe('the counts ARE the PULSE schedule indicators\' counts', () => {
  const attention = build()
  const sourceStates = Object.fromEntries(PULSE_SOURCES.map(s => [s, { loading: false, error: false }]))
  const pulse = evaluatePulse({
    sources: { activities: PROGRAMME, programmeBaselines: [{ ...HEADER, activityCount: SNAPSHOT.activityCount }], programmeBaselineSnapshot: SNAPSHOT },
    sourceStates, now: NOW, currencyCode: 'AUD',
  })
  const indicator = (id) => pulse.indicators.find(i => i.id === id)

  it('overdue = PULSE "Programme activities overdue"', () => {
    expect(indicator(INDICATOR.OVERDUE_ACTIVITIES).values.overdue).toBe(attention.counts.overdue)
  })

  it('blocked = PULSE "Blocked activities"', () => {
    expect(indicator(INDICATOR.BLOCKED_ACTIVITIES).values.blocked).toBe(attention.counts.blocked)
    expect(blockedActivityRows(PROGRAMME, DEP, NOW).map(r => r.id).sort())
      .toEqual(PROGRAMME.filter(a => attentionFor(attention, a.id).blocked).map(a => a.id).sort())
  })

  it('conflict + requires review = PULSE "Dependencies needing review", links and activities apart', () => {
    const v = indicator(INDICATOR.DEPENDENCY_REVIEW).values
    expect(v.links).toBe(attention.counts.conflictLinks + attention.counts.reviewLinks)
    expect(v.conflict).toBe(attention.counts.conflictLinks)
    expect(v.missing + v.cancelled + v.malformed + v.cycle).toBe(attention.counts.reviewLinks)
    const flagged = PROGRAMME.filter(a => { const f = attentionFor(attention, a.id); return f.conflict || f.review })
    expect(v.activities).toBe(flagged.length)
    expect(new Set(dependencyReviewRows(PROGRAMME, DEP).map(r => r.activityId))).toEqual(new Set(flagged.map(a => a.id)))
  })

  it('later than baseline = PULSE "Later than the approved baseline" for the active version', () => {
    expect(indicator(INDICATOR.BASELINE_SLIPPAGE).values.later).toBe(attention.counts.laterThanBaseline)
    expect(baselineSlippageRows(PROGRAMME, COMPARISON, HEADER).map(r => [r.id, r.laterBy]).sort())
      .toEqual(PROGRAMME.filter(a => attentionFor(attention, a.id).laterThanBaseline).map(a => [a.id, attentionFor(attention, a.id).laterBy]).sort())
  })

  it('the module imports the selectors and re-implements none of them', () => {
    const src = stripComments(read('lib/programmeAttention.js'))
    expect(src).toContain("import { isOverdue, daysLate } from './projectTimeline'")
    expect(src).toContain("import { blockedActivityRows, dependencyReviewRows, baselineSlippageRows } from './pulseSchedule'")
    // No date arithmetic, no status test, no graph walk and no clock of its own.
    expect(src).not.toMatch(/plannedStart|plannedFinish|actualFinish|\.status\b|daysBetween|todayIso|addDays|earliestStart|predecessors/)
    expect(src.replace(/now = new Date\(\)/g, '')).not.toMatch(/new Date\(|Date\.now/)
    expect(src).not.toMatch(/from 'react|from 'firebase|critical|reschedul/i)
  })
})

// ── 6. Page wiring ───────────────────────────────────────────────────────────

describe('the page: one displayed set, evaluated from the complete programme', () => {
  const page = stripComments(read('pages/project/ProjectTimeline.jsx'))
  const chip = stripComments(read('pages/project/timeline/AttentionFilter.jsx'))

  it('dependency states and attention are built from `ordered`, never from the filtered list', () => {
    expect(page).toContain('const depStates = useMemo(() => dependencyStates(ordered, now), [ordered, now])')
    expect(page).toMatch(/buildProgrammeAttention\(\{\s*activities: ordered, depStates, now,/)
    expect(page).not.toMatch(/dependencyStates\((matched|filtered)/)
    expect(page).not.toMatch(/buildProgrammeAttention\(\{\s*activities: (matched|filtered)/)
  })

  it('the attention filter narrows the already-filtered list into the ONE displayed set', () => {
    expect(page).toContain('() => filterByAttention(matched, attention, attentionFilter),')
    // The chart, the list and the cards all receive that same set.
    expect(page.match(/activities=\{filtered\}/g)).toHaveLength(3)
    expect(page).not.toContain('activities={matched}')
  })

  it('the baseline flag follows the selected approved baseline the page already compares with', () => {
    expect(page).toContain('baseline: { usable: baselineInfo.available, header: selectedHeader, comparison },')
  })

  it('the choice is page state, validated, and cleared with the other filters', () => {
    expect(page).toContain('const [attentionFilter, setAttentionFilterState] = useState(ATTENTION_FILTER.OFF)')
    expect(page).toContain('const setAttentionFilter = (v) => { if (isAttentionFilter(v)) setAttentionFilterState(v) }')
    expect(page).toContain('const filtersActive = Boolean(search || status || responsible || hideClosed || due || attentionFilter)')
    expect(page).toContain('setAttentionFilterState(ATTENTION_FILTER.OFF)')
  })

  it('the control is a labelled group of pressed-state buttons with counts as text', () => {
    expect(chip).toContain('role="group" aria-labelledby="tl-attention-label"')
    expect(chip).toContain('aria-pressed={active}')
    expect(chip).toContain('attentionCount(attention, o.value)')
    expect(chip).toContain('onClick={() => onChange(active ? ATTENTION_FILTER.OFF : o.value)}')
  })

  it('later-than-baseline without a baseline is disabled and says "not evaluated" — never a zero', () => {
    expect(chip).toContain('const notEvaluated = o.value === ATTENTION_FLAG.LATER_THAN_BASELINE && baselineOff')
    expect(chip).toContain('disabled={notEvaluated && !active}')
    expect(chip).toContain('not evaluated')
  })

  it('the control computes nothing and writes nothing', () => {
    expect(chip).not.toMatch(/from 'firebase|use[A-Z]\w+\(|new Date\(|isOverdue|dependencyStates/)
  })
})
