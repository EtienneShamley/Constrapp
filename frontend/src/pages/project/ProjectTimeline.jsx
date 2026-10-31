import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Stat from '../../components/Stat'
import { ModuleTile, BeatToggle } from '../../components/ModuleMark'
import { MODULE_NAMES } from '../../lib/moduleBranding'
import { useProfile } from '../../hooks/useProfile'
import { useContacts } from '../../hooks/useContacts'
import { useCostCodes } from '../../hooks/useCostCodes'
import { useProjectActivities } from '../../hooks/useProjectActivities'
import { useLocalToday } from '../../hooks/useLocalToday'
import {
  ACTIVITY_STATUS, ACTIVITY_STATUS_ORDER, ACTIVITY_STATUS_LABELS,
  DUE_FILTER, DUE_FILTER_OPTIONS,
  canReadProgramme, canAuthorProgramme,
  timelineSummary, sortActivities, filterActivities, responsibleOptions,
  quickActionLabel,
} from '../../lib/projectTimeline'
import { DEFAULT_GANTT_SCALE, isGanttScale } from '../../lib/timelineGantt'
import { GANTT_GROUP, isGanttGroup, toggleGroupKey, collapseAllKeys } from '../../lib/ganttGrouping'
import { dependencyStates, successorIndex, successorsOf } from '../../lib/ganttDependencies'
import TimelineGantt from './timeline/TimelineGantt'
import ActivityTable from './timeline/ActivityTable'
import ActivityCards from './timeline/ActivityCards'
import ActivityEditorModal from './timeline/ActivityEditorModal'
import ActivityCancelModal from './timeline/ActivityCancelModal'
import ActivityDetailModal from './timeline/ActivityDetailModal'

// ── Constrapp GANTT™ — the project programme (ADR-29, ADR-46, ADR-64) ────────
//
// The ADR-29 Timeline tab under its module name. ONE collection, ONE listener
// (useProjectActivities), ONE editor — the Gantt chart and the activity list
// are two VIEWS of the same filtered records, never two registers.
//
// THE HONEST FRAME, stated on the page and not only in the docs:
//
//   · This is a CURRENT-PLAN programme, not approved-baseline variance.
//     Constrapp stores no immutable baseline, so "late" means late against the
//     dates as they stand now — editing a planned date silently redefines "on
//     time". The page must never claim slippage against an approved programme.
//     The recorded (actual) dates drawn beneath the plan are compared with the
//     CURRENT plan and labelled so.
//   · Progress % is MANUALLY ENTERED and unverified. It is never derived from
//     dates, from child tasks, or from Progress Claims, and it feeds no budget,
//     forecast, margin or cash figure.
//   · Nothing here writes a financial document, and nothing writes
//     projects/{projectId}.progress.
//   · There are no dependencies, no critical path and no automatic
//     rescheduling — nothing moves on its own. Zoom, grouping and collapse are
//     presentation state on this page; no stored field exists for them.
//
// One clock for the whole screen (`now`), passed down to the chart, the list
// and the cards, so no two panels can disagree about today. It comes from
// useLocalToday, which moves it forward at local midnight (and on refocus), so
// a tab left open overnight does not keep showing yesterday's overdue state.

const VIEW = { CHART: 'chart', LIST: 'list' }

const viewBtnCls = (active) =>
  `inline-flex min-h-[44px] items-center rounded-lg border px-3.5 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-brand-accent ${
    active ? 'border-brand-accent/40 bg-brand-accent/15 text-brand-text' : 'border-brand-border text-brand-muted hover:text-brand-text hover:bg-brand-card'
  }`

// The branded module heading (ADR-48 convention, as PULSE / SHIELD / Quant):
// the module tile with its luminous dot, the full product name as an <h2>
// (the project name owns the page's <h1>), a one-line subtitle, and the
// Pause / Resume control the continuous beat must sit beside (WCAG 2.2.2).
// The pause state lives here and is deliberately not persisted.
function GanttHeading({ canWrite, onAdd, addDisabled }) {
  const [beatPaused, setBeatPaused] = useState(false)
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <ModuleTile module="gantt" beat paused={beatPaused} />
        <div className="min-w-0">
          <h2 className="m-0 text-[15px] font-bold text-brand-text">{MODULE_NAMES.gantt}</h2>
          <p className="m-0 mt-0.5 text-[12px] text-brand-muted">Construction programme</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-brand-muted">Calendar days · current plan</span>
        <BeatToggle paused={beatPaused} onToggle={() => setBeatPaused(p => !p)} subject="glow animation" />
        {canWrite && <Btn onClick={onAdd} disabled={addDisabled}>+ Add activity</Btn>}
      </div>
    </div>
  )
}

