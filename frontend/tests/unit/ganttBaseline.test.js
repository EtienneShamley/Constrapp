import { describe, it, expect } from 'vitest'
import {
  BASELINE_STATUS, BASELINE_LIMITS, SNAPSHOT_MAX_BYTES, FIRESTORE_DOCUMENT_MAX_BYTES, ENTRY_KEYS,
  canBaselineTransition, validateBaselineDraft, normaliseBaselineDraft, validateWithdrawReason,
  projectBaselineEntry, validateBaselineEntry, firestoreValueBytes, estimateSnapshotBytes, buildCapturePayload,
  approvedBaselines, activeBaseline, originalBaseline, draftBaselines, baselineOrdinal, baselineDesignation,
  baselineVersionLabel, baselineSelectorOptions, selectedBaseline, ACTIVE_CHOICE, BASELINE_DESIGNATION,
  snapshotEntryIndex, isSnapshotUsable, programmeDrift, driftKey,
  activityBaselineVariance, baselineComparison, varianceFor, VARIANCE_KIND, VARIANCE_STATE, EMPTY_VARIANCE,
  formatDayDelta, formatDayDeltaShort, varianceLabel, completionLabel, varianceShort, baselineDatesLabel,
  baselineSummary,
} from '../../src/lib/ganttBaseline'
import { ACTIVITY_STATUS } from '../../src/lib/projectTimeline'

// ── Programme baselines — pure domain tests (ADR-66) ─────────────────────────
//
// No Firestore, no React, no clock. Dates are 'YYYY-MM-DD' strings through
// the ADR-29 UTC helpers, so every variance here is deterministic in every
// timezone.

const ts = (ms) => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6, toMillis: () => ms })

const activity = (overrides = {}) => ({
  id: 'a1', name: 'Ground floor slab', description: '', isMilestone: false, status: ACTIVITY_STATUS.NOT_STARTED,
  plannedStart: '2026-10-05', plannedFinish: '2026-10-09', actualStart: null, actualFinish: null,
  percentComplete: 0, responsibleContactId: null, responsibleName: '', costCodeId: null, costCodeName: '',
  sortOrder: 10, notes: '', predecessors: [], revision: 2,
  ...overrides,
})

const entry = (overrides = {}) => ({
  activityId: 'a1', name: 'Ground floor slab', isMilestone: false,
  plannedStart: '2026-10-05', plannedFinish: '2026-10-09',
  status: ACTIVITY_STATUS.NOT_STARTED, percentComplete: 0, revision: 2, sortOrder: 10, costCodeId: null,
  ...overrides,
})

const snapshotOf = (entries, extra = {}) => ({ id: 'b1', activityCount: entries.length, capturedAt: ts(1), capturedBy: 'u', activities: entries, ...extra })

const header = (overrides = {}) => ({
  id: 'b1', name: 'Original programme', reason: 'Award', status: BASELINE_STATUS.APPROVED, activityCount: 1,
  approvedAt: ts(2000), approvedBy: 'u_admin', withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
  revision: 2, createdAt: ts(1000), createdBy: 'u_pm', updatedAt: ts(2000), updatedBy: 'u_admin',
  ...overrides,
})

// ── Lifecycle and drafts ─────────────────────────────────────────────────────

describe('header lifecycle', () => {
  it('draft → approved | withdrawn only; approved and withdrawn are terminal', () => {
    expect(canBaselineTransition('draft', 'approved')).toBe(true)
    expect(canBaselineTransition('draft', 'withdrawn')).toBe(true)
    expect(canBaselineTransition('draft', 'draft')).toBe(false)
    expect(canBaselineTransition('approved', 'withdrawn')).toBe(false)
    expect(canBaselineTransition('approved', 'draft')).toBe(false)
    expect(canBaselineTransition('withdrawn', 'approved')).toBe(false)
    expect(canBaselineTransition('nope', 'approved')).toBe(false)
  })

  it('validates and normalises the name and reason', () => {
    expect(validateBaselineDraft({ name: '', reason: 'r' })).toMatch(/name/)
    expect(validateBaselineDraft({ name: 'n', reason: '  ' })).toMatch(/reason/)
    expect(validateBaselineDraft({ name: 'x'.repeat(121), reason: 'r' })).toMatch(/120/)
    expect(validateBaselineDraft({ name: 'n', reason: 'x'.repeat(501) })).toMatch(/500/)
    expect(validateBaselineDraft({ name: ' n ', reason: ' r ' })).toBeNull()
    expect(normaliseBaselineDraft({ name: ' n ', reason: ' r ' })).toEqual({ name: 'n', reason: 'r' })
    expect(validateWithdrawReason(' ')).toMatch(/reason/)
    expect(validateWithdrawReason('x'.repeat(501))).toMatch(/500/)
    expect(validateWithdrawReason('too early')).toBeNull()
  })
})

