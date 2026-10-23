import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  normaliseUnit, UNIT_ALIASES, REJECTED_UNIT_EXAMPLES, unitDimension, isSupportedUnit, isUnitCompatible, UNIT_DIMENSION_LABELS,
  linkableBoqItems, linkedMeasurements, boqItemLabel, boqItemPickerLabel,
  LINK_STATE, LINK_STATE_LABELS, measurementLinkState, isValidLinkState,
  APPLY_BLOCKER, APPLY_BLOCKER_LABELS, aggregateLinkedQuantity,
  APPLY_DISABLED, APPLY_DISABLED_LABELS, applyReadiness, applyPreview,
  QUANT_APPLIED_STATE, QUANT_APPLIED_STATE_LABELS, isReadableQuantApplied, quantAppliedState, evidenceKey,
  evidenceFingerprint, evidenceRowKey, isValidEvidence, EVIDENCE_VERSION, EVIDENCE_MAX_LENGTH,
} from '../../src/lib/quantBoq.js'
import { buildCalibration, roundQuantity, isReadableMeasurement, validateMeasurementDraft, measurementBoqItemId } from '../../src/lib/quant.js'
import { boqLineAmount } from '../../src/lib/boq.js'

// ── Constrapp Quant™ 1B — unit suite for lib/quantBoq.js (ADR-52) ────────────
//
// Pure unit compatibility, link state, aggregation, readiness, preview and
// provenance state — plus source-structure pins over the BOQ page and the
// apply dialog (the derivation goes through lib/boq.js → boqLineAmount, the
// subscriptions are the existing hooks, nothing else is written). Plain Node.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const P = (x, y) => ({ x, y })
// 100 page units = 1 m.
const CAL = buildCalibration({ pointA: P(0, 0), pointB: P(100, 0), realDistance: 1, unit: 'm' })
const SNAP = { revision: 1, pageDistance: 100, realDistance: 1, unit: 'm' }
const TS = (seconds) => ({ seconds, nanoseconds: 0 })

const drawing = (overrides = {}) => ({
  id: 'd1', status: 'active', drawingNumber: 'A-101', currentRevisionId: 'r2', currentRevisionCode: 'B', ...overrides,
})
const page = (overrides = {}) => ({
  id: 'd1_r2_1', drawingId: 'd1', revisionId: 'r2', page: 1, source: 'pdf', pageWidth: 612, pageHeight: 792, pageRotation: 0,
  calibration: CAL, calibrationRevision: 1, revision: 1, ...overrides,
})
let n = 0
const measurement = (overrides = {}) => ({
  id: `m${++n}`, takeoffPageId: 'd1_r2_1', drawingId: 'd1', revisionId: 'r2', page: 1,
  kind: 'area', points: [P(0, 0), P(300, 0), P(300, 400), P(0, 400)], // 3 m × 4 m = 12 m²
  label: 'Slab', costCodeId: 'cc1', costCodeName: '04-100 — Formwork', calibration: SNAP, boqItemId: 'b1',
  status: 'active', voidReason: '', voidedAt: null, voidedBy: null, revision: 1,
  createdAt: TS(1), createdBy: 'u1', updatedAt: TS(1), updatedBy: 'u1',
  ...overrides,
})
const length = (overrides = {}) => measurement({ kind: 'length', points: [P(0, 0), P(300, 400)], ...overrides }) // 5 m
const count  = (overrides = {}) => measurement({ kind: 'count', points: [P(1, 1), P(2, 2), P(3, 3)], calibration: null, ...overrides })

const item = (overrides = {}) => ({
  id: 'b1', itemNumber: '2.1', section: 'Substructure', description: 'Formwork to slab edge', unit: 'm2',
  quantity: 10, rate: 85, amount: 850, costCodeId: 'cc1', costCodeName: '04-100 — Formwork', notes: '',
  status: 'active', currency: 'AUD', revision: 1, updatedAt: TS(100), ...overrides,
})
const unpriced = (overrides = {}) => item({ rate: null, amount: null, ...overrides })

const ok = { measurements: { loading: false, error: false }, pages: { loading: false, error: false }, drawings: { loading: false, error: false }, boq: { loading: false, error: false } }
const agg = (it, ms, extra = {}) => aggregateLinkedQuantity({ item: it, measurements: ms, takeoffPages: [page()], drawings: [drawing()], ...extra })

// ── 1. Unit normalisation ────────────────────────────────────────────────────

describe('unit normalisation', () => {
  it('lower-cases, maps ² and ^2 to 2, and strips whitespace and full stops', () => {
    expect(normaliseUnit('m²')).toBe('m2')
    expect(normaliseUnit('M^2')).toBe('m2')
    expect(normaliseUnit(' Sq. m ')).toBe('sqm')
    expect(normaliseUnit('No.')).toBe('no')
    expect(normaliseUnit('lin m')).toBe('linm')
    expect(normaliseUnit('Linear  metres')).toBe('linearmetres')
    expect(normaliseUnit(null)).toBe('')
    expect(normaliseUnit(undefined)).toBe('')
  })
})

// ── 2. Compatible aliases ────────────────────────────────────────────────────

describe('compatible unit aliases — factor 1 only', () => {
  it('length: m, lm, lin m, metre(s), meter(s), linear metre(s)', () => {
    for (const u of ['m', 'M', 'lm', 'LM', 'lin m', 'lin. m', 'metre', 'metres', 'meter', 'meters', 'linear metre', 'linear metres', 'Lineal metres']) {
      expect(unitDimension(u), u).toBe('length')
      expect(isUnitCompatible('length', u), u).toBe(true)
    }
  })

  it('area: m², m2, m^2, sqm, sq m, sq.m, square metre(s)', () => {
    for (const u of ['m²', 'm2', 'M2', 'm^2', 'sqm', 'sq m', 'sq. m', 'SQ.M', 'square metre', 'square metres', 'square meters']) {
      expect(unitDimension(u), u).toBe('area')
      expect(isUnitCompatible('area', u), u).toBe(true)
    }
  })

  it('count: no, no., nr, number, ea, each, count', () => {
    for (const u of ['no', 'no.', 'No.', 'nr', 'Nr.', 'num', 'number', 'ea', 'each', 'EACH', 'count']) {
      expect(unitDimension(u), u).toBe('count')
      expect(isUnitCompatible('count', u), u).toBe(true)
    }
  })

  it('every alias in the table normalises to itself (the table is already canonical)', () => {
    for (const kind of Object.keys(UNIT_ALIASES)) {
      for (const alias of UNIT_ALIASES[kind]) expect(normaliseUnit(alias)).toBe(alias)
    }
  })

  it('labels name the Quant output unit for each dimension', () => {
    expect(UNIT_DIMENSION_LABELS).toEqual({ length: 'length (m)', area: 'area (m²)', count: 'count (no.)' })
  })
})

