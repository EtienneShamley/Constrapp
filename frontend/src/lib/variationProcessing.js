import {
  VARIATION_TYPE, VARIATION_STATUS, VARIATION_REASON, VARIATION_MAX_LINES, VARIATION_PO_STATUSES,
  TAX_CODES, formatClientVariationNumber, formatSupplierVariationNumber,
  buildVariationLineItem, variationTotals, gstForLine, variationCalcVersion,
  normaliseOriginRfi, isEligibleOriginRfi, isPoLinkedSupplierVariation,
} from './variations'
import { CALC_VERSION, CURRENT_CALC_VERSION, roundToCents, roundAmount, gstOnAmount, isSupportedAmount } from './supplierCalc'
import { toCents } from './money'

// ── Trusted variation processing — the PURE half (ADR-90) ────────────────────
//
// Creating a variation, EDITING A DRAFT, approving one, and the one-time legacy
// Apply / Commit are processed by the trusted backend
// (functions/src/variations/), not by a browser transaction validated in
// Security Rules. This module is everything those four operations DECIDE and
// DERIVE, with no Firebase import: the
// callables compose the generated copy of it (functions/src/generated/
// variationCalc.js), and the browser uses the same functions to build a request
// and to preview what the server will store. One formula, two places it runs.
//
// WHAT A REQUEST MAY CARRY. A variation is an AUTHORED commercial document, so
// its content — the title, the lines, each line's ex-GST amount and tax code —
// is the user's own input and travels in the request. Nothing DERIVED does:
// no GST, no subtotal or total, no document number, no currency, no cost-code
// or counterparty snapshot of a purchase order, no RFI number or title, no
// status, no stamp, no calculation version, no company. Every one of those is
// produced here from the request and from records the transaction reads.

// The roles Security Rules let read and draft a variation (`variationMember`).
export const VARIATION_PROCESSING_ROLES = ['company_admin', 'project_manager', 'qs']

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const isId = (v) => typeof v === 'string' && ID_RE.test(v)
const isIdOrNull = (v) => v === null || isId(v)
const isDate = (v) => typeof v === 'string' && (v === '' || DATE_RE.test(v))
const isText = (v, max) => typeof v === 'string' && v.length <= max
const REASONS = ['', ...Object.values(VARIATION_REASON)]

// Bounds — the ones the variations Rules block has always applied to a stored
// document (title 1–500, description / notes 5000, names and references 200,
// 1–200 lines), plus a bound on a line description, which Rules cannot inspect.
export const VARIATION_LIMITS = Object.freeze({
  title: 500, description: 5000, notes: 5000, name: 200, reference: 200, lineDescription: 2000, lines: VARIATION_MAX_LINES,
})

// ── The create request ───────────────────────────────────────────────────────

export const CREATE_VARIATION_KEYS = [
  'projectId', 'variationId', 'variationType', 'title', 'description', 'reason',
  'clientId', 'clientName', 'clientRef', 'supplierId', 'supplierName', 'supplierRef', 'poId',
  'originRfiId', 'identifiedDate', 'submittedDate', 'responseDueDate', 'effectiveDate', 'notes', 'lines',
]
export const CREATE_VARIATION_LINE_KEYS = ['poLineIndex', 'costCodeId', 'description', 'submittedAmount', 'taxCode']

const exactKeys = (value, keys) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => k in value)

// The request the browser sends for a new variation, from the editor's values
// and its BUILT lines (lib/variations.js → buildVariationLineItem). Only the
// authored part of each line is kept; everything derived is dropped.
export function createVariationRequest({
  projectId, variationId, variationType,
  title, description, reason,
  clientId, clientName, clientRef,
  supplierId, supplierName, supplierRef,
  poId, originRfi = null,
  identifiedDate, submittedDate, responseDueDate, effectiveDate,
  lineItems, notes,
}) {
  const isClient = variationType === VARIATION_TYPE.CLIENT
  const linked = !isClient && typeof poId === 'string' && poId.length > 0
  return {
    projectId, variationId, variationType,
    title: String(title ?? '').trim(),
    description: String(description ?? '').trim(),
    reason: reason || '',
    clientId:   isClient ? (clientId ?? null) : null,
    clientName: isClient ? String(clientName ?? '').trim() : null,
    clientRef:  isClient ? String(clientRef ?? '').trim() : null,
    supplierId:   isClient || linked ? null : (supplierId ?? null),
    supplierName: isClient || linked ? null : String(supplierName ?? '').trim(),
    supplierRef:  isClient ? null : String(supplierRef ?? '').trim(),
    poId: linked ? poId : null,
    originRfiId: originRfi?.id ?? null,
    identifiedDate:  identifiedDate  || '',
    submittedDate:   submittedDate   || '',
    responseDueDate: responseDueDate || '',
    effectiveDate:   effectiveDate   || '',
    notes: String(notes ?? '').trim(),
    lines: (lineItems ?? []).map(li => {
      const inherited = Number.isInteger(li?.poLineIndex) && li.poLineIndex >= 0
      return {
        poLineIndex: inherited ? li.poLineIndex : null,
        costCodeId: inherited ? null : (typeof li?.costCodeId === 'string' && li.costCodeId.length > 0 ? li.costCodeId : null),
        description: String(li?.description ?? ''),
        submittedAmount: Number(li?.submittedAmount) || 0,
        taxCode: li?.taxCode,
      }
    }),
  }
}

