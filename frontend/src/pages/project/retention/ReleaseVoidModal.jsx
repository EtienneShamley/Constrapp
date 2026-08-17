import { useState } from 'react'
import Btn from '../../../components/Btn'
import { formatCurrency } from '../../../lib/formatters'
import { RR_STATUS } from '../../../lib/retention'

// ── Void a Retention Release ─────────────────────────────────────────────────
//
// Void is terminal and requires a non-whitespace reason — enforced here AND by
// Firestore rules. A release is never deleted (ADR-12): it is retained audit
// history (and remains currency-lock evidence).
//
// Because the released amount is DERIVED at read time, voiding needs no
// reversal, credit note, or adjustment document — the invoice's payable drops
// back at the next render and the amount returns to retention held. The supplier
// invoice itself is never touched in either direction.

export default function ReleaseVoidModal({ release, currencyCode, onConfirm, onClose }) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)
  const wasPosted = release.status === RR_STATUS.POSTED

  async function submit(e) {
    e.preventDefault()
    if (!reason.trim()) { setError('Enter a reason for voiding this retention release.'); return }
    setSaving(true); setError(null)
    try {
      await onConfirm(reason)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to void. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[480px] bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">Void retention release</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>
        <form onSubmit={submit} className="p-5">
          <p className="m-0 text-[12.5px] text-brand-text">
            <span className="font-semibold">{release.releaseNumber}</span> · {release.invoiceNumber} ·{' '}
            <span className="font-semibold">{money(release.releaseTotal)}</span>
          </p>
          <p className="m-0 mt-1.5 text-[11.5px] text-brand-muted">
            {wasPosted
              ? `Voiding is permanent. ${money(release.releaseTotal)} stops being payable on ${release.invoiceNumber} and returns to retention held — the invoice's Remaining Payable and the AP ageing update at the next render.`
              : 'Voiding is permanent. This draft has released nothing, so no balance changes.'}
          </p>
          <p className="m-0 mt-1.5 text-[11.5px] text-brand-muted">
            The release is kept as audit history and is never deleted. No reversal or credit note is created,
            and the supplier invoice is not modified — its retention figures have never changed.
          </p>
          <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mt-4 mb-1.5">
            Reason *
          </label>
          <input
            className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
            placeholder="e.g. Released against the wrong invoice"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {error && <p className="m-0 mt-2 text-[12px] text-brand-red">{error}</p>}
          <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
            <Btn variant="danger" type="submit" disabled={saving}>{saving ? 'Voiding…' : 'Void release'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