// ── 3. Rejected units ────────────────────────────────────────────────────────

describe('rejected and ambiguous units', () => {
  it('refuses volumes, sub-multiples, mass, time, lump sums, percentages, blanks and unknowns', () => {
    for (const u of [...REJECTED_UNIT_EXAMPLES, 'mm2', 'cm2', 'ft', 'ft2', 'yd', 'in', 'L', 'litre', 'tonne', 'day', 'wk', '', '   ', null, undefined, 'm/s', 'm 3', 'units?', 'items']) {
      expect(unitDimension(u), String(u)).toBeNull()
      expect(isSupportedUnit(u), String(u)).toBe(false)
      for (const kind of ['length', 'area', 'count']) expect(isUnitCompatible(kind, u), `${kind} ${u}`).toBe(false)
    }
  })

  it('never crosses a dimension: an area is not a length, a count is not an area', () => {
    expect(isUnitCompatible('area', 'm')).toBe(false)
    expect(isUnitCompatible('length', 'm2')).toBe(false)
    expect(isUnitCompatible('count', 'm2')).toBe(false)
    expect(isUnitCompatible('area', 'no')).toBe(false)
    expect(isUnitCompatible('length', 'each')).toBe(false)
    expect(isUnitCompatible('volume', 'm3')).toBe(false)
    expect(isUnitCompatible(undefined, 'm')).toBe(false)
  })

  it('mm and cm are refused rather than scaled — the only factor is 1', () => {
    expect(unitDimension('mm')).toBeNull()
    expect(unitDimension('cm')).toBeNull()
    expect(unitDimension('km')).toBeNull()
  })
})

// ── 4. Linkable items & link state ───────────────────────────────────────────

describe('linkable BOQ items', () => {
  const items = [
    item({ id: 'b1', unit: 'm2', itemNumber: '2.10' }),
    item({ id: 'b2', unit: 'm²', itemNumber: '2.9' }),
    item({ id: 'b3', unit: 'm3' }),                       // incompatible
    item({ id: 'b4', unit: 'm2', costCodeId: 'cc9' }),    // other cost code
    item({ id: 'b5', unit: 'm2', status: 'void' }),       // void
    item({ id: 'b6', unit: 'm', kind: undefined }),       // length item
    item({ id: 'b7', unit: 'no' }),
  ]

  it('offers only ACTIVE items on the SAME cost code whose unit accepts the kind, in register order', () => {
    expect(linkableBoqItems(items, { kind: 'area', costCodeId: 'cc1' }).map(i => i.id)).toEqual(['b2', 'b1'])
    expect(linkableBoqItems(items, { kind: 'length', costCodeId: 'cc1' }).map(i => i.id)).toEqual(['b6'])
    expect(linkableBoqItems(items, { kind: 'count', costCodeId: 'cc1' }).map(i => i.id)).toEqual(['b7'])
    expect(linkableBoqItems(items, { kind: 'area', costCodeId: 'cc9' }).map(i => i.id)).toEqual(['b4'])
  })

  it('offers nothing without a cost code or a kind, and tolerates a missing list', () => {
    expect(linkableBoqItems(items, { kind: 'area' })).toEqual([])
    expect(linkableBoqItems(items, { costCodeId: 'cc1' })).toEqual([])
    expect(linkableBoqItems(undefined, { kind: 'area', costCodeId: 'cc1' })).toEqual([])
  })

  it('labels name the item without any money', () => {
    expect(boqItemLabel(item())).toBe('2.1 · Formwork to slab edge')
    expect(boqItemLabel(item({ itemNumber: '' }))).toBe('Formwork to slab edge')
    expect(boqItemPickerLabel(item())).toBe('2.1 · Formwork to slab edge · m2 · qty 10')
    expect(boqItemPickerLabel(item())).not.toMatch(/\$|85/)
    expect(boqItemLabel(null)).toBe('')
  })
})

