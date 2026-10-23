import { formatQuantity } from './boq'
import {
  isWithdrawnRevision, isSupersededRevision, isWithdrawnDrawing, revisionWarning,
} from './drawings'

// ── Constrapp Quant™ 1A — manual drawing measurement (ADR-51) ────────────────
//
// Pure geometry, calibration and validation for the takeoff workspace. No
// React, no Firebase, no Firestore reads, and — deliberately — NO financial
// arithmetic: a measurement is a quantity in metres, square metres or units,
// never money. Nothing in this module writes onto a BOQ item, a budget line or
// any other commercial document. Quant 1B (ADR-52) adds an OPTIONAL `boqItemId`
// link on a measurement — an identity, validated here by shape only — and the
// explicit review-and-apply step lives in lib/quantBoq.js + lib/boqActions.js.
//
// ⚠️ CANONICAL COORDINATES. Every stored point is in the PAGE'S OWN space:
//   · PDF  — the PDF.js default viewport at scale 1 (`page.getViewport({
//            scale: 1 })`), which applies the page's /Rotate and CropBox. Origin
//            top-left, y down, units are PDF points (1/72 in). Width/height are
//            that viewport's width/height.
//   · image — intrinsic pixels (naturalWidth × naturalHeight). Origin top-left.
// The on-screen canvas is that space scaled by one number (`renderScale`), and
// the SVG overlay uses `viewBox="0 0 pageWidth pageHeight"`, so a stored point
// is independent of the window, CSS size, zoom, pan, canvas resolution and
// device pixel ratio by construction. Screen pixels are NEVER stored.
//
// ⚠️ A QUANTITY IS NEVER STORED. Every quantity is reproduced from geometry ×
// the applicable calibration (lib/quant.js → measurementQuantity). The page
// holds the CURRENT calibration; each length/area measurement carries a
// SNAPSHOT of the calibration it was last saved or reviewed under, so a
// re-calibration is visible (needs review) and the original quantity stays
// explainable (originalQuantity) without a stored number anywhere.

// ── Roles (UX mirror only — Firestore rules are the boundary) ────────────────

export const QUANT_ROLES = ['company_admin', 'project_manager', 'qs']
export const canUseQuant = (role) => QUANT_ROLES.includes(role)

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const MEASUREMENT_KIND = {
  LENGTH: 'length',
  AREA:   'area',
  COUNT:  'count',
}
export const MEASUREMENT_KINDS = [MEASUREMENT_KIND.LENGTH, MEASUREMENT_KIND.AREA, MEASUREMENT_KIND.COUNT]

export const KIND_LABELS = {
  [MEASUREMENT_KIND.LENGTH]: 'Length',
  [MEASUREMENT_KIND.AREA]:   'Area',
  [MEASUREMENT_KIND.COUNT]:  'Count',
}

// Metric output units (ADR-51): metres, square metres, individual units.
export const KIND_UNITS = {
  [MEASUREMENT_KIND.LENGTH]: 'm',
  [MEASUREMENT_KIND.AREA]:   'm²',
  [MEASUREMENT_KIND.COUNT]:  'no.',
}

export const MIN_POINTS = {
  [MEASUREMENT_KIND.LENGTH]: 2,
  [MEASUREMENT_KIND.AREA]:   3,
  [MEASUREMENT_KIND.COUNT]:  1,
}
export const MAX_POINTS = 500
export const LABEL_MAX  = 120

export const MEASUREMENT_STATUS = { ACTIVE: 'active', VOID: 'void' }

export const PAGE_SOURCE = { PDF: 'pdf', IMAGE: 'image' }
export const PAGE_SOURCES = [PAGE_SOURCE.PDF, PAGE_SOURCE.IMAGE]
export const PAGE_ROTATIONS = [0, 90, 180, 270]

// Metric calibration input units. The ONLY unit vocabulary Quant owns; BOQ
// and cost-code `unit` strings are untouched (Quant 1B maps between them).
export const CALIBRATION_UNITS = {
  mm: { code: 'mm', label: 'millimetres', metres: 0.001 },
  m:  { code: 'm',  label: 'metres',      metres: 1 },
}
export const CALIBRATION_UNIT_CODES = Object.keys(CALIBRATION_UNITS)

export const isCalibrationUnit = (u) => Object.prototype.hasOwnProperty.call(CALIBRATION_UNITS, u)

// ── Numbers & points ─────────────────────────────────────────────────────────

export const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n)

export const isFinitePoint = (p) =>
  !!p && typeof p === 'object' && isFiniteNumber(p.x) && isFiniteNumber(p.y)

export const isPointList = (points) => Array.isArray(points) && points.every(isFinitePoint)

// A stored point is exactly { x, y } — nothing else rides along.
export const normalisePoint = (p) => ({ x: Number(p.x), y: Number(p.y) })
export const normalisePoints = (points) => (points ?? []).map(normalisePoint)

export function distance(a, b) {
  if (!isFinitePoint(a) || !isFinitePoint(b)) return NaN
  return Math.hypot(b.x - a.x, b.y - a.y)
}