// Shape and bounds of a create request. Returns null when the request is one
// the server may act on, otherwise a short reason (never shown to a user as
// such — the browser validates the same content before it sends).
export function createVariationRequestProblem(data) {
  if (!exactKeys(data, CREATE_VARIATION_KEYS)) return 'keys'
  if (!isId(data.projectId) || !isId(data.variationId)) return 'ids'
  if (data.variationType !== VARIATION_TYPE.CLIENT && data.variationType !== VARIATION_TYPE.SUPPLIER) return 'type'
  if (!isText(data.title, VARIATION_LIMITS.title) || data.title.trim().length === 0 || data.title !== data.title.trim()) return 'title'
  if (!isText(data.description, VARIATION_LIMITS.description)) return 'description'
  if (!REASONS.includes(data.reason)) return 'reason'
  for (const key of ['identifiedDate', 'submittedDate', 'responseDueDate', 'effectiveDate']) if (!isDate(data[key])) return key
  if (!isText(data.notes, VARIATION_LIMITS.notes)) return 'notes'
  if (!isIdOrNull(data.originRfiId)) return 'originRfiId'

  if (data.variationType === VARIATION_TYPE.CLIENT) {
    if (!isIdOrNull(data.clientId) || !isText(data.clientName, VARIATION_LIMITS.name) || !isText(data.clientRef, VARIATION_LIMITS.reference)) return 'client'
    if (data.supplierId !== null || data.supplierName !== null || data.supplierRef !== null || data.poId !== null) return 'client-only'
  } else {
    if (data.clientId !== null || data.clientName !== null || data.clientRef !== null) return 'supplier-only'
    if (!isText(data.supplierRef, VARIATION_LIMITS.reference)) return 'supplierRef'
    if (data.poId === null) {
      if (!isIdOrNull(data.supplierId) || !isText(data.supplierName, VARIATION_LIMITS.name)) return 'supplier'
    } else {
      // A PO-linked variation takes its supplier FROM the purchase order.
      if (!isId(data.poId) || data.supplierId !== null || data.supplierName !== null) return 'po-link'
    }
  }

  if (!Array.isArray(data.lines) || data.lines.length < 1 || data.lines.length > VARIATION_LIMITS.lines) return 'lines'
  for (const line of data.lines) {
    if (!exactKeys(line, CREATE_VARIATION_LINE_KEYS)) return 'line-keys'
    if (!isText(line.description, VARIATION_LIMITS.lineDescription)) return 'line-description'
    if (!TAX_CODES.includes(line.taxCode)) return 'line-tax-code'
    if (typeof line.submittedAmount !== 'number' || roundToCents(line.submittedAmount) === null) return 'line-amount'
    if (line.poLineIndex === null) {
      if (!isId(line.costCodeId)) return 'line-cost-code'
    } else {
      // A line that names a PO line INHERITS that line's cost code.
      if (!Number.isInteger(line.poLineIndex) || line.poLineIndex < 0 || line.costCodeId !== null || data.poId === null) return 'line-po-index'
    }
  }
  return null
}

// The cost-code ids a create request needs read (new-scope lines only).
export const requestedCostCodeIds = (input) =>
  [...new Set((input?.lines ?? []).filter(l => l.poLineIndex === null).map(l => l.costCodeId))]

// ── Building the stored draft ────────────────────────────────────────────────