describe('link state', () => {
  const items = [item({ id: 'b1' }), item({ id: 'bVoid', status: 'void' }), item({ id: 'bOther', costCodeId: 'cc9' }), item({ id: 'bM3', unit: 'm3' })]

  it('classifies none / ok / missing / void / cost-code mismatch / unit mismatch', () => {
    expect(measurementLinkState(measurement({ boqItemId: null }), items)).toEqual({ state: LINK_STATE.NONE, item: null })
    expect(measurementLinkState(measurement({ boqItemId: undefined }), items).state).toBe(LINK_STATE.NONE) // 1A document
    expect(measurementLinkState(measurement({ boqItemId: 'b1' }), items).state).toBe(LINK_STATE.OK)
    expect(measurementLinkState(measurement({ boqItemId: 'ghost' }), items)).toEqual({ state: LINK_STATE.ITEM_MISSING, item: null })
    expect(measurementLinkState(measurement({ boqItemId: 'bVoid' }), items).state).toBe(LINK_STATE.ITEM_VOID)
    expect(measurementLinkState(measurement({ boqItemId: 'bOther' }), items).state).toBe(LINK_STATE.COST_CODE_MISMATCH)
    expect(measurementLinkState(measurement({ boqItemId: 'bM3' }), items).state).toBe(LINK_STATE.UNIT_MISMATCH)
    expect(isValidLinkState(LINK_STATE.OK)).toBe(true)
    expect(isValidLinkState(LINK_STATE.ITEM_VOID)).toBe(false)
    for (const s of Object.values(LINK_STATE)) expect(LINK_STATE_LABELS[s]).toBeTruthy()
  })

  it('linkedMeasurements returns every status for one item and nothing for a blank id', () => {
    const ms = [measurement({ boqItemId: 'b1' }), measurement({ boqItemId: 'b1', status: 'void' }), measurement({ boqItemId: 'b2' }), measurement({ boqItemId: null })]
    expect(linkedMeasurements(ms, 'b1')).toHaveLength(2)
    expect(linkedMeasurements(ms, null)).toEqual([])
    expect(linkedMeasurements(undefined, 'b1')).toEqual([])
  })

  it('the 1A schema stays readable: a missing boqItemId is fine, a blank string or a number is not', () => {
    expect(isReadableMeasurement(measurement({ boqItemId: undefined }))).toBe(true)
    expect(isReadableMeasurement(measurement({ boqItemId: null }))).toBe(true)
    expect(isReadableMeasurement(measurement({ boqItemId: 'b1' }))).toBe(true)
    expect(isReadableMeasurement(measurement({ boqItemId: '' }))).toBe(false)
    expect(isReadableMeasurement(measurement({ boqItemId: 7 }))).toBe(false)
    expect(measurementBoqItemId({ boqItemId: '' })).toBeNull()
    expect(measurementBoqItemId({})).toBeNull()
    expect(measurementBoqItemId({ boqItemId: 'b1' })).toBe('b1')
    const ok = { kind: 'count', points: [P(1, 1)], label: 'Doors', costCodeId: 'cc', costCodeName: '10 — Doors' }
    expect(validateMeasurementDraft(ok)).toBeNull()
    expect(validateMeasurementDraft({ ...ok, boqItemId: null })).toBeNull()
    expect(validateMeasurementDraft({ ...ok, boqItemId: 'b1' })).toBeNull()
    expect(validateMeasurementDraft({ ...ok, boqItemId: '  ' })).toMatch(/link is not valid/)
    expect(validateMeasurementDraft({ ...ok, boqItemId: 3 })).toMatch(/link is not valid/)
  })
})

// ── 5. Aggregation ───────────────────────────────────────────────────────────

describe('aggregateLinkedQuantity — eligible measurements', () => {
  it('sums UNROUNDED values and rounds ONCE to three decimals', () => {
    // Three thin strips, each 0.3333333… m² → 1.000 exactly, not 0.999.
    const strip = (id) => measurement({ id, points: [P(0, 0), P(100, 0), P(100, 33.33333333), P(0, 33.33333333)] })
    const a = agg(item(), [strip('s1'), strip('s2'), strip('s3')])
    expect(a.eligible).toHaveLength(3)
    expect(a.blockers).toHaveLength(0)
    expect(a.total).toBe(1)
    // Rounding each first would give 0.333 × 3 = 0.999.
    expect(roundQuantity(a.eligible[0].quantity.value) * 3).toBeCloseTo(0.999, 10)
    expect(a.unit).toBe('m²')
  })

  it('a 3 × 4 rectangle totals 12 m²; two of them 24; the item at 24 is unchanged', () => {
    const a = agg(item(), [measurement(), measurement()])
    expect(a.total).toBe(24)
    expect(a.unchanged).toBe(false)
    const b = agg(item({ quantity: 24 }), [measurement(), measurement()])
    expect(b.unchanged).toBe(true)
    expect(a.unitKind).toBe('area')
  })

  it('lengths and counts aggregate under their own units', () => {
    const l = agg(item({ unit: 'lm' }), [length(), length({ points: [P(0, 0), P(0, 250)] })]) // 5 + 2.5
    expect(l.total).toBe(7.5)
    expect(l.unit).toBe('m')
    const c = agg(item({ unit: 'no.' }), [count(), count({ points: [P(5, 5)] })]) // 3 + 1
    expect(c.total).toBe(4)
    expect(c.unit).toBe('no.')
  })

  it('counts the same measurement ONCE even if the list holds it twice', () => {
    const m = measurement({ id: 'dup' })
    const a = agg(item(), [m, { ...m }])
    expect(a.rows).toHaveLength(1)
    expect(a.total).toBe(12)
  })

  it('ignores measurements linked to another item, unlinked, or 1A documents', () => {
    const a = agg(item(), [measurement({ boqItemId: 'b2' }), measurement({ boqItemId: null }), measurement({ boqItemId: undefined }), measurement()])
    expect(a.rows).toHaveLength(1)
    expect(a.total).toBe(12)
  })

  it('excludes VOID measurements explicitly — listed as history, never summed', () => {
    const a = agg(item(), [measurement(), measurement({ status: 'void', voidReason: 'wrong room' })])
    expect(a.voided).toHaveLength(1)
    expect(a.rows).toHaveLength(1)
    expect(a.total).toBe(12)
  })

  it('aggregates across pages and drawings of the project when every source is current', () => {
    const d2 = drawing({ id: 'd2', currentRevisionId: 'r9', drawingNumber: 'A-201' })
    const p2 = page({ id: 'd2_r9_3', drawingId: 'd2', revisionId: 'r9', page: 3 })
    const a = aggregateLinkedQuantity({
      item: item(),
      measurements: [measurement(), measurement({ takeoffPageId: 'd2_r9_3', drawingId: 'd2', revisionId: 'r9', page: 3 })],
      takeoffPages: [page(), p2], drawings: [drawing(), d2],
    })
    expect(a.total).toBe(24)
    expect(a.rows.map(r => r.drawing.drawingNumber).sort()).toEqual(['A-101', 'A-201'])
  })

  it('returns an empty aggregate for no item and for no links', () => {
    expect(aggregateLinkedQuantity({})).toMatchObject({ rows: [], eligible: [], blockers: [], total: null, unchanged: false })
    const a = agg(item(), [])
    expect(a.total).toBeNull()
    expect(a.eligible).toEqual([])
  })
})

