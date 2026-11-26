import { useState } from 'react'
import Btn from '../../../components/Btn'
import WriteFeedback from '../../../components/WriteFeedback'
import { useWriteAction } from '../../../hooks/useWriteAction'
import { formatCurrency } from '../../../lib/formatters'
import { todayIso } from '../../../lib/payments'
import {
  buildClientRetentionRelease, validateClientReleaseDraft, CLIENT_RETENTION_RELEASED_NOTICE,
} from '../../../lib/clientRetention'
import ReceivableDialog from '../clientCredit/ReceivableDialog'

// ── Create / edit a DRAFT Client Retention Release ───────────────────────────
//
// A release is an AUTHORISATION that makes retention already withheld on an
// issued client invoice receivable. It is not an invoice, a credit note or a
// receipt: it bills nothing new and moves no cash.
//
// The user enters an ex-GST amount, at most the retention still held on the
// invoice. The GST released is the invoice's own retention GST in proportion
// (lib/clientRetention.js → buildClientRetentionRelease), previewed live; the
// hook re-derives it inside its transaction.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'

export default function ClientReleaseModal({
  invoice, release = null, ledgerDoc, row, currencyCode, onClose, onSave,
}) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const isEdit = !!release
  const heldExGst = row?.retentionHeldExGst ?? 0

  const [amount, setAmount] = useState(release ? String(release.amount ?? '') : '')
  const [releaseDate, setReleaseDate] = useState(release?.releaseDate || todayIso())
  const [reason, setReason] = useState(release?.reason || '')
  const [notes, setNotes] = useState(release?.notes || '')
  const write = useWriteAction('Client retention release draft')

  const value = amount === '' ? NaN : Number(amount)
  const validationError = validateClientReleaseDraft(
    { clientInvoiceId: invoice.id, amount: value, releaseDate, reason },
    { invoice, ledgerDoc },
  )
  const built = Number.isFinite(value) && value > 0 ? buildClientRetentionRelease(invoice, ledgerDoc, value) : null
  const preview = built && !built.error ? built : null

  function handleSubmit(e) {
    e.preventDefault()
    if (validationError) return
    write.run(() => onSave({
      clientInvoiceId: invoice.id,
      amount: value,
      releaseDate,
      reason,
      notes,
    }), { onConfirmed: onClose })
  }

  return (
    <ReceivableDialog
      title={isEdit ? `Edit ${release.releaseNumber}` : `Release retention on ${invoice.invoiceNumber}`}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          <span className="font-semibold text-brand-text">{invoice.invoiceNumber}</span>
          {invoice.clientName ? <> · {invoice.clientName}</> : null} withheld{' '}
          <span className="font-semibold text-brand-text">{money(row?.retentionTotal)}</span> (inc. GST).{' '}
          <span className="font-semibold text-brand-text">{money(row?.retentionHeld)}</span> is still held —{' '}
          {money(heldExGst)} ex-GST.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="crr-amount">Release Amount (ex-GST) <span className="text-brand-red">*</span></label>
            <input
              id="crr-amount"
              type="number" min="0" step="0.01" max={heldExGst}
              className={inputCls}
              placeholder="0.00"
              value={amount}
              onChange={e => { write.clearFailure(); setAmount(e.target.value) }}
              autoFocus
            />
            <div className="mt-1.5">
              <Btn
                sm variant="ghost" type="button"
                disabled={!(heldExGst > 0)}
                onClick={() => { write.clearFailure(); setAmount(String(heldExGst)) }}
              >
                Release all held
              </Btn>
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="crr-date">Release Date <span className="text-brand-red">*</span></label>
            <input
              id="crr-date" type="date" className={inputCls} value={releaseDate}
              onChange={e => { write.clearFailure(); setReleaseDate(e.target.value) }}
            />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">The date the release was agreed.</p>
          </div>
        </div>

        <div>
          <label className={labelCls} htmlFor="crr-reason">Reason <span className="text-brand-red">*</span></label>
          <input
            id="crr-reason" className={inputCls}
            placeholder="e.g. Practical completion — half of retention released"
            value={reason}
            onChange={e => { write.clearFailure(); setReason(e.target.value) }}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="crr-notes">Notes</label>
          <input id="crr-notes" className={inputCls} placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        {/* Live preview */}
        <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
          <p className="m-0">Released (ex-GST) <span className="font-semibold ml-2">{preview ? money(preview.amount) : '—'}</span></p>
          <p className="m-0 text-brand-muted">GST released <span className="ml-2">{preview ? money(preview.gstAmount) : '—'}</span></p>
          <p className="m-0 font-bold">Becomes receivable (inc. GST) <span className="ml-2">{preview ? money(preview.releaseTotal) : '—'}</span></p>
        </div>
        <p className="m-0 text-[11px] text-brand-muted">
          The GST released is this invoice&apos;s own retention GST in proportion — not a flat rate. A draft releases
          nothing until it is posted. {CLIENT_RETENTION_RELEASED_NOTICE}
        </p>

        {validationError && <p className="text-[12px] text-brand-red m-0">{validationError}</p>}
        <WriteFeedback write={write} />

        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || !!validationError}>
            {write.busy ? 'Saving…' : write.waiting ? 'Waiting for confirmation…' : isEdit ? 'Save draft' : 'Create draft release'}
          </Btn>
        </div>
      </form>
    </ReceivableDialog>
  )
}