export const CREATE_PROBLEM = Object.freeze({
  PO_INVALID:        'po_invalid',          // missing, or not sent / closed
  PO_LINE_INVALID:   'po_line_invalid',     // the index names no PO line, or that line has no cost code
  COST_CODE_INVALID: 'cost_code_invalid',   // a new-scope line's cost code does not exist in the company
  RFI_INVALID:       'rfi_invalid',         // missing, a draft, cancelled, or without a number and title
  OUT_OF_RANGE:      'out_of_range',        // a figure beyond the supported amount
})

// The complete document a new variation is stored as — everything derived from
// the validated request and from the records the transaction read:
//   number      the next number of the type's company counter
//   currency    the project's resolved currency
//   po          the purchase order document { id, …data } or null
//   costCodes   Map(costCodeId → cost code document) for the new-scope lines
//   rfi         the originating RFI document { id, …data } or null
//   uid, now    the caller and the server timestamp sentinel
// Returns { ok: true, document } or { ok: false, problem, detail }.
export function buildVariationDraft({ input, number, currency, po = null, costCodes = new Map(), rfi = null, uid, now }) {
  const refuse = (problem, detail = {}) => ({ ok: false, problem, detail })
  const isClient = input.variationType === VARIATION_TYPE.CLIENT
  const linked = input.poId !== null

  if (linked) {
    if (!po || po.id !== input.poId || !VARIATION_PO_STATUSES.includes(po.status)) return refuse(CREATE_PROBLEM.PO_INVALID, { poId: input.poId, status: po?.status ?? null })
    if (typeof po.poNumber !== 'string' || !isText(po.supplierName, VARIATION_LIMITS.name)) return refuse(CREATE_PROBLEM.PO_INVALID, { poId: input.poId })
  }

  const library = [...costCodes.entries()].map(([id, cc]) => ({ id, code: cc?.code, name: cc?.name }))
  const lineItems = []
  for (let index = 0; index < input.lines.length; index += 1) {
    const line = input.lines[index]
    if (line.poLineIndex !== null) {
      const poLine = (po?.lineItems ?? [])[line.poLineIndex]
      if (!poLine || typeof poLine.costCodeId !== 'string' || poLine.costCodeId.length === 0) {
        return refuse(CREATE_PROBLEM.PO_LINE_INVALID, { line: index, poLineIndex: line.poLineIndex })
      }
    } else if (!costCodes.has(line.costCodeId)) {
      return refuse(CREATE_PROBLEM.COST_CODE_INVALID, { line: index, costCodeId: line.costCodeId })
    }
    // The browser's own line builder, under the calculation version the
    // backend stamps — the preview and the stored line cannot differ.
    const built = buildVariationLineItem(
      { ...line, poLineIndex: line.poLineIndex === null ? '' : line.poLineIndex },
      { po: linked ? po : null, costCodes: library, calcVersion: CURRENT_CALC_VERSION },
    )
    if (built.submittedAmount === null || built.submittedGst === null) return refuse(CREATE_PROBLEM.OUT_OF_RANGE, { line: index })
    lineItems.push(built)
  }

  let origin = normaliseOriginRfi(null)
  if (input.originRfiId !== null) {
    if (!rfi || rfi.id !== input.originRfiId || !isEligibleOriginRfi(rfi)) return refuse(CREATE_PROBLEM.RFI_INVALID, { rfiId: input.originRfiId, status: rfi?.status ?? null })
    origin = normaliseOriginRfi(rfi)
    if (origin.originRfiId === null) return refuse(CREATE_PROBLEM.RFI_INVALID, { rfiId: input.originRfiId })
  }

  const submitted = variationTotals(lineItems, 'submitted', CURRENT_CALC_VERSION)
  if (!isSupportedAmount(submitted.subtotal) || !isSupportedAmount(submitted.gst) || !isSupportedAmount(submitted.total)) {
    return refuse(CREATE_PROBLEM.OUT_OF_RANGE)
  }

  return {
    ok: true,
    document: {
      variationNumber: isClient ? formatClientVariationNumber(number) : formatSupplierVariationNumber(number),
      variationType: input.variationType,
      status: VARIATION_STATUS.DRAFT,

      title: input.title,
      description: input.description,
      reason: input.reason,

      clientId:   isClient ? input.clientId : null,
      clientName: isClient ? input.clientName : null,
      clientRef:  isClient ? input.clientRef : null,

      supplierId:   isClient ? null : (linked ? (po.supplierId ?? null) : input.supplierId),
      supplierName: isClient ? null : (linked ? po.supplierName : input.supplierName),
      supplierRef:  isClient ? null : input.supplierRef,

      poId:     linked ? po.id : null,
      poNumber: linked ? po.poNumber : null,

      ...origin,

      lineItems,

      submittedSubtotal: submitted.subtotal,
      submittedGst:      submitted.gst,
      submittedTotal:    submitted.total,
      approvedSubtotal:  null,
      approvedGst:       null,
      approvedTotal:     null,
      forecastAmount:    null,

      identifiedDate:  input.identifiedDate,
      submittedDate:   input.submittedDate,
      responseDueDate: input.responseDueDate,
      approvedDate:    '',
      effectiveDate:   input.effectiveDate,

      currency,
      // The calculation policy of every figure on this document, now and at
      // approval (lib/supplierCalc.js). Written here, once; never by a client.
      calcVersion: CURRENT_CALC_VERSION,
      revision: 1,
      notes: input.notes,
      assessmentNotes: '',

      submittedAt: null, submittedBy: null,
      approvedAt:  null, approvedBy:  null,
      rejectedAt:  null, rejectedBy:  null,
      withdrawnAt: null, withdrawnBy: null,

      attachments:             [],
      externalRefs:            {},
      supersededByVariationId: null,

      createdAt: now,
      createdBy: uid,
      updatedAt: now,
      updatedBy: uid,
    },
  }
}

