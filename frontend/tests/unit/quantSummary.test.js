import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SUMMARY_CATEGORY, SUMMARY_ISSUE, SUMMARY_ISSUE_LABELS, SUMMARY_ISSUE_ORDER, SUMMARY_READINESS, TARGET_PROBLEM, KIND_ORDER,
  classifyMeasurement, summariseTakeoff, kindTotals, emptyKindTotals, isTotalable, summaryReadiness, measurementTarget, revisionLabel, measuredAt,
} from '../../src/lib/quantSummary.js'
import { buildCalibration, roundQuantity, QUANTITY_STATE } from '../../src/lib/quant.js'
import { parseSavedSelection, readSelection, writeSelection, SELECTION_VERSION } from '../../src/lib/quantSelection.js'

// ── Constrapp Quant™ 1C-B — project-wide summary and traceability (ADR-53) ───
//
// Pure tests over lib/quantSummary.js (classification, per-kind totals that
// never mix, current vs historical kept apart, attention rows, readiness,
// navigation targets) and the optional `measurementId` in the remembered
// selection, plus source pins over the summary view, the workspace's
// open-target flow and the BOQ dialog's "Open in Quant". Plain Node, no jsdom.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const P = (x, y) => ({ x, y })
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const CAL = buildCalibration({ pointA: P(0, 0), pointB: P(100, 0), realDistance: 1, unit: 'm' }) // 100 units = 1 m
const SNAP = { revision: 1, pageDistance: 100, realDistance: 1, unit: 'm' }
const TS = (seconds) => ({ seconds, nanoseconds: 0, toDate: () => new Date(seconds * 1000) })

const drawing = (o = {}) => ({ id: 'd1', status: 'active', drawingNumber: 'A-101', title: 'Ground Floor Plan', currentRevisionId: 'r2', currentRevisionCode: 'B', ...o })
const page = (o = {}) => ({ id: 'd1_r2_1', drawingId: 'd1', revisionId: 'r2', page: 1, calibration: CAL, calibrationRevision: 1, ...o })
let n = 0
const m = (o = {}) => ({
  id: `m${++n}`, takeoffPageId: 'd1_r2_1', drawingId: 'd1', revisionId: 'r2', page: 1,
  kind: 'area', points: [P(0, 0), P(300, 0), P(300, 400), P(0, 400)], // 12 m²
  label: 'Slab', costCodeId: 'cc1', costCodeName: '04-100 — Formwork', calibration: SNAP, boqItemId: 'b1',
  status: 'active', voidReason: '', voidedAt: null, voidedBy: null, revision: 1,
  createdAt: TS(1), createdBy: 'u1', updatedAt: TS(1), updatedBy: 'u1', ...o,
})
const length = (o = {}) => m({ kind: 'length', points: [P(0, 0), P(300, 400)], ...o }) // 5 m
const count  = (o = {}) => m({ kind: 'count', points: [P(1, 1), P(2, 2), P(3, 3)], calibration: null, boqItemId: null, ...o })
const item = (o = {}) => ({ id: 'b1', itemNumber: '2.1', description: 'Formwork to slab edge', unit: 'm2', quantity: 10, rate: 85, costCodeId: 'cc1', status: 'active', ...o })
const costCodes = [{ id: 'cc1', code: '04-100', name: 'Formwork', isActive: true }, { id: 'cc2', code: '03-100', name: 'Concrete', isActive: true }]

const sum = (measurements, extra = {}) => summariseTakeoff({ measurements, takeoffPages: [page()], drawings: [drawing()], costCodes, boqItems: [item()], ...extra })

// ── 1. Classification ────────────────────────────────────────────────────────