// ── Projection and validation ────────────────────────────────────────────────

describe('capture projection', () => {
  it('projects EXACTLY the entry keys — no description, notes, actual dates, predecessors or name snapshots', () => {
    const e = projectBaselineEntry(activity({ actualStart: '2026-10-05', actualFinish: '2026-10-09', notes: 'n', description: 'd', predecessors: [{ activityId: 'a0', type: 'FS', lagDays: 0 }], costCodeId: 'cc1', costCodeName: 'Concrete', responsibleContactId: 'c1', responsibleName: 'Bob' }))
    expect(Object.keys(e).sort()).toEqual([...ENTRY_KEYS].sort())
    expect(e).toEqual(entry({ costCodeId: 'cc1' }))
  })

  it('reads a legacy document without a revision as revision 1 and never repairs a record', () => {
    const legacy = activity(); delete legacy.revision
    expect(projectBaselineEntry(legacy).revision).toBe(1)
    const bad = projectBaselineEntry(activity({ plannedStart: 'nope', name: '', costCodeId: '' }))
    expect(bad.plannedStart).toBe('nope')
    expect(bad.name).toBe('')
    expect(bad.costCodeId).toBeNull()
  })

  it('validates every entry with a precise reason', () => {
    expect(validateBaselineEntry(entry())).toBeNull()
    expect(validateBaselineEntry(entry({ activityId: '' }))).toMatch(/document id/)
    expect(validateBaselineEntry(entry({ name: ' ' }))).toMatch(/no name/)
    expect(validateBaselineEntry(entry({ name: 'x'.repeat(121) }))).toMatch(/120/)
    expect(validateBaselineEntry(entry({ status: 'blocked' }))).toMatch(/status/)
    expect(validateBaselineEntry(entry({ plannedStart: '2026-02-30' }))).toMatch(/planned start/)
    expect(validateBaselineEntry(entry({ isMilestone: true, plannedStart: '', plannedFinish: '' }))).toMatch(/milestone date/)
    expect(validateBaselineEntry(entry({ plannedFinish: 'x' }))).toMatch(/planned finish/)
    expect(validateBaselineEntry(entry({ plannedFinish: '2026-10-01' }))).toMatch(/before its planned start/)
    expect(validateBaselineEntry(entry({ isMilestone: true }))).toMatch(/milestone with two different dates/)
    expect(validateBaselineEntry(entry({ percentComplete: 101 }))).toMatch(/0–100/)
    expect(validateBaselineEntry(entry({ percentComplete: 1.5 }))).toMatch(/0–100/)
    expect(validateBaselineEntry(entry({ revision: 0 }))).toMatch(/revision/)
    expect(validateBaselineEntry(entry({ sortOrder: 'a' }))).toMatch(/order/)
    expect(validateBaselineEntry(entry({ costCodeId: 7 }))).toMatch(/cost code/)
    expect(validateBaselineEntry(entry({ status: ACTIVITY_STATUS.CANCELLED }))).toBeNull()
  })
})

