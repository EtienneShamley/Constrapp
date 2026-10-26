import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  QUANTITY_STATE, QUANTITY_PROBLEM, QUANTITY_PROBLEM_LABELS, DEDUCTION_PROBLEM,
  MAX_DEDUCTIONS, DEDUCTION_MAX_POINTS, DEDUCTION_ID_MAX, MAX_POINTS,
  isDeduction, isDeductionList, measurementDeductions, hasDeductions,
  boundingBox, segmentsCross, pointOnPolygonBoundary, pointInOrOnPolygon, segmentWithinPolygon, polygonWithinPolygon, polygonsDisjoint,
  deductionsProblem, measurementQuantity, originalQuantity, quantityIssue, quantityBreakdown, roundQuantity, formatMeasurementQuantity,
  validateDeductionLabel, validateDeductionPoints, validateDeductions, newDeductionId, withDeduction, withoutDeduction,
  isReadableMeasurement, summariseMeasurements, calibrationReviewState, CALIBRATION_REVIEW, buildCalibration, calibrationSnapshot,
  areaPathWithHoles, holesPath, hitTestMeasurements, QUANT_ERROR,
} from '../../src/lib/quant.js'
import { QuantError, runCreateMeasurement, runUpdateMeasurement, runVoidMeasurement, runSaveCalibration } from '../../src/lib/quantActions.js'
import {
  aggregateLinkedQuantity, applyReadiness, evidenceFingerprint, evidenceRowKey, EVIDENCE_VERSION, APPLY_BLOCKER, quantAppliedState, QUANT_APPLIED_STATE, evidenceKey,
} from '../../src/lib/quantBoq.js'
import { summariseTakeoff, classifyMeasurement, kindTotals, emptyKindTotals, SUMMARY_CATEGORY, SUMMARY_ISSUE } from '../../src/lib/quantSummary.js'
import { parseSavedDraft, writeDraft, readDraft, restorableDraft, DRAFT_VERSION } from '../../src/lib/quantDraft.js'

// ── Constrapp Quant™ 1D — manual opening and void deductions (ADR-54) ────────
//
// Pure tests over the deduction geometry (containment, disjointness,
// concavity, touching), the NET derivation through the one existing
// measurementQuantity, validation, the guarded update against the in-memory
// Firestore stand-in (stale writes, server-copy validation, no snapshot
// change), draft memory, the page and project summaries, the BOQ aggregate,
// the fingerprint's backward compatibility — plus source pins over the rules,
// the overlay, the list, the dialog and the workspace. Plain Node, no jsdom.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const readRoot = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const P = (x, y) => ({ x, y })
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const CAL = buildCalibration({ pointA: P(0, 0), pointB: P(100, 0), realDistance: 1, unit: 'm' }) // 100 units = 1 m
const SNAP = { revision: 1, pageDistance: 100, realDistance: 1, unit: 'm' }
const TS = (seconds) => ({ seconds, nanoseconds: 0, toDate: () => new Date(seconds * 1000) })

// The brief's example: a 30 m² slab (5 m × 6 m) with a 2 m² door and a 3 m² window.
const SLAB   = [P(0, 0), P(500, 0), P(500, 600), P(0, 600)]           // 30 m²
const DOOR   = { id: 'door',   label: 'Door D01',   points: [P(50, 50), P(150, 50), P(150, 250), P(50, 250)] }     // 1 m × 2 m = 2 m²
const WINDOW = { id: 'window', label: 'Window W01', points: [P(300, 100), P(450, 100), P(450, 300), P(300, 300)] } // 1.5 m × 2 m = 3 m²
const rect = (id, x0, y0, x1, y1, label = id) => ({ id, label, points: [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)] })

const area = (overrides = {}) => ({
  id: 'slab', takeoffPageId: 'd1_r2_1', drawingId: 'd1', revisionId: 'r2', page: 1,
  kind: 'area', points: SLAB, label: 'Slab GF', costCodeId: 'cc1', costCodeName: '04-100 — Formwork',
  calibration: SNAP, boqItemId: 'b1', status: 'active', voidReason: '', voidedAt: null, voidedBy: null,
  revision: 1, createdAt: TS(1), createdBy: 'u1', updatedAt: TS(1), updatedBy: 'u1',
  ...overrides,
})
const withHoles = (...holes) => area({ deductions: holes })

// ── 1. Geometry primitives ───────────────────────────────────────────────────

describe('geometry — containment, disjointness, concavity, touching', () => {
  it('segmentsCross is PROPER only: touching at an endpoint or running along is not a crossing', () => {
    expect(segmentsCross(P(0, 0), P(2, 2), P(0, 2), P(2, 0))).toBe(true)
    expect(segmentsCross(P(0, 0), P(2, 0), P(1, 0), P(1, 2))).toBe(false) // T-touch
    expect(segmentsCross(P(0, 0), P(2, 0), P(1, 0), P(3, 0))).toBe(false) // collinear overlap
    expect(segmentsCross(P(0, 0), P(2, 0), P(2, 0), P(2, 2))).toBe(false) // shared endpoint
  })

  it('a point on an edge is "in or on"; even-odd alone would be unreliable there', () => {
    expect(pointOnPolygonBoundary(SLAB, P(250, 0))).toBe(true)
    expect(pointInOrOnPolygon(SLAB, P(250, 0))).toBe(true)
    expect(pointInOrOnPolygon(SLAB, P(250, 300))).toBe(true)
    expect(pointInOrOnPolygon(SLAB, P(250, -1))).toBe(false)
    expect(boundingBox(SLAB)).toEqual({ minX: 0, minY: 0, maxX: 500, maxY: 600 })
  })

  it('polygonWithinPolygon: inside passes, touching the parent boundary passes, straddling fails', () => {
    expect(polygonWithinPolygon(DOOR.points, SLAB)).toBe(true)
    expect(polygonWithinPolygon(rect('flush', 0, 0, 100, 200).points, SLAB)).toBe(true)        // flush with two edges (a door at the floor line)
    expect(polygonWithinPolygon(rect('out', -10, 0, 100, 200).points, SLAB)).toBe(false)       // sticks out on the left
    expect(polygonWithinPolygon(rect('bigger', -10, -10, 510, 610).points, SLAB)).toBe(false) // contains the parent
    expect(polygonWithinPolygon(SLAB, SLAB)).toBe(true)                                         // identical: all on the boundary (then refused by area)
  })

  it('CONCAVE parent: a hole in the notch is outside even when every vertex is on the boundary; one in an arm is inside', () => {
    // A U: arms x∈[0,2] and x∈[4,6], base y∈[0,2], gap x∈(2,4), y∈(2,6).
    const U = [P(0, 0), P(6, 0), P(6, 6), P(4, 6), P(4, 2), P(2, 2), P(2, 6), P(0, 6)]
    expect(polygonWithinPolygon([P(0.5, 3), P(1.5, 3), P(1.5, 5), P(0.5, 5)], U)).toBe(true)  // inside the left arm
    expect(polygonWithinPolygon([P(2.5, 3), P(3.5, 3), P(3.5, 5), P(2.5, 5)], U)).toBe(false) // in the gap: vertices outside
    // The regression: every vertex ON the U's boundary, no proper crossing, yet the triangle lies in the gap.
    expect(polygonWithinPolygon([P(2, 5), P(4, 5), P(4, 3)], U)).toBe(false)
    expect(segmentWithinPolygon(P(2, 5), P(4, 5), U)).toBe(false)   // the chord across the notch
    expect(segmentWithinPolygon(P(0.5, 3), P(1.5, 5), U)).toBe(true)
    // An edge that leaves and re-enters (across the gap, arm to arm) is a proper crossing.
    expect(polygonWithinPolygon([P(1, 3), P(5, 3), P(5, 5), P(1, 5)], U)).toBe(false)
    // A hole spanning the base under the gap is fine: it never leaves.
    expect(polygonWithinPolygon([P(1, 0.5), P(5, 0.5), P(5, 1.5), P(1, 1.5)], U)).toBe(true)
  })

  it('polygonsDisjoint: apart passes; touching, crossing, nested, identical and partially overlapping fail', () => {
    expect(polygonsDisjoint(DOOR.points, WINDOW.points)).toBe(true)
    expect(polygonsDisjoint(rect('a', 0, 0, 2, 1).points, rect('b', 2, 0, 4, 1).points)).toBe(false)   // shared edge (touching)
    expect(polygonsDisjoint(rect('a', 0, 0, 2, 1).points, rect('b', 2, 1, 4, 2).points)).toBe(false)   // shared corner
    expect(polygonsDisjoint(rect('a', 0, 0, 2, 1).points, rect('b', 1, 0, 3, 1).points)).toBe(false)   // collinear partial overlap — the double-deduction case
    expect(polygonsDisjoint(rect('a', 0, 0, 4, 4).points, rect('b', 1, 1, 2, 2).points)).toBe(false)   // nested
    expect(polygonsDisjoint(DOOR.points, DOOR.points)).toBe(false)                                       // identical
    expect(polygonsDisjoint(rect('a', 0, 1, 3, 2).points, rect('b', 1, 0, 2, 3).points)).toBe(false)   // a plus sign: crossing, no vertex inside
    expect(polygonsDisjoint(rect('a', 0, 0, 1, 1).points, rect('b', 1.0001, 0, 2, 1).points)).toBe(true) // a hairline gap is apart
  })
})