describe('classification — current & valid, attention, historical, void', () => {
  it('a calibrated, reviewed, linked measurement on the current revision is CURRENT with no issues and its own-page quantity', () => {
    const s = sum([m()])
    const r = s.rows[0]
    expect(r.category).toBe(SUMMARY_CATEGORY.CURRENT)
    expect(r.issues).toEqual([])
    expect(near(r.quantity.value, 12)).toBe(true)
    expect(r.current).toBe(true)
    expect(r.costCode).toBe('04-100 — Formwork')
    expect(r.revisionLabel).toBe('Rev B · current')
    expect(r.measuredAt).toBe(r.m.createdAt)
  })

  it('an unlinked measurement is still CURRENT (a valid quantity) and is listed under attention informationally', () => {
    const s = sum([m({ boqItemId: null })])
    expect(s.rows[0].category).toBe(SUMMARY_CATEGORY.CURRENT)
    expect(s.rows[0].issues).toEqual([SUMMARY_ISSUE.UNLINKED])
    expect(s.attention.map(r => r.m.id)).toEqual([s.rows[0].m.id])
    expect(near(s.totals.current.area.total, 12)).toBe(true)
  })

  it('needs review, uncalibrated and non-derivable geometry are ATTENTION and never totalled', () => {
    // Needs review: the page was re-calibrated (revision 2) after this measurement's snapshot (revision 1).
    const needsReview = m({ takeoffPageId: 'd1_r2_3', page: 3 })
    const uncal = m({ takeoffPageId: 'd1_r2_2', page: 2 })
    const crossed = m({ points: [P(0, 0), P(300, 0), P(100, 400), P(300, 400)] })
    const s = summariseTakeoff({
      measurements: [needsReview, uncal, crossed],
      takeoffPages: [page(), page({ id: 'd1_r2_2', page: 2, calibration: null, calibrationRevision: 0 }), page({ id: 'd1_r2_3', page: 3, calibrationRevision: 2 })],
      drawings: [drawing()], costCodes, boqItems: [item()],
    })
    const byId = Object.fromEntries(s.rows.map(r => [r.m.id, r]))
    expect(byId[needsReview.id].issues).toEqual([SUMMARY_ISSUE.NEEDS_REVIEW])
    expect(byId[uncal.id].issues).toEqual([SUMMARY_ISSUE.UNCALIBRATED])
    expect(byId[crossed.id].issues).toEqual([SUMMARY_ISSUE.INVALID])
    for (const r of s.rows) expect(r.category).toBe(SUMMARY_CATEGORY.ATTENTION)
    expect(s.totals.current.area.count).toBe(0)
    expect(s.counts).toEqual({ current: 0, attention: 3, historical: 0, void: 0, total: 3 })
  })

  it('a missing drawing or a missing takeoff page is ATTENTION (source missing), never a quantity', () => {
    const s = summariseTakeoff({ measurements: [m(), m({ takeoffPageId: 'd1_r2_9', page: 9 })], takeoffPages: [page()], drawings: [], costCodes, boqItems: [] })
    for (const r of s.rows) {
      expect(r.category).toBe(SUMMARY_CATEGORY.ATTENTION)
      expect(r.issues).toEqual([SUMMARY_ISSUE.SOURCE_MISSING])
      expect(r.quantity.value).toBeNull()
    }
    const s2 = sum([m({ takeoffPageId: 'd1_r2_9', page: 9 })])
    expect(s2.rows[0].issues).toEqual([SUMMARY_ISSUE.SOURCE_MISSING])
  })

  it('invalid BOQ links are ATTENTION: missing item, void item, other cost code, incompatible unit', () => {
    const items = [item(), item({ id: 'bv', status: 'void' }), item({ id: 'bc', costCodeId: 'cc2' }), item({ id: 'bu', unit: 'm3' })]
    const s = sum([m({ boqItemId: 'nope' }), m({ boqItemId: 'bv' }), m({ boqItemId: 'bc' }), m({ boqItemId: 'bu' })], { boqItems: items })
    expect(s.rows.map(r => r.issues[0])).toEqual([SUMMARY_ISSUE.LINK_MISSING, SUMMARY_ISSUE.LINK_VOID, SUMMARY_ISSUE.LINK_COST_CODE, SUMMARY_ISSUE.LINK_UNIT])
    for (const r of s.rows) expect(r.category).toBe(SUMMARY_CATEGORY.ATTENTION)
    expect(s.totals.current.area.count).toBe(0)
  })

  it('a measurement on an earlier revision, or on a withdrawn drawing, is HISTORICAL — totalled apart, never with current work', () => {
    const older = m({ revisionId: 'r1', takeoffPageId: 'd1_r1_1' })
    const onWithdrawn = m({ drawingId: 'd2', takeoffPageId: 'd2_r5_1', revisionId: 'r5' })
    const s = summariseTakeoff({
      measurements: [m(), older, onWithdrawn],
      takeoffPages: [page(), page({ id: 'd1_r1_1', revisionId: 'r1' }), page({ id: 'd2_r5_1', drawingId: 'd2', revisionId: 'r5' })],
      drawings: [drawing(), drawing({ id: 'd2', drawingNumber: 'A-102', status: 'withdrawn', currentRevisionId: null })],
      costCodes, boqItems: [item()],
    })
    const byId = Object.fromEntries(s.rows.map(r => [r.m.id, r]))
    expect(byId[older.id].category).toBe(SUMMARY_CATEGORY.HISTORICAL)
    expect(byId[older.id].issues).toEqual([SUMMARY_ISSUE.NOT_CURRENT])
    expect(byId[onWithdrawn.id].category).toBe(SUMMARY_CATEGORY.HISTORICAL)
    expect(byId[onWithdrawn.id].issues).toEqual([SUMMARY_ISSUE.DRAWING_WITHDRAWN])
    expect(near(s.totals.current.area.total, 12)).toBe(true)
    expect(s.totals.current.area.count).toBe(1)
    expect(near(s.totals.historical.area.total, 24)).toBe(true)
    expect(s.totals.historical.area.count).toBe(2)
    // Historical rows are NOT in the attention list (no duplicate warning); they have their own list.
    expect(s.attention).toHaveLength(0)
    expect(s.historical.map(r => r.m.id).sort()).toEqual([older.id, onWithdrawn.id].sort())
    expect(byId[older.id].revisionLabel).toBe('Revision …r1 · earlier revision')
    expect(byId[onWithdrawn.id].revisionLabel).toBe('Revision …r5 · drawing withdrawn')
  })

  it('a voided measurement is VOID: counted, never totalled, never in attention, kept in the voided list', () => {
    const v = m({ status: 'void', voidReason: 'wrong room' })
    const s = sum([m(), v])
    expect(s.counts.void).toBe(1)
    expect(s.voided.map(r => r.m.id)).toEqual([v.id])
    expect(s.attention).toHaveLength(0)
    expect(s.totals.current.area.count).toBe(1)
  })

  it('an unreadable record is ATTENTION (unreadable), counted once, never drawn into a total', () => {
    const s = sum([m({ points: 'junk' })])
    expect(s.rows[0].category).toBe(SUMMARY_CATEGORY.ATTENTION)
    expect(s.rows[0].issues).toEqual([SUMMARY_ISSUE.UNREADABLE])
    expect(s.counts.attention).toBe(1)
  })

  it('every measurement counts once even if the subscription lists it twice', () => {
    const one = m()
    const s = sum([one, one])
    expect(s.counts.total).toBe(1)
  })
})

