import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import ActivityDialog from './ActivityDialog'
import {
  ACTIVITY_STATUS, ACTIVITY_STATUS_LABELS, ACTIVITY_STATUS_BADGE,
  formatIsoDate, durationLabel, dueLabel, isOverdue,
} from '../../../lib/projectTimeline'
import { planComparisonLabel } from '../../../lib/timelineGantt'
import { stateFor, dependencyFlag, DEPENDENCY_STATE } from '../../../lib/ganttDependencies'

// ── Read-only activity detail (ADR-64, ADR-65) ───────────────────────────────
//
// What a bar on the Gantt opens for a reader who cannot author the programme
// (qs — the one role that reads the programme but does not write it, ADR-29),
// and for anyone on a CANCELLED activity, which is retained history and can
// no longer be edited. GENUINELY read-only: no form, no Save, no quick action,
// no write path of any kind — one Close button. Every figure is the stored
// record (the same values the activity table shows); the plan comparison is
// against the CURRENT plan, never an approved baseline.

const rowCls   = 'flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3 py-2 border-b border-brand-border/60'
const labelCls = 'shrink-0 w-full sm:w-[150px] text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px]'
const valueCls = 'text-[13px] text-brand-text'

function Row({ label, children }) {
  return (
    <div className={rowCls}>
      <span className={labelCls}>{label}</span>
      <span className={valueCls}>{children}</span>
    </div>
  )
}

export default function ActivityDetailModal({ activity, now, onClose, dependencyStates, successors = [] }) {
  const a = activity ?? {}
  const late = isOverdue(a, now)
  const comparison = planComparisonLabel(a)
  // ADR-65: the links as derived at read time — every one listed, whatever
  // the chart could draw. Text, never colour alone.
  const dep = stateFor(dependencyStates, a.id)
  const flag = dependencyFlag(dep)

  return (
    <ActivityDialog title="Activity" titleId="activity-detail-title" onClose={onClose} panelClassName="max-w-[560px]">
      <div className="p-5">
        <p className="m-0 text-[15px] font-bold text-brand-text">
          {a.isMilestone && <span aria-hidden="true" className="mr-1.5">◆</span>}
          {a.name}
          {a.isMilestone && <span className="ml-2 text-[10px] font-bold text-brand-purple uppercase">Milestone</span>}
        </p>
        {a.description && <p className="m-0 mt-1 text-[12px] text-brand-muted">{a.description}</p>}

        <div className="mt-4">
          <Row label="Status">
            <Badge sm label={ACTIVITY_STATUS_LABELS[a.status] ?? a.status} variant={ACTIVITY_STATUS_BADGE[a.status] ?? 'info'} />
            {late && <span className="ml-2 text-[11px] font-bold text-brand-red">Overdue · {dueLabel(a, now)}</span>}
          </Row>
          <Row label={a.isMilestone ? 'Milestone date' : 'Planned'}>
            {a.isMilestone
              ? formatIsoDate(a.plannedStart)
              : <>{formatIsoDate(a.plannedStart)} → {formatIsoDate(a.plannedFinish)} <span className="text-brand-muted">({durationLabel(a)}, calendar days)</span></>}
          </Row>
          <Row label="Actual">
            {a.actualStart || a.actualFinish
              ? <>{formatIsoDate(a.actualStart)} → {formatIsoDate(a.actualFinish)}</>
              : <span className="text-brand-muted">No actual dates recorded</span>}
          </Row>
          {comparison && (
            <Row label="Against current plan">
              {comparison}
              <span className="block text-[10.5px] text-brand-muted">A comparison with the planned dates as they stand now — Constrapp stores no baseline.</span>
            </Row>
          )}
          <Row label="Progress">
            <span className="tabular-nums font-semibold">{a.percentComplete ?? 0}%</span>
            <span className="ml-2 text-[10.5px] text-brand-muted">Entered by hand, unverified</span>
          </Row>
          <Row label="Responsible">{a.responsibleName || <span className="text-brand-muted">Not assigned</span>}</Row>
          <Row label="Cost code">{a.costCodeName || <span className="text-brand-muted">None</span>}</Row>
          <Row label="Predecessors">
            {dep.count === 0 ? (
              <span className="text-brand-muted">None</span>
            ) : (
              <>
                {flag && (
                  <span className={`block text-[11px] font-bold ${flag === 'Review' ? 'text-brand-amber' : 'text-brand-red'}`}>
                    {flag === 'Blocked' ? 'Blocked — a predecessor is not finished or needs review'
                      : flag === 'Conflict' ? 'Starts before a predecessor allows'
                        : 'A dependency requires review'}
                  </span>
                )}
                <ul className="m-0 mt-0.5 pl-4 space-y-0.5">
                  {dep.entries.map((e, i) => (
                    <li key={`${e.activityId}-${i}`} className={e.state === DEPENDENCY_STATE.VALID ? '' : e.state === DEPENDENCY_STATE.CONFLICT ? 'text-brand-red' : 'text-brand-amber'}>
                      {e.name || e.activityId || 'Malformed entry'}
                      <span className="text-brand-muted"> · finish to start{e.lagDays > 0 ? ` +${e.lagDays} ${e.lagDays === 1 ? 'day' : 'days'}` : ''}</span>
                      {e.earliestStart && <span className="text-brand-muted"> · earliest start {formatIsoDate(e.earliestStart)}</span>}
                      {e.state !== DEPENDENCY_STATE.VALID && <span> · {e.stateLabel}</span>}
                      {e.state === DEPENDENCY_STATE.VALID && e.finished && <span className="text-brand-muted"> · finished</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Row>
          <Row label="Successors">
            {successors.length === 0 ? (
              <span className="text-brand-muted">None depend on this activity</span>
            ) : (
              <ul className="m-0 pl-4 space-y-0.5">
                {successors.map(s => <li key={s.id}>{s.name}</li>)}
              </ul>
            )}
          </Row>
          {a.notes && <Row label="Notes">{a.notes}</Row>}
          {a.status === ACTIVITY_STATUS.CANCELLED && (
            <Row label="Cancelled">{a.cancelReason || '—'}</Row>
          )}
        </div>

        <p className="m-0 mt-4 text-[11px] text-brand-muted">
          {a.status === ACTIVITY_STATUS.CANCELLED
            ? 'A cancelled activity is retained programme history and cannot be edited.'
            : 'Read-only. Company admins and project managers author the programme.'}
        </p>

        <div className="flex justify-end mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose}>Close</Btn>
        </div>
      </div>
    </ActivityDialog>
  )
}
