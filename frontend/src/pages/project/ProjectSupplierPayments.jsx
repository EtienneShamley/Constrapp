import { useEffect, useMemo, useState } from 'react'
import { useOutletContext, useNavigate, useLocation } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency } from '../../lib/formatters'
import { roundMoney } from '../../lib/purchaseOrders'
import { useProfile } from '../../hooks/useProfile'
import { useSupplierPayments } from '../../hooks/useSupplierPayments'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import { useContacts } from '../../hooks/useContacts'
import { PO_SUPPLIER_TYPES } from '../../lib/contacts'
import { isFinancialRole } from '../../lib/margin'
import {
  PAYMENT_STATUS, PAYMENT_STATUS_LABELS, PAYMENT_BADGE_VARIANTS,
  PAYMENT_METHOD, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, paymentMethodLabel,
  RECONCILIATION_LABELS, RECONCILIATION_BADGE_VARIANTS,
  AGEING_BUCKETS, allocatedTotal, unallocatedAmount, toCents, todayIso, isFutureDate,
  validateAllocations,
} from '../../lib/payments'
import {
  allocatableSupplierInvoices, allocateOldestFirst, buildAllocations,
  invoiceOverPaymentWarnings, allocationExceptions, ALLOCATION_EXCEPTION_REMEDY,
  paymentSummary, payablesSummary, apAgeing, postBlockedReason, isFutureDatedPayment,
  validatePaymentDraft, allocationInvoiceLabel, supplierMatchesInvoice, isPayableInvoice,
  RETENTION_HELPER_TEXT, AP_RECONCILIATION_NOTICE, LEGACY_SUPPLIER_MATCH_NOTE,
} from '../../lib/supplierPayments'

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

function Metric({ label, value, help, danger }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className={`text-lg font-bold ${danger ? 'text-brand-red' : 'text-brand-text'}`}>{value}</p>
      {help && <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{help}</p>}
    </div>
  )
}

