import { useMemo, useState } from 'react'
import Btn from '../../../components/Btn'
import ActivityDialog from './ActivityDialog'
import { todayIso } from '../../../lib/payments'
import {
  ACTIVITY_STATUS, ACTIVITY_STATUS_ORDER, ACTIVITY_STATUS_LABELS,
  CREATABLE_STATUSES, LIMITS,
  validateActivityDraft, durationLabel, nextSortOrder, formatIsoDate,
} from '../../../lib/projectTimeline'
import {
  MAX_PREDECESSORS, MAX_LAG_DAYS, DEPENDENCY_STATE_LABELS,
  activitiesById, predecessorsOf, normalisePredecessors, toStoredPredecessors,
  predecessorCandidateError, validatePredecessorsDraft, draftConflicts,
  conflictAcknowledgementKey, earliestStartAfter, stateFor,
} from '../../../lib/ganttDependencies'
import { ACTIVITY_WRITE_ERROR } from '../../../lib/activityActions'

// ── Activity editor (create / edit) ──────────────────────────────────────────
//
// Authors ONE programme activity. Pure UI over lib/projectTimeline.js and
// lib/ganttDependencies.js validation — every rule shown here has a
// counterpart in the `activities` block of firestore.rules, so the form can
// never assemble a document the server rejects for a reason the user cannot
// see (graph checks — cycles, cancelled sources — are client-side, DC41).
//
// Deliberate behaviour:
//   · a MILESTONE collapses to a single date field — its finish is always its
//     start, so the two can never disagree, and progress becomes a two-way
//     "reached / not reached" choice
//   · choosing a status PRE-FILLS the dates and progress that status requires
//     (today's date, 100%) — VISIBLY, in the fields, never silently on save
//   · status may move BACKWARDS (completed → in progress); correcting a
//     mis-ticked activity is a supported action, not an error
//   · CANCELLING IS NOT HERE. It has its own modal because it is terminal and
//     records a reason.
//   · PREDECESSORS (ADR-65): finish-to-start links to other activities in this
//     programme, with a non-negative lag in calendar days. The picker never
//     offers the activity itself, a duplicate, a cancelled activity or one
//     that would close a cycle. A link already stored that no longer resolves
//     (cancelled or missing) is SHOWN for review — never silently dropped by
//     an unrelated edit — and may be removed here deliberately. A planned
//     start before what the predecessors allow is a CONFLICT: it may be saved
//     only after an explicit acknowledgement, which resets whenever the start
//     or the links change. Nothing is rescheduled for the user.
//   · the save is a GUARDED transaction (ADR-65): when someone else changed
//     the activity since it was opened, the save is refused, the draft stays,
//     and *Reload latest* re-seeds the form from the current record.
//   · the shell is ActivityDialog: `role="dialog"`, Tab contained, Escape
//     closes (not while saving), and focus returns to whatever opened it.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const hintCls  = 'm-0 mt-1 text-[10.5px] text-brand-muted'

// The form's field state from an activity (or the empty defaults).
function seedFields(activity, activities) {
  return {
    name: activity?.name ?? '',
    description: activity?.description ?? '',
    isMilestone: activity?.isMilestone === true,
    status: activity?.status ?? ACTIVITY_STATUS.NOT_STARTED,
    plannedStart: activity?.plannedStart ?? '',
    plannedFinish: activity?.plannedFinish ?? '',
    actualStart: activity?.actualStart ?? '',
    actualFinish: activity?.actualFinish ?? '',
    percentComplete: String(activity?.percentComplete ?? 0),
    responsibleContactId: activity?.responsibleContactId ?? '',
    costCodeId: activity?.costCodeId ?? '',
    sortOrder: String(activity?.sortOrder ?? nextSortOrder(activities)),
    notes: activity?.notes ?? '',
    // Stored shape, kept as entered (lag as a string while typing).
    predecessors: normalisePredecessors(predecessorsOf(activity)).map(e => ({
      activityId: e.activityId, type: e.type, lagDays: String(e.lagDays), malformed: e.malformed,
    })),
  }
}