// ── Editing a draft ──────────────────────────────────────────────────────────
//
// A draft edit REPLACES the authored content. The request carries what the
// editor holds — never a derived figure — plus the revision the user edited,
// and the server derives the stored lines and header again in full.
//
// CALCULATION VERSION OF AN EDITED DRAFT. A draft that the backend saves is
// stored under the CURRENT calculation version (2, exact), whatever it was
// before: after the edit every figure on it has just been derived, so nothing
// historical remains to preserve, and a draft is not yet a financial fact. A
// legacy draft that nobody edits stays legacy and is verified as legacy when
// it is approved. An approved, rejected or withdrawn variation can never be
// edited, so no historical obligation is touched.

export const UPDATE_VARIATION_KEYS = [
  'projectId', 'variationId', 'expectedRevision', 'title', 'description', 'reason',
  'clientRef', 'supplierRef', 'identifiedDate', 'responseDueDate', 'effectiveDate',
  'notes', 'changeOriginRfi', 'originRfiId', 'lines',
]

// The request the browser sends for a draft edit, from the reviewed copy and
// the editor's values. `data.notes` undefined keeps the stored notes;
// `data.originRfi` undefined keeps the stored link (which is how a link to a
// since-cancelled RFI survives unrelated edits), null removes it, an RFI
// document sets it.
export function updateVariationRequest({ projectId, seen, data }) {
  const isClient = seen?.variationType === VARIATION_TYPE.CLIENT
  const changeOriginRfi = data?.originRfi !== undefined
  return {
    projectId,
    variationId: seen?.id,
    expectedRevision: Number.isFinite(Number(seen?.revision)) ? Number(seen.revision) : 0,
    title: String(data?.title ?? '').trim(),
    description: String(data?.description ?? '').trim(),
    reason: data?.reason || '',
    clientRef:   isClient ? String(data?.clientRef ?? '').trim() : null,
    supplierRef: isClient ? null : String(data?.supplierRef ?? '').trim(),
    identifiedDate:  data?.identifiedDate  || '',
    responseDueDate: data?.responseDueDate || '',
    effectiveDate:   data?.effectiveDate   || '',
    notes: data?.notes === undefined ? null : String(data.notes ?? '').trim(),
    changeOriginRfi,
    originRfiId: changeOriginRfi ? (data.originRfi?.id ?? null) : null,
    lines: (data?.lineItems ?? []).map(li => {
      const inherited = Number.isInteger(li?.poLineIndex) && li.poLineIndex >= 0
      return {
        poLineIndex: inherited ? li.poLineIndex : null,
        costCodeId: inherited ? null : (typeof li?.costCodeId === 'string' && li.costCodeId.length > 0 ? li.costCodeId : null),
        description: String(li?.description ?? ''),
        submittedAmount: Number(li?.submittedAmount) || 0,
        taxCode: li?.taxCode,
      }
    }),
  }
}