// Sum of consecutive segment lengths. NOT closed — a length is a polyline.
export function polylineLength(points) {
  if (!isPointList(points) || points.length < 2) return 0
  let total = 0
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i])
  return total
}

// Shoelace formula over an IMPLICITLY closed polygon: the last point joins the
// first. An explicitly repeated closing point is tolerated (it contributes a
// zero-length edge). Fewer than three distinct points, or collinear points,
// give 0 — which validation then rejects as degenerate.
export function polygonArea(points) {
  if (!isPointList(points) || points.length < 3) return 0
  let twice = 0
  const n = points.length
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    twice += a.x * b.y - b.x * a.y
  }
  return Math.abs(twice) / 2
}

export const countPoints = (points) => (isPointList(points) ? points.length : 0)

// ── Polygon simplicity (Quant 1C-A, ADR-53) ──────────────────────────────────
//
// The shoelace formula is a SIGNED sum: a polygon whose outline crosses itself
// (a bow-tie, one crossed edge) yields a plausible non-zero figure that is not
// the area of anything. An area is therefore accepted only when its ring is
// SIMPLE: no two non-adjacent edges intersect or touch, and no adjacent pair
// doubles back along itself. Rules cannot inspect `points` (DC32), so this is
// client-only — the quantity of a stored crossed polygon derives as INVALID,
// which the list shows and the BOQ apply blocks. O(n²) over at most 500 points.

const GEOM_EPS = 1e-9

// Sign of the turn a→b→c: 0 collinear, 1 counter-clockwise, -1 clockwise.
export function orientation(a, b, c) {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  return Math.abs(v) <= GEOM_EPS ? 0 : v > 0 ? 1 : -1
}

// `p` (already known collinear with a–b) lies within the segment's box.
const withinSegmentBox = (a, b, p) =>
  Math.min(a.x, b.x) - GEOM_EPS <= p.x && p.x <= Math.max(a.x, b.x) + GEOM_EPS
  && Math.min(a.y, b.y) - GEOM_EPS <= p.y && p.y <= Math.max(a.y, b.y) + GEOM_EPS

// Closed segments a–b and c–d intersect or touch (a shared endpoint counts).
export function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d)
  const o3 = orientation(c, d, a), o4 = orientation(c, d, b)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && withinSegmentBox(a, b, c)) return true
  if (o2 === 0 && withinSegmentBox(a, b, d)) return true
  if (o3 === 0 && withinSegmentBox(c, d, a)) return true
  if (o4 === 0 && withinSegmentBox(c, d, b)) return true
  return false
}

// The polygon's ring: consecutive duplicates collapsed and an explicit repeated
// closing vertex dropped, so a tolerated closing point never counts as an
// edge of its own. Does not mutate the input.
export function polygonRing(points) {
  if (!isPointList(points)) return []
  const ring = []
  for (const p of points) {
    const last = ring[ring.length - 1]
    if (!last || distance(last, p) > GEOM_EPS) ring.push(p)
  }
  while (ring.length > 1 && distance(ring[0], ring[ring.length - 1]) <= GEOM_EPS) ring.pop()
  return ring
}

export const POLYGON_PROBLEM = {
  DEGENERATE:        'degenerate',        // fewer than three distinct points, or zero area (collinear)
  SELF_INTERSECTING: 'self_intersecting', // two edges cross or touch; or an edge doubles back on its neighbour
}

// Every point of the ring on one line (a "polygon" with no interior at all).
const allCollinear = (ring) => {
  const a = ring[0]
  const b = ring.find(p => distance(a, p) > GEOM_EPS)
  if (!b) return true
  return ring.every(p => orientation(a, b, p) === 0)
}

// Null for a simple polygon, otherwise the one problem that disqualifies it.
// Crossings are reported before a zero area: a symmetric bow-tie has a zero
// shoelace sum, and "crosses itself" is the message that tells the user how
// to fix it.
export function polygonProblem(points) {
  const ring = polygonRing(points)
  const n = ring.length
  if (n < 3 || allCollinear(ring)) return POLYGON_PROBLEM.DEGENERATE
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      const c = ring[j], d = ring[(j + 1) % n]
      const consecutive = j === i + 1
      const wraps = i === 0 && j === n - 1
      if (consecutive || wraps) {
        // Adjacent edges share exactly one vertex. They are legal unless the
        // two free ends lie on the SAME ray from the shared vertex — the
        // outline runs out and straight back (a spike), which no area has.
        const shared = consecutive ? b : a
        const p = consecutive ? a : b
        const q = consecutive ? d : c
        if (orientation(shared, p, q) === 0 && (p.x - shared.x) * (q.x - shared.x) + (p.y - shared.y) * (q.y - shared.y) > 0) {
          return POLYGON_PROBLEM.SELF_INTERSECTING
        }
        continue
      }
      if (segmentsIntersect(a, b, c, d)) return POLYGON_PROBLEM.SELF_INTERSECTING
    }
  }
  if (polygonArea(ring) <= 0) return POLYGON_PROBLEM.DEGENERATE
  return null
}