describe('aggregateLinkedQuantity — blockers (one ineligible active measurement blocks the whole apply)', () => {
  const expectBlocked = (a, blocker) => {
    expect(a.blockers).toHaveLength(1)
    expect(a.blockers[0].blocker).toBe(blocker)
    expect(a.total).toBeNull()
    expect(APPLY_BLOCKER_LABELS[blocker].title).toBeTruthy()
    expect(APPLY_BLOCKER_LABELS[blocker].remedy).toBeTruthy()
  }

  it('an eligible measurement beside a blocked one still yields NO total — nothing is silently omitted', () => {
    const a = agg(item(), [measurement(), measurement({ calibration: { ...SNAP, revision: 0 } })])
    expect(a.eligible).toHaveLength(1)
    expect(a.blockers).toHaveLength(1)
    expect(a.total).toBeNull()
  })

  it('unreadable record', () => {
    expectBlocked(agg(item(), [measurement({ points: ['junk', 7] })]), APPLY_BLOCKER.UNREADABLE)
    expectBlocked(agg(item(), [measurement({ kind: 'volume' })]), APPLY_BLOCKER.UNREADABLE)
  })

  it('cost-code mismatch (the BOQ item was re-coded after linking)', () => {
    expectBlocked(agg(item({ costCodeId: 'cc9' }), [measurement()]), APPLY_BLOCKER.COST_CODE_MISMATCH)
  })

  it('unit mismatch — area to a length item, length to an area item, count to anything but a count, m³ to everything', () => {
    expectBlocked(agg(item({ unit: 'm' }), [measurement()]), APPLY_BLOCKER.UNIT_MISMATCH)
    expectBlocked(agg(item(), [length()]), APPLY_BLOCKER.UNIT_MISMATCH)
    expectBlocked(agg(item(), [count()]), APPLY_BLOCKER.UNIT_MISMATCH)
    const m3 = agg(item({ unit: 'm3' }), [measurement()])
    expectBlocked(m3, APPLY_BLOCKER.UNIT_MISMATCH)
    expect(m3.unitKind).toBeNull()
  })

  it('mixed kinds linked to one item: the wrong kind blocks, the right kind is eligible, no total', () => {
    const a = agg(item(), [measurement(), length()])
    expect(a.eligible).toHaveLength(1)
    expect(a.blockers.map(r => r.blocker)).toEqual([APPLY_BLOCKER.UNIT_MISMATCH])
    expect(a.total).toBeNull()
  })

  it('missing drawing or missing takeoff page', () => {
    expectBlocked(aggregateLinkedQuantity({ item: item(), measurements: [measurement()], takeoffPages: [page()], drawings: [] }), APPLY_BLOCKER.SOURCE_MISSING)
    expectBlocked(aggregateLinkedQuantity({ item: item(), measurements: [measurement()], takeoffPages: [], drawings: [drawing()] }), APPLY_BLOCKER.SOURCE_MISSING)
  })

  it('superseded revision (not the drawing’s current pointer) and withdrawn drawing both block', () => {
    expectBlocked(agg(item(), [measurement({ revisionId: 'r1', takeoffPageId: 'd1_r1_1' })], { takeoffPages: [page(), page({ id: 'd1_r1_1', revisionId: 'r1' })] }), APPLY_BLOCKER.SOURCE_NOT_CURRENT)
    expectBlocked(agg(item(), [measurement()], { drawings: [drawing({ status: 'withdrawn' })] }), APPLY_BLOCKER.SOURCE_NOT_CURRENT)
    // A drawing whose pointer moved to a NEW revision: the old sheet's measurements are stale.
    expectBlocked(agg(item(), [measurement()], { drawings: [drawing({ currentRevisionId: 'r3' })] }), APPLY_BLOCKER.SOURCE_NOT_CURRENT)
  })

  it('uncalibrated page (length/area) — a count on the same page is fine', () => {
    expectBlocked(agg(item(), [measurement()], { takeoffPages: [page({ calibration: null, calibrationRevision: 0 })] }), APPLY_BLOCKER.UNCALIBRATED)
    const c = agg(item({ unit: 'no' }), [count()], { takeoffPages: [page({ calibration: null, calibrationRevision: 0 })] })
    expect(c.total).toBe(3)
  })

  it('needs review after a re-calibration; a count never needs review', () => {
    expectBlocked(agg(item(), [measurement()], { takeoffPages: [page({ calibrationRevision: 2 })] }), APPLY_BLOCKER.NEEDS_REVIEW)
    const c = agg(item({ unit: 'no' }), [count()], { takeoffPages: [page({ calibrationRevision: 2 })] })
    expect(c.total).toBe(3)
  })

  it('degenerate or crossed geometry that derives no quantity BLOCKS the apply (ADR-53 revision)', () => {
    // Readable (≥3 finite points) but collinear: validateMeasurementDraft refuses
    // it at save; a direct write could still store it. Before 1C-A it derived 0
    // and was summed; it is now INVALID — a zero-area outline is not an area.
    const a = agg(item(), [measurement({ points: [P(0, 0), P(1, 0), P(2, 0)] })])
    expect(a.rows[0].quantity.value).toBeNull()
    expect(a.rows[0].quantity.state).toBe('invalid')
    expect(a.rows[0].blocker).toBe(APPLY_BLOCKER.INVALID)
    expect(a.total).toBeNull()
    // A crossed outline with a plausible non-zero shoelace figure blocks the same way.
    const crossed = agg(item(), [measurement({ points: [P(0, 0), P(300, 0), P(100, 400), P(300, 400)] })]) // shoelace 2 m², crossed
    expect(crossed.rows[0].quantity.state).toBe('invalid')
    expect(crossed.rows[0].quantity.reason).toBe('self_intersecting')
    expect(crossed.blockers).toHaveLength(1)
    expect(crossed.total).toBeNull()
  })

  it('the rows carry the drawing and the current flag for the dialog’s source column', () => {
    const a = agg(item(), [measurement()])
    expect(a.rows[0].drawing.drawingNumber).toBe('A-101')
    expect(a.rows[0].current).toBe(true)
    expect(a.rows[0].review).toBe('current')
  })
})

// ── 6. Readiness ─────────────────────────────────────────────────────────────