// Shape and bounds of a draft-edit request. Null when acceptable.
export function updateVariationRequestProblem(data) {
  if (!exactKeys(data, UPDATE_VARIATION_KEYS)) return 'keys'
  if (!isId(data.projectId) || !isId(data.variationId)) return 'ids'
  if (!Number.isInteger(data.expectedRevision) || data.expectedRevision < 0) return 'expectedRevision'
  if (!isText(data.title, VARIATION_LIMITS.title) || data.title.trim().length === 0 || data.title !== data.title.trim()) return 'title'
  if (!isText(data.description, VARIATION_LIMITS.description)) return 'description'
  if (!REASONS.includes(data.reason)) return 'reason'
  for (const key of ['identifiedDate', 'responseDueDate', 'effectiveDate']) if (!isDate(data[key])) return key
  if (!(data.notes === null || isText(data.notes, VARIATION_LIMITS.notes))) return 'notes'
  if (!(data.clientRef === null || isText(data.clientRef, VARIATION_LIMITS.reference))) return 'clientRef'
  if (!(data.supplierRef === null || isText(data.supplierRef, VARIATION_LIMITS.reference))) return 'supplierRef'
  if ((data.clientRef === null) === (data.supplierRef === null)) return 'refs'          // exactly one side
  if (typeof data.changeOriginRfi !== 'boolean') return 'changeOriginRfi'
  if (!isIdOrNull(data.originRfiId) || (!data.changeOriginRfi && data.originRfiId !== null)) return 'originRfiId'
  if (!Array.isArray(data.lines) || data.lines.length < 1 || data.lines.length > VARIATION_LIMITS.lines) return 'lines'
  for (const line of data.lines) {
    if (!exactKeys(line, CREATE_VARIATION_LINE_KEYS)) return 'line-keys'
    if (!isText(line.description, VARIATION_LIMITS.lineDescription)) return 'line-description'
    if (!TAX_CODES.includes(line.taxCode)) return 'line-tax-code'
    if (typeof line.submittedAmount !== 'number' || roundToCents(line.submittedAmount) === null) return 'line-amount'
    if (line.poLineIndex === null) {
      if (!isId(line.costCodeId)) return 'line-cost-code'
    } else if (!Number.isInteger(line.poLineIndex) || line.poLineIndex < 0 || line.costCodeId !== null) {
      return 'line-po-index'
    }
  }
  return null
}

export const DRAFT_PROBLEM = Object.freeze({
  ...CREATE_PROBLEM,
  REFS_INVALID: 'refs_invalid',   // the external reference is on the wrong side for the variation's type
})