// ── 2. Totals never mix ──────────────────────────────────────────────────────

describe('totals — per kind, unrounded, never across kinds', () => {
  it('lengths, areas and counts sit in their own buckets with their own units', () => {
    const s = sum([m(), m(), length({ boqItemId: null }), count()]) // the m² item cannot take a length; unlinked is still valid
    expect(s.totals.current.area).toMatchObject({ count: 2, unit: 'm²' })
    expect(near(s.totals.current.area.total, 24)).toBe(true)
    expect(s.totals.current.length).toMatchObject({ count: 1, unit: 'm' })
    expect(near(s.totals.current.length.total, 5)).toBe(true)
    expect(s.totals.current.count).toMatchObject({ count: 1, total: 3, unit: 'no.' })
    // No grand total exists anywhere in the summary.
    expect(Object.keys(s.totals)).toEqual(['current', 'historical'])
    expect(Object.keys(s.totals.current).sort()).toEqual(['area', 'count', 'length'])
    expect(KIND_ORDER).toEqual(['length', 'area', 'count'])
  })

  it('sums unrounded and leaves rounding to display (three ⅓ strips make 1.000, not 0.999)', () => {
    const strip = (id) => m({ id, points: [P(0, 0), P(100, 0), P(100, 33.33333333), P(0, 33.33333333)] })
    const s = sum([strip('s1'), strip('s2'), strip('s3')])
    expect(roundQuantity(s.totals.current.area.total)).toBe(1)
    expect(kindTotals([])).toEqual(emptyKindTotals())
    expect(kindTotals([{ m: { kind: 'area' }, quantity: { state: QUANTITY_STATE.INVALID, value: null } }]).area.count).toBe(0)
  })

  it('groups by cost code: named live, current totals and historical totals apart, attention counted', () => {
    const s = sum([m(), m({ costCodeId: 'cc2', costCodeName: 'old name' }), m({ revisionId: 'r1', takeoffPageId: 'd1_r1_1' }), m({ takeoffPageId: 'd1_r2_3', page: 3 })], { takeoffPages: [page(), page({ id: 'd1_r1_1', revisionId: 'r1' }), page({ id: 'd1_r2_3', page: 3, calibrationRevision: 2 })] })
    expect(s.byCostCode.map(g => g.name)).toEqual(['03-100 — Concrete', '04-100 — Formwork'])
    const formwork = s.byCostCode[1]
    expect(formwork.totals.area.count).toBe(1)
    expect(formwork.historical.area.count).toBe(1)
    expect(formwork.counts).toEqual({ current: 1, attention: 1, historical: 1 })
  })

  it('groups by drawing → revision → page with the current revision first, page totals current-or-historical, and an openable target', () => {
    const s = summariseTakeoff({
      measurements: [m(), m({ page: 2, takeoffPageId: 'd1_r2_2' }), m({ revisionId: 'r1', takeoffPageId: 'd1_r1_1' }), m({ status: 'void' })],
      takeoffPages: [page(), page({ id: 'd1_r2_2', page: 2 }), page({ id: 'd1_r1_1', revisionId: 'r1' })],
      drawings: [drawing()], costCodes, boqItems: [item()],
      revisions: [{ id: 'r1', revisionCode: 'A', status: 'superseded' }, { id: 'r2', revisionCode: 'B', status: 'current' }],
    })
    expect(s.byDrawing).toHaveLength(1)
    const d = s.byDrawing[0]
    expect(d.number).toBe('A-101')
    expect(d.revisions.map(r => r.label)).toEqual(['Rev B · current', 'Rev A · superseded'])
    expect(d.revisions[0].pages.map(p => p.page)).toEqual([1, 2])
    expect(d.revisions[0].pages[0].counts).toEqual({ current: 1, attention: 0, historical: 0, void: 1 })
    expect(d.revisions[0].pages[0].target).toEqual({ drawingId: 'd1', revisionId: 'r2', page: 1, measurementId: null })
    expect(d.revisions[1].pages[0].historical.area.count).toBe(1)
    expect(d.revisions[1].pages[0].totals.area.count).toBe(0)
    // A withdrawn drawing's pages carry no target — they cannot be opened.
    const w = summariseTakeoff({ measurements: [m()], takeoffPages: [page()], drawings: [drawing({ status: 'withdrawn' })], costCodes, boqItems: [] })
    expect(w.byDrawing[0].withdrawn).toBe(true)
    expect(w.byDrawing[0].revisions[0].pages[0].target).toBeNull()
  })

  it('the attention list is ordered by what blocks first and carries every issue of a row once', () => {
    const items = [item({ id: 'bv', status: 'void' })]
    const both = m({ boqItemId: 'bv', takeoffPageId: 'd1_r2_3', page: 3 }) // needs review (page re-calibrated) + void link
    const s = sum([m({ boqItemId: null }), both, m({ points: 'junk' })], { boqItems: items, takeoffPages: [page(), page({ id: 'd1_r2_3', page: 3, calibrationRevision: 2 })] })
    expect(s.attention.map(r => r.issues)).toEqual([[SUMMARY_ISSUE.UNREADABLE], [SUMMARY_ISSUE.NEEDS_REVIEW, SUMMARY_ISSUE.LINK_VOID], [SUMMARY_ISSUE.UNLINKED]])
    expect(s.attention.filter(r => r.m.id === both.id)).toHaveLength(1)
    expect(s.issueCounts).toEqual({ [SUMMARY_ISSUE.UNREADABLE]: 1, [SUMMARY_ISSUE.NEEDS_REVIEW]: 1, [SUMMARY_ISSUE.LINK_VOID]: 1, [SUMMARY_ISSUE.UNLINKED]: 1 })
    for (const issue of Object.values(SUMMARY_ISSUE)) {
      expect(SUMMARY_ISSUE_LABELS[issue]).toBeTruthy()
      expect(SUMMARY_ISSUE_ORDER).toContain(issue)
    }
  })

  it('an empty project summarises to zeros and empty groups — never an error', () => {
    const s = summariseTakeoff({})
    expect(s.counts).toEqual({ current: 0, attention: 0, historical: 0, void: 0, total: 0 })
    expect(s.byCostCode).toEqual([])
    expect(s.byDrawing).toEqual([])
    expect(s.attention).toEqual([])
  })
})

