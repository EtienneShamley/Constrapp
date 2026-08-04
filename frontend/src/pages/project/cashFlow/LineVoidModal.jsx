import { useState } from 'react'
import Btn from '../../../components/Btn'
import { formatCurrency } from '../../../lib/formatters'
import { monthLabel, CFL_SOURCE_TYPE_LABELS } from '../../../lib/cashFlow'

// ── Void a Cash Flow timing line ─────────────────────────────────────────────
//
// Void is terminal and requires a non-whitespace reason — rules-enforced. The
// line is never deleted: it is retained forecast history (and remains
// currency-lock evidence), contributing nothing to any month or coverage.

export default function LineVoidModal({ line, currencyCode, onConfirm, onClose }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!reason.trim()) { setError('Enter a reason for voiding this timing line.'); return }
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
          <h2 className="text-[15px] font-bold text-brand-text m-0">Void timing line</h2>
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
            {monthLabel(line.monthKey)} · {CFL_SOURCE_TYPE_LABELS[line.sourceType] ?? line.sourceType} ·{' '}
            <span className="font-semibold">{formatCurrency(line.amount, currencyCode)}</span>
          </p>
          <p className="m-0 mt-1.5 text-[11.5px] text-brand-muted">
            Voiding is permanent. The line is kept as forecast history and stops counting toward every
            month, coverage, and peak-funding figure. Nothing else changes.
          </p>
          <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mt-4 mb-1.5">
            Reason *
          </label>
          <input
            className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
            placeholder="e.g. Superseded by a revised split"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {error && <p className="m-0 mt-2 text-[12px] text-brand-red">{error}</p>}
          <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
            <Btn variant="danger" type="submit" disabled={saving}>{saving ? 'Voiding…' : 'Void line'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
