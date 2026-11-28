import { CODE, fail } from '../lib/errors.js'
import { assertCommercialActivated } from '../lib/commercialActivation.js'
import { requireAuth, loadProfile, assertActiveRole } from '../lib/authz.js'
import { VARIATION_ROLES, parseCreateVariation, parseUpdateVariationDraft, parseApproveVariation, parseApplyVariationCommitment } from './contracts.js'
import { createVariation, updateVariationDraft, approveVariation, applyVariationCommitment } from './operations.js'

// ── The variation callables, as plain async functions of `(request)` ─────────
//
// `deps` — { db, now, log, config, hooks? } — is injected, the Final Account
// handler pattern: the emulator suite calls a handler directly; src/index.js
// wires each into `onCall`. Order: enabled-gate → authenticate → validate →
// authorise → operate. Nothing reads project data before the caller is
// established, and nothing is written while the switch is off.

const OPERATIONS = {
  createVariation:          { parse: parseCreateVariation,          run: createVariation },
  updateVariationDraft:     { parse: parseUpdateVariationDraft,     run: updateVariationDraft },
  approveVariation:         { parse: parseApproveVariation,         run: approveVariation },
  applyVariationCommitment: { parse: parseApplyVariationCommitment, run: applyVariationCommitment },
}

export const VARIATION_HANDLER_NAMES = Object.keys(OPERATIONS)

const requestId = (request) =>
  request?.rawRequest?.headers?.['x-cloud-trace-context']?.split('/')[0]
  ?? request?.rawRequest?.headers?.['function-execution-id']
  ?? null

export function createVariationHandlers(deps) {
  const handler = ({ parse, run }) => async (request) => {
    // Fail closed: anything but an explicit `true` is off.
    if (deps.config().enabled !== true) fail(CODE.VARIATION_DISABLED)
    const { uid } = requireAuth(request)
    const input = parse(request.data)
    // Fail fast for a caller who may not act; the transaction re-checks the
    // membership it reads itself.
    const profile = assertActiveRole(await loadProfile(deps.db, uid), VARIATION_ROLES, CODE.VARIATION_FORBIDDEN)
    // Phase 2 company activation — fail fast; the transaction re-checks it.
    await assertCommercialActivated(deps.db, profile.companyId)
    return run(deps, { uid, input, requestId: requestId(request) })
  }
  return Object.fromEntries(Object.entries(OPERATIONS).map(([name, operation]) => [name, handler(operation)]))
}
