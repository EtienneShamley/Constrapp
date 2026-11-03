import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useCompany } from './useCompany'

// ── The approved-budget POINTER — Constrapp SHIELD™ 2B1 (ADR-70) ─────────────
//
// `approvedBudget/current`: ONE deterministic document per project naming the
// ACTIVE approved budget version (activeApprovalId, versionCount) and the
// ORIGINAL one (originalApprovalId). A single-document subscription, idle
// (settled, null) for a project that has never approved a budget — the
// LEGACY state, which every consumer labels "Working budget (not approved)".
//
// READ-ONLY here: the pointer is created and advanced only inside the approve
// transaction (lib/budgetApprovalActions.js), paired with the header by the
// rules. A failed read is UNAVAILABLE, never "no approved budget".
export function useApprovedBudgetPointer(projectId) {
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, pointer: null, error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'approvedBudget', 'current')
    const unsubscribe = onSnapshot(
      ref,
      (d) => setSnap({ key, pointer: d.exists() ? { id: d.id, ...d.data() } : null, error: false }),
      () => setSnap({ key, pointer: null, error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const pointer = settled ? snap.pointer : null
  const pointerLoading = targetKey !== null && !settled
  const pointerError = settled ? snap.error : false

  return { pointer, pointerLoading, pointerError }
}
