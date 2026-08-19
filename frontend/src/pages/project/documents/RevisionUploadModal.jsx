import { useState } from 'react'
import Btn from '../../../components/Btn'
import ProgBar from '../../../components/ProgBar'
import { inputCls, labelCls, modalShellCls, modalCardCls } from './styles'
import { useStorageUpload } from '../../../hooks/useStorageUpload'
import {
  CONCURRENT_REVISION_MESSAGE,
  findDuplicateRevisionCode, normaliseRevisionCode, validateRevisionDraft,
} from '../../../lib/drawings'
import {
  DRAWING_MAX_BYTES, FILE_INPUT_ACCEPT, ALLOWED_FILE_LABEL,
  formatFileSize, validateFile,
} from '../../../lib/files'
// The app keeps exactly ONE timezone-sensitive clock (ADR-25) — reused here for
// the default issue date rather than introducing a second `new Date()`.
import { todayIso } from '../../../lib/payments'

// Issues a new revision of a drawing.
//
// THE ORDER IS STORAGE FIRST, FIRESTORE SECOND, and this modal is where the user
// sees it happen:
//
//   1. mint the revision ID and its immutable storage path
//   2. upload the bytes (progress, cancel)
//   3. ONE Firestore transaction promotes the revision and supersedes the
//      previous current one
//
// Nothing appears in the register until step 3 commits — there is no optimistic
// row. If step 3 fails, the uploaded bytes are ORPHANED and stay that way:
// objects are create-only in Storage Rules, and a delete permission that could
// tidy them up could also destroy an issued revision.
//
// RETRY MINTS A NEW REVISION ID, because the previous path can never be written
// twice. That is stated to the user rather than hidden.
export default function RevisionUploadModal({
  drawing, revisions, newRevisionTarget, commitRevision, onClose,
}) {
  const { upload, cancel, progress, uploading } = useStorageUpload()

  const [revisionCode, setRevisionCode] = useState('')
  const [revisionDate, setRevisionDate] = useState(todayIso())
  const [notes, setNotes]               = useState('')
  const [file, setFile]                 = useState(null)
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState(null)

  // The pointer this user was looking at when they opened the modal. The
  // transaction compares it against the stored pointer and ABORTS if another
  // user issued a revision in the meantime.
  const [expectedCurrentRevisionId] = useState(drawing?.currentRevisionId ?? null)

  const fileError  = file ? validateFile(file, DRAWING_MAX_BYTES) : null
  const duplicate  = findDuplicateRevisionCode(revisions, revisionCode)
  const busy       = uploading || saving
  const concurrent = error === CONCURRENT_REVISION_MESSAGE

  function chooseFile(e) {
    setFile(e.target.files?.[0] ?? null)
    setError(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()

    const draftError = validateRevisionDraft({ revisionCode, revisionDate })
    if (draftError) { setError(draftError); return }
    if (!file) { setError('Choose a file to upload'); return }
    const invalid = validateFile(file, DRAWING_MAX_BYTES)
    if (invalid) { setError(invalid); return }

    setError(null)

    let target
    try {
      // A FRESH revision ID on every attempt — a retry can never overwrite the
      // path a failed attempt already claimed.
      target = newRevisionTarget(file.type)
    } catch (err) {
      setError(err.message || 'Could not prepare this upload')
      return
    }

    try {
      await upload({ path: target.storagePath, file, contentType: file.type })
    } catch (err) {
      setError(err.message)
      return
    }

    setSaving(true)
    try {
      await commitRevision({
        revisionId:   target.revisionId,
        storagePath:  target.storagePath,
        expectedCurrentRevisionId,
        revisionCode, revisionDate, notes, file,
      })
      onClose()
    } catch (err) {
      setSaving(false)
      setError(err.message || 'Could not save this revision. Try again.')
    }
  }

  return (
    <div className={modalShellCls}>
      <div className="absolute inset-0 bg-black/60" onClick={busy ? undefined : onClose} />
      <div className={`${modalCardCls} max-w-[520px]`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <div>
            <h2 className="text-[15px] font-bold text-brand-text m-0">Upload New Revision</h2>
            <p className="text-[12px] text-brand-muted mt-0.5 mb-0">
              {drawing.drawingNumber} · {drawing.title}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            disabled={busy}
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center disabled:opacity-40"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Revision <span className="text-brand-red">*</span></label>
              <input
                className={inputCls}
                placeholder="e.g. B"
                value={revisionCode}
                onChange={e => setRevisionCode(e.target.value)}
                disabled={busy}
                required
                autoFocus
              />
              <p className="text-[11px] text-brand-muted mt-1">
                Stored as {normaliseRevisionCode(revisionCode) || '—'}
              </p>
            </div>
            <div>
              <label className={labelCls}>Revision Date <span className="text-brand-red">*</span></label>
              <input
                type="date"
                className={inputCls}
                value={revisionDate}
                onChange={e => setRevisionDate(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>

          <div>
            <label className={labelCls}>File <span className="text-brand-red">*</span></label>
            <input
              type="file"
              className={`${inputCls} file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-[12px] file:font-bold file:bg-brand-card file:text-brand-text`}
              accept={FILE_INPUT_ACCEPT}
              onChange={chooseFile}
              disabled={busy}
            />
            <p className="text-[11px] text-brand-muted mt-1">
              {ALLOWED_FILE_LABEL} · maximum {formatFileSize(DRAWING_MAX_BYTES)}
              {file && ` · selected ${file.name} (${formatFileSize(file.size)})`}
            </p>
            {fileError && <p className="text-[12px] text-brand-red mt-1 mb-0">{fileError}</p>}
          </div>

          <div>
            <label className={labelCls}>Revision Notes</label>
            <textarea
              className={inputCls}
              rows={2}
              placeholder="What changed in this revision?"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={busy}
            />
          </div>

          {duplicate && (
            <p className="text-[12px] text-brand-amber m-0">
              ⚠ Revision {duplicate.revisionCode} already exists on this drawing. Revision codes are
              not checked for uniqueness — continue only if this is intentional.
            </p>
          )}

          {uploading && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[12px] text-brand-muted">
                <span>Uploading… {progress}%</span>
                <button
                  type="button"
                  onClick={cancel}
                  className="text-brand-red font-bold cursor-pointer min-h-[44px] px-2"
                >
                  Cancel upload
                </button>
              </div>
              <ProgBar value={progress} />
            </div>
          )}

          {saving && (
            <p className="text-[12px] text-brand-muted m-0">
              File uploaded. Recording the revision…
            </p>
          )}

          {error && (
            <div className={`rounded-lg border px-3 py-2 ${concurrent
              ? 'border-brand-amber/40 bg-brand-amber/10'
              : 'border-brand-red/40 bg-brand-red/10'}`}
            >
              <p className={`text-[12px] m-0 ${concurrent ? 'text-brand-amber' : 'text-brand-red'}`}>
                {error}
              </p>
              {concurrent && (
                <p className="text-[11px] text-brand-muted mt-1 mb-0">
                  Nothing was promoted. Close this dialog, review the drawing's current revision, then
                  issue again if it is still required.
                </p>
              )}
              {!concurrent && !busy && (
                <p className="text-[11px] text-brand-muted mt-1 mb-0">
                  Trying again uploads the file afresh under a new revision ID — an uploaded file can
                  never be replaced in place.
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={busy}>
              {error ? 'Close' : 'Cancel'}
            </Btn>
            <Btn type="submit" sm disabled={busy || Boolean(fileError) || concurrent}>
              {uploading ? 'Uploading…' : saving ? 'Saving…' : error ? 'Try Again' : 'Issue Revision'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