describe('capture payload', () => {
  it('captures EVERY activity (cancelled history included, with its status) in programme order, with counts', () => {
    const p = buildCapturePayload([
      activity({ id: 'c', name: 'C', sortOrder: 30, status: ACTIVITY_STATUS.CANCELLED, cancelReason: 'x' }),
      activity({ id: 'a', name: 'A', sortOrder: 10 }),
      activity({ id: 'm', name: 'M', sortOrder: 20, isMilestone: true, plannedStart: '2026-10-09', plannedFinish: '2026-10-09' }),
    ])
    expect(p.ok).toBe(true)
    expect(p.entries.map(e => e.activityId)).toEqual(['a', 'm', 'c'])
    expect(p.entries[2].status).toBe(ACTIVITY_STATUS.CANCELLED)
    expect(p.counts).toEqual({ total: 3, captured: 3, live: 2, cancelledAtCapture: 1, milestones: 1, invalid: 0 })
    expect(p.bytes).toBeGreaterThan(0)
    expect(p.refusal).toBeNull()
  })

  it('REFUSES — naming the records — on any malformed activity or a duplicate id; nothing is excluded silently', () => {
    const p = buildCapturePayload([
      activity({ id: 'a', name: 'A' }),
      activity({ id: 'b', name: 'B', plannedFinish: '2026-10-01' }),
      activity({ id: 'a', name: 'A again' }),
    ])
    expect(p.ok).toBe(false)
    expect(p.errors).toHaveLength(2)
    expect(p.errors[0].reason).toBe('B has a planned finish before its planned start')
    expect(p.errors[1].reason).toMatch(/appears twice/)
    expect(p.refusal).toMatch(/2 activities cannot be captured/)
    expect(p.refusal).toMatch(/nothing is excluded silently/)
    // The valid rows are still projected (for the preview), never written.
    expect(p.entries.map(e => e.activityId)).toEqual(['a'])
  })

  it('refuses an empty programme, more than 2,000 entries, and an oversized payload — never truncating', () => {
    expect(buildCapturePayload([]).refusal).toMatch(/no activities/)
    const many = Array.from({ length: BASELINE_LIMITS.entries + 1 }, (_, i) => activity({ id: `a${i}`, sortOrder: i }))
    const p = buildCapturePayload(many)
    expect(p.ok).toBe(false)
    expect(p.entries).toHaveLength(2001)
    expect(p.refusal).toMatch(/at most 2000/)
    expect(p.refusal).toMatch(/Nothing was written/)
  })

  it('the worst case the rules admit (2,000 × 120-character names) fits under the 900 KB ceiling and the 1 MiB limit', () => {
    const worst = Array.from({ length: 2000 }, (_, i) => activity({
      id: `activity-${String(i).padStart(14, '0')}`, name: 'x'.repeat(120), sortOrder: i * 10,
      costCodeId: `cost-code-${String(i).padStart(10, '0')}`, revision: 123456,
    }))
    const p = buildCapturePayload(worst, { capturedBy: 'u_'.padEnd(28, 'x') })
    expect(p.ok).toBe(true)
    expect(p.bytes).toBeLessThan(SNAPSHOT_MAX_BYTES)
    expect(p.bytes).toBeLessThan(FIRESTORE_DOCUMENT_MAX_BYTES)
    // Realistic names are far smaller.
    const typical = buildCapturePayload(Array.from({ length: 2000 }, (_, i) => activity({ id: `a${i}`, name: 'Ground floor slab pour', sortOrder: i })))
    expect(typical.bytes).toBeLessThan(p.bytes)
  })

  it('an unrealistic payload above the byte ceiling is refused by size, not by count', () => {
    // Names are capped at 120 by validation, so force the estimate through a
    // long cost-code id (unbounded in the schema) to cross the ceiling.
    const huge = Array.from({ length: 2000 }, (_, i) => activity({ id: `a${i}`, sortOrder: i, costCodeId: 'c'.repeat(400) }))
    const p = buildCapturePayload(huge)
    expect(p.ok).toBe(false)
    expect(p.errors).toHaveLength(0)
    expect(p.refusal).toMatch(/above the/)
    expect(p.refusal).toMatch(/nothing was truncated/)
  })
})

describe('Firestore storage size estimate (the documented formula)', () => {
  it('strings are UTF-8 bytes + 1, numbers 8, booleans and null 1, maps add their field names + 1', () => {
    expect(firestoreValueBytes('abc')).toBe(4)
    expect(firestoreValueBytes('—')).toBe(4)   // 3 UTF-8 bytes + 1
    expect(firestoreValueBytes(12)).toBe(8)
    expect(firestoreValueBytes(true)).toBe(1)
    expect(firestoreValueBytes(null)).toBe(1)
    expect(firestoreValueBytes({ a: 'x' })).toBe(2 + 2)
    expect(firestoreValueBytes([1, 'ab'])).toBe(8 + 3)
    expect(firestoreValueBytes(ts(1))).toBe(8)
  })

  it('a snapshot estimate counts every entry plus the document overhead', () => {
    const one = estimateSnapshotBytes([entry()], { capturedBy: 'u' })
    const two = estimateSnapshotBytes([entry(), entry({ activityId: 'a2' })], { capturedBy: 'u' })
    expect(two - one).toBe(firestoreValueBytes(entry({ activityId: 'a2' })))
    expect(estimateSnapshotBytes([])).toBeGreaterThan(200)
  })
})

// ── Versions ─────────────────────────────────────────────────────────────────

