import { useMemo, useState } from 'react'
import Btn from '../../../components/Btn'
import ActivityDialog from './ActivityDialog'
import {
  BASELINE_LIMITS, buildCapturePayload, validateBaselineDraft,
} from '../../../lib/ganttBaseline'
import { BASELINE_ERROR } from '../../../lib/programmeBaselineActions'

// ── Capture a programme baseline — preview, then a DRAFT (ADR-66) ────────────
//
// Step one of the workflow: Create baseline → PREVIEW → Capture draft →
// Review → Approve or Withdraw → Compare. The preview is computed from the
// programme AS LOADED (the page's listener) so the user sees what will be
// captured — how many activities, how many are cancelled history, how many
// milestones, the estimated size — and every record that would REFUSE the
// capture, named with its reason. Nothing is ever excluded or truncated
// silently: an invalid activity blocks the capture until it is corrected.
//
// The capture itself (useProgrammeBaselines → lib/programmeBaselineActions.js)
// re-reads the programme FROM THE SERVER and writes the header + snapshot
// pair in one transaction; this dialog only collects the name and reason and
// shows the outcome. A draft is NOT an approved baseline.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const hintCls  = 'm-0 mt-1 text-[10.5px] text-brand-muted'

function Fact({ label, value }) {
  return (
    <div className="rounded-lg bg-brand-bg/60 px-3 py-2">
      <p className="m-0 text-[10px] font-bold uppercase tracking-[0.4px] text-brand-muted">{label}</p>
      <p className="m-0 mt-0.5 text-[15px] font-black tabular-nums text-brand-text">{value}</p>
    </div>
  )
}

export default function BaselineCaptureModal({ activities, approvedCount = 0, onCapture, onClose }) {
  const [name, setName]     = useState(approvedCount === 0 ? 'Original programme' : 'Revised programme')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)
  const [problems, setProblems] = useState([])   // the records a refused capture named

  // The preview — from the loaded programme; the capture re-reads the server.
  const preview = useMemo(() => buildCapturePayload(activities), [activities])

  async function handleSubmit(e) {
    e.preventDefault()
    const draftError = validateBaselineDraft({ name, reason })
    if (draftError) { setError(draftError); return }
    if (!preview.ok) { setError(preview.refusal); return }
    setSaving(true); setError(null); setProblems([])
    try {
      const result = await onCapture({ name, reason })
      onClose(result)
    } catch (err) {
      setError(err?.message || 'The baseline could not be captured. Nothing was written.')
      if (err?.kind === BASELINE_ERROR.INVALID && Array.isArray(err?.details?.errors)) setProblems(err.details.errors)
      setSaving(false)
    }
  }

  const kb = Math.max(1, Math.round(preview.bytes / 1024))

  return (
    <ActivityDialog title="Capture programme baseline" titleId="baseline-capture-title" onClose={() => onClose(null)} busy={saving} panelClassName="max-w-[620px]">
      <form onSubmit={handleSubmit} className="p-5">
        <p className="m-0 mb-3 text-[12px] text-brand-text-soft">
          A baseline is a copy of the programme&apos;s planned dates as they stand <strong className="text-brand-text">now</strong>,
          saved as a draft for approval. Once approved it never changes; the current programme stays editable and
          is compared against it. It is planning evidence — not a contractual programme acceptance or an
          extension-of-time entitlement.
        </p>

        {/* ── Preview ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
          <Fact label="Activities" value={preview.counts.captured} />
          <Fact label="Cancelled history" value={preview.counts.cancelledAtCapture} />
          <Fact label="Milestones" value={preview.counts.milestones} />
          <Fact label="Estimated size" value={`${kb} KB`} />
        </div>
        <p className={hintCls}>
          Every activity is captured as stored, including cancelled history with its status (shown as history,
          never as a new delay). Preview from the programme as loaded — the capture re-reads it from the server.
          A single baseline may hold up to {BASELINE_LIMITS.entries} activities within {Math.round(preview.byteCeiling / 1024)} KB.
        </p>

        {!preview.ok && (
          <div className="border border-brand-amber/40 rounded-lg p-3 mt-3" role="alert">
            <p className="m-0 text-[12px] text-brand-amber font-semibold">{preview.refusal}</p>
            {preview.errors.length > 0 && (
              <ul className="m-0 mt-1.5 pl-4 text-[11.5px] text-brand-amber space-y-0.5">
                {preview.errors.slice(0, 20).map(p => <li key={`${p.activityId}-${p.reason}`}>{p.reason}</li>)}
                {preview.errors.length > 20 && <li>… and {preview.errors.length - 20} more</li>}
              </ul>
            )}
          </div>
        )}

        {/* ── Name and reason ───────────────────────────────────────── */}
        <div className="mt-4">
          <label className={labelCls} htmlFor="baseline-name">Baseline name *</label>
          <input
            id="baseline-name"
            className={inputCls}
            autoFocus
            maxLength={BASELINE_LIMITS.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="mt-3">
          <label className={labelCls} htmlFor="baseline-reason">Reason *</label>
          <textarea
            id="baseline-reason"
            className={`${inputCls} min-h-[72px]`}
            maxLength={BASELINE_LIMITS.reason}
            placeholder={approvedCount === 0
              ? 'e.g. Contract programme as agreed at award'
              : 'e.g. Re-baselined after approved client variation CV-0004 and the revised access date'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className={hintCls}>
            Recorded with the draft, with your name and the server time. {approvedCount > 0 && 'Approving a new baseline keeps every earlier approved baseline unchanged.'}
          </p>
        </div>

        {error && (
          <div className="mt-3" role="alert">
            <p className="m-0 text-[12px] text-brand-red">{error}</p>
            {problems.length > 0 && (
              <ul className="m-0 mt-1 pl-4 text-[11.5px] text-brand-red space-y-0.5">
                {problems.slice(0, 20).map(p => <li key={`${p.activityId}-${p.reason}`}>{p.reason}</li>)}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={() => onClose(null)} disabled={saving}>Cancel</Btn>
          <Btn type="submit" disabled={saving || !preview.ok}>
            {saving ? 'Capturing…' : 'Capture draft baseline'}
          </Btn>
        </div>
      </form>
    </ActivityDialog>
  )
}