// ── 2b. Historical totals are qualified exactly like current ones ───────────

describe('REGRESSION — a historical measurement with a quantity problem is visible, badged, and NEVER summed', () => {
  const olderPage = (o = {}) => page({ id: 'd1_r1_1', revisionId: 'r1', ...o })
  const older = (o = {}) => m({ revisionId: 'r1', takeoffPageId: 'd1_r1_1', ...o })
  const run = (measurements, pages) => summariseTakeoff({ measurements, takeoffPages: pages, drawings: [drawing()], costCodes, boqItems: [item()] })

  it('needs review after a re-calibration: derives a number under the NEW scale but stays out of the historical total', () => {
    const s = run([older()], [page(), olderPage({ calibrationRevision: 2 })])
    const r = s.rows[0]
    expect(r.category).toBe(SUMMARY_CATEGORY.HISTORICAL)
    expect(r.issues).toEqual([SUMMARY_ISSUE.NOT_CURRENT, SUMMARY_ISSUE.NEEDS_REVIEW])
    expect(r.quantity.state).toBe(QUANTITY_STATE.OK)      // a figure exists…
    expect(s.totals.historical.area.count).toBe(0)        // …but it is not represented as validated
    expect(s.totals.historical.area.total).toBe(0)
    expect(s.totals.current.area.count).toBe(0)
    expect(s.historical.map(x => x.m.id)).toEqual([r.m.id]) // still visible and traceable
    expect(s.byDrawing[0].revisions.find(x => x.revisionId === 'r1').pages[0].historical.area.count).toBe(0)
    expect(s.byCostCode[0].historical.area.count).toBe(0)
  })

  it('self-crossing geometry on an earlier revision: INVALID, badged, not summed', () => {
    const s = run([older({ points: [P(0, 0), P(300, 0), P(100, 400), P(300, 400)] })], [page(), olderPage()])
    expect(s.rows[0].category).toBe(SUMMARY_CATEGORY.HISTORICAL)
    expect(s.rows[0].issues).toEqual([SUMMARY_ISSUE.NOT_CURRENT, SUMMARY_ISSUE.INVALID])
    expect(s.rows[0].quantity.value).toBeNull()
    expect(s.totals.historical.area.count).toBe(0)
  })

  it('an uncalibrated earlier page: UNCALIBRATED, badged, not summed; a count on it still counts', () => {
    const pages = [page(), olderPage({ calibration: null, calibrationRevision: 0 })]
    const s = run([older(), older({ kind: 'count', points: [P(1, 1), P(2, 2)], calibration: null, boqItemId: null })], pages)
    const [area, cnt] = s.rows
    expect(area.issues).toEqual([SUMMARY_ISSUE.NOT_CURRENT, SUMMARY_ISSUE.UNCALIBRATED])
    expect(s.totals.historical.area.count).toBe(0)
    expect(cnt.issues).toEqual([SUMMARY_ISSUE.NOT_CURRENT])
    expect(s.totals.historical.count).toMatchObject({ count: 1, total: 2 })
  })

  it('a missing page source on an earlier revision is ATTENTION (source missing) — no quantity, no total of either kind', () => {
    const s = run([older({ takeoffPageId: 'd1_r1_9', page: 9 })], [page()])
    expect(s.rows[0].category).toBe(SUMMARY_CATEGORY.ATTENTION)
    expect(s.rows[0].issues).toEqual([SUMMARY_ISSUE.SOURCE_MISSING])
    expect(s.totals.historical.area.count).toBe(0)
    expect(s.totals.current.area.count).toBe(0)
  })

  it('the same on a WITHDRAWN drawing: the withdrawal badge comes first, the quantity problem beside it, nothing summed', () => {
    const s = summariseTakeoff({
      measurements: [m({ drawingId: 'd2', revisionId: 'r5', takeoffPageId: 'd2_r5_1' })],
      takeoffPages: [page({ id: 'd2_r5_1', drawingId: 'd2', revisionId: 'r5', calibrationRevision: 2 })],
      drawings: [drawing({ id: 'd2', status: 'withdrawn', currentRevisionId: null })], costCodes, boqItems: [item()],
    })
    expect(s.rows[0].issues).toEqual([SUMMARY_ISSUE.DRAWING_WITHDRAWN, SUMMARY_ISSUE.NEEDS_REVIEW])
    expect(s.totals.historical.area.count).toBe(0)
  })

  it('valid historical quantities still total exactly as before, apart from current, and never together', () => {
    const s = run([m(), older(), older({ kind: 'length', points: [P(0, 0), P(300, 400)], boqItemId: null })], [page(), olderPage()])
    expect(near(s.totals.current.area.total, 12)).toBe(true)
    expect(s.totals.current.area.count).toBe(1)
    expect(near(s.totals.historical.area.total, 12)).toBe(true)
    expect(near(s.totals.historical.length.total, 5)).toBe(true)
    expect(s.totals.historical.area.count).toBe(1)
    // Historical rows with quantity problems are never pulled into the attention list (no duplicate warning).
    const s2 = run([older()], [page(), olderPage({ calibrationRevision: 2 })])
    expect(s2.attention).toHaveLength(0)
  })

  it('isTotalable is the single gate kindTotals applies: derived AND not awaiting review', () => {
    const ok = { quantity: { state: QUANTITY_STATE.OK, value: 1 }, review: 'current', issues: [] }
    expect(isTotalable(ok)).toBe(true)
    expect(isTotalable({ ...ok, review: 'needs_review' })).toBe(false)
    expect(isTotalable({ ...ok, issues: [SUMMARY_ISSUE.NEEDS_REVIEW] })).toBe(false)
    expect(isTotalable({ ...ok, quantity: { state: QUANTITY_STATE.UNCALIBRATED, value: null } })).toBe(false)
    expect(isTotalable({ ...ok, quantity: { state: QUANTITY_STATE.INVALID, value: null } })).toBe(false)
    expect(isTotalable(null)).toBe(false)
    expect(kindTotals([{ m: { kind: 'area' }, ...ok, review: 'needs_review' }]).area.count).toBe(0)
    expect(kindTotals([{ m: { kind: 'area' }, ...ok }]).area).toMatchObject({ count: 1, total: 1 })
  })
})

