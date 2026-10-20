import { useState } from 'react'
import Btn from '../../../components/Btn'
import { inputCls, labelCls, modalShellCls, modalCardCls } from './styles'
import { KIND_LABELS } from '../../../lib/quant'

// ── Void a measurement ───────────────────────────────────────────────────────
//
// Void is terminal and requires a non-whitespace reason — rules-enforced. The
// record is never deleted: it stays as takeoff history, drawn no more and
// counted in no summary.

export default function MeasurementVoidModal({ measurement, onConfirm, onClose }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!reason.trim()) { setError('Enter a reason for voiding this measurement.'); return }
    setSaving(true); setError(null)
    try {
      await onConfirm(reason)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to void. Nothing was changed.')
      setSaving(false)
    }
  }

  return (
    <div className={modalShellCls}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`${modalCardCls} max-w-[480px]`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">Void measurement</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>
        <form onSubmit={submit} className="p-5">
          <p className="m-0 text-[12.5px] text-brand-text">
            <span className="font-semibold">{measurement.label}</span> · {KIND_LABELS[measurement.kind]} · {measurement.costCodeName}
          </p>
          <p className="m-0 mt-1.5 text-[11.5px] text-brand-muted">
            Voiding is permanent. The measurement is kept as takeoff history and is no longer drawn or summed.
            Nothing else changes — Quant never writes a BOQ quantity or a financial figure.
          </p>
          <label className={`${labelCls} mt-4`} htmlFor="quant-void-reason">Reason *</label>
          <input
            id="quant-void-reason"
            className={inputCls}
            placeholder="e.g. Measured the wrong room"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
          {error && <p className="m-0 mt-2 text-[12px] text-brand-red" role="alert">{error}</p>}
          <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} disabled={saving}>Cancel</Btn>
            <Btn variant="danger" type="submit" disabled={saving}>{saving ? 'Voiding…' : 'Void measurement'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
