import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useCompany } from './useCompany'

// ── ONE budget approval SNAPSHOT — Constrapp SHIELD™ 2B1 (ADR-70) ────────────
//
// The immutable payload of the ONE selected approval
// (`budgetApprovalSnapshots/{approvalId}`): a single-document subscription
// keyed by the selection, so a page reads the active version (and, when a
// consumer needs the original, version 1) and no historical payload is ever
// streamed for a version nobody is looking at. With no selection the hook is
// idle.
//
// READ-ONLY. The snapshot is create-only in the rules; nothing in the app
// ever updates it. A failed read is UNAVAILABLE, never "no approved budget".
export function useBudgetApprovalSnapshot(projectId, approvalId) {
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, snapshot: null, error: false })

  useEffect(() => {
    if (!companyId || !projectId || !approvalId) return undefined

    const key = `${companyId}/${projectId}/${approvalId}`
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'budgetApprovalSnapshots', approvalId)
    const unsubscribe = onSnapshot(
      ref,
      (d) => setSnap({ key, snapshot: d.exists() ? { id: d.id, ...d.data() } : null, error: false }),
      () => setSnap({ key, snapshot: null, error: true }),
    )
    return unsubscribe
  }, [companyId, projectId, approvalId])

  const targetKey = companyId && projectId && approvalId ? `${companyId}/${projectId}/${approvalId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const snapshot = settled ? snap.snapshot : null
  const snapshotLoading = targetKey !== null && !settled
  const snapshotError = settled ? snap.error : false

  return { snapshot, snapshotLoading, snapshotError }
}