describe('applyReadiness — a loading or failed source is never "no issue"', () => {
  const good = agg(item(), [measurement()])

  it('loading or unavailable sources disable apply before anything else is judged', () => {
    expect(applyReadiness({ item: item(), aggregate: good, sources: { ...ok, pages: { loading: true, error: false } } })).toEqual({ canApply: false, reason: APPLY_DISABLED.LOADING })
    expect(applyReadiness({ item: item(), aggregate: good, sources: { ...ok, drawings: { loading: false, error: true } } })).toEqual({ canApply: false, reason: APPLY_DISABLED.UNAVAILABLE })
    // Error wins over loading when both are present.
    expect(applyReadiness({ item: item(), aggregate: good, sources: { measurements: { loading: true, error: false }, boq: { loading: false, error: true } } }).reason).toBe(APPLY_DISABLED.UNAVAILABLE)
  })

  it('a void item, an unsupported unit, blockers, nothing eligible and an unchanged total each disable apply with their reason', () => {
    expect(applyReadiness({ item: item({ status: 'void' }), aggregate: good, sources: ok }).reason).toBe(APPLY_DISABLED.ITEM_VOID)
    expect(applyReadiness({ item: item({ unit: 'm3' }), aggregate: agg(item({ unit: 'm3' }), [measurement()]), sources: ok }).reason).toBe(APPLY_DISABLED.UNIT_UNSUPPORTED)
    expect(applyReadiness({ item: item(), aggregate: agg(item(), [measurement({ calibration: { ...SNAP, revision: 0 } })]), sources: ok }).reason).toBe(APPLY_DISABLED.BLOCKED)
    expect(applyReadiness({ item: item(), aggregate: agg(item(), []), sources: ok }).reason).toBe(APPLY_DISABLED.NONE_ELIGIBLE)
    expect(applyReadiness({ item: item({ quantity: 12 }), aggregate: agg(item({ quantity: 12 }), [measurement()]), sources: ok }).reason).toBe(APPLY_DISABLED.UNCHANGED)
    for (const r of Object.values(APPLY_DISABLED)) expect(APPLY_DISABLED_LABELS[r]).toBeTruthy()
  })

  it('an active item with an eligible, changed total may be applied', () => {
    expect(applyReadiness({ item: item(), aggregate: good, sources: ok })).toEqual({ canApply: true, reason: null })
    expect(applyReadiness({ item: item(), aggregate: good })).toEqual({ canApply: true, reason: null })
  })
})

// ── 7. Preview ───────────────────────────────────────────────────────────────

describe('applyPreview — the BOQ’s own arithmetic', () => {
  it('priced: amounts through boqLineAmount at the UNCHANGED rate; difference rounded once', () => {
    const p = applyPreview(item(), 12)
    expect(p).toEqual({
      priced: true, rate: 85, currentQuantity: 10, proposedQuantity: 12, difference: 2,
      currentAmount: boqLineAmount(10, 85), proposedAmount: boqLineAmount(12, 85),
    })
    expect(p.proposedAmount).toBe(1020)
    expect(applyPreview(item({ quantity: 12.5 }), 12).difference).toBe(-0.5)
    expect(applyPreview(item({ rate: 0 }), 12)).toMatchObject({ priced: true, rate: 0, currentAmount: 0, proposedAmount: 0 })
  })

  it('unpriced: no monetary amount is calculated at all', () => {
    const p = applyPreview(unpriced(), 12)
    expect(p).toMatchObject({ priced: false, rate: null, currentAmount: null, proposedAmount: null, proposedQuantity: 12, difference: 2 })
  })

  it('no total → no proposal', () => {
    expect(applyPreview(item(), null)).toMatchObject({ proposedQuantity: null, difference: null, proposedAmount: null, currentAmount: 850 })
  })
})

// ── 8. Provenance state ──────────────────────────────────────────────────────

