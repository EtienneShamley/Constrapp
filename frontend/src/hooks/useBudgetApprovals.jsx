import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  serverTimestamp, runTransaction, getDocsFromServer,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import {
  runBudgetCapture, runBudgetApprove, runBudgetWithdraw, checkBudgetDrift,
} from '../lib/budgetApprovalActions'

// ── Budget approval HEADERS — Constrapp SHIELD™ 2B1 (ADR-70) ─────────────────
//
// One bounded listener over `budgetApprovals` (the small lifecycle headers —
// reason, status, version, counts, totals and stamps; never the snapshot
// payload), plus the capture / approve / withdraw transactions. The active
// version's payload is read by useApprovedBudget (pointer + header + snapshot,
// each a single-document subscription), so a project with ten approved
// versions never streams ten payloads to a page.
//
// ⚠️ THIS HOOK WRITES ONLY `budgetApprovals`, `budgetApprovalSnapshots` AND
// `approvedBudget/current`. It never writes a budget line, and never touches
// Purchase Orders, Progress Claims, Supplier Invoices, Variations, Forecast
// Lines, Cash Flow Lines or the Commercial Baseline. Approving a budget moves
// no Actual, no commitment, no forecast and no cash figure (ADR-70).
//
// ⚠️ EVERY WRITE IS A GUARDED TRANSACTION (lib/budgetApprovalActions.js):
// capture reads the budget lines and cost codes FROM THE SERVER
// (`getDocsFromServer`, never the cache) and creates the header + snapshot
// pair atomically; approve re-reads the lines for drift, then reads the
// header (stale by revision AND stamps refused), the snapshot and the POINTER
// inside the transaction; withdraw reads the header. Rules require the pair,
// the lifecycle and the pointer pairing (DC44 lists what they cannot prove).
//
// No currency ratchet is engaged here: a capture requires budget lines, and
// the first budget line already locked the project's currency.
//
// The keyed-snapshot / derived-loading pattern (ADR-41) as in every other
// subscription hook.
export function useBudgetApprovals(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()

  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, approvals: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'budgetApprovals')
    // Ordered by a field EVERY header carries; versions, drafts and history
    // order are derived in lib/budgetApproval.js, never from this.
    const q = query(ref, orderBy('createdAt', 'asc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        approvals: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error — most often a rules rejection. Unavailable, never an
      // empty history.
      () => setSnap({ key, approvals: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const budgetApprovals = settled ? snap.approvals : []
  const budgetApprovalsLoading = targetKey !== null && !settled
  const budgetApprovalsError = settled ? snap.error : false

  const headerRef = useCallback(
    (id) => doc(db, 'companies', companyId, 'projects', projectId, 'budgetApprovals', id),
    [companyId, projectId],
  )
  const snapshotRef = useCallback(
    (id) => doc(db, 'companies', companyId, 'projects', projectId, 'budgetApprovalSnapshots', id),
    [companyId, projectId],
  )
  const pointerRef = useCallback(
    () => doc(db, 'companies', companyId, 'projects', projectId, 'approvedBudget', 'current'),
    [companyId, projectId],
  )
  // The working register and the cost-code library — the same queries the
  // listeners use, read from the SERVER by the actions.
  const budgetLinesQuery = useCallback(
    () => query(collection(db, 'companies', companyId, 'projects', projectId, 'budgetLines'), orderBy('createdAt', 'desc')),
    [companyId, projectId],
  )
  const costCodesQuery = useCallback(
    () => query(collection(db, 'companies', companyId, 'costCodes'), orderBy('code', 'asc')),
    [companyId],
  )

  // CAPTURE — mints ONE random id shared by the header and the snapshot.
  const captureBudgetApproval = useCallback(async (input, currencyCode) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const id = doc(collection(db, 'companies', companyId, 'projects', projectId, 'budgetApprovals')).id
    return runBudgetCapture({
      db,
      headerRef: headerRef(id),
      snapshotRef: snapshotRef(id),
      budgetLinesQuery: budgetLinesQuery(),
      costCodesQuery: costCodesQuery(),
      getDocsFromServer,
      input,
      uid: user.uid,
      currencyCode,
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, headerRef, snapshotRef, budgetLinesQuery, costCodesQuery])

  // DRIFT (read-only) — the working register on the server against a draft's snapshot.
  const checkDrift = useCallback(async (snapshot) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return checkBudgetDrift({ budgetLinesQuery: budgetLinesQuery(), getDocsFromServer, snapshot })
  }, [companyId, projectId, user, budgetLinesQuery])

  // APPROVE — `header` is the copy the reviewer opened; `acknowledgedDriftKey`
  // the drift they reviewed; `seenVersionCount` the pointer count they
  // reviewed against (0 when no version existed).
  const approveBudgetApproval = useCallback(async (header, snapshot, acknowledgedDriftKey, seenVersionCount) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runBudgetApprove({
      db,
      headerRef: headerRef(header.id),
      snapshotRef: snapshotRef(header.id),
      pointerRef: pointerRef(),
      budgetLinesQuery: budgetLinesQuery(),
      getDocsFromServer,
      seen: header,
      snapshot,
      acknowledgedDriftKey,
      seenVersionCount,
      uid: user.uid,
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, headerRef, snapshotRef, pointerRef, budgetLinesQuery])

  // WITHDRAW — a draft only, with a reason. Approved versions are never
  // withdrawn or deleted.
  const withdrawBudgetApproval = useCallback(async (header, reason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runBudgetWithdraw({
      db,
      headerRef: headerRef(header.id),
      seen: header,
      reason,
      uid: user.uid,
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, headerRef])

  return {
    budgetApprovals,
    budgetApprovalsLoading,
    budgetApprovalsError,
    captureBudgetApproval,
    checkDrift,
    approveBudgetApproval,
    withdrawBudgetApproval,
  }
}
