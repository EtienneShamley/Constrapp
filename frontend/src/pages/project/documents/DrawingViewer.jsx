import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import { getFileBlob } from '../../../hooks/useStorageUpload'
import { formatRevisionStatus, revisionWarning } from '../../../lib/drawings'
import {
  DRAWING_MAX_BYTES, downloadTimeoutMs, formatFileSize, isImageContentType, isPdfContentType,
} from '../../../lib/files'
import {
  createObjectUrl, typedBlob, openStoredFile, downloadStoredFile, openOutcomeNotice,
} from '../../../lib/fileBlob'

// Whether the viewport has room for the inline PDF preview (Tailwind `md`).
// Subscribed, not sampled once, so rotating a tablet behaves.
const WIDE_QUERY = '(min-width: 768px)'
const subscribeWide = (onChange) => {
  const mq = window.matchMedia?.(WIDE_QUERY)
  if (!mq) return () => {}
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
const isWide = () => window.matchMedia?.(WIDE_QUERY)?.matches === true

// Renders ONE drawing revision: its safety status, its metadata, and the ways to
// actually look at it.
//
// ⚠️ STATUS IS COMMUNICATED IN WORDS, NEVER BY COLOUR ALONE. A superseded or
// withdrawn revision carries a non-dismissible banner that spells out what it is
// and what to do about it. Colour only reinforces text that already says it, so
// the warning survives greyscale printing and colour-blind readers.
//
// ⚠️ THE FILE IS READ THROUGH THE AUTHENTICATED SDK, NEVER A DOWNLOAD URL
// (DC46-A, ADR-73). `getFileBlob` is a rules-checked read on every call; the
// bytes are shown from `blob:` URLs, which are not shareable bearer links.
//   · the INLINE preview's URL is owned here and revoked when the revision
//     changes or the viewer unmounts;
//   · Open and Download each get their OWN URL from lib/fileBlob.js, which
//     outlives this component on purpose (an opened tab must survive the app
//     navigating away from the drawing).
//
// WHAT IS FETCHED WHEN. An image is fetched at once — it is the content. A PDF
// is fetched at once only where the inline preview is actually shown (md and
// up); on a phone nothing is downloaded until the user taps Open or Download,
// so a 50 MB sheet is never pulled over a site connection for a hidden preview.
// The bytes are fetched ONCE per revision and reused by preview, Open and
// Download; they are dropped when the revision changes.
//
// PDFs are NOT given a bespoke viewer. `Open` hands the file to the browser's
// own PDF viewer, which is better than anything this app would ship.
export default function DrawingViewer({ drawing, revision }) {
  // Key-tagged so a revision switch shows nothing stale, without writing state
  // synchronously inside the effect.
  const [preview, setPreview] = useState({ key: null, url: null, error: null })
  const [action, setAction]   = useState({ key: null, busy: null, error: null, notice: null })

  const storagePath = revision?.storagePath ?? null
  const contentType = revision?.contentType ?? null
  const fileName    = revision?.fileName ?? ''
  const fileSize    = revision?.fileSize ?? null
  const isImage = isImageContentType(contentType)
  const isPdf   = isPdfContentType(contentType)

  const wide  = useSyncExternalStore(subscribeWide, isWide, () => false)
  const eager = !!storagePath && (isImage || (isPdf && wide))

  // One in-flight or settled fetch per revision. A failure is forgotten so the
  // next attempt really retries.
  const fetchRef   = useRef({ key: null, promise: null })
  const previewRef = useRef(null)

  const loadBlob = useCallback(() => {
    const cached = fetchRef.current
    if (cached.key === storagePath && cached.promise) return cached.promise
    const promise = getFileBlob(storagePath, { maxBytes: DRAWING_MAX_BYTES, timeoutMs: downloadTimeoutMs(fileSize) })
    fetchRef.current = { key: storagePath, promise }
    promise.catch(() => {
      if (fetchRef.current.promise === promise) fetchRef.current = { key: null, promise: null }
    })
    return promise
  }, [storagePath, fileSize])

  // The revision's lifetime: when it changes (or the viewer unmounts) the
  // preview URL is revoked and the cached bytes are released.
  useEffect(() => () => {
    previewRef.current?.revoke()
    previewRef.current = null
    fetchRef.current = { key: null, promise: null }
  }, [storagePath])

  // The inline preview — only where it is shown. Once made, the URL is kept
  // for the life of the revision (narrowing the window does not revoke it).
  useEffect(() => {
    if (!eager || previewRef.current) return undefined
    let cancelled = false
    loadBlob()
      .then((blob) => {
        if (cancelled || previewRef.current) return
        const handle = createObjectUrl(typedBlob(blob, contentType))
        previewRef.current = handle
        setPreview({ key: storagePath, url: handle.url, error: null })
      })
      .catch((err) => {
        if (!cancelled) setPreview({ key: storagePath, url: null, error: err?.message || 'Could not open this file.' })
      })
    return () => { cancelled = true }
  }, [eager, storagePath, contentType, loadBlob])

  // Open / Download. The handler runs inside the click, so the new tab (or the
  // save) is not treated as a popup; the bytes are usually already here.
  async function run(kind) {
    const key = storagePath
    setAction({ key, busy: kind, error: null, notice: null })
    try {
      const args = { fetchBlob: loadBlob, contentType, fileName }
      const outcome = kind === 'open' ? await openStoredFile(args) : await downloadStoredFile(args)
      setAction({ key, busy: null, error: null, notice: kind === 'open' ? openOutcomeNotice(outcome) : null })
    } catch (err) {
      setAction({ key, busy: null, error: err?.message || 'Could not open this file.', notice: null })
    }
  }

  if (!revision) {
    return (
      <div className="px-5 py-10 text-center text-[13px] text-brand-muted">
        This drawing has no current revision.
      </div>
    )
  }

  const previewSettled = preview.key === storagePath
  const url          = previewSettled ? preview.url : null
  const previewError = previewSettled ? preview.error : null
  const acting = action.key === storagePath ? action : { busy: null, error: null, notice: null }
  const warning = revisionWarning(revision, drawing)

  return (
    <div className="flex flex-col gap-4">
      {warning && (
        <div
          role="alert"
          className={`rounded-lg border-2 px-4 py-3 ${warning.tone === 'withdrawn'
            ? 'border-brand-red bg-brand-red/10'
            : 'border-brand-amber bg-brand-amber/10'}`}
        >
          <p className={`text-[13px] font-bold tracking-[0.5px] m-0 ${warning.tone === 'withdrawn'
            ? 'text-brand-red'
            : 'text-brand-amber'}`}
          >
            {warning.title}
          </p>
          <p className="text-[13px] font-semibold text-brand-text mt-1 mb-0">{warning.body}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[15px] font-bold text-brand-text">
          Revision {revision.revisionCode}
        </span>
        <Badge
          label={formatRevisionStatus(revision.status)}
          variant={revision.status === 'current' ? 'active' : revision.status === 'withdrawn' ? 'danger' : 'soon'}
          sm
        />
        <span className="text-[12px] text-brand-muted">Issued {revision.revisionDate}</span>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 m-0">
        {[
          ['File',      revision.fileName],
          ['Size',      formatFileSize(revision.fileSize)],
          ['Type',      revision.fileExt ? revision.fileExt.toUpperCase() : '—'],
          ['Sequence',  `#${revision.revisionSequence}`],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] m-0">{label}</dt>
            <dd className="text-[13px] text-brand-text m-0 mt-0.5 break-words">{value || '—'}</dd>
          </div>
        ))}
      </dl>

      {revision.notes && (
        <p className="text-[13px] text-brand-text m-0">
          <span className="text-brand-muted">Notes: </span>{revision.notes}
        </p>
      )}

      {revision.status === 'withdrawn' && revision.withdrawReason && (
        <p className="text-[13px] text-brand-text m-0">
          <span className="text-brand-muted">Withdrawn because: </span>{revision.withdrawReason}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Btn onClick={() => run('open')} disabled={acting.busy !== null}>
          {acting.busy === 'open' ? 'Opening…' : 'Open'}
        </Btn>
        <Btn variant="ghost" onClick={() => run('download')} disabled={acting.busy !== null}>
          {acting.busy === 'download' ? 'Downloading…' : 'Download'}
        </Btn>
        {acting.busy && fileSize > 0 && (
          <span className="text-[12px] text-brand-muted" role="status">
            Fetching {formatFileSize(fileSize)} — large drawings can take a moment.
          </span>
        )}
      </div>
      {acting.error && <p className="text-[12px] text-brand-red m-0" role="alert">{acting.error}</p>}
      {acting.notice && <p className="text-[12px] text-brand-muted m-0" role="status">{acting.notice}</p>}

      {eager && !url && (
        previewError
          ? <p className="text-[12px] text-brand-red m-0" role="alert">{previewError}</p>
          : <p className="text-[12px] text-brand-muted m-0" role="status">Loading preview…</p>
      )}

      {url && isImage && (
        <img
          src={url}
          alt={`${drawing?.drawingNumber ?? 'Drawing'} revision ${revision.revisionCode}`}
          className="max-w-full h-auto rounded-lg border border-brand-border bg-white"
        />
      )}

      {url && isPdf && wide && (
        // Preview only where there is room — on phones the browser's own viewer,
        // reached through `Open`, is far better than a squeezed iframe, and the
        // file is not fetched until it is asked for.
        <div>
          <iframe
            src={url}
            title={`${drawing?.drawingNumber ?? 'Drawing'} revision ${revision.revisionCode}`}
            className="w-full h-[70vh] rounded-lg border border-brand-border bg-white"
          />
          <p className="text-[11px] text-brand-muted mt-1.5 mb-0">
            Preview only — use Open for the full viewer, search and printing.
          </p>
        </div>
      )}
    </div>
  )
}
