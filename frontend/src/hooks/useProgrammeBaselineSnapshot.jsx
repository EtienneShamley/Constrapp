import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useCompany } from './useCompany'

// ── ONE programme baseline SNAPSHOT — Constrapp GANTT™ 1B (ADR-66) ───────────
//
// The immutable payload of the ONE selected baseline
// (`programmeBaselineSnapshots/{baselineId}`): a single-document subscription,
// keyed by the selection, so switching version reads one document and no
// historical payload is ever streamed for a version nobody is looking at.
// With no selection the hook is idle.
//
// READ-ONLY. The snapshot is create-only in the rules; nothing in the app
// ever updates it. A failed read is UNAVAILABLE, never "no baseline".
export function useProgrammeBaselineSnapshot(projectId, baselineId) {
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, snapshot: null, error: false })

  useEffect(() => {
    if (!companyId || !projectId || !baselineId) return undefined

    const key = `${companyId}/${projectId}/${baselineId}`
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'programmeBaselineSnapshots', baselineId)
    const unsubscribe = onSnapshot(
      ref,
      (d) => setSnap({ key, snapshot: d.exists() ? { id: d.id, ...d.data() } : null, error: false }),
      () => setSnap({ key, snapshot: null, error: true }),
    )
    return unsubscribe
  }, [companyId, projectId, baselineId])

  const targetKey = companyId && projectId && baselineId ? `${companyId}/${projectId}/${baselineId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const snapshot = settled ? snap.snapshot : null
  const snapshotLoading = targetKey !== null && !settled
  const snapshotError = settled ? snap.error : false

  return { snapshot, snapshotLoading, snapshotError }
}
