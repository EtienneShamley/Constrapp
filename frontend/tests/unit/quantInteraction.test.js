import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MEASUREMENT_KIND, MIN_POINTS, MAX_POINTS, QUANTITY_STATE, QUANTITY_PROBLEM, QUANTITY_PROBLEM_LABELS, POLYGON_PROBLEM,
  orientation, segmentsIntersect, polygonRing, polygonProblem, isSimplePolygon, polygonArea, polylineLength,
  measurementQuantity, quantityIssue, validatePoints, validateMeasurementDraft, summariseMeasurements, buildCalibration,
  distanceToSegment, nearestVertex, nearestSegment, insertPointAt, removePointAt, canRemovePoint, editValidation,
  HIT_TOLERANCE_PX, pointInPolygon, distanceToMeasurement, hitTestMeasurements,
  ZOOM_MIN, ZOOM_MAX, clampZoom, wheelZoom, pinchZoom, zoomAboutPoint, pointerDistance, screenToCanonical,
  clampPageInput,
} from '../../src/lib/quant.js'
import {
  DRAFT_VERSION, draftStorageKey, parseSavedDraft, readDraft, writeDraft, clearDraft, listDrafts, isDraftEmpty, restorableDraft,
} from '../../src/lib/quantDraft.js'
import { aggregateLinkedQuantity, APPLY_BLOCKER, applyReadiness, evidenceFingerprint } from '../../src/lib/quantBoq.js'

// ── Constrapp Quant™ 1C-A — measurement correctness and interaction (ADR-53) ─
//
// Pure tests over the geometry, editing, hit-testing, zoom and draft helpers
// added in 1C-A, plus source-structure pins over the viewer, workspace, picker,
// overlay and the three dialogs. Plain Node, no jsdom — the ADR-26 convention:
// the DOM is touched only inside the components, which the pins read as text.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const P = (x, y) => ({ x, y })
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const CAL = buildCalibration({ pointA: P(0, 0), pointB: P(100, 0), realDistance: 1, unit: 'm' }) // 100 units = 1 m
const SNAP = { revision: 1, pageDistance: 100, realDistance: 1, unit: 'm' }

const SQUARE  = [P(0, 0), P(300, 0), P(300, 400), P(0, 400)]                 // 12 m²
const CONCAVE = [P(0, 0), P(6, 0), P(6, 4), P(3, 4), P(3, 2), P(0, 2)]        // L-shape, 18 units²
const BOWTIE  = [P(0, 0), P(2, 2), P(2, 0), P(0, 2)]                         // symmetric: shoelace 0
const CROSSED = [P(0, 0), P(4, 0), P(1, 3), P(4, 3)]                         // one crossed edge: shoelace = 1.5 ≠ 0
const SPIKE   = [P(0, 0), P(4, 0), P(4, 3), P(4, 6), P(4, 3), P(0, 3)]       // doubles back along an edge

const measurement = (overrides = {}) => ({
  id: 'm1', takeoffPageId: 'd1_r2_1', drawingId: 'd1', revisionId: 'r2', page: 1,
  kind: 'area', points: SQUARE, label: 'Slab', costCodeId: 'cc1', costCodeName: '04-100 — Formwork',
  calibration: SNAP, boqItemId: 'b1', status: 'active', voidReason: '', voidedAt: null, voidedBy: null,
  revision: 1, createdAt: { seconds: 1 }, createdBy: 'u1', updatedAt: { seconds: 1 }, updatedBy: 'u1',
  ...overrides,
})

// ── 1. Polygon simplicity ────────────────────────────────────────────────────

