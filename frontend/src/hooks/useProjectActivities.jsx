import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  serverTimestamp, runTransaction,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { runActivityQuickAction } from '../lib/activityQuickActions'
import { runActivityCreate, runActivityUpdate, runActivityCancel } from '../lib/activityActions'

// ── Project Timeline activities (the programme) — ADR-29 / ADR-65 ────────────
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
// ⚠️ NO CURRENCY RATCHET. Every recent FINANCIAL create stages
// `stageProjectCurrencyLock` (ADR-21) because it writes monetary data. An
// activity holds no amount, no currency and no counter, so engaging the
// ratchet here would lock a project's currency on a scheduling write, which
// would be wrong.
//
// ⚠️ EVERY WRITE IS A GUARDED TRANSACTION (ADR-65). Create, full edit, cancel
// and the quick status actions all run through lib/activityActions.js /
// lib/activityQuickActions.js: read the server copy, refuse a STALE save when
// the activity's `revision` or (updatedAt, updatedBy) differs from the copy
// the user acted on, re-validate, verify any NEW predecessor on the server,
// then write with `revision` = stored + 1. The collection is no longer
// last-write-wins through the app; the limits of that guarantee (direct SDK
// writes, the Stage-1 transitional ruleset, graph-wide races) are Deferred
// Control 41.
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
  // A sibling activity in the SAME project — the only predecessor reference
  // the app can build, so a cross-project id cannot be expressed here.
  const predecessorRef = useCallback(
    (activityId) => doc(collectionRef(), activityId),
    [collectionRef],
  )

  // Creates an activity with a RANDOM document id — stable, never reused: the
  // id predecessors (ADR-65) attach to from the successor side.
  const createActivity = useCallback(async (input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const ref = doc(collectionRef())
    return runActivityCreate({
      db, ref, predecessorRef, input, uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user, collectionRef, predecessorRef])

  // Edits everything except the cancellation branch and the immutable core
  // (`createdAt`, `createdBy` are never written here, and rules reject an
  // update that changes them; `revision` is written as stored + 1).
  //
  // Status may move BACKWARDS — completed → in_progress, in_progress →
  // not_started — because a programme is a plan that gets corrected, not an
  // audit record. Cancellation is deliberately NOT reachable from here.
  // `activityDoc` is the copy the dialog was opened from — its version.
  const updateActivity = useCallback(async (activityDoc, input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runActivityUpdate({
      db,
      ref: doc(collectionRef(), activityDoc.id),
      predecessorRef,
      seen: activityDoc,
      input,
      uid: user.uid,
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, collectionRef, predecessorRef])

  // Cancellation is TERMINAL and requires a non-whitespace reason — enforced
  // in the action layer AND by Firestore rules, which additionally restrict
  // the write to the cancellation keys (+ revision) so no content edit can
  // ride along. Activities are NEVER deleted (the ADR-12 posture).
  const cancelActivity = useCallback(async (activityDoc, cancelReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runActivityCancel({
      db,
      ref: doc(collectionRef(), activityDoc.id),
      seen: activityDoc,
      reason: cancelReason,
      uid: user.uid,
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, collectionRef])

  // QUICK STATUS ACTION (start / hold / complete) — the same guarded write,
  // planning the transition against the server copy and writing only the
  // planned keys + revision + stamps. See lib/activityQuickActions.js.
  const quickUpdateActivity = useCallback(async (activityDoc, action) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runActivityQuickAction({
      db,
      ref: doc(collectionRef(), activityDoc.id),
      seen: activityDoc,
      action,
      uid: user.uid,
      now: new Date(),
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, collectionRef])

  return {
    activities,
    activitiesLoading,
    activitiesError,
    createActivity,
    updateActivity,
    cancelActivity,
    quickUpdateActivity,
  }
}
