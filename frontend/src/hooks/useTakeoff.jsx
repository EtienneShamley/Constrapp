import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { takeoffPageId, MEASUREMENT_KIND } from '../lib/quant'
import {
  runEnsurePage, runSaveCalibration, runCreateMeasurement, runUpdateMeasurement, runVoidMeasurement,
} from '../lib/quantActions'

// ── Constrapp Quant™ 1A — takeoff pages and measurements (ADR-51) ────────────
//
// Two project-scoped collections, two keyed subscriptions (ADR-41), one file:
//
//   …/projects/{projectId}/takeoffPages/{drawingId}_{revisionId}_{page}
//   …/projects/{projectId}/takeoffMeasurements/{measurementId}
//
// Every write is a revision-guarded transaction in lib/quantActions.js, which
// refuses to overwrite a version the user has not seen. These hooks write ONLY
// those two collections: no BOQ item, budget line, forecast line, cash-flow
// line, baseline, PO, claim or invoice is read or written, and no currency
// lock is staged. Quant 1B owns BOQ linkage (ADR-51).
//
// Mounted only inside the Quant workspace, i.e. after the page's role gate, so
// subcontractor and client users never open them (rules deny them anyway).

const pagesCol = (companyId, projectId) =>
  collection(db, 'companies', companyId, 'projects', projectId, 'takeoffPages')
const measurementsCol = (companyId, projectId) =>
  collection(db, 'companies', companyId, 'projects', projectId, 'takeoffMeasurements')

export function useTakeoffPages(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, takeoffPages: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    // No orderBy — pages are looked up by their deterministic id, never listed
    // in collection order.
    const unsubscribe = onSnapshot(
      pagesCol(companyId, projectId),
      (querySnap) => setSnap({
        key,
        takeoffPages: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read is UNAVAILABLE — never "this page is not calibrated".
      () => setSnap({ key, takeoffPages: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const takeoffPages = settled ? snap.takeoffPages : []
  const takeoffPagesLoading = targetKey !== null && !settled
  const takeoffPagesError = settled ? snap.error : false

  const pageRef = useCallback(
    (identity) => doc(pagesCol(companyId, projectId), takeoffPageId(identity.drawingId, identity.revisionId, identity.page)),
    [companyId, projectId],
  )

  // Save or replace a page's calibration. `seenPage` is the page document as
  // rendered (or null). The CALLER obtains the user's explicit confirmation
  // when measurements already exist on the page — the hook never decides that.
  const saveCalibration = useCallback(async ({ identity, geometry, draft, seenPage }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runSaveCalibration({
      db, pageRef: pageRef(identity), identity, geometry, draft, seenPage,
      uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user, pageRef])

  return { takeoffPages, takeoffPagesLoading, takeoffPagesError, saveCalibration }
}

export function useTakeoffMeasurements(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, takeoffMeasurements: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    // Entry order — the order the QS took them off. Single-field ordering, so
    // no composite index is required.
    const q = query(measurementsCol(companyId, projectId), orderBy('createdAt', 'asc'))
    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        takeoffMeasurements: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read is UNAVAILABLE — never "no measurements yet".
      () => setSnap({ key, takeoffMeasurements: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const takeoffMeasurements = settled ? snap.takeoffMeasurements : []
  const takeoffMeasurementsLoading = targetKey !== null && !settled
  const takeoffMeasurementsError = settled ? snap.error : false

  const pageRef = useCallback(
    (identity) => doc(pagesCol(companyId, projectId), takeoffPageId(identity.drawingId, identity.revisionId, identity.page)),
    [companyId, projectId],
  )
  const measurementRef = useCallback(
    (id) => doc(measurementsCol(companyId, projectId), id),
    [companyId, projectId],
  )

  // Create one measurement. `seenPage` is the takeoff page as rendered, or
  // null when none exists yet. A COUNT on a never-calibrated page first makes
  // sure the page document exists (a separate commit — rules verify the
  // page with exists(), which sees committed state only); a length or area
  // needs an existing calibrated page, which is what the user measured under.
  const createMeasurement = useCallback(async ({ identity, geometry, draft, seenPage }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const common = { db, uid: user.uid, runTransaction, serverTimestamp }

    let page = seenPage ?? null
    if (!page && draft?.kind === MEASUREMENT_KIND.COUNT) {
      const ensured = await runEnsurePage({ ...common, pageRef: pageRef(identity), identity, geometry })
      page = ensured.page
    }
    return runCreateMeasurement({
      ...common,
      pageRef: pageRef(identity),
      measurementRef: doc(measurementsCol(companyId, projectId)),
      identity, draft, seenPage: page,
    })
  }, [companyId, projectId, user, pageRef])

  // Edit an active measurement's geometry, label or cost code. Pass
  // `calibration` (the page's current snapshot) ONLY when the edit is a
  // geometry change or an explicit review — see lib/quantActions.js.
  const updateMeasurement = useCallback(async ({ seen, changes, calibration }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runUpdateMeasurement({
      db, ref: measurementRef(seen.id), seen, changes, calibration,
      uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user, measurementRef])

  const voidMeasurement = useCallback(async ({ seen, reason }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runVoidMeasurement({
      db, ref: measurementRef(seen.id), seen, reason,
      uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user, measurementRef])

  return {
    takeoffMeasurements,
    takeoffMeasurementsLoading,
    takeoffMeasurementsError,
    createMeasurement,
    updateMeasurement,
    voidMeasurement,
  }
}
