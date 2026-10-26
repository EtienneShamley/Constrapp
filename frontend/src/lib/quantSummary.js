import {
  MEASUREMENT_KIND, MEASUREMENT_KINDS, MEASUREMENT_STATUS, KIND_UNITS, QUANTITY_STATE, CALIBRATION_REVIEW,
  isReadableMeasurement, measurementQuantity, calibrationReviewState, isCurrentSource, takeoffPageId,
} from './quant'
import { measurementLinkState, LINK_STATE } from './quantBoq'
import { isWithdrawnDrawing, isSupersededRevision, isWithdrawnRevision } from './drawings'
import { resolveCostCodeName } from './costCodes'

// ── Constrapp Quant™ 1C-B — the project-wide takeoff summary (ADR-53) ────────
//
// Pure: no React, no Firebase, no Firestore reads, and NO new arithmetic. Every
// quantity is lib/quant.js → measurementQuantity under the measurement's OWN
// page calibration (exactly what the page list shows); link state is
// lib/quantBoq.js → measurementLinkState; revision liveness is the drawing
// register's own helpers. This module only CLASSIFIES and GROUPS — it never
// stores a total, never writes anything, and never produces a commercial figure.
//
// ⚠️ TOTALS NEVER MIX. Lengths (m), areas (m²) and counts (no.) are totalled
// per kind, never added together. CURRENT, VALID measurements (on the
// drawing's current revision, calibrated where needed, reviewed, derivable)
// are the only ones that reach a "project total"; HISTORICAL measurements
// (an earlier revision, or a withdrawn drawing) are totalled separately and
// labelled as such; measurements NEEDING ATTENTION (uncalibrated, needs
// review, non-derivable geometry, a missing source, an invalid link) are
// counted and listed but never summed; VOIDED measurements are counted only.
// An unlinked measurement is still a valid quantity — it is listed under
// attention so the QS can link it, but it counts in the valid totals.

export const SUMMARY_CATEGORY = {
  CURRENT:    'current',    // on the current revision, derivable, reviewed — a valid quantity
  ATTENTION:  'attention',  // something must be fixed before the quantity can be trusted or applied
  HISTORICAL: 'historical', // an earlier revision, or a withdrawn drawing — kept for the record
  VOID:       'void',       // voided — history only
}

export const SUMMARY_CATEGORY_LABELS = {
  [SUMMARY_CATEGORY.CURRENT]:    'Current & valid',
  [SUMMARY_CATEGORY.ATTENTION]:  'Needs attention',
  [SUMMARY_CATEGORY.HISTORICAL]: 'Historical',
  [SUMMARY_CATEGORY.VOID]:       'Voided',
}

export const SUMMARY_ISSUE = {
  UNREADABLE:       'unreadable',
  SOURCE_MISSING:   'source_missing',
  DRAWING_WITHDRAWN:'drawing_withdrawn',
  NOT_CURRENT:      'not_current',
  UNCALIBRATED:     'uncalibrated',
  NEEDS_REVIEW:     'needs_review',
  INVALID:          'invalid',
  UNLINKED:         'unlinked',
  LINK_MISSING:     'link_missing',
  LINK_VOID:        'link_void',
  LINK_COST_CODE:   'link_cost_code',
  LINK_UNIT:        'link_unit',
}

export const SUMMARY_ISSUE_LABELS = {
  [SUMMARY_ISSUE.UNREADABLE]:        'Record could not be read',
  [SUMMARY_ISSUE.SOURCE_MISSING]:    'Drawing or sheet record missing',
  [SUMMARY_ISSUE.DRAWING_WITHDRAWN]: 'Drawing withdrawn',
  [SUMMARY_ISSUE.NOT_CURRENT]:       'On an earlier revision',
  [SUMMARY_ISSUE.UNCALIBRATED]:      'Page not calibrated',
  [SUMMARY_ISSUE.NEEDS_REVIEW]:      'Needs review — scale changed',
  [SUMMARY_ISSUE.INVALID]:           'Quantity cannot be derived',
  [SUMMARY_ISSUE.UNLINKED]:          'Not linked to a BOQ item',
  [SUMMARY_ISSUE.LINK_MISSING]:      'Linked BOQ item not found',
  [SUMMARY_ISSUE.LINK_VOID]:         'Linked BOQ item is void',
  [SUMMARY_ISSUE.LINK_COST_CODE]:    'Linked BOQ item has a different cost code',
  [SUMMARY_ISSUE.LINK_UNIT]:         'Linked BOQ item unit is incompatible',
}

