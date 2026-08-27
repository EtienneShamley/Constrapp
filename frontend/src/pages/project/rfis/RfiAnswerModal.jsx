import { useState } from 'react'
import Btn from '../../../components/Btn'
import { todayIso } from '../../../lib/payments'
import { LIMITS, validateAnswer, formatIsoDate } from '../../../lib/rfis'
import RfiModalShell, { inputCls, labelCls, hintCls } from './RfiModalShell'

// ── Answer an RFI (open → answered) ──────────────────────────────────────────
//
// Records the answer AND the AUTHORED date it was received — the real-world
// date on the correspondence, kept separate from the system stamp
// (`answeredAt`). Response time is measured between the authored dates.
//
// ⚠️ THE ANSWER IS FINAL. There is no reopen and no answer revision: once
// recorded it is frozen by rules. An unsatisfactory answer is closed with a
// note saying so, and a new RFI is raised.

export default function RfiAnswerModal({ rfi, onAnswer, onClose }) {
  const [answer, setAnswer]         = useState('')
  const [answerDate, setAnswerDate] = useState(todayIso())
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    const gateError = validateAnswer({ answer, answerDate }, rfi)
    if (gateError) { setError(gateError); return }
    setSaving(true); setError(null)
    try {
      await onAnswer(rfi, { answer, answerDate })
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to record the answer. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <RfiModalShell title={`Answer ${rfi?.rfiNumber}`} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="p-5">
        <p className="m-0 mb-1 text-[13px] font-bold text-brand-text">{rfi?.title}</p>
        <p className="m-0 mb-3 text-[11.5px] text-brand-muted">
          Raised {formatIsoDate(rfi?.raisedDate)} · due {formatIsoDate(rfi?.dueDate)} · {rfi?.assignedToName || 'unassigned'}
        </p>
        <div className="border border-brand-border rounded-lg p-3 mb-4">
          <p className="m-0 text-[12px] text-brand-text-soft whitespace-pre-wrap">{rfi?.question}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="rfi-answer">Answer *</label>
            <textarea
              id="rfi-answer"
              className={`${inputCls} min-h-[140px]`}
              maxLength={LIMITS.answer}
              placeholder="Transcribe the answer as received."
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="rfi-answer-date">Answer date *</label>
            <input
              id="rfi-answer-date"
              type="date"
              className={inputCls}
              min={rfi?.raisedDate || undefined}
              value={answerDate}
              onChange={(e) => setAnswerDate(e.target.value)}
            />
            <p className={hintCls}>The date the answer was received — not today unless it arrived today.</p>
          </div>
        </div>

        <div className="border border-brand-amber/40 rounded-lg p-3 mt-4">
          <p className="m-0 text-[12px] text-brand-amber">
            ⚠ The answer is recorded once and cannot be edited or reopened. If it turns out to be
            insufficient, close this RFI with a note and raise a new one.
          </p>
        </div>

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red">{error}</p>}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
          <Btn type="submit" disabled={saving}>{saving ? 'Recording…' : 'Record answer'}</Btn>
        </div>
      </form>
    </RfiModalShell>
  )
}
