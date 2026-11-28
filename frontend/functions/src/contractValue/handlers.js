import { CODE, fail } from '../lib/errors.js'
import { assertCommercialActivated } from '../lib/commercialActivation.js'
import { requireAuth, loadProfile, assertActiveRole } from '../lib/authz.js'
import { parseContractValueOperation, CONTRACT_VALUE_OPERATIONS, CONTRACT_VALUE_ROLES } from './operations.js'

// ADR-96 — `contractValueOperation` { operation: propose | approve | withdraw, request }.
// Order: switch → authenticate → validate → authorise → operate.
export function createContractValueHandlers(deps) {
  return {
    contractValueOperation: async (request) => {
      if (deps.config().enabled !== true) fail(CODE.CONTRACT_VALUE_INVALID, { message: 'Correcting the original contract value is not available yet. Nothing was changed.' })
      const { uid } = requireAuth(request)
      const { operation, input } = parseContractValueOperation(request.data)
      const profile = assertActiveRole(await loadProfile(deps.db, uid), CONTRACT_VALUE_ROLES, CODE.NO_MEMBERSHIP)
      // Phase 2 company activation — fail fast; the transaction re-checks it.
      await assertCommercialActivated(deps.db, profile.companyId)
      const out = await CONTRACT_VALUE_OPERATIONS[operation](deps, { uid, input })
      return { operation, revisionId: input.revisionId, ...out }
    },
  }
}
