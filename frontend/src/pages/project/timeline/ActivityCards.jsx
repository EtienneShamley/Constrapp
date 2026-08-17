import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import ProgBar from '../../../components/ProgBar'
import {
  ACTIVITY_STATUS, ACTIVITY_STATUS_LABELS, ACTIVITY_STATUS_BADGE,
  ACTIVITY_GROUP, ACTIVITY_GROUP_ORDER, ACTIVITY_GROUP_LABELS, ACTIVITY_GROUP_HINTS,
  groupActivities, formatIsoDate, durationLabel, dueLabel, isOverdue,
} from '../../../lib/projectTimeline'

// ── Activity cards — the MOBILE programme ────────────────────────────────────
//
// ⚠️ THE GANTT IS NOT RENDERED BELOW `md:`. A horizontal programme at a
// legible column width is unreadable on a 375px screen, and pinch-zoom is not
// an interaction model this app uses. What a site user actually needs on a
// phone is "what is on me, and what is late" — which is what this is.
//
// Grouped by the derived horizon (Overdue → This week → Upcoming → Later →
// Completed/Cancelled). Empty groups are omitted; the closed group renders last
// and collapsed-looking, but is never hidden.
//
// Every tap target is at least 44px and nothing is hover-only.

export default function ActivityCards({ activities, canWrite, onEdit, onCancel, now }) {
  const groups = groupActivities(activities, now)

  return (
    <div className="space-y-5">
      {ACTIVITY_GROUP_ORDER.map((key) => {
        const list = groups[key]
        if (list.length === 0) return null
        return (
          <section key={key}>
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <h3 className={`text-[12px] font-bold uppercase tracking-[0.5px] m-0 ${key === ACTIVITY_GROUP.OVERDUE ? 'text-brand-red' : 'text-brand-muted'}`}>
                {ACTIVITY_GROUP_LABELS[key]} · {list.length}
              </h3>
            </div>
            <p className="m-0 mb-2 text-[10.5px] text-brand-muted">{ACTIVITY_GROUP_HINTS[key]}</p>

            <div className="space-y-2">
              {list.map((a) => {
                const late = isOverdue(a, now)
                return (
                  <div
                    key={a.id}
                    className={`border rounded-xl p-3.5 bg-brand-surface ${late ? 'border-brand-red/40' : 'border-brand-border'} ${a.status === ACTIVITY_STATUS.CANCELLED ? 'opacity-55' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="m-0 text-[13px] font-bold text-brand-text">
                        {a.isMilestone && <span aria-hidden="true" className="mr-1.5">◆</span>}
                        {a.name}
                      </p>
                      <Badge
                        sm
                        label={ACTIVITY_STATUS_LABELS[a.status] ?? a.status}
                        variant={ACTIVITY_STATUS_BADGE[a.status] ?? 'info'}
                      />
                    </div>

                    {a.isMilestone && (
                      <p className="m-0 mt-0.5 text-[10px] font-bold text-brand-purple uppercase">Milestone</p>
                    )}

                    <p className={`m-0 mt-1.5 text-[12px] font-semibold ${late ? 'text-brand-red' : 'text-brand-text-soft'}`}>
                      {/* Text, never colour alone. */}
                      {late && 'Overdue · '}{dueLabel(a, now)}
                    </p>

                    <p className="m-0 mt-1 text-[11.5px] text-brand-muted">
                      {a.isMilestone
                        ? `Date ${formatIsoDate(a.plannedStart)}`
                        : `Planned ${formatIsoDate(a.plannedStart)} → ${formatIsoDate(a.plannedFinish)} · ${durationLabel(a)}`}
                    </p>

                    <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
                      {a.responsibleName || 'No one assigned'}
                      {a.costCodeName ? ` · ${a.costCodeName}` : ''}
                    </p>

                    {a.status === ACTIVITY_STATUS.ON_HOLD && a.notes && (
                      <p className="m-0 mt-1 text-[11px] text-brand-amber">On hold — {a.notes}</p>
                    )}
                    {a.status === ACTIVITY_STATUS.CANCELLED && a.cancelReason && (
                      <p className="m-0 mt-1 text-[11px] text-brand-muted">Cancelled — {a.cancelReason}</p>
                    )}

                    <div className="mt-2.5 flex items-center gap-2">
                      <span className="text-[11.5px] font-semibold text-brand-text tabular-nums w-[38px] shrink-0">
                        {a.percentComplete ?? 0}%
                      </span>
                      <ProgBar
                        value={a.percentComplete ?? 0}
                        colour={late ? 'brand-red' : a.status === ACTIVITY_STATUS.COMPLETED ? 'brand-accent' : 'brand-blue'}
                      />
                    </div>

                    {canWrite && a.status !== ACTIVITY_STATUS.CANCELLED && (
                      <div className="mt-3 flex gap-2">
                        <Btn variant="ghost" className="flex-1" onClick={() => onEdit(a)}>Edit</Btn>
                        <Btn variant="ghost" className="flex-1" onClick={() => onCancel(a)}>Cancel</Btn>
                      </div>
                    )}
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