// ── 2. The deduction set ─────────────────────────────────────────────────────

describe('deductionsProblem — the rules of a valid set, with the offender named', () => {
  it('the brief: door and window inside the slab are a valid set', () => {
    expect(deductionsProblem(SLAB, [DOOR, WINDOW])).toBeNull()
    expect(deductionsProblem(SLAB, [])).toBeNull()
    expect(deductionsProblem(SLAB, undefined)).toBeNull()
  })

  it('a self-crossing or collapsed hole is INVALID; one leaving the parent is OUTSIDE; touching the parent is fine', () => {
    const bowtie = { id: 'x', label: 'x', points: [P(10, 10), P(30, 30), P(30, 10), P(10, 30)] }
    expect(deductionsProblem(SLAB, [bowtie])).toEqual({ problem: DEDUCTION_PROBLEM.INVALID, deductionIds: ['x'] })
    const flat = { id: 'f', label: 'f', points: [P(10, 10), P(20, 10), P(30, 10)] }
    expect(deductionsProblem(SLAB, [flat]).problem).toBe(DEDUCTION_PROBLEM.INVALID)
    expect(deductionsProblem(SLAB, [DOOR, rect('out', 450, 500, 550, 650)])).toEqual({ problem: DEDUCTION_PROBLEM.OUTSIDE, deductionIds: ['out'] })
    expect(deductionsProblem(SLAB, [rect('flush', 0, 0, 100, 200)])).toBeNull()
  })

  it('overlapping, nested, touching and duplicate holes are OVERLAP, both named; duplicate ids and junk are MALFORMED', () => {
    expect(deductionsProblem(SLAB, [DOOR, rect('o', 100, 100, 200, 300)])).toEqual({ problem: DEDUCTION_PROBLEM.OVERLAP, deductionIds: ['door', 'o'] })
    expect(deductionsProblem(SLAB, [DOOR, rect('n', 60, 60, 90, 90)]).problem).toBe(DEDUCTION_PROBLEM.OVERLAP)
    expect(deductionsProblem(SLAB, [DOOR, rect('t', 150, 50, 250, 250)]).problem).toBe(DEDUCTION_PROBLEM.OVERLAP)
    expect(deductionsProblem(SLAB, [DOOR, { ...DOOR, id: 'dup-geometry' }]).problem).toBe(DEDUCTION_PROBLEM.OVERLAP)
    expect(deductionsProblem(SLAB, [DOOR, { ...WINDOW, id: 'door' }])).toEqual({ problem: DEDUCTION_PROBLEM.MALFORMED, deductionIds: ['door'] })
    expect(deductionsProblem(SLAB, [DOOR, { id: 'bad', label: 'bad', points: [P(1, 1), { x: 'a', y: 2 }, P(3, 3)] }])).toEqual({ problem: DEDUCTION_PROBLEM.MALFORMED, deductionIds: ['bad'] })
    expect(deductionsProblem(SLAB, ['junk']).problem).toBe(DEDUCTION_PROBLEM.MALFORMED)
    expect(deductionsProblem(SLAB, [{ id: 'many', label: 'm', points: Array.from({ length: DEDUCTION_MAX_POINTS + 1 }, (_, i) => P(10 + i, 10 + (i % 2))) }]).problem).toBe(DEDUCTION_PROBLEM.MALFORMED)
  })

  it('the holes together may not equal or exceed the gross area', () => {
    expect(deductionsProblem(SLAB, [{ id: 'all', label: 'all', points: SLAB }])).toEqual({ problem: DEDUCTION_PROBLEM.EXCEED_AREA, deductionIds: ['all'] })
    const halves = [rect('h1', 0, 0, 500, 300), rect('h2', 0, 300.001, 500, 600)]  // just short of everything
    expect(deductionsProblem(SLAB, halves)).toBeNull()
  })

  it('shape helpers: isDeduction, isDeductionList (≤ 50, distinct ids), measurementDeductions on legacy records', () => {
    expect(isDeduction(DOOR)).toBe(true)
    expect(isDeduction({ ...DOOR, id: '' })).toBe(false)
    expect(isDeduction({ ...DOOR, id: 'x'.repeat(DEDUCTION_ID_MAX + 1) })).toBe(false)
    expect(isDeduction({ ...DOOR, label: 7 })).toBe(false)
    expect(isDeduction({ ...DOOR, points: [P(0, 0), P(NaN, 1), P(1, 1)] })).toBe(false)
    expect(isDeductionList(undefined)).toBe(true)
    expect(isDeductionList([])).toBe(true)
    expect(isDeductionList([DOOR, WINDOW])).toBe(true)
    expect(isDeductionList([DOOR, { ...WINDOW, id: 'door' }])).toBe(false)
    expect(isDeductionList(Array.from({ length: MAX_DEDUCTIONS + 1 }, (_, i) => rect(`d${i}`, i, 0, i + 0.5, 1)))).toBe(false)
    expect(isDeductionList('nope')).toBe(false)
    expect(measurementDeductions(area())).toEqual([])
    expect(hasDeductions(area())).toBe(false)
    expect(hasDeductions(withHoles(DOOR))).toBe(true)
    expect(MAX_DEDUCTIONS).toBe(50)
    expect(DEDUCTION_MAX_POINTS).toBe(100)
    expect(DEDUCTION_MAX_POINTS).toBeLessThan(MAX_POINTS)
  })
})