describe('P0 — self-intersecting area polygons are refused (ADR-53)', () => {
  it('REGRESSION — a crossed outline whose shoelace result is NON-ZERO is refused, not measured', () => {
    expect(polygonArea(CROSSED)).toBeGreaterThan(0)              // the formula would have produced a figure…
    expect(polygonProblem(CROSSED)).toBe(POLYGON_PROBLEM.SELF_INTERSECTING)
    expect(validatePoints('area', CROSSED)).toMatch(/crosses itself/)
    const q = measurementQuantity({ kind: 'area', points: CROSSED }, CAL)
    expect(q).toEqual({ value: null, unit: 'm²', state: QUANTITY_STATE.INVALID, reason: QUANTITY_PROBLEM.SELF_INTERSECTING })
    expect(quantityIssue(q)).toMatch(/crosses itself/)
  })

  it('the symmetric bow-tie is refused as CROSSED (it was only ever caught by its zero result, with a misleading message)', () => {
    expect(polygonArea(BOWTIE)).toBe(0)
    expect(polygonProblem(BOWTIE)).toBe(POLYGON_PROBLEM.SELF_INTERSECTING)
    expect(validatePoints('area', BOWTIE)).toMatch(/crosses itself/)
    expect(measurementQuantity({ kind: 'area', points: BOWTIE }, CAL).reason).toBe(QUANTITY_PROBLEM.SELF_INTERSECTING)
  })

  it('valid simple polygons pass unchanged: a rectangle, a concave L, a triangle, a 500-point circle', () => {
    expect(polygonProblem(SQUARE)).toBeNull()
    expect(polygonProblem(CONCAVE)).toBeNull()
    expect(polygonProblem([P(0, 0), P(4, 0), P(0, 3)])).toBeNull()
    const circle = Array.from({ length: MAX_POINTS }, (_, i) => P(Math.cos(i * 2 * Math.PI / MAX_POINTS) * 100, Math.sin(i * 2 * Math.PI / MAX_POINTS) * 100))
    expect(isSimplePolygon(circle)).toBe(true)
    expect(validatePoints('area', circle)).toBeNull()
    // The quantities the 1A suite pins are untouched.
    expect(near(measurementQuantity({ kind: 'area', points: SQUARE }, CAL).value, 12)).toBe(true)
    expect(near(polygonArea(CONCAVE), 18)).toBe(true)
  })

  it('shared endpoints and consecutive edges are handled: adjacent edges may share a vertex; a spike is refused', () => {
    // Every adjacent pair shares exactly one vertex — legal.
    expect(polygonProblem([P(0, 0), P(4, 0), P(4, 4), P(0, 4)])).toBeNull()
    // A vertex in the middle of a straight run (collinear, opposite directions) is legal.
    expect(polygonProblem([P(0, 0), P(2, 0), P(4, 0), P(4, 4), P(0, 4)])).toBeNull()
    // Doubling back along an edge (collinear, same direction) is a spike — refused.
    expect(polygonProblem(SPIKE)).toBe(POLYGON_PROBLEM.SELF_INTERSECTING)
    // A non-adjacent vertex touching another edge (a T) is refused.
    expect(polygonProblem([P(0, 0), P(4, 0), P(4, 4), P(2, 0), P(0, 4)])).toBe(POLYGON_PROBLEM.SELF_INTERSECTING)
    // A figure-of-eight pinched at a shared vertex is refused.
    expect(polygonProblem([P(0, 0), P(2, 2), P(4, 0), P(4, 4), P(2, 2), P(0, 4)])).toBe(POLYGON_PROBLEM.SELF_INTERSECTING)
  })

  it('a repeated closing vertex and consecutive duplicates are normalised consistently', () => {
    const closed = [...SQUARE, P(0, 0)]
    expect(polygonRing(closed)).toEqual(SQUARE)
    expect(polygonProblem(closed)).toBeNull()
    expect(near(measurementQuantity({ kind: 'area', points: closed }, CAL).value, 12)).toBe(true)
    const dupes = [P(0, 0), P(0, 0), P(300, 0), P(300, 0), P(300, 400), P(0, 400), P(0, 400)]
    expect(polygonRing(dupes)).toEqual(SQUARE)
    expect(polygonProblem(dupes)).toBeNull()
    expect(polygonRing('junk')).toEqual([])
  })

  it('degenerate polygons (collinear, coincident, fewer than three distinct points) are DEGENERATE', () => {
    expect(polygonProblem([P(0, 0), P(1, 1), P(2, 2)])).toBe(POLYGON_PROBLEM.DEGENERATE)
    expect(polygonProblem([P(1, 1), P(1, 1), P(1, 1)])).toBe(POLYGON_PROBLEM.DEGENERATE)
    expect(polygonProblem([P(0, 0), P(5, 0), P(0, 0)])).toBe(POLYGON_PROBLEM.DEGENERATE)
    const q = measurementQuantity({ kind: 'area', points: [P(0, 0), P(1, 1), P(2, 2)] }, CAL)
    expect(q.state).toBe(QUANTITY_STATE.INVALID)
    expect(q.reason).toBe(QUANTITY_PROBLEM.DEGENERATE)
    expect(validatePoints('area', [P(0, 0), P(1, 1), P(2, 2)])).toMatch(/collinear or coincide/)
  })

  it('length and count semantics are preserved: a self-crossing polyline is still a length, a count still counts', () => {
    const zigzag = [P(0, 0), P(400, 300), P(400, 0), P(0, 300)]
    expect(validatePoints('length', zigzag)).toBeNull()
    expect(near(measurementQuantity({ kind: 'length', points: zigzag }, CAL).value, polylineLength(zigzag) / 100)).toBe(true)
    expect(measurementQuantity({ kind: 'count', points: CROSSED }, null)).toEqual({ value: 4, unit: 'no.', state: QUANTITY_STATE.OK })
    // Too-few and malformed still name themselves.
    expect(measurementQuantity({ kind: 'area', points: [P(0, 0), P(1, 0)] }, CAL).reason).toBe(QUANTITY_PROBLEM.TOO_FEW_POINTS)
    expect(measurementQuantity({ kind: 'area', points: 'junk' }, CAL).reason).toBe(QUANTITY_PROBLEM.MALFORMED)
    expect(quantityIssue({ state: QUANTITY_STATE.OK, value: 1 })).toBeNull()
    for (const reason of Object.values(QUANTITY_PROBLEM)) expect(QUANTITY_PROBLEM_LABELS[reason]).toBeTruthy()
  })

  it('an uncalibrated page does not hide a crossed area: the geometry problem is reported before the scale', () => {
    expect(measurementQuantity({ kind: 'area', points: CROSSED }, null).state).toBe(QUANTITY_STATE.INVALID)
    expect(measurementQuantity({ kind: 'area', points: SQUARE }, null).state).toBe(QUANTITY_STATE.UNCALIBRATED)
  })

  it('a complete draft with a crossed outline is refused before any transaction (validateMeasurementDraft)', () => {
    const draft = { kind: 'area', points: CROSSED, label: 'Room', costCodeId: 'cc', costCodeName: '04 — Formwork' }
    expect(validateMeasurementDraft(draft)).toMatch(/crosses itself/)
    expect(validateMeasurementDraft({ ...draft, points: SQUARE })).toBeNull()
  })

  it('an EXISTING stored crossed polygon is listed as not derivable, counted as incomplete, and never summed', () => {
    const list = [measurement(), measurement({ id: 'm2', points: CROSSED })]
    const s = summariseMeasurements(list, CAL)
    expect(s.area).toMatchObject({ count: 2, incomplete: 1 })
    expect(near(s.area.total, 12)).toBe(true)
  })

  it('an existing invalid record BLOCKS the BOQ application through the unchanged aggregation engine', () => {
    const item = { id: 'b1', unit: 'm2', quantity: 10, rate: 85, costCodeId: 'cc1', status: 'active', updatedAt: { seconds: 1 } }
    const page = { id: 'd1_r2_1', drawingId: 'd1', revisionId: 'r2', page: 1, calibration: CAL, calibrationRevision: 1 }
    const drawing = { id: 'd1', status: 'active', currentRevisionId: 'r2' }
    const a = aggregateLinkedQuantity({ item, measurements: [measurement(), measurement({ id: 'm2', points: CROSSED })], takeoffPages: [page], drawings: [drawing] })
    expect(a.eligible).toHaveLength(1)
    expect(a.blockers).toHaveLength(1)
    expect(a.blockers[0].blocker).toBe(APPLY_BLOCKER.INVALID)
    expect(a.total).toBeNull()
    expect(evidenceFingerprint(a)).toBeNull()
    const ok = { measurements: { loading: false, error: false } }
    expect(applyReadiness({ item, aggregate: a, sources: ok }).canApply).toBe(false)
    // No second engine: the apply dialog and the BOQ library import nothing new for this.
    expect(read('lib/quantBoq.js')).not.toMatch(/polygonProblem|isSimplePolygon|segmentsIntersect/)
    expect(read('pages/project/boq/BoqQuantityApplyModal.jsx')).not.toMatch(/polygonProblem|isSimplePolygon/)
  })

  it('stays fast at the point cap: a 500-point simple polygon validates well within a frame', () => {
    const circle = Array.from({ length: MAX_POINTS }, (_, i) => P(Math.cos(i * 2 * Math.PI / MAX_POINTS) * 1000, Math.sin(i * 2 * Math.PI / MAX_POINTS) * 1000))
    const t0 = performance.now()
    for (let i = 0; i < 5; i++) expect(polygonProblem(circle)).toBeNull()
    expect((performance.now() - t0) / 5).toBeLessThan(100)
  })

  it('segment primitives: proper crossings, touching, collinear overlap, and disjoint segments', () => {
    expect(orientation(P(0, 0), P(1, 0), P(1, 1))).toBe(1)
    expect(orientation(P(0, 0), P(1, 0), P(1, -1))).toBe(-1)
    expect(orientation(P(0, 0), P(1, 0), P(2, 0))).toBe(0)
    expect(segmentsIntersect(P(0, 0), P(4, 4), P(0, 4), P(4, 0))).toBe(true)   // cross
    expect(segmentsIntersect(P(0, 0), P(4, 0), P(2, 0), P(2, 5))).toBe(true)   // T-touch
    expect(segmentsIntersect(P(0, 0), P(4, 0), P(2, 0), P(6, 0))).toBe(true)   // collinear overlap
    expect(segmentsIntersect(P(0, 0), P(4, 0), P(5, 0), P(9, 0))).toBe(false)  // collinear, apart
    expect(segmentsIntersect(P(0, 0), P(1, 1), P(2, 0), P(3, 1))).toBe(false)  // parallel, apart
  })
})

// ── 2. Geometry editing helpers ──────────────────────────────────────────────

