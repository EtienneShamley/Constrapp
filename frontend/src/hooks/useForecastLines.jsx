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
  const [forecastLines, setForecastLines]               = useState([])
  const [forecastLinesLoading, setForecastLinesLoading] = useState(true)
  // True when the live read failed (connection loss or a rules rejection).
  // Consumers deriving financial figures must treat a failed read as
  // UNAVAILABLE — never as a genuine zero. Set only from the async snapshot
  // callbacks; existing consumers may ignore it.
  const [forecastLinesError, setForecastLinesError]     = useState(false)

  const companyId = company?.id ?? null

  useEffect(() => {
    if (!companyId || !projectId) {
      setForecastLines([])
      setForecastLinesLoading(false)
      return
    }

    setForecastLinesLoading(true)
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'forecastLines')
    // No orderBy — the document id is the costCodeId; ordering is applied in the
    // UI against the live cost-code list. A project with no forecastLines simply
    // yields an empty array (every relevant cost code then shows "Not forecast").
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        setForecastLines(snap.docs.map(d => ({ id: d.id, ...d.data() })))
        setForecastLinesLoading(false)
        setForecastLinesError(false)
      },
      () => {
        setForecastLines([])
        setForecastLinesLoading(false)
        setForecastLinesError(true)
      }
    )
    return unsubscribe
  }, [companyId, projectId])

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
