import { useState } from 'react'
import Btn from '../../../components/Btn'
import WriteFeedback from '../../../components/WriteFeedback'
import { useWriteAction } from '../../../hooks/useWriteAction'
import { formatCurrency } from '../../../lib/formatters'
import { toCents, fromCents } from '../../../lib/money'
import { todayIso } from '../../../lib/payments'
import { TAX_CODE_LABELS, hasRetention } from '../../../lib/clientInvoices'
import { readLedger } from '../../../lib/clientLedger'
import {
  buildClientCreditNote, validateClientCreditDraft, CLIENT_CREDIT_NOTE_NOTICE,
} from '../../../lib/clientCreditNotes'
import ReceivableDialog from './ReceivableDialog'

// ── Create / edit a DRAFT Client Credit Note ─────────────────────────────────
//
// A credit note corrects ONE issued client invoice by crediting its SOURCE
// LINES. The user enters an ex-GST amount per invoice line; the tax code and
// variation are inherited from that line and are never editable here. GST, and
// the split between retention still held and what is receivable now, follow
// from the invoice and its ledger (lib/clientCreditNotes.js →
// buildClientCreditNote) and are previewed live — the hook re-derives them
// inside its transaction, so the preview is a preview, never the stored value.
//
// A draft moves nothing: posting is a separate, confirmed step.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'