export const isSimplePolygon = (points) => polygonProblem(points) === null

// ── Calibration ──────────────────────────────────────────────────────────────
//
// A calibration is two canonical points plus the real distance between them:
//   { pointA, pointB, pageDistance, realDistance, unit }
// `pageDistance` is DERIVED from the points and stored beside them so the
// ratio is reproducible, and rules can check it is positive.

export function toMetres(value, unit) {
  if (!isFiniteNumber(value) || !isCalibrationUnit(unit)) return NaN
  return value * CALIBRATION_UNITS[unit].metres
}

export function convertLength(value, from, to) {
  if (!isFiniteNumber(value) || !isCalibrationUnit(from) || !isCalibrationUnit(to)) return NaN
  return value * CALIBRATION_UNITS[from].metres / CALIBRATION_UNITS[to].metres
}

export function convertArea(value, from, to) {
  if (!isFiniteNumber(value) || !isCalibrationUnit(from) || !isCalibrationUnit(to)) return NaN
  const f = CALIBRATION_UNITS[from].metres / CALIBRATION_UNITS[to].metres
  return value * f * f
}

// Error string or null. Zero-length segments and non-positive, non-finite or
// absurd distances are refused — a calibration that cannot be trusted must not
// be saved.
export function validateCalibrationDraft({ pointA, pointB, realDistance, unit } = {}) {
  if (!isFinitePoint(pointA) || !isFinitePoint(pointB)) return 'Pick two points on the drawing.'
  if (distance(pointA, pointB) <= 0) return 'The two calibration points must be different.'
  if (!isCalibrationUnit(unit)) return 'Choose millimetres or metres.'
  const d = typeof realDistance === 'number' ? realDistance : Number(realDistance)
  if (realDistance === null || realDistance === undefined || realDistance === '' || !Number.isFinite(d)) {
    return 'Enter the known distance as a number.'
  }
  if (d <= 0) return 'The known distance must be greater than zero.'
  return null
}

// The stored calibration, or null when the draft is invalid.
export function buildCalibration({ pointA, pointB, realDistance, unit } = {}) {
  if (validateCalibrationDraft({ pointA, pointB, realDistance, unit })) return null
  const a = normalisePoint(pointA)
  const b = normalisePoint(pointB)
  return {
    pointA: a,
    pointB: b,
    pageDistance: distance(a, b),
    realDistance: Number(realDistance),
    unit,
  }
}

// A calibration is usable when it is a map with positive finite distances and
// a known unit. Points are not needed to APPLY a calibration — only the ratio.
export function isValidCalibration(cal) {
  return !!cal && typeof cal === 'object'
    && isFiniteNumber(cal.pageDistance) && cal.pageDistance > 0
    && isFiniteNumber(cal.realDistance) && cal.realDistance > 0
    && isCalibrationUnit(cal.unit)
}

// Real metres per canonical page unit.
export function metresPerPageUnit(cal) {
  if (!isValidCalibration(cal)) return NaN
  return toMetres(cal.realDistance, cal.unit) / cal.pageDistance
}

// The drawing scale the calibration implies — "1:100" — for PDF pages only,
// where a canonical unit is a PDF point (1/72 in = 0.0254/72 m). Images have
// no physical page size, so there is nothing to compare with: null. Rounded to
// the nearest whole ratio for review; it is informational, never stored.
export function impliedDrawingScale(cal, source) {
  if (source !== PAGE_SOURCE.PDF || !isValidCalibration(cal)) return null
  const pagePhysicalMetres = cal.pageDistance * (0.0254 / 72)
  const ratio = toMetres(cal.realDistance, cal.unit) / pagePhysicalMetres
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  return `1:${Math.round(ratio)}`
}

// The provenance a length/area measurement carries: WHICH calibration it was
// last saved or reviewed under. Points are omitted — the ratio is enough to
// reproduce the quantity, and the page keeps the current points.
export function calibrationSnapshot(page) {
  if (!page || !isValidCalibration(page.calibration)) return null
  const revision = Number(page.calibrationRevision)
  if (!Number.isInteger(revision) || revision < 1) return null
  return {
    revision,
    pageDistance: page.calibration.pageDistance,
    realDistance: page.calibration.realDistance,
    unit:         page.calibration.unit,
  }
}

export const isValidCalibrationSnapshot = (s) =>
  isValidCalibration(s) && Number.isInteger(s.revision) && s.revision >= 1

// ── Quantities (derived — never stored) ──────────────────────────────────────

export const QUANTITY_STATE = {
  OK:           'ok',
  UNCALIBRATED: 'uncalibrated',
  INVALID:      'invalid',
}

// WHY a quantity is INVALID — carried beside the state so the list, the editor
// and the apply dialog can say something actionable instead of "—".
export const QUANTITY_PROBLEM = {
  MALFORMED:         'malformed',         // unknown kind or unreadable points
  TOO_FEW_POINTS:    'too_few_points',
  DEGENERATE:        POLYGON_PROBLEM.DEGENERATE,
  SELF_INTERSECTING: POLYGON_PROBLEM.SELF_INTERSECTING,
}

