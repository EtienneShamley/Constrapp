import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import { thCls } from './styles'
import { formatRevisionStatus, isWithdrawnRevision, sortRevisions } from '../../../lib/drawings'
import { formatFileSize } from '../../../lib/files'

const statusVariant = (status) =>
  status === 'current' ? 'active' : status === 'withdrawn' ? 'danger' : 'soon'

// The full issue history of one drawing — every revision ever created, none of
// which can be deleted.
//
// ⚠️ ORDERED BY `revisionSequence`, NEVER BY `revisionCode`. Real revision codes
// ("A", "B", "P1", "C2", "10") do not sort lexically into issue order, and a
// history in the wrong order is a history that misleads.
export default function RevisionHistoryTable({
  revisions, selectedId, onSelect, canWrite, onWithdraw,
}) {
  const rows = sortRevisions(revisions)

  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-[13px] text-brand-muted">
        No revisions issued yet.
      </div>
    )
  }

  return (
    <>
      {/* Desktop / tablet register */}
      <table className="w-full border-collapse hidden md:table">
        <thead>
          <tr className="bg-brand-card border-b border-brand-border">
            {['Rev', 'Issued', 'Status', 'File', 'Size', 'Notes', ''].map((h, i) => (
              <th key={h || i} className={thCls}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr
              key={r.id}
              className={`border-b border-brand-border transition-colors ${r.id === selectedId ? 'bg-brand-card' : 'hover:bg-brand-card'}`}
            >
              <td className="px-3.5 py-3 text-[13px] font-bold text-brand-text">{r.revisionCode}</td>
              <td className="px-3.5 py-3 text-[12px] text-brand-muted">{r.revisionDate}</td>
              <td className="px-3.5 py-3">
                <Badge label={formatRevisionStatus(r.status)} variant={statusVariant(r.status)} sm />
              </td>
              <td className="px-3.5 py-3 text-[12px] text-brand-muted break-all max-w-[220px]">{r.fileName}</td>
              <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{formatFileSize(r.fileSize)}</td>
              <td className="px-3.5 py-3 text-[12px] text-brand-muted max-w-[240px]">{r.notes || '—'}</td>
              <td className="px-3.5 py-3">
                <div className="flex justify-end gap-2">
                  <Btn variant="ghost" sm onClick={() => onSelect(r.id)}>View</Btn>
                  {canWrite && !isWithdrawnRevision(r) && (
                    <Btn variant="ghost" sm onClick={() => onWithdraw(r)}>Withdraw</Btn>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Mobile cards — the table is not squeezed, it is replaced. */}
      <div className="md:hidden flex flex-col">
        {rows.map(r => (
          <div
            key={r.id}
            className={`px-4 py-3.5 border-b border-brand-border ${r.id === selectedId ? 'bg-brand-card' : ''}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[15px] font-bold text-brand-text m-0">Revision {r.revisionCode}</p>
                <p className="text-[12px] text-brand-muted mt-0.5 mb-0">
                  Issued {r.revisionDate} · {formatFileSize(r.fileSize)}
                </p>
              </div>
              <Badge label={formatRevisionStatus(r.status)} variant={statusVariant(r.status)} sm />
            </div>

            {r.notes && <p className="text-[12px] text-brand-muted mt-1.5 mb-0">{r.notes}</p>}

            <div className="flex gap-2 mt-2.5">
              <Btn variant="ghost" sm onClick={() => onSelect(r.id)}>View</Btn>
              {canWrite && !isWithdrawnRevision(r) && (
                <Btn variant="ghost" sm onClick={() => onWithdraw(r)}>Withdraw</Btn>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