describe('approved history: active, original, ordinals, designation', () => {
  const h1 = header({ id: 'b1', approvedAt: ts(1000) })
  const h2 = header({ id: 'b2', name: 'Revision 1', approvedAt: ts(5000) })
  const h3 = header({ id: 'b3', name: 'Revision 2', approvedAt: ts(9000) })
  const draft = header({ id: 'd1', status: BASELINE_STATUS.DRAFT, approvedAt: null, approvedBy: null, createdAt: ts(9500) })
  const withdrawn = header({ id: 'w1', status: BASELINE_STATUS.WITHDRAWN, approvedAt: null, approvedBy: null, withdrawnAt: ts(100) })
  const all = [h3, draft, h1, withdrawn, h2]

  it('orders approved versions by approvedAt; drafts and withdrawn are never approved', () => {
    expect(approvedBaselines(all).map(h => h.id)).toEqual(['b1', 'b2', 'b3'])
    expect(activeBaseline(all).id).toBe('b3')
    expect(originalBaseline(all).id).toBe('b1')
    expect(draftBaselines(all).map(h => h.id)).toEqual(['d1'])
    expect(activeBaseline([draft, withdrawn])).toBeNull()
    expect(originalBaseline([])).toBeNull()
  })

  it('a tie on approvedAt breaks on the document id, deterministically', () => {
    const x = header({ id: 'zz', approvedAt: ts(5000) })
    const y = header({ id: 'aa', approvedAt: ts(5000) })
    expect(approvedBaselines([x, y]).map(h => h.id)).toEqual(['aa', 'zz'])
    expect(approvedBaselines([y, x]).map(h => h.id)).toEqual(['aa', 'zz'])
    expect(activeBaseline([x, y]).id).toBe('zz')
    expect(originalBaseline([x, y]).id).toBe('aa')
  })

  it('an approved header with no usable approvedAt is never active (a malformed record cannot become the baseline)', () => {
    const bad = header({ id: 'bad', approvedAt: null })
    expect(approvedBaselines([bad, h1]).map(h => h.id)).toEqual(['b1'])
  })

  it('ordinals are stable 1-based positions; designations name active, original, both, or historical', () => {
    expect(baselineOrdinal(all, 'b1')).toBe(1)
    expect(baselineOrdinal(all, 'b3')).toBe(3)
    expect(baselineOrdinal(all, 'd1')).toBeNull()
    expect(baselineDesignation(all, 'b3')).toBe(BASELINE_DESIGNATION.ACTIVE)
    expect(baselineDesignation(all, 'b1')).toBe(BASELINE_DESIGNATION.ORIGINAL)
    expect(baselineDesignation(all, 'b2')).toBe(BASELINE_DESIGNATION.HISTORICAL)
    expect(baselineDesignation([h1], 'b1')).toBe(BASELINE_DESIGNATION.ACTIVE_ORIGINAL)
    expect(baselineDesignation(all, 'd1')).toBeNull()
    expect(baselineDesignation([], 'b1')).toBeNull()
  })

  it('labels and selector options (newest first) carry the ordinal, the name and the designation', () => {
    expect(baselineVersionLabel(all, h2)).toBe('Baseline 2 — Revision 1')
    expect(baselineVersionLabel(all, draft)).toBe('Original programme')
    expect(baselineVersionLabel(all, header({ id: 'b1', name: '', approvedAt: ts(1000) }))).toBe('Baseline 1')
    const opts = baselineSelectorOptions(all)
    expect(opts.map(o => o.id)).toEqual(['b3', 'b2', 'b1'])
    expect(opts[0].designationLabel).toBe('Active')
    expect(opts[2].designationLabel).toBe('Original')
  })

  it('selectedBaseline resolves "active" or an approved id, never a draft or an unknown id', () => {
    expect(selectedBaseline(all, ACTIVE_CHOICE).id).toBe('b3')
    expect(selectedBaseline(all, undefined).id).toBe('b3')
    expect(selectedBaseline(all, 'b1').id).toBe('b1')
    expect(selectedBaseline(all, 'd1')).toBeNull()
    expect(selectedBaseline(all, 'nope')).toBeNull()
    expect(selectedBaseline([], ACTIVE_CHOICE)).toBeNull()
  })
})

// ── Snapshot reading and drift ───────────────────────────────────────────────

describe('snapshot index and usability', () => {
  it('indexes entries by id, skipping malformed ones and duplicates, and tolerates a malformed document', () => {
    const idx = snapshotEntryIndex(snapshotOf([entry(), { garbage: true }, entry({ activityId: 'a1', name: 'dup' }), entry({ activityId: 'a2' })]))
    expect([...idx.keys()]).toEqual(['a1', 'a2'])
    expect(idx.get('a1').name).toBe('Ground floor slab')
    expect(snapshotEntryIndex(null).size).toBe(0)
    expect(snapshotEntryIndex({ activities: 'x' }).size).toBe(0)
    expect(isSnapshotUsable(snapshotOf([entry()]))).toBe(true)
    expect(isSnapshotUsable({ activities: [] })).toBe(false)
    expect(isSnapshotUsable(null)).toBe(false)
  })
})