// The order the attention list and its counters use: what blocks a quantity
// first, then what blocks its application, then the informational link gap.
export const SUMMARY_ISSUE_ORDER = [
  SUMMARY_ISSUE.UNREADABLE, SUMMARY_ISSUE.SOURCE_MISSING, SUMMARY_ISSUE.INVALID, SUMMARY_ISSUE.UNCALIBRATED,
  SUMMARY_ISSUE.NEEDS_REVIEW, SUMMARY_ISSUE.LINK_MISSING, SUMMARY_ISSUE.LINK_VOID, SUMMARY_ISSUE.LINK_COST_CODE,
  SUMMARY_ISSUE.LINK_UNIT, SUMMARY_ISSUE.UNLINKED, SUMMARY_ISSUE.NOT_CURRENT, SUMMARY_ISSUE.DRAWING_WITHDRAWN,
]

const LINK_ISSUE = {
  [LINK_STATE.ITEM_MISSING]:       SUMMARY_ISSUE.LINK_MISSING,
  [LINK_STATE.ITEM_VOID]:          SUMMARY_ISSUE.LINK_VOID,
  [LINK_STATE.COST_CODE_MISMATCH]: SUMMARY_ISSUE.LINK_COST_CODE,
  [LINK_STATE.UNIT_MISMATCH]:      SUMMARY_ISSUE.LINK_UNIT,
}

// The measured-at stamp, only when the stored document carries a real
// Firestore Timestamp (`toDate`). Nothing is invented for a record without one.
export const measuredAt = (m) =>
  m?.createdAt && typeof m.createdAt.toDate === 'function' ? m.createdAt : null

// ── Revision labelling ───────────────────────────────────────────────────────
//
// A measurement pins { drawingId, revisionId, page }. The drawing master knows
// its CURRENT revision (id + code); the revisions subcollection is subscribed
// only for the selected drawing, so for any other drawing an earlier revision
// can be named only as "earlier revision" plus the id's tail. Honest, never
// invented.
export function revisionLabel(m, drawing, revisionsById = null) {
  const rev = revisionsById?.get?.(m?.revisionId) ?? null
  const code = rev?.revisionCode ?? (drawing?.currentRevisionId === m?.revisionId ? drawing?.currentRevisionCode : null)
  const base = code ? `Rev ${code}` : `Revision …${String(m?.revisionId ?? '').slice(-4)}`
  if (!drawing) return `${base} · drawing missing`
  if (isWithdrawnDrawing(drawing)) return `${base} · drawing withdrawn`
  if (drawing.currentRevisionId === m?.revisionId) return `${base} · current`
  if (rev && isWithdrawnRevision(rev)) return `${base} · withdrawn`
  if (rev && isSupersededRevision(rev)) return `${base} · superseded`
  return `${base} · earlier revision`
}

// ── Classification ───────────────────────────────────────────────────────────

// One measurement, judged against the live records. Returns a row:
// { m, category, issues, quantity, review, drawing, page, link, current, measuredAt }
export function classifyMeasurement(m, { pagesById, drawingsById, boqItems = [] } = {}) {
  const base = { m, category: SUMMARY_CATEGORY.ATTENTION, issues: [], quantity: { value: null, unit: KIND_UNITS[m?.kind] ?? '', state: QUANTITY_STATE.INVALID }, review: null, drawing: null, page: null, link: null, current: false, measuredAt: measuredAt(m) }
  if (m?.status === MEASUREMENT_STATUS.VOID) return { ...base, category: SUMMARY_CATEGORY.VOID }
  if (!isReadableMeasurement(m)) return { ...base, issues: [SUMMARY_ISSUE.UNREADABLE] }
  const drawing = drawingsById?.get?.(m.drawingId) ?? null
  const page = pagesById?.get?.(m.takeoffPageId) ?? null
  const row = { ...base, drawing, page }
  if (!drawing || !page) return { ...row, issues: [SUMMARY_ISSUE.SOURCE_MISSING] }
  row.quantity = measurementQuantity(m, page.calibration ?? null)
  row.review = calibrationReviewState(m, page)
  row.link = measurementLinkState(m, boqItems)
  // Quantity qualification applies to EVERY category: a crossed outline, an
  // uncalibrated page or a scale changed since the measurement was taken is
  // named on a historical row too, and keeps it out of the historical total.
  const quantityIssues = []
  if (row.quantity.state === QUANTITY_STATE.INVALID) quantityIssues.push(SUMMARY_ISSUE.INVALID)
  if (row.review === CALIBRATION_REVIEW.UNCALIBRATED) quantityIssues.push(SUMMARY_ISSUE.UNCALIBRATED)
  if (row.review === CALIBRATION_REVIEW.NEEDS_REVIEW) quantityIssues.push(SUMMARY_ISSUE.NEEDS_REVIEW)
  if (isWithdrawnDrawing(drawing)) return { ...row, category: SUMMARY_CATEGORY.HISTORICAL, issues: [SUMMARY_ISSUE.DRAWING_WITHDRAWN, ...quantityIssues] }
  if (!isCurrentSource(m, drawing)) return { ...row, category: SUMMARY_CATEGORY.HISTORICAL, issues: [SUMMARY_ISSUE.NOT_CURRENT, ...quantityIssues] }
  row.current = true
  const issues = [...quantityIssues]
  if (row.link.state === LINK_STATE.NONE) issues.push(SUMMARY_ISSUE.UNLINKED)
  else if (LINK_ISSUE[row.link.state]) issues.push(LINK_ISSUE[row.link.state])
  const blocking = issues.some(i => i !== SUMMARY_ISSUE.UNLINKED)
  return { ...row, issues, category: blocking ? SUMMARY_CATEGORY.ATTENTION : SUMMARY_CATEGORY.CURRENT }
}

