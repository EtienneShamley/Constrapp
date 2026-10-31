import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  serverTimestamp, runTransaction, getDocsFromServer,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import {
  runBaselineCapture, runBaselineApprove, runBaselineWithdraw, checkBaselineDrift,
} from '../lib/programmeBaselineActions'

// ── Programme baseline HEADERS — Constrapp GANTT™ 1B (ADR-66) ────────────────
//
// One bounded listener over `programmeBaselines` (the small lifecycle headers
// — name, reason, status, counts and stamps; never the snapshot payload). The
// selected snapshot is a separate single-document subscription
// (useProgrammeBaselineSnapshot), so a project with ten approved versions
// never streams ten payloads to the page.
//
// ⚠️ THIS HOOK WRITES ONLY `programmeBaselines` AND `programmeBaselineSnapshots`
// DOCUMENTS. It never writes an activity, and never touches Forecast Lines,
// Cash Flow Lines, the Commercial Baseline (`commercial/baseline` — a
// different, financial record), Progress Claims, Purchase Orders, invoices,
// Budget Lines, Variations or `projects/{projectId}.progress`. A programme
// baseline holds no amount and no currency, so no currency ratchet is
// engaged (the ADR-29 posture for activities).
//
// ⚠️ EVERY WRITE IS A GUARDED TRANSACTION (lib/programmeBaselineActions.js):
// capture reads the programme FROM THE SERVER (`getDocsFromServer`, never the
// cache) and creates the header + snapshot pair atomically; approve re-reads
// the programme for drift, then reads the header (stale by revision AND
// stamps refused) and the snapshot inside the transaction; withdraw reads the
// header. Rules require the pair and the lifecycle (DC42 lists what they
// cannot prove).
//
// The keyed-snapshot / derived-loading pattern (ADR-41) as in every other
// subscription hook.
export function useProgrammeBaselines(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()

  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, baselines: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'programmeBaselines')
    // Ordered by a field EVERY header carries; active / original / ordinals
    // are derived in lib/ganttBaseline.js from approvedAt, never from this.
    const q = query(ref, orderBy('createdAt', 'asc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        baselines: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error — most often a rules rejection. Unavailable, never an
      // empty history.
      () => setSnap({ key, baselines: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const baselines = settled ? snap.baselines : []
  const baselinesLoading = targetKey !== null && !settled
  const baselinesError = settled ? snap.error : false

  const headerRef = useCallback(
    (id) => doc(db, 'companies', companyId, 'projects', projectId, 'programmeBaselines', id),
    [companyId, projectId],
  )
  const snapshotRef = useCallback(
    (id) => doc(db, 'companies', companyId, 'projects', projectId, 'programmeBaselineSnapshots', id),
    [companyId, projectId],
  )
  // The whole programme — the same query the activities listener uses, read
  // from the SERVER by the actions.
  const activitiesQuery = useCallback(
    () => query(collection(db, 'companies', companyId, 'projects', projectId, 'activities'), orderBy('createdAt', 'asc')),
    [companyId, projectId],
  )

  // CAPTURE — mints ONE random id shared by the header and the snapshot.
  const captureBaseline = useCallback(async (input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const id = doc(collection(db, 'companies', companyId, 'projects', projectId, 'programmeBaselines')).id
    return runBaselineCapture({
      db,
      headerRef: headerRef(id),
      snapshotRef: snapshotRef(id),
      activitiesQuery: activitiesQuery(),
      getDocsFromServer,
      input,
      uid: user.uid,
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, headerRef, snapshotRef, activitiesQuery])

  // DRIFT (read-only) — the programme on the server against a draft's snapshot.
  const checkDrift = useCallback(async (snapshot) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return checkBaselineDrift({ activitiesQuery: activitiesQuery(), getDocsFromServer, snapshot })
  }, [companyId, projectId, user, activitiesQuery])

  // APPROVE — `header` is the copy the reviewer opened (its version);
  // `acknowledgedDriftKey` the drift they explicitly reviewed.
  const approveBaseline = useCallback(async (header, snapshot, acknowledgedDriftKey) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runBaselineApprove({
      db,
      headerRef: headerRef(header.id),
      snapshotRef: snapshotRef(header.id),
      activitiesQuery: activitiesQuery(),
      getDocsFromServer,
      seen: header,
      snapshot,
      acknowledgedDriftKey,
      uid: user.uid,
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, headerRef, snapshotRef, activitiesQuery])

  // WITHDRAW — a draft only, with a reason. Approved baselines are never
  // withdrawn or deleted.
  const withdrawBaseline = useCallback(async (header, reason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runBaselineWithdraw({
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
    baselines,
    baselinesLoading,
    baselinesError,
    captureBaseline,
    checkDrift,
    approveBaseline,
    withdrawBaseline,
  }
}