describe('programme drift since capture', () => {
  const snap = snapshotOf([entry({ activityId: 'a1', revision: 2 }), entry({ activityId: 'a2', revision: 1 }), entry({ activityId: 'a3', revision: 1 }), entry({ activityId: 'c0', revision: 1, status: ACTIVITY_STATUS.CANCELLED })])

  it('reports changed revisions, added activities, cancelled-since and missing sources, sorted by name', () => {
    const d = programmeDrift([
      activity({ id: 'a1', name: 'One', revision: 3 }),
      activity({ id: 'a2', name: 'Two', revision: 1 }),
      activity({ id: 'a3', name: 'Three', revision: 2, status: ACTIVITY_STATUS.CANCELLED }),
      activity({ id: 'a4', name: 'Four', revision: 1 }),
      activity({ id: 'c0', name: 'Old', revision: 1, status: ACTIVITY_STATUS.CANCELLED }),
    ], snap)
    expect(d.changed).toEqual([{ activityId: 'a1', name: 'One', from: 2, to: 3 }])
    expect(d.added).toEqual([{ activityId: 'a4', name: 'Four' }])
    expect(d.cancelledAfter).toEqual([{ activityId: 'a3', name: 'Three', from: 1, to: 2 }])
    expect(d.missing).toEqual([])
    expect(d.total).toBe(3)
    expect(d.any).toBe(true)
    expect(d.key).toBe('c:a1@3|a:a4|x:a3@2')
  })

  it('an unchanged programme has no drift and an empty key; a missing source is reported', () => {
    const same = [activity({ id: 'a1', revision: 2 }), activity({ id: 'a2', revision: 1 }), activity({ id: 'a3', revision: 1 }), activity({ id: 'c0', revision: 1, status: ACTIVITY_STATUS.CANCELLED })]
    const d = programmeDrift(same, snap)
    expect(d.any).toBe(false)
    expect(d.key).toBe('')
    const missing = programmeDrift(same.slice(1), snap)
    expect(missing.missing.map(m => m.activityId)).toEqual(['a1'])
    expect(missing.key).toBe('m:a1')
  })

  it('the drift key is order-independent and changes with any revision', () => {
    expect(driftKey({ changed: [{ activityId: 'b', to: 2 }, { activityId: 'a', to: 5 }] })).toBe('c:a@5|c:b@2')
    expect(driftKey({ changed: [{ activityId: 'a', to: 6 }] })).not.toBe(driftKey({ changed: [{ activityId: 'a', to: 5 }] }))
    expect(driftKey()).toBe('')
  })

  it('a legacy activity without a revision reads as 1 — the same as its captured entry', () => {
    const legacy = activity({ id: 'a2' }); delete legacy.revision
    const d = programmeDrift([activity({ id: 'a1', revision: 2 }), legacy, activity({ id: 'a3', revision: 1 }), activity({ id: 'c0', status: ACTIVITY_STATUS.CANCELLED, revision: 1 })], snap)
    expect(d.changed).toEqual([])
  })
})

// ── Variance ─────────────────────────────────────────────────────────────────

