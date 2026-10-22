import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  QUANT_ROLES, canUseQuant,
  MEASUREMENT_KIND, MEASUREMENT_KINDS, KIND_UNITS, MIN_POINTS, MAX_POINTS, LABEL_MAX, MEASUREMENT_STATUS,
  PAGE_SOURCE, PAGE_ROTATIONS, CALIBRATION_UNITS, CALIBRATION_UNIT_CODES,
  isFinitePoint, isPointList, distance, polylineLength, polygonArea, countPoints,
  toMetres, convertLength, convertArea, validateCalibrationDraft, buildCalibration, isValidCalibration,
  metresPerPageUnit, impliedDrawingScale, calibrationSnapshot, isValidCalibrationSnapshot,
  QUANTITY_STATE, QUANTITY_DECIMALS, roundQuantity, measurementQuantity, originalQuantity, formatMeasurementQuantity,
  CALIBRATION_REVIEW, calibrationReviewState, needsCalibrationReview,
  takeoffPageId, isPageNumber, validatePageGeometry,
  canMeasureOnRevision, isCurrentSource, sourceWarning,
  validateLabel, validatePoints, validateMeasurementDraft, isReadableMeasurement, isReadablePage,
  activeMeasurements, measurementsForPage, sortMeasurements, summariseMeasurements,
  sameRevision, QUANT_ERROR, QUANT_ERROR_MESSAGES, quantErrorKind,
  RENDER_LIMITS, boundedRenderScale, FIT_MODE, fitScale, clampZoom, ZOOM_MIN, ZOOM_MAX, screenToCanonical, pointsToPath,
} from '../../src/lib/quant.js'
import {
  QuantError, runEnsurePage, runSaveCalibration, runCreateMeasurement, runUpdateMeasurement, runVoidMeasurement,
} from '../../src/lib/quantActions.js'
import { openPdf, pageGeometry, canonicalToRendered, renderedToCanonical, canonicalToPdfUserSpace, renderPage, isRenderCancelled } from '../../src/lib/pdfRender.js'
import { boqLineAmount } from '../../src/lib/boq.js'

// ── Constrapp Quant™ 1A — unit suite (ADR-51) ────────────────────────────────
//
// Pure geometry, calibration and validation (lib/quant.js); the revision-
// guarded transactions against an in-memory Firestore stand-in
// (lib/quantActions.js); the PDF.js adapter against a LOCAL two-page fixture
// through the legacy Node build (lib/pdfRender.js) — no Storage, no CORS, no
// canvas; and source-structure pins over the hooks and pages (the keyed
// subscription, the role gate, the absence of any financial or BOQ write).
// Plain Node, no jsdom — the ADR-26 convention.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const readRoot = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
const FIXTURE = fileURLToPath(new URL('./fixtures/quant-two-page.pdf', import.meta.url))

const P = (x, y) => ({ x, y })
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

// A calibration where 100 page units = 1 m (so 1 unit = 10 mm).
const CAL_1M_PER_100 = buildCalibration({ pointA: P(0, 0), pointB: P(100, 0), realDistance: 1, unit: 'm' })
// The same scale stated in millimetres.
const CAL_1000MM_PER_100 = buildCalibration({ pointA: P(10, 10), pointB: P(110, 10), realDistance: 1000, unit: 'mm' })

const page = (overrides = {}) => ({
  id: 'd1_r1_1', drawingId: 'd1', revisionId: 'r1', page: 1,
  source: 'pdf', pageWidth: 612, pageHeight: 792, pageRotation: 0,
  calibration: CAL_1M_PER_100, calibrationRevision: 1,
  calibratedAt: {}, calibratedBy: 'u1', revision: 1, createdAt: { seconds: 1 }, createdBy: 'u1', updatedAt: {}, updatedBy: 'u1',
  ...overrides,
})

const measurement = (overrides = {}) => ({
  id: 'm1', takeoffPageId: 'd1_r1_1', drawingId: 'd1', revisionId: 'r1', page: 1,
  kind: MEASUREMENT_KIND.LENGTH, points: [P(0, 0), P(300, 400)], label: 'Slab edge',
  costCodeId: 'cc1', costCodeName: '03-100 — Concrete', calibration: calibrationSnapshot(page()),
  status: MEASUREMENT_STATUS.ACTIVE, voidReason: '', voidedAt: null, voidedBy: null,
  revision: 1, createdAt: { seconds: 10 }, createdBy: 'u1', updatedAt: {}, updatedBy: 'u1',
  ...overrides,
})

// ── 1. Lengths and areas against hand-calculated values ─────────────────────

describe('geometry — lengths and areas by hand', () => {
  it('distance is Euclidean: a 3-4-5 triangle', () => {
    expect(distance(P(0, 0), P(3, 4))).toBe(5)
    expect(distance(P(-1, -1), P(2, 3))).toBe(5)
  })

  it('polyline length sums consecutive segments and never closes', () => {
    // 0,0 → 3,4 (5) → 3,0 (4) → back is NOT added
    expect(polylineLength([P(0, 0), P(3, 4), P(3, 0)])).toBe(9)
    expect(polylineLength([P(0, 0), P(10, 0)])).toBe(10)
  })

  it('a 3×4 rectangle has area 12 in either winding', () => {
    const cw  = [P(0, 0), P(3, 0), P(3, 4), P(0, 4)]
    const ccw = [...cw].reverse()
    expect(polygonArea(cw)).toBe(12)
    expect(polygonArea(ccw)).toBe(12)
  })

  it('a right triangle has area ½·b·h', () => {
    expect(polygonArea([P(0, 0), P(6, 0), P(0, 3)])).toBe(9)
  })

  it('an L-shape (concave) by shoelace: 6×4 minus the 3×2 notch = 18', () => {
    const L = [P(0, 0), P(6, 0), P(6, 2), P(3, 2), P(3, 4), P(0, 4)]
    expect(polygonArea(L)).toBe(18)
  })

  it('under the 100-units-per-metre calibration a 300×400 diagonal is 5 m and a 3×4 rectangle of 300×400 is 12 m²', () => {
    const len = measurementQuantity({ kind: 'length', points: [P(0, 0), P(300, 400)] }, CAL_1M_PER_100)
    expect(len.state).toBe(QUANTITY_STATE.OK)
    expect(near(len.value, 5)).toBe(true)
    expect(len.unit).toBe('m')
    const area = measurementQuantity({ kind: 'area', points: [P(0, 0), P(300, 0), P(300, 400), P(0, 400)] }, CAL_1M_PER_100)
    expect(near(area.value, 12)).toBe(true)
    expect(area.unit).toBe('m²')
  })
})

// ── 2. Polygon closure and degenerate shapes ────────────────────────────────

describe('geometry — closure and degenerate shapes', () => {
  it('the polygon is implicitly closed; an explicit repeated closing point changes nothing', () => {
    const open   = [P(0, 0), P(3, 0), P(3, 4), P(0, 4)]
    const closed = [...open, P(0, 0)]
    expect(polygonArea(closed)).toBe(polygonArea(open))
  })

  it('collinear points have zero area and are rejected as a degenerate area', () => {
    const line = [P(0, 0), P(1, 1), P(2, 2)]
    expect(polygonArea(line)).toBe(0)
    expect(validatePoints('area', line)).toMatch(/collinear or coincide/)
  })

  it('coincident points have zero length and are rejected', () => {
    expect(polylineLength([P(5, 5), P(5, 5)])).toBe(0)
    expect(validatePoints('length', [P(5, 5), P(5, 5)])).toMatch(/cannot be zero/)
  })

  it('fewer than the minimum points is refused per kind', () => {
    expect(MIN_POINTS).toEqual({ length: 2, area: 3, count: 1 })
    expect(validatePoints('length', [P(0, 0)])).toMatch(/at least 2 points/)
    expect(validatePoints('area', [P(0, 0), P(1, 0)])).toMatch(/at least 3 points/)
    expect(validatePoints('count', [])).toMatch(/at least 1 point/)
    expect(polygonArea([P(0, 0), P(1, 0)])).toBe(0)
  })

  it('a self-intersecting bow-tie is tolerated by the formula (signed areas cancel) — validation rejects the zero result', () => {
    const bowtie = [P(0, 0), P(2, 2), P(2, 0), P(0, 2)]
    expect(polygonArea(bowtie)).toBe(0)
    expect(validatePoints('area', bowtie)).not.toBeNull()
  })

  it('more than MAX_POINTS is refused', () => {
    const many = Array.from({ length: MAX_POINTS + 1 }, (_, i) => P(i, (i * 7) % 13))
    expect(validatePoints('length', many)).toMatch(/Too many points/)
    expect(validatePoints('length', many.slice(0, MAX_POINTS))).toBeNull()
  })
})

// ── 3. Counts ────────────────────────────────────────────────────────────────

describe('counts', () => {
  it('a count is the number of points and needs no calibration', () => {
    const q = measurementQuantity({ kind: 'count', points: [P(1, 1), P(2, 2), P(3, 3)] }, null)
    expect(q).toEqual({ value: 3, unit: 'no.', state: QUANTITY_STATE.OK })
    expect(countPoints([P(0, 0)])).toBe(1)
    expect(countPoints('nope')).toBe(0)
  })

  it('a count never carries a calibration snapshot and is never flagged for scale review', () => {
    const m = measurement({ kind: 'count', points: [P(1, 1)], calibration: null })
    expect(calibrationReviewState(m, page({ calibrationRevision: 9 }))).toBe(CALIBRATION_REVIEW.NOT_APPLICABLE)
    expect(calibrationReviewState(m, null)).toBe(CALIBRATION_REVIEW.NOT_APPLICABLE)
  })
})

// ── 4. Calibration with mm and metres ────────────────────────────────────────

describe('calibration', () => {
  it('only mm and m exist, with their metre factors', () => {
    expect(CALIBRATION_UNIT_CODES).toEqual(['mm', 'm'])
    expect(CALIBRATION_UNITS.mm.metres).toBe(0.001)
    expect(CALIBRATION_UNITS.m.metres).toBe(1)
  })

  it('a known distance in mm and the same in m produce the same metres per page unit', () => {
    expect(near(metresPerPageUnit(CAL_1M_PER_100), 0.01)).toBe(true)
    expect(near(metresPerPageUnit(CAL_1000MM_PER_100), 0.01)).toBe(true)
  })

  it('buildCalibration derives pageDistance from the points and stores exactly five fields', () => {
    expect(CAL_1M_PER_100).toEqual({ pointA: P(0, 0), pointB: P(100, 0), pageDistance: 100, realDistance: 1, unit: 'm' })
    const diag = buildCalibration({ pointA: P(0, 0), pointB: P(30, 40), realDistance: '2500', unit: 'mm' })
    expect(diag.pageDistance).toBe(50)
    expect(diag.realDistance).toBe(2500) // numeric string coerced once, here
  })

  it('a 3.6 m wall drawn 36 units long under the 100/m scale measures 3.6 m', () => {
    const cal = buildCalibration({ pointA: P(0, 0), pointB: P(36, 0), realDistance: 3600, unit: 'mm' })
    const q = measurementQuantity({ kind: 'length', points: [P(0, 0), P(36, 0)] }, cal)
    expect(near(q.value, 3.6)).toBe(true)
  })

  it('the implied drawing scale is reported for PDF pages only (points → 1:N) and null for images', () => {
    // 100 pt = 1 m. 100 pt = 100/72 in = 0.035277… m → ratio ≈ 28.35
    expect(impliedDrawingScale(CAL_1M_PER_100, 'pdf')).toBe('1:28')
    // 1 m drawn at 1:100 is 10 mm = 28.3465 pt
    const at100 = buildCalibration({ pointA: P(0, 0), pointB: P(28.3465, 0), realDistance: 1, unit: 'm' })
    expect(impliedDrawingScale(at100, 'pdf')).toBe('1:100')
    expect(impliedDrawingScale(CAL_1M_PER_100, 'image')).toBeNull()
    expect(impliedDrawingScale(null, 'pdf')).toBeNull()
  })

  it('zero-length segments and invalid dimensions are refused', () => {
    expect(validateCalibrationDraft({ pointA: P(1, 1), pointB: P(1, 1), realDistance: 5, unit: 'm' })).toMatch(/must be different/)
    expect(validateCalibrationDraft({ pointA: P(0, 0), pointB: P(1, 0), realDistance: 0, unit: 'm' })).toMatch(/greater than zero/)
    expect(validateCalibrationDraft({ pointA: P(0, 0), pointB: P(1, 0), realDistance: -3, unit: 'm' })).toMatch(/greater than zero/)
    expect(validateCalibrationDraft({ pointA: P(0, 0), pointB: P(1, 0), realDistance: '', unit: 'm' })).toMatch(/as a number/)
    expect(validateCalibrationDraft({ pointA: P(0, 0), pointB: P(1, 0), realDistance: 'abc', unit: 'm' })).toMatch(/as a number/)
    expect(validateCalibrationDraft({ pointA: P(0, 0), pointB: P(1, 0), realDistance: 5, unit: 'ft' })).toMatch(/millimetres or metres/)
    expect(validateCalibrationDraft({ pointA: null, pointB: P(1, 0), realDistance: 5, unit: 'm' })).toMatch(/two points/)
    expect(buildCalibration({ pointA: P(1, 1), pointB: P(1, 1), realDistance: 5, unit: 'm' })).toBeNull()
  })

  it('isValidCalibration accepts only positive finite distances and a known unit', () => {
    expect(isValidCalibration(CAL_1M_PER_100)).toBe(true)
    expect(isValidCalibration({ ...CAL_1M_PER_100, pageDistance: 0 })).toBe(false)
    expect(isValidCalibration({ ...CAL_1M_PER_100, realDistance: Infinity })).toBe(false)
    expect(isValidCalibration({ ...CAL_1M_PER_100, unit: 'in' })).toBe(false)
    expect(isValidCalibration(null)).toBe(false)
    expect(isValidCalibration('1:100')).toBe(false)
  })
})

