import { useMemo, useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency } from '../../lib/formatters'
import { roundMoney } from '../../lib/purchaseOrders'
import { useProfile } from '../../hooks/useProfile'
import { useClientReceipts } from '../../hooks/useClientReceipts'
import { useClientInvoices } from '../../hooks/useClientInvoices'
import { useContacts } from '../../hooks/useContacts'
import { CONTACT_TYPE } from '../../lib/contacts'
import { isFinancialRole } from '../../lib/margin'
import {
  PAYMENT_STATUS, PAYMENT_STATUS_LABELS, PAYMENT_BADGE_VARIANTS,
  PAYMENT_METHOD, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, paymentMethodLabel,
  allocatedTotal, unallocatedAmount, toCents, todayIso, isFutureDate,
  validateAllocations,
} from '../../lib/payments'
import {
  allocatableInvoices, allocateOldestFirst, buildAllocations,
  invoiceOverAllocationWarnings, allocationExceptions, ALLOCATION_EXCEPTION_REMEDY,
  receiptSummary, receivablesSummary, postBlockedReason, isFutureDatedReceipt,
  validateReceiptDraft,
} from '../../lib/clientReceipts'

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

const blankRow = () => ({ clientInvoiceId: '', allocatedAmount: '' })

function ReceiptEditorModal({
  receipt, clientContacts, clientInvoices, clientReceipts,
  currencyCode, onClose, onSave,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const isEdit = !!receipt

  const [clientId, setClientId]     = useState(receipt?.clientId || '')
  const [receiptDate, setReceiptDate] = useState(receipt?.receiptDate || todayIso())
  const [amount, setAmount]         = useState(receipt ? String(receipt.amount ?? '') : '')
  const [method, setMethod]         = useState(receipt?.paymentMethod || '')
  const [methodOther, setMethodOther] = useState(receipt?.paymentMethodOther || '')
  const [bankReference, setBankReference] = useState(receipt?.bankReference || '')
  const [externalReference, setExternalReference] = useState(receipt?.externalReference || '')
  const [notes, setNotes]           = useState(receipt?.notes || '')
  const [rows, setRows] = useState(() =>
    receipt?.allocations?.length
      ? receipt.allocations.map(a => ({
          clientInvoiceId: a.clientInvoiceId || '',
          allocatedAmount: String(a.allocatedAmount ?? ''),
        }))
      : [blankRow()],
  )
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const client = clientContacts.find(c => c.id === clientId) ?? null
  const cash   = roundMoney(Number(amount) || 0)

  // The issued, non-void invoices of the SELECTED CLIENT, with their live
  // remaining balances. Excludes this receipt's own posted allocations so an
  // edit never double-counts itself.
  const targets = useMemo(
    () => allocatableInvoices(clientInvoices, clientId, clientReceipts, { excludeReceiptId: receipt?.id ?? null }),
    [clientInvoices, clientId, clientReceipts, receipt?.id],
  )
  const targetById = useMemo(() => new Map(targets.map(t => [t.id, t])), [targets])

  // Changing the client invalidates every allocation — an invoice belongs to one
  // client, so the existing rows can no longer be valid. Confirmed explicitly,
  // never silently discarded.
  function changeClient(e) {
    const next = e.target.value
    const hasAllocations = rows.some(r => r.clientInvoiceId)
    if (hasAllocations && next !== clientId) {
      const ok = window.confirm(
        'Changing the client will remove the allocations on this receipt, because an invoice belongs to one client. Continue?',
      )
      if (!ok) return
      setRows([blankRow()])
    }
    setClientId(next)
    setAcknowledged(false)
  }

  const setRow = (idx, patch) => setRows(rs => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const addRow = () => setRows(rs => [...rs, blankRow()])
  const removeRow = (idx) => setRows(rs => (rs.length === 1 ? [blankRow()] : rs.filter((_, i) => i !== idx)))

  // Allocate exactly what is still outstanding on that invoice, capped by the
  // cash still unallocated on this receipt.
  function allocateRemaining(idx) {
    const row = rows[idx]
    const target = targetById.get(row.clientInvoiceId)
    if (!target) return
    const others = rows.filter((_, i) => i !== idx)
    const otherTotal = allocatedTotal(others.map(r => ({ allocatedAmount: Number(r.allocatedAmount) || 0 })))
    const cashLeft = Math.max(roundMoney(cash - otherTotal), 0)
    const take = Math.min(Math.max(target.remaining, 0), cashLeft)
    setRow(idx, { allocatedAmount: String(take) })
  }

  // ⚠️ EXPLICIT ACTION ONLY. This runs on a button press and produces a
  // PROPOSAL the user can edit or discard — Constrapp never silently decides
  // which debt a client's money settles.
  function allocateOldest() {
    const proposal = allocateOldestFirst(cash, targets)
    setRows(proposal.length
      ? proposal.map(a => ({ clientInvoiceId: a.clientInvoiceId, allocatedAmount: String(a.allocatedAmount) }))
      : [blankRow()])
    setAcknowledged(false)
  }

  const builtAllocations = useMemo(
    () => buildAllocations(
      rows.map(r => ({ clientInvoiceId: r.clientInvoiceId, allocatedAmount: Number(r.allocatedAmount) || 0 })),
      clientInvoices,
    ),
    [rows, clientInvoices],
  )

  const allocated   = allocatedTotal(builtAllocations)
  const unallocated = unallocatedAmount(cash, allocated)

  // Over-allocating the RECEIPT is impossible — the money does not exist.
  const overAllocatesReceipt = toCents(allocated) > toCents(cash)
  // Over-allocating an INVOICE is warned with an acknowledgement, never blocked:
  // it cannot be enforced anywhere (rules cannot sum sibling documents).
  const warnings = useMemo(
    () => invoiceOverAllocationWarnings(builtAllocations, clientInvoices, clientReceipts, { excludeReceiptId: receipt?.id ?? null }),
    [builtAllocations, clientInvoices, clientReceipts, receipt?.id],
  )
  const needsAck = warnings.length > 0

  const futureDated = isFutureDate(receiptDate)

  const validationError =
    validateReceiptDraft({
      clientId, clientName: client?.displayName || '', receiptDate, amount: cash,
      paymentMethod: method, paymentMethodOther: methodOther,
      allocations: builtAllocations, invoices: clientInvoices,
    })
    ?? validateAllocations(builtAllocations, cash, 'clientInvoiceId')

  const valid = !validationError && (!needsAck || acknowledged)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      await onSave({
        clientId,
        clientName: client?.displayName || '',
        receiptDate,
        amount: cash,
        paymentMethod: method,
        paymentMethodOther: methodOther,
        bankReference,
        externalReference,
        allocations: builtAllocations,
        notes,
        invoices: clientInvoices,
      })
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell wide title={isEdit ? `Edit ${receipt.receiptNumber}` : 'New Client Receipt'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
        {/* Client + date + amount */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Client <span className="text-brand-red">*</span></label>
            <select className={inputCls} value={clientId} onChange={changeClient} required>
              <option value="" disabled>Select the client…</option>
              {clientContacts.map(c => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </select>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Client-type contacts only. The name is snapshotted onto this receipt, so later contact edits never
              rewrite the cash record.
            </p>
          </div>
          <div>
            <label className={labelCls}>Receipt Date <span className="text-brand-red">*</span></label>
            <input type="date" className={inputCls} value={receiptDate} onChange={e => setReceiptDate(e.target.value)} />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              The date the money was actually received — not the date you are entering it.
            </p>
          </div>
          <div>
            <label className={labelCls}>Amount Received <span className="text-brand-red">*</span></label>
            <input
              type="number" min="0" step="0.01"
              className={inputCls}
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Gross cash received ({currencyCode}). No GST is calculated — tax was recorded on the invoice.
            </p>
          </div>
        </div>

        {futureDated && (
          <p className="m-0 text-[12px] text-brand-amber">
            ⚠ This receipt date is in the future. The draft can be saved, but it cannot be posted until
            {' '}{receiptDate} — posting states that money has actually been received.
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
            <p className="m-0 mt-1 text-[11px] text-brand-muted">Not pre-filled — record how the money actually arrived.</p>
          </div>
          {method === PAYMENT_METHOD.OTHER ? (
            <div>
              <label className={labelCls}>Describe the method <span className="text-brand-red">*</span></label>
              <input className={inputCls} placeholder="e.g. offset against retention" value={methodOther} onChange={e => setMethodOther(e.target.value)} />
            </div>
          ) : (
            <div>
              <label className={labelCls}>Bank Reference</label>
              <input className={inputCls} placeholder="Your bank statement reference" value={bankReference} onChange={e => setBankReference(e.target.value)} />
              <p className="m-0 mt-1 text-[11px] text-brand-muted">Optional — the key for future bank reconciliation.</p>
            </div>
          )}
          <div>
            <label className={labelCls}>External Reference</label>
            <input className={inputCls} placeholder="e.g. Xero PMT-0042" value={externalReference} onChange={e => setExternalReference(e.target.value)} />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">Optional — the receipt in your accounting system.</p>
          </div>
        </div>

        {method === PAYMENT_METHOD.OTHER && (
          <div className="sm:max-w-[33%]">
            <label className={labelCls}>Bank Reference</label>
            <input className={inputCls} placeholder="Your bank statement reference" value={bankReference} onChange={e => setBankReference(e.target.value)} />
          </div>
        )}

        {/* Allocations */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label className={labelCls}>Allocate to Client Invoices</label>
            <div className="flex flex-wrap gap-2 mb-1.5">
              <Btn sm variant="ghost" type="button" onClick={allocateOldest} disabled={!clientId || cash <= 0 || targets.length === 0}>
                Allocate oldest first
              </Btn>
              <Btn sm variant="ghost" type="button" onClick={addRow} disabled={!clientId}>+ Add allocation</Btn>
            </div>
          </div>

          {!clientId ? (
            <p className="m-0 text-[12px] text-brand-muted">Select a client to see their issued invoices.</p>
          ) : targets.length === 0 ? (
            <p className="m-0 text-[12px] text-brand-muted">
              This client has no issued invoices on this project. The receipt can still be saved and posted — it will
              be held as unallocated money on account.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((row, idx) => {
                const target = targetById.get(row.clientInvoiceId)
                const chosenElsewhere = new Set(rows.filter((_, i) => i !== idx).map(r => r.clientInvoiceId).filter(Boolean))
                return (
                  <div key={idx} className="rounded-lg border border-brand-border p-2.5 flex flex-col gap-2">
                    <div className="grid grid-cols-1 sm:grid-cols-[1.6fr_1fr_auto_auto] gap-2 items-start">
                      <select
                        className={inputCls}
                        value={row.clientInvoiceId}
                        onChange={e => setRow(idx, { clientInvoiceId: e.target.value })}
                      >
                        <option value="">Select an invoice…</option>
                        {targets
                          .filter(t => !chosenElsewhere.has(t.id))
                          .map(t => (
                            <option key={t.id} value={t.id}>
                              {t.invoiceNumber} — {t.invoiceDate || 'no date'}
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
                      <p className="m-0 text-[11px] text-brand-muted">
                        {target.invoiceNumber} invoiced {money(target.grossTotal)} (inc. GST) · received to date {money(target.received)} ·
                        {' '}<span className={target.remaining < 0 ? 'text-brand-red font-semibold' : 'text-brand-text font-semibold'}>
                          remaining to reconcile {money(target.remaining)}
                        </span>
                        {target.dueDate ? ` · due ${target.dueDate}` : ''}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
            Only <span className="font-semibold">issued</span> invoices belonging to the selected client can be
            allocated. Allocations are freely editable while the receipt is a draft and freeze permanently when it is
            posted. A receipt may be left partly or entirely unallocated.
          </p>
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
              I understand this allocates more than the invoice&apos;s remaining balance and want to save it anyway.
              <span className="block text-brand-muted mt-0.5">
                Constrapp warns but never blocks over-allocation, and cannot prevent two users allocating the same
                remaining balance at the same time.
              </span>
            </span>
          </label>
        )}

        {/* Allocated / unallocated summary */}
        <div className="rounded-lg border border-brand-border p-3">
          <div className="grid grid-cols-3 gap-3">
            <Metric label="Amount Received" value={money(cash)} help="Gross cash" />
            <Metric label="Allocated" value={money(allocated)} help={`${builtAllocations.length} invoice${builtAllocations.length === 1 ? '' : 's'}`} />
            <Metric
              label="Unallocated"
              value={money(unallocated)}
              danger={overAllocatesReceipt}
              help={overAllocatesReceipt ? 'Exceeds the receipt' : 'Held on account'}
            />
          </div>
          {toCents(unallocated) > 0 && !overAllocatesReceipt && (
            <p className="m-0 mt-2 text-[11px] text-brand-amber">
              {money(unallocated)} will be recorded as unallocated money on account. It counts as cash received and
              reduces no invoice balance until you allocate it.
            </p>
          )}
        </div>

        {validationError && <p className="text-[12px] text-brand-red m-0">{validationError}</p>}
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}

        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !valid}>
            {saving ? 'Saving…' : isEdit ? 'Save draft' : 'Create draft receipt'}
          </Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Post ─────────────────────────────────────────────────────────────────────

function PostModal({ receipt, currencyCode, onClose, onConfirm }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  // ⚠️ CLIENT-ENFORCED. Firestore rules validate only the 'YYYY-MM-DD' shape of
  // receiptDate — a direct SDK call can post a future-dated receipt.
  const blocked = postBlockedReason(receipt)

  async function submit(e) {
    e.preventDefault()
    if (blocked) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(receipt)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to post. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell title={`Post ${receipt.receiptNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Posting records this money as actually received. The amount, date, method, references, and allocations
          freeze permanently — a posted receipt can only be voided, never edited.
        </p>
        <div className="grid grid-cols-3 gap-3 rounded-lg border border-brand-border p-3">
          <Metric label="Amount" value={money(receipt.amount)} />
          <Metric label="Allocated" value={money(receipt.allocatedTotal)} />
          <Metric label="Unallocated" value={money(receipt.unallocatedAmount)} />
        </div>
        <p className="m-0 text-[12px] text-brand-muted">
          Received {receipt.receiptDate} · {paymentMethodLabel(receipt.paymentMethod, receipt.paymentMethodOther)}
        </p>
        {blocked && <p className="m-0 text-[12px] text-brand-red">{blocked}</p>}
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !!blocked}>{saving ? 'Posting…' : 'Post receipt'}</Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Void ─────────────────────────────────────────────────────────────────────

function VoidModal({ receipt, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!reason.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(receipt, reason)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to void. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell title={`Void ${receipt.receiptNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Voiding is permanent — a voided receipt can never be re-posted or edited, and its number is retained,
          leaving an intentional gap in the sequence. Its allocations stop counting immediately, so every invoice
          balance is restored at the next render. No reversal record is created, and financial records are never
          deleted.
        </p>
        <div>
          <label className={labelCls}>Reason <span className="text-brand-red">*</span></label>
          <input
            className={inputCls}
            placeholder="Why is this receipt being voided?"
            value={reason}
            onChange={e => setReason(e.target.value)}
            autoFocus
          />
        </div>
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !reason.trim()}>{saving ? 'Voiding…' : 'Void receipt'}</Btn>
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

function DetailModal({ receipt, clientInvoices, currencyCode, onClose }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const byId = new Map((clientInvoices ?? []).map(inv => [inv.id, inv]))

  return (
    <ModalShell
      wide
      title={`${receipt.receiptNumber} — ${PAYMENT_STATUS_LABELS[receipt.status] ?? receipt.status}`}
      onClose={onClose}
    >
      <div className="px-5 py-4 flex flex-col gap-3.5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
          <DetailRow label="Client" value={receipt.clientName} />
          <DetailRow label="Receipt Date" value={receipt.receiptDate} />
          <DetailRow label="Amount Received" value={money(receipt.amount)} />
          <DetailRow label="Payment Method" value={paymentMethodLabel(receipt.paymentMethod, receipt.paymentMethodOther)} />
          <DetailRow label="Bank Reference" value={receipt.bankReference} />
          <DetailRow label="External Reference" value={receipt.externalReference} />
          <DetailRow label="Allocated" value={money(receipt.allocatedTotal)} />
          <DetailRow label="Unallocated" value={money(receipt.unallocatedAmount)} />
          <DetailRow label="Currency (audit snapshot)" value={receipt.currency} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-brand-card border-b border-brand-border">
                {['Invoice', 'Status', 'Invoice Total', 'Allocated'].map(h => (
                  <th key={h} className={thCls}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(receipt.allocations ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3.5 py-3 text-[12.5px] text-brand-muted">
                    Unallocated — this money is held on account and reduces no invoice balance.
                  </td>
                </tr>
              ) : (
                (receipt.allocations ?? []).map((a, i) => {
                  const inv = byId.get(a.clientInvoiceId)
                  return (
                    <tr key={i} className="border-b border-brand-border">
                      <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">{a.invoiceNumber || '—'}</td>
                      <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">
                        {!inv
                          ? <span className="text-brand-amber">not found</span>
                          : inv.status === 'void'
                            ? <span className="text-brand-amber">voided after posting</span>
                            : inv.status}
                      </td>
                      <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{inv ? money(inv.grossTotal) : '—'}</td>
                      <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(a.allocatedAmount)}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {receipt.notes && <DetailRow label="Notes" value={receipt.notes} />}
        {receipt.status === PAYMENT_STATUS.VOID && <DetailRow label="Void Reason" value={receipt.voidReason} />}

        <p className="m-0 text-[11px] text-brand-muted border-t border-brand-border pt-3">
          A receipt records gross cash received in this project&apos;s currency ({currencyCode}). It carries no GST,
          no net amount, and no revenue meaning — the tax was recorded on the invoice being reconciled. Invoice
          balances are derived at read time and are never written onto invoice documents.
        </p>
      </div>
    </ModalShell>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectClientReceipts() {
  const navigate = useNavigate()
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { profile, profileLoading } = useProfile()

  const canView = isFinancialRole(profile?.role)
  // Non-financial roles never trigger the commercially-sensitive reads (rules
  // would deny them anyway — this is the UX mirror; rules are the boundary).
  const mid = canView ? projectId : null

  const {
    clientReceipts, clientReceiptsLoading, clientReceiptsError,
    createClientReceipt, updateClientReceipt, postClientReceipt, voidClientReceipt,
  } = useClientReceipts(mid)
  const { clientInvoices, clientInvoicesLoading } = useClientInvoices(mid)
  const { contacts } = useContacts()

  const [editing, setEditing] = useState(null)   // receipt | 'new' | null
  const [posting, setPosting] = useState(null)
  const [voiding, setVoiding] = useState(null)
  const [detail, setDetail]   = useState(null)
  const [search, setSearch]   = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [clientFilter, setClientFilter] = useState('all')
  const [unallocatedOnly, setUnallocatedOnly] = useState(false)

  const clientContacts = useMemo(
    () => contacts.filter(c => c.isActive !== false && (c.contactTypes ?? []).includes(CONTACT_TYPE.CLIENT)),
    [contacts],
  )

  const summary = useMemo(() => receiptSummary(clientReceipts), [clientReceipts])
  const receivables = useMemo(
    () => receivablesSummary(clientInvoices, clientReceipts),
    [clientInvoices, clientReceipts],
  )
  const exceptions = useMemo(
    () => allocationExceptions(clientReceipts, clientInvoices),
    [clientReceipts, clientInvoices],
  )

  const clientNames = [...new Set(clientReceipts.map(r => r.clientName).filter(Boolean))].sort()

  const filtered = clientReceipts.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    if (clientFilter !== 'all' && r.clientName !== clientFilter) return false
    if (unallocatedOnly && toCents(r.unallocatedAmount) <= 0) return false
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      const hay = [
        r.receiptNumber, r.clientName, r.bankReference, r.externalReference, r.notes,
        ...(r.allocations ?? []).map(a => a.invoiceNumber),
      ].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  // ── Gates ──────────────────────────────────────────────────────────────────
  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!canView) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Receipts are restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          Client receipts and cash position are visible to Company Admin, Project Manager, and QS roles only.
          Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }
  if (clientReceiptsLoading || clientInvoicesLoading) {
    return <div className="text-[13px] text-brand-muted">Loading receipts…</div>
  }

  return (
    <div>
      {/* ── Cash received ──────────────────────────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
          <Metric label="Receipts Recorded" value={money(summary.postedAmount)} help={`${summary.postedCount} posted`} />
          <Metric label="Allocated" value={money(summary.allocated)} help="Matched to invoices" />
          <Metric label="Unallocated — on account" value={money(summary.unallocated)} help="Reduces no invoice balance" />
          <Metric label="Draft Receipts" value={money(summary.draftAmount)} help={`${summary.draftCount} draft · not counted`} />
          <Metric label="Received to Date" value={money(receivables.received)} help="Against issued invoices" />
          <Metric
            label="Remaining to Reconcile"
            value={money(receivables.remaining)}
            help="Issued invoices, after posted receipts"
          />
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          A receipt records gross cash received. Only <span className="font-semibold">posted</span> receipts count;
          drafts and voids contribute nothing. Every invoice balance is derived at read time — nothing is written
          onto a client invoice.
        </p>
      </Card>

      {/* ── Over-reconciled callout ────────────────────────────────────────── */}
      {toCents(receivables.overReconciled) < 0 && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-red m-0">Over-reconciled invoices</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            More has been received against these invoices than was billed. The balances below are shown signed and
            are never clamped, and they are deliberately excluded from ageing so they cannot offset genuine arrears.
          </p>
          <div className="flex flex-wrap gap-3 mt-2.5">
            {receivables.rows.filter(r => toCents(r.remaining) < 0).map(r => (
              <span key={r.id} className="text-[12px] text-brand-text">
                <span className="font-semibold">{r.invoiceNumber}</span>{' '}
                <span className="text-brand-red font-semibold">{money(r.remaining)}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* ── Allocation exceptions ──────────────────────────────────────────── */}
      {exceptions.length > 0 && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">Allocation exceptions</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">{ALLOCATION_EXCEPTION_REMEDY}</p>
          <div className="flex flex-col gap-1 mt-2.5">
            {exceptions.map((x, i) => (
              <p key={i} className="m-0 text-[12px] text-brand-text">
                <span className="font-semibold">{x.receiptNumber}</span> → {x.invoiceNumber} ({money(x.allocatedAmount)}) — {x.reason}
              </p>
            ))}
          </div>
        </Card>
      )}

      {/* ── Register ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          Money received from this project&apos;s clients, allocated against issued client invoices.
        </p>
        <div className="flex items-center gap-2">
          {clientContacts.length === 0 && (
            <Btn variant="ghost" sm onClick={() => navigate('/contacts')}>Add a client contact</Btn>
          )}
          <Btn sm onClick={() => setEditing('new')} disabled={clientContacts.length === 0}>+ New Receipt</Btn>
        </div>
      </div>

      {clientReceiptsError && (
        <p className="text-[12px] text-brand-amber mb-3">Couldn&apos;t load receipts — check your connection and access.</p>
      )}

      {clientReceipts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3.5">
          <input
            className={`${inputCls} max-w-[260px]`}
            placeholder="Search CR #, client, reference, invoice…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className={`${inputCls} max-w-[170px]`} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {[PAYMENT_STATUS.DRAFT, PAYMENT_STATUS.POSTED, PAYMENT_STATUS.VOID].map(s => (
              <option key={s} value={s}>{PAYMENT_STATUS_LABELS[s]}</option>
            ))}
          </select>
          {clientNames.length > 0 && (
            <select className={`${inputCls} max-w-[220px]`} value={clientFilter} onChange={e => setClientFilter(e.target.value)}>
              <option value="all">All clients</option>
              {clientNames.map(n => (
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
        {clientReceipts.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {clientContacts.length === 0
                ? 'Add a client-type contact before recording receipts.'
                : 'No receipts yet. Record the first payment received from your client.'}
            </p>
            {clientContacts.length === 0
              ? <Btn variant="ghost" onClick={() => navigate('/contacts')}>Go to Contacts</Btn>
              : <Btn onClick={() => setEditing('new')}>+ Record your first receipt</Btn>}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">No receipts match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['CR #', 'Client', 'Receipt Date', 'Method', 'Bank Ref', 'Amount', 'Allocated', 'Unallocated', 'Invoices', 'Status', ''].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const future = r.status === PAYMENT_STATUS.DRAFT && isFutureDatedReceipt(r)
                  const invoiceNumbers = (r.allocations ?? []).map(a => a.invoiceNumber).filter(Boolean).join(', ')
                  return (
                    <tr key={r.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setDetail(r)}
                          className="text-brand-accent hover:underline cursor-pointer"
                        >
                          {r.receiptNumber}
                        </button>
                      </td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-text">{r.clientName || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] whitespace-nowrap">
                        <span className={future ? 'text-brand-amber font-semibold' : 'text-brand-muted'}>
                          {r.receiptDate || '—'}{future ? ' • future' : ''}
                        </span>
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">
                        {paymentMethodLabel(r.paymentMethod, r.paymentMethodOther)}
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{r.bankReference || '—'}</td>
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{money(r.amount)}</td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">{money(r.allocatedTotal)}</td>
                      <td className="px-3.5 py-3 text-[13px] whitespace-nowrap">
                        <span className={toCents(r.unallocatedAmount) > 0 ? 'text-brand-amber font-semibold' : 'text-brand-muted'}>
                          {money(r.unallocatedAmount)}
                        </span>
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{invoiceNumbers || '—'}</td>
                      <td className="px-3.5 py-3">
                        <Badge label={PAYMENT_STATUS_LABELS[r.status] ?? r.status} variant={PAYMENT_BADGE_VARIANTS[r.status]} sm />
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex gap-1.5 justify-end">
                          {r.status === PAYMENT_STATUS.DRAFT && (
                            <>
                              <Btn sm variant="ghost" onClick={() => setEditing(r)}>Edit</Btn>
                              <Btn sm variant="success" onClick={() => setPosting(r)}>Post</Btn>
                            </>
                          )}
                          {(r.status === PAYMENT_STATUS.DRAFT || r.status === PAYMENT_STATUS.POSTED) && (
                            <Btn sm variant="ghost" onClick={() => setVoiding(r)}>Void</Btn>
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

      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        Constrapp records cash movements and their allocations. It cannot verify that money was genuinely received,
        cannot block over-allocation, and cannot prevent two users allocating the same remaining balance
        concurrently — Firestore rules cannot sum sibling documents. Bank reconciliation and accounting integrations
        are future work.
      </p>

      {editing && (
        <ReceiptEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          receipt={editing === 'new' ? null : editing}
          clientContacts={clientContacts}
          clientInvoices={clientInvoices}
          clientReceipts={clientReceipts}
          currencyCode={currencyCode}
          onClose={() => setEditing(null)}
          onSave={editing === 'new'
            ? createClientReceipt
            : (data) => updateClientReceipt(editing, data)}
        />
      )}

      {posting && (
        <PostModal
          receipt={posting}
          currencyCode={currencyCode}
          onClose={() => setPosting(null)}
          onConfirm={postClientReceipt}
        />
      )}

      {voiding && (
        <VoidModal receipt={voiding} onClose={() => setVoiding(null)} onConfirm={voidClientReceipt} />
      )}

      {detail && (
        <DetailModal
          receipt={detail}
          clientInvoices={clientInvoices}
          currencyCode={currencyCode}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}
