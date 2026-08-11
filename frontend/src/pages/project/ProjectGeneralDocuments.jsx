import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { useProfile } from '../../hooks/useProfile'
import { useProjectDocuments } from '../../hooks/useProjectDocuments'
import { getFileUrl } from '../../hooks/useStorageUpload'
import {
  DOCUMENT_CATEGORIES, DOCUMENT_STATUS,
  canWriteDocuments, filterDocuments,
  formatDocumentCategory, formatDocumentStatus, formatDocumentVisibility,
  isInternalDocument,
} from '../../lib/projectDocuments'
import { formatFileSize } from '../../lib/files'
import DocumentUploadModal from './documents/DocumentUploadModal'
import DocumentWithdrawModal from './documents/DocumentWithdrawModal'
import { inputCls, thCls } from './documents/styles'

// The GENERAL DOCUMENTS register — specifications, contracts, certificates,
// safety documents, programmes, manuals, correspondence.
//
// ⚠️ INTERNAL IS SHOWN IN WORDS AND WITH A LOCK GLYPH, never by colour alone.
// Whether a subcontractor can see a document is exactly the kind of fact that
// must survive a greyscale print and a colour-blind reader.
//
// A REPLACEMENT IS A NEW RECORD. There is no revision subcollection here: the
// old record becomes `superseded` with a forward link and both files are kept.
export default function ProjectGeneralDocuments() {
  const { projectId } = useOutletContext()
  const { profile }   = useProfile()

  const {
    documents, documentsLoading, documentsError, seesInternalDocuments,
    newDocumentTarget, createDocument, withdrawDocument,
  } = useProjectDocuments(projectId)

  const [search, setSearch]                     = useState('')
  const [category, setCategory]                 = useState('')
  const [includeWithdrawn, setIncludeWithdrawn] = useState(false)
  const [showUpload, setShowUpload]             = useState(false)
  const [replaces, setReplaces]                 = useState(null)
  const [withdrawTarget, setWithdrawTarget]     = useState(null)
  const [openError, setOpenError]               = useState(null)

  const canWrite = canWriteDocuments(profile?.role)
  const rows = filterDocuments(documents, { search, category, includeWithdrawn })

  // The tab is opened SYNCHRONOUSLY inside the click, then pointed at the URL
  // once it resolves — a popup opened after an await is blocked by most
  // browsers. `opener` is cleared so the new tab cannot reach back into the app.
  //
  // The URL itself is minted here and thrown away; it is never persisted.
  async function openFile(document) {
    setOpenError(null)
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    try {
      const url = await getFileUrl(document.storagePath)
      if (tab) tab.location.href = url
      else window.location.assign(url)
    } catch (err) {
      tab?.close()
      setOpenError(err.message)
    }
  }

  function startReplace(document) {
    setReplaces(document)
    setShowUpload(true)
  }

  function closeUpload() {
    setShowUpload(false)
    setReplaces(null)
  }

  const visibilityCell = (d) => (
    <span className="inline-flex items-center gap-1 text-[12px]">
      {isInternalDocument(d) && <span aria-hidden="true">🔒</span>}
      <span className={isInternalDocument(d) ? 'text-brand-amber font-bold' : 'text-brand-muted'}>
        {formatDocumentVisibility(d.visibility)}
      </span>
    </span>
  )

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          Project document register — contracts, specifications, certificates and correspondence.
        </p>
        {canWrite && <Btn sm onClick={() => setShowUpload(true)}>+ Upload Document</Btn>}
      </div>

      {!seesInternalDocuments && (
        <p className="text-[12px] text-brand-muted mb-3">
          You are seeing documents shared with the project. Internal documents are not listed.
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-2.5 mb-3.5">
        <input
          className={`${inputCls} sm:max-w-[280px]`}
          placeholder="Search name, version or notes…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className={`${inputCls} sm:max-w-[200px]`}
          value={category}
          onChange={e => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {DOCUMENT_CATEGORIES.map(c => (
            <option key={c} value={c}>{formatDocumentCategory(c)}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 min-h-[44px] text-[12.5px] text-brand-muted cursor-pointer">
          <input
            type="checkbox"
            checked={includeWithdrawn}
            onChange={e => setIncludeWithdrawn(e.target.checked)}
          />
          Show withdrawn
        </label>
      </div>

      {openError && <p className="text-[12px] text-brand-red mb-2">{openError}</p>}

      <Card padding={false}>
        {documentsError ? (
          // ⚠️ NOT "no documents" — a failed subscription and an empty register
          // are opposite facts.
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-red m-0">Documents are unavailable.</p>
            <p className="text-[12px] text-brand-muted mt-1 mb-0">
              We could not load this project's documents. Check your connection and refresh.
            </p>
          </div>
        ) : documentsLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading documents…</div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {documents.length === 0
                ? 'No documents yet.'
                : 'No documents match these filters.'}
            </p>
            {canWrite && documents.length === 0 && (
              <Btn onClick={() => setShowUpload(true)}>+ Upload your first document</Btn>
            )}
          </div>
        ) : (
          <>
            {/* Desktop / tablet register */}
            <table className="w-full border-collapse hidden md:table">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['Name', 'Category', 'Visibility', 'Version', 'Date', 'File', 'Status', ''].map((h, i) => (
                    <th key={h || i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(d => (
                  <tr key={d.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text max-w-[260px] break-words">
                      {d.name}
                      {d.notes && <span className="block text-[11px] text-brand-muted font-normal mt-0.5">{d.notes}</span>}
                    </td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted">{formatDocumentCategory(d.category)}</td>
                    <td className="px-3.5 py-3">{visibilityCell(d)}</td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted">{d.versionLabel || '—'}</td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{d.documentDate || '—'}</td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">
                      {d.fileExt?.toUpperCase()} · {formatFileSize(d.fileSize)}
                    </td>
                    <td className="px-3.5 py-3">
                      <Badge
                        label={formatDocumentStatus(d.status)}
                        variant={d.status === DOCUMENT_STATUS.ACTIVE ? 'active' : d.status === DOCUMENT_STATUS.WITHDRAWN ? 'danger' : 'soon'}
                        sm
                      />
                    </td>
                    <td className="px-3.5 py-3">
                      <div className="flex justify-end gap-2">
                        <Btn variant="ghost" sm onClick={() => openFile(d)}>Open</Btn>
                        {canWrite && d.status === DOCUMENT_STATUS.ACTIVE && (
                          <>
                            <Btn variant="ghost" sm onClick={() => startReplace(d)}>Replace</Btn>
                            <Btn variant="ghost" sm onClick={() => setWithdrawTarget(d)}>Withdraw</Btn>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile cards */}
            <div className="md:hidden flex flex-col">
              {rows.map(d => (
                <div key={d.id} className="px-4 py-4 border-b border-brand-border">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[15px] font-bold text-brand-text m-0 break-words">{d.name}</p>
                      <p className="text-[12px] text-brand-muted mt-1 mb-0">
                        {formatDocumentCategory(d.category)}
                        {d.versionLabel ? ` · ${d.versionLabel}` : ''}
                        {d.documentDate ? ` · ${d.documentDate}` : ''}
                      </p>
                      <p className="text-[12px] text-brand-muted mt-0.5 mb-0">
                        {d.fileExt?.toUpperCase()} · {formatFileSize(d.fileSize)}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <Badge
                        label={formatDocumentStatus(d.status)}
                        variant={d.status === DOCUMENT_STATUS.ACTIVE ? 'active' : d.status === DOCUMENT_STATUS.WITHDRAWN ? 'danger' : 'soon'}
                        sm
                      />
                      {visibilityCell(d)}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 mt-2.5">
                    <Btn variant="ghost" sm onClick={() => openFile(d)}>Open</Btn>
                    {canWrite && d.status === DOCUMENT_STATUS.ACTIVE && (
                      <>
                        <Btn variant="ghost" sm onClick={() => startReplace(d)}>Replace</Btn>
                        <Btn variant="ghost" sm onClick={() => setWithdrawTarget(d)}>Withdraw</Btn>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {showUpload && (
        <DocumentUploadModal
          replaces={replaces}
          newDocumentTarget={newDocumentTarget}
          createDocument={createDocument}
          onClose={closeUpload}
        />
      )}

      {withdrawTarget && (
        <DocumentWithdrawModal
          title="Withdraw Document"
          subtitle={withdrawTarget.name}
          onClose={() => setWithdrawTarget(null)}
          onWithdraw={(reason) => withdrawDocument(withdrawTarget, reason)}
        />
      )}
    </div>
  )
}
