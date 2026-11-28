import { useEffect, useState, useCallback } from 'react'
import { collection, doc, onSnapshot, query, orderBy } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { runClientApplicationPost, runClientApplicationVoid, CLIENT_FINANCE_CALL_TIMEOUT_MS } from '../lib/clientLedgerActions'

// ── Client Receipt Applications (Phase 2 step 5, ADR-95) ──────────────────
//
// A posted receipt's UNALLOCATED money allocated, later, to an issued invoice of
// the same client, currency and project. Moves no cash. Financial-role reads
// (Rules). The browser writes NOTHING: `postClientReceiptApplication` /
// `voidClientReceiptApplication` (a correction of an erroneous record) check
// the money and move the receipt's and the invoice's ledgers.

const callClientFinance = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: CLIENT_FINANCE_CALL_TIMEOUT_MS })(data)).data
const isSignedIn = () => auth.currentUser != null

export function useClientReceiptApplications(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const [snap, setSnap] = useState({ key: null, applications: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined
    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'clientReceiptApplications')
    return onSnapshot(
      query(ref, orderBy('createdAt', 'desc')),
      (querySnap) => setSnap({ key, applications: querySnap.docs.map(d => ({ id: d.id, ...d.data() })), error: false }),
      () => setSnap({ key, applications: [], error: true }),
    )
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const clientReceiptApplications = settled ? snap.applications : []
  const clientReceiptApplicationsLoading = targetKey !== null && !settled
  const clientReceiptApplicationsError = settled ? snap.error : false

  const newApplicationId = useCallback(() => {
    if (!companyId || !projectId) return null
    return doc(collection(db, 'companies', companyId, 'projects', projectId, 'clientReceiptApplications')).id
  }, [companyId, projectId])

  const postClientReceiptApplication = useCallback(async (applicationId, input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runClientApplicationPost({ call: callClientFinance, projectId, applicationId, input, isSignedIn })
  }, [companyId, projectId, user])

  const voidClientReceiptApplication = useCallback(async (application, reason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runClientApplicationVoid({ call: callClientFinance, projectId, applicationId: application.id, reason, isSignedIn })
  }, [companyId, projectId, user])

  return {
    clientReceiptApplications, clientReceiptApplicationsLoading, clientReceiptApplicationsError,
    newApplicationId, postClientReceiptApplication, voidClientReceiptApplication,
  }
}
