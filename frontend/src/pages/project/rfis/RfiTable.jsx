import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import {
  RFI_STATUS, RFI_STATUS_LABELS, RFI_STATUS_BADGE,
  formatIsoDate, dueLabel, isOverdue, referenceLabel, hasReference,
  canEditQuestion, canEditManagement, canRaise, canAnswer, canClose, canCancel,
} from '../../../lib/rfis'

// ── RFI register table — THE RECORD ──────────────────────────────────────────
//
// Desktop/tablet only — the mobile layout uses grouped cards instead
// (RfiCards.jsx). Wide content scrolls inside its own container, the
// established pattern across every table in the app.

const thCls = 'px-3 py-2.5 text-left text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] whitespace-nowrap'
const tdCls = 'px-3 py-2.5 text-[12px] text-brand-text align-top'

export default function RfiTable({ rfis, canWrite, onView, onEdit, onRaise, onAnswer, onCloseRfi, onCancel, now }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] border-collapse">
        <thead>
          <tr className="bg-brand-card">
            <th className={thCls}>RFI #</th>
            <th className={thCls}>Title</th>
            <th className={thCls}>Assigned to</th>
            <th className={thCls}>Raised</th>
            <th className={thCls}>Due</th>
            <th className={thCls}>Status</th>
            <th className={thCls}>Reference</th>
            <th className={thCls}></th>
          </tr>
        </thead>
        <tbody>
          {rfis.map((r) => {
            const late = isOverdue(r, now)
            const terminal = r.status === RFI_STATUS.CLOSED || r.status === RFI_STATUS.CANCELLED
            return (
              <tr
                key={r.id}
                className={`border-b border-brand-border hover:bg-brand-card ${r.status === RFI_STATUS.CANCELLED ? 'opacity-55' : ''}`}
              >
                <td className={`${tdCls} whitespace-nowrap font-semibold tabular-nums`}>
                  <button type="button" className="text-brand-accent hover:underline cursor-pointer min-h-[32px]" onClick={() => onView(r)}>
                    {r.rfiNumber}
                  </button>
                </td>
                <td className={tdCls}>
                  <span className="font-semibold text-brand-text">{r.title}</span>
                  {r.raisedByName && <span className="block text-[10.5px] text-brand-muted mt-0.5">Raised by {r.raisedByName}</span>}
                </td>
                <td className={`${tdCls} whitespace-nowrap`}>
                  {r.assignedToName || <span className="text-brand-muted">—</span>}
                </td>
                <td className={`${tdCls} whitespace-nowrap tabular-nums`}>{formatIsoDate(r.raisedDate)}</td>
                <td className={`${tdCls} whitespace-nowrap tabular-nums`}>
                  {formatIsoDate(r.dueDate)}
                  {/* Overdue is never colour-only: the word is always present. */}
                  {late && (
                    <span className="block text-[10.5px] font-bold text-brand-red">Overdue · {dueLabel(r, now)}</span>
                  )}
                </td>
                <td className={`${tdCls} whitespace-nowrap`}>
                  <Badge sm label={RFI_STATUS_LABELS[r.status] ?? r.status} variant={RFI_STATUS_BADGE[r.status] ?? 'info'} />
                </td>
                <td className={tdCls}>
                  {hasReference(r) ? referenceLabel(r) : <span className="text-brand-muted">—</span>}
                </td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap align-top">
                  <Btn sm variant="ghost" onClick={() => onView(r)}>View</Btn>
                  {canWrite && !terminal && (
                    <>
                      {' '}
                      {(canEditQuestion(r.status) || canEditManagement(r.status)) && (
                        <Btn sm variant="ghost" onClick={() => onEdit(r)}>Edit</Btn>
                      )}
                      {' '}
                      {canRaise(r.status) && <Btn sm onClick={() => onRaise(r)}>Raise</Btn>}
                      {canAnswer(r.status) && <Btn sm onClick={() => onAnswer(r)}>Answer</Btn>}
                      {canClose(r.status) && <Btn sm onClick={() => onCloseRfi(r)}>Close</Btn>}
                      {canCancel(r.status) && <>{' '}<Btn sm variant="ghost" onClick={() => onCancel(r)}>Cancel</Btn></>}
                    </>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
