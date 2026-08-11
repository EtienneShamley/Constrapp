import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import {
  DRAWING_STATUS, REVISION_STATUS,
  CONCURRENT_REVISION_MESSAGE,
  normaliseRevisionCode, validateRevisionDraft, validateWithdrawReason,
} from '../lib/drawings'
import { drawingStoragePath, storageExtension, originalFileName } from '../lib/files'

// ── Drawing revisions (immutable issues) ─────────────────────────────────────
//
// Owns every write that moves a drawing's current-revision pointer, because
// each of them has to be ONE transaction spanning the master and its revisions.
//
// ISSUING A REVISION IS A TWO-PHASE OPERATION and the caller drives both halves:
//
//   1. newRevisionTarget(contentType) — mints the revision ID client-side and
//      derives its immutable storage path
//   2. the caller uploads the bytes (hooks/useStorageUpload.jsx)
//   3. commitRevision(...) — ONE Firestore transaction that creates the
//      revision, supersedes the previous current, and moves the master
//
// Storage first, Firestore second. If step 3 fails, the bytes are ORPHANED —
// accepted and documented, because the alternative is a register row pointing
// at a file that is not there.
//
// ⚠️ CONCURRENCY IS ABORTED, NEVER RESOLVED. The transaction re-reads the
// master and compares its current-revision pointer with the one the UI was
// showing when the upload started. If another user issued a revision in the
// meantime, the transaction throws CONCURRENT_REVISION_MESSAGE and promotes
// nothing. Auto-promoting would silently supersede work this user has not seen.
export function useDrawingRevisions(projectId, drawingId) {
  const { user }    = useAuth()
  const { company } = useCompany()

  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, revisions: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId || !drawingId) return undefined

    const key = `${companyId}/${projectId}/${drawingId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'drawings', drawingId, 'revisions')
    // ⚠️ Ordered by the INTEGER revisionSequence, never by revisionCode: codes
    // are real-world text ("A", "B", "P1", "10") and sort wrongly under every
    // lexical comparison.
    const q = query(ref, orderBy('revisionSequence', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        revisions: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed subscription is reported as a failure, never as "no revisions".
      () => setSnap({ key, revisions: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId, drawingId])

  const targetKey = companyId && projectId && drawingId
    ? `${companyId}/${projectId}/${drawingId}`
    : null
  const settled = targetKey !== null && snap.key === targetKey
  const revisions = settled ? snap.revisions : []
  const revisionsLoading = targetKey !== null && !settled
  const revisionsError = settled ? snap.error : false

  const drawingRef = useCallback(() => (
    doc(db, 'companies', companyId, 'projects', projectId, 'drawings', drawingId)
  ), [companyId, projectId, drawingId])

  const revisionRef = useCallback((revisionId) => (
    doc(db, 'companies', companyId, 'projects', projectId, 'drawings', drawingId, 'revisions', revisionId)
  ), [companyId, projectId, drawingId])

  // Phase 1 — mint the identity and the path the bytes will live at.
  //
  // The ID is minted CLIENT-SIDE precisely so the storage path can be derived
  // before the upload starts: the path contains the revision ID, and Storage
  // Rules recompute that same path from the object's location. Nothing about
  // the user's filename enters it.
  const newRevisionTarget = useCallback((contentType) => {
    if (!companyId || !projectId || !drawingId) throw new Error('Not authenticated')

    const ref = doc(collection(db, 'companies', companyId, 'projects', projectId, 'drawings', drawingId, 'revisions'))
    const storagePath = drawingStoragePath(companyId, projectId, drawingId, ref.id, contentType)
    if (!storagePath) throw new Error('Unsupported file type')

    return { revisionId: ref.id, storagePath }
  }, [companyId, projectId, drawingId])

  // Phase 3 — ONE transaction: create the revision as current, supersede the
  // previous current, and move the master.
  //
  // `expectedCurrentRevisionId` is the pointer the UI was showing before the
  // upload. It is the concurrency check, and it is checked INSIDE the
  // transaction, so two simultaneous issues cannot both promote.
  const commitRevision = useCallback(async ({
    revisionId, storagePath, expectedCurrentRevisionId = null,
    revisionCode, revisionDate, notes, file,
  }) => {
    if (!companyId || !projectId || !drawingId || !user) throw new Error('Not authenticated')

    const validationError = validateRevisionDraft({ revisionCode, revisionDate })
    if (validationError) throw new Error(validationError)

    const contentType = file?.type
    const fileExt = storageExtension(contentType)
    if (!fileExt) throw new Error('Unsupported file type')

    // Recomputed rather than trusted: the path written to Firestore must be the
    // one derived from these IDs, and rules reject anything else.
    const expectedPath = drawingStoragePath(companyId, projectId, drawingId, revisionId, contentType)
    if (!expectedPath || expectedPath !== storagePath) {
      throw new Error('This upload could not be verified. Try again.')
    }

    const code = normaliseRevisionCode(revisionCode)
    const master = drawingRef()
    const newRevision = revisionRef(revisionId)

    await runTransaction(db, async (tx) => {
      const masterSnap = await tx.get(master)
      if (!masterSnap.exists()) throw new Error('This drawing no longer exists.')

      const data = masterSnap.data()
      if (data.status !== DRAWING_STATUS.ACTIVE) {
        throw new Error('This drawing has been withdrawn and cannot receive new revisions.')
      }

      // ⚠️ THE CONCURRENCY GATE. Abort — never guess.
      const actualCurrent = data.currentRevisionId ?? null
      if (actualCurrent !== (expectedCurrentRevisionId ?? null)) {
        throw new Error(CONCURRENT_REVISION_MESSAGE)
      }

      // Dense and monotonic because rules force revisionCount to move by
      // exactly +1 on every promotion. This is the value revisions are ORDERED
      // by — revisionCode is never sorted.
      const revisionSequence = Number(data.revisionCount ?? 0) + 1

      tx.set(newRevision, {
        revisionCode: code,
        revisionSequence,
        revisionDate,

        status: REVISION_STATUS.CURRENT,
        notes:  String(notes ?? '').trim(),

        // File identity — IMMUTABLE from here. The original filename is kept as
        // metadata only; `storagePath` is the identity, and rules freeze it.
        fileName:    originalFileName(file),
        fileExt,
        fileSize:    file.size,
        contentType,
        storagePath,

        // Reserved for a future takeoff module. Deliberately not fabricated:
        // nothing here counts pages or reads a sheet size, so inventing values
        // would put untrue metadata into the permanent record.
        pageCount: null,
        sheetSize: '',

        supersededAt:           null,
        supersededBy:           null,
        supersededByRevisionId: null,
        withdrawnAt:            null,
        withdrawnBy:            null,
        withdrawReason:         '',

        revision: 1,

        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })

      // The outgoing revision is superseded in the SAME commit, which is what
      // keeps "exactly one current revision" true for everything the app writes.
      if (actualCurrent) {
        tx.update(revisionRef(actualCurrent), {
          status:                 REVISION_STATUS.SUPERSEDED,
          supersededAt:           serverTimestamp(),
          supersededBy:           user.uid,
          supersededByRevisionId: revisionId,
          updatedAt:              serverTimestamp(),
          updatedBy:              user.uid,
        })
      }

      tx.update(master, {
        currentRevisionId:         revisionId,
        currentRevisionCode:       code,
        currentRevisionIssuedDate: revisionDate,
        revisionCount:             revisionSequence,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
    })

    return revisionId
  }, [companyId, projectId, drawingId, user, drawingRef, revisionRef])

  // Withdraws one revision. Nothing is ever hard-deleted.
  //
  // Withdrawing a NON-CURRENT revision touches only that revision.
  //
  // Withdrawing the CURRENT revision forces an explicit decision, taken by the
  // user and passed in here — never inferred:
  //   · reinstateRevisionId set  → that earlier revision becomes current again
  //     and the master's pointer moves to it
  //   · reinstateRevisionId null → the master itself becomes WITHDRAWN with no
  //     current revision
  //
  // There is no automatic promotion of "the next one down". Which revision the
  // site should build from is a decision, not an ordering.
  const withdrawRevision = useCallback(async ({
    revision, withdrawReason, reinstateRevisionId = null, expectedCurrentRevisionId = null,
  }) => {
    if (!companyId || !projectId || !drawingId || !user) throw new Error('Not authenticated')
    if (revision.status === REVISION_STATUS.WITHDRAWN) {
      throw new Error('This revision has already been withdrawn')
    }

    const reasonError = validateWithdrawReason(withdrawReason)
    if (reasonError) throw new Error(reasonError)
    if (reinstateRevisionId === revision.id) {
      throw new Error('A withdrawn revision cannot be reinstated')
    }

    const reason = String(withdrawReason).trim()
    const master = drawingRef()

    await runTransaction(db, async (tx) => {
      // ── Reads first (Firestore requires every read before any write) ───────
      const masterSnap = await tx.get(master)
      if (!masterSnap.exists()) throw new Error('This drawing no longer exists.')
      const data = masterSnap.data()

      const actualCurrent = data.currentRevisionId ?? null
      if (actualCurrent !== (expectedCurrentRevisionId ?? null)) {
        throw new Error(CONCURRENT_REVISION_MESSAGE)
      }

      const withdrawingCurrent = actualCurrent === revision.id

      let reinstate = null
      if (withdrawingCurrent && reinstateRevisionId) {
        const reinstateSnap = await tx.get(revisionRef(reinstateRevisionId))
        if (!reinstateSnap.exists()) throw new Error('The revision to reinstate no longer exists.')
        reinstate = { id: reinstateSnap.id, ...reinstateSnap.data() }
        if (reinstate.status !== REVISION_STATUS.SUPERSEDED) {
          throw new Error('Only a superseded revision can be reinstated.')
        }
      }

      // ── Writes ────────────────────────────────────────────────────────────
      tx.update(revisionRef(revision.id), {
        status:         REVISION_STATUS.WITHDRAWN,
        withdrawnAt:    serverTimestamp(),
        withdrawnBy:    user.uid,
        withdrawReason: reason,
        updatedAt:      serverTimestamp(),
        updatedBy:      user.uid,
      })

      if (!withdrawingCurrent) return

      if (reinstate) {
        tx.update(revisionRef(reinstate.id), {
          status:                 REVISION_STATUS.CURRENT,
          supersededAt:           null,
          supersededBy:           null,
          supersededByRevisionId: null,
          updatedAt:              serverTimestamp(),
          updatedBy:              user.uid,
        })
        tx.update(master, {
          currentRevisionId:         reinstate.id,
          currentRevisionCode:       reinstate.revisionCode,
          currentRevisionIssuedDate: reinstate.revisionDate,
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
        })
        return
      }

      // No replacement nominated — the drawing itself is withdrawn and left
      // with no current revision. Terminal.
      tx.update(master, {
        status:                    DRAWING_STATUS.WITHDRAWN,
        currentRevisionId:         null,
        currentRevisionCode:       '',
        currentRevisionIssuedDate: null,
        withdrawnAt:               serverTimestamp(),
        withdrawnBy:               user.uid,
        withdrawReason:            reason,
        updatedAt:                 serverTimestamp(),
        updatedBy:                 user.uid,
      })
    })
  }, [companyId, projectId, drawingId, user, drawingRef, revisionRef])

  return {
    revisions,
    revisionsLoading,
    revisionsError,
    newRevisionTarget,
    commitRevision,
    withdrawRevision,
  }
}