// ── 3. The NET derivation ────────────────────────────────────────────────────

describe('measurementQuantity — gross − deductions = net, through the one derivation', () => {
  it('30 − 2 − 3 = 25 m²: value IS the net; gross and deducted ride alongside for display', () => {
    const q = measurementQuantity(withHoles(DOOR, WINDOW), CAL)
    expect(q.state).toBe(QUANTITY_STATE.OK)
    expect(near(q.value, 25)).toBe(true)
    expect(near(q.gross, 30)).toBe(true)
    expect(near(q.deducted, 5)).toBe(true)
    expect(q.deductionCount).toBe(2)
    expect(q.unit).toBe('m²')
    expect(quantityBreakdown(q)).toEqual({ gross: '30 m²', deducted: '5 m²', net: '25 m²', count: 2 })
    expect(formatMeasurementQuantity(q)).toBe('25 m²')
  })

  it('a legacy area without the key derives EXACTLY as before — same shape, no breakdown keys', () => {
    const q = measurementQuantity(area(), CAL)
    expect(q).toEqual({ value: 30, unit: 'm²', state: QUANTITY_STATE.OK })
    expect(quantityBreakdown(q)).toBeNull()
    expect(measurementQuantity(area({ deductions: [] }), CAL)).toEqual({ value: 30, unit: 'm²', state: QUANTITY_STATE.OK })
  })

  it('the net is unrounded and scaled through the calibration like everything else (mm stated scale, re-calibration)', () => {
    const mm = buildCalibration({ pointA: P(0, 0), pointB: P(100, 0), realDistance: 1000, unit: 'mm' })
    expect(near(measurementQuantity(withHoles(DOOR, WINDOW), mm).value, 25)).toBe(true)
    const half = buildCalibration({ pointA: P(0, 0), pointB: P(50, 0), realDistance: 1, unit: 'm' }) // 50 units = 1 m → every area ×4
    expect(near(measurementQuantity(withHoles(DOOR, WINDOW), half).value, 100)).toBe(true)
    const odd = withHoles(rect('t', 0, 0, 123.456, 100))
    expect(measurementQuantity(odd, CAL).value).toBeCloseTo(30 - 1.23456, 10)
  })

  it('a zero, negative or sub-precision net is INVALID (deductions_exceed_area), never a number', () => {
    const all = withHoles({ id: 'all', label: 'all', points: SLAB })
    const q = measurementQuantity(all, CAL)
    expect(q.state).toBe(QUANTITY_STATE.INVALID)
    expect(q.reason).toBe(QUANTITY_PROBLEM.DEDUCTIONS_EXCEED_AREA)
    expect(q.value).toBeNull()
    // Two holes leaving a sliver that rounds to 0.000 m² at BOQ precision.
    const sliver = withHoles(rect('h1', 0, 0, 500, 300), rect('h2', 0, 300.0001, 500, 600)) // 0.0005 m² left
    const s = measurementQuantity(sliver, CAL)
    expect(roundQuantity(500 * 0.0001 / 10000)).toBe(0)
    expect(s.state).toBe(QUANTITY_STATE.INVALID)
    expect(s.reason).toBe(QUANTITY_PROBLEM.DEDUCTIONS_EXCEED_AREA)
    // …whereas a sliver that survives rounding is a (tiny) number.
    const ok = withHoles(rect('h1', 0, 0, 500, 300), rect('h2', 0, 301, 500, 600)) // 0.05 m² left
    expect(roundQuantity(measurementQuantity(ok, CAL).value)).toBe(0.05)
  })

  it('every deduction problem derives as INVALID with its reason, its label and the offending ids; uncalibrated stays uncalibrated', () => {
    const outside = withHoles(DOOR, rect('out', 450, 500, 550, 650))
    const q = measurementQuantity(outside, CAL)
    expect(q).toMatchObject({ value: null, state: QUANTITY_STATE.INVALID, reason: QUANTITY_PROBLEM.DEDUCTION_OUTSIDE, deductionIds: ['out'] })
    expect(quantityIssue(q)).toBe(QUANTITY_PROBLEM_LABELS[QUANTITY_PROBLEM.DEDUCTION_OUTSIDE])
    expect(measurementQuantity(withHoles(DOOR, rect('o', 100, 100, 200, 300)), CAL).reason).toBe(QUANTITY_PROBLEM.DEDUCTIONS_OVERLAP)
    expect(measurementQuantity(withHoles({ id: 'x', label: 'x', points: [P(10, 10), P(30, 30), P(30, 10), P(10, 30)] }), CAL).reason).toBe(QUANTITY_PROBLEM.DEDUCTION_INVALID)
    expect(measurementQuantity(withHoles('junk'), CAL).reason).toBe(QUANTITY_PROBLEM.DEDUCTION_MALFORMED)
    // Geometry problems are reported BEFORE the calibration question — and a crossed PARENT first of all.
    expect(measurementQuantity(outside, null).reason).toBe(QUANTITY_PROBLEM.DEDUCTION_OUTSIDE)
    expect(measurementQuantity(withHoles(DOOR), null)).toEqual({ value: null, unit: 'm²', state: QUANTITY_STATE.UNCALIBRATED })
    expect(measurementQuantity(area({ points: [P(0, 0), P(4, 0), P(1, 3), P(4, 3)], deductions: [DOOR] }), CAL).reason).toBe(QUANTITY_PROBLEM.SELF_INTERSECTING)
    for (const code of Object.values(DEDUCTION_PROBLEM)) expect(QUANTITY_PROBLEM_LABELS[code]).toBeTruthy()
    // Deductions on a length or count are ignored by the derivation (and unreadable to the app).
    expect(measurementQuantity({ kind: 'length', points: [P(0, 0), P(300, 400)], deductions: [DOOR] }, CAL).value).toBe(5)
  })

  it('re-calibration: the ORIGINAL quantity is the original NET under the recorded snapshot, and the whole measurement needs review', () => {
    const m = withHoles(DOOR, WINDOW)
    const recal = buildCalibration({ pointA: P(0, 0), pointB: P(50, 0), realDistance: 1, unit: 'm' })
    const page = { id: 'd1_r2_1', calibration: recal, calibrationRevision: 2 }
    expect(calibrationReviewState(m, page)).toBe(CALIBRATION_REVIEW.NEEDS_REVIEW)
    expect(near(measurementQuantity(m, page.calibration).value, 100)).toBe(true)
    expect(near(originalQuantity(m).value, 25)).toBe(true)
    expect(near(originalQuantity(m).gross, 30)).toBe(true)
  })
})

// ── 4. Validation ────────────────────────────────────────────────────────────