export default function ClientCreditNoteModal({
  invoice, creditNote = null, ledgerDoc, remaining = null, currencyCode, onClose, onSave,
}) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const isEdit = !!creditNote
  const sourceLines = invoice.lineItems ?? []

  const [creditDate, setCreditDate] = useState(creditNote?.creditDate || todayIso())
  const [reason, setReason] = useState(creditNote?.reason || '')
  const [reference, setReference] = useState(creditNote?.clientCreditReference || '')
  const [notes, setNotes] = useState(creditNote?.notes || '')
  // One editor amount per SOURCE line of the invoice, keyed by its index.
  const [amounts, setAmounts] = useState(() => {
    const byIndex = new Map((creditNote?.lineItems ?? []).map(li => [li.invoiceLineIndex, li.amount]))
    return sourceLines.map((_, i) => (byIndex.has(i) ? String(byIndex.get(i)) : ''))
  })
  const write = useWriteAction('Client credit note draft')

  // What POSTED credit notes have already taken from each line (whole cents).
  const ledger = readLedger(ledgerDoc)
  const lineState = sourceLines.map((li, i) => {
    const amountCents = toCents(li.amount)
    const creditedCents = ledger.lines[i]?.amountCents ?? 0
    return { amountCents, creditedCents, remainingCents: amountCents - creditedCents }
  })

  const setAmount = (idx, value) => {
    write.clearFailure()
    setAmounts(as => as.map((a, i) => (i === idx ? value : a)))
  }
  const creditAllRemaining = () => {
    write.clearFailure()
    setAmounts(lineState.map(s => (s.remainingCents > 0 ? String(fromCents(s.remainingCents)) : '')))
  }

  // Rows exactly as the hook takes them. An untouched line is not a row.
  const rows = amounts
    .map((a, i) => ({ invoiceLineIndex: i, amount: Number(a) }))
    .filter((r, i) => amounts[i] !== '' && (!Number.isFinite(r.amount) || toCents(r.amount) !== 0))

  const validationError = validateClientCreditDraft(
    { clientInvoiceId: invoice.id, creditDate, reason, rows },
    { invoice, ledgerDoc },
  )
  const built = rows.length > 0 ? buildClientCreditNote(invoice, ledgerDoc, rows) : null
  const preview = built && !built.error ? built.totals : null
  const withheld = hasRetention(invoice)

  // A credit that takes the invoice below what has already been received
  // leaves the difference OWED TO THE CLIENT. Said before the draft is saved.
  const remainingAfterCents = preview && remaining !== null
    ? toCents(remaining) - toCents(preview.receivableTotal)
    : null

  function handleSubmit(e) {
    e.preventDefault()
    if (validationError) return
    write.run(() => onSave({
      clientInvoiceId: invoice.id,
      creditDate,
      reason,
      clientCreditReference: reference,
      notes,
      rows,
    }), { onConfirmed: onClose })
  }

  return (
    <ReceivableDialog
      wide
      title={isEdit ? `Edit ${creditNote.creditNumber}` : `Record credit note against ${invoice.invoiceNumber}`}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          A credit note corrects <span className="font-semibold text-brand-text">{invoice.invoiceNumber}</span>
          {invoice.clientName ? <> ({invoice.clientName})</> : null}: it reduces what has been billed and re-opens
          the same ex-GST value under Available to Invoice. It does not change the contract sum and moves no cash.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls} htmlFor="ccn-date">Credit Date <span className="text-brand-red">*</span></label>
            <input
              id="ccn-date" type="date" className={inputCls} value={creditDate}
              onChange={e => { write.clearFailure(); setCreditDate(e.target.value) }}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="ccn-reason">Reason <span className="text-brand-red">*</span></label>
            <input
              id="ccn-reason" className={inputCls} autoFocus
              placeholder="Why is this credit being issued?"
              value={reason}
              onChange={e => { write.clearFailure(); setReason(e.target.value) }}
            />
          </div>
        </div>

        {/* Source lines */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className={labelCls}>Credit by invoice line (ex-GST)</p>
            <div className="mb-1.5">
              <Btn sm variant="ghost" type="button" onClick={creditAllRemaining}>Credit all remaining</Btn>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border border-brand-border">
            <table className="w-full border-collapse min-w-[720px]">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  <th className={thCls}>Line</th>
                  <th className={thCls}>Tax</th>
                  <th className={`${thCls} text-right`}>Invoiced</th>
                  <th className={`${thCls} text-right`}>Already credited</th>
                  <th className={`${thCls} text-right`}>Remaining</th>
                  <th className={thCls}>Credit this line</th>
                </tr>
              </thead>
              <tbody>
                {sourceLines.map((li, i) => {
                  const s = lineState[i]
                  const inputId = `ccn-line-${i}`
                  return (
                    <tr key={i} className="border-b border-brand-border last:border-b-0">
                      <td className="px-3 py-2.5 text-[13px] text-brand-text">
                        <label htmlFor={inputId}>{li.description || `Line ${i + 1}`}</label>
                        {li.variationNumber && (
                          <span className="block text-[11px] text-brand-muted">{li.variationNumber}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">
                        {TAX_CODE_LABELS[li.taxCode] ?? li.taxCode}
                      </td>
                      <td className="px-3 py-2.5 text-[13px] text-brand-text text-right tabular-nums whitespace-nowrap">
                        {money(fromCents(s.amountCents))}
                      </td>
                      <td className="px-3 py-2.5 text-[13px] text-brand-muted text-right tabular-nums whitespace-nowrap">
                        {money(fromCents(s.creditedCents))}
                      </td>
                      <td className="px-3 py-2.5 text-[13px] font-semibold text-brand-text text-right tabular-nums whitespace-nowrap">
                        {money(fromCents(s.remainingCents))}
                      </td>
                      <td className="px-3 py-2 min-w-[140px]">
                        <input
                          id={inputId}
                          type="number" min="0" step="0.01"
                          className={inputCls}
                          placeholder="0.00"
                          value={amounts[i]}
                          disabled={s.remainingCents <= 0}
                          onChange={e => setAmount(i, e.target.value)}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
            Each credit line inherits the tax code and variation of the invoice line it credits — neither can be
            changed here. “Already credited” counts posted credit notes only; other drafts have credited nothing.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="ccn-reference">External Credit Reference</label>
            <input
              id="ccn-reference" className={inputCls}
              placeholder="e.g. Xero CN-0012"
              value={reference}
              onChange={e => setReference(e.target.value)}
            />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Optional — the adjustment note you issued from your accounting system.
            </p>
          </div>
          <div>
            <label className={labelCls} htmlFor="ccn-notes">Notes</label>
            <input id="ccn-notes" className={inputCls} placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        {/* Live preview */}
        <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
          <p className="m-0">Credit subtotal (ex-GST) <span className="font-semibold ml-2">{preview ? money(preview.subtotal) : '—'}</span></p>
          <p className="m-0 text-brand-muted">GST reversed <span className="ml-2">{preview ? money(preview.gstTotal) : '—'}</span></p>
          <p className="m-0 font-bold">Credit total (inc. GST) <span className="ml-2">{preview ? money(preview.grossTotal) : '—'}</span></p>
          {withheld && (
            <>
              <p className="m-0 text-brand-muted">
                Reduces retention held <span className="ml-2">{preview ? money(preview.retentionTotal) : '—'}</span>
              </p>
              <p className="m-0 font-semibold">
                Reduces receivable now <span className="ml-2">{preview ? money(preview.receivableTotal) : '—'}</span>
              </p>
            </>
          )}
        </div>

        {remainingAfterCents !== null && remainingAfterCents < 0 && (
          <p className="m-0 text-[12px] text-brand-amber">
            ⚠ Once posted, this credit leaves <span className="font-semibold">{money(fromCents(-remainingAfterCents))} owed
            to the client</span> on {invoice.invoiceNumber}: more has been received than the invoice will then be owed.
            Constrap records no refund — the remedy is to void the receipt and re-record it with the surplus
            unallocated.
          </p>
        )}

        <p className="m-0 text-[11px] text-brand-muted">{CLIENT_CREDIT_NOTE_NOTICE}</p>

        {validationError && <p className="text-[12px] text-brand-red m-0">{validationError}</p>}
        <WriteFeedback write={write} />

        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || !!validationError}>
            {write.busy ? 'Saving…' : write.waiting ? 'Waiting for confirmation…' : isEdit ? 'Save draft' : 'Create draft credit note'}
          </Btn>
        </div>
      </form>
    </ReceivableDialog>
  )
}
