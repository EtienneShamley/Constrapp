import { useEffect, useState, useCallback } from 'react'
import { collection, doc, onSnapshot, query, orderBy } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { runClientRefundPost, runClientRefundVoid, CLIENT_FINANCE_CALL_TIMEOUT_MS } from '../lib/clientLedgerActions'

// ── Client Refunds (Phase 2 step 5, ADR-95) ───────────────────────────────
//
// Money ACTUALLY returned to the client, outside the app — never a negative
// receipt. Financial-role reads (Rules). The browser writes NOTHING: recording
// a refund and correcting (voiding) its record are the trusted callables
// `postClientRefund` / `voidClientRefund`, which check the money is available
// and move the receipt's or the invoice's ledger.

const callClientFinance = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: CLIENT_FINANCE_CALL_TIMEOUT_MS })(data)).data
const isSignedIn = () => auth.currentUser != null

export function useClientRefunds(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const [snap, setSnap] = useState({ key: null, refunds: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined
    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'clientRefunds')
    return onSnapshot(
      query(ref, orderBy('createdAt', 'desc')),
      (querySnap) => setSnap({ key, refunds: querySnap.docs.map(d => ({ id: d.id, ...d.data() })), error: false }),
      () => setSnap({ key, refunds: [], error: true }),
    )
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const clientRefunds = settled ? snap.refunds : []
  const clientRefundsLoading = targetKey !== null && !settled
  const clientRefundsError = settled ? snap.error : false

  // A fresh id per refund form, so a retry after a lost response is the same request.
  const newRefundId = useCallback(() => {
    if (!companyId || !projectId) return null
    return doc(collection(db, 'companies', companyId, 'projects', projectId, 'clientRefunds')).id
  }, [companyId, projectId])

  const postClientRefund = useCallback(async (refundId, input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runClientRefundPost({ call: callClientFinance, projectId, refundId, input, isSignedIn })
  }, [companyId, projectId, user])

  const voidClientRefund = useCallback(async (refund, reason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runClientRefundVoid({ call: callClientFinance, projectId, refundId: refund.id, reason, isSignedIn })
  }, [companyId, projectId, user])

  return { clientRefunds, clientRefundsLoading, clientRefundsError, newRefundId, postClientRefund, voidClientRefund }
}
