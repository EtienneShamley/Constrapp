import {
  MEASUREMENT_KIND, MEASUREMENT_KINDS, MEASUREMENT_STATUS, KIND_UNITS, QUANTITY_STATE, CALIBRATION_REVIEW,
  isReadableMeasurement, measurementQuantity, calibrationReviewState, roundQuantity, isCurrentSource,
  measurementBoqItemId,
} from './quant'
import { BOQ_STATUS, boqLineAmount, isPriced, sortBoqItems, formatQuantity } from './boq'
import { isWithdrawnDrawing } from './drawings'

// ── Constrapp Quant™ 1B — measurements ↔ BOQ items (ADR-52) ──────────────────
//
// Pure: no React, no Firebase, no Firestore reads. This module owns exactly
// three things:
//
//   1. UNIT COMPATIBILITY — whether a measurement KIND (length / area / count)
//      may be applied to a BOQ item's free-text `unit`. One normaliser, one
//      alias table, factor 1 only. Anything not in the table is REFUSED; no
//      dimension is ever crossed and nothing is ever scaled.
//   2. LINK STATE — what a stored `boqItemId` currently points at (a valid
//      target, a voided item, a cost-code or unit mismatch, nothing).
//   3. AGGREGATION — the quantity the ELIGIBLE linked measurements of one item
//      add up to, derived on every read from geometry × calibration through
//      lib/quant.js, summed UNROUNDED and rounded ONCE (roundQuantity, 3 dp)
//      — plus every BLOCKER that stops the total being applied. A blocked
//      measurement is never silently omitted: one ineligible active
//      measurement blocks the whole apply.
//
// ⚠️ NOTHING HERE IS A FINANCIAL FORMULA. The only money shown is the BOQ
// item's own derived amount through lib/boq.js → boqLineAmount, exactly as the
// BOQ editor previews it. No budget, forecast, commitment or margin figure is
// read or produced.
//
// ⚠️ EVERYTHING HERE IS CLIENT-ENFORCED. Firestore rules verify a link's
// target (same project, exists, active, same cost code); they cannot read a
// list, so unit compatibility, the aggregate and "every linked measurement is
// eligible" are computed in the browser and confirmed by a person
// (docs/SECURITY.md → Deferred Control 33).

// ── Unit compatibility ───────────────────────────────────────────────────────

// Lower-case; superscript two and caret-two become "2"; whitespace and full
// stops vanish. "m²", "M2", "sq. m" and "sq m" all normalise to one key.
export function normaliseUnit(unit) {
  return String(unit ?? '')
    .toLowerCase()
    .replace(/²/g, '2')
    .replace(/\^2/g, '2')
    .replace(/[\s.]+/g, '')
}

// The ONLY accepted spellings, by measurement kind. Deliberately narrow:
// every alias is dimensionally identical to the Quant output unit (metres,
// square metres, units), so the conversion factor is always exactly 1.
export const UNIT_ALIASES = {
  [MEASUREMENT_KIND.LENGTH]: ['m', 'lm', 'linm', 'metre', 'metres', 'meter', 'meters', 'linearmetre', 'linearmetres', 'linearmeter', 'linearmeters', 'lineal', 'linealmetre', 'linealmetres'],
  [MEASUREMENT_KIND.AREA]:   ['m2', 'sqm', 'squaremetre', 'squaremetres', 'squaremeter', 'squaremeters'],
  [MEASUREMENT_KIND.COUNT]:  ['no', 'nr', 'num', 'number', 'ea', 'each', 'count'],
}

// Spellings that are REFUSED on purpose, named so the refusal is a decision
// rather than an omission: volumes, sub-multiples that would need scaling,
// mass, time, lump sums, percentages. Not consulted by the code — the table
// above is the whole allow-list — but pinned by tests and quoted in the UI.
export const REJECTED_UNIT_EXAMPLES = ['m³', 'm3', 'mm', 'cm', 'km', 'kg', 't', 'hr', 'hour', 'ls', 'sum', 'lump sum', 'item', '%']

