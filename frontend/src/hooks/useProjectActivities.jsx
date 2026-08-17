import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  setDoc, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import {
  ACTIVITY_STATUS,
  normaliseActivityDraft, validateActivityDraft, validateCancelReason,
} from '../lib/projectTimeline'

// ── Project Timeline activities (the programme) — ADR-29 ─────────────────────
//
// An activity is a PLANNING record, not a financial document.
//
// ⚠️ THIS HOOK WRITES ONLY `activities` DOCUMENTS. It never touches Forecast
// Lines, Cash Flow Lines, the Commercial Baseline, Progress Claims, Purchase
// Orders, Supplier/Client Invoices, Budget Lines, Variations, or
// `projects/{projectId}.progress`. The optional `costCodeId` + frozen
// `costCodeName` are a JOIN KEY for a future read-time "delay → forecast
// impact" derivation — never an authored commercial value.
//
// ⚠️ NO TRANSACTION AND NO CURRENCY RATCHET. Every other recent create wraps
// itself in `runTransaction` to stage `stageProjectCurrencyLock` (ADR-21),
// because it writes monetary data. An activity holds no amount, no currency and
// no counter, so there is nothing to make atomic and nothing to lock — engaging
// the ratchet here would lock a project's currency on a scheduling write, which
// would be wrong.
//
// ⚠️ LAST-WRITE-WINS. There is no optimistic concurrency: two users editing one
// activity will overwrite each other, including fields the second never looked
// at. `updatedAt`/`updatedBy` record WHO last wrote, not WHAT changed. The UI
// surfaces that metadata; compare-and-set is deferred (docs/SECURITY.md →
// Deferred Control 20).
//
// The keyed-snapshot pattern below (state tagged with the target it belongs to,
// loading DERIVED from it) is the one used by useCashFlowLines /
// useSupplierPayments — deliberately, because the older `setLoading(true)`
// inside an effect is what produces this repo's accepted lint errors.
export function useProjectActivities(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()

  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, activities: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'activities')
    // Ordered by a field EVERY document carries. Display order is decided by
    // sortActivities() in lib/projectTimeline.js (sortOrder, then a
    // deterministic tie-break), so a document with an odd sortOrder can never
    // drop out of the subscription.
    const q = query(ref, orderBy('createdAt', 'asc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        activities: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error — most often a rules rejection for a subcontractor/client
      // user. Degrade to "unavailable", never to a silent empty programme.
      () => setSnap({ key, activities: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const activities = settled ? snap.activities : []
  const activitiesLoading = targetKey !== null && !settled
  const activitiesError = settled ? snap.error : false

  const collectionRef = useCallback(
    () => collection(db, 'companies', companyId, 'projects', projectId, 'activities'),
    [companyId, projectId],
  )

  // Creates an activity with a RANDOM document id — stable, never reused, and
  // the only forward-compatibility this foundation needs for future links
  // (drawings, photos, RFIs, dependencies) that attach from the other side.
  const createActivity = useCallback(async (input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateActivityDraft(input, { creating: true })
    if (validationError) throw new Error(validationError)

    const ref = doc(collectionRef())
    await setDoc(ref, {
      ...normaliseActivityDraft(input),

      // Cancellation stamps. Rules require these empty/null at create, so a
      // pre-cancelled activity cannot be forged.
      cancelReason: '',
      cancelledAt:  null,
      cancelledBy:  null,

      revision: 1,
      createdAt: serverTimestamp(),
      createdBy: user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
    return ref.id
  }, [companyId, projectId, user, collectionRef])

  // Edits everything except the cancellation branch and the immutable core
  // (`revision`, `createdAt`, `createdBy` are never written here, and rules
  // reject an update that changes any of them).
  //
  // Status may move BACKWARDS — completed → in_progress, in_progress →
  // not_started — because a programme is a plan that gets corrected, not an
  // audit record. Cancellation is deliberately NOT reachable from here.
  const updateActivity = useCallback(async (activityDoc, input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (activityDoc?.status === ACTIVITY_STATUS.CANCELLED) {
      throw new Error('A cancelled activity cannot be edited')
    }

    const validationError = validateActivityDraft(input)
    if (validationError) throw new Error(validationError)

    const ref = doc(collectionRef(), activityDoc.id)
    await updateDoc(ref, {
      ...normaliseActivityDraft(input),
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user, collectionRef])

  // Cancellation is TERMINAL and requires a non-whitespace reason — enforced
  // here AND by Firestore rules, which additionally restrict the write to the
  // cancellation keys so no content edit can ride along.
  //
  // Activities are NEVER deleted (the ADR-12 posture): a cancelled activity is
  // retained programme history that simply stops counting as outstanding work.
  const cancelActivity = useCallback(async (activityDoc, cancelReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (activityDoc?.status === ACTIVITY_STATUS.CANCELLED) {
      throw new Error('This activity is already cancelled')
    }

    const reasonError = validateCancelReason(cancelReason)
    if (reasonError) throw new Error(reasonError)

    const ref = doc(collectionRef(), activityDoc.id)
    await updateDoc(ref, {
      status:       ACTIVITY_STATUS.CANCELLED,
      cancelReason: String(cancelReason).trim(),
      cancelledAt:  serverTimestamp(),
      cancelledBy:  user.uid,
      updatedAt:    serverTimestamp(),
      updatedBy:    user.uid,
    })
  }, [companyId, projectId, user, collectionRef])

  return {
    activities,
    activitiesLoading,
    activitiesError,
    createActivity,
    updateActivity,
    cancelActivity,
  }
}
