import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import { formatDate } from '../../../lib/formatters'
import {
  RFI_STATUS, RFI_STATUS_LABELS, RFI_STATUS_BADGE,
  formatIsoDate, dueLabel, isOverdue, responseDays, referenceLabel, hasReference,
  canEditQuestion, canEditManagement, canRaise, canAnswer, canClose, canCancel,
} from '../../../lib/rfis'
import { VARIATION_STATUS_LABELS, VARIATION_BADGE_VARIANTS } from '../../../lib/variations'
import RfiModalShell from './RfiModalShell'

// ── RFI detail — READ-ONLY ───────────────────────────────────────────────────
//
// The whole record on one screen, with the lifecycle actions the current
// status permits. Every figure here is derived at read time from the document
// (lib/rfis.js); nothing is stored.
//
// Stamps show WHO (uid → 'You' or 'Another user' — users/{uid} is client-read-
// only, ADR-27) and WHEN. `raisedByName` is the one human name on the record:
// a snapshot the creator took of their own profile.
//
// LINKED VARIATIONS are a read-time reverse view of each Variation's
// originRfiId (ADR-34) — the RFI document stores no variation reference. The
// caller passes the already-loaded project variations filtered by this RFI,
// plus whether that read failed, so an error is never shown as "None".

const rowLabel = 'text-[10.5px] font-bold text-brand-muted uppercase tracking-[0.4px] m-0 mb-0.5'
const rowValue = 'text-[12.5px] text-brand-text m-0'

function Row({ label, children }) {
  return (
    <div>
      <p className={rowLabel}>{label}</p>
      <p className={rowValue}>{children}</p>
    </div>
  )
}