describe('activity variance against a baseline entry', () => {
  it('positive = later, negative = earlier, zero = unchanged; start and finish separately', () => {
    const later = activityBaselineVariance(activity({ plannedStart: '2026-10-07', plannedFinish: '2026-10-15' }), entry())
    expect(later).toMatchObject({ kind: VARIANCE_KIND.IN_BASELINE, startVariance: 2, finishVariance: 6, state: VARIANCE_STATE.LATER, moved: true, startMoved: true, finishMoved: true, completionVariance: null, completedLate: null })
    const earlier = activityBaselineVariance(activity({ plannedStart: '2026-10-01', plannedFinish: '2026-10-06' }), entry())
    expect(earlier).toMatchObject({ startVariance: -4, finishVariance: -3, state: VARIANCE_STATE.EARLIER })
    const same = activityBaselineVariance(activity(), entry())
    expect(same).toMatchObject({ startVariance: 0, finishVariance: 0, state: VARIANCE_STATE.UNCHANGED, moved: false })
    const startOnly = activityBaselineVariance(activity({ plannedStart: '2026-10-06' }), entry())
    expect(startOnly).toMatchObject({ startVariance: 1, finishVariance: 0, state: VARIANCE_STATE.UNCHANGED, moved: true, startMoved: true, finishMoved: false })
  })

  it('completion variance ONLY from a recorded actual finish — never inferred from a completed status', () => {
    const completedNoFinish = activityBaselineVariance(activity({ status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100 }), entry())
    expect(completedNoFinish.completionVariance).toBeNull()
    expect(completedNoFinish.completedLate).toBeNull()
    const late = activityBaselineVariance(activity({ status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualStart: '2026-10-05', actualFinish: '2026-10-12' }), entry())
    expect(late.completionVariance).toBe(3)
    expect(late.completedLate).toBe(true)
    const early = activityBaselineVariance(activity({ status: ACTIVITY_STATUS.IN_PROGRESS, actualStart: '2026-10-05', actualFinish: '2026-10-08' }), entry())
    expect(early.completionVariance).toBe(-1)
    expect(early.completedLate).toBe(false)
    const onDay = activityBaselineVariance(activity({ actualFinish: '2026-10-09' }), entry())
    expect(onDay.completionVariance).toBe(0)
    expect(onDay.completedLate).toBe(false)
  })

  it('crosses a month end, a year end and a leap day correctly', () => {
    expect(activityBaselineVariance(activity({ plannedStart: '2026-11-01', plannedFinish: '2026-11-03' }), entry({ plannedStart: '2026-10-30', plannedFinish: '2026-10-31' })).finishVariance).toBe(3)
    expect(activityBaselineVariance(activity({ plannedStart: '2027-01-02', plannedFinish: '2027-01-05' }), entry({ plannedStart: '2026-12-30', plannedFinish: '2026-12-31' })).startVariance).toBe(3)
    expect(activityBaselineVariance(activity({ plannedStart: '2028-02-28', plannedFinish: '2028-03-01' }), entry({ plannedStart: '2028-02-28', plannedFinish: '2028-02-28' })).finishVariance).toBe(2)
    expect(activityBaselineVariance(activity({ plannedStart: '2027-02-28', plannedFinish: '2027-03-01' }), entry({ plannedStart: '2027-02-28', plannedFinish: '2027-02-28' })).finishVariance).toBe(1)
  })

  it('milestones compare their single date', () => {
    const m = activityBaselineVariance(
      activity({ isMilestone: true, plannedStart: '2026-10-12', plannedFinish: '2026-10-12' }),
      entry({ isMilestone: true, plannedStart: '2026-10-09', plannedFinish: '2026-10-09' }),
    )
    expect(m.finishVariance).toBe(3)
    expect(m.startVariance).toBe(3)
    expect(m.state).toBe(VARIANCE_STATE.LATER)
  })

  it('classifies no baseline, added after, cancelled at capture, cancelled after, missing source and invalid dates', () => {
    expect(activityBaselineVariance(null, null).kind).toBe(VARIANCE_KIND.NO_BASELINE)
    expect(activityBaselineVariance(activity(), null).kind).toBe(VARIANCE_KIND.ADDED_AFTER)
    expect(activityBaselineVariance(null, entry()).kind).toBe(VARIANCE_KIND.MISSING_SOURCE)
    expect(activityBaselineVariance(activity({ status: ACTIVITY_STATUS.CANCELLED }), entry({ status: ACTIVITY_STATUS.CANCELLED })).kind).toBe(VARIANCE_KIND.CANCELLED_AT_CAPTURE)
    expect(activityBaselineVariance(activity({ status: ACTIVITY_STATUS.CANCELLED }), entry()).kind).toBe(VARIANCE_KIND.CANCELLED_AFTER)
    expect(activityBaselineVariance(activity({ plannedFinish: 'bad' }), entry()).kind).toBe(VARIANCE_KIND.INVALID)
    expect(activityBaselineVariance(activity(), entry({ plannedStart: '2026-02-30' })).kind).toBe(VARIANCE_KIND.INVALID)
    for (const kind of [VARIANCE_KIND.ADDED_AFTER, VARIANCE_KIND.CANCELLED_AFTER, VARIANCE_KIND.INVALID]) {
      const v = kind === VARIANCE_KIND.ADDED_AFTER ? activityBaselineVariance(activity(), null)
        : kind === VARIANCE_KIND.CANCELLED_AFTER ? activityBaselineVariance(activity({ status: ACTIVITY_STATUS.CANCELLED }), entry())
          : activityBaselineVariance(activity({ plannedFinish: 'bad' }), entry())
      expect(v.startVariance).toBeNull()
      expect(v.finishVariance).toBeNull()
      expect(v.state).toBeNull()
    }
  })
})

describe('baselineComparison over a programme', () => {
  it('maps every live activity and every orphaned entry; with no usable snapshot everything is NO_BASELINE', () => {
    const snap = snapshotOf([entry({ activityId: 'a1' }), entry({ activityId: 'gone' })])
    const m = baselineComparison([activity({ id: 'a1', plannedFinish: '2026-10-10' }), activity({ id: 'new' })], snap)
    expect(varianceFor(m, 'a1').finishVariance).toBe(1)
    expect(varianceFor(m, 'new').kind).toBe(VARIANCE_KIND.ADDED_AFTER)
    expect(varianceFor(m, 'gone').kind).toBe(VARIANCE_KIND.MISSING_SOURCE)
    expect(varianceFor(m, 'unknown')).toBe(EMPTY_VARIANCE)
    const none = baselineComparison([activity()], null)
    expect(varianceFor(none, 'a1').kind).toBe(VARIANCE_KIND.NO_BASELINE)
    expect(varianceFor(null, 'a1')).toBe(EMPTY_VARIANCE)
  })

  it('never mutates the activities or the snapshot', () => {
    const list = [activity()]
    const snap = snapshotOf([entry()])
    const before = JSON.stringify([list, snap])
    baselineComparison(list, snap)
    baselineSummary(list, snap)
    expect(JSON.stringify([list, snap])).toBe(before)
  })
})

