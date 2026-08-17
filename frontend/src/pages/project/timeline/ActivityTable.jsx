import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import ProgBar from '../../../components/ProgBar'
import {
  ACTIVITY_STATUS, ACTIVITY_STATUS_LABELS, ACTIVITY_STATUS_BADGE,
  formatIsoDate, durationLabel, dueLabel, isOverdue, isClosedStatus,
} from '../../../lib/projectTimeline'

// ── Activity table — THE RECORD ──────────────────────────────────────────────
//
// The exact, complete programme record and the accessible equivalent of the
// Gantt above it (the ADR-26 chart/table contract, reused): the chart is never
// the only path to the data, and every figure is read here rather than measured
// off a bar.
//
// Desktop/tablet only — the mobile layout uses grouped cards instead
// (ActivityCards.jsx). Wide content scrolls inside its own container, the
// established pattern across every table in the app.

const thCls = 'px-3 py-2.5 text-left text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] whitespace-nowrap'
const tdCls = 'px-3 py-2.5 text-[12px] text-brand-text align-top'

export default function ActivityTable({ activities, canWrite, onEdit, onCancel, now }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1080px] border-collapse">
        <thead>
          <tr className="bg-brand-card">
            <th className={thCls}>Activity</th>
            <th className={thCls}>Responsible</th>
            <th className={thCls}>Cost code</th>
            <th className={thCls}>Planned start</th>
            <th className={thCls}>Planned finish</th>
            <th className={thCls}>Duration</th>
            <th className={thCls}>Status</th>
            <th className={`${thCls} text-right`}>Progress</th>
            <th className={thCls}>Actual start</th>
            <th className={thCls}>Actual finish</th>
            {canWrite && <th className={thCls}></th>}
          </tr>
        </thead>
        <tbody>
          {activities.map((a) => {
            const late   = isOverdue(a, now)
            const closed = isClosedStatus(a.status)
            return (
              <tr
                key={a.id}
                className={`border-b border-brand-border hover:bg-brand-card ${a.status === ACTIVITY_STATUS.CANCELLED ? 'opacity-55' : ''}`}
              >
                <td className={tdCls}>
                  <span className="font-semibold text-brand-text">
                    {a.isMilestone && <span aria-hidden="true" className="mr-1.5">◆</span>}
                    {a.name}
                  </span>
                  {a.isMilestone && <span className="ml-1.5 text-[10px] font-bold text-brand-purple uppercase">Milestone</span>}
                  {a.description && <span className="block text-[10.5px] text-brand-muted mt-0.5">{a.description}</span>}
                  {a.status === ACTIVITY_STATUS.CANCELLED && a.cancelReason && (
                    <span className="block text-[10.5px] text-brand-muted mt-0.5">Cancelled — {a.cancelReason}</span>
                  )}
                  {a.status === ACTIVITY_STATUS.ON_HOLD && a.notes && (
                    <span className="block text-[10.5px] text-brand-amber mt-0.5">On hold — {a.notes}</span>
                  )}
                </td>
                <td className={`${tdCls} whitespace-nowrap`}>
                  {a.responsibleName || <span className="text-brand-muted">—</span>}
                </td>
                <td className={`${tdCls} whitespace-nowrap`}>
                  {a.costCodeName || <span className="text-brand-muted">—</span>}
                </td>
                <td className={`${tdCls} whitespace-nowrap tabular-nums`}>{formatIsoDate(a.plannedStart)}</td>
                <td className={`${tdCls} whitespace-nowrap tabular-nums`}>
                  {formatIsoDate(a.plannedFinish)}
                  {/* Overdue is never colour-only: the word is always present. */}
                  {late && (
                    <span className="block text-[10.5px] font-bold text-brand-red">
                      Overdue · {dueLabel(a, now)}
                    </span>
                  )}
                </td>
                <td className={`${tdCls} whitespace-nowrap`}>{durationLabel(a)}</td>
                <td className={`${tdCls} whitespace-nowrap`}>
                  <Badge
                    sm
                    label={ACTIVITY_STATUS_LABELS[a.status] ?? a.status}
                    variant={ACTIVITY_STATUS_BADGE[a.status] ?? 'info'}
                  />
                </td>
                <td className={`${tdCls} text-right`}>
                  <span className="tabular-nums font-semibold">{a.percentComplete ?? 0}%</span>
                  <span className="block mt-1 w-[70px] ml-auto">
                    <ProgBar
                      value={a.percentComplete ?? 0}
                      colour={late ? 'brand-red' : closed ? 'brand-accent' : 'brand-blue'}
                    />
                  </span>
                </td>
                <td className={`${tdCls} whitespace-nowrap tabular-nums`}>{formatIsoDate(a.actualStart)}</td>
                <td className={`${tdCls} whitespace-nowrap tabular-nums`}>{formatIsoDate(a.actualFinish)}</td>
                {canWrite && (
                  <td className="px-3 py-2.5 text-right whitespace-nowrap align-top">
                    {a.status === ACTIVITY_STATUS.CANCELLED ? (
                      <span className="text-[11px] text-brand-muted">Cancelled</span>
                    ) : (
                      <>
                        <Btn sm variant="ghost" onClick={() => onEdit(a)}>Edit</Btn>{' '}
                        <Btn sm variant="ghost" onClick={() => onCancel(a)}>Cancel</Btn>
                      </>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