describe('P1 — geometry editing helpers (insert / remove / nearest)', () => {
  it('distanceToSegment measures to the segment, not its line', () => {
    expect(near(distanceToSegment(P(2, 3), P(0, 0), P(4, 0)), 3)).toBe(true)
    expect(near(distanceToSegment(P(-3, 4), P(0, 0), P(4, 0)), 5)).toBe(true) // beyond the end → to the endpoint
    expect(near(distanceToSegment(P(1, 1), P(2, 2), P(2, 2)), Math.SQRT2)).toBe(true) // zero-length segment
    expect(Number.isNaN(distanceToSegment(P(NaN, 0), P(0, 0), P(1, 0)))).toBe(true)
  })

  it('nearestVertex and nearestSegment find the closest by distance; the closing edge counts only for areas', () => {
    expect(nearestVertex(SQUARE, P(290, 10))).toEqual({ index: 1, distance: Math.hypot(10, 10) })
    expect(nearestVertex([], P(0, 0))).toBeNull()
    expect(nearestSegment(SQUARE, P(150, -5), true)).toMatchObject({ index: 0, distance: 5 })
    // The closing edge (3 → 0) is x = 0: an open polyline has no such edge.
    expect(nearestSegment(SQUARE, P(-5, 200), true)).toMatchObject({ index: 3, distance: 5 })
    expect(nearestSegment(SQUARE, P(-5, 200), false).index).not.toBe(3)
    expect(nearestSegment([P(0, 0)], P(1, 1))).toBeNull()
  })

  it('insertPointAt inserts AFTER the edge start, removePointAt removes by index, neither mutates', () => {
    const out = insertPointAt(SQUARE, 0, P(150, 0))
    expect(out).toEqual([P(0, 0), P(150, 0), P(300, 0), P(300, 400), P(0, 400)])
    expect(SQUARE).toHaveLength(4)
    expect(insertPointAt(SQUARE, 3, P(0, 200))).toEqual([...SQUARE, P(0, 200)]) // on the closing edge → appended
    expect(removePointAt(out, 1)).toEqual(SQUARE)
    expect(removePointAt(SQUARE, 9)).toEqual(SQUARE)
    expect(removePointAt(SQUARE, -1)).toEqual(SQUARE)
    // Points are normalised to { x, y } only.
    expect(insertPointAt([{ x: 1, y: 2, extra: true }], 0, { x: 3, y: 4, z: 1 })).toEqual([P(1, 2), P(3, 4)])
  })

  it('canRemovePoint keeps every kind at or above its minimum; editValidation is the same rule the save uses', () => {
    expect(MIN_POINTS).toEqual({ length: 2, area: 3, count: 1 })
    expect(canRemovePoint('area', SQUARE)).toBe(true)
    expect(canRemovePoint('area', [P(0, 0), P(1, 0), P(0, 1)])).toBe(false)
    expect(canRemovePoint('length', [P(0, 0), P(1, 0)])).toBe(false)
    expect(canRemovePoint('count', [P(0, 0)])).toBe(false)
    expect(canRemovePoint('count', [P(0, 0), P(1, 1)])).toBe(true)
    expect(canRemovePoint('volume', SQUARE)).toBe(false)
    expect(editValidation('area', removePointAt(SQUARE, 0))).toBeNull()
    expect(editValidation('area', CROSSED)).toMatch(/crosses itself/)
    expect(editValidation('length', [P(1, 1), P(1, 1)])).toMatch(/cannot be zero/)
  })

  it('a drag that crosses the outline is flagged live and cannot be saved; moving it back clears the flag', () => {
    const dragged = SQUARE.map((p, i) => (i === 2 ? P(-300, 400) : p)) // vertex 2 dragged across → crossed
    expect(editValidation('area', dragged)).toMatch(/crosses itself/)
    expect(quantityIssue(measurementQuantity({ kind: 'area', points: dragged }, CAL))).toMatch(/crosses itself/)
    expect(editValidation('area', SQUARE)).toBeNull()
  })
})

// ── 3. Hit testing ───────────────────────────────────────────────────────────

describe('P1 — selecting measurements on the drawing (zoom-aware hit testing)', () => {
  const area   = measurement({ id: 'area',  points: SQUARE })
  const inner  = measurement({ id: 'inner', points: [P(100, 100), P(200, 100), P(200, 200), P(100, 200)] })
  const line   = measurement({ id: 'line',  kind: 'length', points: [P(500, 0), P(500, 400)] })
  const dots   = measurement({ id: 'dots',  kind: 'count', points: [P(700, 50), P(700, 150)], calibration: null })
  const voided = measurement({ id: 'void',  status: 'void', points: [P(900, 0), P(1000, 0), P(1000, 100)] })
  const all = [area, inner, line, dots, voided]

  it('pointInPolygon: inside, outside, concave notch', () => {
    expect(pointInPolygon(SQUARE, P(10, 10))).toBe(true)
    expect(pointInPolygon(SQUARE, P(-1, 10))).toBe(false)
    expect(pointInPolygon(CONCAVE, P(1, 1))).toBe(true)
    expect(pointInPolygon(CONCAVE, P(1, 3))).toBe(false) // inside the notch
    expect(pointInPolygon([P(0, 0), P(1, 0)], P(0, 0))).toBe(false)
  })

  it('distanceToMeasurement: a count by its nearest marker, a length by its edge, an area by its boundary', () => {
    expect(near(distanceToMeasurement(dots, P(700, 60)), 10)).toBe(true)
    expect(near(distanceToMeasurement(line, P(510, 200)), 10)).toBe(true)
    expect(near(distanceToMeasurement(area, P(150, -8)), 8)).toBe(true)
    expect(distanceToMeasurement({ kind: 'area', points: 'junk' }, P(0, 0))).toBe(Infinity)
  })

  it('a tap within the tolerance of an edge or marker selects it; the nearest wins', () => {
    expect(hitTestMeasurements(all, P(505, 200), 10)).toBe('line')
    expect(hitTestMeasurements(all, P(700, 158), 10)).toBe('dots')
    expect(hitTestMeasurements(all, P(305, 200), 10)).toBe('area')
    // Two candidates in range: the closer one (8 units to x=500, 12 to x=520).
    expect(hitTestMeasurements([line, measurement({ id: 'near', kind: 'length', points: [P(520, 0), P(520, 400)] })], P(508, 200), 20)).toBe('line')
    expect(hitTestMeasurements([line, measurement({ id: 'near', kind: 'length', points: [P(520, 0), P(520, 400)] })], P(512, 200), 20)).toBe('near')
  })

  it('a tap inside nested areas selects the SMALLEST containing area; outside everything selects nothing', () => {
    expect(hitTestMeasurements(all, P(150, 150), 5)).toBe('inner')
    expect(hitTestMeasurements(all, P(50, 350), 5)).toBe('area')
    expect(hitTestMeasurements(all, P(2000, 2000), 5)).toBeNull()
    // An edge hit beats an inside hit.
    expect(hitTestMeasurements(all, P(150, 205), 10)).toBe('inner')
  })

  it('voided and unreadable records are never hit; invalid inputs give null', () => {
    expect(hitTestMeasurements(all, P(950, 20), 50)).toBeNull()
    expect(hitTestMeasurements([measurement({ id: 'bad', points: 'junk' })], P(0, 0), 50)).toBeNull()
    expect(hitTestMeasurements(all, P(NaN, 0), 10)).toBeNull()
    expect(hitTestMeasurements(all, P(0, 0), -1)).toBeNull()
  })

  it('the tolerance is a FINGER on screen: 22 px (half a 44 px target) divided by the CSS scale, so a zoom never changes the feel', () => {
    expect(HIT_TOLERANCE_PX).toBe(22)
    const atHalf = HIT_TOLERANCE_PX / 0.5, atFour = HIT_TOLERANCE_PX / 4
    expect(atHalf).toBe(44)   // zoomed out: 44 canonical units is 22 px
    expect(atFour).toBe(5.5)  // zoomed in: 5.5 canonical units is 22 px
    expect(hitTestMeasurements([line], P(530, 200), atHalf)).toBe('line')
    expect(hitTestMeasurements([line], P(530, 200), atFour)).toBeNull()
  })
})