// ── Totals (per kind — never across kinds) ───────────────────────────────────

// Since ADR-54 an area's `total` is NET; `gross` and `deducted` ride alongside
// (zero when nothing is deducted) for the breakdown line only — never a
// second total.
export const emptyKindTotals = () => {
  const out = {}
  for (const kind of MEASUREMENT_KINDS) out[kind] = { count: 0, total: 0, unit: KIND_UNITS[kind], gross: 0, deducted: 0 }
  return out
}

// A row whose quantity may enter a total: it derived (state OK) AND it is not
// waiting for a scale review — a figure computed under a calibration the QS
// has not yet confirmed is never represented as validated, in any category.
export const isTotalable = (r) =>
  r?.quantity?.state === QUANTITY_STATE.OK && r.quantity.value !== null
  && r.review !== CALIBRATION_REVIEW.NEEDS_REVIEW
  && !(r.issues ?? []).includes(SUMMARY_ISSUE.NEEDS_REVIEW)

// Sums the rows' quantities per kind — UNROUNDED, exactly like the page
// summary; callers round once for display. Only totalable rows contribute;
// the caller decides which category of rows to pass.
export function kindTotals(rows) {
  const out = emptyKindTotals()
  for (const r of rows ?? []) {
    if (!isTotalable(r)) continue
    const entry = out[r.m.kind]
    if (!entry) continue
    entry.count += 1
    entry.total += r.quantity.value
    entry.gross += typeof r.quantity.gross === 'number' ? r.quantity.gross : r.quantity.value
    entry.deducted += typeof r.quantity.deducted === 'number' ? r.quantity.deducted : 0
  }
  return out
}

const countBy = (rows, category) => rows.filter(r => r.category === category).length
const validRows = (rows) => rows.filter(r => r.category === SUMMARY_CATEGORY.CURRENT)
const historicalRows = (rows) => rows.filter(r => r.category === SUMMARY_CATEGORY.HISTORICAL)

