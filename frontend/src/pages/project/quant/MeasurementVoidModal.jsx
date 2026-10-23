import { useState } from 'react'
import Btn from '../../../components/Btn'
import { inputCls, labelCls } from './styles'
import { KIND_LABELS } from '../../../lib/quant'
import QuantDialog from './QuantDialog'

// ── Void a measurement ───────────────────────────────────────────────────────
//
// Void is terminal and requires a non-whitespace reason — rules-enforced. The
// record is never deleted: it stays as takeoff history, drawn no more and
// counted in no summary. Dialog semantics, Escape (not while voiding), focus
// containment and focus return come from QuantDialog (ADR-53).

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
    <QuantDialog title="Void measurement" titleId="quant-void-title" onClose={onClose} busy={saving} panelClassName="max-w-[480px]">
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
    </QuantDialog>
  )
}
