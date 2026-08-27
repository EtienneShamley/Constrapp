import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import {
  RFI_STATUS, RFI_STATUS_LABELS, RFI_STATUS_BADGE,
  RFI_GROUP, RFI_GROUP_ORDER, RFI_GROUP_LABELS, RFI_GROUP_HINTS,
  groupRfis, formatIsoDate, dueLabel, isOverdue, referenceLabel, hasReference,
  canEditQuestion, canEditManagement, canRaise, canAnswer, canClose, canCancel,
} from '../../../lib/rfis'

// ── RFI cards — the MOBILE register ──────────────────────────────────────────
//
// Grouped by the derived horizon (Overdue → Due this week → Open → Awaiting
// close → Draft → Closed/Cancelled). Empty groups are omitted; the closed
// group renders last but is never hidden.
//
// Every tap target is at least 44px and nothing is hover-only.

export default function RfiCards({ rfis, canWrite, onView, onEdit, onRaise, onAnswer, onCloseRfi, onCancel, now }) {
  const groups = groupRfis(rfis, now)

  return (
    <div className="space-y-5">
      {RFI_GROUP_ORDER.map((key) => {
        const list = groups[key]
        if (list.length === 0) return null
        return (
          <section key={key}>
            <h3 className={`text-[12px] font-bold uppercase tracking-[0.5px] m-0 mb-1 ${key === RFI_GROUP.OVERDUE ? 'text-brand-red' : 'text-brand-muted'}`}>
              {RFI_GROUP_LABELS[key]} · {list.length}
            </h3>
            <p className="m-0 mb-2 text-[10.5px] text-brand-muted">{RFI_GROUP_HINTS[key]}</p>

            <div className="space-y-2">
              {list.map((r) => {
                const late = isOverdue(r, now)
                const terminal = r.status === RFI_STATUS.CLOSED || r.status === RFI_STATUS.CANCELLED
                return (
                  <div
                    key={r.id}
                    className={`border rounded-xl p-3.5 bg-brand-surface ${late ? 'border-brand-red/40' : 'border-brand-border'} ${r.status === RFI_STATUS.CANCELLED ? 'opacity-55' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="m-0 text-[13px] font-bold text-brand-text">
                        <span className="text-brand-accent tabular-nums mr-1.5">{r.rfiNumber}</span>
                        {r.title}
                      </p>
                      <Badge sm label={RFI_STATUS_LABELS[r.status] ?? r.status} variant={RFI_STATUS_BADGE[r.status] ?? 'info'} />
                    </div>

                    <p className={`m-0 mt-1.5 text-[12px] font-semibold ${late ? 'text-brand-red' : 'text-brand-text-soft'}`}>
                      {/* Text, never colour alone. */}
                      {late && 'Overdue · '}{dueLabel(r, now)}
                    </p>

                    <p className="m-0 mt-1 text-[11.5px] text-brand-muted">
                      Raised {formatIsoDate(r.raisedDate)}{r.dueDate ? ` · due ${formatIsoDate(r.dueDate)}` : ''}
                    </p>
                    <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
                      {r.assignedToName || 'Not assigned'}
                      {hasReference(r) ? ` · ${referenceLabel(r)}` : ''}
                    </p>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Btn variant="ghost" className="flex-1" onClick={() => onView(r)}>View</Btn>
                      {canWrite && !terminal && (
                        <>
                          {(canEditQuestion(r.status) || canEditManagement(r.status)) && (
                            <Btn variant="ghost" className="flex-1" onClick={() => onEdit(r)}>Edit</Btn>
                          )}
                          {canRaise(r.status) && <Btn className="flex-1" onClick={() => onRaise(r)}>Raise</Btn>}
                          {canAnswer(r.status) && <Btn className="flex-1" onClick={() => onAnswer(r)}>Answer</Btn>}
                          {canClose(r.status) && <Btn className="flex-1" onClick={() => onCloseRfi(r)}>Close</Btn>}
                          {canCancel(r.status) && <Btn variant="ghost" className="flex-1" onClick={() => onCancel(r)}>Cancel</Btn>}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
