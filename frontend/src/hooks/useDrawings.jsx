import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  setDoc, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import {
  DRAWING_STATUS, REVISION_SCHEMA_VERSION,
  normaliseDrawingNumber, validateDrawingDraft, validateWithdrawReason,
} from '../lib/drawings'

// ── Drawing masters ──────────────────────────────────────────────────────────
//
// The register-level hook: the list of drawing masters for one project, plus
// creation, identity edits, and withdrawal of an EMPTY master. Revisions live in
// hooks/useDrawingRevisions.jsx — including every write that moves the master's
// current-revision pointer, because those must share one transaction.
//
// A MASTER IS BORN EMPTY (revisionCount 0, currentRevisionId null) and only
// starts advertising a revision once that revision's bytes are genuinely in
// Storage. This is the whole reason creation and first-issue are separate steps:
// an upload failure can never leave a drawing claiming a revision that is not
// there. Firestore rules enforce the empty birth.
//
// READS ARE OPEN TO EVERY PROVISIONED COMPANY MEMBER, including subcontractor
// and client — a drawing is site information. WRITES are company_admin /
// project_manager only (rules-enforced; lib/drawings.js carries the UX mirror).
export function useDrawings(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()

  const companyId = company?.id ?? null

  // Subscription state tagged with the target it belongs to, so a project
  // switch never renders the previous project's drawings. State is written only
  // from the onSnapshot callbacks; loading/error are derived at render time.
  const [snap, setSnap] = useState({ key: null, drawings: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'drawings')
    // Ordered by drawing number — the order a register is read in. Single-field
    // ordering, so no composite index is required.
    const q = query(ref, orderBy('drawingNumber'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        drawings: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed subscription must NOT look like an empty register — "no
      // drawings" and "we could not load the drawings" are opposite facts, and
      // confusing them on a drawing register is a site-safety problem.
      () => setSnap({ key, drawings: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const drawings = settled ? snap.drawings : []
  const drawingsLoading = targetKey !== null && !settled
  const drawingsError = settled ? snap.error : false

  // Creates an EMPTY drawing master and returns its id. The caller then issues
  // the first revision, which promotes transactionally.
  //
  // Random Firestore ID: `drawingId` is the immutable identity a future takeoff
  // will reference, so it must survive the drawing number being corrected.
  const createDrawing = useCallback(async ({ drawingNumber, title, discipline, description }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateDrawingDraft({ drawingNumber, title, discipline })
    if (validationError) throw new Error(validationError)

    const ref = doc(collection(db, 'companies', companyId, 'projects', projectId, 'drawings'))

    await setDoc(ref, {
      drawingNumber: normaliseDrawingNumber(drawingNumber),
      title:         String(title).trim(),
      discipline,
      description:   String(description ?? '').trim(),

      status: DRAWING_STATUS.ACTIVE,

      // Born empty. Rules require exactly this at create.
      currentRevisionId:         null,
      currentRevisionCode:       '',
      currentRevisionIssuedDate: null,
      revisionCount:             0,

      // Which revision schema the subcollection is written in, so a future
      // migration can tell old revisions from new ones without guessing.
      revisionSchemaVersion: REVISION_SCHEMA_VERSION,

      withdrawnAt:    null,
      withdrawnBy:    null,
      withdrawReason: '',

      createdAt: serverTimestamp(),
      createdBy: user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
    return ref.id
  }, [companyId, projectId, user])

  // Identity edits only — number, title, discipline, description. The pointer,
  // the revision count and the status are never written here (and rules reject
  // an update that touches them alongside these fields).
  const updateDrawing = useCallback(async (drawing, { drawingNumber, title, discipline, description }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (drawing.status !== DRAWING_STATUS.ACTIVE) {
      throw new Error('A withdrawn drawing cannot be edited')
    }

    const validationError = validateDrawingDraft({ drawingNumber, title, discipline })
    if (validationError) throw new Error(validationError)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'drawings', drawing.id)
    await updateDoc(ref, {
      drawingNumber: normaliseDrawingNumber(drawingNumber),
      title:         String(title).trim(),
      discipline,
      description:   String(description ?? '').trim(),
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  // Withdraws a master that has NO current revision — the drawing created for an
  // upload that failed, or one whose current revision was already withdrawn with
  // no replacement.
  //
  // Withdrawing a drawing that DOES have a current revision is deliberately not
  // possible here: that decision belongs with the revision, where the user must
  // explicitly choose whether an earlier revision is reinstated. Withdrawal is
  // terminal, and nothing is ever hard-deleted.
  const withdrawDrawing = useCallback(async (drawing, withdrawReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (drawing.status !== DRAWING_STATUS.ACTIVE) {
      throw new Error('This drawing has already been withdrawn')
    }
    if (drawing.currentRevisionId) {
      throw new Error('Withdraw the current revision first, and choose whether an earlier revision is reinstated')
    }

    const reasonError = validateWithdrawReason(withdrawReason)
    if (reasonError) throw new Error(reasonError)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'drawings', drawing.id)
    await updateDoc(ref, {
      status: DRAWING_STATUS.WITHDRAWN,
      currentRevisionId:         null,
      currentRevisionCode:       '',
      currentRevisionIssuedDate: null,
      withdrawnAt:    serverTimestamp(),
      withdrawnBy:    user.uid,
      withdrawReason: String(withdrawReason).trim(),
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  return {
    drawings,
    drawingsLoading,
    drawingsError,
    createDrawing,
    updateDrawing,
    withdrawDrawing,
  }
}

// One drawing master, live. Used by the detail route, which is reached by URL
// and therefore cannot rely on the register list being loaded.
export function useDrawing(projectId, drawingId) {
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, drawing: null, error: false })

  useEffect(() => {
    if (!companyId || !projectId || !drawingId) return undefined

    const key = `${companyId}/${projectId}/${drawingId}`
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'drawings', drawingId)

    const unsubscribe = onSnapshot(
      ref,
      (docSnap) => setSnap({
        key,
        drawing: docSnap.exists() ? { id: docSnap.id, ...docSnap.data() } : null,
        error: false,
      }),
      () => setSnap({ key, drawing: null, error: true }),
    )
    return unsubscribe
  }, [companyId, projectId, drawingId])

  const targetKey = companyId && projectId && drawingId
    ? `${companyId}/${projectId}/${drawingId}`
    : null
  const settled = targetKey !== null && snap.key === targetKey

  return {
    drawing:        settled ? snap.drawing : null,
    drawingLoading: targetKey !== null && !settled,
    drawingError:   settled ? snap.error : false,
  }
}
