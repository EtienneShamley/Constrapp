import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Stat from '../../components/Stat'
import { useProfile } from '../../hooks/useProfile'
import { useContacts } from '../../hooks/useContacts'
import { useCostCodes } from '../../hooks/useCostCodes'
import { useProjectActivities } from '../../hooks/useProjectActivities'
import {
  ACTIVITY_STATUS_ORDER, ACTIVITY_STATUS_LABELS,
  canReadProgramme, canAuthorProgramme,
  timelineSummary, sortActivities, filterActivities, responsibleOptions,
} from '../../lib/projectTimeline'
import TimelineGantt from './timeline/TimelineGantt'
import ActivityTable from './timeline/ActivityTable'
import ActivityCards from './timeline/ActivityCards'
import ActivityEditorModal from './timeline/ActivityEditorModal'
import ActivityCancelModal from './timeline/ActivityCancelModal'

// ── Project Timeline — the project programme (ADR-29) ────────────────────────
//
// THE HONEST FRAME, stated on the page and not only in the docs:
//
//   · This is a CURRENT-PLAN programme, not approved-baseline variance.
//     Constrapp stores no immutable baseline, so "late" means late against the
//     dates as they stand now — editing a planned date silently redefines "on
//     time". The page must never claim slippage against an approved programme.
//   · Progress % is MANUALLY ENTERED and unverified. It is never derived from
//     dates, from child tasks, or from Progress Claims, and it feeds no budget,
//     forecast, margin or cash figure.
//   · Nothing here writes a financial document, and nothing writes
//     projects/{projectId}.progress.
//   · There are no dependencies, no critical path and no automatic
//     rescheduling — nothing moves on its own.
//
// One clock for the whole screen (`now`), passed down to the Gantt, the table
// and the cards, so no two panels can disagree about today.

export default function ProjectTimeline() {
  const { projectId } = useOutletContext()
  const { profile } = useProfile()
  const { contacts } = useContacts()
  const { costCodes } = useCostCodes()
  const {
    activities, activitiesLoading, activitiesError,
    createActivity, updateActivity, cancelActivity,
  } = useProjectActivities(projectId)

  const [search, setSearch]     = useState('')
  const [status, setStatus]     = useState('')
  const [responsible, setResponsible] = useState('')
  const [hideClosed, setHideClosed]   = useState(false)
  const [editing, setEditing]   = useState(null)   // 'new' | activity | null
  const [cancelling, setCancelling] = useState(null)

  const role = profile?.role
  // ⚠️ UX ONLY. Firestore rules are the trust boundary — these flags hide
  // actions the server would reject, they do not authorise anything.
  const canRead  = canReadProgramme(role)
  const canWrite = canAuthorProgramme(role)

  // ONE clock. Re-created per render is intentional and harmless: every derived
  // figure on the screen comes from this single value.
  const now = useMemo(() => new Date(), [])

  const ordered  = useMemo(() => sortActivities(activities), [activities])
  const summary  = useMemo(() => timelineSummary(ordered, now), [ordered, now])
  const filtered = useMemo(
    () => filterActivities(ordered, { search, status, responsibleContactId: responsible, hideClosed }, now),
    [ordered, search, status, responsible, hideClosed, now],
  )
  const people = useMemo(() => responsibleOptions(ordered), [ordered])

  const filtersActive = Boolean(search || status || responsible || hideClosed)

  async function handleSave(fields) {
    if (editing === 'new') await createActivity(fields)
    else await updateActivity(editing, fields)
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-[17px] font-semibold text-brand-text m-0">Programme</h2>
          <p className="m-0 mt-0.5 text-[12px] text-brand-muted">
            What has to happen, by when, and who owns it — measured against the current plan.
          </p>
        </div>
        {canWrite && (
          <Btn onClick={() => setEditing('new')} disabled={activitiesError}>+ Add activity</Btn>
        )}
      </div>

      {activitiesError ? (
        <Card>
          <p className="m-0 text-[12.5px] text-brand-amber">
            The programme failed to load — it is <strong>unavailable, not empty</strong>. Reload the page;
            if it persists, your role may not have programme access.
          </p>
        </Card>
      ) : activitiesLoading ? (
        <p className="text-[13px] text-brand-muted">Loading programme…</p>
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
          {/* ── Summary ──────────────────────────────────────────────── */}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
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
            {filtersActive && (
              <p className="m-0 mt-3 text-[11.5px] text-brand-muted">
                Showing {filtered.length} of {ordered.length} activities.{' '}
                <button
                  type="button"
                  className="text-brand-accent hover:underline cursor-pointer"
                  onClick={() => { setSearch(''); setStatus(''); setResponsible(''); setHideClosed(false) }}
                >
                  Clear filters
                </button>
              </p>
            )}
          </Card>

          {filtered.length === 0 ? (
            <Card>
              <p className="m-0 text-[12.5px] text-brand-muted">
                No activity matches these filters.
              </p>
            </Card>
          ) : (
            <>
              {/* ── Gantt — DESKTOP/TABLET ONLY ─────────────────────── */}
              <Card padding={false} className="mb-3.5 hidden md:block">
                <div className="px-3.5 py-3 border-b border-brand-border">
                  <p className="text-[13px] font-bold text-brand-text m-0">Programme view</p>
                  <p className="m-0 mt-0.5 text-[11px] text-brand-muted">
                    Planned dates on a calendar-day grid. Scroll sideways for the full span.
                  </p>
                </div>
                <TimelineGantt activities={filtered} now={now} />
              </Card>

              {/* ── Table — DESKTOP/TABLET ──────────────────────────── */}
              <Card padding={false} className="mb-3.5 hidden md:block">
                <div className="px-3.5 py-3 border-b border-brand-border">
                  <p className="text-[13px] font-bold text-brand-text m-0">Activities</p>
                  <p className="m-0 mt-0.5 text-[11px] text-brand-muted">
                    The complete record — every figure above is read from here.
                  </p>
                </div>
                <ActivityTable
                  activities={filtered}
                  canWrite={canWrite}
                  onEdit={setEditing}
                  onCancel={setCancelling}
                  now={now}
                />
              </Card>

              {/* ── Cards — MOBILE ──────────────────────────────────── */}
              <div className="md:hidden mb-3.5">
                <ActivityCards
                  activities={filtered}
                  canWrite={canWrite}
                  onEdit={setEditing}
                  onCancel={setCancelling}
                  now={now}
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
                report slippage against an approved programme.
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
                reschedules automatically — changing one activity moves nothing else.
              </li>
              <li>
                A cost code is an optional label that links an activity to the commercial spine. It is
                reporting context only.
              </li>
              <li>
                Responsibility is assigned to a company <strong className="text-brand-text-soft">Contact</strong>.
                Assigning an internal staff member needs user management, which is not built yet.
              </li>
              <li>
                Activities are cancelled, never deleted — and simultaneous edits by two people overwrite each
                other, so agree who is updating the programme.
              </li>
              {!canWrite && (
                <li>
                  <strong className="text-brand-text-soft">You have read-only access.</strong> Company admins
                  and project managers author the programme.
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
    </div>
  )
}