// ── 5. Zoom-independent measurements ─────────────────────────────────────────

describe('zoom independence — screen → canonical', () => {
  const W = 612, H = 792
  it('the same sheet position maps to the same canonical point at every rendered size', () => {
    const small = { left: 0, top: 0, width: 306, height: 396 }   // 0.5 px/unit
    const large = { left: 100, top: 50, width: 2448, height: 3168 } // 4 px/unit, offset
    const a = screenToCanonical(76.5, 99, small, W, H)
    const b = screenToCanonical(100 + 612, 50 + 792, large, W, H)
    expect(near(a.x, 153)).toBe(true); expect(near(a.y, 198)).toBe(true)
    expect(near(b.x, 153)).toBe(true); expect(near(b.y, 198)).toBe(true)
  })

  it('a quantity does not change when the rendered scale changes (geometry is canonical)', () => {
    const pts = [P(0, 0), P(300, 400)]
    const q1 = measurementQuantity({ kind: 'length', points: pts }, CAL_1M_PER_100)
    const rendered = pts.map(p => canonicalToRendered(p, 3.25)).map(p => renderedToCanonical(p, 3.25))
    const q2 = measurementQuantity({ kind: 'length', points: rendered }, CAL_1M_PER_100)
    expect(near(q1.value, q2.value, 1e-9)).toBe(true)
  })

  it('points are clamped to the page and an unusable rect yields null', () => {
    const rect = { left: 0, top: 0, width: 612, height: 792 }
    expect(screenToCanonical(-50, 5000, rect, W, H)).toEqual({ x: 0, y: H })
    expect(screenToCanonical(10, 10, { left: 0, top: 0, width: 0, height: 0 }, W, H)).toBeNull()
    expect(screenToCanonical(10, 10, null, W, H)).toBeNull()
  })

  it('fit and zoom are display-only numbers with bounds', () => {
    expect(fitScale(612, 792, 1224, 0, FIT_MODE.WIDTH)).toBe(2)
    expect(fitScale(612, 792, 1224, 396, FIT_MODE.PAGE)).toBe(0.5)
    expect(fitScale(0, 792, 1224, 396)).toBe(1)
    expect(clampZoom(0.01)).toBe(ZOOM_MIN)
    expect(clampZoom(100)).toBe(ZOOM_MAX)
    expect(clampZoom(NaN)).toBe(1)
  })

  it('the render scale is bounded by edge and pixel limits so a huge sheet never overflows the canvas', () => {
    expect(boundedRenderScale(612, 792, 2)).toBe(2)
    // An A0 sheet (3370×2384 pt) at 8× would be 26960 px wide → capped to whichever
    // bound is tighter (here the 32 MP pixel cap, below the 8192 px edge cap)
    const a0 = boundedRenderScale(3370, 2384, 8, RENDER_LIMITS.desktop)
    expect(near(a0, Math.min(8192 / 3370, Math.sqrt(32_000_000 / (3370 * 2384))))).toBe(true)
    expect(a0 * 3370).toBeLessThanOrEqual(8192)
    expect(a0 * a0 * 3370 * 2384).toBeLessThanOrEqual(32_000_000 + 1)
    // Touch limits are tighter
    expect(boundedRenderScale(3370, 2384, 8, RENDER_LIMITS.touch)).toBeLessThan(boundedRenderScale(3370, 2384, 8, RENDER_LIMITS.desktop))
    // Pixel cap binds for a near-square sheet
    const s = boundedRenderScale(5000, 5000, 2, { maxEdge: 100000, maxPixels: 25_000_000 })
    expect(near(s, 1)).toBe(true)
    expect(boundedRenderScale(0, 10, 1)).toBe(0)
    expect(boundedRenderScale(10, 10, -1)).toBe(0)
  })
})

// ── 6. PDF transformations and rotation (local fixture, legacy build) ───────

describe('PDF.js adapter against the local two-page fixture', () => {
  async function withFixture(fn) {
    const data = new Uint8Array(readFileSync(FIXTURE))
    const pdf = await openPdf(pdfjs, data)
    try { await fn(pdf) } finally { pdf.destroy() }
  }

  it('opens the fixture and reports two pages; destroy() is exposed for cleanup', async () => {
    await withFixture(async (pdf) => {
      expect(pdf.numPages).toBe(2)
      expect(typeof pdf.destroy).toBe('function')
    })
  })

  it('page 1 (portrait, no rotation) has the canonical geometry 612×792, rotation 0, source pdf', async () => {
    await withFixture(async (pdf) => {
      const p1 = await pdf.getPage(1)
      expect(pageGeometry(p1)).toEqual({ source: PAGE_SOURCE.PDF, pageWidth: 612, pageHeight: 792, pageRotation: 0 })
      p1.cleanup()
    })
  })

  it('page 2 (landscape MediaBox, /Rotate 90, CropBox) is canonically 500×750 with rotation 90 — a non-square rotated page', async () => {
    await withFixture(async (pdf) => {
      const p2 = await pdf.getPage(2)
      const g = pageGeometry(p2)
      expect(g).toEqual({ source: PAGE_SOURCE.PDF, pageWidth: 500, pageHeight: 750, pageRotation: 90 })
      expect(PAGE_ROTATIONS).toContain(g.pageRotation)
      // The canonical origin is the CropBox corner as rotated — PDF user space (50, 50).
      expect(canonicalToPdfUserSpace(p2, P(0, 0))).toEqual({ x: 50, y: 50 })
      expect(canonicalToPdfUserSpace(p2, P(500, 750))).toEqual({ x: 800, y: 550 })
      p2.cleanup()
    })
  })

  it('the KNOWN rectangles of the acceptance fixture land where the canonical contract says (rotation + CropBox)', async () => {
    await withFixture(async (pdf) => {
      // Page 1: user-space rect (100,100)–(500,400) → canonical (100,392)–(500,692): 400 wide, 300 tall.
      const p1 = await pdf.getPage(1)
      const v1 = p1.getViewport({ scale: 1 })
      expect(v1.convertToViewportPoint(100, 100)).toEqual([100, 692])
      expect(v1.convertToViewportPoint(500, 400)).toEqual([500, 392])
      const bottom1 = distance(P(100, 692), P(500, 692))
      expect(bottom1).toBe(400)
      // Calibrating that 400 pt edge as 4000 mm makes the rectangle 4 × 3 m: perimeter 14 m, area 12 m², diagonal 5 m.
      const cal1 = buildCalibration({ pointA: P(100, 692), pointB: P(500, 692), realDistance: 4000, unit: 'mm' })
      const rect1 = [P(100, 392), P(500, 392), P(500, 692), P(100, 692)]
      expect(near(measurementQuantity({ kind: 'area', points: rect1 }, cal1).value, 12)).toBe(true)
      expect(near(measurementQuantity({ kind: 'length', points: [...rect1, rect1[0]] }, cal1).value, 14)).toBe(true)
      expect(near(measurementQuantity({ kind: 'length', points: [P(100, 392), P(500, 692)] }, cal1).value, 5)).toBe(true)
      p1.cleanup()

      // Page 2: user-space rect (100,100)–(700,500) under /Rotate 90 + CropBox [50 50 800 550]
      // → canonical (50,50)–(450,650): 400 wide × 600 tall on screen.
      const p2 = await pdf.getPage(2)
      const v2 = p2.getViewport({ scale: 1 })
      expect(v2.convertToViewportPoint(100, 100)).toEqual([50, 50])
      expect(v2.convertToViewportPoint(700, 500)).toEqual([450, 650])
      expect(v2.convertToViewportPoint(700, 100)).toEqual([50, 650])
      const cal2 = buildCalibration({ pointA: P(50, 650), pointB: P(450, 650), realDistance: 4000, unit: 'mm' })
      const rect2 = [P(50, 50), P(450, 50), P(450, 650), P(50, 650)]
      expect(near(measurementQuantity({ kind: 'area', points: rect2 }, cal2).value, 24)).toBe(true)
      expect(near(measurementQuantity({ kind: 'length', points: [...rect2, rect2[0]] }, cal2).value, 20)).toBe(true)
      // The same calibration stated in metres gives the same answer.
      const cal2m = buildCalibration({ pointA: P(50, 650), pointB: P(450, 650), realDistance: 4, unit: 'm' })
      expect(near(measurementQuantity({ kind: 'area', points: rect2 }, cal2m).value, 24)).toBe(true)
      p2.cleanup()
    })
  })

  it('page 1 canonical → PDF user space flips y (origin bottom-left in PDF space)', async () => {
    await withFixture(async (pdf) => {
      const p1 = await pdf.getPage(1)
      const u = canonicalToPdfUserSpace(p1, P(100, 100))
      expect(u.x).toBe(100)
      expect(u.y).toBe(692)
      p1.cleanup()
    })
  })

  it('the viewport at scale 2 is exactly 2× the canonical viewport, so the overlay scales by one number', async () => {
    await withFixture(async (pdf) => {
      const p2 = await pdf.getPage(2)
      const v1 = p2.getViewport({ scale: 1 })
      const v2 = p2.getViewport({ scale: 2 })
      expect(v2.width).toBe(v1.width * 2)
      expect(v2.height).toBe(v1.height * 2)
      // The same PDF point is reached from canonical (100,100) and rendered (200,200)@2
      expect(v1.convertToPdfPoint(100, 100)).toEqual(v2.convertToPdfPoint(200, 200))
      p2.cleanup()
    })
  })

  it('renderPage sizes only the canvas backing store, bounded, and returns a cancellable task', () => {
    const fakePage = {
      getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
      render: ({ canvas, viewport }) => ({ promise: Promise.resolve({ canvas, viewport }), cancel: () => {} }),
    }
    const canvas = { style: {} }
    const { task, renderScale } = renderPage(fakePage, canvas, { cssScale: 1.5, devicePixelRatio: 2 })
    expect(renderScale).toBe(3)
    expect(canvas.width).toBe(1836)
    expect(canvas.height).toBe(2376)
    expect(canvas.style).toEqual({}) // CSS box is the layout's, never set here
    expect(typeof task.cancel).toBe('function')
    // Capped: a huge sheet on touch limits
    const big = { ...fakePage, getViewport: ({ scale }) => ({ width: 3370 * scale, height: 2384 * scale }) }
    const r = renderPage(big, { style: {} }, { cssScale: 4, devicePixelRatio: 3, limits: RENDER_LIMITS.touch })
    expect(r.renderScale).toBeLessThan(12)
    expect(near(r.renderScale, 4096 / 3370) || r.renderScale < 4096 / 3370).toBe(true)
    expect(isRenderCancelled({ name: 'RenderingCancelledException' })).toBe(true)
    expect(isRenderCancelled(new Error('x'))).toBe(false)
  })
})