export default function ProjectTimeline() {
  const { projectId } = useOutletContext()
  const { profile } = useProfile()
  const { contacts } = useContacts()
  const { costCodes } = useCostCodes()
  const {
    activities, activitiesLoading, activitiesError,
    createActivity, updateActivity, cancelActivity, quickUpdateActivity,
  } = useProjectActivities(projectId)

  const [search, setSearch]     = useState('')
  const [status, setStatus]     = useState('')
  const [responsible, setResponsible] = useState('')
  const [hideClosed, setHideClosed]   = useState(false)
  const [due, setDue]           = useState(DUE_FILTER.ANY)
  // Chart presentation state (ADR-64) — nothing here is stored.
  const [view, setView]         = useState(VIEW.CHART)
  const [scale, setScaleState]  = useState(DEFAULT_GANTT_SCALE)
  const [groupBy, setGroupByState] = useState(GANTT_GROUP.NONE)
  const [collapsed, setCollapsed]  = useState(() => new Set())
  // Quick status actions: the activity id being written, and the outcome
  // message of the last attempt (announced through a live region).
  const [quickBusyId, setQuickBusyId] = useState(null)
  const [quickNotice, setQuickNotice] = useState(null)   // { tone: 'ok' | 'error', text }
  const [editing, setEditing]   = useState(null)   // 'new' | activity | null
  const [cancelling, setCancelling] = useState(null)
  const [viewing, setViewing]   = useState(null)   // activity | null — the read-only detail

  const role = profile?.role
  // ⚠️ UX ONLY. Firestore rules are the trust boundary — these flags hide
  // actions the server would reject, they do not authorise anything.
  const canRead  = canReadProgramme(role)
  const canWrite = canAuthorProgramme(role)

  // ONE clock for the screen. Stable within a local calendar day (so the memos
  // below stay stable) and advanced at midnight / on refocus by useLocalToday.
  const now = useLocalToday()

  const ordered  = useMemo(() => sortActivities(activities), [activities])
  const summary  = useMemo(() => timelineSummary(ordered, now), [ordered, now])
  const filtered = useMemo(
    () => filterActivities(ordered, { search, status, responsibleContactId: responsible, hideClosed, due }, now),
    [ordered, search, status, responsible, hideClosed, due, now],
  )
  const people = useMemo(() => responsibleOptions(ordered), [ordered])
  // ADR-65: dependency states over the WHOLE programme (a filtered-out
  // predecessor still blocks), derived once per snapshot and per local day.
  const depStates = useMemo(() => dependencyStates(ordered, now), [ordered, now])
  const succIndex = useMemo(() => successorIndex(ordered), [ordered])

  const filtersActive = Boolean(search || status || responsible || hideClosed || due)

  function clearFilters() {
    setSearch(''); setStatus(''); setResponsible(''); setHideClosed(false); setDue(DUE_FILTER.ANY)
  }

  const setScale = (s) => { if (isGanttScale(s)) setScaleState(s) }
  const setGroupBy = (g) => { if (isGanttGroup(g)) { setGroupByState(g); setCollapsed(new Set()) } }
  const toggleGroup = (key) => setCollapsed(prev => toggleGroupKey(prev, key))
  const collapseAll = (groups) => setCollapsed(collapseAllKeys(groups))
  const expandAll = () => setCollapsed(new Set())

  // A bar was activated on the chart. An author opens the existing editor; a
  // reader — or anyone on a cancelled activity, which is retained history and
  // cannot be edited — opens the read-only detail. The record is looked up
  // from the loaded programme, never from the chart's geometry.
  function handleActivate(activityId) {
    const activity = ordered.find(a => a.id === activityId)
    if (!activity) return
    if (canWrite && activity.status !== ACTIVITY_STATUS.CANCELLED) setEditing(activity)
    else setViewing(activity)
  }

  // A quick action is a guarded write (see useProjectActivities →
  // quickUpdateActivity). All UI state changes happen HERE, after the
  // transaction has settled — never inside it.
  async function handleQuickAction(activity, action) {
    if (quickBusyId) return
    const label = quickActionLabel(action, activity)
    setQuickBusyId(activity.id)
    setQuickNotice(null)
    try {
      await quickUpdateActivity(activity, action)
      setQuickNotice({ tone: 'ok', text: `${label}: “${activity.name}” updated.` })
    } catch (err) {
      setQuickNotice({ tone: 'error', text: `${label} — “${activity.name}”: ${err?.message ?? 'The activity could not be updated.'}` })
    } finally {
      setQuickBusyId(null)
    }
  }

  // `base` is the copy the editor was opened from (or re-seeded to by
  // *Reload latest*): the version the guarded save compares against.
  async function handleSave(fields, base) {
    if (editing === 'new') await createActivity(fields)
    else await updateActivity(base ?? editing, fields)
  }

  if (!canRead) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-brand-text font-semibold">Programme not available</p>
        <p className="m-0 mt-1.5 text-[12px] text-brand-muted">
          The project programme is visible to company admins, project managers and QS users. Subcontractor
          and client access is not available: those roles are not yet scoped to their own projects, so any
          access would expose every programme in the company.
        </p>
      </Card>
    )
  }

  return (
    <div>
      <div className="mb-4">
        <GanttHeading canWrite={canWrite} onAdd={() => setEditing('new')} addDisabled={activitiesError} />
      </div>

      {activitiesError ? (
        <Card>
          <p className="m-0 text-[12.5px] text-brand-amber">
            The programme failed to load — it is <strong>unavailable, not empty</strong>. Reload the page;
            if it persists, your role may not have programme access.
          </p>
        </Card>
      ) : activitiesLoading ? (
        <p className="text-[13px] text-brand-muted" role="status">Loading programme…</p>
      ) : ordered.length === 0 ? (
        <Card className="text-center py-14">
          <div className="text-4xl mb-3 leading-none" aria-hidden="true">⏱</div>
          <h3 className="text-brand-text font-bold text-base mb-2 m-0">No programme yet</h3>
          <p className="text-brand-muted text-[12.5px] mb-4 max-w-md mx-auto">
            Add the activities and milestones this project runs on. Constrapp keeps a simple, current
            programme — dates, responsibility and progress — not a critical-path schedule.
          </p>
          {canWrite
            ? <Btn onClick={() => setEditing('new')}>+ Add the first activity</Btn>
            : <p className="m-0 text-[11.5px] text-brand-muted">
                QS users can read the programme; a company admin or project manager creates it.
              </p>}
        </Card>
      ) : (
        <>
          {/* ── Summary — the whole programme, whatever is filtered or collapsed ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3.5">
            <Card>
              <Stat
                label="Overdue"
                value={summary.overdue}
                sub="Past planned finish, not complete"
                color={summary.overdue > 0 ? 'var(--color-brand-red)' : undefined}
              />
            </Card>
            <Card>
              <Stat label={`Due next ${summary.dueSoonDays} days`} value={summary.dueSoon} sub="Open work due soon" />
            </Card>
            <Card>
              <Stat label="In progress" value={summary.inProgress} sub="Started, not finished" />
            </Card>
            <Card>
              <Stat label="Milestones remaining" value={summary.milestonesRemaining} sub="Not yet reached" />
            </Card>
          </div>

          {/* ── Filters ──────────────────────────────────────────────── */}
          <Card className="mb-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5" htmlFor="tl-search">
                  Search
                </label>
                <input
                  id="tl-search"
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none min-h-[44px]"
                  placeholder="Activity, responsible, cost code…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5" htmlFor="tl-status">
                  Status
                </label>
                <select
                  id="tl-status"
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">All statuses</option>
                  {ACTIVITY_STATUS_ORDER.map(s => (
                    <option key={s} value={s}>{ACTIVITY_STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5" htmlFor="tl-responsible">
                  Responsible
                </label>
                <select
                  id="tl-responsible"
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]"
                  value={responsible}
                  onChange={(e) => setResponsible(e.target.value)}
                >
                  <option value="">Anyone</option>
                  {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5" htmlFor="tl-due">
                  Due
                </label>
                {/* One control, not two checkboxes: overdue and due-soon are
                    mutually exclusive, so combining them could only ever
                    produce an empty list. */}
                <select
                  id="tl-due"
                  aria-describedby="tl-due-hint"
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                >
                  {DUE_FILTER_OPTIONS.map(o => <option key={o.value || 'any'} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-[12.5px] text-brand-text cursor-pointer min-h-[44px]">
                  <input
                    type="checkbox"
                    checked={hideClosed}
                    onChange={(e) => setHideClosed(e.target.checked)}
                  />
                  Hide completed &amp; cancelled
                </label>
              </div>
            </div>
            <p id="tl-due-hint" className="m-0 mt-3 text-[11px] text-brand-muted">
              {due === DUE_FILTER.OVERDUE
                ? 'Overdue: open activities whose planned finish is before today. Completed and cancelled work is never overdue.'
                : due === DUE_FILTER.DUE_SOON
                  ? `Due soon: open activities with a planned finish from today to ${summary.dueSoonDays} days ahead — overdue work is not included.`
                  : 'Filters combine: each one narrows the list further. The chart and the list show the same filtered activities.'}
            </p>
            {filtersActive && (
              <p className="m-0 mt-1.5 text-[11.5px] text-brand-muted">
                Showing {filtered.length} of {ordered.length} activities.{' '}
                <button
                  type="button"
                  className="text-brand-accent hover:underline cursor-pointer"
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              </p>
            )}
          </Card>

          {/* Quick-action outcome — always in the DOM so screen readers announce it. */}
          <div aria-live="polite" role="status">
            {quickNotice && (
              <div
                className={`mb-3.5 rounded-lg border px-3.5 py-2.5 text-[12.5px] flex items-start justify-between gap-3 ${
                  quickNotice.tone === 'error'
                    ? 'border-brand-amber/40 bg-brand-amber/5 text-brand-amber'
                    : 'border-brand-border bg-brand-surface text-brand-text-soft'}`}
              >
                <span>{quickNotice.text}</span>
                <button
                  type="button"
                  className="text-brand-muted hover:text-brand-text cursor-pointer min-h-[32px] px-1"
                  onClick={() => setQuickNotice(null)}
                  aria-label="Dismiss message"
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          {filtered.length === 0 ? (
            <Card>
              <p className="m-0 text-[12.5px] text-brand-muted">
                No activity matches these filters.
              </p>
            </Card>
          ) : (
            <>
              {/* ── Chart / List — DESKTOP/TABLET: two views of ONE filtered set ── */}
              <div role="group" aria-label="Programme view" className="hidden md:flex items-center gap-1 mb-3">
                <button type="button" aria-pressed={view === VIEW.CHART} className={viewBtnCls(view === VIEW.CHART)} onClick={() => setView(VIEW.CHART)}>
                  Chart
                </button>
                <button type="button" aria-pressed={view === VIEW.LIST} className={viewBtnCls(view === VIEW.LIST)} onClick={() => setView(VIEW.LIST)}>
                  List
                </button>
                <span className="ml-2 text-[11px] text-brand-muted">
                  {filtered.length} {filtered.length === 1 ? 'activity' : 'activities'} · the list is the complete record
                </span>
              </div>

              {view === VIEW.CHART && (
                <Card padding={false} className="mb-3.5 hidden md:block">
                  <div className="px-3.5 py-3 border-b border-brand-border">
                    <p className="text-[13px] font-bold text-brand-text m-0">Programme chart</p>
                    <p className="m-0 mt-0.5 text-[11px] text-brand-muted">
                      Planned dates on a calendar-day grid; recorded dates beneath. Open an activity by clicking its bar or pressing Enter on it.
                    </p>
                  </div>
                  <TimelineGantt
                    activities={filtered}
                    now={now}
                    scale={scale}
                    onScaleChange={setScale}
                    groupBy={groupBy}
                    onGroupByChange={setGroupBy}
                    costCodes={costCodes}
                    collapsed={collapsed}
                    onToggleGroup={toggleGroup}
                    onCollapseAll={collapseAll}
                    onExpandAll={expandAll}
                    onActivate={handleActivate}
                    canWrite={canWrite}
                    dependencyStates={depStates}
                  />
                </Card>
              )}

              {view === VIEW.LIST && (
                <Card padding={false} className="mb-3.5 hidden md:block">
                  <div className="px-3.5 py-3 border-b border-brand-border">
                    <p className="text-[13px] font-bold text-brand-text m-0">Activities</p>
                    <p className="m-0 mt-0.5 text-[11px] text-brand-muted">
                      The complete record — every figure on the chart is read from here.
                    </p>
                  </div>
                  <ActivityTable
                    activities={filtered}
                    canWrite={canWrite}
                    onEdit={setEditing}
                    onCancel={setCancelling}
                    onQuickAction={handleQuickAction}
                    quickBusyId={quickBusyId}
                    now={now}
                    dependencyStates={depStates}
                  />
                </Card>
              )}

              {/* ── Cards — MOBILE: the usable programme on a phone ──── */}
              <div className="md:hidden mb-3.5">
                <ActivityCards
                  activities={filtered}
                  canWrite={canWrite}
                  onEdit={setEditing}
                  onCancel={setCancelling}
                  onQuickAction={handleQuickAction}
                  quickBusyId={quickBusyId}
                  now={now}
                  dependencyStates={depStates}
                />
              </div>
            </>
          )}

          {/* ── What this programme is, and is not ───────────────────── */}
          <Card>
            <p className="text-[12.5px] font-bold text-brand-text m-0 mb-1.5">What this programme is</p>
            <ul className="m-0 pl-4 text-[11.5px] text-brand-muted space-y-1">
              <li>
                <strong className="text-brand-text-soft">Current plan, not an approved baseline.</strong> “Overdue”
                means late against the dates as they stand today. Constrapp stores no baseline, so it cannot
                report slippage against an approved programme; the recorded dates on the chart are compared with
                the current plan only.
              </li>
              <li>
                <strong className="text-brand-text-soft">Progress % is entered by hand</strong> and is not verified.
                It is never derived from dates or from Progress Claims, and it changes no budget, forecast,
                margin or cash figure.
              </li>
              <li>
                <strong className="text-brand-text-soft">Calendar days.</strong> Weekends, public holidays and
                working calendars are not modelled.
              </li>
              <li>
                <strong className="text-brand-text-soft">No dependencies or critical path.</strong> Nothing
                reschedules automatically — changing one activity moves nothing else, and nothing on the chart
                can be dragged.
              </li>
              <li>
                A cost code is an optional label that links an activity to the commercial spine. It is
                reporting context only — grouping the chart by cost code or responsible party changes no record.
              </li>
              <li>
                Responsibility is assigned to a company <strong className="text-brand-text-soft">Contact</strong>.
                Assigning an internal staff member needs user management, which is not built yet.
              </li>
              <li>
                Activities are cancelled, never deleted. <strong className="text-brand-text-soft">Quick status
                buttons</strong> record today’s date and refuse to apply if someone else changed the activity
                first. The full editor does not have that check — two people saving the same activity overwrite
                each other, so agree who is updating the programme.
              </li>
              {!canWrite && (
                <li>
                  <strong className="text-brand-text-soft">You have read-only access.</strong> Company admins
                  and project managers author the programme; opening a bar shows its details.
                </li>
              )}
            </ul>
          </Card>
        </>
      )}

      {editing && (
        <ActivityEditorModal
          activity={editing === 'new' ? null : editing}
          activities={ordered}
          contacts={contacts}
          costCodes={costCodes}
          projectId={projectId}
          dependencyStates={depStates}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      {cancelling && (
        <ActivityCancelModal
          activity={cancelling}
          onCancelActivity={cancelActivity}
          onClose={() => setCancelling(null)}
        />
      )}

      {viewing && (
        <ActivityDetailModal
          activity={viewing}
          now={now}
          dependencyStates={depStates}
          successors={successorsOf(viewing.id, succIndex)}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}
