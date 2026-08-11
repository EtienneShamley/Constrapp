import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, where,
  runTransaction, setDoc, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { useProfile } from './useProfile'
import {
  DOCUMENT_STATUS, DOCUMENT_VISIBILITY,
  canReadInternalDocuments, canTransitionDocument,
  validateDocumentDraft, validateWithdrawReason, sortDocuments,
} from '../lib/projectDocuments'
import { documentStoragePath, storageExtension, originalFileName } from '../lib/files'

// ── General project documents ────────────────────────────────────────────────
//
// The flat register: specifications, contracts, certificates, safety documents,
// programmes, manuals, correspondence. No folders, no revision subcollection —
// a replacement is a NEW record and the old one is superseded with a forward
// link, so both files are preserved.
//
// ⚠️ THE VISIBILITY FILTER IS A QUERY REQUIREMENT, NOT A SECURITY CONTROL.
// Firestore rules are not filters: they are evaluated against every document a
// query returns, and one `internal` document in the result set fails the WHOLE
// query. A subcontractor or client therefore MUST subscribe with
// `where('visibility','==','project')` — without it they would see not "the
// project documents" but an error. The rules are what actually protect internal
// documents; this filter is what makes the allowed query answerable.
//
// Ordering is applied client-side (lib/projectDocuments.js → sortDocuments).
// Combining the equality filter with a server-side `orderBy` on a different
// field would demand a composite index; sorting here keeps one ordering for both
// audiences and needs no index at all.
export function useProjectDocuments(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { profile } = useProfile()

  const companyId = company?.id ?? null
  const seesInternal = canReadInternalDocuments(profile?.role)

  const [snap, setSnap] = useState({ key: null, documents: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}/${seesInternal}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'documents')
    const q = seesInternal
      ? query(ref)
      : query(ref, where('visibility', '==', DOCUMENT_VISIBILITY.PROJECT))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        documents: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // "Documents are unavailable" — never "no documents". A failed
      // subscription and an empty register are opposite facts.
      () => setSnap({ key, documents: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId, seesInternal])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}/${seesInternal}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const documents = settled ? sortDocuments(snap.documents) : []
  const documentsLoading = targetKey !== null && !settled
  const documentsError = settled ? snap.error : false

  // Phase 1 — mint the identity and derive the immutable storage path, before
  // any bytes move. The user's filename never enters the path.
  const newDocumentTarget = useCallback((contentType) => {
    if (!companyId || !projectId) throw new Error('Not authenticated')

    const ref = doc(collection(db, 'companies', companyId, 'projects', projectId, 'documents'))
    const storagePath = documentStoragePath(companyId, projectId, ref.id, contentType)
    if (!storagePath) throw new Error('Unsupported file type')

    return { documentId: ref.id, storagePath }
  }, [companyId, projectId])

  // Phase 3 — the Firestore record, written only after the bytes are stored.
  //
  // When `replacesDocumentId` is supplied the new record and the supersession of
  // the old one commit in ONE transaction, so the register can never show two
  // active copies of the same document (or an orphaned "superseded by nothing").
  const createDocument = useCallback(async ({
    documentId, storagePath,
    name, category, visibility, versionLabel, documentDate, notes,
    file, replacesDocumentId = null,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateDocumentDraft({ name, category, visibility, documentDate })
    if (validationError) throw new Error(validationError)

    const contentType = file?.type
    const fileExt = storageExtension(contentType)
    if (!fileExt) throw new Error('Unsupported file type')

    // Recomputed rather than trusted — rules reject any other path.
    const expectedPath = documentStoragePath(companyId, projectId, documentId, contentType)
    if (!expectedPath || expectedPath !== storagePath) {
      throw new Error('This upload could not be verified. Try again.')
    }

    const col = collection(db, 'companies', companyId, 'projects', projectId, 'documents')
    const ref = doc(col, documentId)

    const payload = {
      name:         String(name).trim(),
      category,
      visibility,
      versionLabel: String(versionLabel ?? '').trim(),
      documentDate: documentDate || null,

      status:                 DOCUMENT_STATUS.ACTIVE,
      supersededByDocumentId: null,

      notes: String(notes ?? '').trim(),

      // File identity — IMMUTABLE from here. The original filename is metadata;
      // `storagePath` is the identity.
      fileName:  originalFileName(file),
      fileExt,
      fileSize:  file.size,
      contentType,
      storagePath,

      withdrawnAt:    null,
      withdrawnBy:    null,
      withdrawReason: '',

      revision: 1,

      createdAt: serverTimestamp(),
      createdBy: user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    }

    if (!replacesDocumentId) {
      await setDoc(ref, payload)
      return ref.id
    }

    const replacedRef = doc(col, replacesDocumentId)
    await runTransaction(db, async (tx) => {
      const replacedSnap = await tx.get(replacedRef)
      if (!replacedSnap.exists()) throw new Error('The document being replaced no longer exists.')
      if (!canTransitionDocument(replacedSnap.data().status, DOCUMENT_STATUS.SUPERSEDED)) {
        throw new Error('That document can no longer be superseded.')
      }

      tx.set(ref, payload)
      // The old file is PRESERVED — only its status and its forward link move.
      tx.update(replacedRef, {
        status:                 DOCUMENT_STATUS.SUPERSEDED,
        supersededByDocumentId: ref.id,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
    })
    return ref.id
  }, [companyId, projectId, user])

  // Metadata edits only. The file is never re-pointed: replacing the FILE means
  // uploading a new document record.
  const updateDocument = useCallback(async (document, {
    name, category, visibility, versionLabel, documentDate, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (document.status !== DOCUMENT_STATUS.ACTIVE) {
      throw new Error('Only an active document can be edited')
    }

    const validationError = validateDocumentDraft({ name, category, visibility, documentDate })
    if (validationError) throw new Error(validationError)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'documents', document.id)
    await updateDoc(ref, {
      name:         String(name).trim(),
      category,
      visibility,
      versionLabel: String(versionLabel ?? '').trim(),
      documentDate: documentDate || null,
      notes:        String(notes ?? '').trim(),
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  // Withdrawal is terminal and requires a real reason. Nothing is hard-deleted:
  // the record and its file both remain, marked as not to be used.
  const withdrawDocument = useCallback(async (document, withdrawReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransitionDocument(document.status, DOCUMENT_STATUS.WITHDRAWN)) {
      throw new Error(`Cannot withdraw a ${document.status} document`)
    }

    const reasonError = validateWithdrawReason(withdrawReason)
    if (reasonError) throw new Error(reasonError)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'documents', document.id)
    await updateDoc(ref, {
      status:         DOCUMENT_STATUS.WITHDRAWN,
      withdrawnAt:    serverTimestamp(),
      withdrawnBy:    user.uid,
      withdrawReason: String(withdrawReason).trim(),
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  return {
    documents,
    documentsLoading,
    documentsError,
    seesInternalDocuments: seesInternal,
    newDocumentTarget,
    createDocument,
    updateDocument,
    withdrawDocument,
  }
}
