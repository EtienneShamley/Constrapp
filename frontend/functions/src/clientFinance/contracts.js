import { CODE, fail } from '../lib/errors.js'
import { INTERNAL_ROLES, isValidId } from '../lib/validation.js'

// ── Client-finance callables — the input contracts (ADR-89) — PURE ───────────
//
// IDENTIFIERS, ONE FLAG AND A REASON ONLY. A request names a project and one
// entry; a void adds why; posting a receipt adds whether the user has
// acknowledged over-allocating an invoice. Any other key — an amount above all, or a companyId — is
// refused, so no figure a browser sends can become authoritative: every figure
// is re-derived from records the transaction reads itself.

// The roles Firestore Rules let draft a credit note or a retention release
// (`financialMember`). There is no approval segregation in this phase: whoever
// may draft may post and void.
export const CLIENT_FINANCE_ROLES = INTERNAL_ROLES

// A void reason is stored on the entry and in the audit event.
export const VOID_REASON_MAX = 500

function parse(data, idKey, withReason) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail(CODE.INVALID_ARGUMENT)
  const keys = withReason ? ['projectId', idKey, 'reason'] : ['projectId', idKey]
  if (Object.keys(data).some(k => !keys.includes(k)) || keys.some(k => !(k in data))) fail(CODE.INVALID_ARGUMENT)
  if (!isValidId(data.projectId) || !isValidId(data[idKey])) fail(CODE.INVALID_ARGUMENT)
  const input = { projectId: data.projectId, entryId: data[idKey] }
  if (!withReason) return input
  const reason = typeof data.reason === 'string' ? data.reason.trim() : ''
  if (reason.length === 0 || reason.length > VOID_REASON_MAX) fail(CODE.INVALID_ARGUMENT)
  return { ...input, reason }
}

// Each parser returns `{ projectId, entryId }` (+ `reason`, trimmed) or throws
// invalid-argument.
export const parsePostClientCreditNote = (data) => parse(data, 'creditNoteId', false)
export const parseVoidClientCreditNote = (data) => parse(data, 'creditNoteId', true)
export const parsePostClientRetentionRelease = (data) => parse(data, 'releaseId', false)
export const parseVoidClientRetentionRelease = (data) => parse(data, 'releaseId', true)
export const parseVoidClientReceipt = (data) => parse(data, 'receiptId', true)

// `{ projectId, receiptId, acknowledgeOverAllocation }` — the flag is REQUIRED
// and a boolean: the server decides whether an acknowledgement was needed, the
// request only says whether one was given.
export function parsePostClientReceipt(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail(CODE.INVALID_ARGUMENT)
  if (typeof data.acknowledgeOverAllocation !== 'boolean') fail(CODE.INVALID_ARGUMENT)
  const { acknowledgeOverAllocation, ...rest } = data
  return { ...parse(rest, 'receiptId', false), acknowledgeOverAllocation }
}