export const QUANTITY_PROBLEM_LABELS = {
  [QUANTITY_PROBLEM.MALFORMED]:         'The geometry could not be read.',
  [QUANTITY_PROBLEM.TOO_FEW_POINTS]:    'Not enough points for this measurement type.',
  [QUANTITY_PROBLEM.DEGENERATE]:        'The outline has no area — its points are collinear or coincide. Edit the geometry.',
  [QUANTITY_PROBLEM.SELF_INTERSECTING]: 'The outline crosses itself — move or remove the crossing points in Geometry.',
}

// The actionable message for an INVALID quantity, or null when there is none.
export const quantityIssue = (q) =>
  q?.state === QUANTITY_STATE.INVALID ? (QUANTITY_PROBLEM_LABELS[q.reason] ?? QUANTITY_PROBLEM_LABELS[QUANTITY_PROBLEM.MALFORMED]) : null

const invalidQuantity = (unit, reason) => ({ value: null, unit: unit ?? '', state: QUANTITY_STATE.INVALID, reason })

// Three decimals — the BOQ quantity convention (lib/boq.js formatQuantity).
export const QUANTITY_DECIMALS = 3
export function roundQuantity(value) {
  if (!isFiniteNumber(value)) return null
  const f = 10 ** QUANTITY_DECIMALS
  return Math.round(value * f) / f
}

// The quantity a measurement's geometry represents under `calibration`:
//   { value, unit, state }
// `value` is UNROUNDED (callers round for display or for a later BOQ write);
// null whenever the geometry is malformed or a physical scale is required and
// absent. A count never needs calibration.
export function measurementQuantity(measurement, calibration) {
  const kind = measurement?.kind
  const unit = KIND_UNITS[kind]
  if (!unit || !isPointList(measurement?.points)) return invalidQuantity(unit, QUANTITY_PROBLEM.MALFORMED)
  const points = measurement.points
  if (points.length < MIN_POINTS[kind]) return invalidQuantity(unit, QUANTITY_PROBLEM.TOO_FEW_POINTS)

  if (kind === MEASUREMENT_KIND.COUNT) {
    return { value: countPoints(points), unit, state: QUANTITY_STATE.OK }
  }
  // An area must be a SIMPLE polygon (ADR-53): a crossed or collapsed outline
  // is INVALID whatever the calibration says — never a number.
  if (kind === MEASUREMENT_KIND.AREA) {
    const problem = polygonProblem(points)
    if (problem) return invalidQuantity(unit, problem)
  }
  if (!isValidCalibration(calibration)) return { value: null, unit, state: QUANTITY_STATE.UNCALIBRATED }

  const k = metresPerPageUnit(calibration)
  if (kind === MEASUREMENT_KIND.LENGTH) {
    return { value: polylineLength(points) * k, unit, state: QUANTITY_STATE.OK }
  }
  return { value: polygonArea(points) * k * k, unit, state: QUANTITY_STATE.OK }
}

// The quantity the measurement had when it was last saved or reviewed — from
// its own calibration snapshot. This is what explains a historical figure
// after a re-calibration.
export const originalQuantity = (measurement) =>
  measurementQuantity(measurement, measurement?.calibration ?? null)

export function formatMeasurementQuantity(q) {
  if (!q || q.value === null || q.value === undefined) return '—'
  return `${formatQuantity(roundQuantity(q.value))} ${q.unit}`.trim()
}

// ── Calibration review state (derived) ───────────────────────────────────────

export const CALIBRATION_REVIEW = {
  CURRENT:        'current',        // measured under the page's current calibration
  NEEDS_REVIEW:   'needs_review',   // the page was re-calibrated since
  UNCALIBRATED:   'uncalibrated',   // the page has no calibration (length/area)
  NOT_APPLICABLE: 'not_applicable', // counts need no scale
}

export const CALIBRATION_REVIEW_LABELS = {
  [CALIBRATION_REVIEW.CURRENT]:        'Current scale',
  [CALIBRATION_REVIEW.NEEDS_REVIEW]:   'Needs review — scale changed',
  [CALIBRATION_REVIEW.UNCALIBRATED]:   'Page not calibrated',
  [CALIBRATION_REVIEW.NOT_APPLICABLE]: 'No scale needed',
}

export function calibrationReviewState(measurement, page) {
  if (measurement?.kind === MEASUREMENT_KIND.COUNT) return CALIBRATION_REVIEW.NOT_APPLICABLE
  if (!page || !isValidCalibration(page.calibration)) return CALIBRATION_REVIEW.UNCALIBRATED
  const seen = measurement?.calibration?.revision
  return Number.isInteger(seen) && seen === page.calibrationRevision
    ? CALIBRATION_REVIEW.CURRENT
    : CALIBRATION_REVIEW.NEEDS_REVIEW
}

export const needsCalibrationReview = (measurement, page) =>
  calibrationReviewState(measurement, page) === CALIBRATION_REVIEW.NEEDS_REVIEW