// The measurement kind a BOQ unit accepts, or null when it is unsupported.
export function unitDimension(unit) {
  const key = normaliseUnit(unit)
  if (!key) return null
  for (const kind of MEASUREMENT_KINDS) {
    if (UNIT_ALIASES[kind].includes(key)) return kind
  }
  return null
}

export const isSupportedUnit = (unit) => unitDimension(unit) !== null

// A measurement of `kind` may be applied to an item measured in `unit`.
export const isUnitCompatible = (kind, unit) => MEASUREMENT_KINDS.includes(kind) && unitDimension(unit) === kind

export const UNIT_DIMENSION_LABELS = {
  [MEASUREMENT_KIND.LENGTH]: `length (${KIND_UNITS.length})`,
  [MEASUREMENT_KIND.AREA]:   `area (${KIND_UNITS.area})`,
  [MEASUREMENT_KIND.COUNT]:  `count (${KIND_UNITS.count})`,
}

// ── Linking ──────────────────────────────────────────────────────────────────

// The BOQ items a measurement of `kind` on `costCodeId` may be linked to:
// ACTIVE, same cost code, compatible unit. Register order.
export function linkableBoqItems(boqItems, { kind, costCodeId } = {}) {
  if (!costCodeId || !MEASUREMENT_KINDS.includes(kind)) return []
  return sortBoqItems((boqItems ?? []).filter(i =>
    i?.status === BOQ_STATUS.ACTIVE
    && i.costCodeId === costCodeId
    && isUnitCompatible(kind, i.unit),
  ))
}

// Every measurement (any status) linked to one item.
export const linkedMeasurements = (measurements, boqItemId) =>
  boqItemId ? (measurements ?? []).filter(m => measurementBoqItemId(m) === boqItemId) : []

// One line describing a BOQ item in a picker or a list — never money.
export function boqItemLabel(item) {
  if (!item) return ''
  const number = String(item.itemNumber ?? '').trim()
  return `${number ? `${number} · ` : ''}${item.description ?? ''}`.trim()
}

export const boqItemPickerLabel = (item) =>
  `${boqItemLabel(item)} · ${item.unit} · qty ${formatQuantity(item.quantity)}`

export const LINK_STATE = {
  NONE:               'none',               // not linked
  OK:                 'ok',                 // active target, same cost code, compatible unit
  ITEM_MISSING:       'item_missing',       // the id names no item in this project
  ITEM_VOID:          'item_void',          // the target was voided after linking
  COST_CODE_MISMATCH: 'cost_code_mismatch', // the item's cost code no longer matches
  UNIT_MISMATCH:      'unit_mismatch',      // the item's unit no longer accepts this kind
}

export const LINK_STATE_LABELS = {
  [LINK_STATE.NONE]:               'Not linked',
  [LINK_STATE.OK]:                 'Linked',
  [LINK_STATE.ITEM_MISSING]:       'Linked item not found',
  [LINK_STATE.ITEM_VOID]:          'Linked item is void',
  [LINK_STATE.COST_CODE_MISMATCH]: 'Linked item has a different cost code',
  [LINK_STATE.UNIT_MISMATCH]:      'Linked item unit is incompatible',
}

// What a measurement's link points at, against the BOQ items as loaded.
// `{ state, item }` — `item` is the target when it exists (whatever its state).
export function measurementLinkState(m, boqItems) {
  const boqItemId = measurementBoqItemId(m)
  if (!boqItemId) return { state: LINK_STATE.NONE, item: null }
  const item = (boqItems ?? []).find(i => i.id === boqItemId) ?? null
  if (!item) return { state: LINK_STATE.ITEM_MISSING, item: null }
  if (item.status !== BOQ_STATUS.ACTIVE) return { state: LINK_STATE.ITEM_VOID, item }
  if (item.costCodeId !== m.costCodeId) return { state: LINK_STATE.COST_CODE_MISMATCH, item }
  if (!isUnitCompatible(m.kind, item.unit)) return { state: LINK_STATE.UNIT_MISMATCH, item }
  return { state: LINK_STATE.OK, item }
}

export const isValidLinkState = (state) => state === LINK_STATE.OK