// ── The summary ──────────────────────────────────────────────────────────────
//
// {
//   rows,                               — every measurement, classified
//   counts: { current, attention, historical, void, total },
//   issueCounts: { [issue]: n },        — over every non-void row
//   totals: { current, historical },    — kind totals, each category alone
//   byCostCode: [{ costCodeId, name, totals, historical, counts }],
//   byDrawing:  [{ drawingId, drawing, number, title, withdrawn, revisions: [{ revisionId, label, current, pages: [{ page, pageId, totals, historical, counts, target }] }] }],
//   attention,                          — rows to act on (attention + unlinked current), issue order
//   historical, voided                  — rows
// }
export function summariseTakeoff({ measurements = [], takeoffPages = [], drawings = [], costCodes = [], boqItems = [], revisions = [] } = {}) {
  const pagesById = new Map((takeoffPages ?? []).map(p => [p.id, p]))
  const drawingsById = new Map((drawings ?? []).map(d => [d.id, d]))
  const revisionsById = new Map((revisions ?? []).map(r => [r.id, r]))

  const seen = new Set()
  const rows = []
  for (const m of measurements ?? []) {
    if (!m?.id || seen.has(m.id)) continue
    seen.add(m.id)
    const row = classifyMeasurement(m, { pagesById, drawingsById, boqItems })
    const drawing = row.drawing ?? drawingsById.get(m.drawingId) ?? null
    rows.push({
      ...row,
      costCode: typeof m.costCodeId === 'string' ? resolveCostCodeName(m.costCodeId, costCodes, m.costCodeName) : '—',
      revisionLabel: revisionLabel(m, drawing, revisionsById),
    })
  }

  const counts = {
    current:    countBy(rows, SUMMARY_CATEGORY.CURRENT),
    attention:  countBy(rows, SUMMARY_CATEGORY.ATTENTION),
    historical: countBy(rows, SUMMARY_CATEGORY.HISTORICAL),
    void:       countBy(rows, SUMMARY_CATEGORY.VOID),
    total:      rows.length,
  }
  const issueCounts = {}
  for (const r of rows) for (const issue of r.issues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1

  // By cost code — register order of the measurements' codes, named live.
  const byCode = new Map()
  for (const r of rows) {
    if (r.category === SUMMARY_CATEGORY.VOID || !r.m?.costCodeId) continue
    const key = r.m.costCodeId
    if (!byCode.has(key)) byCode.set(key, { costCodeId: key, name: resolveCostCodeName(key, costCodes, r.m.costCodeName), rows: [] })
    byCode.get(key).rows.push(r)
  }
  const byCostCode = [...byCode.values()]
    .map(g => ({
      costCodeId: g.costCodeId, name: g.name,
      totals: kindTotals(validRows(g.rows)),
      historical: kindTotals(historicalRows(g.rows)),
      counts: { current: countBy(g.rows, SUMMARY_CATEGORY.CURRENT), attention: countBy(g.rows, SUMMARY_CATEGORY.ATTENTION), historical: countBy(g.rows, SUMMARY_CATEGORY.HISTORICAL) },
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // By drawing → revision → page. Void rows are counted on their page so the
  // sheet reads whole; they total nothing.
  const byDrawingMap = new Map()
  for (const r of rows) {
    const d = r.drawing ?? drawingsById.get(r.m?.drawingId) ?? null
    const drawingId = r.m?.drawingId ?? 'unknown'
    if (!byDrawingMap.has(drawingId)) {
      byDrawingMap.set(drawingId, {
        drawingId, drawing: d,
        number: d?.drawingNumber ?? 'Unknown drawing', title: d?.title ?? '',
        withdrawn: !!d && isWithdrawnDrawing(d),
        revisions: new Map(),
      })
    }
    const dg = byDrawingMap.get(drawingId)
    const revisionId = r.m?.revisionId ?? 'unknown'
    if (!dg.revisions.has(revisionId)) {
      dg.revisions.set(revisionId, {
        revisionId,
        label: revisionLabel(r.m, d, revisionsById),
        current: !!d && d.currentRevisionId === revisionId,
        pages: new Map(),
      })
    }
    const rg = dg.revisions.get(revisionId)
    const pageNo = r.m?.page ?? 0
    if (!rg.pages.has(pageNo)) rg.pages.set(pageNo, { page: pageNo, pageId: takeoffPageId(drawingId, revisionId, pageNo), rows: [] })
    rg.pages.get(pageNo).rows.push(r)
  }
  const byDrawing = [...byDrawingMap.values()]
    .map(dg => ({
      ...dg,
      revisions: [...dg.revisions.values()]
        .map(rg => ({
          ...rg,
          pages: [...rg.pages.values()]
            .map(pg => ({
              page: pg.page, pageId: pg.pageId,
              totals: kindTotals(validRows(pg.rows)),
              historical: kindTotals(historicalRows(pg.rows)),
              counts: {
                current: countBy(pg.rows, SUMMARY_CATEGORY.CURRENT), attention: countBy(pg.rows, SUMMARY_CATEGORY.ATTENTION),
                historical: countBy(pg.rows, SUMMARY_CATEGORY.HISTORICAL), void: countBy(pg.rows, SUMMARY_CATEGORY.VOID),
              },
              target: dg.drawing && !dg.withdrawn ? { drawingId: dg.drawingId, revisionId: rg.revisionId, page: pg.page, measurementId: null } : null,
            }))
            .sort((a, b) => a.page - b.page),
        }))
        // The current revision first, then the rest by label.
        .sort((a, b) => (a.current === b.current ? a.label.localeCompare(b.label) : a.current ? -1 : 1)),
    }))
    .sort((a, b) => a.number.localeCompare(b.number))

  const issueRank = (r) => Math.min(...r.issues.map(i => SUMMARY_ISSUE_ORDER.indexOf(i)).filter(i => i >= 0), SUMMARY_ISSUE_ORDER.length)
  const attention = rows
    .filter(r => r.category === SUMMARY_CATEGORY.ATTENTION || (r.category === SUMMARY_CATEGORY.CURRENT && r.issues.includes(SUMMARY_ISSUE.UNLINKED)))
    .sort((a, b) => issueRank(a) - issueRank(b) || (a.m.label ?? '').localeCompare(b.m.label ?? ''))
  const historical = historicalRows(rows)
  const voided = rows.filter(r => r.category === SUMMARY_CATEGORY.VOID)

  return {
    rows, counts, issueCounts,
    totals: { current: kindTotals(validRows(rows)), historical: kindTotals(historical) },
    byCostCode, byDrawing, attention, historical, voided,
  }
}

// ── Readiness: may the summary be trusted right now? ─────────────────────────
//
// `sources` carries { loading, error } per subscription the summary was built
// from (measurements, pages, drawings, cost codes, BOQ items). A failed read is
// UNAVAILABLE and a pending one is LOADING — neither is ever "no issues".

export const SUMMARY_READINESS = { LOADING: 'loading', UNAVAILABLE: 'unavailable', READY: 'ready' }

export function summaryReadiness(sources = {}) {
  const flags = Object.values(sources)
  if (flags.some(s => s?.error)) return SUMMARY_READINESS.UNAVAILABLE
  if (flags.some(s => s?.loading)) return SUMMARY_READINESS.LOADING
  return SUMMARY_READINESS.READY
}

// ── Source traceability ──────────────────────────────────────────────────────
//
// Where a measurement can be OPENED: its drawing must be in the loaded register
// and not withdrawn (the picker offers nothing else — the Quant tab never
// displays a withdrawn drawing), and the record must not be void. Anything else
// is explained, never navigated to. Revision and page existence are confirmed
// by the workspace against the live revision list once the drawing is selected.

export const TARGET_PROBLEM = {
  VOID:              'void',
  DRAWING_MISSING:   'drawing_missing',
  DRAWING_WITHDRAWN: 'drawing_withdrawn',
  UNREADABLE:        'unreadable',
}

export const TARGET_PROBLEM_MESSAGES = {
  [TARGET_PROBLEM.VOID]:              'This measurement is voided. It is listed under Voided on its page and is no longer drawn.',
  [TARGET_PROBLEM.DRAWING_MISSING]:   'The drawing this measurement was taken on is not in the register, so its sheet cannot be opened.',
  [TARGET_PROBLEM.DRAWING_WITHDRAWN]: 'The drawing this measurement was taken on has been withdrawn. Withdrawn drawings are not opened on the Quant tab; the record stays as history.',
  [TARGET_PROBLEM.UNREADABLE]:        'This record could not be read, so there is no geometry to open.',
}

export function measurementTarget(m, { drawings = [] } = {}) {
  if (!m || typeof m !== 'object') return { ok: false, problem: TARGET_PROBLEM.UNREADABLE, message: TARGET_PROBLEM_MESSAGES[TARGET_PROBLEM.UNREADABLE] }
  if (m.status === MEASUREMENT_STATUS.VOID) return { ok: false, problem: TARGET_PROBLEM.VOID, message: TARGET_PROBLEM_MESSAGES[TARGET_PROBLEM.VOID] }
  if (typeof m.drawingId !== 'string' || typeof m.revisionId !== 'string' || !Number.isInteger(m.page) || m.page < 1) {
    return { ok: false, problem: TARGET_PROBLEM.UNREADABLE, message: TARGET_PROBLEM_MESSAGES[TARGET_PROBLEM.UNREADABLE] }
  }
  const drawing = (drawings ?? []).find(d => d?.id === m.drawingId) ?? null
  if (!drawing) return { ok: false, problem: TARGET_PROBLEM.DRAWING_MISSING, message: TARGET_PROBLEM_MESSAGES[TARGET_PROBLEM.DRAWING_MISSING] }
  if (isWithdrawnDrawing(drawing)) return { ok: false, problem: TARGET_PROBLEM.DRAWING_WITHDRAWN, message: TARGET_PROBLEM_MESSAGES[TARGET_PROBLEM.DRAWING_WITHDRAWN] }
  return { ok: true, drawingId: m.drawingId, revisionId: m.revisionId, page: m.page, measurementId: m.id ?? null }
}

export const KIND_ORDER = [MEASUREMENT_KIND.LENGTH, MEASUREMENT_KIND.AREA, MEASUREMENT_KIND.COUNT]
