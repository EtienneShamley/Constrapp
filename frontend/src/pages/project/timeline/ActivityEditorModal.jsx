import { useMemo, useState } from 'react'
import Btn from '../../../components/Btn'
import { todayIso } from '../../../lib/payments'
import {
  ACTIVITY_STATUS, ACTIVITY_STATUS_ORDER, ACTIVITY_STATUS_LABELS,
  CREATABLE_STATUSES, LIMITS,
  validateActivityDraft, durationLabel, nextSortOrder,
} from '../../../lib/projectTimeline'

// ── Activity editor (create / edit) ──────────────────────────────────────────
//
// Authors ONE programme activity. Pure UI over lib/projectTimeline.js
// validation — every rule shown here has a counterpart in the `activities`
// block of firestore.rules, so the form can never assemble a document the
// server rejects for a reason the user cannot see.
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

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const hintCls  = 'm-0 mt-1 text-[10.5px] text-brand-muted'

function ModalShell({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[680px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export default function ActivityEditorModal({
  activity,        // existing activity when editing, null when creating
  activities,      // the whole programme — for the next sortOrder only
  contacts,        // active company contacts
  costCodes,       // active company cost codes
  projectId,
  onSave,          // async (fields) => void
  onClose,
}) {
  const creating = !activity
  const today = todayIso()

  const [name, setName]                 = useState(activity?.name ?? '')
  const [description, setDescription]   = useState(activity?.description ?? '')
  const [isMilestone, setIsMilestone]   = useState(activity?.isMilestone === true)
  const [status, setStatus]             = useState(activity?.status ?? ACTIVITY_STATUS.NOT_STARTED)
  const [plannedStart, setPlannedStart]   = useState(activity?.plannedStart ?? '')
  const [plannedFinish, setPlannedFinish] = useState(activity?.plannedFinish ?? '')
  const [actualStart, setActualStart]     = useState(activity?.actualStart ?? '')
  const [actualFinish, setActualFinish]   = useState(activity?.actualFinish ?? '')
  const [percentComplete, setPercentComplete] = useState(String(activity?.percentComplete ?? 0))
  const [responsibleContactId, setResponsibleContactId] = useState(activity?.responsibleContactId ?? '')
  const [costCodeId, setCostCodeId]     = useState(activity?.costCodeId ?? '')
  const [sortOrder, setSortOrder]       = useState(
    String(activity?.sortOrder ?? nextSortOrder(activities)),
  )
  const [notes, setNotes]               = useState(activity?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

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
    setIsMilestone(checked)
    if (checked) {
      setPlannedFinish(plannedStart)
      setPercentComplete(Number(percentComplete) >= 100 ? '100' : '0')
    }
  }

  const changePlannedStart = (value) => {
    setPlannedStart(value)
    if (isMilestone) setPlannedFinish(value)
    // Keep a nonsensical span from being the default: nudge the finish forward
    // rather than silently accepting an inverted one.
    else if (plannedFinish && value && plannedFinish < value) setPlannedFinish(value)
  }

  // Picking a status fills in what that status REQUIRES, visibly.
  const changeStatus = (value) => {
    setStatus(value)
    if (value === ACTIVITY_STATUS.NOT_STARTED) {
      setPercentComplete('0')
      setActualStart('')
      setActualFinish('')
    }
    if (value === ACTIVITY_STATUS.IN_PROGRESS) {
      if (!actualStart) setActualStart(today)
      setActualFinish('')
      if (isMilestone) setPercentComplete('0')
    }
    if (value === ACTIVITY_STATUS.COMPLETED) {
      setPercentComplete('100')
      if (!actualFinish) setActualFinish(today)
    }
  }

  const fields = {
    name,
    description,
    isMilestone,
    status,
    plannedStart,
    plannedFinish: isMilestone ? plannedStart : plannedFinish,
    actualStart:  actualStart  || null,
    actualFinish: actualFinish || null,
    percentComplete: percentComplete === '' ? NaN : Number(percentComplete),
    responsibleContactId: responsibleContactId || null,
    responsibleName: responsibleContactId ? contactName(responsibleContactId) : '',
    costCodeId: costCodeId || null,
    costCodeName: costCodeId ? costCodeLabel(costCodeId) : '',
    sortOrder: Number(sortOrder),
    notes,
  }

  const statusOptions = creating ? CREATABLE_STATUSES : ACTIVITY_STATUS_ORDER.filter(
    s => s !== ACTIVITY_STATUS.CANCELLED,
  )

  const durationPreview = durationLabel({
    isMilestone,
    plannedStart,
    plannedFinish: isMilestone ? plannedStart : plannedFinish,
  })

  async function handleSubmit(e) {
    e.preventDefault()
    const validationError = validateActivityDraft(fields, { creating })
    if (validationError) { setError(validationError); return }
    setSaving(true); setError(null)
    try {
      await onSave(fields)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell title={creating ? 'Add activity' : 'Edit activity'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="activity-name">Activity name *</label>
            <input
              id="activity-name"
              className={inputCls}
              maxLength={LIMITS.name}
              placeholder="e.g. Ground floor slab pour"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="sm:col-span-2">
            <label className="flex items-start gap-2 cursor-pointer min-h-[44px] items-center">
              <input
                type="checkbox"
                checked={isMilestone}
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
              value={status}
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
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
            <p className={hintCls}>Lower numbers sit higher in the programme. Not unique.</p>
          </div>

          <div>
            <label className={labelCls} htmlFor="activity-planned-start">
              {isMilestone ? 'Milestone date *' : 'Planned start *'}
            </label>
            <input
              id="activity-planned-start"
              type="date"
              className={inputCls}
              value={plannedStart}
              onChange={(e) => changePlannedStart(e.target.value)}
            />
          </div>

          {!isMilestone && (
            <div>
              <label className={labelCls} htmlFor="activity-planned-finish">Planned finish *</label>
              <input
                id="activity-planned-finish"
                type="date"
                className={inputCls}
                min={plannedStart || undefined}
                value={plannedFinish}
                onChange={(e) => setPlannedFinish(e.target.value)}
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
              value={actualStart}
              onChange={(e) => setActualStart(e.target.value)}
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="activity-actual-finish">Actual finish</label>
            <input
              id="activity-actual-finish"
              type="date"
              className={inputCls}
              min={actualStart || undefined}
              value={actualFinish}
              onChange={(e) => setActualFinish(e.target.value)}
            />
          </div>

          <div className="sm:col-span-2">
            {isMilestone ? (
              <>
                <label className={labelCls} htmlFor="activity-reached">Milestone</label>
                <select
                  id="activity-reached"
                  className={inputCls}
                  value={Number(percentComplete) >= 100 ? '100' : '0'}
                  onChange={(e) => setPercentComplete(e.target.value)}
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
                  value={percentComplete}
                  onChange={(e) => setPercentComplete(e.target.value)}
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
              value={responsibleContactId}
              onChange={(e) => setResponsibleContactId(e.target.value)}
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
              value={costCodeId}
              onChange={(e) => setCostCodeId(e.target.value)}
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

          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="activity-description">Description</label>
            <input
              id="activity-description"
              className={inputCls}
              maxLength={LIMITS.description}
              placeholder="Optional"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="activity-notes">Notes</label>
            <input
              id="activity-notes"
              className={inputCls}
              maxLength={LIMITS.notes}
              placeholder={status === ACTIVITY_STATUS.ON_HOLD ? 'Why is this on hold?' : 'Optional'}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            {status === ACTIVITY_STATUS.ON_HOLD && (
              <p className={hintCls}>On hold keeps the progress recorded — record the blocker here.</p>
            )}
          </div>
        </div>

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red">{error}</p>}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
          <Btn type="submit" disabled={saving}>
            {saving ? 'Saving…' : creating ? 'Add activity' : 'Save activity'}
          </Btn>
        </div>
      </form>
    </ModalShell>
  )
}