// ── 7. Image intrinsic coordinates ───────────────────────────────────────────

describe('image pages', () => {
  it('an image page is its intrinsic pixel box with rotation 0, and validates like a PDF page', () => {
    const g = { source: PAGE_SOURCE.IMAGE, pageWidth: 4961, pageHeight: 3508, pageRotation: 0 }
    expect(validatePageGeometry(g)).toBeNull()
    expect(impliedDrawingScale(CAL_1M_PER_100, PAGE_SOURCE.IMAGE)).toBeNull()
  })

  it('page geometry refuses unknown sources, non-positive sizes and odd rotations', () => {
    expect(validatePageGeometry({ source: 'svg', pageWidth: 1, pageHeight: 1, pageRotation: 0 })).toMatch(/source/)
    expect(validatePageGeometry({ source: 'image', pageWidth: 0, pageHeight: 1, pageRotation: 0 })).toMatch(/width/)
    expect(validatePageGeometry({ source: 'image', pageWidth: 1, pageHeight: -1, pageRotation: 0 })).toMatch(/height/)
    expect(validatePageGeometry({ source: 'pdf', pageWidth: 1, pageHeight: 1, pageRotation: 45 })).toMatch(/rotation/)
    expect(validatePageGeometry({ source: 'pdf', pageWidth: 1, pageHeight: 1, pageRotation: 270 })).toBeNull()
  })

  it('the viewer reads an image through <img> (no bytes, no CORS) and a PDF through getFileBytes', () => {
    const viewer = stripComments(read('pages/project/quant/PageViewer.jsx'))
    expect(viewer).toContain('getFileUrl(storagePath)')
    expect(viewer).toContain('getFileBytes(storagePath)')
    expect(viewer).toContain('onLoad={onImageLoad}')
    expect(viewer).toContain('img.naturalWidth')
    expect(viewer).toContain('source: PAGE_SOURCE.IMAGE')
  })
})

// ── 8. Scale changes and review flags ───────────────────────────────────────

describe('re-calibration — review flags and provenance', () => {
  it('a measurement saved under calibration revision 1 is CURRENT on that page and NEEDS REVIEW after a re-calibration', () => {
    const m = measurement()
    expect(calibrationReviewState(m, page())).toBe(CALIBRATION_REVIEW.CURRENT)
    const recal = buildCalibration({ pointA: P(0, 0), pointB: P(50, 0), realDistance: 1, unit: 'm' }) // 50 units = 1 m
    const pg = page({ calibration: recal, calibrationRevision: 2, revision: 2 })
    expect(calibrationReviewState(m, pg)).toBe(CALIBRATION_REVIEW.NEEDS_REVIEW)
    expect(needsCalibrationReview(m, pg)).toBe(true)
  })

  it('after a re-calibration the CURRENT quantity doubles and the ORIGINAL stays explainable from the snapshot — nothing stored', () => {
    const m = measurement() // 500 units diagonal
    const recal = buildCalibration({ pointA: P(0, 0), pointB: P(50, 0), realDistance: 1, unit: 'm' })
    const pg = page({ calibration: recal, calibrationRevision: 2 })
    expect(near(measurementQuantity(m, pg.calibration).value, 10)).toBe(true)
    expect(near(originalQuantity(m).value, 5)).toBe(true)
    expect(Object.keys(m)).not.toContain('quantity')
    expect(Object.keys(m)).not.toContain('value')
  })

  it('an uncalibrated page makes a length UNCALIBRATED (null, never 0) and a count still counts', () => {
    const pg = page({ calibration: null, calibrationRevision: 0 })
    const len = measurementQuantity(measurement(), pg.calibration)
    expect(len).toEqual({ value: null, unit: 'm', state: QUANTITY_STATE.UNCALIBRATED })
    expect(calibrationReviewState(measurement(), pg)).toBe(CALIBRATION_REVIEW.UNCALIBRATED)
    expect(measurementQuantity({ kind: 'count', points: [P(1, 1)] }, null).value).toBe(1)
  })

  it('the snapshot carries exactly the ratio and the revision, and is valid only with a positive revision', () => {
    expect(calibrationSnapshot(page())).toEqual({ revision: 1, pageDistance: 100, realDistance: 1, unit: 'm' })
    expect(calibrationSnapshot(page({ calibration: null, calibrationRevision: 0 }))).toBeNull()
    expect(isValidCalibrationSnapshot({ revision: 0, pageDistance: 1, realDistance: 1, unit: 'm' })).toBe(false)
    expect(isValidCalibrationSnapshot({ revision: 3, pageDistance: 1, realDistance: 1, unit: 'm' })).toBe(true)
  })

  it('the calibration dialog demands an explicit acknowledgement before replacing a calibration that measurements depend on', () => {
    const modal = stripComments(read('pages/project/quant/CalibrationModal.jsx'))
    expect(modal).toContain('const needsAck = replacing && affectedCount > 0')
    expect(modal).toContain("if (needsAck && !acknowledged) { setError(")
    expect(modal).toMatch(/Nothing is re-scaled silently/)
  })
})

// ── 9. Unit conversion ───────────────────────────────────────────────────────

describe('metric unit conversion', () => {
  it('lengths convert between mm and m exactly', () => {
    expect(toMetres(2500, 'mm')).toBe(2.5)
    expect(toMetres(2.5, 'm')).toBe(2.5)
    expect(convertLength(1, 'm', 'mm')).toBe(1000)
    expect(convertLength(1500, 'mm', 'm')).toBe(1.5)
    expect(convertLength(7, 'm', 'm')).toBe(7)
  })

  it('areas convert by the square of the factor', () => {
    expect(convertArea(1, 'm', 'mm')).toBe(1_000_000)
    expect(near(convertArea(2_000_000, 'mm', 'm'), 2)).toBe(true)
  })

  it('unknown units and non-finite values yield NaN rather than a wrong number', () => {
    expect(Number.isNaN(toMetres(1, 'ft'))).toBe(true)
    expect(Number.isNaN(convertLength(1, 'mm', 'in'))).toBe(true)
    expect(Number.isNaN(toMetres(Infinity, 'm'))).toBe(true)
    expect(Number.isNaN(convertArea('2', 'm', 'mm'))).toBe(true)
  })

  it('output units are fixed: m, m², no.', () => {
    expect(KIND_UNITS).toEqual({ length: 'm', area: 'm²', count: 'no.' })
  })
})

// ── 10. Three-decimal display behaviour ─────────────────────────────────────

describe('quantity precision and display', () => {
  it('rounds to three decimals, half away from zero, like the BOQ quantity convention', () => {
    expect(QUANTITY_DECIMALS).toBe(3)
    expect(roundQuantity(1.23456)).toBe(1.235)
    expect(roundQuantity(1.2344)).toBe(1.234)
    expect(roundQuantity(0.0005)).toBe(0.001)
    expect(roundQuantity(12)).toBe(12)
    expect(roundQuantity(NaN)).toBeNull()
    expect(roundQuantity('1.2')).toBeNull()
  })

  it('formats with the unit and three decimals max, never a currency symbol, and "—" when unknown', () => {
    expect(formatMeasurementQuantity({ value: 5.123456, unit: 'm' })).toBe('5.123 m')
    expect(formatMeasurementQuantity({ value: 12, unit: 'm²' })).toBe('12 m²')
    expect(formatMeasurementQuantity({ value: 3, unit: 'no.' })).toBe('3 no.')
    expect(formatMeasurementQuantity({ value: null, unit: 'm' })).toBe('—')
    expect(formatMeasurementQuantity(null)).toBe('—')
    expect(formatMeasurementQuantity({ value: 1234.5, unit: 'm' })).not.toMatch(/\$/)
  })

  it('the raw derived value stays UNROUNDED — rounding is a display (or later BOQ-write) decision', () => {
    const q = measurementQuantity({ kind: 'length', points: [P(0, 0), P(123.456789, 0)] }, CAL_1M_PER_100)
    expect(q.value).toBeCloseTo(1.23456789, 10)
  })
})

// ── 11. NaN / Infinity / zero / negative refusal ─────────────────────────────

describe('hostile numbers are refused', () => {
  it('points must be finite numbers', () => {
    expect(isFinitePoint(P(NaN, 1))).toBe(false)
    expect(isFinitePoint(P(1, Infinity))).toBe(false)
    expect(isFinitePoint({ x: '1', y: 2 })).toBe(false)
    expect(isFinitePoint(P(0, -5))).toBe(true) // negative coordinates are legal geometry
    expect(isPointList([P(1, 1), null])).toBe(false)
    expect(isPointList('[]')).toBe(false)
    expect(Number.isNaN(distance(P(NaN, 0), P(1, 1)))).toBe(true)
  })

  it('a measurement with non-finite points is INVALID, never a number', () => {
    const q = measurementQuantity({ kind: 'area', points: [P(0, 0), P(1, 0), P(1, NaN)] }, CAL_1M_PER_100)
    expect(q).toEqual({ value: null, unit: 'm²', state: QUANTITY_STATE.INVALID })
    expect(validatePoints('area', [P(0, 0), P(1, 0), P(1, Infinity)])).toMatch(/not valid/)
  })

  it('a calibration with a zero, negative, NaN or infinite page distance is invalid and yields NaN scale', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const cal = { ...CAL_1M_PER_100, pageDistance: bad }
      expect(isValidCalibration(cal)).toBe(false)
      expect(Number.isNaN(metresPerPageUnit(cal))).toBe(true)
    }
    expect(measurementQuantity(measurement(), { ...CAL_1M_PER_100, realDistance: -2 }).state).toBe(QUANTITY_STATE.UNCALIBRATED)
  })

  it('an unknown kind is INVALID', () => {
    expect(measurementQuantity({ kind: 'volume', points: [P(0, 0)] }, CAL_1M_PER_100).state).toBe(QUANTITY_STATE.INVALID)
    expect(validatePoints('volume', [P(0, 0)])).toMatch(/Choose a measurement type/)
    expect(MEASUREMENT_KINDS).toEqual(['length', 'area', 'count'])
  })
})

// ── 12. Malformed stored records ─────────────────────────────────────────────

describe('malformed stored records', () => {
  it('a readable measurement needs every field the viewer relies on', () => {
    expect(isReadableMeasurement(measurement())).toBe(true)
    expect(isReadableMeasurement(measurement({ points: 'oops' }))).toBe(false)
    expect(isReadableMeasurement(measurement({ points: [P(1, 1), { x: 'a', y: 1 }] }))).toBe(false)
    expect(isReadableMeasurement(measurement({ kind: 'volume' }))).toBe(false)
    expect(isReadableMeasurement(measurement({ label: 7 }))).toBe(false)
    expect(isReadableMeasurement(measurement({ costCodeId: '' }))).toBe(false)
    expect(isReadableMeasurement(measurement({ status: 'draft' }))).toBe(false)
    expect(isReadableMeasurement(measurement({ calibration: { revision: 0 } }))).toBe(false)
    expect(isReadableMeasurement(measurement({ kind: 'count', calibration: null }))).toBe(true)
    expect(isReadableMeasurement(null)).toBe(false)
  })

  it('a readable page needs identity, geometry and a non-negative calibration revision', () => {
    expect(isReadablePage(page())).toBe(true)
    expect(isReadablePage(page({ calibration: null, calibrationRevision: 0 }))).toBe(true)
    expect(isReadablePage(page({ page: 0 }))).toBe(false)
    expect(isReadablePage(page({ pageWidth: -1 }))).toBe(false)
    expect(isReadablePage(page({ calibrationRevision: -1 }))).toBe(false)
    expect(isReadablePage(page({ calibration: { pageDistance: 0 } }))).toBe(false)
  })

  it('summaries skip unreadable records and count incomplete ones separately from totals', () => {
    const list = [
      measurement(),                                       // 5 m
      measurement({ id: 'm2', points: 'junk' }),           // unreadable — skipped
      measurement({ id: 'm3', kind: 'count', points: [P(1, 1), P(2, 2)], calibration: null }),
      measurement({ id: 'm4', status: 'void' }),           // void — excluded
    ]
    const s = summariseMeasurements(list, CAL_1M_PER_100)
    expect(s.length).toMatchObject({ count: 1, incomplete: 0, unit: 'm' })
    expect(near(s.length.total, 5)).toBe(true)
    expect(s.count).toMatchObject({ count: 1, total: 2 })
    expect(s.area).toMatchObject({ count: 0, total: 0 })
    const uncal = summariseMeasurements([measurement()], null)
    expect(uncal.length).toMatchObject({ count: 1, incomplete: 1, total: 0 })
  })

  it('the list tells the user how many records could not be read instead of drawing them', () => {
    const list = stripComments(read('pages/project/quant/MeasurementList.jsx'))
    expect(list).toContain('const readable   = sorted.filter(isReadableMeasurement)')
    expect(list).toMatch(/could not be read/)
    const overlay = stripComments(read('pages/project/quant/MeasurementOverlay.jsx'))
    expect(overlay).toContain('measurements.filter(isReadableMeasurement)')
  })
})

