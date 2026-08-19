import { useState } from 'react'
import { Link, useOutletContext, useParams } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { useProfile } from '../../hooks/useProfile'
import { useDrawing, useDrawings } from '../../hooks/useDrawings'
import { useDrawingRevisions } from '../../hooks/useDrawingRevisions'
import {
  canWriteDrawings, currentRevision, formatDiscipline, isWithdrawnDrawing,
} from '../../lib/drawings'
import DrawingViewer from './documents/DrawingViewer'
import RevisionHistoryTable from './documents/RevisionHistoryTable'
import RevisionUploadModal from './documents/RevisionUploadModal'
import RevisionWithdrawModal from './documents/RevisionWithdrawModal'
import DrawingEditorModal from './documents/DrawingEditorModal'
import DocumentWithdrawModal from './documents/DocumentWithdrawModal'

// ONE DRAWING, as a ROUTE rather than a modal.
//
// A drawing is a destination: it is linked to from a register, shared between
// people, opened on a phone on site, and bookmarked. A modal has no URL and
// cannot do any of that.
export default function ProjectDrawingDetail() {
  const { projectId } = useOutletContext()
  const { drawingId } = useParams()
  const { profile }   = useProfile()

  const { drawing, drawingLoading, drawingError } = useDrawing(projectId, drawingId)
  // The register list is loaded only for the duplicate-number warning in the
  // editor; every write below goes through the revisions hook.
  const { drawings, updateDrawing, withdrawDrawing } = useDrawings(projectId)
  const {
    revisions, revisionsLoading, revisionsError,
    newRevisionTarget, commitRevision, withdrawRevision,
  } = useDrawingRevisions(projectId, drawingId)

  const [selectedId, setSelectedId]           = useState(null)
  const [showUpload, setShowUpload]           = useState(false)
  const [showEditor, setShowEditor]           = useState(false)
  const [withdrawTarget, setWithdrawTarget]   = useState(null)
  const [showDrawingWithdraw, setShowDrawingWithdraw] = useState(false)

  const canWrite = canWriteDrawings(profile?.role)

  if (drawingError) {
    return (
      <Card>
        <p className="text-[13px] text-brand-red m-0">This drawing is unavailable.</p>
        <p className="text-[12px] text-brand-muted mt-1 mb-0">
          We could not load it. Check your connection and refresh.
        </p>
      </Card>
    )
  }
  if (drawingLoading) {
    return <div className="text-[13px] text-brand-muted">Loading drawing…</div>
  }
  if (!drawing) {
    return (
      <Card>
        <p className="text-[13px] text-brand-muted m-0">Drawing not found.</p>
        <Link to="../.." relative="path" className="text-[12px] font-bold text-brand-accent no-underline">
          ← Back to drawings
        </Link>
      </Card>
    )
  }

  // The revision on screen: whatever the user selected from the history, or the
  // drawing's authored current revision.
  const current  = currentRevision(drawing, revisions)
  const selected = revisions.find(r => r.id === selectedId) ?? current
  const withdrawn = isWithdrawnDrawing(drawing)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          to="../.."
          relative="path"
          className="text-[12px] font-bold text-brand-accent no-underline inline-flex items-center min-h-[44px]"
        >
          ← Drawings
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold text-brand-text m-0">{drawing.drawingNumber}</h1>
            {withdrawn
              ? <Badge label="Withdrawn" variant="danger" sm />
              : <Badge label={formatDiscipline(drawing.discipline)} variant="info" sm />}
          </div>
          <p className="text-[14px] text-brand-text mt-1 mb-0 break-words">{drawing.title}</p>
          {drawing.description && (
            <p className="text-[12.5px] text-brand-muted mt-1 mb-0">{drawing.description}</p>
          )}
        </div>

        {canWrite && !withdrawn && (
          <div className="flex flex-wrap gap-2 shrink-0">
            <Btn variant="ghost" sm onClick={() => setShowEditor(true)}>Edit</Btn>
            <Btn sm onClick={() => setShowUpload(true)}>+ New Revision</Btn>
            {!drawing.currentRevisionId && (
              <Btn variant="ghost" sm onClick={() => setShowDrawingWithdraw(true)}>Withdraw Drawing</Btn>
            )}
          </div>
        )}
      </div>

      {withdrawn && (
        <div role="alert" className="rounded-lg border-2 border-brand-red bg-brand-red/10 px-4 py-3">
          <p className="text-[13px] font-bold tracking-[0.5px] text-brand-red m-0">WITHDRAWN</p>
          <p className="text-[13px] font-semibold text-brand-text mt-1 mb-0">
            This drawing has been withdrawn and has no current revision. Do not use it.
          </p>
          {drawing.withdrawReason && (
            <p className="text-[12px] text-brand-muted mt-1 mb-0">Reason: {drawing.withdrawReason}</p>
          )}
        </div>
      )}

      <Card>
        {revisionsError ? (
          <p className="text-[13px] text-brand-red m-0">Revisions are unavailable.</p>
        ) : revisionsLoading ? (
          <p className="text-[13px] text-brand-muted m-0">Loading revisions…</p>
        ) : revisions.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              No revisions issued yet. This drawing has no file until the first revision is uploaded.
            </p>
            {canWrite && !withdrawn && (
              <Btn onClick={() => setShowUpload(true)}>+ Upload first revision</Btn>
            )}
          </div>
        ) : (
          <DrawingViewer drawing={drawing} revision={selected} />
        )}
      </Card>

      <div>
        <h2 className="text-[13px] font-bold text-brand-text mb-2">Revision History</h2>
        <Card padding={false}>
          {revisionsError ? (
            <div className="px-5 py-10 text-center text-[13px] text-brand-red">
              Revision history is unavailable.
            </div>
          ) : (
            <RevisionHistoryTable
              revisions={revisions}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
              canWrite={canWrite && !withdrawn}
              onWithdraw={setWithdrawTarget}
            />
          )}
        </Card>
      </div>

      {showUpload && (
        <RevisionUploadModal
          drawing={drawing}
          revisions={revisions}
          newRevisionTarget={newRevisionTarget}
          commitRevision={commitRevision}
          onClose={() => setShowUpload(false)}
        />
      )}

      {showEditor && (
        <DrawingEditorModal
          drawing={drawing}
          drawings={drawings}
          onClose={() => setShowEditor(false)}
          onSave={(values) => updateDrawing(drawing, values)}
        />
      )}

      {withdrawTarget && (
        <RevisionWithdrawModal
          drawing={drawing}
          revision={withdrawTarget}
          revisions={revisions}
          onClose={() => setWithdrawTarget(null)}
          onWithdraw={({ withdrawReason, reinstateRevisionId }) => withdrawRevision({
            revision: withdrawTarget,
            withdrawReason,
            reinstateRevisionId,
            expectedCurrentRevisionId: drawing.currentRevisionId ?? null,
          })}
        />
      )}

      {showDrawingWithdraw && (
        <DocumentWithdrawModal
          title={`Withdraw ${drawing.drawingNumber}`}
          subtitle={drawing.title}
          body="This drawing has no current revision. Withdrawing is permanent: it cannot be reactivated and can no longer receive revisions. Nothing is deleted."
          onClose={() => setShowDrawingWithdraw(false)}
          onWithdraw={(reason) => withdrawDrawing(drawing, reason)}
        />
      )}
    </div>
  )
}