describe('evidence fingerprint — WHICH measurements made the total, not just how many and how much', () => {
  // Two fixed lengths: 5 m + 7 m = 12 m from 2 measurements…
  const five  = () => length({ id: 'L-five',  points: [P(0, 0), P(300, 400)] })   // 5 m
  const seven = () => length({ id: 'L-seven', points: [P(0, 0), P(700, 0)] })     // 7 m
  // …and the SAME total from the same two ids with different geometry: 4 m + 8 m.
  const four  = () => length({ id: 'L-five',  points: [P(0, 0), P(400, 0)], revision: 2 })
  const eight = () => length({ id: 'L-seven', points: [P(0, 0), P(800, 0)], revision: 2 })
  const lmItem = (o = {}) => item({ unit: 'lm', quantity: 12, ...o })

  it('is deterministic, order-independent, versioned and bounded', () => {
    const a = evidenceFingerprint(agg(lmItem(), [five(), seven()]))
    const b = evidenceFingerprint(agg(lmItem(), [seven(), five()]))
    expect(a).toBe(b)
    expect(a).toMatch(new RegExp(`^${EVIDENCE_VERSION}:[0-9a-f]{16}$`))
    expect(a.length).toBeLessThanOrEqual(EVIDENCE_MAX_LENGTH)
    expect(isValidEvidence(a)).toBe(true)
    expect(isValidEvidence('')).toBe(false)
    expect(isValidEvidence('x'.repeat(EVIDENCE_MAX_LENGTH + 1))).toBe(false)
    expect(isValidEvidence(42)).toBe(false)
    // A 500-point SIMPLE polygon (a circle traced in order — ADR-53 refuses a
    // crossed one) still digests to the same bounded length.
    const big = measurement({ points: Array.from({ length: 500 }, (_, i) => P(Math.cos(i * 2 * Math.PI / 500) * 100 + 200, Math.sin(i * 2 * Math.PI / 500) * 100 + 200)) })
    expect(evidenceFingerprint(agg(item(), [big])).length).toBe(a.length)
  })

  it('REGRESSION — same total, same count, changed geometry: 5 + 7 → 4 + 8 is DIFFERENT evidence', () => {
    const before = agg(lmItem(), [five(), seven()])
    const after  = agg(lmItem(), [four(), eight()])
    expect(before.total).toBe(12)
    expect(after.total).toBe(12)
    expect(before.eligible).toHaveLength(2)
    expect(after.eligible).toHaveLength(2)
    expect(evidenceFingerprint(before)).not.toBe(evidenceFingerprint(after))
    const applied = { at: TS(50), by: 'u1', quantity: 12, measurementCount: 2, evidence: evidenceFingerprint(before) }
    const it12 = lmItem({ quantApplied: applied })
    expect(quantAppliedState(it12, before, ok)).toBe(QUANT_APPLIED_STATE.MATCHES)
    expect(quantAppliedState(it12, after, ok)).toBe(QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED)
  })

  it('REGRESSION — a changed measurement revision alone (same geometry) is detected', () => {
    const base = agg(lmItem(), [five(), seven()])
    const bumped = agg(lmItem(), [five(), length({ id: 'L-seven', points: [P(0, 0), P(700, 0)], revision: 2 })])
    expect(bumped.total).toBe(12)
    expect(evidenceFingerprint(base)).not.toBe(evidenceFingerprint(bumped))
  })

  it('a swapped measurement with identical geometry (different id), a re-calibrated page, a moved current-revision pointer and a snapshot change all change the evidence', () => {
    const base = evidenceFingerprint(agg(lmItem(), [five(), seven()]))
    expect(evidenceFingerprint(agg(lmItem(), [five(), length({ id: 'L-other', points: [P(0, 0), P(700, 0)] })]))).not.toBe(base)
    // Page re-calibrated AND the snapshots reviewed to revision 2 — same metres, different provenance.
    const reviewed = (m) => ({ ...m, calibration: { ...SNAP, revision: 2 } })
    expect(evidenceFingerprint(agg(lmItem(), [reviewed(five()), reviewed(seven())], { takeoffPages: [page({ calibrationRevision: 2 })] }))).not.toBe(base)
    // Same evidence on a different item is different evidence.
    expect(evidenceFingerprint(agg(lmItem({ id: 'b2' }), [five(), seven()]))).not.toBe(base)
    expect(evidenceRowKey(agg(lmItem(), [five()]).rows[0])).toContain('L-five:1:length:cc1:d1:r2:1:d1_r2_1:0,0;300,400:1/100/1/m:1:100/1/m:r2:active')
  })

  it('has no fingerprint while anything is blocked or nothing is eligible — and never counts void or unlinked rows', () => {
    expect(evidenceFingerprint(agg(lmItem(), []))).toBeNull()
    expect(evidenceFingerprint(agg(lmItem(), [five(), length({ calibration: { ...SNAP, revision: 0 } })]))).toBeNull()
    expect(evidenceFingerprint(null)).toBeNull()
    const withVoid = evidenceFingerprint(agg(lmItem(), [five(), seven(), length({ id: 'gone', status: 'void' })]))
    expect(withVoid).toBe(evidenceFingerprint(agg(lmItem(), [five(), seven()])))
  })
})

describe('quantApplied — the latest application, never a certificate', () => {
  const M = measurement({ id: 'M-fixed' })
  const synced = () => {
    const base = item({ quantity: 12 })
    const evidence = evidenceFingerprint(agg(base, [M]))
    return item({ quantity: 12, quantApplied: { at: TS(50), by: 'u1', quantity: 12, measurementCount: 1, evidence } })
  }
  const applied = synced().quantApplied

  it('readability: a map with a finite quantity, a positive integer count, an actor and an optional bounded evidence string', () => {
    expect(isReadableQuantApplied(applied)).toBe(true)
    expect(isReadableQuantApplied({ ...applied, evidence: undefined })).toBe(true) // legacy
    expect(isReadableQuantApplied(null)).toBe(false)
    expect(isReadableQuantApplied({ ...applied, measurementCount: 0 })).toBe(false)
    expect(isReadableQuantApplied({ ...applied, quantity: 'twelve' })).toBe(false)
    expect(isReadableQuantApplied({ ...applied, by: null })).toBe(false)
    expect(isReadableQuantApplied({ ...applied, evidence: '' })).toBe(false)
    expect(isReadableQuantApplied({ ...applied, evidence: 'x'.repeat(129) })).toBe(false)
  })

  it('states: none / matches / item edited since / measurements changed / unverifiable / unknown while loading or unavailable', () => {
    expect(quantAppliedState(item(), agg(item(), [M]), ok)).toBe(QUANT_APPLIED_STATE.NONE)
    const s = synced()
    expect(quantAppliedState(s, agg(s, [M]), ok)).toBe(QUANT_APPLIED_STATE.MATCHES)
    const edited = item({ quantity: 15, quantApplied: applied })
    expect(quantAppliedState(edited, agg(edited, [M]), ok)).toBe(QUANT_APPLIED_STATE.ITEM_EDITED_SINCE)
    expect(quantAppliedState(s, agg(s, [M, measurement()]), ok)).toBe(QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED)
    expect(quantAppliedState(s, agg(s, [{ ...M, calibration: { ...SNAP, revision: 0 } }]), ok)).toBe(QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED)
    expect(quantAppliedState(s, agg(s, []), ok)).toBe(QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED)
    for (const s2 of Object.values(QUANT_APPLIED_STATE)) expect(QUANT_APPLIED_STATE_LABELS[s2]).toBeTruthy()
    expect(QUANT_APPLIED_STATE_LABELS[QUANT_APPLIED_STATE.ITEM_EDITED_SINCE]).toMatch(/Outdated/)
    expect(QUANT_APPLIED_STATE_LABELS[QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED]).toMatch(/Outdated/)
    expect(QUANT_APPLIED_STATE_LABELS[QUANT_APPLIED_STATE.UNVERIFIABLE]).toMatch(/Cannot verify/)
  })

  it('REGRESSION — a LEGACY record with no fingerprint is "cannot verify", never "matches", even when total and count agree', () => {
    const legacy = item({ quantity: 12, quantApplied: { at: TS(50), by: 'u1', quantity: 12, measurementCount: 1 } })
    expect(quantAppliedState(legacy, agg(legacy, [M]), ok)).toBe(QUANT_APPLIED_STATE.UNVERIFIABLE)
    // Item-edited-since still wins over unverifiable (it is the stronger fact).
    const legacyEdited = item({ quantity: 13, quantApplied: legacy.quantApplied })
    expect(quantAppliedState(legacyEdited, agg(legacyEdited, [M]), ok)).toBe(QUANT_APPLIED_STATE.ITEM_EDITED_SINCE)
  })

  it('REGRESSION — missing or unavailable source data is never reported as matching', () => {
    const s = synced()
    const a = agg(s, [M])
    expect(quantAppliedState(s, a, { ...ok, pages: { loading: true, error: false } })).toBe(QUANT_APPLIED_STATE.UNKNOWN)
    expect(quantAppliedState(s, a, { ...ok, drawings: { loading: false, error: true } })).toBe(QUANT_APPLIED_STATE.UNKNOWN)
    expect(quantAppliedState(s, a, { ...ok, boq: { loading: false, error: true } })).toBe(QUANT_APPLIED_STATE.UNKNOWN)
    // Sources settled but the drawing or page record is gone: the row blocks, so no fingerprint — changed, not matched.
    expect(quantAppliedState(s, aggregateLinkedQuantity({ item: s, measurements: [M], takeoffPages: [page()], drawings: [] }), ok)).toBe(QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED)
    expect(quantAppliedState(s, aggregateLinkedQuantity({ item: s, measurements: [M], takeoffPages: [], drawings: [drawing()] }), ok)).toBe(QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED)
    // An aggregate not computed at all is never a match.
    expect(quantAppliedState(s, null, ok)).toBe(QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED)
  })
})