describe('validation — labels, points, the complete list, ids', () => {
  it('labels are non-blank and bounded; hole outlines are simple areas of ≤ 100 points', () => {
    expect(validateDeductionLabel('')).toMatch(/label/)
    expect(validateDeductionLabel('  ')).toMatch(/label/)
    expect(validateDeductionLabel('x'.repeat(121))).toMatch(/too long/)
    expect(validateDeductionLabel('Door D01')).toBeNull()
    expect(validateDeductionPoints([P(0, 0), P(1, 0)])).toMatch(/at least 3/)
    expect(validateDeductionPoints([P(0, 0), P(2, 2), P(2, 0), P(0, 2)])).toMatch(/crosses itself/)
    expect(validateDeductionPoints(Array.from({ length: 101 }, (_, i) => P(Math.cos(i / 101 * 2 * Math.PI) * 10 + 50, Math.sin(i / 101 * 2 * Math.PI) * 10 + 50)))).toMatch(/max 100/)
    expect(validateDeductionPoints(DOOR.points)).toBeNull()
  })

  it('validateDeductions judges the COMPLETE list against the parent and names the problem in the derivation\'s words', () => {
    expect(validateDeductions(SLAB, [DOOR, WINDOW], CAL)).toBeNull()
    expect(validateDeductions(SLAB, [], CAL)).toBeNull()
    expect(validateDeductions(SLAB, undefined)).toBeNull()
    expect(validateDeductions(SLAB, 'nope')).toMatch(/not valid/)
    expect(validateDeductions(SLAB, [DOOR, { ...WINDOW, id: 'door' }])).toMatch(/same id/)
    expect(validateDeductions(SLAB, [{ ...DOOR, id: '' }])).toMatch(/usable id/)
    expect(validateDeductions(SLAB, [{ ...DOOR, label: ' ' }])).toMatch(/label/)
    expect(validateDeductions(SLAB, [rect('out', 450, 500, 550, 650)])).toBe(QUANTITY_PROBLEM_LABELS[QUANTITY_PROBLEM.DEDUCTION_OUTSIDE])
    expect(validateDeductions(SLAB, [DOOR, rect('o', 100, 100, 200, 300)])).toBe(QUANTITY_PROBLEM_LABELS[QUANTITY_PROBLEM.DEDUCTIONS_OVERLAP])
    expect(validateDeductions(SLAB, [{ id: 'all', label: 'all', points: SLAB }])).toBe(QUANTITY_PROBLEM_LABELS[QUANTITY_PROBLEM.DEDUCTIONS_EXCEED_AREA])
    // With a calibration the sub-precision net is refused too; without one only the canonical comparison stands.
    const sliver = [rect('h1', 0, 0, 500, 300), rect('h2', 0, 300.0001, 500, 600)]
    expect(validateDeductions(SLAB, sliver, CAL)).toBe(QUANTITY_PROBLEM_LABELS[QUANTITY_PROBLEM.DEDUCTIONS_EXCEED_AREA])
    expect(validateDeductions(SLAB, sliver, null)).toBeNull()
    expect(validateDeductions(SLAB, Array.from({ length: 51 }, (_, i) => rect(`d${i}`, i * 9, 10, i * 9 + 5, 20)))).toMatch(/max 50/)
    // Fifty small holes in a 5 × 6 m slab are fine.
    expect(validateDeductions(SLAB, Array.from({ length: 50 }, (_, i) => rect(`d${i}`, (i % 10) * 50 + 5, Math.floor(i / 10) * 50 + 5, (i % 10) * 50 + 40, Math.floor(i / 10) * 50 + 40)), CAL)).toBeNull()
  })

  it('ids are fresh and distinct; withDeduction adds or replaces in place; withoutDeduction removes by id', () => {
    const id = newDeductionId(['door', 'window'])
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(id.length).toBeLessThanOrEqual(DEDUCTION_ID_MAX)
    expect(['door', 'window']).not.toContain(id)
    expect(newDeductionId()).not.toBe(newDeductionId())
    expect(withDeduction([DOOR], WINDOW)).toEqual([DOOR, WINDOW])
    expect(withDeduction([DOOR, WINDOW], { ...DOOR, label: 'Door D01 (revised)' })).toEqual([{ ...DOOR, label: 'Door D01 (revised)' }, WINDOW])
    expect(withDeduction(undefined, DOOR)).toEqual([DOOR])
    expect(withoutDeduction([DOOR, WINDOW], 'door')).toEqual([WINDOW])
    expect(withoutDeduction(undefined, 'door')).toEqual([])
  })

  it('readability: a list on an area stays readable (a bad hole is NAMED, not hidden); holes on a length, or a non-list, are unreadable', () => {
    expect(isReadableMeasurement(area())).toBe(true)
    expect(isReadableMeasurement(withHoles(DOOR))).toBe(true)
    expect(isReadableMeasurement(withHoles('junk'))).toBe(true)       // visible, named deduction_malformed, removable
    expect(isReadableMeasurement(area({ deductions: 'junk' }))).toBe(false)
    expect(isReadableMeasurement(area({ kind: 'length', points: [P(0, 0), P(1, 1)], deductions: [DOOR] }))).toBe(false)
    expect(isReadableMeasurement(area({ kind: 'count', points: [P(0, 0)], calibration: null, deductions: [] }))).toBe(false)
  })

  it('paths: the fill carries the holes (evenodd), the hole outlines are drawn apart; malformed holes are not drawn; hit testing is unchanged', () => {
    expect(areaPathWithHoles(SLAB, [DOOR])).toBe('M0 0 L500 0 L500 600 L0 600 Z M50 50 L150 50 L150 250 L50 250 Z')
    expect(areaPathWithHoles(SLAB, [])).toBe('M0 0 L500 0 L500 600 L0 600 Z')
    expect(holesPath([DOOR, 'junk'])).toBe('M50 50 L150 50 L150 250 L50 250 Z')
    // A tap inside a hole still selects the parent (the hole is part of it).
    expect(hitTestMeasurements([withHoles(DOOR)], P(100, 150), 5)).toBe('slab')
  })
})

// ── 5. Guarded update against the in-memory Firestore stand-in ───────────────

function fakeFirestore() {
  const store = new Map()
  const ref = (path) => ({ path, id: path.split('/').pop() })
  const runTransaction = async (_db, body) => {
    const writes = []
    const tx = {
      get: async (r) => {
        const data = store.get(r.path)
        return { id: r.id, exists: () => data !== undefined, data: () => data }
      },
      set: (r, data) => writes.push(['set', r, data]),
      update: (r, data) => writes.push(['update', r, data]),
    }
    const out = await body(tx)
    for (const [op, r, data] of writes) {
      if (op === 'set') store.set(r.path, data)
      else store.set(r.path, { ...store.get(r.path), ...data })
    }
    return out
  }
  const serverTimestamp = () => ({ __serverTimestamp: true })
  return { db: {}, store, ref, runTransaction, serverTimestamp }
}
const IDENTITY = { drawingId: 'd1', revisionId: 'r2', page: 1 }
const GEOMETRY = { source: 'pdf', pageWidth: 612, pageHeight: 792, pageRotation: 0 }
const PAGE_PATH = 'companies/c/projects/p/takeoffPages/d1_r2_1'
const M_PATH = 'companies/c/projects/p/takeoffMeasurements/slab'