// ── 3. Readiness ─────────────────────────────────────────────────────────────

describe('readiness — loading and failed subscriptions are never "no issues"', () => {
  const ok = { loading: false, error: false }
  it('unavailable beats loading beats ready', () => {
    expect(summaryReadiness({ a: ok, b: ok })).toBe(SUMMARY_READINESS.READY)
    expect(summaryReadiness({ a: ok, b: { loading: true, error: false } })).toBe(SUMMARY_READINESS.LOADING)
    expect(summaryReadiness({ a: { loading: true, error: false }, b: { loading: false, error: true } })).toBe(SUMMARY_READINESS.UNAVAILABLE)
    expect(summaryReadiness({})).toBe(SUMMARY_READINESS.READY)
  })
  it('the view renders counts, totals and lists only when READY, and says loading / unavailable otherwise', () => {
    const view = stripComments(read('pages/project/quant/TakeoffSummary.jsx'))
    expect(view).toContain("const loading = readiness === SUMMARY_READINESS.LOADING")
    expect(view).toContain("const unavailable = readiness === SUMMARY_READINESS.UNAVAILABLE")
    expect(view).toMatch(/\{loading && <p role="status"/)
    expect(view).toMatch(/\{unavailable && \(\s*<p role="alert"/)
    expect(view).toMatch(/not &quot;no measurements&quot; and not &quot;no issues&quot;/)
    expect(view).toMatch(/\{ready && \(\s*<>\s*<Card padding=\{false\}>/)
    // The workspace feeds every source's loading/error flags.
    const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
    expect(workspace).toMatch(/const summaryState = summaryReadiness\(\{\s*measurements: \{ loading: takeoffMeasurementsLoading, error: takeoffMeasurementsError \},\s*pages:\s+\{ loading: takeoffPagesLoading,\s+error: takeoffPagesError \},\s*drawings:\s+\{ loading: drawingsLoading,\s+error: drawingsError \},\s*boq:\s+\{ loading: boqItemsLoading,\s+error: boqItemsError \},\s*\}\)/)
  })
})

// ── 4. Navigation targets ────────────────────────────────────────────────────

describe('traceability — a measurement opens its own sheet, or is explained', () => {
  it('a live measurement on a register drawing yields its exact target', () => {
    expect(measurementTarget(m({ id: 'x' }), { drawings: [drawing()] })).toEqual({ ok: true, drawingId: 'd1', revisionId: 'r2', page: 1, measurementId: 'x' })
  })
  it('void, missing drawing, withdrawn drawing and unreadable identity are explained, never navigated', () => {
    expect(measurementTarget(m({ status: 'void' }), { drawings: [drawing()] })).toMatchObject({ ok: false, problem: TARGET_PROBLEM.VOID })
    expect(measurementTarget(m(), { drawings: [] })).toMatchObject({ ok: false, problem: TARGET_PROBLEM.DRAWING_MISSING })
    expect(measurementTarget(m(), { drawings: [drawing({ status: 'withdrawn' })] })).toMatchObject({ ok: false, problem: TARGET_PROBLEM.DRAWING_WITHDRAWN })
    expect(measurementTarget({ id: 'z', status: 'active', drawingId: 7 }, { drawings: [drawing()] })).toMatchObject({ ok: false, problem: TARGET_PROBLEM.UNREADABLE })
    expect(measurementTarget(null)).toMatchObject({ ok: false })
    for (const r of Object.values(TARGET_PROBLEM)) expect(measurementTarget(m({ status: r === 'void' ? 'void' : 'active' }), { drawings: [] }).message).toBeTruthy()
  })
  it('revisionLabel names what it can prove: the current code from the master, a loaded revision\'s code and status, else the id tail', () => {
    const d = drawing()
    expect(revisionLabel(m(), d)).toBe('Rev B · current')
    expect(revisionLabel(m({ revisionId: 'r1' }), d)).toBe('Revision …r1 · earlier revision')
    const revs = new Map([['r1', { id: 'r1', revisionCode: 'A', status: 'superseded' }], ['r0', { id: 'r0', revisionCode: 'P1', status: 'withdrawn' }]])
    expect(revisionLabel(m({ revisionId: 'r1' }), d, revs)).toBe('Rev A · superseded')
    expect(revisionLabel(m({ revisionId: 'r0' }), d, revs)).toBe('Rev P1 · withdrawn')
    expect(revisionLabel(m(), null)).toBe('Revision …r2 · drawing missing')
    expect(revisionLabel(m(), drawing({ status: 'withdrawn' }))).toBe('Rev B · drawing withdrawn')
  })
  it('measuredAt is the document\'s own Firestore Timestamp or null — never invented', () => {
    expect(measuredAt(m())).toBeTruthy()
    expect(measuredAt(m({ createdAt: { seconds: 1 } }))).toBeNull()
    expect(measuredAt(m({ createdAt: null }))).toBeNull()
    expect(measuredAt(null)).toBeNull()
  })
})

// ── 5. The remembered selection's optional measurementId ────────────────────

describe('remembered selection — optional measurementId, per project, intent only', () => {
  const mem = () => { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map } }
  it('is written and read back only when present; entries without it parse exactly as before', () => {
    const s = mem()
    writeSelection(s, 'p1', { drawingId: 'd1', revisionId: 'r2', page: 1, measurementId: 'm9' })
    expect(readSelection(s, 'p1')).toEqual({ drawingId: 'd1', revisionId: 'r2', page: 1, measurementId: 'm9' })
    writeSelection(s, 'p1', { drawingId: 'd1', revisionId: 'r2', page: 1, measurementId: null })
    expect(readSelection(s, 'p1')).toEqual({ drawingId: 'd1', revisionId: 'r2', page: 1 })
    expect(parseSavedSelection(JSON.stringify({ v: SELECTION_VERSION, drawingId: 'd', measurementId: 'a/b' }))).toEqual({ drawingId: 'd', revisionId: null, page: 1 })
    expect(parseSavedSelection(JSON.stringify({ v: SELECTION_VERSION, drawingId: 'd', measurementId: 42 }))).toEqual({ drawingId: 'd', revisionId: null, page: 1 })
  })
  it('projects stay isolated: one project\'s target never appears in another', () => {
    const s = mem()
    writeSelection(s, 'A', { drawingId: 'd1', revisionId: 'r2', page: 1, measurementId: 'mA' })
    writeSelection(s, 'B', { drawingId: 'd2', revisionId: 'r3', page: 2 })
    expect(readSelection(s, 'A').measurementId).toBe('mA')
    expect(readSelection(s, 'B').measurementId).toBeUndefined()
  })
})

// ── 6. Structure pins ────────────────────────────────────────────────────────

describe('structure — one navigation mechanism, read-only, protections intact', () => {
  const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
  const boqPage = stripComments(read('pages/project/ProjectBoq.jsx'))
  const modal = stripComments(read('pages/project/boq/BoqQuantityApplyModal.jsx'))
  const view = stripComments(read('pages/project/quant/TakeoffSummary.jsx'))

  it('the summary is a VIEW on the Quant tab over the subscriptions already mounted — no new hook, tab or route', () => {
    expect(workspace).toContain("const [view, setView] = useState('measure')")
    expect(workspace).toContain('const projectSummary = summariseTakeoff({ measurements: takeoffMeasurements, takeoffPages, drawings, costCodes, boqItems, revisions })')
    expect(workspace).toMatch(/\{view === 'summary' && \(\s*<TakeoffSummary/)
    expect(workspace).toContain("<div className={view === 'summary' ? 'hidden' : 'flex flex-col gap-3.5'}>")
    expect(view).not.toMatch(/useTakeoff|useDrawings\(|useCostCodes\(|useBoqItems|onSnapshot|firebase/)
    expect(read('lib/projectTabs.js')).not.toMatch(/summary/i)
    expect(read('App.jsx')).not.toMatch(/quant\/summary|TakeoffSummary/)
  })

  it('"Open" validates the target first and moves the selection with the same discard confirmation as the picker', () => {
    expect(workspace).toMatch(/const openMeasurement = \(m\) => \{\s*const result = measurementTarget\(m, \{ drawings \}\)\s*if \(!result\.ok\) \{ setNotice\(\{ tone: 'error', text: result\.message \}\); setView\('measure'\); return \}\s*openTarget\(result\)/)
    expect(workspace).toMatch(/const openTarget = \(t\) => \{[\s\S]*?if \(!samePage\) \{\s*if \(!confirmDiscard\(\)\) return\s*resetDrafts\(\)\s*setDrawingChoice\(t\.drawingId\)\s*setRevisionChoice\(t\.revisionId\)\s*setPageChoice\(t\.page\)/)
    expect(workspace).toContain("setSelectedId(t.measurementId ?? null)")
    expect(workspace).toContain("setView('measure')")
    // The target is resolved as the records settle, from a microtask, and explained when unreachable.
    expect(workspace).toContain("if (drawingsSettled && drawingChoice === target.drawingId && !drawing) {")
    expect(workspace).toContain("} else if (drawing && revisionsSettled && revisionChoice === target.revisionId && !chosen) {")
    expect(workspace).toContain("if (!m) outcome = { tone: 'error', text: 'That measurement no longer exists on this sheet")
    expect(workspace).toMatch(/else if \(m\.status !== MEASUREMENT_STATUS\.ACTIVE\) outcome = \{ tone: 'error'/)
    expect(workspace).toMatch(/Promise\.resolve\(\)\.then\(\(\) => \{\s*if \(cancelled\) return\s*setNotice\(outcome\)/)
    // Measurability, the banner and the transactions are untouched by any of this.
    expect(workspace).toContain('const measurable = !!identity && !!geometry && sheetLive && canWrite')
    expect(workspace).not.toMatch(/saved\?\.measurementId[^\n]*(measurable|sheetLive|canMeasure)/)
  })

  it('the remembered selection carries the target: the workspace starts from it, the BOQ page writes it and navigates with the app router', () => {
    expect(workspace).toContain('const [selectedId, setSelectedId] = useState(saved?.measurementId ?? null)')
    expect(workspace).toMatch(/const \[target, setTarget\] = useState\(saved\?\.measurementId\s*\? \{ drawingId: saved\.drawingId, revisionId: saved\.revisionId, page: saved\.page, measurementId: saved\.measurementId \}\s*: null\)/)
    expect(boqPage).toContain("import { writeSelection } from '../../lib/quantSelection'")
    expect(boqPage).toMatch(/const openInQuant = \(row\) => \{[\s\S]*?writeSelection\(typeof window !== 'undefined' \? window\.sessionStorage : null, projectId, \{\s*drawingId: m\.drawingId, revisionId: m\.revisionId, page: m\.page, measurementId: m\.id,\s*\}\)\s*setApplying\(null\)\s*navigate\(`\/projects\/\$\{projectId\}\/quant`\)/)
    expect(boqPage).toContain('onOpenInQuant={openInQuant}')
    expect(modal).toContain('onOpenInQuant && row.drawing && (')
    expect(modal).toContain('onClick={() => onOpenInQuant(row)}')
    expect(modal).toContain('Open in Quant →')
    // No second router, no new dependency, nothing written to Firestore by the hand-off.
    expect(boqPage).not.toMatch(/createBrowserRouter|window\.location\.(assign|href =)/)
    expect(workspace).not.toMatch(/useNavigate|window\.location/)
  })

  it('the BOQ review-and-apply workflow is unchanged: the apply write, the fingerprint and the readiness gates', () => {
    expect(modal).toContain("await onApply(item, { quantity: aggregate.total, measurementCount: aggregate.eligible.length, evidence })")
    expect(modal).toContain('const evidence = evidenceFingerprint(aggregate)')
    expect(modal).toContain('const canApply = readiness.canApply && confirmed && !saving')
    expect(read('lib/boqActions.js')).not.toMatch(/quantSummary|quantSelection/)
    expect(read('lib/quantBoq.js')).not.toMatch(/quantSummary|quantSelection/)
    expect(read('lib/quantSummary.js')).not.toMatch(/boqLineAmount|rate\b|amount\b|formatCurrency|roundMoney|from 'firebase/)
  })

  it('drafts are per sheet, so opening another source never discards the unsaved work on the sheet you left', () => {
    expect(read('lib/quantDraft.js')).toContain("export const draftStorageKey = (projectId, pageId) => `${projectPrefix(projectId)}${pageId}`")
    expect(workspace).toContain('const samePage = t.drawingId === drawingId && t.revisionId === revisionId && t.page === page')
    expect(workspace).toMatch(/\{otherDrafts\.length > 0 && \(/)
    expect(workspace).toContain('Unsaved work on {otherDrafts.length === 1 ? \'another sheet\' : `${otherDrafts.length} other sheets`} is remembered:')
    expect(workspace).toContain("Unsaved work on the current sheet is kept while you review.")
  })

  it('the measured date is shown only from a real timestamp, in the list and in the summary rows', () => {
    const list = stripComments(read('pages/project/quant/MeasurementList.jsx'))
    expect(list).toContain('measured: measuredAt(m) ? formatDate(measuredAt(m)) : null,')
    expect(list.match(/\{measured && /g)).toHaveLength(1)
    expect(view).toContain('{row.measuredAt && <span className="block text-[11px] font-normal text-brand-muted">Measured {formatDate(row.measuredAt)}</span>}')
    expect(read('lib/quantSummary.js')).toContain("m?.createdAt && typeof m.createdAt.toDate === 'function' ? m.createdAt : null")
  })

  it('no Quant file gained a Firestore write, a financial import or a BOQ write; the summary module is pure', () => {
    const dir = fileURLToPath(new URL('../../src/pages/project/quant/', import.meta.url))
    const FORBIDDEN = /updateBoqItem|createBoqItem|voidBoqItem|applyBoqQuantity|boqActions|useBudgetLines|formatCurrency|roundMoney|\bsetDoc\(|\bupdateDoc\(|\baddDoc\(|\bdeleteDoc\(|\brunTransaction\(/
    for (const f of readdirSync(dir)) expect(stripComments(read(`pages/project/quant/${f}`)), f).not.toMatch(FORBIDDEN)
    const lib = stripComments(read('lib/quantSummary.js'))
    expect(lib).not.toMatch(/from 'react|from 'firebase|setDoc|updateDoc|runTransaction/)
    expect(lib).toMatch(/^import \{[\s\S]*?\} from '\.\/quant'$/m)
    expect(lib).toContain("import { measurementLinkState, LINK_STATE } from './quantBoq'")
    expect(lib).toContain("import { isWithdrawnDrawing, isSupersededRevision, isWithdrawnRevision } from './drawings'")
  })

  it('every summary action is a real ≥44px button; tables scroll inside their container; cards below md', () => {
    expect(view).toMatch(/const openBtnCls = 'inline-flex min-h-\[44px\]/)
    expect(view.match(/className=\{openBtnCls\}/g).length).toBeGreaterThanOrEqual(3)
    expect(view).toContain('<div className="hidden md:block overflow-x-auto">')
    expect(view).toContain('<div className="md:hidden flex flex-col">')
    expect(view).not.toMatch(/style=\{\{/)
  })

  it('the classifier is the single judgement: the view sums nothing and derives nothing', () => {
    expect(view).not.toMatch(/measurementQuantity|polygonArea|polylineLength|\+=|reduce\(/)
    expect(classifyMeasurement(m(), { pagesById: new Map([['d1_r2_1', page()]]), drawingsById: new Map([['d1', drawing()]]), boqItems: [item()] }).category).toBe(SUMMARY_CATEGORY.CURRENT)
  })
})