// ── 9. Evidence key ──────────────────────────────────────────────────────────

describe('evidenceKey — any change to what was reviewed changes the key', () => {
  it('is stable for the same evidence and differs when the item, a measurement, a blocker or a total moves', () => {
    const ms = [measurement({ id: 'a' }), measurement({ id: 'b' })]
    const k1 = evidenceKey(item(), agg(item(), ms))
    expect(evidenceKey(item(), agg(item(), [...ms].reverse()))).toBe(k1)
    expect(evidenceKey(item({ quantity: 11 }), agg(item({ quantity: 11 }), ms))).not.toBe(k1)
    expect(evidenceKey(item({ rate: 90 }), agg(item({ rate: 90 }), ms))).not.toBe(k1)
    expect(evidenceKey(item({ updatedAt: TS(101) }), agg(item({ updatedAt: TS(101) }), ms))).not.toBe(k1)
    expect(evidenceKey(item(), agg(item(), [ms[0]]))).not.toBe(k1)
    expect(evidenceKey(item(), agg(item(), [ms[0], measurement({ id: 'b', revision: 2 })]))).not.toBe(k1)
    expect(evidenceKey(item(), agg(item(), [ms[0], measurement({ id: 'b', calibration: { ...SNAP, revision: 0 } })]))).not.toBe(k1)
    // Same total, same count, different geometry — the key moves too (the fingerprint is part of it).
    expect(evidenceKey(item(), agg(item(), [ms[0], measurement({ id: 'b', points: [P(0, 0), P(400, 0), P(400, 300), P(0, 300)] })]))).not.toBe(k1)
    expect(evidenceKey(null, null)).toBe('')
  })

  it('the confirmation key and the persisted fingerprint are built from the SAME canonical row text', () => {
    const a = agg(item(), [measurement({ id: 'a' })])
    expect(evidenceKey(item(), a)).toContain(evidenceFingerprint(a))
    expect(evidenceKey(item(), a)).toContain(evidenceRowKey(a.rows[0]))
  })
})

// ── 10. Source-structure pins ────────────────────────────────────────────────

