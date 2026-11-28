import { CODE, fail } from '../lib/errors.js'
import { requireAuth, loadProfile, assertActiveRole } from '../lib/authz.js'
import { isValidId } from '../lib/validation.js'
import { transferBoqToBudget } from './transfer.js'
import {
  BOQ_TRANSFER_ROLES, BOQ_TRANSFER_REQUEST_KEYS, BOQ_TRANSFER_OPTIONAL_REQUEST_KEYS, BOQ_TRANSFER_MAX_ZERO_CHOICES, isReviewKeyShape, normaliseZeroChoices,
} from '../generated/boqBudgetTransferCalc.js'

// ── The BOQ transfer callable, as a plain async function of `(request)` ──────
//
// `deps` — { db, now, log, config, hooks?, sourceLimit? } — is injected, the
// Final Account handler pattern: the emulator suite calls the handler
// directly; src/index.js wires it into `onCall`. Order: enabled-gate →
// authenticate → validate → authorise → operate. Nothing reads project data
// before the caller is established.

export const BOQ_BUDGET_HANDLER_NAMES = ['transferBoqToBudget']

// Identifiers and guards ONLY. Any other key — an amount above all — is refused.
export function parseTransferBoqToBudget(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail(CODE.INVALID_ARGUMENT)
  const KEYS = BOQ_TRANSFER_REQUEST_KEYS
  // ADR-97: `estimateId` is the one OPTIONAL key (an identifier, never an amount).
  if (Object.keys(data).some(k => !KEYS.includes(k) && !BOQ_TRANSFER_OPTIONAL_REQUEST_KEYS.includes(k)) || KEYS.some(k => !(k in data))) fail(CODE.INVALID_ARGUMENT)
  const { projectId, reviewKey, setToZero } = data
  const estimateId = 'estimateId' in data ? data.estimateId : null
  if ('estimateId' in data && !isValidId(estimateId)) fail(CODE.INVALID_ARGUMENT)
  if (!isValidId(projectId)) fail(CODE.INVALID_ARGUMENT)
  if (!isReviewKeyShape(reviewKey)) fail(CODE.INVALID_ARGUMENT)
  if (!Array.isArray(setToZero) || setToZero.length > BOQ_TRANSFER_MAX_ZERO_CHOICES) fail(CODE.INVALID_ARGUMENT)
  if (setToZero.some(id => !isValidId(id))) fail(CODE.INVALID_ARGUMENT)
  const zero = normaliseZeroChoices(setToZero)
  if (zero.length !== setToZero.length) fail(CODE.INVALID_ARGUMENT)   // no duplicates
  return { projectId, reviewKey, setToZero: zero, estimateId }
}

const requestId = (request) =>
  request?.rawRequest?.headers?.['x-cloud-trace-context']?.split('/')[0]
  ?? request?.rawRequest?.headers?.['function-execution-id']
  ?? null

export function createBoqBudgetHandlers(deps) {
  return {
    async transferBoqToBudget(request) {
      if (deps.config().enabled === false) fail(CODE.BOQ_TRANSFER_DISABLED)
      const { uid } = requireAuth(request)
      const input = parseTransferBoqToBudget(request.data)
      // Fail fast for a caller who may not transfer; the transaction re-checks
      // the membership it reads itself.
      assertActiveRole(await loadProfile(deps.db, uid), BOQ_TRANSFER_ROLES, CODE.BOQ_TRANSFER_FORBIDDEN)
      return transferBoqToBudget(deps, { uid, ...input, requestId: requestId(request) })
    },
  }
}