export default function ActivityEditorModal({
  activity,        // existing activity when editing, null when creating
  activities,      // the whole programme — predecessor candidates, cycle checks, next sortOrder
  contacts,        // active company contacts
  costCodes,       // active company cost codes
  projectId,
  dependencyStates, // read-time link states (for the review list) — optional
  onSave,          // async (fields, base) => void — `base` is the version the save is guarded against
  onClose,
}) {
  const creating = !activity
  const today = todayIso()

  // `base` is the copy the save is compared against (its revision and
  // stamps). *Reload latest* replaces it with the current record.
  const [base, setBase] = useState(activity ?? null)
  const [f, setF] = useState(() => seedFields(activity, activities))
  const set = (key) => (value) => setF(prev => ({ ...prev, [key]: value }))

  const [candidate, setCandidate] = useState('')
  const [ackKey, setAckKey] = useState(null)     // the conflict key the user acknowledged
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)
  const [stale, setStale]   = useState(false)

  const byId = useMemo(() => activitiesById(activities), [activities])
  const selfId = activity?.id ?? null
  const latest = selfId ? byId.get(selfId) ?? null : null

  // Contacts assigned to THIS project first — the same courtesy the PO supplier
  // picker gives, without changing who is selectable.
  const contactGroups = useMemo(() => {
    const active = (contacts ?? []).filter(c => c.isActive !== false)
    const mine   = active.filter(c => (c.projectIds ?? []).includes(projectId))
    const others = active.filter(c => !(c.projectIds ?? []).includes(projectId))
    const byName = (a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? '')
    return { mine: [...mine].sort(byName), others: [...others].sort(byName) }
  }, [contacts, projectId])

  const activeCostCodes = useMemo(
    () => (costCodes ?? []).filter(c => c.isActive !== false),
    [costCodes],
  )

  const contactName = (id) =>
    (contacts ?? []).find(c => c.id === id)?.displayName ?? ''

  const costCodeLabel = (id) => {
    const cc = (costCodes ?? []).find(c => c.id === id)
    if (!cc) return ''
    return cc.name ? `${cc.code} — ${cc.name}` : cc.code
  }

  // Milestone toggle: the finish follows the start, and progress collapses to
  // 0/100. Shown immediately in the fields.
  const changeMilestone = (checked) => {
    setF(prev => ({
      ...prev,
      isMilestone: checked,
      plannedFinish: checked ? prev.plannedStart : prev.plannedFinish,
      percentComplete: checked ? (Number(prev.percentComplete) >= 100 ? '100' : '0') : prev.percentComplete,
    }))
  }

  const changePlannedStart = (value) => {
    setF(prev => ({
      ...prev,
      plannedStart: value,
      // Keep a nonsensical span from being the default: nudge the finish
      // forward rather than silently accepting an inverted one.
      plannedFinish: prev.isMilestone ? value : (prev.plannedFinish && value && prev.plannedFinish < value ? value : prev.plannedFinish),
    }))
  }

  // Picking a status fills in what that status REQUIRES, visibly.
  const changeStatus = (value) => {
    setF(prev => {
      const next = { ...prev, status: value }
      if (value === ACTIVITY_STATUS.NOT_STARTED) {
        next.percentComplete = '0'; next.actualStart = ''; next.actualFinish = ''
      }
      if (value === ACTIVITY_STATUS.IN_PROGRESS) {
        if (!prev.actualStart) next.actualStart = today
        next.actualFinish = ''
        if (prev.isMilestone) next.percentComplete = '0'
      }
      if (value === ACTIVITY_STATUS.COMPLETED) {
        next.percentComplete = '100'
        if (!prev.actualFinish) next.actualFinish = today
      }
      return next
    })
  }

  // ── Predecessors ───────────────────────────────────────────────────────────
  const storedPredecessors = f.predecessors.map(e => ({ activityId: e.activityId, type: 'FS', lagDays: e.lagDays === '' ? NaN : Number(e.lagDays) }))
  const previousIds = predecessorsOf(base).map(e => e?.activityId).filter(Boolean)
  const liveState = selfId ? stateFor(dependencyStates, selfId) : null

  // Candidates: every other live activity, with the reason it cannot be added
  // (self, duplicate, cancelled, cycle) — disabled, never hidden, so the user
  // understands why.
  const candidates = useMemo(() => {
    const list = (activities ?? [])
      .filter(a => a.id !== selfId && a.status !== ACTIVITY_STATUS.CANCELLED)
      .map(a => ({ id: a.id, name: a.name, reason: predecessorCandidateError(byId, selfId ?? '__new__', a.id, storedPredecessors) }))
    return list.sort((x, y) => (x.name ?? '').localeCompare(y.name ?? ''))
    // storedPredecessors is derived from f.predecessors each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities, byId, selfId, f.predecessors])

  const addPredecessor = () => {
    if (!candidate) return
    const reason = predecessorCandidateError(byId, selfId ?? '__new__', candidate, storedPredecessors)
    if (reason) { setError(reason); return }
    if (f.predecessors.length >= MAX_PREDECESSORS) { setError(`An activity may have at most ${MAX_PREDECESSORS} predecessors`); return }
    setF(prev => ({ ...prev, predecessors: [...prev.predecessors, { activityId: candidate, type: 'FS', lagDays: '0', malformed: false }] }))
    setCandidate('')
    setError(null)
  }
  const removePredecessor = (index) =>
    setF(prev => ({ ...prev, predecessors: prev.predecessors.filter((_, i) => i !== index) }))
  const changeLag = (index, value) =>
    setF(prev => ({ ...prev, predecessors: prev.predecessors.map((e, i) => (i === index ? { ...e, lagDays: value } : e)) }))

  const fields = {
    name: f.name,
    description: f.description,
    isMilestone: f.isMilestone,
    status: f.status,
    plannedStart: f.plannedStart,
    plannedFinish: f.isMilestone ? f.plannedStart : f.plannedFinish,
    actualStart:  f.actualStart  || null,
    actualFinish: f.actualFinish || null,
    percentComplete: f.percentComplete === '' ? NaN : Number(f.percentComplete),
    responsibleContactId: f.responsibleContactId || null,
    responsibleName: f.responsibleContactId ? contactName(f.responsibleContactId) : '',
    costCodeId: f.costCodeId || null,
    costCodeName: f.costCodeId ? costCodeLabel(f.costCodeId) : '',
    sortOrder: Number(f.sortOrder),
    notes: f.notes,
    predecessors: storedPredecessors,
  }

  // Conflicts for the draft AS TYPED; the acknowledgement is keyed to the
  // start date + links so any change resets it.
  const conflicts = useMemo(() => draftConflicts(fields, byId), [fields.plannedStart, f.predecessors, byId]) // eslint-disable-line react-hooks/exhaustive-deps
  const currentAckKey = conflictAcknowledgementKey(fields)
  const acknowledged = ackKey === currentAckKey

  const statusOptions = creating ? CREATABLE_STATUSES : ACTIVITY_STATUS_ORDER.filter(
    s => s !== ACTIVITY_STATUS.CANCELLED,
  )

  const durationPreview = durationLabel({
    isMilestone: f.isMilestone,
    plannedStart: f.plannedStart,
    plannedFinish: f.isMilestone ? f.plannedStart : f.plannedFinish,
  })

  function reloadLatest() {
    if (!latest) return
    setBase(latest)
    setF(seedFields(latest, activities))
    setAckKey(null)
    setStale(false)
    setError(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const validationError = validateActivityDraft(fields, { creating })
    if (validationError) { setError(validationError); return }
    const linkError = validatePredecessorsDraft(toStoredPredecessors(storedPredecessors), {
      activities: byId, successorId: selfId ?? '__new__', previousIds,
    })
    if (linkError) { setError(linkError); return }
    if (conflicts.length > 0 && !acknowledged) {
      setError('This activity starts before its predecessors allow. Tick the acknowledgement to save it anyway, or change the dates.')
      return
    }
    setSaving(true); setError(null); setStale(false)
    try {
      await onSave({ ...fields, predecessors: toStoredPredecessors(storedPredecessors) }, base)
      onClose()
    } catch (err) {
      // Nothing was written in any of these cases; the draft stays as typed.
      if (err?.kind === ACTIVITY_WRITE_ERROR.STALE) setStale(true)
      setError(err?.message || 'Failed to save. Nothing was written — check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ActivityDialog title={creating ? 'Add activity' : 'Edit activity'} titleId="activity-editor-title" onClose={onClose} busy={saving}>
      <form onSubmit={handleSubmit} className="p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="activity-name">Activity name *</label>
            <input
              id="activity-name"
              className={inputCls}
              autoFocus
              maxLength={LIMITS.name}
              placeholder="e.g. Ground floor slab pour"
              value={f.name}
              onChange={(e) => set('name')(e.target.value)}
            />
          </div>

          <div className="sm:col-span-2">
            <label className="flex items-start gap-2 cursor-pointer min-h-[44px] items-center">
              <input
                type="checkbox"
                checked={f.isMilestone}
                onChange={(e) => changeMilestone(e.target.checked)}
              />
              <span className="text-[12.5px] text-brand-text">
                This is a <strong>milestone</strong> — a single dated point, not a span of work
              </span>
            </label>
          </div>

          <div>
            <label className={labelCls} htmlFor="activity-status">Status *</label>
            <select
              id="activity-status"
              className={inputCls}
              value={f.status}
              onChange={(e) => changeStatus(e.target.value)}
            >
              {statusOptions.map(s => (
                <option key={s} value={s}>{ACTIVITY_STATUS_LABELS[s]}</option>
              ))}
            </select>
            {!creating && (
              <p className={hintCls}>
                Status may move backwards — correcting a mis-ticked activity is supported.
                Cancelling is a separate action.
              </p>
            )}
          </div>

          <div>
            <label className={labelCls} htmlFor="activity-order">Programme order</label>
            <input
              id="activity-order"
              type="number"
              step="1"
              className={inputCls}
              value={f.sortOrder}
              onChange={(e) => set('sortOrder')(e.target.value)}
            />
            <p className={hintCls}>Lower numbers sit higher in the programme. Not unique.</p>
          </div>

          <div>
            <label className={labelCls} htmlFor="activity-planned-start">
              {f.isMilestone ? 'Milestone date *' : 'Planned start *'}
            </label>
            <input
              id="activity-planned-start"
              type="date"
              className={inputCls}
              value={f.plannedStart}
              onChange={(e) => changePlannedStart(e.target.value)}
            />
          </div>

          {!f.isMilestone && (
            <div>
              <label className={labelCls} htmlFor="activity-planned-finish">Planned finish *</label>
              <input
                id="activity-planned-finish"
                type="date"
                className={inputCls}
                min={f.plannedStart || undefined}
                value={f.plannedFinish}
                onChange={(e) => set('plannedFinish')(e.target.value)}
              />
              <p className={hintCls}>
                Inclusive — the last day of work. Duration: <span className="text-brand-text font-semibold">{durationPreview}</span> (calendar days;
                weekends and public holidays are not modelled).
              </p>
            </div>
          )}

          <div>
            <label className={labelCls} htmlFor="activity-actual-start">Actual start</label>
            <input
              id="activity-actual-start"
              type="date"
              className={inputCls}
              value={f.actualStart}
              onChange={(e) => set('actualStart')(e.target.value)}
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="activity-actual-finish">Actual finish</label>
            <input
              id="activity-actual-finish"
              type="date"
              className={inputCls}
              min={f.actualStart || undefined}
              value={f.actualFinish}
              onChange={(e) => set('actualFinish')(e.target.value)}
            />
          </div>

          <div className="sm:col-span-2">
            {f.isMilestone ? (
              <>
                <label className={labelCls} htmlFor="activity-reached">Milestone</label>
                <select
                  id="activity-reached"
                  className={inputCls}
                  value={Number(f.percentComplete) >= 100 ? '100' : '0'}
                  onChange={(e) => set('percentComplete')(e.target.value)}
                >
                  <option value="0">Not reached (0%)</option>
                  <option value="100">Reached (100%)</option>
                </select>
              </>
            ) : (
              <>
                <label className={labelCls} htmlFor="activity-percent">Progress % *</label>
                <input
                  id="activity-percent"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  className={inputCls}
                  value={f.percentComplete}
                  onChange={(e) => set('percentComplete')(e.target.value)}
                />
                <p className={hintCls}>
                  Whole numbers only. <strong>Manually entered</strong> — Constrapp never derives it from
                  dates or from progress claims, and it feeds no budget, forecast, margin or cash figure.
                </p>
              </>
            )}
          </div>

          <div>
            <label className={labelCls} htmlFor="activity-responsible">Responsible</label>
            <select
              id="activity-responsible"
              className={inputCls}
              value={f.responsibleContactId}
              onChange={(e) => set('responsibleContactId')(e.target.value)}
            >
              <option value="">— Not assigned —</option>
              {contactGroups.mine.length > 0 && (
                <optgroup label="This project">
                  {contactGroups.mine.map(c => (
                    <option key={c.id} value={c.id}>{c.displayName}</option>
                  ))}
                </optgroup>
              )}
              {contactGroups.others.length > 0 && (
                <optgroup label="Other company contacts">
                  {contactGroups.others.map(c => (
                    <option key={c.id} value={c.id}>{c.displayName}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <p className={hintCls}>
              A company Contact (subcontractor, supplier or consultant). Assigning an internal staff
              member is not available — see the note below the programme.
            </p>
          </div>

          <div>
            <label className={labelCls} htmlFor="activity-cost-code">Cost code</label>
            <select
              id="activity-cost-code"
              className={inputCls}
              value={f.costCodeId}
              onChange={(e) => set('costCodeId')(e.target.value)}
            >
              <option value="">— None —</option>
              {activeCostCodes.map(cc => (
                <option key={cc.id} value={cc.id}>
                  {cc.name ? `${cc.code} — ${cc.name}` : cc.code}
                </option>
              ))}
            </select>
            <p className={hintCls}>
              Optional. The commercial link only — it changes no budget, forecast or cash figure.
            </p>
          </div>

          {/* ── Predecessors (ADR-65) ──────────────────────────────────── */}
          <fieldset className="sm:col-span-2 m-0 p-0 border-0 min-w-0">
            <legend className={labelCls}>Predecessors (finish to start)</legend>
            <p className={`${hintCls} mt-0 mb-2`}>
              This activity may start the calendar day after each predecessor&apos;s planned finish, plus the lag
              (a milestone allows the same day). Nothing is rescheduled for you: a start before that is a
              conflict you can save only after acknowledging it.
            </p>

            {f.predecessors.length === 0 ? (
              <p className="m-0 mb-2 text-[12px] text-brand-muted">No predecessors.</p>
            ) : (
              <ul className="m-0 mb-2 p-0 list-none space-y-1.5">
                {f.predecessors.map((e, i) => {
                  const p = byId.get(e.activityId)
                  const live = liveState?.entries.find(x => x.activityId === e.activityId)
                  const unresolved = e.malformed || !p || p.status === ACTIVITY_STATUS.CANCELLED
                  const lag = e.lagDays === '' ? NaN : Number(e.lagDays)
                  const earliest = p && !unresolved ? earliestStartAfter(p, Number.isInteger(lag) ? lag : 0) : null
                  const conflict = conflicts.find(c => c.activityId === e.activityId)
                  return (
                    <li key={`${e.activityId}-${i}`} className={`rounded-lg border px-3 py-2 ${unresolved || conflict ? 'border-brand-amber/50' : 'border-brand-border'}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-[12.5px] text-brand-text font-semibold truncate">
                          {p?.name ?? (e.activityId ? `Unknown activity (${e.activityId})` : 'Malformed entry')}
                          <span className="ml-1.5 text-[10.5px] font-normal text-brand-muted">FS</span>
                        </span>
                        <label className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
                          Lag
                          <input
                            type="number"
                            min="0"
                            max={MAX_LAG_DAYS}
                            step="1"
                            aria-label={`Lag in days after ${p?.name ?? 'the predecessor'}`}
                            className="w-[76px] bg-brand-bg border border-brand-border rounded-lg px-2 py-1.5 text-[12.5px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[36px]"
                            value={e.lagDays}
                            disabled={unresolved}
                            onChange={(ev) => changeLag(i, ev.target.value)}
                          />
                          days
                        </label>
                        <Btn sm variant="ghost" type="button" onClick={() => removePredecessor(i)} aria-label={`Remove predecessor ${p?.name ?? e.activityId}`}>
                          Remove
                        </Btn>
                      </div>
                      <p className={`m-0 mt-1 text-[11px] ${unresolved || conflict ? 'text-brand-amber' : 'text-brand-muted'}`}>
                        {e.malformed
                          ? 'Malformed dependency — remove it and add it again.'
                          : !p
                            ? 'This predecessor is no longer in the programme — dependency requires review. Remove it or replace it.'
                            : p.status === ACTIVITY_STATUS.CANCELLED
                              ? 'This predecessor was cancelled — dependency requires review. Remove it or replace it.'
                              : conflict
                                ? `Conflict: earliest permitted start ${formatIsoDate(earliest)}, planned start ${formatIsoDate(f.plannedStart)}.`
                                : earliest
                                  ? `Earliest permitted start ${formatIsoDate(earliest)}${live && live.state !== 'valid' ? ` · ${DEPENDENCY_STATE_LABELS[live.state]}` : ''}${p.status === ACTIVITY_STATUS.COMPLETED ? ' · finished' : ''}`
                                  : 'The predecessor has no usable planned finish.'}
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <label className={labelCls} htmlFor="activity-add-predecessor">Add predecessor</label>
                <select
                  id="activity-add-predecessor"
                  className={inputCls}
                  value={candidate}
                  onChange={(e) => setCandidate(e.target.value)}
                  disabled={f.predecessors.length >= MAX_PREDECESSORS}
                >
                  <option value="">— Choose an activity —</option>
                  {candidates.map(c => (
                    <option key={c.id} value={c.id} disabled={Boolean(c.reason)}>
                      {c.name}{c.reason ? ` — ${c.reason.toLowerCase()}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <Btn variant="ghost" type="button" onClick={addPredecessor} disabled={!candidate || f.predecessors.length >= MAX_PREDECESSORS}>
                Add
              </Btn>
            </div>
            <p className={hintCls}>
              Up to {MAX_PREDECESSORS}. Activities that would create a cycle, are cancelled, or are already listed cannot be chosen.
              Only activities in this project&apos;s programme can be predecessors.
            </p>

            {conflicts.length > 0 && (
              <div className="mt-3 rounded-lg border border-brand-amber/50 bg-brand-amber/5 px-3 py-2.5" role="alert">
                <p className="m-0 text-[12px] text-brand-amber font-semibold">
                  Starts before {conflicts.length === 1 ? 'a predecessor allows' : `${conflicts.length} predecessors allow`}.
                </p>
                <ul className="m-0 mt-1 pl-4 text-[11.5px] text-brand-amber">
                  {conflicts.map(c => (
                    <li key={c.activityId}>{c.name}: earliest permitted start {formatIsoDate(c.earliestStart)}</li>
                  ))}
                </ul>
                <label className="mt-2 flex items-center gap-2 text-[12px] text-brand-text cursor-pointer min-h-[44px]">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAckKey(e.target.checked ? currentAckKey : null)}
                  />
                  I understand this activity is planned to start before its predecessors finish, and I want to save it anyway.
                </label>
                <p className="m-0 text-[10.5px] text-brand-muted">
                  The acknowledgement resets if the start date or the predecessors change. It is a confirmation in this
                  form only — nothing is rescheduled, and the chart will show the conflict.
                </p>
              </div>
            )}
          </fieldset>

          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="activity-description">Description</label>
            <input
              id="activity-description"
              className={inputCls}
              maxLength={LIMITS.description}
              placeholder="Optional"
              value={f.description}
              onChange={(e) => set('description')(e.target.value)}
            />
          </div>

          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="activity-notes">Notes</label>
            <input
              id="activity-notes"
              className={inputCls}
              maxLength={LIMITS.notes}
              placeholder={f.status === ACTIVITY_STATUS.ON_HOLD ? 'Why is this on hold?' : 'Optional'}
              value={f.notes}
              onChange={(e) => set('notes')(e.target.value)}
            />
            {f.status === ACTIVITY_STATUS.ON_HOLD && (
              <p className={hintCls}>On hold keeps the progress recorded — record the blocker here.</p>
            )}
          </div>
        </div>

        {error && (
          <div className="mt-3" role="alert">
            <p className="m-0 text-[12px] text-brand-red">{error}</p>
            {stale && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Btn sm variant="ghost" type="button" onClick={reloadLatest} disabled={!latest}>
                  Reload latest
                </Btn>
                <span className="text-[11px] text-brand-muted">
                  {latest
                    ? 'Replaces the form with the current record. Your unsaved edits above are discarded only when you choose this.'
                    : 'The activity is no longer in the programme.'}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn type="submit" disabled={saving}>
            {saving ? 'Saving…' : creating ? 'Add activity' : 'Save activity'}
          </Btn>
        </div>
      </form>
    </ActivityDialog>
  )
}