// ── In-memory Firestore stand-in for the guarded transactions ───────────────

function fakeFirestore({ failWith = null } = {}) {
  const store = new Map()
  const ref = (path) => ({ path, id: path.split('/').pop() })
  const runTransaction = async (_db, body) => {
    if (failWith) throw Object.assign(new Error(failWith), { code: failWith })
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

const IDENTITY = { drawingId: 'd1', revisionId: 'r1', page: 2 }
const GEOMETRY = { source: 'pdf', pageWidth: 500, pageHeight: 750, pageRotation: 90 }
const PAGE_PATH = 'companies/c/projects/p/takeoffPages/d1_r1_2'
const CAL_DRAFT = { pointA: P(0, 0), pointB: P(100, 0), realDistance: 1, unit: 'm' }

const expectKind = async (promise, kind) => {
  let caught = null
  try { await promise } catch (err) { caught = err }
  expect(caught).toBeInstanceOf(QuantError)
  expect(caught.kind).toBe(kind)
  expect(caught.message).toBeTruthy()
}

// ── 13. Persisted measurement lifecycle ──────────────────────────────────────

describe('persisted lifecycle — guarded transactions', () => {
  it('first calibration creates the page at revision 1 / calibrationRevision 1 with the exact schema', async () => {
    const f = fakeFirestore()
    const out = await runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, draft: CAL_DRAFT, seenPage: null, uid: 'u1' })
    expect(out).toEqual({ kind: null, revision: 1, calibrationRevision: 1 })
    const doc = f.store.get(PAGE_PATH)
    expect(Object.keys(doc).sort()).toEqual([
      'calibratedAt', 'calibratedBy', 'calibration', 'calibrationRevision', 'createdAt', 'createdBy',
      'drawingId', 'page', 'pageHeight', 'pageRotation', 'pageWidth', 'revision', 'revisionId', 'source', 'updatedAt', 'updatedBy',
    ])
    expect(doc.calibration).toEqual(buildCalibration(CAL_DRAFT))
    expect(doc.calibratedBy).toBe('u1')
    expect(doc.createdAt).toEqual({ __serverTimestamp: true })
  })

  it('ensurePage creates an UNCALIBRATED page once and returns the existing one afterwards', async () => {
    const f = fakeFirestore()
    const first = await runEnsurePage({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, uid: 'u1' })
    expect(first.created).toBe(true)
    expect(first.page).toMatchObject({ calibration: null, calibrationRevision: 0, revision: 1 })
    const again = await runEnsurePage({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, uid: 'u2' })
    expect(again.created).toBe(false)
    expect(f.store.get(PAGE_PATH).createdBy).toBe('u1')
  })

  it('create → edit geometry → rename → void, each exactly +1 revision, created stamps untouched', async () => {
    const f = fakeFirestore()
    await runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, draft: CAL_DRAFT, seenPage: null, uid: 'u1' })
    const seenPage = { revision: 1 }
    const mRef = f.ref('companies/c/projects/p/takeoffMeasurements/m1')
    const created = await runCreateMeasurement({
      ...f, pageRef: f.ref(PAGE_PATH), measurementRef: mRef, identity: IDENTITY, seenPage, uid: 'u1',
      draft: { kind: 'length', points: [P(0, 0), P(300, 400)], label: '  Slab edge ', costCodeId: 'cc1', costCodeName: ' 03-100 — Concrete ' },
    })
    expect(created).toEqual({ kind: null, revision: 1, id: 'm1' })
    let doc = f.store.get(mRef.path)
    expect(doc).toMatchObject({
      takeoffPageId: 'd1_r1_2', drawingId: 'd1', revisionId: 'r1', page: 2, kind: 'length',
      label: 'Slab edge', costCodeId: 'cc1', costCodeName: '03-100 — Concrete',
      calibration: { revision: 1, pageDistance: 100, realDistance: 1, unit: 'm' },
      status: 'active', voidReason: '', voidedAt: null, voidedBy: null, revision: 1, createdBy: 'u1',
    })
    expect(Object.keys(doc)).not.toContain('quantity')

    const r2 = await runUpdateMeasurement({ ...f, ref: mRef, seen: { ...doc, revision: 1 }, changes: { points: [P(0, 0), P(600, 800)] }, calibration: { revision: 1, pageDistance: 100, realDistance: 1, unit: 'm' }, uid: 'u2' })
    expect(r2.revision).toBe(2)
    doc = f.store.get(mRef.path)
    expect(doc.points).toEqual([P(0, 0), P(600, 800)])
    expect(doc.updatedBy).toBe('u2')
    expect(doc.createdBy).toBe('u1')

    const r3 = await runUpdateMeasurement({ ...f, ref: mRef, seen: { ...doc }, changes: { label: 'Slab edge north' }, uid: 'u2' })
    expect(r3.revision).toBe(3)
    expect(f.store.get(mRef.path).label).toBe('Slab edge north')
    // A rename leaves the calibration snapshot alone (not silently "reviewed").
    expect(f.store.get(mRef.path).calibration.revision).toBe(1)

    const r4 = await runVoidMeasurement({ ...f, ref: mRef, seen: f.store.get(mRef.path), reason: ' wrong room ', uid: 'u3' })
    expect(r4.revision).toBe(4)
    doc = f.store.get(mRef.path)
    expect(doc).toMatchObject({ status: 'void', voidReason: 'wrong room', voidedBy: 'u3', revision: 4 })
    expect(doc.points).toEqual([P(0, 0), P(600, 800)]) // nothing else moved
  })

  it('a count on a never-calibrated page is created with a null snapshot; a length is refused as UNCALIBRATED', async () => {
    const f = fakeFirestore()
    const ensured = await runEnsurePage({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, uid: 'u1' })
    const common = { ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, seenPage: ensured.page, uid: 'u1' }
    const c = await runCreateMeasurement({ ...common, measurementRef: f.ref('x/m1'), draft: { kind: 'count', points: [P(1, 1)], label: 'Doors', costCodeId: 'cc', costCodeName: 'Doors' } })
    expect(c.kind).toBeNull()
    expect(f.store.get('x/m1').calibration).toBeNull()
    await expectKind(
      runCreateMeasurement({ ...common, measurementRef: f.ref('x/m2'), draft: { kind: 'length', points: [P(0, 0), P(1, 1)], label: 'L', costCodeId: 'cc', costCodeName: 'C' } }),
      QUANT_ERROR.UNCALIBRATED,
    )
    expect(f.store.has('x/m2')).toBe(false)
  })

  it('invalid drafts are refused BEFORE any transaction runs', async () => {
    const f = fakeFirestore({ failWith: 'unavailable' }) // would surface OFFLINE if reached
    const base = { ...f, pageRef: f.ref(PAGE_PATH), measurementRef: f.ref('x/m'), identity: IDENTITY, seenPage: { revision: 1 }, uid: 'u1' }
    await expectKind(runCreateMeasurement({ ...base, draft: { kind: 'length', points: [P(0, 0)], label: 'L', costCodeId: 'cc', costCodeName: 'C' } }), QUANT_ERROR.INVALID)
    await expectKind(runCreateMeasurement({ ...base, draft: { kind: 'area', points: [P(0, 0), P(1, 0), P(2, 0)], label: 'A', costCodeId: 'cc', costCodeName: 'C' } }), QUANT_ERROR.INVALID)
    await expectKind(runCreateMeasurement({ ...base, draft: { kind: 'count', points: [P(0, 0)], label: '   ', costCodeId: 'cc', costCodeName: 'C' } }), QUANT_ERROR.INVALID)
    await expectKind(runCreateMeasurement({ ...base, draft: { kind: 'count', points: [P(0, 0)], label: 'x'.repeat(LABEL_MAX + 1), costCodeId: 'cc', costCodeName: 'C' } }), QUANT_ERROR.INVALID)
    await expectKind(runCreateMeasurement({ ...base, draft: { kind: 'count', points: [P(0, 0)], label: 'Doors', costCodeId: '', costCodeName: 'C' } }), QUANT_ERROR.INVALID)
    await expectKind(runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, draft: { ...CAL_DRAFT, realDistance: 0 }, seenPage: null, uid: 'u1' }), QUANT_ERROR.INVALID)
    await expectKind(runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: { ...IDENTITY, page: 0 }, geometry: GEOMETRY, draft: CAL_DRAFT, seenPage: null, uid: 'u1' }), QUANT_ERROR.INVALID)
    await expectKind(runEnsurePage({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: { ...GEOMETRY, pageWidth: 0 }, uid: 'u1' }), QUANT_ERROR.INVALID)
    await expectKind(runVoidMeasurement({ ...f, ref: f.ref('x/m'), seen: { revision: 1 }, reason: '  ', uid: 'u1' }), QUANT_ERROR.INVALID)
    await expectKind(runUpdateMeasurement({ ...f, ref: f.ref('x/m'), seen: { revision: 1, kind: 'length' }, changes: {}, uid: 'u1' }), QUANT_ERROR.INVALID)
    expect(f.store.size).toBe(0)
  })

  it('a missing uid is a PERMISSION refusal; SDK permission and network failures map to named kinds', async () => {
    const f = fakeFirestore()
    await expectKind(runEnsurePage({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, uid: null }), QUANT_ERROR.PERMISSION)
    const denied = fakeFirestore({ failWith: 'permission-denied' })
    await expectKind(runEnsurePage({ ...denied, pageRef: denied.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, uid: 'u1' }), QUANT_ERROR.PERMISSION)
    const offline = fakeFirestore({ failWith: 'unavailable' })
    await expectKind(runEnsurePage({ ...offline, pageRef: offline.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, uid: 'u1' }), QUANT_ERROR.OFFLINE)
    expect(quantErrorKind('deadline-exceeded')).toBe(QUANT_ERROR.OFFLINE)
    expect(quantErrorKind('not-found')).toBe(QUANT_ERROR.MISSING)
    expect(quantErrorKind('weird')).toBe(QUANT_ERROR.UNKNOWN)
    for (const k of Object.values(QUANT_ERROR)) expect(QUANT_ERROR_MESSAGES[k]).toBeTruthy()
    expect(QUANT_ERROR_MESSAGES[QUANT_ERROR.OFFLINE]).toMatch(/nothing was saved/i)
  })

  it('a void or an edit of a non-active record, or of a record that vanished, is refused', async () => {
    const f = fakeFirestore()
    f.store.set('x/m', measurement({ status: 'void', revision: 2 }))
    await expectKind(runUpdateMeasurement({ ...f, ref: f.ref('x/m'), seen: { revision: 2, kind: 'length' }, changes: { label: 'new' }, uid: 'u1' }), QUANT_ERROR.INVALID)
    await expectKind(runVoidMeasurement({ ...f, ref: f.ref('x/m'), seen: { revision: 2 }, reason: 'again', uid: 'u1' }), QUANT_ERROR.INVALID)
    await expectKind(runVoidMeasurement({ ...f, ref: f.ref('x/gone'), seen: { revision: 1 }, reason: 'r', uid: 'u1' }), QUANT_ERROR.MISSING)
    await expectKind(runCreateMeasurement({ ...f, pageRef: f.ref('x/nopage'), measurementRef: f.ref('x/m9'), identity: IDENTITY, seenPage: { revision: 1 }, uid: 'u1', draft: { kind: 'count', points: [P(1, 1)], label: 'D', costCodeId: 'cc', costCodeName: 'C' } }), QUANT_ERROR.MISSING)
  })
})