async function seeded() {
  const f = fakeFirestore()
  await runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, draft: { pointA: P(0, 0), pointB: P(100, 0), realDistance: 1, unit: 'm' }, seenPage: null, uid: 'u1' })
  await runCreateMeasurement({
    ...f, pageRef: f.ref(PAGE_PATH), measurementRef: f.ref(M_PATH), identity: IDENTITY, seenPage: { revision: 1 }, uid: 'u1',
    draft: { kind: 'area', points: SLAB, label: 'Slab GF', costCodeId: 'cc1', costCodeName: 'Formwork', boqItemId: 'b1' },
  })
  const seen = () => ({ id: 'slab', ...f.store.get(M_PATH) })
  const update = (args) => runUpdateMeasurement({ ...f, ref: f.ref(M_PATH), uid: 'u2', ...args })
  return { f, seen, update }
}
const expectKind = async (promise, kind, pattern = null) => {
  let caught = null
  try { await promise } catch (err) { caught = err }
  expect(caught).toBeInstanceOf(QuantError)
  expect(caught.kind).toBe(kind)
  if (pattern) expect(caught.message).toMatch(pattern)
}

describe('runUpdateMeasurement — deductions ride the one guarded update', () => {
  it('create writes NO deductions key; the first deduction adds it with revision +1; a second is +1 again; the snapshot and link are untouched', async () => {
    const { f, seen, update } = await seeded()
    expect(Object.keys(f.store.get(M_PATH))).not.toContain('deductions')
    const out = await update({ seen: seen(), changes: { deductions: [{ ...DOOR, label: '  Door D01  ' }] } })
    expect(out).toEqual({ kind: null, revision: 2, linkCleared: false })
    let doc = f.store.get(M_PATH)
    expect(doc.deductions).toEqual([{ id: 'door', label: 'Door D01', points: DOOR.points }])
    expect(doc).toMatchObject({ revision: 2, calibration: SNAP, boqItemId: 'b1', points: SLAB, updatedBy: 'u2', createdBy: 'u1' })
    expect(Object.keys(doc.deductions[0]).sort()).toEqual(['id', 'label', 'points'])
    await update({ seen: seen(), changes: { deductions: withDeduction(doc.deductions, WINDOW) } })
    doc = f.store.get(M_PATH)
    expect(doc.revision).toBe(3)
    expect(doc.deductions.map(d => d.id)).toEqual(['door', 'window'])
    expect(near(measurementQuantity(doc, CAL).value, 25)).toBe(true)
    // Rename, edit outline, remove — each one update, each +1.
    await update({ seen: seen(), changes: { deductions: withDeduction(seen().deductions, { ...DOOR, label: 'Door D01 — revised' }) } })
    expect(f.store.get(M_PATH).deductions[0].label).toBe('Door D01 — revised')
    await update({ seen: seen(), changes: { deductions: withDeduction(seen().deductions, { ...WINDOW, points: rect('w', 300, 100, 400, 300).points }) } })
    expect(near(measurementQuantity(f.store.get(M_PATH), CAL).value, 26)).toBe(true)
    await update({ seen: seen(), changes: { deductions: withoutDeduction(seen().deductions, 'door') } })
    expect(f.store.get(M_PATH)).toMatchObject({ revision: 6, deductions: [{ id: 'window' }] })
    await update({ seen: seen(), changes: { deductions: [] } })
    expect(f.store.get(M_PATH).deductions).toEqual([])
    expect(f.store.get(M_PATH).revision).toBe(7)
  })

  it('invalid sets are refused with the actionable reason: outside, overlapping, exceeding, duplicate id, over the bounds, on a length', async () => {
    const { seen, update } = await seeded()
    await expectKind(update({ seen: seen(), changes: { deductions: [rect('out', 450, 500, 550, 650)] } }), QUANT_ERROR.INVALID, /outside/)
    await expectKind(update({ seen: seen(), changes: { deductions: [DOOR, rect('o', 100, 100, 200, 300)] } }), QUANT_ERROR.INVALID, /overlap/)
    await expectKind(update({ seen: seen(), changes: { deductions: [{ id: 'all', label: 'all', points: SLAB }] } }), QUANT_ERROR.INVALID, /leave no area/)
    await expectKind(update({ seen: seen(), changes: { deductions: [DOOR, { ...WINDOW, id: 'door' }] } }), QUANT_ERROR.INVALID, /same id/)
    await expectKind(update({ seen: seen(), changes: { deductions: 'junk' } }), QUANT_ERROR.INVALID)
    await expectKind(update({ seen: { ...seen(), kind: 'length' }, changes: { deductions: [DOOR] } }), QUANT_ERROR.INVALID, /Only an area/)
    // The sub-precision net is judged under the parent's recorded snapshot.
    await expectKind(update({ seen: seen(), changes: { deductions: [rect('h1', 0, 0, 500, 300), rect('h2', 0, 300.0001, 500, 600)] } }), QUANT_ERROR.INVALID, /leave no area/)
  })

  it('the set is judged against the SERVER outline: a stale copy is STALE, and the server copy decides containment', async () => {
    const { f, seen, update } = await seeded()
    const stale = seen()
    // Another user shrinks the slab underneath (hole still inside).
    await update({ seen: seen(), changes: { points: [P(0, 0), P(500, 0), P(500, 300), P(0, 300)] }, calibration: calibrationSnapshot({ calibration: CAL, calibrationRevision: 1 }) })
    expect(f.store.get(M_PATH).revision).toBe(2)
    await expectKind(update({ seen: stale, changes: { deductions: [DOOR] } }), QUANT_ERROR.STALE)
    expect(f.store.get(M_PATH).deductions).toBeUndefined()
    // Fresh copy: the window (y up to 300) now touches the new bottom edge — still within; a hole below it is outside.
    await update({ seen: seen(), changes: { deductions: [WINDOW] } })
    expect(f.store.get(M_PATH).deductions.map(d => d.id)).toEqual(['window'])
    await expectKind(update({ seen: seen(), changes: { deductions: [WINDOW, rect('below', 50, 350, 150, 450)] } }), QUANT_ERROR.INVALID, /outside/)
  })

  it('moving the PARENT outline is refused when it would strand a hole, and allowed when every hole stays inside', async () => {
    const { f, seen, update } = await seeded()
    await update({ seen: seen(), changes: { deductions: [DOOR, WINDOW] } })
    const snap = calibrationSnapshot({ calibration: CAL, calibrationRevision: 1 })
    await expectKind(update({ seen: seen(), changes: { points: [P(0, 0), P(500, 0), P(500, 200), P(0, 200)] }, calibration: snap }), QUANT_ERROR.INVALID, /outside/)
    expect(f.store.get(M_PATH).points).toEqual(SLAB)
    await update({ seen: seen(), changes: { points: [P(0, 0), P(500, 0), P(500, 400), P(0, 400)] }, calibration: snap })
    expect(f.store.get(M_PATH)).toMatchObject({ revision: 3, points: [P(0, 0), P(500, 0), P(500, 400), P(0, 400)] })
    expect(near(measurementQuantity(f.store.get(M_PATH), CAL).value, 15)).toBe(true)
  })

  it('a deductions change never touches the calibration snapshot — a parent that needs review keeps needing it', async () => {
    const { f, seen, update } = await seeded()
    const recal = { id: 'd1_r2_1', calibration: buildCalibration({ pointA: P(0, 0), pointB: P(50, 0), realDistance: 1, unit: 'm' }), calibrationRevision: 2 }
    expect(calibrationReviewState(seen(), recal)).toBe(CALIBRATION_REVIEW.NEEDS_REVIEW)
    await update({ seen: seen(), changes: { deductions: [DOOR] } })
    expect(f.store.get(M_PATH).calibration).toEqual(SNAP)
    expect(calibrationReviewState(f.store.get(M_PATH), recal)).toBe(CALIBRATION_REVIEW.NEEDS_REVIEW)
    // A label-only edit still leaves the holes and the snapshot alone.
    await update({ seen: seen(), changes: { label: 'Slab GF — east' } })
    expect(f.store.get(M_PATH)).toMatchObject({ label: 'Slab GF — east', deductions: [{ id: 'door' }], calibration: SNAP, revision: 3 })
  })

  it('void keeps the holes as history; a voided parent accepts no deduction change; an invalid stored set is corrected by removal', async () => {
    const { f, seen, update } = await seeded()
    await update({ seen: seen(), changes: { deductions: [DOOR, WINDOW] } })
    // Simulate a direct-SDK write that broke the set (window moved outside).
    f.store.set(M_PATH, { ...f.store.get(M_PATH), deductions: [DOOR, rect('window', 450, 500, 560, 650)] })
    expect(measurementQuantity(f.store.get(M_PATH), CAL).reason).toBe(QUANTITY_PROBLEM.DEDUCTION_OUTSIDE)
    // Renaming the bad one is refused (the set stays invalid); removing it is the correction.
    await expectKind(update({ seen: seen(), changes: { deductions: withDeduction(seen().deductions, { ...seen().deductions[1], label: 'renamed' }) } }), QUANT_ERROR.INVALID, /outside/)
    await update({ seen: seen(), changes: { deductions: withoutDeduction(seen().deductions, 'window') } })
    expect(near(measurementQuantity(f.store.get(M_PATH), CAL).value, 28)).toBe(true)
    await runVoidMeasurement({ ...f, ref: f.ref(M_PATH), seen: seen(), reason: 'done', uid: 'u2' })
    expect(f.store.get(M_PATH)).toMatchObject({ status: 'void', deductions: [{ id: 'door' }] })
    await expectKind(update({ seen: seen(), changes: { deductions: [] } }), QUANT_ERROR.INVALID)
  })
})

