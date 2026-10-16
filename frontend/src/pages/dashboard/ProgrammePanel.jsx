import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useProjectActivities } from '../../hooks/useProjectActivities'
import { useLocalToday } from '../../hooks/useLocalToday'
import { formatIsoDate } from '../../lib/projectTimeline'
import { figureState, FIGURE_STATE } from '../../lib/projectSnapshot'
import { programmeOverview, donutSegments } from '../../lib/dashboardProgramme'

// ── Dashboard · Programme panel (Dashboard v2, ADR-45) ───────────────────────
//
// ⚠️ THE ROLE GATE IS THE PARENT, NOT THIS FILE. Dashboard renders this panel
// only when `canReadProgramme(profile.role)` (company_admin / project_manager /
// qs — the `activities` rules read audience), and only for the ONE selected
// project, keyed by its id. So subcontractor and client users never open the
// activities subscription. Firestore rules remain the enforced boundary.
//
// Every figure is lib/dashboardProgramme.js → programmeOverview, i.e. the
// existing `timelineSummary` plus a per-status tally. NON-FINANCIAL: these are
// manually maintained activity COUNTS — not weighted progress, earned value,
// baseline schedule performance or a health score — and the panel says so.
// There is deliberately no completion percentage, in the donut or anywhere.

// Status colours follow ACTIVITY_STATUS_BADGE (the Timeline tab's badges):
// not started → muted, in progress → blue, on hold → amber, completed → accent,
// cancelled → red. Each status is always named in the legend.
const STATUS_STROKE = {
  not_started: 'stroke-brand-muted',
  in_progress: 'stroke-brand-blue',
  on_hold:     'stroke-brand-amber',
  completed:   'stroke-brand-accent',
  cancelled:   'stroke-brand-red',
  other:       'stroke-brand-text-soft',
}
const STATUS_SWATCH = {
  not_started: 'bg-brand-muted',
  in_progress: 'bg-brand-blue',
  on_hold:     'bg-brand-amber',
  completed:   'bg-brand-accent',
  cancelled:   'bg-brand-red',
  other:       'bg-brand-text-soft',
}

// r = 100 / (2π), so the circumference is 100 user units and pathLength="100"
// makes every dash value a percentage of the ring.
const R = 15.9155

function Fact({ label, value, tone = 'text-brand-text', hint }) {
  return (
    <div className="min-w-0 rounded-lg bg-brand-bg/60 px-3 py-2.5">
      <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">{label}</p>
      <p className={`m-0 mt-0.5 text-[18px] font-black tabular-nums leading-tight ${tone}`}>{value}</p>
      {hint && <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{hint}</p>}
    </div>
  )
}

// Next milestone — the selected project's nearest OPEN milestone against the
// current plan (lib/projectTimeline.js → nextMilestone). Overdue is always
// stated in words, never by colour alone.
function NextMilestone({ next }) {
  if (!next || next.kind === null) {
    return (
      <div className="mt-2 rounded-lg bg-brand-bg/60 px-3 py-2.5">
        <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Next milestone</p>
        <p className="m-0 mt-0.5 text-[12.5px] text-brand-text-soft">No open milestones on the programme.</p>
      </div>
    )
  }
  const m = next.milestone
  const overdue = next.kind === 'overdue'
  const when = overdue
    ? `Overdue · ${next.daysLate === 1 ? '1 day late' : `${next.daysLate} days late`}`
    : next.daysUntil === 0 ? 'Due today'
      : next.daysUntil === 1 ? 'Due tomorrow'
        : `Due in ${next.daysUntil} days`
  // Earlier milestones still open while a later one is "next".
  const otherOverdue = overdue ? next.overdueCount - 1 : next.overdueCount

  return (
    <div className={`mt-2 rounded-lg px-3 py-2.5 ${overdue ? 'border border-brand-red/40 bg-brand-red/5' : 'bg-brand-bg/60'}`}>
      <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">
        {overdue ? 'Overdue milestone' : 'Next milestone'}
      </p>
      <p className="m-0 mt-0.5 truncate text-[13px] font-bold text-brand-text" title={m.name}>
        <span aria-hidden="true" className="mr-1.5">◆</span>{m.name}
      </p>
      <p className={`m-0 mt-0.5 text-[11.5px] font-semibold tabular-nums ${overdue ? 'text-brand-red' : 'text-brand-text-soft'}`}>
        {formatIsoDate(m.plannedFinish)} · {when}
      </p>
      {otherOverdue > 0 && (
        <p className="m-0 mt-0.5 text-[10.5px] text-brand-amber">
          {otherOverdue === 1 ? '1 other milestone is' : `${otherOverdue} other milestones are`} overdue.
        </p>
      )}
      {overdue && (
        <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">No upcoming milestone is planned.</p>
      )}
    </div>
  )
}