// ── 14. Stale concurrent edits ───────────────────────────────────────────────

describe('stale concurrent edits are refused, never merged', () => {
  it('re-calibrating from a stale page copy is STALE and writes nothing', async () => {
    const f = fakeFirestore()
    await runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, draft: CAL_DRAFT, seenPage: null, uid: 'u1' })
    // Another user re-calibrates (server now at revision 2)
    await runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, draft: { ...CAL_DRAFT, realDistance: 2 }, seenPage: { revision: 1 }, uid: 'u2' })
    expect(f.store.get(PAGE_PATH)).toMatchObject({ revision: 2, calibrationRevision: 2 })
    // The first user still holds revision 1
    await expectKind(runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, draft: { ...CAL_DRAFT, realDistance: 3 }, seenPage: { revision: 1 }, uid: 'u1' }), QUANT_ERROR.STALE)
    expect(f.store.get(PAGE_PATH).calibration.realDistance).toBe(2)
    // Seeing nothing when a page exists is stale too — never overwrite unseen.
    await expectKind(runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, draft: CAL_DRAFT, seenPage: null, uid: 'u1' }), QUANT_ERROR.STALE)
    // Seeing a page that no longer exists is stale, not a re-create.
    await expectKind(runSaveCalibration({ ...f, pageRef: f.ref('x/other'), identity: IDENTITY, geometry: GEOMETRY, draft: CAL_DRAFT, seenPage: { revision: 1 }, uid: 'u1' }), QUANT_ERROR.STALE)
  })

  it('saving a measurement after the page was re-calibrated underneath is STALE (the quantity shown was not the one that would be saved)', async () => {
    const f = fakeFirestore()
    await runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, draft: CAL_DRAFT, seenPage: null, uid: 'u1' })
    await runSaveCalibration({ ...f, pageRef: f.ref(PAGE_PATH), identity: IDENTITY, geometry: GEOMETRY, draft: { ...CAL_DRAFT, realDistance: 2 }, seenPage: { revision: 1 }, uid: 'u2' })
    await expectKind(runCreateMeasurement({
      ...f, pageRef: f.ref(PAGE_PATH), measurementRef: f.ref('x/m1'), identity: IDENTITY, seenPage: { revision: 1 }, uid: 'u1',
      draft: { kind: 'length', points: [P(0, 0), P(1, 1)], label: 'L', costCodeId: 'cc', costCodeName: 'C' },
    }), QUANT_ERROR.STALE)
    expect(f.store.has('x/m1')).toBe(false)
    // With no seen page at all, a length cannot be saved either.
    await expectKind(runCreateMeasurement({
      ...f, pageRef: f.ref(PAGE_PATH), measurementRef: f.ref('x/m1'), identity: IDENTITY, seenPage: null, uid: 'u1',
      draft: { kind: 'length', points: [P(0, 0), P(1, 1)], label: 'L', costCodeId: 'cc', costCodeName: 'C' },
    }), QUANT_ERROR.STALE)
  })

  it('editing or voiding a measurement another user changed is STALE and nothing is written', async () => {
    const f = fakeFirestore()
    f.store.set('x/m', measurement({ revision: 1 }))
    await runUpdateMeasurement({ ...f, ref: f.ref('x/m'), seen: { revision: 1, kind: 'length' }, changes: { label: 'theirs' }, uid: 'u2' })
    expect(f.store.get('x/m').revision).toBe(2)
    await expectKind(runUpdateMeasurement({ ...f, ref: f.ref('x/m'), seen: { revision: 1, kind: 'length' }, changes: { label: 'mine' }, uid: 'u1' }), QUANT_ERROR.STALE)
    await expectKind(runVoidMeasurement({ ...f, ref: f.ref('x/m'), seen: { revision: 1 }, reason: 'gone', uid: 'u1' }), QUANT_ERROR.STALE)
    expect(f.store.get('x/m')).toMatchObject({ label: 'theirs', revision: 2, status: 'active' })
  })

  it('sameRevision is strict: integer equality only', () => {
    expect(sameRevision({ revision: 2 }, { revision: 2 })).toBe(true)
    expect(sameRevision({ revision: '2' }, { revision: 2 })).toBe(false)
    expect(sameRevision(null, { revision: 1 })).toBe(false)
    expect(sameRevision({ revision: 1 }, undefined)).toBe(false)
  })

  it('the hooks pass the rendered copy as `seen` and inject the real SDK — the transaction, not the UI, decides', () => {
    const hook = stripComments(read('hooks/useTakeoff.jsx'))
    expect(hook).toContain('runTransaction, serverTimestamp')
    expect(hook).toContain('seenPage')
    expect(hook).toContain("import { db } from '../lib/firebase'")
    for (const fn of ['runEnsurePage', 'runSaveCalibration', 'runCreateMeasurement', 'runUpdateMeasurement', 'runVoidMeasurement']) {
      expect(hook).toContain(fn)
    }
    // The actions module itself imports no Firebase — SDK functions are injected.
    expect(read('lib/quantActions.js')).not.toMatch(/from 'firebase/)
    expect(read('lib/quant.js')).not.toMatch(/from 'firebase/)
  })
})

// ── 15. Drawing / revision / page isolation ──────────────────────────────────

describe('drawing, revision and page isolation', () => {
  it('the page id is deterministic from (drawing, revision, page) and empty for a bad identity', () => {
    expect(takeoffPageId('d1', 'r1', 3)).toBe('d1_r1_3')
    expect(takeoffPageId('d1', 'r2', 3)).not.toBe(takeoffPageId('d1', 'r1', 3))
    expect(takeoffPageId('d1', 'r1', 4)).not.toBe(takeoffPageId('d1', 'r1', 3))
    expect(takeoffPageId('', 'r1', 1)).toBe('')
    expect(takeoffPageId('d1', 'r1', 0)).toBe('')
    expect(takeoffPageId('d1', 'r1', 1.5)).toBe('')
    expect(isPageNumber(1)).toBe(true)
    expect(isPageNumber('1')).toBe(false)
  })

  it('measurementsForPage returns only that page’s records; another revision of the same drawing is a different page', () => {
    const list = [
      measurement({ id: 'a', takeoffPageId: 'd1_r1_1' }),
      measurement({ id: 'b', takeoffPageId: 'd1_r2_1', revisionId: 'r2' }),
      measurement({ id: 'c', takeoffPageId: 'd1_r1_2', page: 2 }),
    ]
    expect(measurementsForPage(list, 'd1_r1_1').map(m => m.id)).toEqual(['a'])
    expect(measurementsForPage(list, 'd1_r2_1').map(m => m.id)).toEqual(['b'])
    expect(measurementsForPage(list, 'd9_r9_9')).toEqual([])
  })

  it('the actions write the identity triple and its id together, and the id never comes from the caller', () => {
    const src = stripComments(read('lib/quantActions.js'))
    expect(src).toContain('takeoffPageId: pageId')
    expect(src).toContain('const pageId = takeoffPageId(identity?.drawingId, identity?.revisionId, identity?.page)')
    expect(src).not.toMatch(/draft\.takeoffPageId|changes\.takeoffPageId|changes\.drawingId|changes\.revisionId|changes\.page\b|changes\.kind/)
  })

  it('sorting is by entry time and never mutates the input', () => {
    const list = [measurement({ id: 'b', createdAt: { seconds: 5 } }), measurement({ id: 'a', createdAt: { seconds: 1 } })]
    const sorted = sortMeasurements(list)
    expect(sorted.map(m => m.id)).toEqual(['a', 'b'])
    expect(list.map(m => m.id)).toEqual(['b', 'a'])
    expect(activeMeasurements([measurement(), measurement({ status: 'void' })])).toHaveLength(1)
  })
})

// ── 16. Project switching ────────────────────────────────────────────────────