// ── Page identity ────────────────────────────────────────────────────────────
//
// Deterministic: one takeoff page per (drawing, revision, page number). Rules
// recompute this id from the stored fields, so a document can never claim a
// different sheet than it is filed under.

export const isPageNumber = (n) => Number.isInteger(n) && n >= 1

// A typed page number, clamped to the sheet's page count; null when the text
// is not a usable page (ADR-53 — the picker commits on Enter/blur, so "12" is
// judged once, as 12, never as 1 on the way).
export function clampPageInput(raw, numPages) {
  const text = String(raw ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  if (!isPageNumber(n)) return null
  return isPageNumber(numPages) ? Math.min(n, numPages) : n
}

export function takeoffPageId(drawingId, revisionId, page) {
  if (!drawingId || !revisionId || !isPageNumber(page)) return ''
  return `${drawingId}_${revisionId}_${page}`
}

export function validatePageGeometry({ source, pageWidth, pageHeight, pageRotation } = {}) {
  if (!PAGE_SOURCES.includes(source)) return 'Unknown page source.'
  if (!isFiniteNumber(pageWidth) || pageWidth <= 0) return 'The page width is not known.'
  if (!isFiniteNumber(pageHeight) || pageHeight <= 0) return 'The page height is not known.'
  if (!PAGE_ROTATIONS.includes(pageRotation)) return 'The page rotation is not known.'
  return null
}

// ── Drawing revision handling ────────────────────────────────────────────────
//
// Measurements are PINNED to { drawingId, revisionId, page } (ADR-28 Decision
// 9) and never move. New measurements may be taken on a CURRENT or SUPERSEDED
// revision (a superseded sheet can legitimately be re-measured for the record)
// but never on a WITHDRAWN one, and never on a withdrawn drawing. The same
// test gates geometry edits, details, review and re-calibration; VOID is the
// one write permitted on a withdrawn sheet, and READS are never gated by it
// (rules mirror all of this — docs/SECURITY.md → Quant™ 1A).

export function canMeasureOnRevision(revision, drawing) {
  if (!revision || !drawing) return false
  if (isWithdrawnRevision(revision) || isWithdrawnDrawing(drawing)) return false
  return true
}

export const isCurrentSource = (measurement, drawing) =>
  !!measurement && !!drawing && drawing.currentRevisionId === measurement.revisionId

// The banner for the sheet on screen. Reuses the Documents register's wording
// (lib/drawings.js → revisionWarning) so a superseded sheet reads the same
// everywhere, and adds the one case Documents never has: the referenced
// revision no longer loads.
export function sourceWarning(revision, drawing) {
  if (!revision) {
    return { tone: 'withdrawn', title: 'REVISION NOT FOUND', body: 'The drawing revision these measurements were taken on could not be loaded.' }
  }
  const base = revisionWarning(revision, drawing)
  if (!base) return null
  if (isSupersededRevision(revision)) {
    return { ...base, body: `${base.body} Measurements on this sheet are historical — re-measure on the current revision.` }
  }
  return { ...base, body: `${base.body} Measurements on this sheet are historical: they can be inspected or voided, never added to, edited or re-calibrated.` }
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateLabel(label) {
  const s = String(label ?? '').trim()
  if (!s) return 'Enter a label for this measurement.'
  if (s.length > LABEL_MAX) return `The label is too long (max ${LABEL_MAX} characters).`
  return null
}

export function validatePoints(kind, points) {
  if (!MEASUREMENT_KINDS.includes(kind)) return 'Choose a measurement type.'
  if (!isPointList(points)) return 'The measurement geometry is not valid.'
  if (points.length < MIN_POINTS[kind]) {
    const need = MIN_POINTS[kind]
    return `A ${KIND_LABELS[kind].toLowerCase()} needs at least ${need} point${need === 1 ? '' : 's'}.`
  }
  if (points.length > MAX_POINTS) return `Too many points (max ${MAX_POINTS}).`
  if (kind === MEASUREMENT_KIND.LENGTH && polylineLength(points) <= 0) return 'A length cannot be zero — the points coincide.'
  if (kind === MEASUREMENT_KIND.AREA && polygonProblem(points) === POLYGON_PROBLEM.SELF_INTERSECTING) {
    return 'The area outline crosses itself — move or remove the crossing points.'
  }
  if (kind === MEASUREMENT_KIND.AREA && polygonArea(points) <= 0) return 'The area is zero — the points are collinear or coincide.'
  return null
}

// ── Geometry editing (Quant 1C-A, ADR-53) ────────────────────────────────────
//
// Pure helpers for the edit session: where a tap landed relative to the
// vertices and edges of the shape being edited, and the new point list after
// an insert or a removal. Nothing here knows about React state or history —
// the workspace keeps the session; these only compute.

export function distanceToSegment(p, a, b) {
  if (!isFinitePoint(p) || !isFinitePoint(a) || !isFinitePoint(b)) return NaN
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 <= 0) return distance(p, a)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

// The vertex nearest to `p` — { index, distance } — or null for an empty list.
export function nearestVertex(points, p) {
  if (!isPointList(points) || points.length === 0 || !isFinitePoint(p)) return null
  let best = null
  points.forEach((v, index) => {
    const d = distance(v, p)
    if (!best || d < best.distance) best = { index, distance: d }
  })
  return best
}

// The edge nearest to `p` — { index (the edge from points[index] to the next),
// distance } — or null when there is no edge. `closed` adds the closing edge
// from the last point back to the first (areas).
export function nearestSegment(points, p, closed = false) {
  if (!isPointList(points) || points.length < 2 || !isFinitePoint(p)) return null
  const n = points.length
  const edges = closed && n > 2 ? n : n - 1
  let best = null
  for (let i = 0; i < edges; i++) {
    const d = distanceToSegment(p, points[i], points[(i + 1) % n])
    if (!best || d < best.distance) best = { index: i, distance: d }
  }
  return best
}

// `p` inserted AFTER points[index] (so on the edge index → index + 1).
export function insertPointAt(points, index, p) {
  const list = normalisePoints(points)
  const at = Math.max(0, Math.min(list.length, index + 1))
  return [...list.slice(0, at), normalisePoint(p), ...list.slice(at)]
}

export function removePointAt(points, index) {
  const list = normalisePoints(points)
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return list
  return [...list.slice(0, index), ...list.slice(index + 1)]
}

// A vertex may be removed only while the shape keeps its minimum point count.
export const canRemovePoint = (kind, points) =>
  MEASUREMENT_KINDS.includes(kind) && isPointList(points) && points.length > MIN_POINTS[kind]

// The pure "what would this edit produce" check the edit strip reports from.
export const editValidation = (kind, points) => validatePoints(kind, points)

// ── Hit testing (Quant 1C-A) ─────────────────────────────────────────────────
//
// In CANONICAL units. The caller converts its screen tolerance with
// `HIT_TOLERANCE_PX / cssScale`, so the same 44 px finger target applies at
// every zoom. Half of 44 px: a tap within 22 px of a vertex or an edge hits.

export const HIT_TOLERANCE_PX = 22

// Ray casting, even-odd rule. Points on the boundary are resolved by the
// caller's distance test first.
export function pointInPolygon(points, p) {
  if (!isPointList(points) || points.length < 3 || !isFinitePoint(p)) return false
  let inside = false
  const n = points.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[i], b = points[j]
    const crosses = (a.y > p.y) !== (b.y > p.y)
    if (crosses && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

// How far `p` is from one measurement's drawn geometry: a count by its nearest
// marker, a length by its nearest edge, an area by its nearest boundary edge.
export function distanceToMeasurement(m, p) {
  if (!isReadableMeasurement(m) || !isFinitePoint(p)) return Infinity
  if (m.kind === MEASUREMENT_KIND.COUNT) return nearestVertex(m.points, p)?.distance ?? Infinity
  return nearestSegment(m.points, p, m.kind === MEASUREMENT_KIND.AREA)?.distance ?? Infinity
}

// The measurement a tap at `p` selects, or null. Boundary and marker hits win
// by distance; failing those, the SMALLEST area that contains the point (so a
// room inside a floor plate is reachable). Only active, readable records are
// candidates — exactly what the overlay draws.
export function hitTestMeasurements(measurements, p, tolerance) {
  if (!isFinitePoint(p) || !isFiniteNumber(tolerance) || tolerance < 0) return null
  let edgeHit = null
  let insideHit = null
  for (const m of activeMeasurements(measurements)) {
    if (!isReadableMeasurement(m)) continue
    const d = distanceToMeasurement(m, p)
    if (d <= tolerance && (!edgeHit || d < edgeHit.distance)) edgeHit = { id: m.id, distance: d }
    if (m.kind === MEASUREMENT_KIND.AREA && pointInPolygon(m.points, p)) {
      const area = polygonArea(m.points)
      if (!insideHit || area < insideHit.area) insideHit = { id: m.id, area }
    }
  }
  if (edgeHit) return edgeHit.id
  return insideHit ? insideHit.id : null
}

// The optional BOQ link (Quant 1B, ADR-52): absent, null, or a non-blank
// document id. Nothing else — the link is an identity, never a quantity.
export const isValidBoqLink = (boqItemId) =>
  boqItemId === undefined || boqItemId === null
  || (typeof boqItemId === 'string' && boqItemId.trim().length > 0)

export function validateBoqLink(boqItemId) {
  return isValidBoqLink(boqItemId) ? null : 'The BOQ item link is not valid.'
}

// Error string or null for a measurement about to be created or edited.
export function validateMeasurementDraft({ kind, points, label, costCodeId, costCodeName, boqItemId } = {}) {
  const pointsError = validatePoints(kind, points)
  if (pointsError) return pointsError
  const labelError = validateLabel(label)
  if (labelError) return labelError
  if (!String(costCodeId ?? '').trim()) return 'Choose the cost code this measurement belongs to.'
  if (!String(costCodeName ?? '').trim()) return 'The chosen cost code has no display name.'
  const linkError = validateBoqLink(boqItemId)
  if (linkError) return linkError
  return null
}

// A stored record is usable only when every field the viewer relies on is
// well-formed. Malformed documents (a direct SDK write, a future schema) are
// listed as "not readable" rather than drawn or summed.
export function isReadableMeasurement(m) {
  return !!m && typeof m === 'object'
    && MEASUREMENT_KINDS.includes(m.kind)
    && isPointList(m.points)
    && typeof m.label === 'string'
    && typeof m.costCodeId === 'string' && m.costCodeId.length > 0
    && (m.status === MEASUREMENT_STATUS.ACTIVE || m.status === MEASUREMENT_STATUS.VOID)
    && typeof m.takeoffPageId === 'string'
    && (m.calibration === null || isValidCalibrationSnapshot(m.calibration))
    // Quant 1A documents have no `boqItemId` key at all; 1B writes null or an id.
    && isValidBoqLink(m.boqItemId)
}

// The link a stored measurement carries, normalised: null for a 1A document.
export const measurementBoqItemId = (m) =>
  typeof m?.boqItemId === 'string' && m.boqItemId.length > 0 ? m.boqItemId : null

export function isReadablePage(p) {
  return !!p && typeof p === 'object'
    && typeof p.drawingId === 'string' && typeof p.revisionId === 'string' && isPageNumber(p.page)
    && !validatePageGeometry(p)
    && (p.calibration === null || isValidCalibration(p.calibration))
    && Number.isInteger(p.calibrationRevision) && p.calibrationRevision >= 0
}

// ── Lists ────────────────────────────────────────────────────────────────────

export const activeMeasurements = (list) =>
  (list ?? []).filter(m => m?.status === MEASUREMENT_STATUS.ACTIVE)

export const measurementsForPage = (list, pageId) =>
  (list ?? []).filter(m => m?.takeoffPageId === pageId)

// Entry order — the order a QS took them off. Does not mutate the input.
export const sortMeasurements = (list) =>
  [...(list ?? [])].sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0))

// Totals by kind for one list, under one calibration — a per-page summary only.
// Quant 1A never carries these onto a BOQ item (ADR-51 → Quant 1B boundary).
export function summariseMeasurements(list, calibration) {
  const out = {}
  for (const kind of MEASUREMENT_KINDS) out[kind] = { count: 0, total: 0, unit: KIND_UNITS[kind], incomplete: 0 }
  for (const m of activeMeasurements(list)) {
    if (!isReadableMeasurement(m)) continue
    const q = measurementQuantity(m, calibration)
    const entry = out[m.kind]
    entry.count += 1
    if (q.value === null) entry.incomplete += 1
    else entry.total += q.value
  }
  return out
}

// ── Concurrency ──────────────────────────────────────────────────────────────

export const sameRevision = (seen, current) =>
  !!seen && !!current && Number.isInteger(seen.revision) && seen.revision === current.revision

export const QUANT_ERROR = {
  STALE:        'stale',
  MISSING:      'missing',
  INVALID:      'invalid',
  UNCALIBRATED: 'uncalibrated',
  WITHDRAWN:    'withdrawn',
  PERMISSION:   'permission',
  OFFLINE:      'offline',
  UNKNOWN:      'unknown',
}

export const QUANT_ERROR_MESSAGES = {
  [QUANT_ERROR.STALE]:        'Another user changed this record since you loaded it. Reload the page and try again.',
  [QUANT_ERROR.MISSING]:      'This record no longer exists.',
  [QUANT_ERROR.INVALID]:      'This change is not valid for the record as it stands.',
  [QUANT_ERROR.UNCALIBRATED]: 'Calibrate this page before measuring a length or an area.',
  [QUANT_ERROR.WITHDRAWN]:    'This revision has been withdrawn. Nothing can be measured on it.',
  [QUANT_ERROR.PERMISSION]:   'You do not have permission to save measurements on this project.',
  [QUANT_ERROR.OFFLINE]:      'Could not reach the server. Check your connection and try again — nothing was saved.',
  [QUANT_ERROR.UNKNOWN]:      'The save did not complete. Nothing was saved — try again.',
}

// Firestore SDK error code → a user-facing kind. A permission error is a rules
// rejection (the role or company genuinely does not permit this); an
// unavailable/deadline error is the network.
export function quantErrorKind(code) {
  switch (code) {
    case 'permission-denied':  return QUANT_ERROR.PERMISSION
    case 'unavailable':
    case 'deadline-exceeded':  return QUANT_ERROR.OFFLINE
    case 'not-found':          return QUANT_ERROR.MISSING
    default:                   return QUANT_ERROR.UNKNOWN
  }
}

// ── Rendering helpers (display geometry only) ────────────────────────────────

// Backing-store ceilings. Browsers cap canvas dimensions and total area, and a
// 50 MB A0 sheet at a high zoom on a phone would exhaust memory; the render
// scale is bounded and zoom beyond the bound is CSS-only.
export const RENDER_LIMITS = {
  desktop: { maxEdge: 8192, maxPixels: 32_000_000 },
  touch:   { maxEdge: 4096, maxPixels: 12_000_000 },
}

export function boundedRenderScale(pageWidth, pageHeight, desiredScale, limits = RENDER_LIMITS.desktop) {
  if (!isFiniteNumber(pageWidth) || !isFiniteNumber(pageHeight) || pageWidth <= 0 || pageHeight <= 0) return 0
  if (!isFiniteNumber(desiredScale) || desiredScale <= 0) return 0
  const byEdge   = limits.maxEdge / Math.max(pageWidth, pageHeight)
  const byPixels = Math.sqrt(limits.maxPixels / (pageWidth * pageHeight))
  return Math.min(desiredScale, byEdge, byPixels)
}

export const FIT_MODE = { WIDTH: 'width', PAGE: 'page' }

// CSS pixels per canonical unit so the page fits the container.
export function fitScale(pageWidth, pageHeight, containerWidth, containerHeight, mode = FIT_MODE.WIDTH) {
  if (!isFiniteNumber(pageWidth) || !isFiniteNumber(pageHeight) || pageWidth <= 0 || pageHeight <= 0) return 1
  if (!isFiniteNumber(containerWidth) || containerWidth <= 0) return 1
  const byWidth = containerWidth / pageWidth
  if (mode !== FIT_MODE.PAGE || !isFiniteNumber(containerHeight) || containerHeight <= 0) return byWidth
  return Math.min(byWidth, containerHeight / pageHeight)
}

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 8
export const ZOOM_STEP = 1.25
export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, isFiniteNumber(z) ? z : 1))

