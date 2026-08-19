import { useState } from 'react'
import Btn from '../../../components/Btn'
import { inputCls, labelCls, modalShellCls, modalCardCls } from './styles'
import { validateWithdrawReason } from '../../../lib/projectDocuments'

// Withdrawal with a MANDATORY, non-whitespace reason.
//
// Used for general documents and for withdrawing a drawing master that has no
// current revision. Both are the same question — "why is this being recalled?" —
// so they share one modal. Withdrawing a drawing REVISION is a different
// question (it also needs a succession decision) and has its own modal.
//
// There is no delete anywhere in this feature. A withdrawn record and its file
// are retained; only their status changes.
export default function DocumentWithdrawModal({
  title, subtitle, body, onWithdraw, onClose,
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()

    const reasonError = validateWithdrawReason(reason)
    if (reasonError) { setError(reasonError); return }

    setSaving(true)
    setError(null)
    try {
      await onWithdraw(reason)
      onClose()
    } catch (err) {
      setError(err.message || 'Could not withdraw this record. Try again.')
      setSaving(false)
    }
  }

  return (
    <div className={modalShellCls}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`${modalCardCls} max-w-[480px]`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-brand-text m-0">{title}</h2>
            {subtitle && <p className="text-[12px] text-brand-muted mt-0.5 mb-0 break-words">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          <p className="text-[12px] text-brand-muted m-0">
            {body ?? 'Withdrawing is permanent and cannot be undone. The record and its file are kept as history, marked WITHDRAWN — do not use.'}
          </p>

          <div>
            <label className={labelCls}>Reason <span className="text-brand-red">*</span></label>
            <textarea
              className={inputCls}
              rows={3}
              placeholder="Why is this being withdrawn?"
              value={reason}
              onChange={e => setReason(e.target.value)}
              required
              autoFocus
            />
          </div>

          {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn variant="danger" type="submit" sm disabled={saving}>
              {saving ? 'Withdrawing…' : 'Withdraw'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