// The update a draft edit writes, derived in full from the validated request
// and the records the transaction read: `live` the stored draft { id, …data },
// `po` ITS purchase order (or null), `costCodes` and `rfi` as for a create.
// The type, the counterparty, the purchase-order link, the number, the
// currency and every stamp but the audit pair are never written. Returns
// { ok: true, update } or { ok: false, problem, detail }.
export function buildVariationDraftUpdate({ input, live, po = null, costCodes = new Map(), rfi = null, uid, now }) {
  const refuse = (problem, detail = {}) => ({ ok: false, problem, detail })
  const isClient = live?.variationType === VARIATION_TYPE.CLIENT
  if (isClient ? (input.clientRef === null || input.supplierRef !== null) : (input.supplierRef === null || input.clientRef !== null)) {
    return refuse(DRAFT_PROBLEM.REFS_INVALID)
  }
  const linked = isPoLinkedSupplierVariation(live)

  const library = [...costCodes.entries()].map(([id, cc]) => ({ id, code: cc?.code, name: cc?.name }))
  const lineItems = []
  for (let index = 0; index < input.lines.length; index += 1) {
    const line = input.lines[index]
    if (line.poLineIndex !== null) {
      // The purchase order's STATUS is not re-checked on an edit (a draft
      // survives its order's cancellation; approval is what requires a
      // committed order) — but the line it names must exist on that order.
      if (!linked || !po || po.id !== live.poId) return refuse(DRAFT_PROBLEM.PO_LINE_INVALID, { line: index, poLineIndex: line.poLineIndex })
      const poLine = (po.lineItems ?? [])[line.poLineIndex]
      if (!poLine || typeof poLine.costCodeId !== 'string' || poLine.costCodeId.length === 0) {
        return refuse(DRAFT_PROBLEM.PO_LINE_INVALID, { line: index, poLineIndex: line.poLineIndex })
      }
    } else if (!costCodes.has(line.costCodeId)) {
      return refuse(DRAFT_PROBLEM.COST_CODE_INVALID, { line: index, costCodeId: line.costCodeId })
    }
    const built = buildVariationLineItem(
      { ...line, poLineIndex: line.poLineIndex === null ? '' : line.poLineIndex },
      { po: linked ? po : null, costCodes: library, calcVersion: CURRENT_CALC_VERSION },
    )
    if (built.submittedAmount === null || built.submittedGst === null) return refuse(DRAFT_PROBLEM.OUT_OF_RANGE, { line: index })
    lineItems.push(built)
  }

  let origin = {}
  if (input.changeOriginRfi) {
    if (input.originRfiId === null) {
      origin = normaliseOriginRfi(null)
    } else {
      if (!rfi || rfi.id !== input.originRfiId || !isEligibleOriginRfi(rfi)) return refuse(DRAFT_PROBLEM.RFI_INVALID, { rfiId: input.originRfiId, status: rfi?.status ?? null })
      origin = normaliseOriginRfi(rfi)
      if (origin.originRfiId === null) return refuse(DRAFT_PROBLEM.RFI_INVALID, { rfiId: input.originRfiId })
    }
  }

  const submitted = variationTotals(lineItems, 'submitted', CURRENT_CALC_VERSION)
  if (!isSupportedAmount(submitted.subtotal) || !isSupportedAmount(submitted.gst) || !isSupportedAmount(submitted.total)) {
    return refuse(DRAFT_PROBLEM.OUT_OF_RANGE)
  }
  const revision = Number.isFinite(Number(live?.revision)) ? Number(live.revision) : 0

  return {
    ok: true,
    update: {
      ...origin,
      title: input.title,
      description: input.description,
      reason: input.reason,
      clientRef: isClient ? input.clientRef : null,
      supplierRef: isClient ? null : input.supplierRef,
      identifiedDate: input.identifiedDate,
      responseDueDate: input.responseDueDate,
      effectiveDate: input.effectiveDate,
      lineItems,
      submittedSubtotal: submitted.subtotal,
      submittedGst: submitted.gst,
      submittedTotal: submitted.total,
      ...(input.notes === null ? {} : { notes: input.notes }),
      // Every figure above was derived just now, under the current version.
      calcVersion: CURRENT_CALC_VERSION,
      revision: revision + 1,
      updatedAt: now,
      updatedBy: uid,
    },
  }
}

// True when the stored draft already IS what this edit writes — the answer to
// a repeated request whose first answer was lost. The audit pair and the
// revision are not compared (the revision is checked by the caller).
export function draftAlreadyHolds(live, update) {
  const skip = new Set(['revision', 'updatedAt', 'updatedBy'])
  return Object.keys(update).filter(k => !skip.has(k)).every(k => JSON.stringify(live?.[k] ?? null) === JSON.stringify(update[k] ?? null))
}

// ── Approval ─────────────────────────────────────────────────────────────────

// Statuses a variation may be approved from: `submitted`, and the reserved
// `under_review` — no application path enters it, but a document already
// holding it must not be stranded (the Rules have always admitted it).
export const APPROVABLE_STATUSES = [VARIATION_STATUS.SUBMITTED, VARIATION_STATUS.UNDER_REVIEW]

export const ASSESSMENT_NOTES_MAX = 5000

// The amounts of an approve request: one finite number per line, each inside
// the supported range once rounded. Null when valid, else a short reason.
export function approvedAmountsProblem(approvedAmounts) {
  if (!Array.isArray(approvedAmounts) || approvedAmounts.length < 1 || approvedAmounts.length > VARIATION_LIMITS.lines) return 'count'
  for (const a of approvedAmounts) {
    if (typeof a !== 'number' || roundToCents(a) === null) return 'amount'
  }
  return null
}

// ── Verification of STORED content (before approval and before commitment) ───
//
// A draft is authored content, not a financial fact; it becomes one only when
// it is approved, and an approved variation becomes commitment only when it is
// applied. Since ADR-90 every draft is WRITTEN by the backend, so new content
// is derived, never forged. But a variation may have been stored earlier —
// under Security Rules, which cannot look inside the line array (Deferred
// Control 37) — so NOTHING STORED IS TRUSTED when it is about to become
// authoritative: the two functions below re-derive it, under the document's
// own calculation version, and the operation is refused unless it reconciles.
//
// Historical compatibility protects legitimate historical FACTS — an approved
// variation is never recalculated or rewritten. It gives no authority to
// unverified draft content.