// ── Aggregation ──────────────────────────────────────────────────────────────

export const APPLY_BLOCKER = {
  UNREADABLE:         'unreadable',
  COST_CODE_MISMATCH: 'cost_code_mismatch',
  UNIT_MISMATCH:      'unit_mismatch',
  SOURCE_MISSING:     'source_missing',
  SOURCE_NOT_CURRENT: 'source_not_current',
  UNCALIBRATED:       'uncalibrated',
  NEEDS_REVIEW:       'needs_review',
  INVALID:            'invalid',
}

// Each blocker names its remedy — every remedy already exists in Quant 1A.
export const APPLY_BLOCKER_LABELS = {
  [APPLY_BLOCKER.UNREADABLE]:         { title: 'Record could not be read',       remedy: 'Void this record on the Quant tab and re-measure.' },
  [APPLY_BLOCKER.COST_CODE_MISMATCH]: { title: 'Cost code does not match',       remedy: 'Re-link the measurement on the Quant tab to an item on its cost code, or unlink it.' },
  [APPLY_BLOCKER.UNIT_MISMATCH]:      { title: 'Unit is incompatible',           remedy: 'Change the BOQ item unit, or unlink the measurement on the Quant tab.' },
  [APPLY_BLOCKER.SOURCE_MISSING]:     { title: 'Drawing or sheet record missing', remedy: 'The drawing or its takeoff page could not be found. Void or unlink the measurement.' },
  [APPLY_BLOCKER.SOURCE_NOT_CURRENT]: { title: 'Not on the current revision',    remedy: 'Re-measure on the current revision, then void or unlink this measurement.' },
  [APPLY_BLOCKER.UNCALIBRATED]:       { title: 'Page not calibrated',            remedy: 'Calibrate the page on the Quant tab.' },
  [APPLY_BLOCKER.NEEDS_REVIEW]:       { title: 'Needs review — scale changed',   remedy: 'Open the Quant tab and Mark reviewed, or re-measure.' },
  [APPLY_BLOCKER.INVALID]:            { title: 'Quantity cannot be derived',     remedy: 'Check the measurement geometry on the Quant tab.' },
}

// Classify ONE active linked measurement against its item and sources.
// Returns a row: { m, quantity, review, current, blocker, drawing, page }.
function classify(m, { item, pagesById, drawingsById }) {
  const row = { m, quantity: { value: null, unit: KIND_UNITS[m?.kind] ?? '', state: QUANTITY_STATE.INVALID }, review: null, current: false, blocker: null, drawing: null, page: null }
  if (!isReadableMeasurement(m)) { row.blocker = APPLY_BLOCKER.UNREADABLE; return row }
  const drawing = drawingsById.get(m.drawingId) ?? null
  const page = pagesById.get(m.takeoffPageId) ?? null
  row.drawing = drawing
  row.page = page
  if (m.costCodeId !== item.costCodeId) { row.blocker = APPLY_BLOCKER.COST_CODE_MISMATCH; return row }
  if (!isUnitCompatible(m.kind, item.unit)) { row.blocker = APPLY_BLOCKER.UNIT_MISMATCH; return row }
  if (!drawing || !page) { row.blocker = APPLY_BLOCKER.SOURCE_MISSING; return row }
  row.current = !isWithdrawnDrawing(drawing) && isCurrentSource(m, drawing)
  if (!row.current) { row.blocker = APPLY_BLOCKER.SOURCE_NOT_CURRENT; return row }
  row.review = calibrationReviewState(m, page)
  row.quantity = measurementQuantity(m, page.calibration ?? null)
  if (row.review === CALIBRATION_REVIEW.UNCALIBRATED) { row.blocker = APPLY_BLOCKER.UNCALIBRATED; return row }
  if (row.review === CALIBRATION_REVIEW.NEEDS_REVIEW) { row.blocker = APPLY_BLOCKER.NEEDS_REVIEW; return row }
  if (row.quantity.state !== QUANTITY_STATE.OK || row.quantity.value === null) { row.blocker = APPLY_BLOCKER.INVALID; return row }
  return row
}

