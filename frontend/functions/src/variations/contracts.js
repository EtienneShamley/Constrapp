import { CODE, fail } from '../lib/errors.js'
import { isValidId } from '../lib/validation.js'
import * as calc from '../generated/variationCalc.js'

// ── Variation callables — the input contracts (ADR-90) — PURE ────────────────
//
// AUTHORED CONTENT AND IDENTIFIERS ONLY. A variation is a document a person
// writes, so a create request carries what they wrote: the title, the dates,
// and each line's ex-GST amount, tax code and cost code (or the purchase-order
// line it changes). An approve request carries the certified amount per line.
// NOTHING DERIVED is accepted — no GST, no subtotal or total, no document
// number, no currency, no status, no stamp, no calculation version, no
// snapshot of a purchase order, cost code or RFI, and no companyId: an
// unexpected key refuses the whole request. Every one of those is produced by
// the generated domain module from records the transaction reads itself.

// The roles Firestore Rules let read and draft a variation (`variationMember`).
// There is no preparer / approver segregation in this step (Phase 2, step 6).
export const VARIATION_ROLES = calc.VARIATION_PROCESSING_ROLES

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (data, keys) => isObject(data) && Object.keys(data).length === keys.length && keys.every(k => k in data)
const isRevision = (v) => Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

// The shape, bounds and exact key sets are the domain module's own
// (lib/variationProcessing.js → createVariationRequestProblem), so the browser
// refuses the same request before it is sent. Returns a plain copy.
export function parseCreateVariation(data) {
  const problem = calc.createVariationRequestProblem(data)
  if (problem) fail(CODE.INVALID_ARGUMENT, { field: problem })
  return { ...data, lines: data.lines.map(line => ({ ...line })) }
}

// A draft edit: the same authored content as a create, the revision the user
// edited, and an explicit statement of whether the originating-RFI link is
// being changed. Shape, bounds and exact key sets are the domain module's own.
export function parseUpdateVariationDraft(data) {
  const problem = calc.updateVariationRequestProblem(data)
  if (problem) fail(CODE.INVALID_ARGUMENT, { field: problem })
  return { ...data, lines: data.lines.map(line => ({ ...line })) }
}

const APPROVE_KEYS = ['projectId', 'variationId', 'expectedRevision', 'approvedAmounts', 'assessmentNotes', 'approvedDate']

// `expectedRevision` is the revision the approver REVIEWED: the approval lands
// on that exact submitted revision or not at all. `approvedDate` is the
// approver's calendar day (a business date, 'YYYY-MM-DD') — the server clock
// supplies every timestamp.
export function parseApproveVariation(data) {
  if (!exactKeys(data, APPROVE_KEYS)) fail(CODE.INVALID_ARGUMENT, { field: 'keys' })
  if (!isValidId(data.projectId) || !isValidId(data.variationId)) fail(CODE.INVALID_ARGUMENT, { field: 'ids' })
  if (!isRevision(data.expectedRevision)) fail(CODE.INVALID_ARGUMENT, { field: 'expectedRevision' })
  const amounts = calc.approvedAmountsProblem(data.approvedAmounts)
  if (amounts) fail(CODE.INVALID_ARGUMENT, { field: `approvedAmounts-${amounts}` })
  if (typeof data.assessmentNotes !== 'string' || data.assessmentNotes.length > calc.ASSESSMENT_NOTES_MAX) fail(CODE.INVALID_ARGUMENT, { field: 'assessmentNotes' })
  if (typeof data.approvedDate !== 'string' || !DATE_RE.test(data.approvedDate)) fail(CODE.INVALID_ARGUMENT, { field: 'approvedDate' })
  return {
    projectId: data.projectId, variationId: data.variationId, expectedRevision: data.expectedRevision,
    approvedAmounts: [...data.approvedAmounts], assessmentNotes: data.assessmentNotes.trim(), approvedDate: data.approvedDate,
  }
}

const APPLY_KEYS = ['projectId', 'variationId', 'expectedRevision']

export function parseApplyVariationCommitment(data) {
  if (!exactKeys(data, APPLY_KEYS)) fail(CODE.INVALID_ARGUMENT, { field: 'keys' })
  if (!isValidId(data.projectId) || !isValidId(data.variationId)) fail(CODE.INVALID_ARGUMENT, { field: 'ids' })
  if (!isRevision(data.expectedRevision)) fail(CODE.INVALID_ARGUMENT, { field: 'expectedRevision' })
  return { projectId: data.projectId, variationId: data.variationId, expectedRevision: data.expectedRevision }
}
