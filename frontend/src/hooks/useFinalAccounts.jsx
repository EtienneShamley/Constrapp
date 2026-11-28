import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy, where,
  serverTimestamp, runTransaction, getDocsFromServer, getDocFromServer,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { useProfile } from './useProfile'
import {
  runFinalAccountPrepare, runFinalAccountWithdraw, runFinalAccountApprove, APPROVE_CALL_TIMEOUT_MS,
} from '../lib/finalAccountActions'

// ── Final Account revisions — L2-B (ADR-77) ──────────────────────────────────
//
// One listener over `finalAccounts` (a handful of revisions per project), plus
// the prepare / withdraw transactions and the approve CALL.
//
// ⚠️ THIS HOOK WRITES ONLY `finalAccounts`, and only two things: a new DRAFT
// revision and a draft's WITHDRAWAL. It never writes a budget line, purchase
// order, claim, invoice, variation, receipt, payment or baseline, and it
// cannot approve: approval is the trusted callable `approveFinalAccount`,
// which recomputes every figure from records it reads itself. A Final Account
// feeds NO other figure anywhere in the app.
//
// PREPARE reads every register from the SERVER (getDocsFromServer /
// getDocFromServer, never the cache) through the same queries the listeners
// use, so the draft is built from what the server holds, not from this tab.
//
// The keyed-snapshot / derived-loading pattern (ADR-41) as in every other
// subscription hook.
export function useFinalAccounts(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { profile } = useProfile()

  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, accounts: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'finalAccounts')
    const q = query(ref, orderBy('createdAt', 'asc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        accounts: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error — most often a rules rejection. Unavailable, never an
      // empty history.
      () => setSnap({ key, accounts: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const finalAccounts = settled ? snap.accounts : []
  const finalAccountsLoading = targetKey !== null && !settled
  const finalAccountsError = settled ? snap.error : false

  const accountRef = useCallback(
    (number) => doc(db, 'companies', companyId, 'projects', projectId, 'finalAccounts', String(number)),
    [companyId, projectId],
  )

  // The registers and documents PREPARE reads from the server.
  const serverReads = useCallback(() => {
    const sub = (name) => collection(db, 'companies', companyId, 'projects', projectId, name)
    const ordered = (name) => query(sub(name), orderBy('createdAt', 'desc'))
    return {
      accountsQuery: query(sub('finalAccounts'), orderBy('createdAt', 'asc')),
      queries: {
        budgetLines: ordered('budgetLines'),
        purchaseOrders: ordered('purchaseOrders'),
        progressClaims: ordered('progressClaims'),
        supplierInvoices: ordered('supplierInvoices'),
        supplierCreditNotes: ordered('supplierCreditNotes'),
        variations: ordered('variations'),
        forecastLines: sub('forecastLines'),
        supplierPayments: ordered('supplierPayments'),
        retentionReleases: ordered('retentionReleases'),
        clientInvoices: ordered('clientInvoices'),
        clientReceipts: ordered('clientReceipts'),
        clientCreditNotes: ordered('clientCreditNotes'),
        clientRetentionReleases: ordered('clientRetentionReleases'),
        clientRefunds: ordered('clientRefunds'),
        clientReceiptApplications: ordered('clientReceiptApplications'),
        costCodes: query(collection(db, 'companies', companyId, 'costCodes'), orderBy('code', 'asc')),
      },
      refs: {
        baseline: doc(sub('commercial'), 'baseline'),
        pointer: doc(sub('approvedBudget'), 'current'),
        header: (id) => doc(sub('budgetApprovals'), id),
        snapshot: (id) => doc(sub('budgetApprovalSnapshots'), id),
        adjustments: (id) => query(sub('budgetAdjustments'), where('baseApprovalId', '==', id)),
      },
    }
  }, [companyId, projectId])

  const prepareFinalAccount = useCallback(async ({ project, currencyCode, input }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runFinalAccountPrepare({
      db,
      accountRef,
      ...serverReads(),
      getDocsFromServer,
      getDocFromServer,
      project,
      currencyCode,
      input,
      uid: user.uid,
      preparedByName: profile?.name ?? '',
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, profile, accountRef, serverReads])

  const withdrawFinalAccount = useCallback(async (account, reason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runFinalAccountWithdraw({
      db,
      accountRef: accountRef(account.number),
      seen: account,
      reason,
      uid: user.uid,
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, accountRef])

  // APPROVE — the trusted callable. Identifiers and the seen revision only.
  const approveFinalAccount = useCallback(async (account, acknowledged) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runFinalAccountApprove({
      call: async (data) => (await httpsCallable(functions, 'approveFinalAccount', { timeout: APPROVE_CALL_TIMEOUT_MS })(data)).data,
      projectId,
      seen: account,
      acknowledged,
    })
  }, [companyId, projectId, user])

  return {
    finalAccounts,
    finalAccountsLoading,
    finalAccountsError,
    prepareFinalAccount,
    withdrawFinalAccount,
    approveFinalAccount,
  }
}
