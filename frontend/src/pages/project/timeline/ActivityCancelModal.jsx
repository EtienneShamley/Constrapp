import { useState } from 'react'
import Btn from '../../../components/Btn'
import { formatIsoDate, validateCancelReason, LIMITS } from '../../../lib/projectTimeline'

// ── Cancel an activity (terminal) ────────────────────────────────────────────
//
// Cancellation is the ONLY exit from the programme — there is no hard delete
// anywhere in Constrapp (ADR-12 posture), and `activities` is no exception:
// `allow delete: if false`. A cancelled activity is retained programme history
// that stops counting as outstanding work.
//
// It is TERMINAL and it requires a NON-WHITESPACE reason — enforced here, in
// the hook, AND by Firestore rules, which additionally restrict the write to
// the cancellation keys so no content edit can ride along with it.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'

export default function ActivityCancelModal({ activity, onCancelActivity, onClose }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    const reasonError = validateCancelReason(reason)
    if (reasonError) { setError(reasonError); return }
    setSaving(true); setError(null)
    try {
      await onCancelActivity(activity, reason)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to cancel. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[520px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">Cancel activity</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5">
          <p className="m-0 mb-1 text-[13px] font-bold text-brand-text">{activity?.name}</p>
          <p className="m-0 mb-4 text-[11.5px] text-brand-muted">
            Planned {formatIsoDate(activity?.plannedStart)} → {formatIsoDate(activity?.plannedFinish)}
          </p>

          <div className="border border-brand-amber/40 rounded-lg p-3 mb-4">
            <p className="m-0 text-[12px] text-brand-amber">
              ⚠ Cancelling is permanent. The activity stays on the record as cancelled history — it cannot
              be reopened, edited or deleted afterwards, and it stops counting as outstanding work.
            </p>
          </div>

          <label className={labelCls} htmlFor="cancel-reason">Reason *</label>
          <input
            id="cancel-reason"
            className={inputCls}
            maxLength={LIMITS.cancelReason}
            placeholder="e.g. Scope removed by client variation CV-0004"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="m-0 mt-1 text-[10.5px] text-brand-muted">
            Recorded against the activity with your name and the server time.
          </p>

          {error && <p className="m-0 mt-3 text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose}>Keep activity</Btn>
            <Btn variant="danger" type="submit" disabled={saving}>
              {saving ? 'Cancelling…' : 'Cancel activity'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