// ── 6. Draft memory ──────────────────────────────────────────────────────────

describe('drafts — a deduction being traced, and a hole being edited, are remembered as intent', () => {
  const memStorage = () => {
    const map = new Map()
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), key: (i) => [...map.keys()][i] ?? null, get length() { return map.size }, map }
  }
  const ID = { drawingId: 'd1', revisionId: 'r2', page: 1 }
  const base = (over = {}) => ({ pageId: 'd1_r2_1', ...ID, tool: 'deduct', points: [P(10, 10), P(20, 10)], calibrationPoints: [], editing: null, deductParentId: 'slab', ...over })
  const raw = (over = {}) => JSON.stringify({ v: DRAFT_VERSION, pageId: 'd1_r2_1', ...ID, tool: 'deduct', points: [P(0, 0)], deductParentId: 'slab', ...over })

  it('round-trips the parent id and the hole id; a deduct draft without a parent, or a junk id, never parses; pre-1D entries parse unchanged', () => {
    const s = memStorage()
    expect(writeDraft(s, 'p1', base())).toBe(true)
    expect(readDraft(s, 'p1', 'd1_r2_1')).toEqual(base())
    const edit = base({ tool: 'edit', points: [], deductParentId: undefined, editing: { measurementId: 'slab', revision: 2, points: DOOR.points, deductionId: 'door' } })
    delete edit.deductParentId
    expect(writeDraft(s, 'p1', edit)).toBe(true)
    expect(readDraft(s, 'p1', 'd1_r2_1')).toEqual(edit)
    expect(parseSavedDraft(raw({ deductParentId: undefined }))).toBeNull()
    expect(parseSavedDraft(raw({ deductParentId: 'a/b' }))).toBeNull()
    expect(parseSavedDraft(raw({ tool: 'edit', points: [], editing: { measurementId: 'slab', revision: 2, points: [P(0, 0)], deductionId: 7 } }))).toBeNull()
    expect(parseSavedDraft(JSON.stringify({ v: DRAFT_VERSION, pageId: 'd1_r2_1', ...ID, tool: 'area', points: [P(0, 0)] }))).toEqual({ pageId: 'd1_r2_1', ...ID, tool: 'area', points: [P(0, 0)], calibrationPoints: [], editing: null })
    // Writing a deduct draft with no parent clears the entry rather than storing an orphan.
    expect(writeDraft(s, 'p1', base({ deductParentId: null }))).toBe(true)
    expect(readDraft(s, 'p1', 'd1_r2_1')).toBeNull()
  })

  it('restorableDraft: a deduction draft needs its parent ACTIVE on the sheet (any revision); a hole edit needs the hole at the same revision', () => {
    const parent = withHoles(DOOR)
    const d = base()
    expect(restorableDraft(d, { pageId: 'd1_r2_1', measurements: [parent] })).toEqual({ draft: d, droppedEdit: false })
    expect(restorableDraft(d, { pageId: 'd1_r2_1', measurements: [area({ revision: 9, deductions: [DOOR] })] })).toEqual({ draft: d, droppedEdit: false }) // re-judged at save
    expect(restorableDraft(d, { pageId: 'd1_r2_1', measurements: [area({ status: 'void' })] })).toEqual({ draft: null, droppedEdit: false, droppedDeduction: true })
    expect(restorableDraft(d, { pageId: 'd1_r2_1', measurements: [] })).toEqual({ draft: null, droppedEdit: false, droppedDeduction: true })
    expect(restorableDraft(d, { pageId: 'd1_r2_2', measurements: [parent] })).toBeNull()
    const e = base({ tool: 'edit', points: [], editing: { measurementId: 'slab', revision: 1, points: DOOR.points, deductionId: 'door' } })
    delete e.deductParentId
    expect(restorableDraft(e, { pageId: 'd1_r2_1', measurements: [parent] })).toEqual({ draft: { ...e, editing: { measurement: parent, points: DOOR.points, deductionId: 'door' } }, droppedEdit: false })
    expect(restorableDraft(e, { pageId: 'd1_r2_1', measurements: [area({ deductions: [WINDOW] })] })).toEqual({ draft: null, droppedEdit: true })   // the hole is gone
    expect(restorableDraft(e, { pageId: 'd1_r2_1', measurements: [area({ revision: 2, deductions: [DOOR] })] })).toEqual({ draft: null, droppedEdit: true }) // the parent moved on
  })
})

// ── 7. Summaries and the BOQ aggregate consume the same net ─────────────────

