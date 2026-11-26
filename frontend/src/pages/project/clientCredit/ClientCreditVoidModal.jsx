import { useState } from 'react'
import Btn from '../../../components/Btn'
import WriteFeedback from '../../../components/WriteFeedback'
import { useWriteAction } from '../../../hooks/useWriteAction'
import { formatCurrency } from '../../../lib/formatters'
import { CCN_STATUS } from '../../../lib/clientCreditNotes'
import ReceivableDialog from './ReceivableDialog'

// ── Void a Client Credit Note ────────────────────────────────────────────────
//
// Void is terminal and needs a non-blank reason (the hook and Firestore Rules
// both require it). Nothing was ever written onto the invoice, so voiding a
// POSTED credit needs no reversal document: the invoice's ledger moves back in
// the same transaction and every derived figure follows at the next render.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'

export default function ClientCreditVoidModal({ creditNote, currencyCode, onClose, onConfirm }) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const [reason, setReason] = useState('')
  const write = useWriteAction('Client credit note void')
  const wasPosted = creditNote.status === CCN_STATUS.POSTED

  function submit(e) {
    e.preventDefault()
    if (!reason.trim()) return
    write.run(() => onConfirm(creditNote, reason), { onConfirmed: onClose })
  }

  return (
    <ReceivableDialog title={`Void ${creditNote.creditNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-text">
          <span className="font-semibold">{creditNote.creditNumber}</span> · {creditNote.invoiceNumber} ·{' '}
          <span className="font-semibold">{money(creditNote.grossTotal)}</span>
        </p>
        <p className="m-0 text-[12.5px] text-brand-muted">
          {wasPosted
            ? `Voiding is permanent. ${money(creditNote.grossTotal)} stops being credited against ${creditNote.invoiceNumber}: net Issued, Available to Invoice, retention held and the amount receivable return to what they were before this credit. No reversal record is created.`
            : 'Voiding is permanent. This draft has credited nothing, so no figure changes.'}
          {' '}The credit note is kept as audit history and its number is retained.
        </p>
        <div>
          <label className={labelCls} htmlFor="ccn-void-reason">Reason <span className="text-brand-red">*</span></label>
          <input
            id="ccn-void-reason"
            className={inputCls}
            placeholder="Why is this credit note being voided?"
            value={reason}
            onChange={e => { write.clearFailure(); setReason(e.target.value) }}
            autoFocus
          />
        </div>
        <WriteFeedback write={write} />
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || !reason.trim()}>{write.busy ? 'Voiding…' : write.waiting ? 'Waiting for confirmation…' : 'Void credit note'}</Btn>
        </div>
      </form>
    </ReceivableDialog>
  )
}
