import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useCompany } from './useCompany'

// ── ONE budget approval HEADER — Constrapp SHIELD™ 2B1 (ADR-70) ──────────────
//
// The header of the ONE selected approval (`budgetApprovals/{approvalId}`):
// a single-document subscription keyed by the selection — the active
// version's header for the financial consumers (its status, version and
// total are cross-checked against the pointer and the snapshot at read time).
// With no selection the hook is idle. READ-ONLY; a failed read is
// UNAVAILABLE, never "no approval".
export function useBudgetApprovalHeader(projectId, approvalId) {
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, header: null, error: false })

  useEffect(() => {
    if (!companyId || !projectId || !approvalId) return undefined

    const key = `${companyId}/${projectId}/${approvalId}`
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'budgetApprovals', approvalId)
    const unsubscribe = onSnapshot(
      ref,
      (d) => setSnap({ key, header: d.exists() ? { id: d.id, ...d.data() } : null, error: false }),
      () => setSnap({ key, header: null, error: true }),
    )
    return unsubscribe
  }, [companyId, projectId, approvalId])

  const targetKey = companyId && projectId && approvalId ? `${companyId}/${projectId}/${approvalId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const header = settled ? snap.header : null
  const headerLoading = targetKey !== null && !settled
  const headerError = settled ? snap.error : false

  return { header, headerLoading, headerError }
}
