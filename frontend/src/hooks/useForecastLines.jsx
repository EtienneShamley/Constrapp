import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot,
  runTransaction, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { stageProjectCurrencyLock } from './projectCurrencyLock'

// Forecast Lines — the ONLY authored input of the Forecast Cost to Complete
// feature. One document per cost code, keyed by a DETERMINISTIC document id
// (costCodeId) so there is exactly one current forecast per cost code and saves
// are idempotent upserts (never addDoc with a random id). Stored fields are
// limited to the manual input, notes, and audit stamps — Actual, Remaining
// Committed, Cost to Complete, Forecast Final Cost, Variance, Budgeted, and
// variation exposure are ALL derived at read time (never written here).
export function useForecastLines(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, so
  // forecastLines/loading/error are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // `error` is true when the live read failed (connection loss or a rules
  // rejection). Consumers deriving financial figures MUST treat a failed read
  // as UNAVAILABLE — never as a genuine zero. It is exposed only once the
  // CURRENT target has settled, so a project switch never flashes a stale
  // unavailable banner under the new project.
  const [snap, setSnap] = useState({ key: null, forecastLines: [], error: false })

  const companyId = company?.id ?? null

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'forecastLines')
    // No orderBy — the document id is the costCodeId; ordering is applied in the
    // UI against the live cost-code list. A project with no forecastLines simply
    // yields an empty array (every relevant cost code then shows "Not forecast").
    const unsubscribe = onSnapshot(
      ref,
      (querySnap) => setSnap({
        key,
        forecastLines: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read must NOT look like an empty register — "none" and "we
      // could not load them" are opposite facts, and confusing them on a
      // financial register fabricates a zero.
      () => setSnap({ key, forecastLines: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no data, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // hides the previous project's rows immediately.
  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const forecastLines = settled ? snap.forecastLines : []
  const forecastLinesLoading = targetKey !== null && !settled
  const forecastLinesError = settled ? snap.error : false

  // Idempotent upsert keyed by costCodeId. A transaction sets createdAt/createdBy
  // only on first creation and always refreshes updatedAt/updatedBy, so audit
  // provenance is preserved across edits.
  //
  //   uncommittedCostToComplete: number | null
  //     null  → not forecast (blank input); the document is NOT deleted
  //     0     → reviewed, no further uncommitted cost expected
  //     < 0   → rejected (invalid)
  //
  // costCodeName stores the CURRENT live cost-code name; when the caller cannot
  // resolve it (missing/inactive cost code, passes ''), the existing stored name
  // is kept as a fallback. Firestore deletion of forecast lines stays blocked by
  // rules — clearing an input writes null instead.
  const upsertForecastLine = useCallback(async (costCodeId, { costCodeName, uncommittedCostToComplete, notes }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!costCodeId) throw new Error('A cost code is required')

    let ctc = uncommittedCostToComplete
    if (ctc === '' || ctc === undefined) ctc = null
    if (ctc !== null) {
      ctc = Number(ctc)
      if (!Number.isFinite(ctc)) throw new Error('Uncommitted Cost to Complete must be a number')
      if (ctc < 0) throw new Error('Uncommitted Cost to Complete cannot be negative')
    }

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'forecastLines', costCodeId)
    const trimmedName = (costCodeName || '').trim()
    const trimmedNotes = (notes ?? '').trim()

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref)
      // An authored number (including 0) is monetary data and engages the
      // currency ratchet IN THIS TRANSACTION, so the forecast input and the lock
      // succeed or fail together. `null` means "not forecast" and carries no
      // money, so it deliberately does not lock. Firestore requires all
      // transaction reads before any writes, hence the staged read here.
      const commitLock = ctc === null
        ? () => {}
        : await stageProjectCurrencyLock(tx, companyId, projectId)

      if (snap.exists()) {
        // Preserve createdAt/createdBy; refresh input, notes, name, and audit.
        tx.update(ref, {
          costCodeId,
          costCodeName: trimmedName || snap.data().costCodeName || '',
          uncommittedCostToComplete: ctc,
          notes: trimmedNotes,
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
        })
      } else {
        tx.set(ref, {
          costCodeId,
          costCodeName: trimmedName,
          uncommittedCostToComplete: ctc,
          notes: trimmedNotes,
          createdAt: serverTimestamp(),
          createdBy: user.uid,
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
        })
      }
      commitLock()
    })

    return ref.id
  }, [companyId, projectId, user])

  return { forecastLines, forecastLinesLoading, forecastLinesError, upsertForecastLine }
}
