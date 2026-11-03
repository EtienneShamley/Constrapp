import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy, where,
  serverTimestamp, runTransaction, getDocFromServer, getDocsFromServer,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import {
  runBudgetAdjustmentPrepare, runBudgetAdjustmentApprove, runBudgetAdjustmentWithdraw,
} from '../lib/budgetAdjustmentActions'

// ── Approved Budget ADJUSTMENTS — Constrapp SHIELD™ 2B2 (ADR-71) ─────────────
//
// `useBudgetAdjustments` — the Budget tab's ONE bounded listener over every
// adjustment of the project (small flat records: the movement, its version,
// sequence, lifecycle and stamps), for the adjustments panel and its
// history, plus the prepare / approve / withdraw transactions.
//
// `useActiveVersionAdjustments` — the adjustments of the ACTIVE version only
// (`where baseApprovalId == activeApprovalId`), for useApprovedBudget. It is
// IDLE unless the pointer's ledger says approved adjustments exist
// (adjustmentCount > 0), so a project with none — every 2B1 project — opens
// NO additional listener anywhere (Dashboard, PULSE, Forecast …).
//
// ⚠️ THIS HOOK WRITES ONLY `budgetAdjustments` AND THE LEDGER FIELDS OF
// `approvedBudget/current`. It never writes a budget line, an approval
// header or snapshot, and never touches Purchase Orders, Progress Claims,
// Supplier Invoices, Variations, Forecast Lines, Cash Flow Lines or the
// Commercial Baseline. An approved adjustment moves the Approved Budget and
// the budget-variance measures only — never Actual, commitment, forecast
// final cost, payables, cash or margin (ADR-71).
//
// The keyed-snapshot / derived-loading pattern (ADR-41) as everywhere else.
// A failed read is UNAVAILABLE, never "no adjustments".

const adjustmentsCollection = (companyId, projectId) =>
  collection(db, 'companies', companyId, 'projects', projectId, 'budgetAdjustments')

export function useActiveVersionAdjustments(projectId, activeApprovalId, enabled) {
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, adjustments: [], error: false })

  const active = enabled && companyId && projectId && activeApprovalId
  useEffect(() => {
    if (!active) return undefined
    const key = `${companyId}/${projectId}/${activeApprovalId}`
    // Equality only — served by the automatic single-field index.
    const q = query(adjustmentsCollection(companyId, projectId), where('baseApprovalId', '==', activeApprovalId))
    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({ key, adjustments: querySnap.docs.map(d => ({ id: d.id, ...d.data() })), error: false }),
      () => setSnap({ key, adjustments: [], error: true }),
    )
    return unsubscribe
  }, [active, companyId, projectId, activeApprovalId])

  const targetKey = active ? `${companyId}/${projectId}/${activeApprovalId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  return {
    adjustments: settled ? snap.adjustments : null,
    adjustmentsLoading: targetKey !== null && !settled,
    adjustmentsError: settled ? snap.error : false,
  }
}

export function useBudgetAdjustments(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, adjustments: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined
    const key = `${companyId}/${projectId}`
    const q = query(adjustmentsCollection(companyId, projectId), orderBy('createdAt', 'asc'))
    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({ key, adjustments: querySnap.docs.map(d => ({ id: d.id, ...d.data() })), error: false }),
      () => setSnap({ key, adjustments: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const budgetAdjustments = settled ? snap.adjustments : []
  const budgetAdjustmentsLoading = targetKey !== null && !settled
  const budgetAdjustmentsError = settled ? snap.error : false

  const adjustmentRef = useCallback(
    (id) => doc(db, 'companies', companyId, 'projects', projectId, 'budgetAdjustments', id),
    [companyId, projectId],
  )
  const pointerRef = useCallback(
    () => doc(db, 'companies', companyId, 'projects', projectId, 'approvedBudget', 'current'),
    [companyId, projectId],
  )
  const approvalHeaderRef = useCallback(
    (id) => doc(db, 'companies', companyId, 'projects', projectId, 'budgetApprovals', id),
    [companyId, projectId],
  )
  const approvalSnapshotRef = useCallback(
    (id) => doc(db, 'companies', companyId, 'projects', projectId, 'budgetApprovalSnapshots', id),
    [companyId, projectId],
  )
  const adjustmentsQuery = useCallback(
    (baseId) => query(adjustmentsCollection(companyId, projectId), where('baseApprovalId', '==', baseId)),
    [companyId, projectId],
  )
  const costCodesQuery = useCallback(
    () => query(collection(db, 'companies', companyId, 'costCodes'), orderBy('code', 'asc')),
    [companyId],
  )

  // ONE id per submission: the dialog mints it once and passes it on every
  // attempt, so a double-click or a retry finds its own draft.
  const newAdjustmentId = useCallback(() => {
    if (!companyId || !projectId) return null
    return doc(adjustmentsCollection(companyId, projectId)).id
  }, [companyId, projectId])

  const prepareBudgetAdjustment = useCallback(async (id, input, currencyCode, seenBase) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runBudgetAdjustmentPrepare({
      db, adjustmentRef: adjustmentRef(id), pointerRef: pointerRef(), costCodesQuery: costCodesQuery(), getDocsFromServer,
      input, uid: user.uid, currencyCode, seenBase, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user, adjustmentRef, pointerRef, costCodesQuery])

  const approveBudgetAdjustment = useCallback(async (adjustment, currencyCode) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runBudgetAdjustmentApprove({
      db, adjustmentRef: adjustmentRef(adjustment.id), pointerRef: pointerRef(),
      approvalHeaderRef, approvalSnapshotRef, adjustmentsQuery, getDocFromServer, getDocsFromServer,
      seen: adjustment, uid: user.uid, currencyCode, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user, adjustmentRef, pointerRef, approvalHeaderRef, approvalSnapshotRef, adjustmentsQuery])

  const withdrawBudgetAdjustment = useCallback(async (adjustment, reason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runBudgetAdjustmentWithdraw({
      db, adjustmentRef: adjustmentRef(adjustment.id), seen: adjustment, reason, uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user, adjustmentRef])

  return {
    budgetAdjustments,
    budgetAdjustmentsLoading,
    budgetAdjustmentsError,
    newAdjustmentId,
    prepareBudgetAdjustment,
    approveBudgetAdjustment,
    withdrawBudgetAdjustment,
  }
}
