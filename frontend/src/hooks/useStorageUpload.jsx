import { useCallback, useRef, useState } from 'react'
import { ref as storageRef, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { storage } from '../lib/firebase'
import { uploadErrorMessage } from '../lib/files'

// ── Firebase Storage uploads ─────────────────────────────────────────────────
//
// The single place the app writes file bytes. Every caller uploads to a
// DETERMINISTIC path built by lib/files.js — never a user-supplied name.
//
// UPLOAD ORDER IS STORAGE FIRST, FIRESTORE SECOND, and this hook is the first
// half. It resolves only after the bytes are genuinely stored, so a caller can
// never write a visible register row pointing at a file that never arrived. The
// cost is accepted and documented: if the Firestore write then fails, the object
// is ORPHANED. An orphan is strictly better than a register entry that lies, and
// cleaning it up would need a delete permission that would also let a client
// destroy an issued drawing revision — so there is no delete, and orphans stay.
//
// Objects are CREATE-ONLY in Storage Rules: uploading again to the same path is
// an overwrite and is denied. A retry therefore has to mint a NEW document ID
// and a new path — which is exactly what the upload modals do.
export function useStorageUpload() {
  const [progress, setProgress]   = useState(0)
  const [uploading, setUploading] = useState(false)
  const [error, setError]         = useState(null)

  // The in-flight resumable task, so the user can cancel a large drawing.
  const taskRef = useRef(null)

  // Uploads one file and resolves with its storage path. Rejects with a human
  // message (never a raw Firebase code).
  const upload = useCallback(({ path, file, contentType }) => {
    if (!path) return Promise.reject(new Error('Upload path could not be built'))

    setUploading(true)
    setProgress(0)
    setError(null)

    return new Promise((resolve, reject) => {
      const task = uploadBytesResumable(storageRef(storage, path), file, { contentType })
      taskRef.current = task

      task.on(
        'state_changed',
        (snap) => {
          const pct = snap.totalBytes > 0
            ? Math.round((snap.bytesTransferred / snap.totalBytes) * 100)
            : 0
          setProgress(pct)
        },
        (err) => {
          taskRef.current = null
          setUploading(false)
          const message = uploadErrorMessage(err)
          setError(message)
          reject(new Error(message))
        },
        () => {
          taskRef.current = null
          setUploading(false)
          setProgress(100)
          resolve(path)
        },
      )
    })
  }, [])

  // Cancels the in-flight upload. The task's error callback then rejects the
  // pending promise with 'Upload cancelled.'
  const cancel = useCallback(() => {
    taskRef.current?.cancel()
  }, [])

  const reset = useCallback(() => {
    taskRef.current = null
    setProgress(0)
    setUploading(false)
    setError(null)
  }, [])

  return { upload, cancel, reset, progress, uploading, error }
}

// Mints a short-lived, on-demand download URL for a stored object.
//
// ⚠️ THE RESULT IS NEVER PERSISTED. A Firebase download URL carries a bearer
// token: anyone holding the link can fetch the bytes without signing in, and
// writing one into Firestore would turn a rules-protected drawing into a public
// link the moment that document is read. URLs are generated only when a user
// actually asks to open or download a file, and are thrown away afterwards.
//
// Throws a human message on failure (typically a rules rejection).
export async function getFileUrl(storagePath) {
  if (!storagePath) throw new Error('This file is not available')
  try {
    return await getDownloadURL(storageRef(storage, storagePath))
  } catch (err) {
    if (err?.code === 'storage/object-not-found') {
      throw new Error('The file for this record is missing from storage.', { cause: err })
    }
    if (err?.code === 'storage/unauthorized') {
      throw new Error('You do not have permission to open this file.', { cause: err })
    }
    throw new Error('Could not open this file. Check your connection and try again.', { cause: err })
  }
}