describe('project switching — keyed subscriptions', () => {
  const hook = stripComments(read('hooks/useTakeoff.jsx'))

  it('both takeoff hooks key their snapshot on company/project and derive loading/error at render time (ADR-41)', () => {
    expect(hook.match(/const key = `\$\{companyId\}\/\$\{projectId\}`/g)).toHaveLength(2)
    expect(hook.match(/const targetKey = companyId && projectId \? `\$\{companyId\}\/\$\{projectId\}` : null/g)).toHaveLength(2)
    expect(hook.match(/const settled = targetKey !== null && snap\.key === targetKey/g)).toHaveLength(2)
    expect(hook).toContain('const takeoffPagesError = settled ? snap.error : false')
    expect(hook).toContain('const takeoffMeasurementsError = settled ? snap.error : false')
    expect(hook).not.toMatch(/setLoading|useState\(true\)/)
  })

  it('the page is remounted per project by the keyed outlet, so no draft survives a project switch', () => {
    const layout = stripComments(read('layouts/ProjectDetailLayout.jsx'))
    expect(layout).toContain('<Outlet key={projectId}')
    const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
    // Changing the sheet inside a project clears every draft in the change handlers.
    expect(workspace).toMatch(/const changeDrawing = \(id\) => \{ resetDrafts\(\)/)
    expect(workspace).toMatch(/const changeRevision = \(id\) => \{ resetDrafts\(\)/)
    // Quant 1B correction renamed the setters (drawingChoice / pageChoice — the CHOICE, validated before use).
    expect(workspace).toMatch(/resetDrafts\(\); setPageChoice\(n\)/)
  })

  it('a failed takeoff read is UNAVAILABLE in the UI — never "not calibrated" or "no measurements"', () => {
    const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
    expect(workspace).toContain('const unavailable = takeoffPagesError || takeoffMeasurementsError')
    expect(workspace).toMatch(/Takeoff records are unavailable/)
    expect(workspace).toContain('&& !takeoffPagesError && !takeoffMeasurementsError')
    expect(workspace).toMatch(/takeoffMeasurementsError \? \(/)
  })
})

// ── 17. Superseded revisions ─────────────────────────────────────────────────

describe('superseded and withdrawn revisions', () => {
  const drawing = { id: 'd1', status: 'active', currentRevisionId: 'r2', currentRevisionCode: 'B' }
  const current    = { id: 'r2', status: 'current', revisionCode: 'B' }
  const superseded = { id: 'r1', status: 'superseded', revisionCode: 'A' }
  const withdrawn  = { id: 'r0', status: 'withdrawn', revisionCode: 'P1' }

  it('measuring is allowed on current and superseded revisions, never on withdrawn ones or withdrawn drawings', () => {
    expect(canMeasureOnRevision(current, drawing)).toBe(true)
    expect(canMeasureOnRevision(superseded, drawing)).toBe(true)
    expect(canMeasureOnRevision(withdrawn, drawing)).toBe(false)
    expect(canMeasureOnRevision(current, { ...drawing, status: 'withdrawn' })).toBe(false)
    expect(canMeasureOnRevision(null, drawing)).toBe(false)
  })

  it('a superseded sheet shows the Documents wording plus the historical-measurement sentence; withdrawn forbids additions', () => {
    const w = sourceWarning(superseded, drawing)
    expect(w.tone).toBe('superseded')
    expect(w.title).toBe('SUPERSEDED — Revision A')
    expect(w.body).toMatch(/Current revision is B/)
    expect(w.body).toMatch(/historical — re-measure on the current revision/)
    const x = sourceWarning(withdrawn, drawing)
    expect(x.tone).toBe('withdrawn')
    expect(x.body).toMatch(/inspected or voided, never added to, edited or re-calibrated/)
    expect(sourceWarning(current, drawing)).toBeNull()
    expect(sourceWarning(null, drawing).title).toBe('REVISION NOT FOUND')
  })

  it('a measurement is pinned to its revision: it never follows the drawing’s current pointer', () => {
    const m = measurement({ revisionId: 'r1' })
    expect(isCurrentSource(m, drawing)).toBe(false)
    expect(isCurrentSource(measurement({ revisionId: 'r2' }), drawing)).toBe(true)
    // Nothing in the library re-points a measurement.
    expect(read('lib/quant.js')).not.toMatch(/currentRevisionId\s*:/) // read, never written
    expect(read('lib/quantActions.js')).not.toMatch(/currentRevisionId/)
  })

  // Production incident (October 2026): the banner showed "REVISION NOT FOUND"
  // with no drawing selected, and flashed while revisions were still loading.
  it('the missing-revision banner is computed only for a selected drawing whose revisions have settled', () => {
    const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
    expect(workspace).toContain('const revisionsSettled = !!drawing && !revisionsLoading && !revisionsError')
    expect(workspace).toContain('const warning = revisionsSettled ? sourceWarning(revision, drawing) : null')
    expect(workspace).not.toMatch(/revision \|\| !drawing \? sourceWarning/)
    // A failed revisions read is its own unavailable banner — never "not found".
    expect(workspace).toContain('{drawing && revisionsError && (')
    expect(workspace).toMatch(/This drawing&apos;s revisions are unavailable/)
    // The picker owns the loading state; the workspace does not invent one.
    const picker = stripComments(read('pages/project/quant/SourcePicker.jsx'))
    expect(picker).toContain("revisionsLoading ? 'Loading revisions…'")
    expect(picker).toContain("revisionsError ? 'Revisions unavailable'")
  })

  it('sourceWarning itself still names a genuinely missing revision, and nothing else, for a selected drawing', () => {
    expect(sourceWarning(null, drawing).title).toBe('REVISION NOT FOUND')
    expect(sourceWarning(current, drawing)).toBeNull()
    // Every input to the banner derives from the current drawingId, so a switch
    // cannot carry a stale banner: the choice is reset and the revisions hook is
    // keyed on the new drawing.
    const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
    expect(workspace).toContain('useDrawingRevisions(projectId, drawingId)')
    expect(workspace).toMatch(/const changeDrawing = \(id\) => \{ resetDrafts\(\); setDrawingChoice\(id\); setRevisionChoice\(null\)/)
    const hook = stripComments(read('hooks/useDrawingRevisions.jsx'))
    expect(hook).toContain('const key = `${companyId}/${projectId}/${drawingId}`')
  })

  it('the picker preselects the current revision, lists superseded/withdrawn ones, and never offers a withdrawn drawing', () => {
    const picker = stripComments(read('pages/project/quant/SourcePicker.jsx'))
    expect(picker).toContain('filter(d => !isWithdrawnDrawing(d))')
    expect(picker).toContain('sortRevisions(revisions)')
    const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
    expect(workspace).toContain('|| currentRevision(drawing, revisions)')
    expect(workspace).toContain('canMeasureOnRevision(revision, drawing)')
    expect(workspace).toContain('sourceWarning(revision, drawing)')
  })

  it('rules refuse a page or measurement on a withdrawn revision OR drawing and require both to exist', () => {
    const rules = readRoot('firestore.rules')
    const pages = rules.slice(rules.indexOf('match /companies/{companyId}/projects/{projectId}/takeoffPages/'), rules.indexOf('match /companies/{companyId}/projects/{projectId}/takeoffMeasurements/'))
    const meas  = rules.slice(rules.indexOf('match /companies/{companyId}/projects/{projectId}/takeoffMeasurements/'), rules.indexOf('// Project counters — PER-PROJECT'))
    for (const block of [pages, meas]) {
      expect(block).toContain("/revisions/$(d.revisionId)).data.status != 'withdrawn'")
      expect(block).toContain("/drawings/$(d.drawingId)).data.status != 'withdrawn'")
      expect(block).toContain('allow delete: if false;')
      expect(block).toContain("in ['company_admin', 'project_manager', 'qs']")
      // READS are role-gated only — never by sheet status — so history stays inspectable.
      expect(block).toContain('allow read: if quantMember();')
    }
    expect(meas).toContain('/takeoffPages/$(d.takeoffPageId))')
    expect(meas).toContain('/costCodes/$(d.costCodeId))')
  })

  it('the exact revision-status contract: read any; create/recalibrate/edit only while live; void always', () => {
    const rules = readRoot('firestore.rules')
    const pages = rules.slice(rules.indexOf('match /companies/{companyId}/projects/{projectId}/takeoffPages/'), rules.indexOf('match /companies/{companyId}/projects/{projectId}/takeoffMeasurements/'))
    const meas  = rules.slice(rules.indexOf('match /companies/{companyId}/projects/{projectId}/takeoffMeasurements/'), rules.indexOf('// Project counters — PER-PROJECT'))
    // Page create and the ONLY page update (recalibration) both require the sheet live.
    expect(pages).toContain('&& sourceLive(request.resource.data)')
    expect(pages).toContain('&& sourceLive(resource.data)')
    // Measurement create (through sourceValid) and the ACTIVE EDIT branch require it; the VOID branch does not.
    expect(meas).toContain('&& sourceLive(d);')
    const editBranch = meas.slice(meas.indexOf('// (a) ACTIVE EDIT'), meas.indexOf('// (b) ACTIVE → VOID'))
    const voidBranch = meas.slice(meas.indexOf('// (b) ACTIVE → VOID'), meas.indexOf('allow delete: if false;'))
    expect(editBranch).toContain('&& sourceLive(resource.data)')
    expect(voidBranch).not.toContain('sourceLive')
    expect(voidBranch).toContain("request.resource.data.status == 'void'")
  })
})

// ── 18. Permission-gated subscriptions ───────────────────────────────────────

describe('permission-gated subscriptions', () => {
  const pageSrc = stripComments(read('pages/project/ProjectQuant.jsx'))
  const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))

  it('the role vocabulary is exactly the three takeoff roles', () => {
    expect(QUANT_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    for (const r of QUANT_ROLES) expect(canUseQuant(r)).toBe(true)
    for (const r of ['subcontractor', 'client', 'super_admin', undefined, null, '']) expect(canUseQuant(r)).toBe(false)
  })

  it('the page gates on the settled profile and mounts the workspace only for a takeoff role', () => {
    expect(pageSrc).toContain('if (profileLoading) {')
    expect(pageSrc).toContain('if (!canUseQuant(profile?.role)) {')
    expect(pageSrc).toMatch(/Quant takeoff is restricted/)
    const gateEnd = pageSrc.indexOf('<TakeoffWorkspace projectId={projectId} />')
    expect(gateEnd).toBeGreaterThan(pageSrc.indexOf('if (!canUseQuant(profile?.role))'))
    // The page itself opens no takeoff/drawing/cost-code subscription.
    expect(pageSrc).not.toMatch(/useTakeoff|useDrawings|useDrawingRevisions|useCostCodes|onSnapshot/)
  })

  it('only the workspace mounts the takeoff, drawing and cost-code hooks', () => {
    expect(workspace).toContain('useTakeoffPages(projectId)')
    expect(workspace).toContain('useTakeoffMeasurements(projectId)')
    expect(workspace).toContain('useDrawings(projectId)')
    expect(workspace).toContain('useDrawingRevisions(projectId, drawingId)')
    expect(workspace).toContain('useCostCodes()')
    const dir = fileURLToPath(new URL('../../src/pages/project/quant/', import.meta.url))
    const others = readdirSync(dir).filter(f => f !== 'TakeoffWorkspace.jsx')
    for (const f of others) expect(read(`pages/project/quant/${f}`), f).not.toMatch(/useTakeoff|useDrawings\(|useCostCodes\(/)
  })

  it('edits are offered only when the sheet is LIVE and measurable; void whenever the role may write (the one write rules allow on a withdrawn sheet)', () => {
    expect(workspace).toContain('const sheetLive = canMeasureOnRevision(revision, drawing)')
    expect(workspace).toContain('const measurable = !!identity && !!geometry && sheetLive && canWrite')
    expect(workspace).toContain('const voidable = !!identity && canWrite && !takeoffPagesError && !takeoffMeasurementsError')
    expect(workspace).toContain('canEdit={measurable}')
    expect(workspace).toContain('canVoid={voidable}')
    expect(workspace).toMatch(/pointerEnabled=\{measurable &&/)
    const list = stripComments(read('pages/project/quant/MeasurementList.jsx'))
    expect(list).toContain('{canEdit && <button type="button" className={actionCls} onClick={() => onEditGeometry(m)}>Geometry</button>}')
    expect(list).toContain('{canEdit && <button type="button" className={actionCls} onClick={() => onEditDetails(m)}>Details</button>}')
    expect(list).toContain('{canVoid && <button type="button" className={`${actionCls} text-brand-red`} onClick={() => onVoid(m)}>Void</button>}')
  })

  it('mobile cards use the compact action group: review indicator beside Mark reviewed, equal 44px cells for the rest, table row unchanged', () => {
    const list = stripComments(read('pages/project/quant/MeasurementList.jsx'))
    // Both class variants keep the 44px target and a visible focus state.
    for (const name of ['rowActionCls', 'compactActionCls']) {
      const m = list.match(new RegExp(`const ${name} = '([^']+)'`))
      expect(m, name).not.toBeNull()
      expect(m[1]).toContain('min-h-[44px]')
      expect(m[1]).toContain('focus-visible:outline-2 focus-visible:outline-brand-accent')
    }
    expect(list).toContain('const actionCls = compact ? compactActionCls : rowActionCls')
    expect(list).toMatch(/compactActionCls = '[^']*\bw-full\b[^']*\bjustify-center\b[^']*\bwhitespace-nowrap\b/)
    // The compact group: the indicator (Needs review badge) and Mark reviewed share a line; the rest are equal cells.
    expect(list).toContain('role="group" aria-label={`Actions for ${m.label}`}')
    expect(list).toContain('{indicator}')
    expect(list).toContain('<div className="grid grid-flow-col auto-cols-fr gap-1 border-t border-brand-border pt-1">')
    expect(list.match(/>Mark reviewed<\/button>/g)).toHaveLength(1)
    expect(list.match(/>Show<\/button>/g)).toHaveLength(2)
    expect(list.match(/>Void<\/button>/g)).toHaveLength(2)
    // The mobile card passes the badge as the indicator; the table does not use compact.
    expect(list).toContain('indicator={<Badge label={CALIBRATION_REVIEW_LABELS[review]} variant={REVIEW_BADGE[review]} sm />}')
    expect(list.match(/<Actions\s+compact/g)).toHaveLength(1)
    expect(list.match(/<Actions\b/g)).toHaveLength(2)
    expect(list).toContain('<div className="flex flex-wrap gap-1">')
  })
})

// ── 19 & 20. No financial writes, no BOQ quantity changes ───────────────────

describe('no financial write and no BOQ quantity change (the Quant 1B boundary)', () => {
  const sources = {
    'lib/quant.js': read('lib/quant.js'),
    'lib/quantActions.js': read('lib/quantActions.js'),
    'lib/pdfRender.js': read('lib/pdfRender.js'),
    'hooks/useTakeoff.jsx': read('hooks/useTakeoff.jsx'),
    'pages/project/ProjectQuant.jsx': read('pages/project/ProjectQuant.jsx'),
    'pages/Quant.jsx': read('pages/Quant.jsx'),
  }
  const quantDir = fileURLToPath(new URL('../../src/pages/project/quant/', import.meta.url))
  for (const f of readdirSync(quantDir)) sources[`pages/project/quant/${f}`] = read(`pages/project/quant/${f}`)

  // ADR-52 revision: the workspace may READ BOQ items (`useBoqItems`, so a
  // measurement can be linked and the list can name the item), but no Quant
  // file may call a BOQ WRITE (`updateBoqItem`, `createBoqItem`, `voidBoqItem`,
  // `applyBoqQuantity`), any other financial hook, the currency lock or money
  // arithmetic. The BOQ write lives in lib/boqActions.js behind the BOQ tab.
  const FORBIDDEN = /updateBoqItem|createBoqItem|voidBoqItem|applyBoqQuantity|runApplyBoqQuantity|runUpdateBoqItem|boqActions|useBudgetLines|useForecastLines|useCashFlowLines|useProjectCommercial|usePurchaseOrders|useProgressClaims|useSupplierInvoices|useVariations|stageProjectCurrencyLock|budgetLines|forecastLines|cashFlowLines|'boqItems'|formatCurrency|GST_RATE|roundMoney|toCents\(/

  it('no Quant file imports or calls a financial hook, a BOQ write, a currency lock or money arithmetic', () => {
    for (const [name, src] of Object.entries(sources)) {
      expect(stripComments(src), name).not.toMatch(FORBIDDEN)
    }
  })

  it('ONLY the workspace reads BOQ items, read-only: the three data fields are destructured and no write function is', () => {
    const workspace = stripComments(sources['pages/project/quant/TakeoffWorkspace.jsx'])
    expect(workspace).toContain('const { boqItems, boqItemsLoading, boqItemsError } = useBoqItems(projectId)')
    for (const [name, src] of Object.entries(sources)) {
      if (name === 'pages/project/quant/TakeoffWorkspace.jsx') continue
      expect(stripComments(src), name).not.toMatch(/useBoqItems/)
    }
  })

  it('the only collections the hook touches are takeoffPages and takeoffMeasurements', () => {
    const hook = stripComments(sources['hooks/useTakeoff.jsx'])
    const cols = [...hook.matchAll(/collection\(db, 'companies', companyId, 'projects', projectId, '([A-Za-z]+)'\)/g)].map(m => m[1])
    expect(cols.sort()).toEqual(['takeoffMeasurements', 'takeoffPages'])
    expect(hook).not.toMatch(/collection\(db, 'companies', companyId, '(costCodes|contacts|counters)'/)
  })

  it('the actions write only through the refs they are handed (set/update), and never a quantity field', () => {
    const src = stripComments(sources['lib/quantActions.js'])
    expect(src.match(/tx\.set\(/g)).toHaveLength(3)   // page (ensure), page (first calibration), measurement
    expect(src.match(/tx\.update\(/g)).toHaveLength(3) // recalibrate, edit, void
    expect(src).not.toMatch(/quantity\s*:/)
    expect(src).not.toMatch(/amount|rate\b|budget/i)
  })

  it('the workspace shows cost-code names read-only and states that applying to the BOQ is a later, explicit step (ADR-52)', () => {
    const editor = stripComments(sources['pages/project/quant/MeasurementEditorModal.jsx'])
    expect(editor).toContain('costCodeDisplayName(cc)')
    expect(editor).toMatch(/later, explicit step on the BOQ tab/)
    // The picker offers only linkable items and never a money figure.
    expect(editor).toContain("linkableBoqItems(boqItems, { kind: measurement?.kind, costCodeId })")
    expect(editor).not.toMatch(/\brate\b|\bamount\b|formatCurrency/i)
    const workspace = stripComments(sources['pages/project/quant/TakeoffWorkspace.jsx'])
    expect(workspace).toMatch(/Quant writes no BOQ quantity by itself/)
  })

  // ADR-52: exactly ONE key joined the measurement schema — the optional
  // `boqItemId` link (hasOnly, not hasAll). Still no quantity, amount, rate,
  // budget or currency field: a measurement never stores a number of its own.
  it('a measurement document has no quantity, amount, unit-price, budget or currency field in its schema; boqItemId is optional', () => {
    const rules = readRoot('firestore.rules')
    const meas = rules.slice(rules.indexOf('match /companies/{companyId}/projects/{projectId}/takeoffMeasurements/'), rules.indexOf('// Project counters — PER-PROJECT'))
    const keys = meas.slice(meas.indexOf('function exactKeys'), meas.indexOf('function linkValid'))
    expect(keys).not.toMatch(/quantity|amount|rate|budget|currency/)
    const [hasOnly, hasAll] = keys.split('hasAll(')
    expect(hasOnly).toContain("'boqItemId'")
    expect(hasAll).not.toContain("'boqItemId'")
    // The link target is verified by rules: same project path, exists, active, same cost code.
    const link = meas.slice(meas.indexOf('function linkValid'), meas.indexOf('function sourceLive'))
    expect(link).toContain('/projects/$(projectId)/boqItems/$(d.boqItemId))')
    expect(link).toContain(".data.status == 'active'")
    expect(link).toContain('.data.costCodeId == d.costCodeId')
    // Re-verified only when the link or the cost code moves.
    expect(meas).toContain("(!changedKeys().hasAny(['boqItemId', 'costCodeId']) || linkValid(request.resource.data))")
  })
})

// ── 21. PDF worker loading and cleanup ───────────────────────────────────────

describe('PDF worker loading and cleanup', () => {
  const loader = stripComments(read('pages/project/quant/pdfjsLoader.js'))
  const viewer = stripComments(read('pages/project/quant/PageViewer.jsx'))

  it('PDF.js and its worker are lazily imported from the SAME pinned package and the worker is wired once', () => {
    expect(loader).toContain("import('pdfjs-dist')")
    expect(loader).toContain("import('pdfjs-dist/build/pdf.worker.min.mjs?url')")
    expect(loader).toContain('pdfjs.GlobalWorkerOptions.workerSrc = worker.default')
    expect(loader).toContain('if (!pdfjsPromise)')
    expect(loader).toContain('pdfjsPromise = null') // a failed load is retried, not cached
    // Nothing outside the Quant folder imports pdfjs-dist statically.
    for (const f of ['App.jsx', 'main.jsx', 'lib/pdfRender.js', 'hooks/useTakeoff.jsx']) {
      expect(read(f), f).not.toMatch(/from 'pdfjs-dist/)
    }
    expect(viewer).not.toMatch(/from 'pdfjs-dist/)
  })

  it('the installed pdfjs-dist is the pinned version the lockfile resolves', () => {
    const pkg = JSON.parse(readRoot('package.json'))
    const installed = JSON.parse(readRoot('node_modules/pdfjs-dist/package.json'))
    expect(installed.version).toBe(pkg.dependencies['pdfjs-dist'])
    expect(pdfjs.version).toBe(pkg.dependencies['pdfjs-dist'])
  })

  it('the viewer releases everything it acquires: render task cancelled, page cleaned up, document destroyed', () => {
    expect(viewer).toContain('task.cancel()')
    expect(viewer).toContain('if (proxy) proxy.cleanup()')
    expect(viewer).toContain('if (handle) handle.destroy()')
    expect(viewer).toContain("if (cancelled) { opened.destroy(); return }")
    expect(viewer).toContain('isRenderCancelled(err)')
    // Every effect idles honestly and writes state only from callbacks.
    expect(viewer).not.toMatch(/useEffect\(\(\) => \{\s*set[A-Z]/)
  })

  it('fit-to-width measures the SCROLLER content box and nothing renders before it is measured', () => {
    // The ResizeObserver sits on the scrolling box (contentRect excludes its
    // border), so a fit-width sheet never overflows by the border width.
    expect(viewer).toMatch(/<div ref=\{containerRef\} className="max-h-\[75vh\] overflow-auto/)
    expect(viewer).toContain("entries[0]?.contentRect?.width ?? 0")
    expect(viewer).toContain('if (!pageProxy || !canvas || cssScale <= 0 || containerWidth <= 0) return undefined')
    expect(viewer).toContain('}, [pageProxy, cssScale, containerWidth])')
  })

  it('rendering is bounded by device class and sized from the layout, never from stored coordinates', () => {
    expect(viewer).toContain('RENDER_LIMITS.touch : RENDER_LIMITS.desktop')
    expect(viewer).toContain('devicePixelRatio: window.devicePixelRatio || 1')
    expect(viewer).toContain('viewBox={`0 0 ${geometry.pageWidth} ${geometry.pageHeight}`}')
    expect(viewer).toContain('screenToCanonical(e.clientX, e.clientY, rect, geometry.pageWidth, geometry.pageHeight)')
    expect(viewer).not.toMatch(/style=\{\{/)
  })

  it('the bytes fetch is bounded in time and names the CORS prerequisite on failure; nothing is persisted', () => {
    const storage = stripComments(read('hooks/useStorageUpload.jsx'))
    expect(storage).toContain('export async function getFileBytes(')
    expect(storage).toContain('FILE_BYTES_TIMEOUT_MS = 20_000')
    expect(storage).toContain('Promise.race([getBytes(storageRef(storage, storagePath), maxBytes), timeout])')
    expect(storage).toMatch(/CORS/)
    expect(storage).toMatch(/docs\/DEPLOYMENT\.md/)
    expect(storage).not.toMatch(/setDoc|updateDoc|addDoc/)
  })

  it('pointsToPath draws canonical geometry and closes only polygons', () => {
    expect(pointsToPath([P(0, 0), P(1, 2)])).toBe('M0 0 L1 2')
    expect(pointsToPath([P(0, 0), P(1, 0), P(1, 1)], true)).toBe('M0 0 L1 0 L1 1 Z')
    expect(pointsToPath([P(0, 0), P(1, 0)], true)).toBe('M0 0 L1 0') // two points cannot close
    expect(pointsToPath([])).toBe('')
  })
})

// ── Validation surface used by the editor ───────────────────────────────────

describe('measurement draft validation', () => {
  it('label rules', () => {
    expect(validateLabel('')).toMatch(/Enter a label/)
    expect(validateLabel('   ')).toMatch(/Enter a label/)
    expect(validateLabel('x'.repeat(LABEL_MAX))).toBeNull()
    expect(validateLabel('x'.repeat(LABEL_MAX + 1))).toMatch(/too long/)
  })

  it('a complete draft passes; each missing piece names itself', () => {
    const ok = { kind: 'count', points: [P(1, 1)], label: 'Doors', costCodeId: 'cc', costCodeName: '10 — Doors' }
    expect(validateMeasurementDraft(ok)).toBeNull()
    expect(validateMeasurementDraft({ ...ok, costCodeId: ' ' })).toMatch(/Choose the cost code/)
    expect(validateMeasurementDraft({ ...ok, costCodeName: '' })).toMatch(/no display name/)
    expect(validateMeasurementDraft({ ...ok, points: [] })).toMatch(/at least 1 point/)
    expect(validateMeasurementDraft({})).toMatch(/Choose a measurement type/)
  })

  it('the void dialog requires a reason and the editor never types a quantity', () => {
    const voidModal = stripComments(read('pages/project/quant/MeasurementVoidModal.jsx'))
    expect(voidModal).toContain("if (!reason.trim()) { setError(")
    const editor = stripComments(read('pages/project/quant/MeasurementEditorModal.jsx'))
    expect(editor).toContain('formatMeasurementQuantity(quantity)')
    expect(editor).not.toMatch(/name="quantity"|id="quant-quantity"/)
  })
})


// ── The remembered selection (Quant 1B correction; lib/quantSelection.js) ───

describe('the workspace remembers its sheet per project — sessionStorage only, validated against loaded records', () => {
  const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
  const lib = stripComments(read('lib/quantSelection.js'))

  it('the ROOT CAUSE is the remount: the project layout keys its Outlet by project, so every tab change unmounts the workspace', () => {
    const layout = stripComments(read('layouts/ProjectDetailLayout.jsx'))
    expect(layout).toContain('<Outlet key={projectId}')
  })

  it('the initial choice comes from the remembered selection for THIS project, read once, from sessionStorage', () => {
    expect(workspace).toContain("import { readSelection, writeSelection, selectableDrawing, effectivePage } from '../../../lib/quantSelection'")
    expect(workspace).toContain("const browserStorage = () => (typeof window !== 'undefined' ? window.sessionStorage : null)")
    expect(workspace).toContain('const [saved] = useState(() => readSelection(browserStorage(), projectId))')
    expect(workspace).toContain('const [drawingChoice, setDrawingChoice] = useState(saved?.drawingId ?? null)')
    expect(workspace).toContain('const [revisionChoice, setRevisionChoice] = useState(saved?.revisionId ?? null)')
    expect(workspace).toContain('const [pageChoice, setPageChoice] = useState(saved?.page ?? 1)')
    expect(workspace).not.toMatch(/localStorage/)
    expect(lib).not.toMatch(/localStorage|firebase|firestore/i)
  })

  it('a saved id is VALIDATED against the loaded records before anything uses it, and the revision subscription opens only for a validated drawing', () => {
    expect(workspace).toContain('const drawingsSettled = !drawingsLoading && !drawingsError')
    expect(workspace).toContain('const drawing = selectableDrawing(drawings, drawingChoice, { settled: drawingsSettled })')
    expect(workspace).toContain("const drawingId = drawing?.id ?? null")
    expect(workspace).toContain('useDrawingRevisions(projectId, drawingId)')
    expect(workspace).toContain('const chosen = (revisionsSettled && revisionChoice && revisions.find(r => r.id === revisionChoice)) || null')
    expect(workspace).toContain('const revision = chosen || currentRevision(drawing, revisions)')
    expect(workspace).toContain('const page = effectivePage({ page: pageChoice, revisionId: revisionChoice, chosen, settled: revisionsSettled })')
    // The picker and the identity see only the VALIDATED id.
    expect(workspace).toContain('drawingId={drawingId} onDrawingChange={changeDrawing}')
    expect(workspace).toContain('const identity = drawingId && revisionId ? { drawingId, revisionId, page } : null')
    // The picker only offers non-withdrawn drawings; the lib restores on the same rule.
    expect(lib).toContain('return d && !isWithdrawnDrawing(d) ? d : null')
  })

  it('the EFFECTIVE selection is written back only once the records have settled — a loading or failed read never erases a remembered sheet', () => {
    expect(workspace).toMatch(/useEffect\(\(\) => \{\s*if \(!drawingsSettled\) return\s*if \(drawingId && !revisionsSettled\) return\s*writeSelection\(browserStorage\(\), projectId, \{ drawingId, revisionId: chosen\?\.id \?\? null, page \}\)\s*\}, \[projectId, drawingsSettled, revisionsSettled, drawingId, chosen, page\]\)/)
  })

  it('measurability is still decided from the LIVE records — nothing restored bypasses the sheet protections', () => {
    expect(workspace).toContain('const sheetLive = canMeasureOnRevision(revision, drawing)')
    expect(workspace).toContain('const measurable = !!identity && !!geometry && sheetLive && canWrite')
    expect(workspace).not.toMatch(/saved\?\.(drawingId|revisionId|page)[^\n]*(measurable|sheetLive|canMeasure)/)
    // The change handlers still reset drafts and the page — restore never calls them.
    expect(workspace).toContain('const changeDrawing = (id) => { resetDrafts(); setDrawingChoice(id); setRevisionChoice(null); setPageChoice(1); setSelectedId(null); setNotice(null) }')
    expect(workspace).toContain('const changeRevision = (id) => { resetDrafts(); setRevisionChoice(id); setPageChoice(1); setSelectedId(null); setNotice(null) }')
  })
})

// ── Mobile action availability (MeasurementList) ─────────────────────────────

describe('which actions a measurement card offers — Show always, Details/Geometry while the sheet is live, Mark reviewed only when needed, Void while the role may write', () => {
  const list = stripComments(read('pages/project/quant/MeasurementList.jsx'))
  const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))

  it('the gates are exactly canEdit (Details, Geometry), canEdit && needsReview (Mark reviewed), canVoid (Void) — in BOTH layouts', () => {
    expect(list.match(/\{canEdit && <button type="button" className=\{actionCls\} onClick=\{\(\) => onEditDetails\(m\)\}>Details<\/button>\}/g)).toHaveLength(2)
    expect(list.match(/\{canEdit && <button type="button" className=\{actionCls\} onClick=\{\(\) => onEditGeometry\(m\)\}>Geometry<\/button>\}/g)).toHaveLength(2)
    expect(list).toContain("const review = canEdit && needsReview && <button type=\"button\" className={actionCls} onClick={() => onReview(m)}>Mark reviewed</button>")
    expect(list.match(/<button type="button" className=\{actionCls\} onClick=\{\(\) => onSelect\(m\)\}>Show<\/button>/g)).toHaveLength(2)
    expect(list.match(/\{canVoid && <button type="button" className=\{`\$\{actionCls\} text-brand-red`\} onClick=\{\(\) => onVoid\(m\)\}>Void<\/button>\}/g)).toHaveLength(2)
  })

  it('canEdit is the workspace\'s `measurable` — so a WITHDRAWN sheet, a sheet still loading its geometry, or a read-only role legitimately shows Show and Void only', () => {
    expect(workspace).toContain('canEdit={measurable}')
    expect(workspace).toContain('canVoid={voidable}')
    expect(workspace).toContain('const measurable = !!identity && !!geometry && sheetLive && canWrite')
    expect(workspace).toContain('const voidable = !!identity && canWrite && !takeoffPagesError && !takeoffMeasurementsError')
  })

  it('the compact group never clips or hides a control: no overflow-hidden, equal visible cells, labels never broken', () => {
    const group = list.match(/<div className="grid grid-flow-col auto-cols-fr gap-1 border-t border-brand-border pt-1">[\s\S]*?<\/div>/)
    expect(group).not.toBeNull()
    expect(group[0]).not.toMatch(/overflow-hidden|hidden\b|sr-only|truncate/)
    expect(list).toMatch(/compactActionCls = '[^']*\bwhitespace-nowrap\b/)
    expect(list).not.toMatch(/compactActionCls = '[^']*\b(hidden|truncate|overflow-hidden)\b/)
  })
})

// ── The local acceptance environment (npm run test:quant) ───────────────────

describe('local acceptance environment — both emulators, never production', () => {
  const launcher = stripComments(readRoot('scripts/quant-dev.mjs'))
  const seed     = stripComments(readRoot('scripts/seed-quant-emulator.mjs'))
  const firebase = stripComments(read('lib/firebase.js'))
  const pkg      = JSON.parse(readRoot('package.json'))

  it('npm run test:quant exists and starts BOTH emulators in exec mode (they stop with the command)', () => {
    expect(pkg.scripts['test:quant']).toBe('node scripts/quant-dev.mjs')
    expect(launcher).toContain("'emulators:exec', '--only', 'firestore,storage'")
    expect(launcher).toContain('node scripts/seed-quant-emulator.mjs && vite --mode emulator')
  })

  it('the launcher opts the CHILD process into both emulators, writes no file, and reads the ports from firebase.json', () => {
    expect(launcher).toContain("VITE_USE_FIREBASE_EMULATOR: 'true'")
    expect(launcher).toContain("VITE_USE_STORAGE_EMULATOR: 'true'")
    expect(launcher).toContain('emulators?.firestore?.port')
    expect(launcher).toContain('emulators?.storage?.port')
    expect(launcher).not.toMatch(/writeFileSync|appendFileSync/)
    expect(launcher).toMatch(/BOTH orange banners/)
  })

  it('the seed refuses without BOTH loopback emulator hosts, with real credentials present, or when either emulator is not answering', () => {
    expect(seed).toContain("parseHost('FIRESTORE_EMULATOR_HOST')")
    expect(seed).toContain("parseHost('FIREBASE_STORAGE_EMULATOR_HOST')")
    expect(seed).toContain("const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]']")
    expect(seed).toContain('if (process.env.GOOGLE_APPLICATION_CREDENTIALS) die(')
    expect(seed).toContain("await probe('Firestore', FS)")
    expect(seed).toContain("await probe('Storage', ST)")
    expect(seed).toContain('withSecurityRulesDisabled')
    expect(seed).toContain('context.storage(`gs://${BUCKET}`)')
  })

  // ADR-52: the seed now ALSO writes three BOQ items (a matching m² item, an
  // incompatible m³ item, an unpriced count item) so linking and applying can
  // be exercised — still no budget line, and no other financial collection.
  it('the seed uses the committed fixture, writes drawings + revisions + bytes + takeoff history + the three Quant 1B BOQ items, and no budget line', () => {
    expect(seed).toContain("tests/unit/fixtures/quant-two-page.pdf")
    for (const key of ['a101P1', 'a101A', 'a101B', 'a201A']) expect(seed).toContain(key)
    expect(seed).toContain("status: 'withdrawn'")
    expect(seed).toContain("status: 'superseded'")
    expect(seed).toContain('historyMeasurement(')
    for (const key of ['formworkM2', 'concreteM3', 'doorsCount']) expect(seed).toContain(key)
    expect(seed).not.toMatch(/budgetLines|forecastLines|purchaseOrders|progressClaims|supplierInvoices|cashFlowLines/)
    expect(seed).toMatch(/4000 mm/)
  })

  // The deterministic Quant 1B case: A-201 Rev A calibrated, one ACTIVE area
  // (the 12 m² rectangle) linked to BOQ 2.1 (qty 10 m² @ $85.00).
  it('the seed writes the ready-made Quant 1B case — A-201 calibrated, a 12 m² area linked to 2.1 — and every restart resets to it', () => {
    expect(seed).toContain("a201Area:   'quant-seed-m-a201-area'")
    expect(seed).toContain('seedPage(a201.id, R.a201A),')
    expect(seed).toMatch(/seedMeasurement\(SEED\.measurements\.a201Area, \{\s*drawingId: a201\.id, revisionId: R\.a201A, kind: 'area', points: A201_RECT,\s*label: '[^']+', boqItemId: B\.formworkM2,/)
    expect(seed).toContain("export const A201_RECT = [{ x: 200, y: 150 }, { x: 600, y: 150 }, { x: 600, y: 450 }, { x: 200, y: 450 }]")
    expect(seed).toContain("const CAL_PNG = { pointA: { x: 200, y: 450 }, pointB: { x: 600, y: 450 }, pageDistance: 400, realDistance: 4000, unit: 'mm' }")
    expect(seed).toContain("const SNAP_PNG = { revision: 1, pageDistance: 400, realDistance: 4000, unit: 'mm' }")
    // The same rectangle under the same calibration, through the app's own arithmetic: 4 m × 3 m = 12 m².
    const rect = [{ x: 200, y: 150 }, { x: 600, y: 150 }, { x: 600, y: 450 }, { x: 200, y: 450 }]
    const cal = buildCalibration({ pointA: { x: 200, y: 450 }, pointB: { x: 600, y: 450 }, realDistance: 4000, unit: 'mm' })
    expect(measurementQuantity({ kind: 'area', points: rect }, cal)).toMatchObject({ value: 12, unit: 'm²', state: 'ok' })
    expect(boqLineAmount(12, 85)).toBe(1020)
    expect(boqLineAmount(10, 85)).toBe(850)
    // The 2.1 item is seeded with the quantity and rate the dialog must show as "existing".
    expect(seed).toMatch(/itemNumber: '2\.1'[\s\S]*?quantity: 10, rate: 85, amount: 850,/)
    // Shape: a seeded measurement carries every key quantActions writes, including the link, so the app READS it as linked.
    expect(seed).toMatch(/takeoffPageId: pageId\(drawingId, revisionId, 1\), drawingId, revisionId, page: 1,\s*kind, points, label,\s*costCodeId: CC\.formwork, costCodeName: costCodeName\('04-100', 'Formwork'\),\s*calibration: SNAP_PNG, status: 'active', voidReason: '', voidedAt: null, voidedBy: null,\s*boqItemId,/)
    // Restart semantics: exec mode, in memory, no import / export flags anywhere in the launcher.
    expect(launcher).not.toMatch(/--import|--export-on-exit/)
    expect(seed).toMatch(/Ctrl\+C discards EVERYTHING \(fixture and your work\); the next start re-seeds exactly this/)
  })

  it('the app emulates Storage only WITH Firestore, only under the launcher gate, and announces both endpoints', () => {
    expect(firebase).toContain('const useStorageEmulator =\n  useFirestoreEmulator &&\n  import.meta.env.VITE_USE_STORAGE_EMULATOR === \'true\'')
    expect(firebase).toContain('connectStorageEmulator(storage, host, port)')
    expect(firebase).toContain('FIRESTORE → LOCAL EMULATOR')
    expect(firebase).toContain('STORAGE → LOCAL EMULATOR')
    // The older launchers never set the Storage flag, so their behaviour is unchanged.
    for (const f of ['scripts/credit-notes-dev.mjs', 'scripts/boq-dev.mjs', 'scripts/tender-dev.mjs']) {
      expect(readRoot(f), f).not.toContain('VITE_USE_STORAGE_EMULATOR')
    }
  })
})