// The aggregate for ONE BOQ item over the project's measurements.
//
//   {
//     item, unitKind,            — the kind the item's unit accepts (null = unsupported)
//     rows,                      — one per ACTIVE linked measurement (classified)
//     voided,                    — linked VOID measurements (history; never summed)
//     eligible, blockers,        — the partition of `rows`
//     total,                     — roundQuantity(Σ eligible unrounded) | null
//     unit,                      — the Quant output unit for this kind
//     unchanged,                 — total === item.quantity
//   }
//
// A measurement is counted at most once (rows are built from a Set of ids).
// Across projects nothing can mix: every input is one project's subscription.
export function aggregateLinkedQuantity({ item, measurements = [], takeoffPages = [], drawings = [] } = {}) {
  const unitKind = item ? unitDimension(item.unit) : null
  const empty = { item: item ?? null, unitKind, rows: [], voided: [], eligible: [], blockers: [], total: null, unit: unitKind ? KIND_UNITS[unitKind] : '', unchanged: false }
  if (!item?.id) return empty

  const pagesById = new Map((takeoffPages ?? []).map(p => [p.id, p]))
  const drawingsById = new Map((drawings ?? []).map(d => [d.id, d]))

  const seen = new Set()
  const rows = []
  const voided = []
  for (const m of linkedMeasurements(measurements, item.id)) {
    if (!m?.id || seen.has(m.id)) continue
    seen.add(m.id)
    if (m.status === MEASUREMENT_STATUS.VOID) { voided.push(m); continue }
    if (m.status !== MEASUREMENT_STATUS.ACTIVE) { rows.push({ m, quantity: { value: null, unit: '', state: QUANTITY_STATE.INVALID }, review: null, current: false, blocker: APPLY_BLOCKER.UNREADABLE, drawing: null, page: null }); continue }
    rows.push(classify(m, { item, pagesById, drawingsById }))
  }

  const eligible = rows.filter(r => r.blocker === null)
  const blockers = rows.filter(r => r.blocker !== null)
  let sum = 0
  for (const r of eligible) sum += r.quantity.value
  const total = eligible.length > 0 && blockers.length === 0 ? roundQuantity(sum) : null

  return {
    ...empty,
    rows, voided, eligible, blockers, total,
    unchanged: total !== null && Number(item.quantity) === total,
  }
}

// ── Readiness: may the aggregate be applied right now? ───────────────────────

export const APPLY_DISABLED = {
  LOADING:       'loading',
  UNAVAILABLE:   'unavailable',
  ITEM_VOID:     'item_void',
  UNIT_UNSUPPORTED: 'unit_unsupported',
  BLOCKED:       'blocked',
  NONE_ELIGIBLE: 'none_eligible',
  UNCHANGED:     'unchanged',
}

export const APPLY_DISABLED_LABELS = {
  [APPLY_DISABLED.LOADING]:          'Loading the measurements, sheets and drawings…',
  [APPLY_DISABLED.UNAVAILABLE]:      'A required source failed to load. Nothing can be applied — this is not "no measurements".',
  [APPLY_DISABLED.ITEM_VOID]:        'This BOQ item is void and cannot be changed.',
  [APPLY_DISABLED.UNIT_UNSUPPORTED]: 'This item’s unit is not supported for Quant application.',
  [APPLY_DISABLED.BLOCKED]:          'Resolve every blocker below before applying.',
  [APPLY_DISABLED.NONE_ELIGIBLE]:    'No eligible linked measurements.',
  [APPLY_DISABLED.UNCHANGED]:        'The measured total already equals the BOQ quantity.',
}

