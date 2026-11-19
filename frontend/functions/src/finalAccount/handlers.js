import { CODE, fail } from '../lib/errors.js'
import { requireAuth, loadProfile, assertActiveRole } from '../lib/authz.js'
import { isValidId } from '../lib/validation.js'
import { approveFinalAccount } from './approve.js'
import { FINAL_ACCOUNT_APPROVE_ROLES } from '../generated/finalAccountCalc.js'

// ── The Final Account callable, as a plain async function of `(request)` ─────
//
// `deps` — { db, now, log, config, hooks?, sourceLimit? } — is injected, the team-handler
// pattern: the emulator suite calls the handler directly; src/index.js wires
// it into `onCall`. Order: enabled-gate → authenticate → validate → authorise
// → operate. Nothing reads project data before the caller is established.

export const FINAL_ACCOUNT_HANDLER_NAMES = ['approveFinalAccount']

const KEYS = ['projectId', 'number', 'expectedRevision', 'acknowledged']

// Identifiers and guards ONLY. Any other key — an amount above all — is refused.
export function parseApproveFinalAccount(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail(CODE.INVALID_ARGUMENT)
  if (Object.keys(data).some(k => !KEYS.includes(k)) || KEYS.some(k => !(k in data))) fail(CODE.INVALID_ARGUMENT)
  const { projectId, number, expectedRevision, acknowledged } = data
  if (!isValidId(projectId)) fail(CODE.INVALID_ARGUMENT)
  if (!Number.isInteger(number) || number < 1 || number > 9999) fail(CODE.INVALID_ARGUMENT)
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) fail(CODE.INVALID_ARGUMENT)
  if (acknowledged !== true) fail(CODE.INVALID_ARGUMENT)
  return { projectId, number, expectedRevision }
}

const requestId = (request) =>
  request?.rawRequest?.headers?.['x-cloud-trace-context']?.split('/')[0]
  ?? request?.rawRequest?.headers?.['function-execution-id']
  ?? null

export function createFinalAccountHandlers(deps) {
  return {
    async approveFinalAccount(request) {
      if (deps.config().enabled === false) fail(CODE.FINAL_ACCOUNT_DISABLED)
      const { uid } = requireAuth(request)
      const input = parseApproveFinalAccount(request.data)
      // Fail fast for a caller who may not approve; the transaction re-checks
      // the membership it reads itself.
      assertActiveRole(await loadProfile(deps.db, uid), FINAL_ACCOUNT_APPROVE_ROLES, CODE.NOT_APPROVER)
      return approveFinalAccount(deps, { uid, ...input, requestId: requestId(request) })
    },
  }
}