// ── Text ─────────────────────────────────────────────────────────────────────

describe('labels', () => {
  it('day deltas carry the sign, singular/plural and "unchanged"', () => {
    expect(formatDayDelta(6)).toBe('+6 days')
    expect(formatDayDelta(-1)).toBe('−1 day')
    expect(formatDayDelta(0)).toBe('unchanged')
    expect(formatDayDelta(null)).toBe('—')
    expect(formatDayDeltaShort(6)).toBe('+6 d')
    expect(formatDayDeltaShort(-3)).toBe('−3 d')
    expect(formatDayDeltaShort(0)).toBe('0 d')
  })

  it('variance and completion sentences name the baseline, never the current plan, and state every kind', () => {
    const later = activityBaselineVariance(activity({ plannedStart: '2026-10-07', plannedFinish: '2026-10-15' }), entry())
    expect(varianceLabel(later)).toBe('Planned start +2 days, finish +6 days against baseline')
    const startOnly = activityBaselineVariance(activity({ plannedStart: '2026-10-06' }), entry())
    expect(varianceLabel(startOnly)).toBe('Planned start +1 day, finish unchanged against baseline')
    expect(varianceLabel(activityBaselineVariance(activity(), entry()))).toBe('Unchanged from baseline')
    const m = activityBaselineVariance(activity({ isMilestone: true, plannedStart: '2026-10-12', plannedFinish: '2026-10-12' }), entry({ isMilestone: true, plannedStart: '2026-10-09', plannedFinish: '2026-10-09' }))
    expect(varianceLabel(m)).toBe('Milestone planned +3 days later than baseline')
    expect(varianceLabel(activityBaselineVariance(activity(), null))).toBe('Added after the baseline was approved')
    expect(varianceLabel(activityBaselineVariance(activity({ status: ACTIVITY_STATUS.CANCELLED }), entry()))).toBe('Cancelled since the baseline was approved')
    expect(varianceLabel(activityBaselineVariance(activity({ status: ACTIVITY_STATUS.CANCELLED }), entry({ status: ACTIVITY_STATUS.CANCELLED })))).toBe('Already cancelled when the baseline was approved')
    expect(varianceLabel(activityBaselineVariance(null, entry()))).toBe('In the baseline but not in the programme')
    expect(varianceLabel(activityBaselineVariance(activity({ plannedFinish: 'x' }), entry()))).toMatch(/Cannot be compared/)
    expect(varianceLabel(EMPTY_VARIANCE)).toBe('')
    expect(varianceLabel(null)).toBe('')
    const late = activityBaselineVariance(activity({ actualFinish: '2026-10-12' }), entry())
    expect(completionLabel(late)).toBe('Finished 3 days after the baseline finish')
    expect(completionLabel(activityBaselineVariance(activity({ actualFinish: '2026-10-08' }), entry()))).toBe('Finished 1 day before the baseline finish')
    expect(completionLabel(activityBaselineVariance(activity({ actualFinish: '2026-10-09' }), entry()))).toBe('Finished on the baseline finish')
    expect(completionLabel(activityBaselineVariance(activity({ isMilestone: true, plannedFinish: '2026-10-05', actualFinish: '2026-10-05' }), entry({ isMilestone: true, plannedStart: '2026-10-05', plannedFinish: '2026-10-05' })))).toBe('Reached on the baseline date')
    expect(completionLabel(activityBaselineVariance(activity(), entry()))).toBe('')
    for (const [lbl] of [[varianceLabel], [completionLabel]]) expect(lbl(later)).not.toMatch(/current plan/)
  })

  it('short values and baseline date labels', () => {
    expect(varianceShort(activityBaselineVariance(activity({ plannedFinish: '2026-10-15' }), entry()))).toBe('+6 d')
    expect(varianceShort(activityBaselineVariance(activity(), null))).toBe('Added')
    expect(varianceShort(activityBaselineVariance(activity({ status: ACTIVITY_STATUS.CANCELLED }), entry()))).toBe('Cancelled')
    expect(varianceShort(activityBaselineVariance(null, entry()))).toBe('Missing')
    expect(varianceShort(activityBaselineVariance(activity({ plannedFinish: 'x' }), entry()))).toBe('Invalid')
    expect(varianceShort(EMPTY_VARIANCE)).toBe('—')
    expect(baselineDatesLabel(entry())).toBe('Baseline 05/10/2026 to 09/10/2026')
    expect(baselineDatesLabel(entry({ isMilestone: true, plannedFinish: '2026-10-05' }))).toBe('Baseline milestone 05/10/2026')
    expect(baselineDatesLabel(null)).toBe('')
  })
})

