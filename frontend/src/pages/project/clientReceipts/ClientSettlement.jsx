import { useMemo, useState } from 'react'
import Card from '../../../components/Card'
import Btn from '../../../components/Btn'
import Badge from '../../../components/Badge'
import WriteFeedback from '../../../components/WriteFeedback'
import { useWriteAction } from '../../../hooks/useWriteAction'
import { formatCurrency } from '../../../lib/formatters'
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, PAYMENT_METHOD, paymentMethodLabel, toCents, todayIso } from '../../../lib/payments'
import { SETTLEMENT_STATUS, REFUND_SOURCE, SETTLEMENT_LIMITS } from '../../../lib/clientSettlement'
import { REFUND_WORDING } from '../../../lib/clientLedgerActions'

// ── Client refunds and receipt applications (Phase 2 step 5, ADR-95) ─────
//
// The browser decides nothing here: every action is a trusted callable that
// checks the money is available, keeps the receipt and the invoice within one
// client, currency and project, and moves the ledgers. A refund records money
// ACTUALLY returned to the client outside the app; an application moves a
// receipt's unallocated money onto an invoice and is not cash. Voiding either
// CORRECTS AN ERRONEOUS RECORD — it is never a reversal of a real payment.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

function Shell({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[560px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

const amountProblem = (value, max) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 'Enter an amount above zero.'
  if (Math.round(n * 100) / 100 !== n) return 'Enter whole cents.'
  if (toCents(n) > toCents(max)) return `At most ${max.toFixed(2)} is available.`
  return null
}

// `target` — { source: 'receipt', receipt, available } or { source: 'invoice', row }.
export function RefundModal({ target, refundId, currencyCode, onClose, onConfirm }) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const fromReceipt = target.source === REFUND_SOURCE.RECEIPT
  const available = fromReceipt ? target.available : -target.row.remaining
  const [amount, setAmount] = useState(String(available.toFixed(2)))
  const [refundDate, setRefundDate] = useState(todayIso())
  const [method, setMethod] = useState(PAYMENT_METHOD.BANK_TRANSFER)
  const [reference, setReference] = useState('')
  const [reason, setReason] = useState('')
  const write = useWriteAction('Client refund')
  const problem = amountProblem(amount, available) ?? (!reference.trim() ? 'Enter the payment reference.' : !reason.trim() ? 'Enter a reason.' : null)

  function submit(e) {
    e.preventDefault()
    if (problem) return
    write.run(() => onConfirm(refundId, {
      source: target.source,
      receiptId: fromReceipt ? target.receipt.id : null,
      clientInvoiceId: fromReceipt ? null : target.row.id,
      amount: Number(amount), refundDate, method, reference, reason,
    }), { onConfirmed: onClose })
  }

  const what = fromReceipt ? `the unallocated money on ${target.receipt.receiptNumber}` : `the overpayment on ${target.row.invoiceNumber}`
  return (
    <Shell title="Record a refund to the client" onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Record money you have ACTUALLY returned to the client from {what} ({money(available)} available). Constrap
          does not send money: record the refund once the payment has been made. It reduces net cash received; it is
          not revenue, cost or profit.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Amount <span className="text-brand-red">*</span></label>
            <input className={inputCls} type="number" step="0.01" min="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Refund date <span className="text-brand-red">*</span></label>
            <input className={inputCls} type="date" value={refundDate} onChange={e => setRefundDate(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Method <span className="text-brand-red">*</span></label>
            <select className={inputCls} value={method} onChange={e => setMethod(e.target.value)}>
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Payment reference <span className="text-brand-red">*</span></label>
            <input className={inputCls} maxLength={SETTLEMENT_LIMITS.REFERENCE} value={reference} onChange={e => setReference(e.target.value)} placeholder="Bank or cheque reference" />
          </div>
        </div>
        <div>
          <label className={labelCls}>Reason <span className="text-brand-red">*</span></label>
          <input className={inputCls} maxLength={SETTLEMENT_LIMITS.REASON} value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is money being returned?" />
        </div>
        {problem && <p className="m-0 text-[12px] text-brand-amber">{problem}</p>}
        <WriteFeedback write={write} />
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || !!problem}>{write.busy ? 'Recording…' : write.waiting ? 'Waiting for confirmation…' : 'Record refund'}</Btn>
        </div>
      </form>
    </Shell>
  )
}

// `invoices` — reconciliation rows of issued invoices (lib/clientReceipts.js).
export function ApplyModal({ receipt, available, invoices, applicationId, currencyCode, onClose, onConfirm }) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  // The same client and currency only (the server checks both again); an
  // invoice that is owed nothing cannot take an application.
  const eligible = useMemo(
    () => (invoices ?? []).filter(r => r.clientId === receipt.clientId && toCents(r.remaining) > 0),
    [invoices, receipt.clientId],
  )
  const [invoiceId, setInvoiceId] = useState(eligible[0]?.id ?? '')
  const chosen = eligible.find(r => r.id === invoiceId) ?? null
  const max = chosen ? Math.min(available, chosen.remaining) : available
  const [amount, setAmount] = useState(String((chosen ? max : available).toFixed(2)))
  const [applicationDate, setApplicationDate] = useState(todayIso())
  const [notes, setNotes] = useState('')
  const write = useWriteAction('Receipt application')
  const problem = !chosen ? 'Choose an invoice of this client that is still owed money.' : amountProblem(amount, max)

  function submit(e) {
    e.preventDefault()
    if (problem) return
    write.run(() => onConfirm(applicationId, {
      receiptId: receipt.id, clientInvoiceId: chosen.id, amount: Number(amount), applicationDate, notes,
    }), { onConfirmed: onClose })
  }

  return (
    <Shell title={`Apply unallocated money — ${receipt.receiptNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          {money(available)} of this receipt is not allocated to any invoice. Apply it to an issued invoice of the same
          client and currency on this project. An application moves no cash and never makes an invoice overpaid.
        </p>
        <div>
          <label className={labelCls}>Invoice <span className="text-brand-red">*</span></label>
          <select className={inputCls} value={invoiceId} onChange={e => setInvoiceId(e.target.value)}>
            {eligible.length === 0 && <option value="">No invoice of this client is owed money</option>}
            {eligible.map(r => <option key={r.id} value={r.id}>{r.invoiceNumber} — owed {money(r.remaining)}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Amount <span className="text-brand-red">*</span></label>
            <input className={inputCls} type="number" step="0.01" min="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Date <span className="text-brand-red">*</span></label>
            <input className={inputCls} type="date" value={applicationDate} onChange={e => setApplicationDate(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Notes</label>
          <input className={inputCls} maxLength={SETTLEMENT_LIMITS.NOTES} value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {problem && <p className="m-0 text-[12px] text-brand-amber">{problem}</p>}
        <WriteFeedback write={write} />
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || !!problem}>{write.busy ? 'Applying…' : write.waiting ? 'Waiting for confirmation…' : 'Apply'}</Btn>
        </div>
      </form>
    </Shell>
  )
}

// A void of a refund or an application is a CORRECTION of an erroneous record.
export function SettlementVoidModal({ record, kind, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const write = useWriteAction(kind === 'refund' ? 'Refund correction' : 'Application correction')
  const number = record.refundNumber ?? record.applicationNumber
  function submit(e) {
    e.preventDefault()
    if (!reason.trim()) return
    write.run(() => onConfirm(record, reason), { onConfirmed: onClose })
  }
  return (
    <Shell title={`Void ${number} as a correction`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        {kind === 'refund' ? (
          <div className="flex flex-col gap-1.5 text-[12.5px] text-brand-muted" data-refund-void-wording>
            <p className="m-0">{REFUND_WORDING.RECORD}</p>
            <p className="m-0 font-semibold text-brand-text">{REFUND_WORDING.VOID}</p>
            <p className="m-0">{REFUND_WORDING.REPAID}</p>
            <p className="m-0">{REFUND_WORDING.NO_MONEY}</p>
            <p className="m-0">{REFUND_WORDING.SEGREGATION}</p>
          </div>
        ) : (
          <p className="m-0 text-[12.5px] text-brand-muted">
            Use this only when the application was recorded in error. The money returns to the receipt’s unallocated balance. The record stays, marked void.
          </p>
        )}
        <div>
          <label className={labelCls}>Reason <span className="text-brand-red">*</span></label>
          <input className={inputCls} value={reason} onChange={e => setReason(e.target.value)} autoFocus placeholder="What was recorded in error?" />
        </div>
        <WriteFeedback write={write} />
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || !reason.trim()}>{write.busy ? 'Voiding…' : write.waiting ? 'Waiting for confirmation…' : (kind === 'refund' ? REFUND_WORDING.CONFIRM_BUTTON : 'Void as correction')}</Btn>
        </div>
      </form>
    </Shell>
  )
}

// `canVoid` — false while the company is not activated for Phase 2
// (lib/commercialActivation.js): the records stay listed, the correction is
// withheld. UX only.
export function SettlementRegister({ refunds, applications, currencyCode, onVoidRefund, onVoidApplication, canVoid = false }) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const rows = [
    ...(refunds ?? []).map(r => ({ ...r, kind: 'refund', number: r.refundNumber, date: r.refundDate,
      what: r.source === REFUND_SOURCE.RECEIPT ? `Refund from ${r.receiptNumber ?? 'receipt'}` : `Refund of overpayment on ${r.invoiceNumber ?? 'invoice'}`,
      detail: `${paymentMethodLabel(r.method)} · ${r.reference || '—'}` })),
    ...(applications ?? []).map(a => ({ ...a, kind: 'application', number: a.applicationNumber, date: a.applicationDate,
      what: `${a.receiptNumber ?? 'Receipt'} → ${a.invoiceNumber ?? 'invoice'}`, detail: 'Application — not cash' })),
  ].sort((x, y) => String(y.date).localeCompare(String(x.date)) || String(y.number).localeCompare(String(x.number)))
  if (rows.length === 0) return null
  return (
    <Card padding={false} className="mt-3.5">
      <p className="text-[13px] font-bold text-brand-text m-0 px-5 pt-4">Refunds and receipt applications</p>
      <div className="overflow-x-auto mt-2">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-brand-card border-b border-brand-border">
              {['#', 'Date', 'What', 'Detail', 'Client', 'Amount', 'Status', ''].map((h, i) => <th key={i} className={thCls}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={`${r.kind}-${r.id}`} className="border-b border-brand-border">
                <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{r.number}</td>
                <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{r.date || '—'}</td>
                <td className="px-3.5 py-3 text-[12.5px] text-brand-text">{r.what}</td>
                <td className="px-3.5 py-3 text-[12px] text-brand-muted">{r.detail}</td>
                <td className="px-3.5 py-3 text-[12px] text-brand-muted">{r.clientName || '—'}</td>
                <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{r.kind === 'refund' ? `−${money(r.amount)}` : money(r.amount)}</td>
                <td className="px-3.5 py-3">
                  <Badge label={r.status === SETTLEMENT_STATUS.VOID ? 'Void (correction)' : 'Posted'} variant={r.status === SETTLEMENT_STATUS.VOID ? 'soon' : 'active'} sm />
                </td>
                <td className="px-3.5 py-3 text-right">
                  {canVoid && r.status === SETTLEMENT_STATUS.POSTED && (
                    <Btn sm variant="ghost" title={r.kind === 'refund' ? REFUND_WORDING.VOID_BUTTON_TITLE : undefined}
                      onClick={() => (r.kind === 'refund' ? onVoidRefund(r) : onVoidApplication(r))}>{REFUND_WORDING.VOID_BUTTON}</Btn>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 px-5 py-3 text-[11px] text-brand-muted">
        A refund is money returned to the client outside Constrap; net cash received = receipts − refunds. An
        application moves a receipt&apos;s unallocated money onto an invoice and moves no cash. A void corrects a
        record entered in error.
      </p>
    </Card>
  )
}