// `sources` carries the loading/error flags of EVERY subscription the
// aggregate was built from. A loading or failed source is never "no issue".
export function applyReadiness({ item, aggregate, sources = {} } = {}) {
  const flags = Object.values(sources)
  if (flags.some(s => s?.error)) return { canApply: false, reason: APPLY_DISABLED.UNAVAILABLE }
  if (flags.some(s => s?.loading)) return { canApply: false, reason: APPLY_DISABLED.LOADING }
  if (!item || item.status !== BOQ_STATUS.ACTIVE) return { canApply: false, reason: APPLY_DISABLED.ITEM_VOID }
  if (!aggregate?.unitKind) return { canApply: false, reason: APPLY_DISABLED.UNIT_UNSUPPORTED }
  if (aggregate.blockers.length > 0) return { canApply: false, reason: APPLY_DISABLED.BLOCKED }
  if (aggregate.eligible.length === 0 || aggregate.total === null) return { canApply: false, reason: APPLY_DISABLED.NONE_ELIGIBLE }
  if (aggregate.unchanged) return { canApply: false, reason: APPLY_DISABLED.UNCHANGED }
  return { canApply: true, reason: null }
}

// ── Preview (the BOQ's own arithmetic, never a second formula) ───────────────

export function applyPreview(item, total) {
  const priced = isPriced(item?.rate)
  const current = Number(item?.quantity)
  const proposed = total
  return {
    priced,
    rate: priced ? item.rate : null,
    currentQuantity: Number.isFinite(current) ? current : null,
    proposedQuantity: proposed,
    difference: proposed !== null && Number.isFinite(current) ? roundQuantity(proposed - current) : null,
    currentAmount: priced ? boqLineAmount(current, item.rate) : null,
    proposedAmount: priced && proposed !== null ? boqLineAmount(proposed, item.rate) : null,
  }
}

// ── Evidence fingerprint: WHICH measurements, in WHAT state, made the total ──
//
// A total and a count cannot identify evidence: 5 + 7 and 4 + 8 are the same
// 12 from two measurements. The fingerprint is a compact, deterministic digest
// of the ELIGIBLE rows' identity and state — measurement id and revision,
// kind, cost code, sheet identity, every stored point, the calibration
// snapshot, the page's current calibration and revision, the drawing's
// current-revision pointer and status — plus the item id and unit and the
// count. The dialog confirms against it, the apply PERSISTS it in
// `quantApplied.evidence`, and the next read recomputes it from the live
// subscriptions and compares. Rows are sorted by id, numbers are serialised
// with `String()`, so the same evidence always yields the same digest.
//
// ⚠️ It is a 64-bit FNV-1a digest, not a cryptographic hash and not a
// server-verified record: a direct-SDK client can write any string, and
// collisions, while vanishingly unlikely for this purpose, are possible. It
// answers one question honestly — "is the evidence I see now the evidence
// that was confirmed?" — and nothing more (docs/SECURITY.md → DC33).

export const EVIDENCE_VERSION = 'v1'
export const EVIDENCE_MAX_LENGTH = 128

// FNV-1a over UTF-16 code units, 64-bit, as 16 hex characters.
function fnv1a64(str) {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(n) : '')
const pointsKey = (points) => (points ?? []).map(p => `${num(p?.x)},${num(p?.y)}`).join(';')
const snapshotKey = (c) => (c ? `${num(c.revision)}/${num(c.pageDistance)}/${num(c.realDistance)}/${c.unit ?? ''}` : 'null')
const pageCalKey = (page) => (page?.calibration ? `${num(page.calibration.pageDistance)}/${num(page.calibration.realDistance)}/${page.calibration.unit ?? ''}` : 'null')

// The canonical (un-hashed) evidence text for one row.
export function evidenceRowKey(row) {
  const { m, page, drawing } = row
  return [
    m.id, num(m.revision), m.kind, m.costCodeId,
    m.drawingId, m.revisionId, num(m.page), m.takeoffPageId,
    pointsKey(m.points), snapshotKey(m.calibration),
    num(page?.calibrationRevision), pageCalKey(page),
    drawing?.currentRevisionId ?? '', drawing?.status ?? '',
  ].join(':')
}

// The fingerprint of an aggregate's ELIGIBLE evidence, or null when there is
// no applicable total (blockers, nothing eligible, no item).
export function evidenceFingerprint(aggregate) {
  if (!aggregate?.item?.id || aggregate.total === null || aggregate.eligible.length === 0) return null
  const rows = aggregate.eligible.map(evidenceRowKey).sort()
  const canonical = [aggregate.item.id, aggregate.item.unit ?? '', String(aggregate.eligible.length), ...rows].join('|')
  return `${EVIDENCE_VERSION}:${fnv1a64(canonical)}`
}