// ── Gesture zoom (Quant 1C-A) ────────────────────────────────────────────────
//
// Wheel: an exponential step per unit of `deltaY`, so a trackpad pinch (which
// browsers deliver as a ctrl-wheel with small deltas) and a mouse wheel notch
// both feel proportionate. deltaMode 1 (lines) and 2 (pages) are scaled to
// pixels first. Always clamped.
const WHEEL_ZOOM_RATE = 0.002
export function wheelZoom(zoom, deltaY, deltaMode = 0) {
  if (!isFiniteNumber(deltaY)) return clampZoom(zoom)
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  return clampZoom(clampZoom(zoom) * Math.exp(-pixels * WHEEL_ZOOM_RATE))
}

// Pinch: the zoom at the gesture's start scaled by the ratio of the current
// finger distance to the starting one. A degenerate distance changes nothing.
export function pinchZoom(startZoom, startDistance, currentDistance) {
  if (!isFiniteNumber(startDistance) || startDistance <= 0 || !isFiniteNumber(currentDistance) || currentDistance <= 0) {
    return clampZoom(startZoom)
  }
  return clampZoom(clampZoom(startZoom) * (currentDistance / startDistance))
}

// The scroll offsets that keep the sheet position under (`pointerX`,
// `pointerY`) — measured from the scroller's visible top-left — fixed while the
// CSS scale moves from `scaleBefore` to `scaleAfter`. Pure arithmetic: the
// content point under the pointer is (scroll + pointer) / scale, and it must
// be the same content point afterwards.
export function zoomAboutPoint({ scrollLeft, scrollTop, pointerX, pointerY, scaleBefore, scaleAfter }) {
  if (!isFiniteNumber(scaleBefore) || scaleBefore <= 0 || !isFiniteNumber(scaleAfter) || scaleAfter <= 0) {
    return { scrollLeft: scrollLeft ?? 0, scrollTop: scrollTop ?? 0 }
  }
  const ratio = scaleAfter / scaleBefore
  return {
    scrollLeft: Math.max(0, ((scrollLeft ?? 0) + (pointerX ?? 0)) * ratio - (pointerX ?? 0)),
    scrollTop:  Math.max(0, ((scrollTop ?? 0) + (pointerY ?? 0)) * ratio - (pointerY ?? 0)),
  }
}

