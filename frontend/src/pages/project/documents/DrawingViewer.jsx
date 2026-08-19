import { useEffect, useState } from 'react'
import Badge from '../../../components/Badge'
import { linkPrimaryCls, linkGhostCls } from './styles'
import { getFileUrl } from '../../../hooks/useStorageUpload'
import { formatRevisionStatus, revisionWarning } from '../../../lib/drawings'
import { formatFileSize, isImageContentType, isPdfContentType } from '../../../lib/files'

// Renders ONE drawing revision: its safety status, its metadata, and the ways to
// actually look at it.
//
// ⚠️ STATUS IS COMMUNICATED IN WORDS, NEVER BY COLOUR ALONE. A superseded or
// withdrawn revision carries a non-dismissible banner that spells out what it is
// and what to do about it. Colour only reinforces text that already says it, so
// the warning survives greyscale printing and colour-blind readers.
//
// ⚠️ DOWNLOAD URLS ARE FETCHED ON DEMAND AND NEVER STORED. A Firebase download
// URL is a bearer link; persisting one in Firestore would turn a rules-protected
// drawing into a public link. It is minted here when the user opens a revision
// and discarded with the component.
//
// PDFs are NOT given a bespoke viewer. `Open` hands the file to the browser's
// own PDF viewer, which is better than anything this app would ship, and an
// inline <iframe> preview appears only where there is room for it.
export default function DrawingViewer({ drawing, revision }) {
  // Key-tagged so a revision switch shows nothing stale, without writing state
  // synchronously inside the effect.
  const [state, setState] = useState({ key: null, url: null, error: null })

  const storagePath = revision?.storagePath ?? null

  useEffect(() => {
    if (!storagePath) return undefined

    let cancelled = false
    getFileUrl(storagePath).then(
      (url)  => { if (!cancelled) setState({ key: storagePath, url, error: null }) },
      (err)  => { if (!cancelled) setState({ key: storagePath, url: null, error: err.message }) },
    )
    return () => { cancelled = true }
  }, [storagePath])

  if (!revision) {
    return (
      <div className="px-5 py-10 text-center text-[13px] text-brand-muted">
        This drawing has no current revision.
      </div>
    )
  }

  const settled = state.key === storagePath
  const url     = settled ? state.url : null
  const urlError = settled ? state.error : null
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

      <div className="flex flex-wrap gap-2">
        {url ? (
          <>
            <a className={linkPrimaryCls} href={url} target="_blank" rel="noopener noreferrer">
              Open
            </a>
            <a className={linkGhostCls} href={url} download={revision.fileName}>
              Download
            </a>
          </>
        ) : urlError ? (
          <p className="text-[12px] text-brand-red m-0">{urlError}</p>
        ) : (
          <p className="text-[12px] text-brand-muted m-0">Preparing file…</p>
        )}
      </div>

      {url && isImageContentType(revision.contentType) && (
        <img
          src={url}
          alt={`${drawing?.drawingNumber ?? 'Drawing'} revision ${revision.revisionCode}`}
          className="max-w-full h-auto rounded-lg border border-brand-border bg-white"
        />
      )}

      {url && isPdfContentType(revision.contentType) && (
        // Preview only where there is room — on phones the browser's own viewer,
        // reached through `Open`, is far better than a squeezed iframe.
        <div className="hidden md:block">
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