export default function RfiDetailModal({
  rfi, now, currentUid, canWrite,
  linkedVariations = [], linkedVariationsUnavailable = false,
  onEdit, onRaise, onAnswer, onCloseRfi, onCancel, onClose,
}) {
  if (!rfi) return null
  const who = (uid) => (uid ? (uid === currentUid ? 'You' : 'Another user') : '—')
  const late = isOverdue(rfi, now)
  const response = responseDays(rfi)

  return (
    <RfiModalShell title={rfi.rfiNumber} onClose={onClose} wide>
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="m-0 text-[15px] font-bold text-brand-text">{rfi.title}</p>
            <p className={`m-0 mt-1 text-[12px] font-semibold ${late ? 'text-brand-red' : 'text-brand-text-soft'}`}>
              {late && 'Overdue · '}{dueLabel(rfi, now)}
            </p>
          </div>
          <Badge label={RFI_STATUS_LABELS[rfi.status] ?? rfi.status} variant={RFI_STATUS_BADGE[rfi.status] ?? 'info'} />
        </div>

        <div className="border border-brand-border rounded-lg p-3 mb-4">
          <p className={rowLabel}>Question</p>
          <p className="m-0 text-[12.5px] text-brand-text whitespace-pre-wrap">{rfi.question}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <Row label="Raised by">{rfi.raisedByName || '—'}</Row>
          <Row label="Raised date">{formatIsoDate(rfi.raisedDate)}</Row>
          <Row label="Assigned to">{rfi.assignedToName || <span className="text-brand-muted">Not assigned</span>}</Row>
          <Row label="Due date">{formatIsoDate(rfi.dueDate)}</Row>
          <Row label="Reference">
            {hasReference(rfi) ? referenceLabel(rfi) : <span className="text-brand-muted">None</span>}
          </Row>
          <Row label="Cost code">{rfi.costCodeName || <span className="text-brand-muted">None</span>}</Row>
        </div>

        {(rfi.status === RFI_STATUS.ANSWERED || rfi.status === RFI_STATUS.CLOSED) && (
          <div className="border border-brand-border rounded-lg p-3 mb-4">
            <p className={rowLabel}>Answer · received {formatIsoDate(rfi.answerDate)}{response !== null ? ` · ${response} day${response === 1 ? '' : 's'} to respond` : ''}</p>
            <p className="m-0 text-[12.5px] text-brand-text whitespace-pre-wrap">{rfi.answer}</p>
          </div>
        )}

        {rfi.status === RFI_STATUS.CLOSED && rfi.closeOutNote && (
          <div className="border border-brand-border rounded-lg p-3 mb-4">
            <p className={rowLabel}>Close-out note</p>
            <p className="m-0 text-[12.5px] text-brand-text whitespace-pre-wrap">{rfi.closeOutNote}</p>
          </div>
        )}

        {rfi.status === RFI_STATUS.CANCELLED && (
          <div className="border border-brand-border rounded-lg p-3 mb-4">
            <p className={rowLabel}>Cancelled</p>
            <p className="m-0 text-[12.5px] text-brand-text whitespace-pre-wrap">{rfi.cancelReason}</p>
          </div>
        )}

        {/* ── Linked variations (read-time, evidence only) ─────────── */}
        <div className="border border-brand-border rounded-lg p-3 mb-4">
          <p className={rowLabel}>Linked variations</p>
          {linkedVariationsUnavailable ? (
            <p className={`${rowValue} text-brand-muted`}>Unavailable</p>
          ) : linkedVariations.length === 0 ? (
            <p className={`${rowValue} text-brand-muted`}>None</p>
          ) : (
            <ul className="m-0 pl-0 list-none space-y-1">
              {linkedVariations.map(v => (
                <li key={v.id} className="flex flex-wrap items-center gap-2 text-[12.5px] text-brand-text">
                  <span className="font-semibold">{v.variationNumber}</span>
                  <span>— {v.title || '—'}</span>
                  <Badge label={VARIATION_STATUS_LABELS[v.status] ?? v.status} variant={VARIATION_BADGE_VARIANTS[v.status] ?? 'info'} sm />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Audit trail ──────────────────────────────────────────── */}
        <div className="border-t border-brand-border pt-3">
          <p className={rowLabel}>History</p>
          <ul className="m-0 pl-4 text-[11.5px] text-brand-muted space-y-0.5">
            <li>Created by {who(rfi.createdBy)} · {formatDate(rfi.createdAt)}</li>
            {rfi.raisedAt && <li>Raised by {who(rfi.raisedBy)} · {formatDate(rfi.raisedAt)}</li>}
            {rfi.answeredAt && <li>Answer recorded by {who(rfi.answeredBy)} · {formatDate(rfi.answeredAt)}</li>}
            {rfi.closedAt && <li>Closed by {who(rfi.closedBy)} · {formatDate(rfi.closedAt)}</li>}
            {rfi.cancelledAt && <li>Cancelled by {who(rfi.cancelledBy)} · {formatDate(rfi.cancelledAt)}</li>}
            <li>Last updated by {who(rfi.updatedBy)} · {formatDate(rfi.updatedAt)}</li>
          </ul>
        </div>

        {canWrite && (
          <div className="flex flex-wrap justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
            {(canEditQuestion(rfi.status) || canEditManagement(rfi.status)) && (
              <Btn variant="ghost" onClick={() => onEdit(rfi)}>{canEditQuestion(rfi.status) ? 'Edit draft' : 'Update assignee / due'}</Btn>
            )}
            {canCancel(rfi.status) && <Btn variant="ghost" onClick={() => onCancel(rfi)}>Cancel RFI</Btn>}
            {canRaise(rfi.status) && <Btn onClick={() => onRaise(rfi)}>Raise</Btn>}
            {canAnswer(rfi.status) && <Btn onClick={() => onAnswer(rfi)}>Record answer</Btn>}
            {canClose(rfi.status) && <Btn onClick={() => onCloseRfi(rfi)}>Close</Btn>}
          </div>
        )}
      </div>
    </RfiModalShell>
  )
}