// Distance between two pointers (pinch), in CSS pixels.
export const pointerDistance = (a, b) =>
  a && b && isFiniteNumber(a.x) && isFiniteNumber(b.x) ? Math.hypot(b.x - a.x, b.y - a.y) : NaN

// Pointer position → canonical page coordinates, from the overlay's rendered
// box. Uses the box's RENDERED size, so any CSS scaling, zoom, device pixel
// ratio or scroll offset is already accounted for. Clamped to the page so a
// drag that leaves the sheet still produces an on-page point.
export function screenToCanonical(clientX, clientY, rect, pageWidth, pageHeight) {
  if (!rect || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height) || rect.width <= 0 || rect.height <= 0) return null
  if (!isFiniteNumber(pageWidth) || !isFiniteNumber(pageHeight)) return null
  const x = (clientX - rect.left) / rect.width * pageWidth
  const y = (clientY - rect.top) / rect.height * pageHeight
  return {
    x: Math.min(pageWidth,  Math.max(0, x)),
    y: Math.min(pageHeight, Math.max(0, y)),
  }
}

// SVG path data for a polyline (open) or polygon (closed) in canonical units.
export function pointsToPath(points, closed = false) {
  if (!isPointList(points) || points.length === 0) return ''
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
  return closed && points.length > 2 ? `${d} Z` : d
}
