import { useState } from 'react'
import Btn from '../../../components/Btn'
import { LIMITS, RFI_STATUS_LABELS, validateCancel } from '../../../lib/rfis'
import RfiModalShell, { inputCls, labelCls, hintCls } from './RfiModalShell'

// ── Cancel an RFI (draft/open → cancelled, terminal) ─────────────────────────
//
// For a mistaken or duplicate question. NOT available once answered — an
// answered question was not a mistake to ask, so its only exit is to close it
// with a note. There is no hard delete anywhere in Constrapp (ADR-12), and
// `rfis` is no exception: a cancelled RFI is retained history.
//
// TERMINAL, and it requires a NON-WHITESPACE reason — enforced here, in the
// hook, AND by Firestore rules, which additionally restrict the write to the
// cancellation keys so no content edit can ride along.

export default function RfiCancelModal({ rfi, onCancelRfi, onClose }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    const gateError = validateCancel(reason, rfi)
    if (gateError) { setError(gateError); return }
    setSaving(true); setError(null)
    try {
      await onCancelRfi(rfi, reason)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to cancel. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <RfiModalShell title={`Cancel ${rfi?.rfiNumber}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-5">
        <p className="m-0 mb-1 text-[13px] font-bold text-brand-text">{rfi?.title}</p>
        <p className="m-0 mb-4 text-[11.5px] text-brand-muted">
          Currently {RFI_STATUS_LABELS[rfi?.status] ?? rfi?.status}
        </p>

        <div className="border border-brand-amber/40 rounded-lg p-3 mb-4">
          <p className="m-0 text-[12px] text-brand-amber">
            ⚠ Cancelling is permanent. The RFI stays on the record as cancelled — it cannot be reopened,
            edited or deleted afterwards, and its number is never reused.
          </p>
        </div>

        <label className={labelCls} htmlFor="rfi-cancel-reason">Reason *</label>
        <input
          id="rfi-cancel-reason"
          className={inputCls}
          maxLength={LIMITS.cancelReason}
          placeholder="e.g. Duplicate of RFI-0003"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className={hintCls}>Recorded against the RFI with your name and the server time.</p>

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red">{error}</p>}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose}>Keep RFI</Btn>
          <Btn variant="danger" type="submit" disabled={saving}>{saving ? 'Cancelling…' : 'Cancel RFI'}</Btn>
        </div>
      </form>
    </RfiModalShell>
  )
}