export const isValidEvidence = (e) => typeof e === 'string' && e.length > 0 && e.length <= EVIDENCE_MAX_LENGTH

// ── Provenance: the latest explicit application, and whether it still holds ──

export const QUANT_APPLIED_STATE = {
  NONE:                 'none',                 // never applied from Quant
  MATCHES:              'matches',              // item quantity == applied quantity AND the evidence fingerprint matches
  ITEM_EDITED_SINCE:    'item_edited_since',    // the item's quantity differs from what was applied
  MEASUREMENTS_CHANGED: 'measurements_changed', // the item still holds the applied quantity, but the evidence no longer matches (or is blocked)
  UNVERIFIABLE:         'unverifiable',         // the record carries no fingerprint — the original evidence cannot be verified
  UNKNOWN:              'unknown',              // sources loading or unavailable — cannot say
}

export const QUANT_APPLIED_STATE_LABELS = {
  [QUANT_APPLIED_STATE.NONE]:                 'No Quant application recorded',
  [QUANT_APPLIED_STATE.MATCHES]:              'Matches the current measurements',
  [QUANT_APPLIED_STATE.ITEM_EDITED_SINCE]:    'Outdated — the BOQ quantity was changed after this application',
  [QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED]: 'Outdated — the linked measurements changed after this application',
  [QUANT_APPLIED_STATE.UNVERIFIABLE]:         'Cannot verify the original evidence — this application recorded no fingerprint',
  [QUANT_APPLIED_STATE.UNKNOWN]:              'Cannot be assessed while sources are loading or unavailable',
}

export const isReadableQuantApplied = (q) =>
  !!q && typeof q === 'object'
  && typeof q.quantity === 'number' && Number.isFinite(q.quantity)
  && Number.isInteger(q.measurementCount) && q.measurementCount >= 1
  && typeof q.by === 'string'
  && (q.evidence === undefined || q.evidence === null || isValidEvidence(q.evidence))

// Never MATCHES while a source is loading or failed, never MATCHES without a
// persisted fingerprint, never MATCHES on total alone.
export function quantAppliedState(item, aggregate, sources = {}) {
  if (!isReadableQuantApplied(item?.quantApplied)) return QUANT_APPLIED_STATE.NONE
  const flags = Object.values(sources)
  if (flags.some(s => s?.error || s?.loading)) return QUANT_APPLIED_STATE.UNKNOWN
  if (Number(item.quantity) !== item.quantApplied.quantity) return QUANT_APPLIED_STATE.ITEM_EDITED_SINCE
  if (!isValidEvidence(item.quantApplied.evidence)) return QUANT_APPLIED_STATE.UNVERIFIABLE
  const now = evidenceFingerprint(aggregate)
  if (now === null || now !== item.quantApplied.evidence) return QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED
  return QUANT_APPLIED_STATE.MATCHES
}

// ── Evidence key: did anything the user reviewed change underneath? ──────────
//
// The in-session confirmation key: the SAME canonical row text the fingerprint
// is built from (for every row, blocked ones included, with their blocker),
// plus the item's own reviewed state. The apply dialog keeps the key the user
// confirmed against; a different key means the result must be reviewed again.
const stampKey = (ts) => (ts && typeof ts.seconds === 'number' ? `${ts.seconds}.${ts.nanoseconds ?? 0}` : String(ts ?? ''))

export function evidenceKey(item, aggregate) {
  if (!item || !aggregate) return ''
  const rows = aggregate.rows.map(r => `${r.blocker ?? 'ok'}:${evidenceRowKey(r)}`).sort()
  return [
    item.id, item.status, item.quantity, item.rate ?? 'null', item.unit, item.costCodeId, stampKey(item.updatedAt),
    aggregate.total ?? 'null', evidenceFingerprint(aggregate) ?? 'null', ...rows,
  ].join('|')
}