// The exact keys of a stored variation line.
export const VARIATION_LINE_KEYS = [
  'costCodeId', 'costCodeName', 'description', 'submittedAmount', 'submittedGst',
  'approvedAmount', 'approvedGst', 'poLineIndex', 'taxCode',
]

// The line GST values the LEGACY editor could have stored for a line whose
// stored (rounded) amount is `amount`. It derived GST from the amount AS
// ENTERED and rounded the amount separately, so an entry carrying a fraction
// of a cent could store a GST one cent either side of the GST of the rounded
// amount. The set is therefore the legacy GST of the stored amount and of the
// two extremes that round to it — never wider, and exactly one value except on
// a half-cent boundary. Whole cents.
function legacyLineGstCents(amount) {
  const out = new Set()
  for (const entered of [amount, amount - 0.0049, amount + 0.0049]) out.add(toCents(gstOnAmount(entered, CALC_VERSION.LEGACY)))
  return out
}

// True when `gst` is a GST figure the document's calculation version produces
// for `amount` and `taxCode`. `exact` forces the single derived value (the
// approved side is always derived from the already-rounded amount).
function lineGstReconciles(amount, taxCode, gst, version, { exact = false } = {}) {
  if (typeof gst !== 'number' || !Number.isFinite(gst)) return false
  const derived = gstForLine(amount, taxCode, version)
  if (derived === null) return false
  if (toCents(gst) === toCents(derived)) return true
  if (exact || version !== CALC_VERSION.LEGACY || taxCode !== 'gst') return false
  return legacyLineGstCents(amount).has(toCents(gst))
}

function lineShapeProblem(li) {
  if (li === null || typeof li !== 'object' || Array.isArray(li)) return 'line'
  const keys = Object.keys(li)
  if (keys.length !== VARIATION_LINE_KEYS.length || !VARIATION_LINE_KEYS.every(k => k in li)) return 'line-keys'
  if (!TAX_CODES.includes(li.taxCode)) return 'line-tax-code'
  if (typeof li.costCodeId !== 'string' || li.costCodeId.length === 0) return 'line-cost-code'
  if (typeof li.costCodeName !== 'string' || typeof li.description !== 'string') return 'line-text'
  if (!(li.poLineIndex === null || (Number.isInteger(li.poLineIndex) && li.poLineIndex >= 0))) return 'line-po-index'
  return null
}

// A stored variation's SUBMITTED side — what is about to be assessed: every
// line has exactly the stored-line keys, a real tax code and a cost code, a
// whole-cent amount inside the supported range, a GST that its own calculation
// version produces, and NO certified value; and the header is the sum of the
// lines. Null when it reconciles, else a short reason.
export function submittedSideProblem(variation) {
  const version = variationCalcVersion(variation)
  if (version === null) return 'version'
  const lines = variation?.lineItems
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > VARIATION_LIMITS.lines) return 'lines'
  for (const li of lines) {
    const shape = lineShapeProblem(li)
    if (shape) return shape
    if (!isSupportedAmount(li.submittedAmount)) return 'line-amount'
    if (!lineGstReconciles(li.submittedAmount, li.taxCode, li.submittedGst, version)) return 'line-gst'
    if (li.approvedAmount != null || li.approvedGst != null) return 'line-approved'
  }
  const totals = variationTotals(lines, 'submitted', version)
  if (typeof variation.submittedSubtotal !== 'number' || typeof variation.submittedGst !== 'number' || typeof variation.submittedTotal !== 'number'
    || toCents(variation.submittedSubtotal) !== toCents(totals.subtotal)
    || toCents(variation.submittedGst) !== toCents(totals.gst)
    || toCents(variation.submittedTotal) !== toCents(totals.total)) return 'header'
  return null
}

// An APPROVED variation's certified side — what is about to be applied to a
// purchase order's commitment: every line's approved amount is whole cents in
// range, its approved GST is EXACTLY what the document's calculation version
// derives from that amount and tax code, and the approved header is the sum of
// the lines. Null when it reconciles. (The document is never changed by this —
// an approved variation that does not reconcile is simply not applied.)
export function approvedSideProblem(variation) {
  const version = variationCalcVersion(variation)
  if (version === null) return 'version'
  const lines = variation?.lineItems
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > VARIATION_LIMITS.lines) return 'lines'
  for (const li of lines) {
    const shape = lineShapeProblem(li)
    if (shape) return shape
    if (!isSupportedAmount(li.approvedAmount)) return 'line-amount'
    if (!lineGstReconciles(li.approvedAmount, li.taxCode, li.approvedGst, version, { exact: true })) return 'line-gst'
  }
  const totals = variationTotals(lines, 'approved', version)
  if (typeof variation.approvedSubtotal !== 'number' || typeof variation.approvedGst !== 'number' || typeof variation.approvedTotal !== 'number'
    || toCents(variation.approvedSubtotal) !== toCents(totals.subtotal)
    || toCents(variation.approvedGst) !== toCents(totals.gst)
    || toCents(variation.approvedTotal) !== toCents(totals.total)) return 'header'
  return null
}