function ModalShell({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative z-10 w-full ${wide ? 'max-w-[900px]' : 'max-w-[560px]'} max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Create / edit draft ──────────────────────────────────────────────────────

const blankRow = () => ({ supplierInvoiceId: '', allocatedAmount: '' })

function PaymentEditorModal({
  payment, supplierContacts, supplierInvoices, supplierPayments, supplierCreditNotes,
  preselect, currencyCode, onClose, onSave,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const isEdit = !!payment

  const [supplierId, setSupplierId]   = useState(payment?.supplierId || preselect?.supplierId || '')
  const [paymentDate, setPaymentDate] = useState(payment?.paymentDate || todayIso())
  const [amount, setAmount]           = useState(payment ? String(payment.amount ?? '') : '')
  const [method, setMethod]           = useState(payment?.paymentMethod || '')
  const [methodOther, setMethodOther] = useState(payment?.paymentMethodOther || '')
  const [bankReference, setBankReference] = useState(payment?.bankReference || '')
  const [remittanceReference, setRemittanceReference] = useState(payment?.remittanceReference || '')
  const [externalReference, setExternalReference] = useState(payment?.externalReference || '')
  const [notes, setNotes]             = useState(payment?.notes || '')
  const [rows, setRows] = useState(() => {
    if (payment?.allocations?.length) {
      return payment.allocations.map(a => ({
        supplierInvoiceId: a.supplierInvoiceId || '',
        allocatedAmount: String(a.allocatedAmount ?? ''),
      }))
    }
    // "Record payment" from a posted Supplier Invoice pre-adds that invoice as
    // an allocation row with no amount — the user still chooses what to pay.
    if (preselect?.supplierInvoiceId) {
      return [{ supplierInvoiceId: preselect.supplierInvoiceId, allocatedAmount: '' }]
    }
    return [blankRow()]
  })
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const supplier = supplierContacts.find(c => c.id === supplierId) ?? null
  const supplierName = supplier?.displayName || ''
  const cash = roundMoney(Number(amount) || 0)

  // The POSTED supplier invoices of the SELECTED SUPPLIER on this project, with
  // their live remaining payable — net of posted supplier credit notes, so a
  // credited slice is never offered as payable. Excludes this payment's own
  // allocations so an edit never double-counts itself. Sorted oldest first.
  const targets = useMemo(
    () => allocatableSupplierInvoices(supplierInvoices, supplierId, supplierName, supplierPayments, { excludePaymentId: payment?.id ?? null, creditNotes: supplierCreditNotes }),
    [supplierInvoices, supplierId, supplierName, supplierPayments, supplierCreditNotes, payment?.id],
  )
  const targetById = useMemo(() => new Map(targets.map(t => [t.id, t])), [targets])

  // Changing the supplier invalidates every allocation — an invoice belongs to
  // one supplier, so the existing rows can no longer be valid. Confirmed
  // explicitly, never silently discarded; cancelling leaves both the supplier
  // and the allocations untouched.
  function changeSupplier(e) {
    const next = e.target.value
    const hasAllocations = rows.some(r => r.supplierInvoiceId)
    if (hasAllocations && next !== supplierId) {
      const ok = window.confirm(
        'Changing the supplier will remove the allocations on this payment, because an invoice belongs to one supplier. Continue?',
      )
      if (!ok) return
      setRows([blankRow()])
    }
    setSupplierId(next)
    setAcknowledged(false)
  }

  const setRow = (idx, patch) => setRows(rs => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const addRow = () => setRows(rs => [...rs, blankRow()])
  const removeRow = (idx) => setRows(rs => (rs.length === 1 ? [blankRow()] : rs.filter((_, i) => i !== idx)))

  // Allocate exactly what is still payable on that invoice, capped by the cash
  // still unallocated on this payment.
  function allocateRemaining(idx) {
    const row = rows[idx]
    const target = targetById.get(row.supplierInvoiceId)
    if (!target) return
    const others = rows.filter((_, i) => i !== idx)
    const otherTotal = allocatedTotal(others.map(r => ({ allocatedAmount: Number(r.allocatedAmount) || 0 })))
    const cashLeft = Math.max(roundMoney(cash - otherTotal), 0)
    const take = Math.min(Math.max(target.remaining, 0), cashLeft)
    setRow(idx, { allocatedAmount: String(take) })
  }

  // ⚠️ EXPLICIT ACTION ONLY. This runs on a button press and produces a
  // PROPOSAL the user can edit or discard. It never fires when the editor opens,
  // when the supplier changes, when the amount changes, when an invoice is
  // added, or when a payment is posted — Constrapp does not silently decide
  // which debt a payment settles.
  function allocateOldest() {
    const proposal = allocateOldestFirst(cash, targets)
    setRows(proposal.length
      ? proposal.map(a => ({ supplierInvoiceId: a.supplierInvoiceId, allocatedAmount: String(a.allocatedAmount) }))
      : [blankRow()])
    setAcknowledged(false)
  }

  const builtAllocations = useMemo(
    () => buildAllocations(
      rows.map(r => ({ supplierInvoiceId: r.supplierInvoiceId, allocatedAmount: Number(r.allocatedAmount) || 0 })),
      supplierInvoices,
    ),
    [rows, supplierInvoices],
  )

  const allocated   = allocatedTotal(builtAllocations)
  const unallocated = unallocatedAmount(cash, allocated)

  // Over-allocating the PAYMENT is impossible — the money does not exist.
  const overAllocatesPayment = toCents(allocated) > toCents(cash)
  // Over-reconciling an INVOICE is warned with an acknowledgement, never
  // blocked: it cannot be enforced anywhere (rules cannot sum sibling documents).
  const warnings = useMemo(
    () => invoiceOverPaymentWarnings(builtAllocations, supplierInvoices, supplierPayments, { excludePaymentId: payment?.id ?? null, creditNotes: supplierCreditNotes }),
    [builtAllocations, supplierInvoices, supplierPayments, supplierCreditNotes, payment?.id],
  )
  const needsAck = warnings.length > 0

  const futureDated = isFutureDate(paymentDate)

  const validationError =
    validatePaymentDraft({
      supplierId, supplierName, paymentDate, amount: cash,
      paymentMethod: method, paymentMethodOther: methodOther,
      allocations: builtAllocations, invoices: supplierInvoices,
    })
    ?? validateAllocations(builtAllocations, cash, 'supplierInvoiceId')

  const valid = !validationError && (!needsAck || acknowledged)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      await onSave({
        supplierId,
        supplierName,
        paymentDate,
        amount: cash,
        paymentMethod: method,
        paymentMethodOther: methodOther,
        bankReference,
        remittanceReference,
        externalReference,
        allocations: builtAllocations,
        notes,
        invoices: supplierInvoices,
      })
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell wide title={isEdit ? `Edit ${payment.paymentNumber}` : 'New Supplier Payment'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
        {/* Supplier + date + amount */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Supplier <span className="text-brand-red">*</span></label>
            <select className={inputCls} value={supplierId} onChange={changeSupplier} required>
              <option value="" disabled>Select the supplier…</option>
              {supplierContacts.map(c => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </select>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Supplier and subcontractor contacts only. The name is snapshotted onto this payment, so later contact
              edits never rewrite the cash record.
            </p>
          </div>
          <div>
            <label className={labelCls}>Payment Date <span className="text-brand-red">*</span></label>
            <input type="date" className={inputCls} value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              The date the money actually left your account — not the date you are entering it.
            </p>
          </div>
          <div>
            <label className={labelCls}>Amount Paid <span className="text-brand-red">*</span></label>
            <input
              type="number" min="0" step="0.01"
              className={inputCls}
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Gross cash paid ({currencyCode}). No GST is calculated — tax was recorded on the supplier invoice.
            </p>
          </div>
        </div>

        {futureDated && (
          <p className="m-0 text-[12px] text-brand-amber">
            ⚠ This payment date is in the future. The draft can be saved, but it cannot be posted until
            {' '}{paymentDate} — posting states that money has actually left your account.
          </p>
        )}

        {/* Method + references */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Payment Method <span className="text-brand-red">*</span></label>
            <select className={inputCls} value={method} onChange={e => setMethod(e.target.value)} required>
              <option value="" disabled>Select how it was paid…</option>
              {PAYMENT_METHODS.map(m => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
              ))}
            </select>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">Not pre-filled — record how the money actually left.</p>
          </div>
          {method === PAYMENT_METHOD.OTHER ? (
            <div>
              <label className={labelCls}>Describe the method <span className="text-brand-red">*</span></label>
              <input className={inputCls} placeholder="e.g. offset against a supplier credit" value={methodOther} onChange={e => setMethodOther(e.target.value)} />
            </div>
          ) : (
            <div>
              <label className={labelCls}>Bank Reference</label>
              <input className={inputCls} placeholder="Your bank statement reference" value={bankReference} onChange={e => setBankReference(e.target.value)} />
              <p className="m-0 mt-1 text-[11px] text-brand-muted">Optional — the key for future bank reconciliation.</p>
            </div>
          )}
          <div>
            <label className={labelCls}>Remittance Reference</label>
            <input className={inputCls} placeholder="e.g. RA-0031" value={remittanceReference} onChange={e => setRemittanceReference(e.target.value)} />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Optional — the reference you gave the supplier. Constrapp generates no remittance advice.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {method === PAYMENT_METHOD.OTHER && (
            <div>
              <label className={labelCls}>Bank Reference</label>
              <input className={inputCls} placeholder="Your bank statement reference" value={bankReference} onChange={e => setBankReference(e.target.value)} />
            </div>
          )}
          <div>
            <label className={labelCls}>External Reference</label>
            <input className={inputCls} placeholder="e.g. Xero PMT-0042" value={externalReference} onChange={e => setExternalReference(e.target.value)} />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">Optional — the payment in your accounting system.</p>
          </div>
        </div>

        {/* Allocations */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label className={labelCls}>Allocate to Supplier Invoices</label>
            <div className="flex flex-wrap gap-2 mb-1.5">
              <Btn sm variant="ghost" type="button" onClick={allocateOldest} disabled={!supplierId || cash <= 0 || targets.length === 0}>
                Allocate oldest first
              </Btn>
              <Btn sm variant="ghost" type="button" onClick={addRow} disabled={!supplierId}>+ Add allocation</Btn>
            </div>
          </div>

          {!supplierId ? (
            <p className="m-0 text-[12px] text-brand-muted">Select a supplier to see their posted invoices.</p>
          ) : targets.length === 0 ? (
            <p className="m-0 text-[12px] text-brand-muted">
              This supplier has no posted invoices on this project. The payment can still be saved and posted — it
              will be held as unallocated money on account.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((row, idx) => {
                const target = targetById.get(row.supplierInvoiceId)
                const chosenElsewhere = new Set(rows.filter((_, i) => i !== idx).map(r => r.supplierInvoiceId).filter(Boolean))
                return (
                  <div key={idx} className="rounded-lg border border-brand-border p-2.5 flex flex-col gap-2">
                    <div className="grid grid-cols-1 sm:grid-cols-[1.6fr_1fr_auto_auto] gap-2 items-start">
                      <select
                        className={inputCls}
                        value={row.supplierInvoiceId}
                        onChange={e => setRow(idx, { supplierInvoiceId: e.target.value })}
                      >
                        <option value="">Select an invoice…</option>
                        {targets
                          .filter(t => !chosenElsewhere.has(t.id))
                          .map(t => (
                            <option key={t.id} value={t.id}>
                              {t.invoiceNumber}{t.supplierInvoiceNumber ? ` · ${t.supplierInvoiceNumber}` : ''} — {t.invoiceDate || 'no date'}
                            </option>
                          ))}
                      </select>
                      <input
                        type="number" min="0" step="0.01"
                        className={inputCls}
                        placeholder="Allocate"
                        value={row.allocatedAmount}
                        onChange={e => setRow(idx, { allocatedAmount: e.target.value })}
                      />
                      <Btn sm variant="ghost" type="button" onClick={() => allocateRemaining(idx)} disabled={!target}>
                        Allocate remaining
                      </Btn>
                      <button
                        type="button"
                        onClick={() => removeRow(idx)}
                        aria-label="Remove allocation"
                        className="text-brand-muted hover:text-brand-red text-lg leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
                      >
                        ×
                      </button>
                    </div>
                    {target && (
                      <>
                        <p className="m-0 text-[11px] text-brand-muted">
                          {/* The retention line appears ONLY when something is
                              actually withheld — a zero retention line would be
                              noise on the direct-PO invoices that are the norm. */}
                          {target.retentionTotal > 0 && (
                            <>
                              invoiced {money(target.grossTotal)} (inc. GST) · retention withheld −{money(target.retentionTotal)} ·{' '}
                            </>
                          )}
                          payable {money(target.payableTotal)} · paid to date {money(target.paid)} ·
                          {' '}<span className={target.remaining < 0 ? 'text-brand-red font-semibold' : 'text-brand-text font-semibold'}>
                            remaining payable {money(target.remaining)}
                          </span>
                          {target.dueDate ? ` · due ${target.dueDate}` : ''}
                        </p>
                        {target.legacyNameMatch && (
                          <p className="m-0 text-[11px] text-brand-amber">{LEGACY_SUPPLIER_MATCH_NOTE}</p>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
            Only <span className="font-semibold">posted</span> invoices belonging to the selected supplier can be
            allocated — approved is not the financial commit point. Allocations are freely editable while the payment
            is a draft and freeze permanently when it is posted. A payment may be left partly or entirely unallocated.
          </p>
          <p className="m-0 mt-1 text-[11px] text-brand-muted">{RETENTION_HELPER_TEXT}</p>
        </div>

        <div>
          <label className={labelCls}>Notes</label>
          <input className={inputCls} placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        {warnings.map((w, i) => (
          <p key={i} className="m-0 text-[12px] text-brand-amber">⚠ {w.message}</p>
        ))}

        {needsAck && (
          <label className="flex items-start gap-2 text-[12px] text-brand-text cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={e => setAcknowledged(e.target.checked)}
            />
            <span>
              I understand this pays more than the invoice&apos;s remaining payable and want to save it anyway.
              <span className="block text-brand-muted mt-0.5">
                Constrapp warns but never blocks over-reconciliation, and cannot prevent two users allocating the
                same remaining payable at the same time.
              </span>
            </span>
          </label>
        )}

        {/* Allocated / unallocated summary */}
        <div className="rounded-lg border border-brand-border p-3">
          <div className="grid grid-cols-3 gap-3">
            <Metric label="Amount Paid" value={money(cash)} help="Gross cash" />
            <Metric label="Allocated" value={money(allocated)} help={`${builtAllocations.length} invoice${builtAllocations.length === 1 ? '' : 's'}`} />
            <Metric
              label="Unallocated"
              value={money(unallocated)}
              danger={overAllocatesPayment}
              help={overAllocatesPayment ? 'Exceeds the payment' : 'Held on account'}
            />
          </div>
          {toCents(unallocated) > 0 && !overAllocatesPayment && (
            <p className="m-0 mt-2 text-[11px] text-brand-amber">
              {money(unallocated)} will be recorded as unallocated money on account. It counts as cash paid and
              reduces no invoice balance until you allocate it.
            </p>
          )}
        </div>

        {validationError && <p className="text-[12px] text-brand-red m-0">{validationError}</p>}
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}

        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !valid}>
            {saving ? 'Saving…' : isEdit ? 'Save draft' : 'Create draft payment'}
          </Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Post ─────────────────────────────────────────────────────────────────────

function PostModal({ payment, currencyCode, onClose, onConfirm }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  // ⚠️ CLIENT-ENFORCED. Firestore rules validate only the 'YYYY-MM-DD' shape of
  // paymentDate — a direct SDK call can post a future-dated payment.
  const blocked = postBlockedReason(payment)

  async function submit(e) {
    e.preventDefault()
    if (blocked) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(payment)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to post. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell title={`Post ${payment.paymentNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Posting records this money as actually paid. The supplier, amount, date, method, references, and
          allocations freeze permanently — a posted payment can only be voided, never edited.
        </p>
        <div className="grid grid-cols-3 gap-3 rounded-lg border border-brand-border p-3">
          <Metric label="Amount" value={money(payment.amount)} />
          <Metric label="Allocated" value={money(payment.allocatedTotal)} />
          <Metric label="Unallocated" value={money(payment.unallocatedAmount)} />
        </div>
        <p className="m-0 text-[12px] text-brand-muted">
          Paid {payment.paymentDate} · {paymentMethodLabel(payment.paymentMethod, payment.paymentMethodOther)}
          {payment.supplierName ? ` · ${payment.supplierName}` : ''}
        </p>
        {blocked && <p className="m-0 text-[12px] text-brand-red">{blocked}</p>}
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !!blocked}>{saving ? 'Posting…' : 'Post payment'}</Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Void ─────────────────────────────────────────────────────────────────────

function VoidModal({ payment, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!reason.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(payment, reason)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to void. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell title={`Void ${payment.paymentNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Voiding is permanent — a voided payment can never be re-posted or edited, and its
          {' '}<span className="font-semibold">{payment.paymentNumber}</span> number is retained, leaving an
          intentional gap in the sequence. Its allocations stop counting immediately, so every supplier invoice
          balance is restored at the next render. <span className="font-semibold">No bank reversal or refund is
          created</span> — voiding corrects Constrapp&apos;s record, not your bank account. Financial records are
          never deleted.
        </p>
        <div>
          <label className={labelCls}>Reason <span className="text-brand-red">*</span></label>
          <input
            className={inputCls}
            placeholder="Why is this payment being voided?"
            value={reason}
            onChange={e => setReason(e.target.value)}
            autoFocus
          />
        </div>
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !reason.trim()}>{saving ? 'Voiding…' : 'Void payment'}</Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Read-only detail ─────────────────────────────────────────────────────────

function DetailRow({ label, value }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className="m-0 text-[13px] text-brand-text break-words">{value || '—'}</p>
    </div>
  )
}

function DetailModal({ payment, supplierInvoices, currencyCode, onClose }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const byId = new Map((supplierInvoices ?? []).map(inv => [inv.id, inv]))

  return (
    <ModalShell
      wide
      title={`${payment.paymentNumber} — ${PAYMENT_STATUS_LABELS[payment.status] ?? payment.status}`}
      onClose={onClose}
    >
      <div className="px-5 py-4 flex flex-col gap-3.5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
          <DetailRow label="Supplier" value={payment.supplierName} />
          <DetailRow label="Payment Date" value={payment.paymentDate} />
          <DetailRow label="Amount Paid" value={money(payment.amount)} />
          <DetailRow label="Payment Method" value={paymentMethodLabel(payment.paymentMethod, payment.paymentMethodOther)} />
          <DetailRow label="Bank Reference" value={payment.bankReference} />
          <DetailRow label="Remittance Reference" value={payment.remittanceReference} />
          <DetailRow label="External Reference" value={payment.externalReference} />
          <DetailRow label="Allocated" value={money(payment.allocatedTotal)} />
          <DetailRow label="Unallocated" value={money(payment.unallocatedAmount)} />
          <DetailRow label="Currency (audit snapshot)" value={payment.currency} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-brand-card border-b border-brand-border">
                {['SI #', 'Supplier Invoice #', 'Status', 'Payable', 'Allocated'].map(h => (
                  <th key={h} className={thCls}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(payment.allocations ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3.5 py-3 text-[12.5px] text-brand-muted">
                    Unallocated — this money is held on account and reduces no invoice balance. It is still actual
                    cash paid.
                  </td>
                </tr>
              ) : (
                (payment.allocations ?? []).map((a, i) => {
                  const inv = byId.get(a.supplierInvoiceId)
                  return (
                    <tr key={i} className="border-b border-brand-border">
                      <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">{a.invoiceNumber || '—'}</td>
                      <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{a.supplierInvoiceNumber || '—'}</td>
                      <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">
                        {!inv
                          ? <span className="text-brand-amber">not found</span>
                          : inv.status === 'cancelled'
                            ? <span className="text-brand-amber">cancelled after posting</span>
                            : inv.status}
                      </td>
                      <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{inv ? money(inv.payableTotal) : '—'}</td>
                      <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(a.allocatedAmount)}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {payment.notes && <DetailRow label="Notes" value={payment.notes} />}
        {payment.status === PAYMENT_STATUS.VOID && <DetailRow label="Void Reason" value={payment.voidReason} />}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 border-t border-brand-border pt-3">
          <DetailRow label="Created By" value={payment.createdBy} />
          <DetailRow label="Posted By" value={payment.postedBy} />
          <DetailRow label="Voided By" value={payment.voidedBy} />
        </div>

        <p className="m-0 text-[11px] text-brand-muted border-t border-brand-border pt-3">
          A payment records gross cash paid in this project&apos;s currency ({currencyCode}). It carries no GST, no
          net amount, and no cost meaning — the tax and the cost were recorded on the supplier invoice being
          settled. Allocations reconcile against each invoice&apos;s net payable after retention withheld. Invoice
          balances are derived at read time and are never written onto invoice documents.
        </p>
      </div>
    </ModalShell>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectSupplierPayments() {
  const navigate = useNavigate()
  const location = useLocation()
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { profile, profileLoading } = useProfile()

  const canView = isFinancialRole(profile?.role)
  // Non-financial roles never trigger the commercially-sensitive reads (rules
  // would deny them anyway — this is the UX mirror; rules are the boundary).
  const mid = canView ? projectId : null

  const {
    supplierPayments, supplierPaymentsLoading, supplierPaymentsError,
    createSupplierPayment, updateSupplierPayment, postSupplierPayment, voidSupplierPayment,
  } = useSupplierPayments(mid)
  const { supplierInvoices, supplierInvoicesLoading } = useSupplierInvoices(mid)
  const {
    supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError,
  } = useSupplierCreditNotes(mid)
  const { contacts } = useContacts()

  // ⚠️ A FAILED CREDIT-NOTE READ IS UNKNOWN, NEVER ZERO. Posted credit notes
  // REDUCE each invoice's remaining payable. If they cannot be read, treating
  // them as an empty list would OVERSTATE what is still owed and could invite a
  // payment against money the supplier has already credited — the one
  // materially unsafe direction on this page. Every credit-dependent figure is
  // therefore rendered unavailable and every action that consumes a remaining
  // payable is disabled until the read succeeds. (Loading is covered by the
  // page gate below, so nothing is briefly rendered overstated either.)
  const creditStateUnknown = supplierCreditNotesError

  // ── "Record payment" hand-off from a posted Supplier Invoice ──────────────
  //
  // The hand-off arrives as ONE-SHOT route state. It is read in the useState
  // initialisers (which run once, on the mount this navigation causes) rather
  // than in an effect, so opening the editor is never a synchronous setState
  // inside an effect. The effect below only clears the history entry.
  const handOff = location.state?.recordPayment ?? null

  const [editing, setEditing] = useState(() => (handOff ? 'new' : null))   // payment | 'new' | null
  const [preselect, setPreselect] = useState(() => handOff)
  const [posting, setPosting] = useState(null)
  const [voiding, setVoiding] = useState(null)
  const [detail, setDetail]   = useState(null)
  const [search, setSearch]   = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [supplierFilter, setSupplierFilter] = useState('all')
  const [unallocatedOnly, setUnallocatedOnly] = useState(false)

  // Supplier and subcontractor contacts — the SAME list the PO supplier picker
  // uses (lib/contacts.js → PO_SUPPLIER_TYPES); no parallel list is invented.
  const supplierContacts = useMemo(
    () => contacts.filter(c => c.isActive !== false && (c.contactTypes ?? []).some(t => PO_SUPPLIER_TYPES.includes(t))),
    [contacts],
  )

  // Clear the consumed history entry so navigating back never reopens the
  // editor. This effect performs no setState — only a router replace.
  useEffect(() => {
    if (!handOff) return
    navigate(location.pathname, { replace: true, state: null })
  }, [handOff, navigate, location.pathname])

  // Resolves the raw hand-off against live data. Falls back safely: an unknown
  // supplier yields no preselection at all, and an invoice that is missing, not
  // posted, from another project, or belonging to another supplier yields the
  // supplier alone with an empty allocation table. The page gates on loading
  // below, so this has resolved before the editor ever mounts.
  const resolvedPreselect = useMemo(() => {
    if (!preselect) return null
    const contact = supplierContacts.find(c => c.id === preselect.supplierId) ?? null
    if (!contact) return null
    const invoice = supplierInvoices.find(inv => inv.id === preselect.supplierInvoiceId) ?? null
    const eligible = !!invoice
      && isPayableInvoice(invoice)
      && supplierMatchesInvoice(invoice, contact.id, contact.displayName)
    return { supplierId: contact.id, supplierInvoiceId: eligible ? invoice.id : null }
  }, [preselect, supplierContacts, supplierInvoices])

  const summary = useMemo(() => paymentSummary(supplierPayments), [supplierPayments])
  const payables = useMemo(
    () => payablesSummary(supplierInvoices, supplierPayments, supplierCreditNotes),
    [supplierInvoices, supplierPayments, supplierCreditNotes],
  )
  const ageing = useMemo(
    () => apAgeing(supplierInvoices, supplierPayments, supplierCreditNotes),
    [supplierInvoices, supplierPayments, supplierCreditNotes],
  )
  const exceptions = useMemo(
    () => allocationExceptions(supplierPayments, supplierInvoices),
    [supplierPayments, supplierInvoices],
  )

  const supplierNames = [...new Set(supplierPayments.map(p => p.supplierName).filter(Boolean))].sort()

  const filtered = supplierPayments.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false
    if (supplierFilter !== 'all' && p.supplierName !== supplierFilter) return false
    if (unallocatedOnly && toCents(p.unallocatedAmount) <= 0) return false
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      const hay = [
        p.paymentNumber, p.supplierName, p.bankReference, p.remittanceReference, p.externalReference, p.notes,
        ...(p.allocations ?? []).map(a => a.invoiceNumber),
        ...(p.allocations ?? []).map(a => a.supplierInvoiceNumber),
      ].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  function openNew() {
    setPreselect(null)
    setEditing('new')
  }

  // ── Gates ──────────────────────────────────────────────────────────────────
  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!canView) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Supplier payments are restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          Supplier payments and the project cash position are visible to Company Admin, Project Manager, and QS
          roles only. Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }
  // Credit notes are part of the loading gate: rendering the register before
  // they arrive would show an overstated remaining payable for a moment.
  if (supplierPaymentsLoading || supplierInvoicesLoading || supplierCreditNotesLoading) {
    return <div className="text-[13px] text-brand-muted">Loading supplier payments…</div>
  }

  // Credit-dependent money: rendered "—" (unavailable) rather than an
  // overstated figure whenever credit-note state could not be read.
  const apMoney = (n) => (creditStateUnknown ? '—' : money(n))

  return (
    <div>
      {creditStateUnknown && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">
            Supplier Credit Notes could not be loaded — payable figures are unavailable
          </p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            Posted credit notes reduce what is still owed on each supplier invoice. Because they cannot be read,
            Constrapp does <span className="font-semibold">not</span> know the true remaining payable and will not
            show it as though no credits exist. Recording, editing, and posting payments are disabled until the
            read succeeds, so a payment cannot be made against money that has already been credited. Voiding an
            existing payment is still permitted. Reload the page; if this persists, check your connection and
            permissions.
          </p>
        </Card>
      )}

      {/* ── Cash paid ──────────────────────────────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
          <Metric label="Payments Recorded" value={money(summary.postedAmount)} help={`${summary.postedCount} posted · total actual cash out`} />
          <Metric label="Allocated" value={money(summary.allocated)} help="Posted money matched to supplier invoices" />
          <Metric label="Unallocated — on account" value={money(summary.unallocated)} help="Cash paid but not matched to an invoice" />
          <Metric label="Draft Payments" value={money(summary.draftAmount)} help={`${summary.draftCount} draft · not counted`} />
          <Metric label="Paid to Date" value={money(payables.paid)} help="Against posted supplier invoices" />
          <Metric
            label="Remaining Payable"
            value={apMoney(payables.remaining)}
            help={creditStateUnknown
              ? 'Unavailable — credit notes could not be read'
              : 'Posted invoices, after posted payments and credit notes'}
          />
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          A payment records gross cash paid. Only <span className="font-semibold">posted</span> payments count;
          drafts and voids contribute nothing. Every invoice balance is derived at read time — nothing is written
          onto a supplier invoice, and no invoice is ever marked <span className="font-semibold">paid</span>.
        </p>
      </Card>

      {/* ── Accounts payable ageing ────────────────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2.5">
          <p className="text-[13px] font-bold text-brand-text m-0">Accounts Payable — ageing by due date</p>
          <p className="m-0 text-[11px] text-brand-muted">Remaining payable after posted Supplier Payments.</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
          <Metric label="Total Posted Supplier Invoices" value={money(payables.postedPayable)} help={`${payables.count} posted · net payable`} />
          <Metric label="Paid to Date" value={money(payables.paid)} help="Posted payments allocated to invoices" />
          <Metric label="Remaining Payable" value={apMoney(ageing.total)} help="Posted invoices still payable" />
          {AGEING_BUCKETS.map(b => (
            <Metric
              key={b.key}
              label={b.label}
              value={apMoney(ageing.buckets[b.key].amount)}
              help={creditStateUnknown
                ? 'Unavailable'
                : `${ageing.buckets[b.key].count} invoice${ageing.buckets[b.key].count === 1 ? '' : 's'}`}
              danger={!creditStateUnknown && (b.key === 'd61_90' || b.key === 'd90plus')}
            />
          ))}
        </div>

        {!creditStateUnknown && ageing.overSettled.length > 0 && (
          <div className="mt-3 pt-3 border-t border-brand-border">
            <p className="m-0 text-[12px] font-bold text-brand-red">Over-reconciled invoices — excluded from ageing</p>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              More has been paid against these invoices than was payable. Their balances are shown signed and are
              never clamped, and they are kept out of the buckets above so they cannot offset genuine arrears.
            </p>
            <div className="flex flex-wrap gap-3 mt-2">
              {ageing.overSettled.map(r => (
                <span key={r.id} className="text-[12px] text-brand-text">
                  <span className="font-semibold">{r.invoiceNumber}</span>{' '}
                  <span className="text-brand-red font-semibold">{money(r.remaining)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <p className="m-0 mt-3 text-[11px] text-brand-muted">{AP_RECONCILIATION_NOTICE}</p>
      </Card>

      {/* ── Allocation exceptions ──────────────────────────────────────────── */}
      {exceptions.length > 0 && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">Allocation exceptions</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">{ALLOCATION_EXCEPTION_REMEDY}</p>
          <div className="flex flex-col gap-1 mt-2.5">
            {exceptions.map((x, i) => (
              <p key={i} className="m-0 text-[12px] text-brand-text">
                <span className="font-semibold">{x.paymentNumber}</span> → {allocationInvoiceLabel(x)}
                {' '}({money(x.allocatedAmount)}) — {x.reason}
              </p>
            ))}
          </div>
        </Card>
      )}

      {/* ── Register ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          Money paid to this project&apos;s suppliers, allocated against posted supplier invoices.
        </p>
        <div className="flex items-center gap-2">
          <Btn variant="ghost" sm onClick={() => navigate(`/projects/${projectId}/invoices`)}>Supplier Invoices</Btn>
          {supplierContacts.length === 0 && (
            <Btn variant="ghost" sm onClick={() => navigate('/contacts')}>Add a supplier contact</Btn>
          )}
          <Btn sm onClick={openNew} disabled={supplierContacts.length === 0 || creditStateUnknown}>+ New Payment</Btn>
        </div>
      </div>

      {supplierPaymentsError && (
        <p className="text-[12px] text-brand-amber mb-3">Couldn&apos;t load supplier payments — check your connection and access.</p>
      )}

      {supplierPayments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3.5">
          <input
            className={`${inputCls} max-w-[280px]`}
            placeholder="Search SP #, supplier, reference, SI # or supplier invoice #…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className={`${inputCls} max-w-[170px]`} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {[PAYMENT_STATUS.DRAFT, PAYMENT_STATUS.POSTED, PAYMENT_STATUS.VOID].map(s => (
              <option key={s} value={s}>{PAYMENT_STATUS_LABELS[s]}</option>
            ))}
          </select>
          {supplierNames.length > 0 && (
            <select className={`${inputCls} max-w-[220px]`} value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)}>
              <option value="all">All suppliers</option>
              {supplierNames.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}
          <Btn sm variant={unallocatedOnly ? 'success' : 'ghost'} onClick={() => setUnallocatedOnly(v => !v)}>
            Has unallocated
          </Btn>
        </div>
      )}

      <Card padding={false}>
        {supplierPayments.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {supplierContacts.length === 0
                ? 'Add a supplier or subcontractor contact before recording payments.'
                : 'No payments yet. Record the first money paid to a supplier.'}
            </p>
            {supplierContacts.length === 0
              ? <Btn variant="ghost" onClick={() => navigate('/contacts')}>Go to Contacts</Btn>
              : <Btn onClick={openNew} disabled={creditStateUnknown}>+ Record your first payment</Btn>}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">No payments match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['SP #', 'Supplier', 'Payment Date', 'Method', 'Bank Ref', 'Remittance Ref', 'Amount', 'Allocated', 'Unallocated', 'Invoices', 'Status', ''].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => {
                  const future = p.status === PAYMENT_STATUS.DRAFT && isFutureDatedPayment(p)
                  const invoiceLabels = (p.allocations ?? []).map(a => allocationInvoiceLabel(a)).join(', ')
                  return (
                    <tr key={p.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setDetail(p)}
                          className="text-brand-accent hover:underline cursor-pointer"
                        >
                          {p.paymentNumber}
                        </button>
                      </td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-text">{p.supplierName || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] whitespace-nowrap">
                        <span className={future ? 'text-brand-amber font-semibold' : 'text-brand-muted'}>
                          {p.paymentDate || '—'}{future ? ' • future' : ''}
                        </span>
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">
                        {paymentMethodLabel(p.paymentMethod, p.paymentMethodOther)}
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{p.bankReference || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{p.remittanceReference || '—'}</td>
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{money(p.amount)}</td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">{money(p.allocatedTotal)}</td>
                      <td className="px-3.5 py-3 text-[13px] whitespace-nowrap">
                        <span className={toCents(p.unallocatedAmount) > 0 ? 'text-brand-amber font-semibold' : 'text-brand-muted'}>
                          {money(p.unallocatedAmount)}
                        </span>
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{invoiceLabels || '—'}</td>
                      <td className="px-3.5 py-3">
                        <Badge label={PAYMENT_STATUS_LABELS[p.status] ?? p.status} variant={PAYMENT_BADGE_VARIANTS[p.status]} sm />
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex gap-1.5 justify-end">
                          {p.status === PAYMENT_STATUS.DRAFT && (
                            <>
                              {/* Editing re-opens the allocation picker and
                                  posting commits cash against a remaining
                                  payable — both need trustworthy credit state.
                                  Void stays available: it only removes money. */}
                              <Btn sm variant="ghost" disabled={creditStateUnknown} onClick={() => { setPreselect(null); setEditing(p) }}>Edit</Btn>
                              <Btn sm variant="success" disabled={creditStateUnknown} onClick={() => setPosting(p)}>Post</Btn>
                            </>
                          )}
                          {(p.status === PAYMENT_STATUS.DRAFT || p.status === PAYMENT_STATUS.POSTED) && (
                            <Btn sm variant="ghost" onClick={() => setVoiding(p)}>Void</Btn>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Reconciliation by invoice ──────────────────────────────────────── */}
      {payables.rows.length > 0 && (
        <Card className="mt-3.5" padding={false}>
          <div className="px-5 pt-4 pb-2">
            <p className="text-[13px] font-bold text-brand-text m-0">Posted supplier invoices — reconciliation</p>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Derived at read time from posted payments and posted supplier credit notes. Nothing is written onto a
              supplier invoice: no balance field, no payment status, no back-reference. Payable is net of retention
              withheld; a negative remaining payable that includes a credit note is money recoverable from the
              supplier (no refund is recorded automatically).
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-y border-brand-border">
                  {['SI #', 'Supplier Invoice #', 'Supplier', 'Due', 'Gross', 'Retention', 'Payable', 'Paid to Date', 'Credited', 'Remaining Payable', 'Reconciliation'].map(h => (
                    <th key={h} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payables.rows.map(r => (
                  <tr key={r.id} className="border-b border-brand-border last:border-b-0">
                    <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">{r.invoiceNumber}</td>
                    <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{r.supplierInvoiceNumber || '—'}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-text">{r.supplierName || '—'}</td>
                    <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{r.dueDate || '—'}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{money(r.grossTotal)}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{r.retentionTotal ? `−${money(r.retentionTotal)}` : '—'}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(r.payableTotal)}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{money(r.paid)}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">
                      {creditStateUnknown ? '—' : (r.credited ? `−${money(r.credited)}` : '—')}
                    </td>
                    <td className={`px-3.5 py-2.5 text-[13px] font-semibold whitespace-nowrap ${!creditStateUnknown && r.remaining < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
                      {apMoney(r.remaining)}
                    </td>
                    <td className="px-3.5 py-2.5">
                      {creditStateUnknown
                        ? <span className="text-[12px] text-brand-muted">—</span>
                        : <Badge label={RECONCILIATION_LABELS[r.state]} variant={RECONCILIATION_BADGE_VARIANTS[r.state]} sm />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        Constrapp records cash movements and their allocations. It cannot verify that money genuinely left your
        bank account, cannot block over-reconciliation, and cannot prevent two users allocating the same remaining
        payable concurrently — Firestore rules cannot sum sibling documents. Supplier Credit Notes are recorded on
        the Supplier Invoices view and reduce each invoice&apos;s remaining payable here. Refunds, retention
        release, remittance output, bank reconciliation, and accounting integrations are future work.
      </p>

      {editing && (
        <PaymentEditorModal
          key={editing === 'new' ? `new_${resolvedPreselect?.supplierInvoiceId ?? resolvedPreselect?.supplierId ?? 'blank'}` : editing.id}
          payment={editing === 'new' ? null : editing}
          supplierContacts={supplierContacts}
          supplierInvoices={supplierInvoices}
          supplierPayments={supplierPayments}
          supplierCreditNotes={supplierCreditNotes}
          preselect={editing === 'new' ? resolvedPreselect : null}
          currencyCode={currencyCode}
          onClose={() => { setEditing(null); setPreselect(null) }}
          onSave={editing === 'new'
            ? createSupplierPayment
            : (data) => updateSupplierPayment(editing, data)}
        />
      )}

      {posting && (
        <PostModal
          payment={posting}
          currencyCode={currencyCode}
          onClose={() => setPosting(null)}
          onConfirm={postSupplierPayment}
        />
      )}

      {voiding && (
        <VoidModal payment={voiding} onClose={() => setVoiding(null)} onConfirm={voidSupplierPayment} />
      )}

      {detail && (
        <DetailModal
          payment={detail}
          supplierInvoices={supplierInvoices}
          currencyCode={currencyCode}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}