describe('structure — the BOQ page and the apply dialog reuse the existing hooks and arithmetic', () => {
  const lib = stripComments(read('lib/quantBoq.js'))
  const actions = stripComments(read('lib/boqActions.js'))
  const hook = stripComments(read('hooks/useBoqItems.jsx'))
  const pageSrc = stripComments(read('pages/project/ProjectBoq.jsx'))
  const modal = stripComments(read('pages/project/boq/BoqQuantityApplyModal.jsx'))

  it('lib/quantBoq.js and lib/boqActions.js import no Firebase and no React', () => {
    for (const src of [lib, actions]) {
      expect(src).not.toMatch(/from 'firebase|from "firebase|from 'react|from "react/)
    }
  })

  it('the only money derivation is boqLineAmount from lib/boq.js — no formula of its own', () => {
    expect(lib).toContain("import { BOQ_STATUS, boqLineAmount, isPriced, sortBoqItems, formatQuantity } from './boq'")
    expect(lib).not.toMatch(/\* *100|\/ *100|Math\.round\([^)]*rate/)
    expect(actions).toContain('const amount = boqLineAmount(quantity, rate)')
    expect(modal).not.toMatch(/quantity\s*\*\s*rate|rate\s*\*\s*quantity|toCents|roundMoney/)
    expect(modal).toContain('applyPreview(item, aggregate.total)')
  })

  it('aggregation goes through lib/quant.js (measurementQuantity, calibrationReviewState, roundQuantity, isCurrentSource) and sums unrounded', () => {
    expect(lib).toContain('row.quantity = measurementQuantity(m, page.calibration ?? null)')
    expect(lib).toContain('row.review = calibrationReviewState(m, page)')
    expect(lib).toContain('isCurrentSource(m, drawing)')
    expect(lib).toContain('for (const r of eligible) sum += r.quantity.value')
    expect(lib).toContain('roundQuantity(sum)')
    expect(lib).not.toMatch(/roundQuantity\(r\.quantity/)
  })

  it('the BOQ actions write ONLY the item document (plus the injected ratchet) — no other collection is named', () => {
    expect(actions.match(/tx\.update\(/g)).toHaveLength(2)
    expect(actions).not.toMatch(/tx\.set\(|tx\.delete\(/)
    expect(actions).not.toMatch(/budgetLines|forecastLines|purchaseOrders|progressClaims|supplierInvoices|supplierPayments|variations|cashFlowLines|baseline/)
    expect(actions).toContain("if (!boqVersionMatches(seen, current)) return { kind: BOQ_WRITE_ERROR.STALE }")
    expect(actions.match(/boqVersionMatches\(seen, current\)/g)).toHaveLength(2)
    expect(actions).toContain('quantApplied: { at: serverTimestamp(), by: uid, quantity, measurementCount, evidence }')
    expect(actions).toMatch(/typeof evidence !== 'string' \|\| evidence\.length === 0 \|\| evidence\.length > EVIDENCE_MAX_LENGTH/)
  })

  it('the hook routes BOTH the manual edit and the Quant apply through the guarded actions with the existing ratchet', () => {
    expect(hook).toContain("import { runUpdateBoqItem, runApplyBoqQuantity } from '../lib/boqActions'")
    expect(hook).toContain('await runUpdateBoqItem({')
    expect(hook).toContain('return runApplyBoqQuantity({')
    expect(hook.match(/stageLock: \(tx\) => stageProjectCurrencyLock\(tx, companyId, projectId\)/g)).toHaveLength(2)
    expect(hook).not.toMatch(/tx\.update\(ref, \{\s*\.\.\.fields/)
    expect(hook).toContain('applyBoqQuantity,')
  })

  it('the BOQ page mounts the existing takeoff and drawing hooks (read-only) and resolves the LIVE item for the dialog', () => {
    expect(pageSrc).toContain('useTakeoffMeasurements(mid)')
    expect(pageSrc).toContain('useTakeoffPages(mid)')
    expect(pageSrc).toContain('useDrawings(mid)')
    expect(pageSrc).toContain('const applyingItem = applying ? boqItems.find(i => i.id === applying) ?? null : null')
    expect(pageSrc).toContain('Quant ({linkedCounts.get(item.id)})')
    expect(pageSrc).toMatch(/Quant measurements are unavailable/)
    expect(pageSrc).not.toMatch(/createMeasurement|updateMeasurement|voidMeasurement|saveCalibration/)
  })

  it('the dialog binds the confirmation to the evidence key, recomputes before applying, and states loading/unavailable', () => {
    expect(modal).toContain('const key = evidenceKey(item, aggregate)')
    expect(modal).toContain('const confirmed = confirmedKey !== null && confirmedKey === key')
    expect(modal).toContain('const evidenceChanged = confirmedKey !== null && confirmedKey !== key')
    expect(modal).toContain('const latest = applyReadiness({ item, aggregate, sources })')
    expect(modal).toContain('const evidence = evidenceFingerprint(aggregate)')
    expect(modal).toContain('onApply(item, { quantity: aggregate.total, measurementCount: aggregate.eligible.length, evidence })')
    // Focus: the panel takes focus on open and the opener gets it back on close (the other dialogs autoFocus a field).
    expect(modal).toContain('panelRef.current?.focus()')
    expect(modal).toMatch(/return \(\) => \{ if \(opener && typeof opener\.focus === 'function'\) opener\.focus\(\) \}/)
    expect(modal).toContain('ref={panelRef} tabIndex={-1}')
    // Keyboard (UI polish): Escape closes unless saving; Tab / Shift+Tab are contained by the pure helper; the
    // handler sits on the dialog root so every control inside it is covered.
    expect(modal).toContain("import { tabbableWithin, tabTarget } from '../../../lib/dialogFocus'")
    expect(modal).toMatch(/if \(e\.key === 'Escape'\) \{\s*if \(saving\) return\s*e\.preventDefault\(\)\s*onClose\(\)\s*return\s*\}/)
    expect(modal).toContain("if (e.key !== 'Tab') return")
    expect(modal).toContain('tabbable: tabbableWithin(panel),')
    expect(modal).toContain('fallback: panel,')
    expect(modal).toContain('if (target) { e.preventDefault(); target.focus() }')
    expect(modal).toMatch(/role="dialog" aria-modal="true" aria-labelledby="boq-apply-title" onKeyDown=\{onKeyDown\}/)
    expect(modal).not.toMatch(/focus-trap|react-focus-lock|@headlessui|@radix-ui/)
    // Money: existing and proposed amounts to the currency's minor unit, like the BOQ editor and void dialogs.
    expect(modal).toContain('const money = (n) => formatCurrency(n, currencyCode, { precise: true })')
    expect(modal).toContain('money(preview.currentAmount)')
    expect(modal).toContain('money(preview.proposedAmount)')
    expect(modal).not.toMatch(/formatCurrency\([^)]*currencyCode\)/)
    // The rules name the same five provenance keys.
    const rules = readFileSync(fileURLToPath(new URL('../../firestore.rules', import.meta.url)), 'utf8')
    expect(rules).toContain("q.keys().hasAll(['at', 'by', 'quantity', 'measurementCount', 'evidence'])")
    expect(rules).toContain('q.evidence is string && q.evidence.size() > 0 && q.evidence.size() <= 128')
    expect(modal).toContain('APPLY_DISABLED_LABELS[APPLY_DISABLED.LOADING]')
    expect(modal).toContain('APPLY_DISABLED_LABELS[APPLY_DISABLED.UNAVAILABLE]')
    expect(modal).toMatch(/not\s+an immutable history, a certification or server-verified evidence/)
    expect(modal).toMatch(/the same total from different measurements reads as outdated/)
    expect(modal).toMatch(/Unpriced — no monetary amount is calculated/)
    expect(modal).toMatch(/role="dialog" aria-modal="true"/)
  })

  it('the Quant editor clears the link when the cost code changes, with a visible notice', () => {
    const editor = stripComments(read('pages/project/quant/MeasurementEditorModal.jsx'))
    expect(editor).toContain('if (boqItemId && nextId !== costCodeId) {')
    expect(editor).toMatch(/cleared because the cost code changed/)
    expect(editor).toContain("boqItemId: boqItemId || null")
    const actionsSrc = stripComments(read('lib/quantActions.js'))
    expect(actionsSrc).toContain('if (recoded && write.boqItemId === undefined && measurementBoqItemId(current)) write.boqItemId = null')
  })
})