// The cost-code ids a stored variation's NEW-SCOPE lines name (the documents
// the transaction must read to verify them).
export const storedCostCodeIds = (variation) =>
  [...new Set((variation?.lineItems ?? []).filter(li => li && li.poLineIndex == null && typeof li.costCodeId === 'string' && li.costCodeId.length > 0).map(li => li.costCodeId))]

// Every line's COMMERCIAL RELATIONSHIP, against records the transaction read:
//   · a line that names a purchase-order line is allowed only on a PO-linked
//     supplier variation, the line must exist on THAT order, and the line's
//     cost code must be the order line's own;
//   · a new-scope line's cost code must exist in the company library.
// `po` is the variation's purchase order { id, …data } or null; `costCodes` a
// Map(costCodeId → cost code document). Returns
//   { ok: true, names }   — `names[i]` is the authoritative cost-code name of
//                           line i (the order line's, or "CODE — NAME")
//   { ok: false, line, reason }
export function lineSources(variation, { po = null, costCodes = new Map() } = {}) {
  const linked = isPoLinkedSupplierVariation(variation)
  const names = []
  const lines = variation?.lineItems ?? []
  for (let index = 0; index < lines.length; index += 1) {
    const li = lines[index]
    if (li?.poLineIndex != null) {
      if (!linked || !po || po.id !== variation.poId) return { ok: false, line: index, reason: 'po-line-without-order' }
      const poLine = (po.lineItems ?? [])[li.poLineIndex]
      if (!poLine || typeof poLine.costCodeId !== 'string' || poLine.costCodeId.length === 0) return { ok: false, line: index, reason: 'po-line-missing' }
      if (poLine.costCodeId !== li.costCodeId) return { ok: false, line: index, reason: 'po-line-cost-code' }
      names.push(typeof poLine.costCodeName === 'string' ? poLine.costCodeName : '')
    } else {
      const cc = costCodes.get(li?.costCodeId)
      if (!cc) return { ok: false, line: index, reason: 'cost-code-missing' }
      names.push(`${cc.code} — ${cc.name}`)
    }
  }
  return { ok: true, names }
}

// The certified lines with each cost-code NAME taken from the authoritative
// source at certification (lineSources(...).names). The id — the join key —
// was verified; the name is a display snapshot, and approval is the write at
// which it is taken.
export const withAuthoritativeNames = (lineItems, names) =>
  (lineItems ?? []).map((li, i) => ({ ...li, costCodeName: names[i] }))

// True when `variation` — already approved — carries exactly the certified
// amounts of this request: the answer to a repeated approve.
export function sameApproval(variation, approvedAmounts) {
  const version = variationCalcVersion(variation)
  const lines = variation?.lineItems
  if (version === null || !Array.isArray(lines) || !Array.isArray(approvedAmounts) || lines.length !== approvedAmounts.length) return false
  return lines.every((li, i) => {
    const wanted = roundAmount(approvedAmounts[i], version)
    return wanted !== null && typeof li?.approvedAmount === 'number' && toCents(li.approvedAmount) === toCents(wanted)
  })
}

// The approved header a transition wrote must be inside the supported range.
export const approvedHeaderSupported = (update) =>
  isSupportedAmount(update?.approvedSubtotal) && isSupportedAmount(update?.approvedGst) && isSupportedAmount(update?.approvedTotal)

// Who the approver is in relation to the document — EVIDENCE for the audit
// event (Phase 2 approval segregation reads it; nothing is refused on it here).
export function approvalActorEvidence(variation, uid) {
  return {
    approverIsCreator:    variation?.createdBy === uid,
    approverIsSubmitter:  variation?.submittedBy === uid,
    approverIsLastEditor: variation?.updatedBy === uid,
  }
}

export { CALC_VERSION, isPoLinkedSupplierVariation }
