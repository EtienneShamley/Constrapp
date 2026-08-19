import { useState } from 'react'
import Btn from '../../../components/Btn'
import { inputCls, labelCls, modalShellCls, modalCardCls } from './styles'
import { reinstatableRevisions, validateWithdrawReason } from '../../../lib/drawings'

// Withdraws ONE drawing revision. Nothing is ever deleted — a withdrawn
// revision stays in the register, marked "do not use".
//
// ⚠️ WITHDRAWING THE CURRENT REVISION FORCES AN EXPLICIT DECISION. The app never
// picks a replacement: "the next one down" is an ordering, not a decision about
// what the site should build from. The user must either nominate an earlier
// revision to reinstate, or state that there is no replacement — which withdraws
// the drawing itself and leaves it with no current revision.
//
// A separate modal from DocumentWithdrawModal on purpose: that one asks for a
// reason, this one asks for a reason AND a succession decision. Merging them
// would produce one component with two disjoint modes.
export default function RevisionWithdrawModal({
  drawing, revision, revisions, onWithdraw, onClose,
}) {
  const isCurrent = drawing?.currentRevisionId === revision.id
  const candidates = reinstatableRevisions(revisions, revision.id)

  const [withdrawReason, setWithdrawReason] = useState('')
  // '' = undecided, 'none' = no replacement, otherwise a revision id. Starts
  // undecided so no succession can happen by simply not looking.
  const [replacement, setReplacement] = useState('')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()

    const reasonError = validateWithdrawReason(withdrawReason)
    if (reasonError) { setError(reasonError); return }
    if (isCurrent && replacement === '') {
      setError('Choose whether an earlier revision is reinstated, or that there is no replacement')
      return
    }

    setSaving(true)
    setError(null)
    try {
      await onWithdraw({
        withdrawReason,
        reinstateRevisionId: isCurrent && replacement !== 'none' ? replacement : null,
      })
      onClose()
    } catch (err) {
      setError(err.message || 'Could not withdraw this revision. Try again.')
      setSaving(false)
    }
  }

  return (
    <div className={modalShellCls}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`${modalCardCls} max-w-[540px]`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <div>
            <h2 className="text-[15px] font-bold text-brand-text m-0">
              Withdraw Revision {revision.revisionCode}
            </h2>
            <p className="text-[12px] text-brand-muted mt-0.5 mb-0">
              {drawing.drawingNumber} · {drawing.title}
            </p>
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
            Withdrawing is permanent and cannot be undone. The revision and its file are kept as
            history, marked <strong className="text-brand-text">WITHDRAWN — do not use</strong>.
          </p>

          {isCurrent && (
            <div>
              <label className={labelCls}>
                This is the current revision <span className="text-brand-red">*</span>
              </label>
              <p className="text-[12px] text-brand-muted mt-0 mb-2">
                Choose what the site builds from next. Nothing is promoted automatically.
              </p>

              <div className="flex flex-col gap-1.5">
                {candidates.map(r => (
                  <label
                    key={r.id}
                    className="flex items-center gap-2.5 min-h-[44px] px-3 rounded-lg border border-brand-border cursor-pointer hover:bg-brand-card"
                  >
                    <input
                      type="radio"
                      name="replacement"
                      value={r.id}
                      checked={replacement === r.id}
                      onChange={() => setReplacement(r.id)}
                    />
                    <span className="text-[13px] text-brand-text">
                      Reinstate Revision <strong>{r.revisionCode}</strong>
                      <span className="text-brand-muted"> · issued {r.revisionDate}</span>
                    </span>
                  </label>
                ))}

                <label className="flex items-center gap-2.5 min-h-[44px] px-3 rounded-lg border border-brand-border cursor-pointer hover:bg-brand-card">
                  <input
                    type="radio"
                    name="replacement"
                    value="none"
                    checked={replacement === 'none'}
                    onChange={() => setReplacement('none')}
                  />
                  <span className="text-[13px] text-brand-text">
                    No replacement — withdraw the whole drawing
                  </span>
                </label>
              </div>

              {replacement === 'none' && (
                <p className="text-[12px] text-brand-amber mt-2 mb-0">
                  ⚠ The drawing will be marked WITHDRAWN with no current revision, and can no longer
                  receive new revisions.
                </p>
              )}
              {candidates.length === 0 && (
                <p className="text-[12px] text-brand-muted mt-2 mb-0">
                  There is no earlier revision available to reinstate.
                </p>
              )}
            </div>
          )}

          <div>
            <label className={labelCls}>Reason <span className="text-brand-red">*</span></label>
            <textarea
              className={inputCls}
              rows={3}
              placeholder="Why is this revision being withdrawn?"
              value={withdrawReason}
              onChange={e => setWithdrawReason(e.target.value)}
              required
            />
          </div>

          {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn variant="danger" type="submit" sm disabled={saving}>
              {saving ? 'Withdrawing…' : 'Withdraw Revision'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