// ── 4. Zoom and pan arithmetic ───────────────────────────────────────────────

describe('P1 — pan and zoom: anchoring, bounds, gestures', () => {
  it('wheelZoom: a negative deltaY zooms in, positive out, lines and pages scale to pixels, always clamped', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1)
    expect(wheelZoom(1, 100)).toBeLessThan(1)
    expect(near(wheelZoom(1, -100) * wheelZoom(1, 100), 1, 1e-12)).toBe(true) // symmetric
    expect(wheelZoom(1, -3, 1)).toBeGreaterThan(wheelZoom(1, -3, 0))            // a line is more than a pixel
    expect(wheelZoom(ZOOM_MAX, -10000)).toBe(ZOOM_MAX)
    expect(wheelZoom(ZOOM_MIN, 10000)).toBe(ZOOM_MIN)
    expect(wheelZoom(2, NaN)).toBe(2)
    expect(wheelZoom(NaN, -100)).toBe(clampZoom(1) * Math.exp(100 * 0.002))
  })

  it('pinchZoom scales the START zoom by the finger-distance ratio and clamps; a degenerate distance changes nothing', () => {
    expect(pinchZoom(1, 100, 200)).toBe(2)
    expect(pinchZoom(2, 200, 100)).toBe(1)
    expect(pinchZoom(1, 100, 100000)).toBe(ZOOM_MAX)
    expect(pinchZoom(1, 0, 100)).toBe(1)
    expect(pinchZoom(1, 100, 0)).toBe(1)
    expect(pinchZoom(1, 100, NaN)).toBe(1)
    expect(near(pointerDistance(P(0, 0), P(3, 4)), 5)).toBe(true)
    expect(Number.isNaN(pointerDistance(null, P(0, 0)))).toBe(true)
  })

  it('zoomAboutPoint keeps the content point under the pointer fixed across a scale change', () => {
    const before = { scrollLeft: 100, scrollTop: 50, pointerX: 30, pointerY: 20, scaleBefore: 1, scaleAfter: 2 }
    const next = zoomAboutPoint(before)
    // Content point under the pointer before: (100+30, 50+20) / 1 = (130, 70). After: must still be (130, 70).
    expect(near((next.scrollLeft + 30) / 2, 130)).toBe(true)
    expect(near((next.scrollTop + 20) / 2, 70)).toBe(true)
    // Zooming back restores the original offsets.
    const back = zoomAboutPoint({ ...next, pointerX: 30, pointerY: 20, scaleBefore: 2, scaleAfter: 1 })
    expect(near(back.scrollLeft, 100)).toBe(true)
    expect(near(back.scrollTop, 50)).toBe(true)
    // Never negative; an unusable scale leaves the offsets alone.
    expect(zoomAboutPoint({ scrollLeft: 0, scrollTop: 0, pointerX: 100, pointerY: 100, scaleBefore: 2, scaleAfter: 1 })).toEqual({ scrollLeft: 0, scrollTop: 0 })
    expect(zoomAboutPoint({ scrollLeft: 7, scrollTop: 9, pointerX: 1, pointerY: 1, scaleBefore: 0, scaleAfter: 1 })).toEqual({ scrollLeft: 7, scrollTop: 9 })
  })

  it('pointer → canonical stays exact at every scale, so a zoom never drifts the overlay from the drawing', () => {
    const W = 612, H = 792
    for (const scale of [0.25, 1, 2.5, 8]) {
      const rect = { left: 13, top: 7, width: W * scale, height: H * scale }
      const p = screenToCanonical(13 + 306 * scale, 7 + 396 * scale, rect, W, H)
      expect(near(p.x, 306)).toBe(true)
      expect(near(p.y, 396)).toBe(true)
    }
  })
})

// ── 5. Page-number input ─────────────────────────────────────────────────────

