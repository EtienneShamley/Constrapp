import { useEffect, useState, useCallback, useMemo } from 'react'
import { collection, doc, onSnapshot, query, orderBy } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { SF_CALLABLE, SF_CALL_TIMEOUT_MS, runSupplierFinance } from '../lib/supplierFinanceActions'
import { RR_STATUS } from '../lib/retention'

// ADR-94: retention releases are created, edited, posted and voided only by the
// supplier-finance backend, which moves the invoice ledger(s) on posting and
// voiding. Firestore Rules admit no client write to the collection.
const callSupplierFinance = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: SF_CALL_TIMEOUT_MS })(data)).data
const revisionOf = (doc) => (Number.isSafeInteger(doc?.revision) ? doc.revision : 0)
const cents2 = (v) => Math.round((Number(v) || 0) * 100) / 100
const settle = (operation, request) => runSupplierFinance(callSupplierFinance, SF_CALLABLE.SETTLEMENT, operation, request)
export function useRetentionReleases(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()

  const companyId = company?.id ?? null


  // Live subscription state, tagged with the target (`key`) it belongs to — the
  // derived-loading pattern used by useSupplierPayments/useCashFlowLines.
  const [snap, setSnap] = useState({ key: null, releases: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'retentionReleases')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        releases: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully. ⚠️ Consumers MUST treat this as UNAVAILABLE, never
      // as "nothing released": an empty list would silently understate every
      // payable balance that includes released retention.
      () => setSnap({ key, releases: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  // Memoised because the write callbacks below VALIDATE against this list (the
  // cumulative cap and the previouslyReleasedAmount snapshot). A fresh `[]` on
  // every render would change their identity on every render.
  const retentionReleases = useMemo(() => (settled ? snap.releases : []), [settled, snap.releases])
  const retentionReleasesLoading = targetKey !== null && !settled
  const retentionReleasesError = settled ? snap.error : false

  // A release's GST is a share of the invoice's STORED retention GST (ADR-91
  // Decision 4); the backend derives it against the invoice ledger, where
  // releases and the retained part of credits draw on one pool (ADR-94).
  const releaseRequest = (releaseId, expectedRevision, supplierInvoiceId, { releaseDate, amount, reason, notes }) => ({
    projectId, releaseId, expectedRevision, supplierInvoiceId, amount: cents2(amount),
    releaseDate: releaseDate || '', reason: String(reason ?? '').trim(), notes: String(notes ?? '').trim(),
  })

  const createRetentionRelease = useCallback(async (data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const id = data.releaseId ?? doc(collection(db, 'companies', companyId, 'projects', projectId, 'retentionReleases')).id
    const out = await settle('saveRelease', releaseRequest(id, null, data.invoice?.id ?? data.supplierInvoiceId, data))
    return out.id
  }, [companyId, projectId, user]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateRetentionRelease = useCallback(async (release, data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (release.status !== RR_STATUS.DRAFT) throw new Error('Only draft retention releases can be edited')
    return settle('saveRelease', releaseRequest(release.id, revisionOf(release), release.supplierInvoiceId, data))
  }, [companyId, projectId, user]) // eslint-disable-line react-hooks/exhaustive-deps

  const postRetentionRelease = useCallback(async (release) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (release.status !== RR_STATUS.DRAFT) throw new Error('Only a draft retention release can be posted')
    return settle('postRelease', { projectId, documentId: release.id, expectedRevision: revisionOf(release) })
  }, [companyId, projectId, user])

  // Voiding corrects a release entered in error. It is REFUSED while payments
  // on the invoice depend on the retention it released (G3).
  const voidRetentionRelease = useCallback(async (release, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (release.status !== RR_STATUS.POSTED) throw new Error('Only a posted retention release can be voided')
    const reason = String(voidReason ?? '').trim()
    if (!reason) throw new Error('Enter a reason for voiding this retention release')
    return settle('voidRelease', { projectId, documentId: release.id, expectedRevision: revisionOf(release), voidReason: reason })
  }, [companyId, projectId, user])

  return {
    retentionReleases,
    retentionReleasesLoading,
    retentionReleasesError,
    createRetentionRelease,
    updateRetentionRelease,
    postRetentionRelease,
    voidRetentionRelease,
  }
}