// ── Summary ──────────────────────────────────────────────────────────────────

describe('baselineSummary — defensible counts only', () => {
  const snap = snapshotOf([
    entry({ activityId: 'u' }),                                                       // unchanged
    entry({ activityId: 'l', plannedStart: '2026-10-10', plannedFinish: '2026-10-20' }), // later
    entry({ activityId: 'e' }),                                                       // earlier
    entry({ activityId: 'm', isMilestone: true, plannedStart: '2026-10-30', plannedFinish: '2026-10-30' }), // milestone later
    entry({ activityId: 'c' }),                                                       // cancelled since
    entry({ activityId: 'x', status: ACTIVITY_STATUS.CANCELLED }),                   // cancelled at capture
    entry({ activityId: 'd' }),                                                       // completed late
    entry({ activityId: 'g' }),                                                       // missing source
    entry({ activityId: 's' }),                                                       // start moved only
  ])
  const live = [
    activity({ id: 'u', name: 'Unchanged' }),
    activity({ id: 'l', name: 'Later', plannedStart: '2026-10-12', plannedFinish: '2026-10-28' }),
    activity({ id: 'e', name: 'Earlier', plannedStart: '2026-10-03', plannedFinish: '2026-10-07' }),
    activity({ id: 'm', name: 'Milestone', isMilestone: true, plannedStart: '2026-11-02', plannedFinish: '2026-11-02' }),
    activity({ id: 'c', name: 'Cancelled', status: ACTIVITY_STATUS.CANCELLED }),
    activity({ id: 'x', name: 'Old', status: ACTIVITY_STATUS.CANCELLED }),
    activity({ id: 'd', name: 'Done late', status: ACTIVITY_STATUS.COMPLETED, percentComplete: 100, actualStart: '2026-10-05', actualFinish: '2026-10-11' }),
    activity({ id: 'n', name: 'New' }),
    activity({ id: 's', name: 'Start moved', plannedStart: '2026-10-06' }),
    activity({ id: 'b', name: 'Bad', plannedFinish: 'nope' }),
  ]

  it('counts each class once and names the single largest finish movement', () => {
    const s = baselineSummary(live, snap)
    expect(s.available).toBe(true)
    expect(s).toMatchObject({
      captured: 9, cancelledAtCapture: 1, addedAfter: 2, cancelledSince: 1, missingSource: 1, invalid: 0,
      compared: 6, earlier: 1, unchanged: 3, later: 2, startMovedOnly: 1,
      milestonesCompared: 1, milestonesLater: 1, completedCompared: 1, completedLate: 1,
    })
    expect(s.largestFinish).toEqual({ days: 8, activityId: 'l', name: 'Later' })
    // "Bad" is added-after (not in the snapshot) and never counted as invalid; an
    // in-baseline bad date would be.
    const withInvalid = baselineSummary([activity({ id: 'u', plannedFinish: 'nope' })], snapshotOf([entry({ activityId: 'u' })]))
    expect(withInvalid.invalid).toBe(1)
  })

  it('the envelope is the LATEST planned finish on each side over non-cancelled rows, in days', () => {
    const s = baselineSummary(live, snap)
    expect(s.envelope).toEqual({ baselineFinish: '2026-10-30', currentFinish: '2026-11-02', days: 3 })
  })

  it('has no average and no completion claim; an unusable snapshot yields an unavailable summary', () => {
    const s = baselineSummary(live, snap)
    expect(Object.keys(s)).not.toContain('average')
    expect(Object.keys(s)).not.toContain('projectDelay')
    const none = baselineSummary(live, null)
    expect(none.available).toBe(false)
    expect(none.captured).toBe(0)
    expect(none.envelope).toBeNull()
  })

  it('a largest-finish tie breaks on the activity id, deterministically', () => {
    const snap2 = snapshotOf([entry({ activityId: 'z' }), entry({ activityId: 'a' })])
    const s = baselineSummary([activity({ id: 'z', name: 'Z', plannedFinish: '2026-10-12' }), activity({ id: 'a', name: 'A', plannedFinish: '2026-10-12' })], snap2)
    expect(s.largestFinish.activityId).toBe('a')
  })
})
