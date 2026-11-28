import { useCallback } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { runBoqBudgetTransfer, TRANSFER_CALL_TIMEOUT_MS } from '../lib/boqBudgetTransferActions'

// ── BOQ → working budget transfer — L4 (ADR-81) ──────────────────────────────
//
// Not a subscription hook and not a Firestore writer: the ONE thing here is
// the call to the trusted `transferBoqToBudget` callable (the useTeam /
// useFinalAccounts → approveFinalAccount pattern). The page already holds the
// live BOQ, budget-line and cost-code registers through their own hooks; the
// review dialog builds the proposal from them with lib/boqBudgetTransfer.js.
//
// ⚠️ THE BROWSER SENDS NO AMOUNT. The request is the project id, the key of the
// proposal the user reviewed and their explicit set-to-zero choices. The
// server recomputes everything from its own transactional reads, and writes
// WORKING budget lines only — never an approved budget version.
export function useBoqBudgetTransfer(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null

  // ADR-97: the optional second argument names the APPROVED estimate revision
  // this transfer is recorded against (the Estimate page only); the BOQ page
  // never passes it, so its request is exactly the ADR-81 request.
  const transferBoqToBudget = useCallback(async ({ reviewKey, setToZero }, estimateId = null) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runBoqBudgetTransfer({
      call: async (data) => (await httpsCallable(functions, 'transferBoqToBudget', { timeout: TRANSFER_CALL_TIMEOUT_MS })(data)).data,
      projectId,
      reviewKey,
      setToZero,
      estimateId,
    })
  }, [companyId, projectId, user])

  return { transferBoqToBudget }
}
