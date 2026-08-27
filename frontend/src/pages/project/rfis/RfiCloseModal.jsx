import { useState } from 'react'
import Btn from '../../../components/Btn'
import { LIMITS, validateClose, formatIsoDate } from '../../../lib/rfis'
import RfiModalShell, { inputCls, labelCls, hintCls } from './RfiModalShell'

// ── Close an RFI (answered → closed, terminal) ───────────────────────────────
//
// The only exit from `answered`. Closing is TERMINAL: nothing on the RFI can
// change afterwards. The optional close-out note is where an unsatisfactory
// answer is recorded ("answer insufficient — raised RFI-0012 instead"), because
// there is no reopen.

export default function RfiCloseModal({ rfi, onCloseRfi, onClose }) {
  const [note, setNote]     = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    const gateError = validateClose(note, rfi)
    if (gateError) { setError(gateError); return }
    setSaving(true); setError(null)
    try {
      await onCloseRfi(rfi, note)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to close. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <RfiModalShell title={`Close ${rfi?.rfiNumber}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-5">
        <p className="m-0 mb-1 text-[13px] font-bold text-brand-text">{rfi?.title}</p>
        <p className="m-0 mb-3 text-[11.5px] text-brand-muted">
          Answered {formatIsoDate(rfi?.answerDate)}
        </p>
        <div className="border border-brand-border rounded-lg p-3 mb-4">
          <p className="m-0 text-[10.5px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Answer</p>
          <p className="m-0 text-[12px] text-brand-text-soft whitespace-pre-wrap">{rfi?.answer}</p>
        </div>

        <label className={labelCls} htmlFor="rfi-close-note">Close-out note</label>
        <textarea
          id="rfi-close-note"
          className={`${inputCls} min-h-[90px]`}
          maxLength={LIMITS.closeOutNote}
          placeholder="Optional — e.g. Answer accepted; or Answer insufficient, raised RFI-0012 instead."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className={hintCls}>Recorded with your name and the server time.</p>

        <div className="border border-brand-amber/40 rounded-lg p-3 mt-4">
          <p className="m-0 text-[12px] text-brand-amber">
            ⚠ Closing is permanent. The RFI cannot be reopened, edited or deleted afterwards.
          </p>
        </div>

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red">{error}</p>}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose}>Keep open</Btn>
          <Btn type="submit" disabled={saving}>{saving ? 'Closing…' : 'Close RFI'}</Btn>
        </div>
      </form>
    </RfiModalShell>
  )
}