describe('P1 — the page-number input commits once, clamped', () => {
  it('clampPageInput: "12" is 12 (never 1 on the way), clamped to the sheet, junk is null', () => {
    expect(clampPageInput('12', 20)).toBe(12)
    expect(clampPageInput('12', 5)).toBe(5)
    expect(clampPageInput(' 3 ', 5)).toBe(3)
    expect(clampPageInput('0', 5)).toBeNull()
    expect(clampPageInput('-2', 5)).toBeNull()
    expect(clampPageInput('1.5', 5)).toBeNull()
    expect(clampPageInput('abc', 5)).toBeNull()
    expect(clampPageInput('', 5)).toBeNull()
    expect(clampPageInput('7', 0)).toBe(7)       // page count unknown yet: trust the number, the viewer reports overflow
    expect(clampPageInput('7', undefined)).toBe(7)
  })

  it('the picker is uncontrolled and keyed by the page: Enter and blur commit, there is no per-keystroke navigation', () => {
    const picker = stripComments(read('pages/project/quant/SourcePicker.jsx'))
    expect(picker).toContain('key={page}')
    expect(picker).toContain('defaultValue={page}')
    expect(picker).toContain("if (e.key === 'Enter') { e.preventDefault(); commitPage(e.currentTarget) }")
    expect(picker).toContain('onBlur={e => commitPage(e.currentTarget)}')
    expect(picker).toContain('const n = clampPageInput(input.value, numPages)')
    expect(picker).toContain('if (n !== null && n !== page) onPageChange(n)')
    expect(picker).not.toMatch(/onChange=\{e => \{\s*const n = Number\(e\.target\.value\)/)
    expect(picker).not.toMatch(/id="quant-page"[^/]*onChange=/s)
  })
})

// ── 6. Remembered drafts ─────────────────────────────────────────────────────

describe('P1 — unsaved work survives a tab change or a refresh (lib/quantDraft.js)', () => {
  const memStorage = () => {
    const map = new Map()
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k),
      key: (i) => [...map.keys()][i] ?? null, get length() { return map.size }, map,
    }
  }
  const ID = { drawingId: 'd1', revisionId: 'r2', page: 1 }
  const draft = (over = {}) => ({ pageId: 'd1_r2_1', ...ID, tool: 'area', points: [P(0, 0), P(10, 0)], calibrationPoints: [], editing: null, ...over })
  const raw = (over = {}) => JSON.stringify({ v: DRAFT_VERSION, pageId: 'd1_r2_1', ...ID, tool: 'area', points: [P(0, 0)], ...over })

  it('the key is scoped to the project AND the sheet; an empty draft clears that sheet only; junk never parses', () => {
    expect(draftStorageKey('p1', 'd1_r2_1')).toBe('constrapp.quant.draft.p1.d1_r2_1')
    const s = memStorage()
    expect(writeDraft(s, 'p1', draft())).toBe(true)
    expect(writeDraft(s, 'p1', draft({ pageId: 'd1_r2_2', page: 2, tool: 'count', points: [P(5, 5)] }))).toBe(true)
    expect(readDraft(s, 'p1', 'd1_r2_1')).toEqual(draft())
    expect(readDraft(s, 'p2', 'd1_r2_1')).toBeNull()
    expect(writeDraft(s, 'p1', draft({ points: [] }))).toBe(true)
    expect(s.map.has(draftStorageKey('p1', 'd1_r2_1'))).toBe(false)
    expect(readDraft(s, 'p1', 'd1_r2_2')).not.toBeNull() // the other sheet's draft is untouched
    expect(parseSavedDraft('not json')).toBeNull()
    expect(parseSavedDraft(raw({ v: 1 }))).toBeNull()                                  // the 1C-A shape (no identity) is not trusted
    expect(parseSavedDraft(raw({ tool: 'laser' }))).toBeNull()
    expect(parseSavedDraft(raw({ points: [{ x: 'a', y: 1 }] }))).toBeNull()
    expect(parseSavedDraft(raw({ tool: 'calibrate', points: [], calibrationPoints: [P(0, 0), P(1, 1), P(2, 2)] }))).toBeNull()
    expect(parseSavedDraft(raw({ pageId: 'other_r2_1' }))).toBeNull()                 // identity and page id must agree
    expect(parseSavedDraft(raw({ page: 0 }))).toBeNull()
    expect(isDraftEmpty(null)).toBe(true)
    expect(isDraftEmpty(draft({ points: [], editing: { measurementId: 'm', revision: 1, points: [P(0, 0)] } }))).toBe(false)
  })

  it('a missing or throwing storage reads nothing and writes nothing, never throws; listing needs an enumerable storage', () => {
    expect(readDraft(null, 'p1', 'd1_r2_1')).toBeNull()
    expect(writeDraft(null, 'p1', draft())).toBe(false)
    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
    expect(readDraft(throwing, 'p1', 'd1_r2_1')).toBeNull()
    expect(writeDraft(throwing, 'p1', draft())).toBe(false)
    expect(clearDraft(throwing, 'p1', 'd1_r2_1')).toBe(false)
    expect(listDrafts(throwing, 'p1')).toEqual([])
    expect(listDrafts(null, 'p1')).toEqual([])
  })

  it('listDrafts returns every remembered draft of ONE project, so other sheets\' work can be named and reopened', () => {
    const s = memStorage()
    writeDraft(s, 'p1', draft())
    writeDraft(s, 'p1', draft({ pageId: 'd9_r1_3', drawingId: 'd9', revisionId: 'r1', page: 3 }))
    writeDraft(s, 'p2', draft({ pageId: 'd2_r1_1', drawingId: 'd2', revisionId: 'r1' }))
    s.setItem('constrapp.quant.draft.p1.junk', 'not json')
    s.setItem('constrapp.quant.selection.p1', '{}')
    expect(listDrafts(s, 'p1').map(d => d.pageId)).toEqual(['d1_r2_1', 'd9_r1_3'])
    expect(listDrafts(s, 'p2').map(d => d.pageId)).toEqual(['d2_r1_1'])
    expect(listDrafts(s, 'p3')).toEqual([])
  })

  it('a geometry edit round-trips with the measurement id and the revision it started from', () => {
    const s = memStorage()
    const e = draft({ tool: 'edit', points: [], editing: { measurementId: 'm1', revision: 3, points: SQUARE } })
    writeDraft(s, 'p1', e)
    expect(readDraft(s, 'p1', 'd1_r2_1')).toEqual(e)
    expect(parseSavedDraft(raw({ tool: 'edit', points: [], editing: { measurementId: 'm', revision: 0, points: [P(0, 0)] } }))).toBeNull()
  })

  it('restorableDraft: the SAME sheet only; an edit only against the same active measurement at the same revision', () => {
    const live = measurement({ id: 'm1', revision: 3 })
    const e = draft({ tool: 'edit', points: [], editing: { measurementId: 'm1', revision: 3, points: CONCAVE } })
    expect(restorableDraft(e, { pageId: 'd1_r2_1', measurements: [live] })).toEqual({ draft: { ...e, editing: { measurement: live, points: CONCAVE } }, droppedEdit: false })
    // Another sheet: nothing restores.
    expect(restorableDraft(e, { pageId: 'd1_r2_2', measurements: [live] })).toBeNull()
    expect(restorableDraft(null, { pageId: 'd1_r2_1' })).toBeNull()
    // The measurement moved on (another user's edit), was voided, or vanished: the edit is dropped and SAID so.
    expect(restorableDraft(e, { pageId: 'd1_r2_1', measurements: [measurement({ id: 'm1', revision: 4 })] })).toEqual({ draft: null, droppedEdit: true })
    expect(restorableDraft(e, { pageId: 'd1_r2_1', measurements: [measurement({ id: 'm1', revision: 3, status: 'void' })] })).toEqual({ draft: null, droppedEdit: true })
    expect(restorableDraft(e, { pageId: 'd1_r2_1', measurements: [] })).toEqual({ draft: null, droppedEdit: true })
    // Draft points survive even when a stale edit beside them is dropped.
    const both = draft({ points: [P(1, 1), P(2, 2)], editing: { measurementId: 'gone', revision: 1, points: SQUARE } })
    expect(restorableDraft(both, { pageId: 'd1_r2_1', measurements: [] })).toEqual({ draft: { ...both, editing: null }, droppedEdit: true })
  })

  it('writes nothing to Firestore and imports no Firebase', () => {
    const lib = stripComments(read('lib/quantDraft.js'))
    expect(lib).not.toMatch(/firebase|firestore|setDoc|updateDoc|runTransaction|localStorage/i)
    expect(lib).toMatch(/^import \{[^}]+\} from '\.\/quant'$/m)
  })
})

// ── 7. Structure pins — the workspace, viewer, overlay and dialogs ──────────

