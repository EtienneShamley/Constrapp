import { CODE, fail } from '../lib/errors.js'
import { requireAuth, loadProfile, assertActiveRole } from '../lib/authz.js'
import { assertCommercialActivated } from '../lib/commercialActivation.js'
import * as calc from '../generated/estimatingCalc.js'
import { parseEstimateOperation } from './contracts.js'
import { buildEstimate, approveEstimate, discardEstimate, setEstimateComponents } from './operations.js'

// ── `estimateOperation` (ADR-97), as a plain async function of `(request)` ───
//
// `deps` — { db, now, log, config, hooks?, sourceLimit? } — is injected (the Final Account /
// variation handler pattern): the emulator suite calls the handler directly;
// src/index.js wires it into `onCall`. Order: enabled-gate → authenticate →
// validate (the operation's OWN contract) → authorise (the operation's OWN
// role set) → company activation (Phase 2) → operate. Each operation re-reads the caller's membership inside
// its own transactions; nothing here grants authority to another operation.

const OPERATIONS = {
  build:         { run: buildEstimate,         roles: calc.ESTIMATE_ROLES },
  approve:       { run: approveEstimate,       roles: calc.ESTIMATE_APPROVER_ROLES },
  discard:       { run: discardEstimate,       roles: calc.ESTIMATE_ROLES },
  setComponents: { run: setEstimateComponents, roles: calc.ESTIMATE_ROLES },
}

export const ESTIMATE_HANDLER_NAMES = ['estimateOperation']

const requestId = (request) =>
  request?.rawRequest?.headers?.['x-cloud-trace-context']?.split('/')[0]
  ?? request?.rawRequest?.headers?.['function-execution-id']
  ?? null

export function createEstimateHandlers(deps) {
  return {
    async estimateOperation(request) {
      if (deps.config().enabled !== true) fail(CODE.ESTIMATE_DISABLED)
      const { uid } = requireAuth(request)
      const { operation, input } = parseEstimateOperation(request.data)
      const op = OPERATIONS[operation]
      const profile = assertActiveRole(await loadProfile(deps.db, uid), op.roles, CODE.ESTIMATE_FORBIDDEN)
      // Phase 2 company activation — fail fast; every transaction re-checks it.
      await assertCommercialActivated(deps.db, profile.companyId)
      const out = await op.run(deps, { uid, input, requestId: requestId(request) })
      return { operation, ...out }
    },
  }
}
