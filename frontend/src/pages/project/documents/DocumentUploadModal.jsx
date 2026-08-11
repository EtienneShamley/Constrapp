import { useState } from 'react'
import Btn from '../../../components/Btn'
import ProgBar from '../../../components/ProgBar'
import { inputCls, labelCls, modalShellCls, modalCardCls } from './styles'
import { useStorageUpload } from '../../../hooks/useStorageUpload'
import {
  DOCUMENT_CATEGORIES, DOCUMENT_VISIBILITY, DEFAULT_DOCUMENT_VISIBILITY,
  formatDocumentCategory, validateDocumentDraft,
} from '../../../lib/projectDocuments'
import {
  DOCUMENT_MAX_BYTES, FILE_INPUT_ACCEPT, ALLOWED_FILE_LABEL,
  formatFileSize, validateFile,
} from '../../../lib/files'

// Uploads a general project document.
//
// Same two-phase order as a drawing revision — STORAGE FIRST, FIRESTORE SECOND —
// so no register row can ever point at bytes that never arrived. Nothing is
// shown optimistically, and a retry uploads afresh under a new document ID
// because stored objects can never be overwritten.
//
// `replaces` turns this into a REPLACEMENT: the new record and the supersession
// of the old one commit in one transaction. There is no revision subcollection
// for general documents — both files are simply preserved.
export default function DocumentUploadModal({
  replaces, newDocumentTarget, createDocument, onClose,
}) {
  const { upload, cancel, progress, uploading } = useStorageUpload()

  const [name, setName]                 = useState(replaces?.name ?? '')
  const [category, setCategory]         = useState(replaces?.category ?? 'specification')
  const [visibility, setVisibility]     = useState(replaces?.visibility ?? DEFAULT_DOCUMENT_VISIBILITY)
  const [versionLabel, setVersionLabel] = useState('')
  const [documentDate, setDocumentDate] = useState('')
  const [notes, setNotes]               = useState('')
  const [file, setFile]                 = useState(null)
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState(null)

  const fileError = file ? validateFile(file, DOCUMENT_MAX_BYTES) : null
  const busy = uploading || saving

  function chooseFile(e) {
    setFile(e.target.files?.[0] ?? null)
    setError(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()

    const draftError = validateDocumentDraft({ name, category, visibility, documentDate })
    if (draftError) { setError(draftError); return }
    if (!file) { setError('Choose a file to upload'); return }
    const invalid = validateFile(file, DOCUMENT_MAX_BYTES)
    if (invalid) { setError(invalid); return }

    setError(null)

    let target
    try {
      target = newDocumentTarget(file.type)
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
      await createDocument({
        documentId:  target.documentId,
        storagePath: target.storagePath,
        name, category, visibility, versionLabel, documentDate, notes, file,
        replacesDocumentId: replaces?.id ?? null,
      })
      onClose()
    } catch (err) {
      setSaving(false)
      setError(err.message || 'Could not save this document. Try again.')
    }
  }

  return (
    <div className={modalShellCls}>
      <div className="absolute inset-0 bg-black/60" onClick={busy ? undefined : onClose} />
      <div className={`${modalCardCls} max-w-[540px]`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-brand-text m-0">
              {replaces ? 'Replace Document' : 'Upload Document'}
            </h2>
            {replaces && (
              <p className="text-[12px] text-brand-muted mt-0.5 mb-0 break-words">
                Supersedes {replaces.name}
              </p>
            )}
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
          <div>
            <label className={labelCls}>Name <span className="text-brand-red">*</span></label>
            <input
              className={inputCls}
              placeholder="e.g. Structural Specification"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={busy}
              required
              autoFocus
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Category <span className="text-brand-red">*</span></label>
              <select className={inputCls} value={category} onChange={e => setCategory(e.target.value)} disabled={busy}>
                {DOCUMENT_CATEGORIES.map(c => (
                  <option key={c} value={c}>{formatDocumentCategory(c)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Visibility <span className="text-brand-red">*</span></label>
              <select className={inputCls} value={visibility} onChange={e => setVisibility(e.target.value)} disabled={busy}>
                <option value={DOCUMENT_VISIBILITY.PROJECT}>Project — everyone in the company</option>
                <option value={DOCUMENT_VISIBILITY.INTERNAL}>Internal — office roles only</option>
              </select>
            </div>
          </div>

          {visibility === DOCUMENT_VISIBILITY.INTERNAL && (
            <p className="text-[12px] text-brand-amber m-0">
              Internal — subcontractor and client users will not see this document.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Version</label>
              <input
                className={inputCls}
                placeholder="e.g. Rev 2 / Issue C"
                value={versionLabel}
                onChange={e => setVersionLabel(e.target.value)}
                disabled={busy}
              />
            </div>
            <div>
              <label className={labelCls}>Document Date</label>
              <input
                type="date"
                className={inputCls}
                value={documentDate}
                onChange={e => setDocumentDate(e.target.value)}
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
              {ALLOWED_FILE_LABEL} · maximum {formatFileSize(DOCUMENT_MAX_BYTES)}
              {file && ` · selected ${file.name} (${formatFileSize(file.size)})`}
            </p>
            {fileError && <p className="text-[12px] text-brand-red mt-1 mb-0">{fileError}</p>}
          </div>

          <div>
            <label className={labelCls}>Notes</label>
            <textarea
              className={inputCls}
              rows={2}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={busy}
            />
          </div>

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

          {saving && <p className="text-[12px] text-brand-muted m-0">File uploaded. Recording the document…</p>}

          {error && (
            <div className="rounded-lg border border-brand-red/40 bg-brand-red/10 px-3 py-2">
              <p className="text-[12px] text-brand-red m-0">{error}</p>
              {!busy && (
                <p className="text-[11px] text-brand-muted mt-1 mb-0">
                  Trying again uploads the file afresh — an uploaded file can never be replaced in place.
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={busy}>
              {error ? 'Close' : 'Cancel'}
            </Btn>
            <Btn type="submit" sm disabled={busy || Boolean(fileError)}>
              {uploading ? 'Uploading…' : saving ? 'Saving…' : error ? 'Try Again' : replaces ? 'Replace Document' : 'Upload Document'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