describe('page totals, project summary and the BOQ aggregate — net once, never a hole on its own', () => {
  const drawing = { id: 'd1', status: 'active', drawingNumber: 'A-101', currentRevisionId: 'r2', currentRevisionCode: 'B' }
  const page = { id: 'd1_r2_1', drawingId: 'd1', revisionId: 'r2', page: 1, calibration: CAL, calibrationRevision: 1 }
  const item = (o = {}) => ({ id: 'b1', itemNumber: '2.1', description: 'Formwork', unit: 'm2', quantity: 10, rate: 85, amount: 850, costCodeId: 'cc1', costCodeName: 'Formwork', status: 'active', currency: 'AUD', revision: 1, updatedAt: TS(100), ...o })
  const ok = { measurements: { loading: false, error: false }, pages: { loading: false, error: false }, drawings: { loading: false, error: false }, boq: { loading: false, error: false } }

  it('page totals: one row, net 25, gross 30, deducted 5 — never 30 + (−5) as two rows', () => {
    const s = summariseMeasurements([withHoles(DOOR, WINDOW), area({ id: 'other', points: rect('r', 0, 0, 100, 100).points })], CAL)
    expect(s.area.count).toBe(2)
    expect(near(s.area.total, 26)).toBe(true)
    expect(near(s.area.gross, 31)).toBe(true)
    expect(near(s.area.deducted, 5)).toBe(true)
    expect(s.area.incomplete).toBe(0)
    const bad = summariseMeasurements([withHoles(rect('out', 450, 500, 550, 650))], CAL)
    expect(bad.area).toMatchObject({ count: 1, incomplete: 1, total: 0 })
  })

  it('project summary: a current valid area with holes totals its NET; an invalid set is ATTENTION with the INVALID issue; kind totals carry gross/deducted', () => {
    const s = summariseTakeoff({ measurements: [withHoles(DOOR, WINDOW), area({ id: 'bad', deductions: [rect('out', 450, 500, 550, 650)] })], takeoffPages: [page], drawings: [drawing], costCodes: [], boqItems: [item()] })
    expect(s.counts).toEqual({ current: 1, attention: 1, historical: 0, void: 0, total: 2 })
    expect(near(s.totals.current.area.total, 25)).toBe(true)
    expect(near(s.totals.current.area.gross, 30)).toBe(true)
    expect(near(s.totals.current.area.deducted, 5)).toBe(true)
    const bad = s.rows.find(r => r.m.id === 'bad')
    expect(bad.category).toBe(SUMMARY_CATEGORY.ATTENTION)
    expect(bad.issues).toEqual([SUMMARY_ISSUE.INVALID])
    expect(bad.quantity.reason).toBe(QUANTITY_PROBLEM.DEDUCTION_OUTSIDE)
    expect(kindTotals([])).toEqual(emptyKindTotals())
    expect(Object.keys(emptyKindTotals().area).sort()).toEqual(['count', 'deducted', 'gross', 'total', 'unit'])
    // Historical rows total apart, still net.
    const h = classifyMeasurement(withHoles(DOOR, { ...WINDOW }, ), { pagesById: new Map([[page.id, page]]), drawingsById: new Map([['d1', { ...drawing, currentRevisionId: 'r3' }]]), boqItems: [item()] })
    expect(h.category).toBe(SUMMARY_CATEGORY.HISTORICAL)
    expect(near(h.quantity.value, 25)).toBe(true)
  })

  it('BOQ aggregate: the eligible total is the NET; an invalid set BLOCKS the apply as "cannot be derived"', () => {
    const agg = aggregateLinkedQuantity({ item: item(), measurements: [withHoles(DOOR, WINDOW), area({ id: 'plain', points: rect('r', 0, 0, 100, 200).points })], takeoffPages: [page], drawings: [drawing] })
    expect(agg.eligible).toHaveLength(2)
    expect(agg.total).toBe(27)
    expect(applyReadiness({ item: item(), aggregate: agg, sources: ok })).toEqual({ canApply: true, reason: null })
    const blocked = aggregateLinkedQuantity({ item: item(), measurements: [withHoles(DOOR, rect('o', 100, 100, 200, 300))], takeoffPages: [page], drawings: [drawing] })
    expect(blocked.total).toBeNull()
    expect(blocked.blockers[0].blocker).toBe(APPLY_BLOCKER.INVALID)
    expect(applyReadiness({ item: item(), aggregate: blocked, sources: ok }).reason).toBe('blocked')
  })

  it('EVIDENCE — unchanged for a measurement without holes (v1, byte-identical row key); changed by adding, moving or removing a hole', () => {
    const plain = area()
    const key = evidenceRowKey({ m: plain, page, drawing })
    expect(key).toBe('slab:1:area:cc1:d1:r2:1:d1_r2_1:0,0;500,0;500,600;0,600:1/100/1/m:1:100/1/m:r2:active')
    expect(evidenceRowKey({ m: area({ deductions: [] }), page, drawing })).toBe(key)
    expect(EVIDENCE_VERSION).toBe('v1')
    const before = aggregateLinkedQuantity({ item: item(), measurements: [plain], takeoffPages: [page], drawings: [drawing] })
    const fp = evidenceFingerprint(before)
    expect(fp).toMatch(/^v1:[0-9a-f]{16}$/)
    expect(evidenceFingerprint(aggregateLinkedQuantity({ item: item(), measurements: [area({ deductions: [] })], takeoffPages: [page], drawings: [drawing] }))).toBe(fp)
    // The SAME revision with a hole added (a direct write) is different evidence; so is a moved or a removed hole.
    const withDoor = aggregateLinkedQuantity({ item: item(), measurements: [withHoles(DOOR)], takeoffPages: [page], drawings: [drawing] })
    const movedDoor = aggregateLinkedQuantity({ item: item(), measurements: [withHoles({ ...DOOR, points: rect('d', 60, 50, 160, 250).points })], takeoffPages: [page], drawings: [drawing] })
    expect(evidenceFingerprint(withDoor)).not.toBe(fp)
    expect(evidenceFingerprint(movedDoor)).not.toBe(evidenceFingerprint(withDoor))
    expect(evidenceRowKey({ m: withHoles(DOOR), page, drawing })).toBe(`${key}:door=50,50;150,50;150,250;50,250`)
    // Order-independent across holes.
    expect(evidenceRowKey({ m: withHoles(WINDOW, DOOR), page, drawing })).toBe(evidenceRowKey({ m: withHoles(DOOR, WINDOW), page, drawing }))
    // An application recorded against the plain slab reads OUTDATED once a hole exists — same item, same total impossible to confuse.
    const applied = item({ quantity: 30, quantApplied: { at: TS(50), by: 'u1', quantity: 30, measurementCount: 1, evidence: fp } })
    expect(quantAppliedState(applied, before, ok)).toBe(QUANT_APPLIED_STATE.MATCHES)
    expect(quantAppliedState(applied, withDoor, ok)).toBe(QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED)
    expect(evidenceKey(item(), withDoor)).not.toBe(evidenceKey(item(), before))
  })
})

// ── 8. Structure pins ────────────────────────────────────────────────────────