export default function ProgrammePanel({ projectId }) {
  const { activities, activitiesLoading, activitiesError } = useProjectActivities(projectId)
  // The viewer's calendar day — advanced at local midnight, so a Dashboard left
  // open overnight does not keep yesterday's overdue / next-milestone state.
  const now = useLocalToday()

  const availability = figureState(['activities'], {
    activities: { loading: activitiesLoading, error: activitiesError },
  })
  const overview = useMemo(() => programmeOverview(activities, now), [activities, now])
  const donut = donutSegments(overview.byStatus, overview.other)
  const s = overview.summary

  return (
    <section
      aria-labelledby="programme-heading"
      className="min-w-0 rounded-xl border border-brand-border bg-brand-surface p-4 sm:p-5"
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="programme-heading" className="m-0 text-[15px] font-bold text-brand-text">Programme</h3>
        <Link
          to={`/projects/${projectId}/timeline`}
          className="inline-flex min-h-[44px] items-center text-[12px] text-brand-accent hover:underline"
        >
          Open Timeline →
        </Link>
      </div>
      <p className="m-0 mb-4 text-[11px] text-brand-muted">
        Activity counts from the manually maintained programme · current plan, not an approved baseline.
      </p>

      {availability.state === FIGURE_STATE.LOADING && (
        <div className="grid grid-cols-2 gap-2" aria-busy="true">
          {['Completed', 'Overdue', 'Due in 14 days', 'Milestones left'].map(l => (
            <Fact key={l} label={l} value="—" tone="text-brand-muted" />
          ))}
          <div className="col-span-2">
            <Fact label="Next milestone" value="—" tone="text-brand-muted" />
          </div>
        </div>
      )}

      {availability.state === FIGURE_STATE.UNAVAILABLE && (
        <div className="rounded-lg border border-brand-amber/30 bg-brand-amber/5 p-4">
          <p className="m-0 text-[13px] font-semibold text-brand-amber">Programme unavailable</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            Activities could not be loaded. This is not an empty programme — check your connection and access, then reload.
          </p>
        </div>
      )}

      {availability.state === FIGURE_STATE.READY && s.total === 0 && (
        <div className="rounded-lg border border-brand-border bg-brand-bg/40 p-4 text-center">
          <p className="m-0 text-[13px] text-brand-text-soft">No programme activities yet.</p>
          <Link
            to={`/projects/${projectId}/timeline`}
            className="inline-flex min-h-[44px] items-center text-[12px] text-brand-accent hover:underline"
          >
            Plan activities on the Timeline →
          </Link>
        </div>
      )}

      {availability.state === FIGURE_STATE.READY && s.total > 0 && (
        <>
          <div className="flex items-center gap-4">
            <svg
              viewBox="0 0 36 36"
              className="h-[104px] w-[104px] shrink-0"
              role="img"
              aria-label={`Activities by status: ${donut.segments.map(d => `${d.label} ${d.count}`).join(', ')}`}
            >
              <circle cx="18" cy="18" r={R} fill="none" strokeWidth="4" className="stroke-brand-border" />
              {donut.segments.map(d => (
                <circle
                  key={d.status}
                  cx="18" cy="18" r={R} fill="none" strokeWidth="4" pathLength="100"
                  strokeDasharray={d.dashArray}
                  strokeDashoffset={d.dashOffset}
                  transform="rotate(-90 18 18)"
                  className={STATUS_STROKE[d.status]}
                />
              ))}
              <text x="18" y="19" textAnchor="middle" className="fill-brand-text text-[8px] font-black">{s.total}</text>
              <text x="18" y="24" textAnchor="middle" className="fill-brand-muted text-[3.4px] font-semibold">activities</text>
            </svg>
            <ul className="m-0 min-w-0 flex-1 list-none space-y-1 p-0">
              {overview.byStatus.map(({ status, label, count }) => (
                <li key={status} className="flex items-center gap-2 text-[12px] text-brand-text-soft">
                  <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${STATUS_SWATCH[status]}`} aria-hidden="true" />
                  <span className="truncate">{label}</span>
                  <span className="ml-auto font-bold tabular-nums text-brand-text">{count}</span>
                </li>
              ))}
              {overview.other > 0 && (
                <li className="flex items-center gap-2 text-[12px] text-brand-text-soft">
                  <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${STATUS_SWATCH.other}`} aria-hidden="true" />
                  <span className="truncate">Other status</span>
                  <span className="ml-auto font-bold tabular-nums text-brand-text">{overview.other}</span>
                </li>
              )}
            </ul>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <Fact label="Completed" value={`${s.completed} of ${s.total}`} hint="activities (a count, not % complete)" />
            <Fact
              label="Overdue"
              value={s.overdue}
              tone={s.overdue > 0 ? 'text-brand-amber' : 'text-brand-text'}
              hint="past planned finish, not complete"
            />
            <Fact label={`Due in ${s.dueSoonDays} days`} value={s.dueSoon} hint="open activities" />
            <Fact label="Milestones left" value={s.milestonesRemaining} hint="open milestones" />
          </div>
          <NextMilestone next={overview.nextMilestone} />
        </>
      )}
    </section>
  )
}