describe('structure — draft protection and navigation in the workspace', () => {
  const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))

  it('unsaved work is exactly: draft points, a calibration pair, or a DIRTY geometry edit — a clean state never prompts', () => {
    // (ADR-54 revision: a session starts from `basePoints` — the measurement's
    // points, or a HOLE's — so a deduction outline edit is judged dirty against
    // the hole it started from, never against its parent.)
    expect(workspace).toContain('const editDirty = !!editing && !samePoints(editing.points, editing.basePoints)')
    expect(workspace).toContain('basePoints: m.points, deductionId: null,')
    expect(workspace).toContain('basePoints: d.points, deductionId: d.id,')
    expect(workspace).toContain('const hasUnsavedWork = draftPoints.length > 0 || calibrationPoints.length > 0 || editDirty')
    expect(workspace).toContain('const confirmDiscard = () => !hasUnsavedWork || window.confirm(DISCARD_MESSAGE)')
  })

  it('changing drawing, revision, page or tool asks first; starting a geometry edit over unsaved work asks too', () => {
    expect(workspace).toContain('const changeDrawing = (id) => { if (!confirmDiscard()) return; resetDrafts();')
    expect(workspace).toContain('const changeRevision = (id) => { if (!confirmDiscard()) return; resetDrafts();')
    expect(workspace).toMatch(/const changePage = \(n\) => \{\s*if \(Number\.isInteger\(n\) && n >= 1 && \(!sheet\.numPages \|\| n <= sheet\.numPages\)\) \{\s*if \(!confirmDiscard\(\)\) return\s*resetDrafts\(\); setPageChoice\(n\); setSelectedId\(null\)/)
    expect(workspace).toMatch(/const chooseTool = \(next\) => \{\s*if \(!confirmDiscard\(\)\) return\s*resetDrafts\(\)/)
    expect(workspace).toMatch(/const startGeometryEdit = \(m\) => \{[\s\S]*?if \(!confirmDiscard\(\)\) return/)
    // Explicit Cancel / Escape discards without a second question.
    expect(workspace).toContain('const cancelDraft = () => { resetDrafts(); setNotice(null) }')
  })

  it('the browser warns before unload while work is unsaved OR a save is in flight; in-app links are held only while saving', () => {
    expect(workspace).toMatch(/useEffect\(\(\) => \{\s*if \(!hasUnsavedWork && pendingSaves === 0\) return undefined\s*const onBeforeUnload = \(e\) => \{ e\.preventDefault\(\); e\.returnValue = '' \}\s*window\.addEventListener\('beforeunload', onBeforeUnload\)\s*return \(\) => window\.removeEventListener\('beforeunload', onBeforeUnload\)\s*\}, \[hasUnsavedWork, pendingSaves\]\)/)
    expect(workspace).toMatch(/useEffect\(\(\) => \{\s*if \(pendingSaves === 0\) return undefined/)
    expect(workspace).toContain("document.addEventListener('click', onClick, true)")
    expect(workspace).toContain("return () => document.removeEventListener('click', onClick, true)")
  })

  it('every save is counted while in flight and still resolves only after the transaction committed', () => {
    expect(workspace).toMatch(/const tracked = async \(work\) => \{\s*setPendingSaves\(n => n \+ 1\)\s*try \{ return await work\(\) \} finally \{ setPendingSaves\(n => n - 1\) \}\s*\}/)
    // calibration, create, details, geometry, review, void — plus, since ADR-54, a
    // deduction save/rename, a deduction outline save and a deduction removal, all
    // through the SAME guarded `updateMeasurement`.
    expect(workspace.match(/await tracked\(\(\) => /g)).toHaveLength(9)
    expect(workspace.match(/await tracked\(\(\) => updateMeasurement\(\{ seen: (live|m), changes: \{ deductions: /g)).toHaveLength(3)
    expect(workspace).not.toMatch(/setNotice\(\{ tone: 'ok'[^\n]*\n[^\n]*await /)
  })

  it('the draft is remembered in sessionStorage per project AND per sheet, restored once per sheet via a microtask, and persisted only after that restore', () => {
    // (1C-B revision: per-sheet keys, so opening another measurement's sheet never touches this one's draft.)
    expect(workspace).toContain("import { readDraft, writeDraft, clearDraft, listDrafts, restorableDraft } from '../../../lib/quantDraft'")
    expect(workspace).toContain('const [restoredFor, setRestoredFor] = useState(null)')
    expect(workspace).toMatch(/if \(!pageId \|\| takeoffMeasurementsLoading \|\| restoredFor === pageId\) return undefined\s*let cancelled = false\s*Promise\.resolve\(\)\.then\(\(\) => \{/)
    expect(workspace).toContain('const saved = readDraft(storage, projectId, pageId)')
    expect(workspace).toContain('const result = restorableDraft(saved, { pageId, measurements: measurementsForPage(takeoffMeasurements, pageId) })')
    expect(workspace).toMatch(/useEffect\(\(\) => \{\s*if \(!pageId \|\| restoredFor !== pageId \|\| !drawingId \|\| !revisionId\) return\s*writeDraft\(browserStorage\(\), projectId, \{\s*pageId,/)
    // Discarding (after the confirmation) clears THIS sheet's entry; other sheets' drafts are listed, never cleared.
    expect(workspace).toMatch(/const resetDrafts = \(\) => \{[\s\S]*?if \(pageId\) clearDraft\(browserStorage\(\), projectId, pageId\)/)
    expect(workspace).toContain('setOtherDrafts(listDrafts(storage, projectId).filter(d => d.pageId !== pageId))')
    expect(workspace).not.toMatch(/localStorage/)
    // No effect writes state synchronously (ADR-41 discipline).
    expect(workspace).not.toMatch(/useEffect\(\(\) => \{\s*set[A-Z]/)
  })

  it('the Select tool hit-tests on tap; measuring and editing taps are refused unless the sheet is measurable', () => {
    expect(workspace).toMatch(/const onTap = \(p, \{ tolerance \}\) => \{\s*if \(editing\) \{\s*if \(!measurable\) return\s*editTap\(p, tolerance\)\s*return\s*\}\s*if \(tool === TOOL\.SELECT\) \{\s*setSelectedId\(hitTestMeasurements\(activeOnPage, p, tolerance\)\)\s*return\s*\}\s*if \(!measurable\) return/)
    // The selection bar offers the EXISTING controls, gated exactly like the list.
    expect(workspace).toContain('{measurable && <Btn sm variant="ghost" onClick={() => setDetailsDialog(selected)}>Details</Btn>}')
    expect(workspace).toContain('{measurable && <Btn sm variant="ghost" onClick={() => startGeometryEdit(selected)}>Geometry</Btn>}')
    expect(workspace).toContain('{voidable && <Btn sm variant="ghost" className="text-brand-red" onClick={() => setVoidDialog(selected)}>Void</Btn>}')
  })

  it('the edit session: history for Undo, a selected vertex for Remove, insert on an edge, markers for counts, Save through the guarded update', () => {
    expect(workspace).toContain('points: insertPointAt(prev.points, seg.index, p), vertex: seg.index + 1')
    expect(workspace).toContain('return { ...prev, history: [...prev.history, prev.points], points: [...prev.points, p], vertex: prev.points.length, pending: null }')
    expect(workspace).toContain('points: removePointAt(prev.points, prev.vertex), vertex: null')
    expect(workspace).toContain('if (!canRemovePoint(editing.kind, editing.points)) {')
    expect(workspace).toMatch(/const undoEdit = \(\) => setEditing\(prev => \{\s*if \(!prev \|\| prev\.history\.length === 0\) return prev/)
    expect(workspace).toContain('const history = prev.pending ? [...prev.history, prev.pending] : prev.history')
    expect(workspace).toContain('<Btn sm onClick={handleSaveGeometry} disabled={!!editError || !editDirty}>Save geometry</Btn>')
    expect(workspace).toContain('const editError = editing ? (validatePoints(editing.kind, editing.points) || quantityIssue(editingQ)) : null')
    // Saving still goes through the one revision-guarded update with the current calibration snapshot.
    expect(workspace).toContain("await tracked(() => updateMeasurement({ seen: editing.measurement, changes: { points: editing.points }, calibration }))")
    expect(workspace).toContain('if (editing.kind !== MEASUREMENT_KIND.COUNT && !calibration) {')
    // Finish is withheld while a draft outline crosses itself.
    expect(workspace).toContain('<Btn sm onClick={finishDraft} disabled={draftPoints.length < MIN_POINTS[tool] || !!draftIssue}>Finish</Btn>')
    // Keyboard: Enter saves, Delete/Backspace removes the selected vertex or undoes, Escape cancels.
    expect(workspace).toContain("if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); if (editing.vertex !== null) removeVertex(); else undoEdit() }")
  })
})

describe('structure — the viewer: one pointer model, anchored zoom, clean listeners', () => {
  const viewer = stripComments(read('pages/project/quant/PageViewer.jsx'))

  it('Ctrl/⌘ + wheel zooms about the cursor through a NON-passive listener that is removed; plain wheel is untouched', () => {
    expect(viewer).toContain("if (!(e.ctrlKey || e.metaKey)) return")
    expect(viewer).toContain("el.addEventListener('wheel', onWheel, { passive: false })")
    expect(viewer).toContain("return () => el.removeEventListener('wheel', onWheel)")
    expect(viewer).toContain('onZoomChange(wheelZoom(zoomRef.current, e.deltaY, e.deltaMode))')
    expect(viewer).toMatch(/anchorRef\.current = \{ x: e\.clientX - rect\.left - el\.clientLeft, y: e\.clientY - rect\.top - el\.clientTop \}/)
  })

  it('every scale change on the same sheet is anchored (pointer, else the centre) in a layout effect through zoomAboutPoint', () => {
    expect(viewer).toContain('useLayoutEffect(() => {')
    expect(viewer).toContain('const anchor = anchorRef.current ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }')
    expect(viewer).toContain('scaleBefore: prev.cssScale, scaleAfter: cssScale,')
    expect(viewer).toContain("if (!el || !prev || prev.pageKey !== pageKey || prev.containerWidth !== containerWidth || prev.cssScale === cssScale) {")
    expect(viewer).toContain('}, [cssScale, pageKey, containerWidth])')
  })

  it('two pointers pinch (coalesced per frame, cancelled on unmount); a second finger ends any tap, drag or pan', () => {
    expect(viewer).toContain('if (pointersRef.current.size === 2) {')
    expect(viewer).toContain("gestureRef.current = { kind: 'pinch', startDistance: pointerDistance(a, b), startZoom: zoomRef.current }")
    expect(viewer).toContain('const next = pinchZoom(g.startZoom, g.startDistance, pointerDistance(a, b))')
    expect(viewer).toContain('frameRef.current = requestAnimationFrame(() => { frameRef.current = 0; onZoomChange(next) })')
    expect(viewer).toContain('useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }, [])')
    // The remaining pointer after a pinch never becomes a tap.
    expect(viewer).toMatch(/if \(g\?\.kind === 'pinch'\) \{\s*if \(pointers\.size < 2\) endGesture\(e\)\s*return\s*\}/)
  })

  it('a drag pans for any touch, or for a mouse/pen only with Select; a mouse slip while measuring places nothing', () => {
    expect(viewer).toContain("const canPanWithMouse = mode === 'select'")
    expect(viewer).toContain("if (g.pointerType === 'touch' || canPanWithMouse) {")
    expect(viewer).toContain("gestureRef.current = { ...g, kind: 'slip' }")
    expect(viewer).toContain('el.scrollLeft = pan.scrollLeft - (e.clientX - pan.x)')
    expect(viewer).toContain('el.scrollTop  = pan.scrollTop  - (e.clientY - pan.y)')
    // A tap is a press that never left the slop; it fires only on release.
    expect(viewer).toContain('if (Math.hypot(e.clientX - g.x, e.clientY - g.y) <= TAP_SLOP_PX) return')
    expect(viewer).toMatch(/if \(g\?\.kind === 'press' && onTap\) \{\s*const p = toCanonical\(e\)\s*endGesture\(e\)\s*if \(p\) onTap\(p, \{ tolerance \}\)/)
  })

  it('in edit mode a press within the 44 px target of the NEAREST vertex starts a drag — never two handles; cancel clears everything', () => {
    expect(viewer).toContain('const tolerance = HIT_TOLERANCE_PX / cssScale')
    expect(viewer).toMatch(/if \(mode === 'edit' && Array\.isArray\(editPoints\) && editPoints\.length > 0\) \{\s*const p = toCanonical\(e\)\s*const hit = p \? nearestVertex\(editPoints, p\) : null\s*if \(hit && hit\.distance <= tolerance\) \{/)
    expect(viewer).toContain("gestureRef.current = { kind: 'drag', index: hit.index }")
    expect(viewer).toContain('onVertexDragStart?.(hit.index)')
    expect(viewer).toMatch(/const onPointerCancel = useCallback\(\(e\) => \{\s*pointersRef\.current\.delete\(e\.pointerId\)\s*endGesture\(e\)/)
    expect(viewer).toContain("if (g?.kind === 'drag') onVertexDragEnd?.()")
    expect(viewer).toContain('e.currentTarget.setPointerCapture?.(e.pointerId)')
    expect(viewer).toContain('if (e) e.currentTarget.releasePointerCapture?.(e.pointerId)')
  })

  it('the overlay is touch-action none so both fingers reach it; coordinates still come from the overlay rect; PDF render cancellation is unchanged', () => {
    expect(viewer).toMatch(/className=\{`relative block select-none touch-none \$\{cursor\}`\}/)
    expect(viewer).toContain('screenToCanonical(e.clientX, e.clientY, rect, geometry.pageWidth, geometry.pageHeight)')
    expect(viewer).toContain('task.cancel()')
    expect(viewer).toContain('}, [pageProxy, cssScale, containerWidth])')
    expect(viewer).not.toMatch(/style=\{\{/)
    // No new dependency for pan/zoom.
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@tailwindcss/vite', 'firebase', 'pdfjs-dist', 'react', 'react-dom', 'react-router-dom', 'recharts', 'tailwindcss'])
  })
})

describe('structure — the overlay handles no pointer events; the selected vertex shows its target', () => {
  const overlay = stripComments(read('pages/project/quant/MeasurementOverlay.jsx'))
  it('is presentation only', () => {
    expect(overlay).toContain('<g pointerEvents="none">')
    expect(overlay).not.toMatch(/onPointer|onClick|onMouse|onTouch/)
    expect(overlay).toContain('const hitR = HIT_TOLERANCE_PX / cssScale')
    expect(overlay).toContain('{i === editing.vertex && (')
    expect(overlay).toContain('measurements.filter(isReadableMeasurement)')
  })
})

describe('structure — the Quant dialogs share the accessible shell (QuantDialog)', () => {
  const shell = stripComments(read('pages/project/quant/QuantDialog.jsx'))
  // The three 1C-A dialogs plus the 1D DeductionDialog (ADR-54).
  const dialogs = ['CalibrationModal.jsx', 'MeasurementEditorModal.jsx', 'MeasurementVoidModal.jsx', 'DeductionDialog.jsx']

  it('QuantDialog: role, aria-modal, accessible name, Escape unless busy, Tab containment via lib/dialogFocus, focus in, focus back', () => {
    expect(shell).toContain('role="dialog" aria-modal="true" aria-labelledby={titleId}')
    expect(shell).toContain("import { tabbableWithin, tabTarget } from '../../../lib/dialogFocus'")
    expect(shell).toMatch(/if \(e\.key === 'Escape'\) \{\s*if \(busy\) return/)
    expect(shell).toContain('tabbable: tabbableWithin(panel),')
    expect(shell).toContain('if (panel && !panel.contains(document.activeElement)) panel.focus()')
    expect(shell).toContain("return () => { if (opener && typeof opener.focus === 'function') opener.focus() }")
    expect(shell).toContain('onClick={busy ? undefined : onClose}')
    expect(shell).toContain('disabled={busy}')
    expect(shell).toContain('<h2 id={titleId}')
  })

  it('each dialog renders through the shell with its own title id, passes its saving state as busy, keeps autoFocus and role="alert" errors, and owns no overlay of its own', () => {
    for (const f of dialogs) {
      const src = stripComments(read(`pages/project/quant/${f}`))
      expect(src, f).toContain("import QuantDialog from './QuantDialog'")
      expect(src, f).toMatch(/<QuantDialog[\s\S]*?busy=\{saving\}/)
      expect(src, f).toMatch(/titleId="quant-[a-z]+-title"/)
      expect(src, f).toContain('autoFocus')
      expect(src, f).toContain('role="alert"')
      expect(src, f).not.toMatch(/modalShellCls|modalCardCls|bg-black\/60|aria-label="Close"/)
    }
    const ids = dialogs.map(f => read(`pages/project/quant/${f}`).match(/titleId="([^"]+)"/)[1])
    expect(new Set(ids).size).toBe(4)
  })

  it('business behaviour is unchanged: the void reason, the calibration acknowledgement, the link clearing', () => {
    expect(stripComments(read('pages/project/quant/MeasurementVoidModal.jsx'))).toContain("if (!reason.trim()) { setError('Enter a reason for voiding this measurement.'); return }")
    const cal = stripComments(read('pages/project/quant/CalibrationModal.jsx'))
    expect(cal).toContain('const needsAck = replacing && affectedCount > 0')
    expect(cal).toContain("if (needsAck && !acknowledged) { setError(")
    const editor = stripComments(read('pages/project/quant/MeasurementEditorModal.jsx'))
    expect(editor).toContain('if (boqItemId && nextId !== costCodeId) {')
    expect(editor).toContain('{issue && <p className="m-0 mt-2 text-[11.5px] text-brand-red" role="alert">{issue}</p>}')
  })

  it('the list names a non-derivable quantity beside its "—" and scrolls the selected row into view', () => {
    const list = stripComments(read('pages/project/quant/MeasurementList.jsx'))
    expect(list).toContain('issue: quantityIssue(q),')
    expect(list.match(/\{issue && /g)).toHaveLength(2)
    expect(list).toContain("el.scrollIntoView?.({ block: 'nearest' })")
    expect(list).toContain('id={`quant-row-${m.id}`}')
    expect(list).toContain('id={`quant-card-${m.id}`}')
  })

  it('no Quant file gained a financial import, a BOQ write or a Firestore write of its own', () => {
    const dir = fileURLToPath(new URL('../../src/pages/project/quant/', import.meta.url))
    const FORBIDDEN = /updateBoqItem|createBoqItem|voidBoqItem|applyBoqQuantity|boqActions|useBudgetLines|formatCurrency|roundMoney|\bsetDoc\(|\bupdateDoc\(|\baddDoc\(|\bdeleteDoc\(|\brunTransaction\(/
    for (const f of readdirSync(dir)) expect(stripComments(read(`pages/project/quant/${f}`)), f).not.toMatch(FORBIDDEN)
    expect(stripComments(read('lib/quant.js'))).not.toMatch(/from 'firebase|setDoc|updateDoc/)
  })
})

// ── 8. Touch targets ─────────────────────────────────────────────────────────

describe('P1 — touch targets: 44 px hit areas, visible handles stay small', () => {
  it('nearest-vertex resolution: two handles 30 px apart on screen cannot both answer; the closer one wins', () => {
    const cssScale = 2 // 1 canonical unit = 2 px
    const tol = HIT_TOLERANCE_PX / cssScale // 11 canonical units = 22 px
    const points = [P(0, 0), P(15, 0)] // 30 px apart on screen
    expect(nearestVertex(points, P(6, 0))).toEqual({ index: 0, distance: 6 })
    expect(nearestVertex(points, P(9, 0))).toEqual({ index: 1, distance: 6 })
    expect(nearestVertex(points, P(7.5, 0)).distance).toBeLessThanOrEqual(tol) // dead centre still hits (one of them)
    expect(nearestVertex(points, P(40, 0)).distance).toBeGreaterThan(tol)       // beyond the target: no drag, a tap instead
  })

  it('the visible handle radius is unchanged at 7 px while the hit radius is 22 px, both in screen pixels at any zoom', () => {
    const overlay = stripComments(read('pages/project/quant/MeasurementOverlay.jsx'))
    expect(overlay).toContain('const HANDLE_PX = 7')
    expect(overlay).toContain('const handleR = HANDLE_PX / cssScale')
    expect(overlay).toContain('const hitR = HIT_TOLERANCE_PX / cssScale')
    expect(HIT_TOLERANCE_PX * 2).toBe(44)
  })

  it('every new workspace control is a real button ≥44px (Btn) or a toolbar button with the shared 44px class', () => {
    const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
    for (const label of ['Remove point', 'Undo', 'Save geometry', 'Clear', 'Select']) expect(workspace).toMatch(new RegExp(`>\\s*${label}\\s*(<|\\{)`))
    expect(workspace).toContain('className={toolBtnCls(tool === TOOL.SELECT && !editing)}')
    expect(stripComments(read('pages/project/quant/styles.js'))).toMatch(/toolBtnCls = \(active\) =>\s*`inline-flex min-h-\[44px\]/)
  })
})

// ── 9. Vocabulary pins ───────────────────────────────────────────────────────

describe('vocabulary', () => {
  it('kinds, polygon problems and quantity problems are closed sets', () => {
    expect(Object.values(MEASUREMENT_KIND)).toEqual(['length', 'area', 'count'])
    expect(POLYGON_PROBLEM).toEqual({ DEGENERATE: 'degenerate', SELF_INTERSECTING: 'self_intersecting' })
    // (ADR-54 revision: five deduction reasons joined the closed set.)
    expect(Object.keys(QUANTITY_PROBLEM).sort()).toEqual([
      'DEDUCTIONS_EXCEED_AREA', 'DEDUCTIONS_OVERLAP', 'DEDUCTION_INVALID', 'DEDUCTION_MALFORMED', 'DEDUCTION_OUTSIDE',
      'DEGENERATE', 'MALFORMED', 'SELF_INTERSECTING', 'TOO_FEW_POINTS',
    ])
    expect(ZOOM_MIN).toBe(0.25)
    expect(ZOOM_MAX).toBe(8)
  })
})