describe('structure — rules, overlay, list, dialog, workspace, financial boundary', () => {
  const rules = readRoot('firestore.rules')
  const meas = rules.slice(rules.indexOf('match /companies/{companyId}/projects/{projectId}/takeoffMeasurements/'), rules.indexOf('// Project counters — PER-PROJECT'))

  it('rules: `deductions` is in hasOnly (never hasAll), area-only, a list of ≤ 50, allowed on an active edit, frozen by void', () => {
    const keys = meas.slice(meas.indexOf('function exactKeys'), meas.indexOf('function linkValid'))
    const [hasOnly, hasAll] = keys.split('hasAll(')
    expect(hasOnly).toContain("'deductions'")
    expect(hasAll).not.toContain("'deductions'")
    expect(meas).toContain("|| (d.kind == 'area' && d.deductions is list && d.deductions.size() <= 50);")
    expect(meas).toContain('&& deductionsValid(d)')
    expect(meas).toContain("changedKeys().hasOnly(['points', 'label', 'costCodeId', 'costCodeName', 'calibration', 'boqItemId', 'deductions', 'revision', 'updatedAt', 'updatedBy'])")
    expect(meas).toContain("changedKeys().hasOnly(['status', 'voidReason', 'voidedAt', 'voidedBy', 'revision', 'updatedAt', 'updatedBy'])")
    expect(Buffer.byteLength(rules, 'utf8')).toBeLessThan(245_000)
  })

  it('the create transaction never writes the key; only runUpdateMeasurement does, validated against the server copy; still 3 set / 3 update', () => {
    const src = stripComments(read('lib/quantActions.js'))
    const create = src.slice(src.indexOf('export async function runCreateMeasurement'), src.indexOf('export async function runUpdateMeasurement'))
    expect(create).not.toMatch(/deductions/)
    expect(src).toContain('const geometryError = validateDeductions(next.points ?? current.points, next.deductions ?? measurementDeductions(current), current.calibration ?? null)')
    expect(src.match(/tx\.set\(/g)).toHaveLength(3)
    expect(src.match(/tx\.update\(/g)).toHaveLength(3)
    expect(src).not.toMatch(/quantity\s*:/)
  })

  it('the overlay fills with evenodd, draws hole outlines dashed, and still handles no pointer events', () => {
    const overlay = stripComments(read('pages/project/quant/MeasurementOverlay.jsx'))
    expect(overlay).toContain('fillRule="evenodd"')
    expect(overlay).toContain('d={areaPathWithHoles(m.points, holes)}')
    expect(overlay).toContain('d={holesPath(holes)}')
    expect(overlay).toContain('strokeDasharray="5 4"')
    expect(overlay).toContain('<g pointerEvents="none">')
    expect(overlay).not.toMatch(/onPointer|onClick|onMouse|onTouch/)
  })

  it('the list shows net with its breakdown and the holes as a SUB-LIST with Edit outline / Rename / Remove — never as measurement rows', () => {
    const list = stripComments(read('pages/project/quant/MeasurementList.jsx'))
    expect(list).toContain('breakdown: quantityBreakdown(q),')
    expect(list).toContain('deductions: measurementDeductions(m),')
    expect(list).toContain('flaggedIds: q.deductionIds ?? [],')
    expect(list).toMatch(/>Edit outline<\/button>/)
    expect(list).toMatch(/>Rename<\/button>/)
    expect(list.match(/>Remove<\/button>/g)).toHaveLength(1)
    expect(list.match(/>Deduct<\/button>/g)).toHaveLength(1)
    expect(list).toContain('const active = readable.filter(m => m.status === MEASUREMENT_STATUS.ACTIVE)')
    expect(list).toContain("const canDeductRow = (m) => canEdit && m.kind === MEASUREMENT_KIND.AREA && typeof onDeduct === 'function'")
    expect(list).not.toMatch(/deductions\.map\(d => \(\s*<tr/)
  })

  it('the dialog takes a label only, previews gross / this deduction / net through measurementQuantity, and renders through QuantDialog', () => {
    const dialog = stripComments(read('pages/project/quant/DeductionDialog.jsx'))
    expect(dialog).toContain("import QuantDialog from './QuantDialog'")
    expect(dialog).toContain('titleId="quant-deduction-title"')
    expect(dialog).toContain('withDeduction(measurementDeductions(parent), candidate)')
    expect(dialog).toContain('const breakdown = quantityBreakdown(preview)')
    expect(dialog).toContain('await onSave({ label: label.trim() })')
    expect(dialog).not.toMatch(/name="quantity"|id="quant-quantity"|formatCurrency|boqItemId|costCodeId/)
    expect(dialog).toContain('autoFocus')
    expect(dialog).toContain('role="alert"')
  })

  it('the workspace: Deduct from the selection bar on an AREA, a deduct tool drawing into draftPoints, STALE keeps the draft and says the parent changed', () => {
    const ws = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
    expect(ws).toContain("DEDUCT:    'deduct',")
    expect(ws).toContain('{measurable && selected.kind === MEASUREMENT_KIND.AREA && <Btn sm variant="ghost" onClick={() => startDeduction(selected)}>Deduct</Btn>}')
    expect(ws).toMatch(/if \(tool === TOOL\.DEDUCT\) \{\s*if \(!deductParent\) \{[\s\S]*?setDraftPoints\(prev => \(prev\.length >= DEDUCTION_MAX_POINTS \? prev : \[\.\.\.prev, p\]\)\)/)
    expect(ws).toContain('const hasUnsavedWork = draftPoints.length > 0 || calibrationPoints.length > 0 || editDirty')
    expect(ws).toContain("const text = err?.kind === QUANT_ERROR.STALE ? STALE_DEDUCTION_MESSAGE : (err?.message || fallback)")
    expect(ws).toContain('deductParentId: tool === TOOL.DEDUCT ? deductParentId : null,')
    expect(ws).toContain('if (!window.confirm(`Remove deduction "${label}" from "${m.label}"?')
    expect(ws).toContain('<Btn sm onClick={finishDraft} disabled={!deductParent || draftPoints.length < MIN_POINTS[MEASUREMENT_KIND.AREA] || !!draftIssue}>Finish deduction</Btn>')
    // A deduction save never passes a calibration snapshot (the review state is preserved).
    expect(ws.match(/changes: \{ deductions: /g)).toHaveLength(3)
    expect(ws).not.toMatch(/changes: \{ deductions: [\s\S]{0,160}?calibration/)
    // Deduct mode gets the measuring cursor.
    expect(stripComments(read('pages/project/quant/PageViewer.jsx'))).toContain("const MEASURING_MODES = ['calibrate', 'length', 'area', 'count', 'deduct', 'edit']")
  })

  it('the BOQ side: the aggregate and the apply are untouched; the dialog only DISPLAYS the breakdown', () => {
    const lib = stripComments(read('lib/quantBoq.js'))
    expect(lib).toContain('for (const r of eligible) sum += r.quantity.value')
    expect(lib).toContain("].join(':') + deductionsKey(m)")
    expect(lib).toContain("if (list.length === 0) return ''")
    const actions = stripComments(read('lib/boqActions.js'))
    expect(actions).not.toMatch(/deduction/i)
    const modal = stripComments(read('pages/project/boq/BoqQuantityApplyModal.jsx'))
    expect(modal).toContain('const b = quantityBreakdown(quantity)')
    expect(modal).not.toMatch(/quantity\s*\*\s*rate|rate\s*\*\s*quantity|toCents|roundMoney|gross\s*-\s*deducted/)
    expect(modal).toContain('onApply(item, { quantity: aggregate.total, measurementCount: aggregate.eligible.length, evidence })')
  })

  it('no Quant file gained a financial import, a BOQ write or a Firestore write of its own', () => {
    const dir = fileURLToPath(new URL('../../src/pages/project/quant/', import.meta.url))
    const FORBIDDEN = /updateBoqItem|createBoqItem|voidBoqItem|applyBoqQuantity|boqActions|useBudgetLines|formatCurrency|roundMoney|\bsetDoc\(|\bupdateDoc\(|\baddDoc\(|\bdeleteDoc\(|\brunTransaction\(/
    for (const f of readdirSync(dir)) expect(stripComments(read(`pages/project/quant/${f}`)), f).not.toMatch(FORBIDDEN)
    expect(stripComments(read('lib/quant.js'))).not.toMatch(/from 'firebase|setDoc|updateDoc|formatCurrency|roundMoney|boqLineAmount/)
  })
})
