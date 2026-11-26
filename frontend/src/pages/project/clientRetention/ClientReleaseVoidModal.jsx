import { useState } from 'react'
import Btn from '../../../components/Btn'
import WriteFeedback from '../../../components/WriteFeedback'
import { useWriteAction } from '../../../hooks/useWriteAction'
import { formatCurrency } from '../../../lib/formatters'
import { CRR_STATUS } from '../../../lib/clientRetention'
import ReceivableDialog from '../clientCredit/ReceivableDialog'

// ── Void a Client Retention Release ──────────────────────────────────────────
//
// Void is terminal and needs a non-blank reason. Nothing was ever written onto
// the invoice, so voiding a POSTED release needs no reversal document: the
// ledger moves back in the same transaction and the amount returns to
// retention held at the next render.
//
// Voiding a posted release LOWERS what is receivable. It is refused when
// receipts are already allocated against the released retention. THE SERVER
// makes that check now, when the void is written; a refusal comes back as a
// message already written for the user and is shown by WriteFeedback.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'

export default function ClientReleaseVoidModal({ release, currencyCode, onClose, onConfirm }) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const [reason, setReason] = useState('')
  const write = useWriteAction('Client retention release void')
  const wasPosted = release.status === CRR_STATUS.POSTED

  function submit(e) {
    e.preventDefault()
    if (!reason.trim()) return
    write.run(() => onConfirm(release, reason), { onConfirmed: onClose })
  }

  return (
    <ReceivableDialog title={`Void ${release.releaseNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-text">
          <span className="font-semibold">{release.releaseNumber}</span> · {release.invoiceNumber} ·{' '}
          <span className="font-semibold">{money(release.releaseTotal)}</span>
        </p>
        <p className="m-0 text-[12.5px] text-brand-muted">
          {wasPosted
            ? `Voiding is permanent. ${money(release.releaseTotal)} stops being receivable on ${release.invoiceNumber} and returns to retention held. The server refuses the void when receipts are already allocated against this released retention — void or re-allocate those receipts first.`
            : 'Voiding is permanent. This draft has released nothing, so no balance changes.'}
          {' '}The release is kept as audit history and its number is retained; no reversal record is created.
        </p>
        <div>
          <label className={labelCls} htmlFor="crr-void-reason">Reason <span className="text-brand-red">*</span></label>
          <input
            id="crr-void-reason"
            className={inputCls}
            placeholder="Why is this release being voided?"
            value={reason}
            onChange={e => { write.clearFailure(); setReason(e.target.value) }}
            autoFocus
          />
        </div>
        <WriteFeedback write={write} />
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || !reason.trim()}>{write.busy ? 'Voiding…' : write.waiting ? 'Waiting for confirmation…' : 'Void release'}</Btn>
        </div>
      </form>
    </ReceivableDialog>
  )
}
