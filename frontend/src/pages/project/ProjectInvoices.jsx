import { useState, useMemo } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency } from '../../lib/formatters'
import { roundMoney } from '../../lib/purchaseOrders'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierPayments } from '../../hooks/useSupplierPayments'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useContacts } from '../../hooks/useContacts'
import { CLAIM_STATUS } from '../../lib/progressClaims'
import {
  SI_STATUS, SI_STATUS_LABELS, SI_BADGE_VARIANTS, SI_SOURCE,
  INVOICEABLE_PO_STATUSES, TAX_CODE, TAX_CODES, TAX_CODE_LABELS,
  gstForLine, invoiceTotals, suggestDueDate,
  duplicateInvoiceWarnings, claimHasActiveInvoice, postedInvoicedByPoLine,
  claimReconciliationError,
} from '../../lib/supplierInvoices'
import {
  RECONCILIATION_LABELS, RECONCILIATION_BADGE_VARIANTS, paymentMethodLabel, daysPastDue,
} from '../../lib/payments'
import {
  payablesSummary, paymentsForInvoice, allocationExceptions, isPastDuePayable,
  allocationInvoiceLabel, ALLOCATION_EXCEPTION_REMEDY,
} from '../../lib/supplierPayments'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import {
  SCN_STATUS, SCN_STATUS_LABELS, SCN_BADGE_VARIANTS,
  isCreditableInvoice, targetInvoiceCostCodes, creditNoteTotals, creditNotesForInvoice,
  creditNoteExceptions, creditNoteSummary, buildCreditNoteLineItems,
  duplicateCreditWarnings, validateCreditNoteDraft, postedCreditedGrossForInvoice, overCreditError,
  CREDIT_NOTE_NOTICE, CREDIT_EXCEPTION_REMEDY, RETAINED_INVOICE_BLOCK_TEXT,
} from '../../lib/supplierCreditNotes'

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

function todayIso() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function TotalsFooter({ totals, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const hasRetention = totals.retention > 0
  return (
    <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
      <p className="m-0">Subtotal (ex-GST) <span className="font-semibold ml-2">{money(totals.subtotal)}</span></p>
      <p className="m-0 text-brand-muted">GST <span className="ml-2">{money(totals.gstTotal)}</span></p>
      <p className="m-0">Gross invoice total (inc. GST) <span className="font-semibold ml-2">{money(totals.grossTotal)}</span></p>
      {hasRetention && (
        <p className="m-0 text-brand-muted">
          Retention withheld <span className="ml-2">−{money(totals.retentionTotal)}</span>
          <span className="ml-1 text-[11px]">(ex-GST {money(totals.retention)} + GST {money(totals.retentionGst)})</span>
        </p>
      )}
      <p className="m-0 font-bold">Net payable <span className="ml-2">{money(totals.payableTotal)}</span></p>
    </div>
  )
}

function TaxSelect({ value, onChange }) {
  return (
    <select className={inputCls} value={value} onChange={onChange}>
      {TAX_CODES.map(tc => (
        <option key={tc} value={tc}>{TAX_CODE_LABELS[tc]}</option>
      ))}
    </select>
  )
}

function CreateInvoiceModal({ invoiceablePOs, invoiceableClaims, purchaseOrders, supplierInvoices, contacts, currencyCode, onClose, onSave }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const [source, setSource]   = useState(SI_SOURCE.DIRECT_PO)
  const [selectedId, setSelectedId] = useState('')      // poId (direct) or claimId (progress_claim)
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate]   = useState(todayIso())
  const [receivedDate, setReceivedDate] = useState(todayIso())
  const [dueDate, setDueDate]           = useState('')
  const [dueTouched, setDueTouched]     = useState(false)
  const [retention, setRetention]       = useState('0')
  const [notes, setNotes]               = useState('')
  const [amounts, setAmounts]           = useState([])   // Path B per-line amount strings
  const [taxCodes, setTaxCodes]         = useState([])   // per-line tax codes
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  // Resolve the selected source document and its supplier snapshot.
  const claim = source === SI_SOURCE.PROGRESS_CLAIM ? invoiceableClaims.find(c => c.id === selectedId) ?? null : null
  const po    = source === SI_SOURCE.DIRECT_PO
    ? invoiceablePOs.find(p => p.id === selectedId) ?? null
    : (claim ? purchaseOrders.find(p => p.id === claim.poId) ?? null : null)

  const supplierId   = claim ? (claim.supplierId ?? null) : (po ? (po.supplierId ?? null) : null)
  const supplierName = claim ? claim.supplierName : (po ? po.supplierName : '')
  const supplierContact = supplierId ? contacts.find(c => c.id === supplierId) ?? null : null

  // Seed per-line state when the source document changes.
  function seedFromClaim(nextClaim) {
    const lines = nextClaim?.lineItems ?? []
    setTaxCodes(lines.map(() => TAX_CODE.GST))
    setAmounts(lines.map(li => String(roundMoney(li.approvedThisPeriod || 0))))
    setRetention(String(nextClaim?.retention || 0))
    applyDueSuggestion(invoiceDate, nextClaim?.supplierId)
  }
  function seedFromPo(nextPo) {
    const lines = nextPo?.lineItems ?? []
    setTaxCodes(lines.map(() => TAX_CODE.GST))
    setAmounts(lines.map(() => ''))
    setRetention('0')
    applyDueSuggestion(invoiceDate, nextPo?.supplierId)
  }
  function applyDueSuggestion(dateStr, sid) {
    if (dueTouched) return
    const contact = sid ? contacts.find(c => c.id === sid) : null
    const suggestion = suggestDueDate(dateStr, contact?.paymentTerms)
    if (suggestion) setDueDate(suggestion)
  }

  const changeSource = (nextSource) => () => {
    setSource(nextSource)
    setSelectedId('')
    setAmounts([])
    setTaxCodes([])
    setRetention('0')
  }
  const selectClaim = (e) => {
    const next = invoiceableClaims.find(c => c.id === e.target.value) ?? null
    setSelectedId(e.target.value)
    seedFromClaim(next)
  }
  const selectPo = (e) => {
    const next = invoiceablePOs.find(p => p.id === e.target.value) ?? null
    setSelectedId(e.target.value)
    seedFromPo(next)
  }
  const changeInvoiceDate = (e) => {
    setInvoiceDate(e.target.value)
    applyDueSuggestion(e.target.value, supplierId)
  }
  const setTax = (idx) => (e) => setTaxCodes(ts => ts.map((t, i) => (i === idx ? e.target.value : t)))
  const setAmount = (idx) => (e) => setAmounts(as => as.map((a, i) => (i === idx ? e.target.value : a)))

  // Build the canonical (ex-GST) invoice lines from the selected source.
  const sourceLines = claim ? (claim.lineItems ?? []) : (po ? (po.lineItems ?? []) : [])
  const builtLines = sourceLines.map((li, idx) => {
    const tc = taxCodes[idx] || TAX_CODE.GST
    // Path A: certified amount is fixed. Path B: user-entered amount.
    const amount = claim ? roundMoney(li.approvedThisPeriod || 0) : (Number(amounts[idx]) || 0)
    return {
      poLineIndex:  claim ? li.poLineIndex : idx,
      costCodeId:   li.costCodeId,
      costCodeName: li.costCodeName,
      description:  li.description || '',
      amount:       roundMoney(amount),
      taxCode:      tc,
      gstAmount:    gstForLine(amount, tc),
    }
  })
  const savedLines = builtLines.filter(l => l.amount > 0)
  const totals = invoiceTotals(builtLines, retention)

  // Over-invoicing warning (Path B): posted-to-date + this line vs PO line total.
  const postedByPoLine = useMemo(() => postedInvoicedByPoLine(supplierInvoices), [supplierInvoices])
  const overLineIdx = new Set()
  let overPoTotal = false
  if (po) {
    const forPo = postedByPoLine[po.id] ?? {}
    let poToDate = 0
    ;(po.lineItems ?? []).forEach((li, idx) => {
      poToDate += forPo[idx] || 0
      const amt = claim ? roundMoney(sourceLines[idx]?.approvedThisPeriod || 0) : (Number(amounts[idx]) || 0)
      if (roundMoney((forPo[idx] || 0) + amt) > roundMoney(li.lineTotal || 0)) overLineIdx.add(idx)
    })
    if ((po.subtotal || 0) > 0 && roundMoney(poToDate + totals.subtotal) > roundMoney(po.subtotal || 0)) {
      overPoTotal = true
    }
  }

  const dupWarnings = duplicateInvoiceWarnings(supplierInvoices, { supplierId, supplierName, supplierInvoiceNumber })
  const gstAdvisory = supplierContact?.gstStatus === 'not_registered' && totals.gstTotal > 0
    ? `${supplierName} is recorded as not GST-registered, but this invoice includes GST. Check the supplier's tax status.`
    : null

  // A claim-sourced invoice must pay exactly the approved claim's certified GST
  // and total — this blocks creation (also re-checked in the hook).
  const reconcileError = claim
    ? claimReconciliationError(totals, { approvedGst: claim.approvedGst, approvedTotal: claim.approvedTotal })
    : null

  const hasSource   = !!(claim || po)
  const hasAmount   = savedLines.length > 0
  const refValid    = supplierInvoiceNumber.trim().length > 0
  const dateValid   = !!invoiceDate
  const valid       = hasSource && hasAmount && refValid && dateValid && !reconcileError

  async function handleSubmit(e) {
    e.preventDefault()
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      await onSave({
        source,
        supplierId,
        supplierName,
        poId:     po ? po.id : (claim ? claim.poId : null),
        poNumber: po ? po.poNumber : (claim ? claim.poNumber : null),
        progressClaimId: claim ? claim.id : null,
        claimNumber:     claim ? claim.claimNumber : null,
        claimApprovedGst:   claim ? (claim.approvedGst ?? null) : null,
        claimApprovedTotal: claim ? (claim.approvedTotal ?? null) : null,
        supplierInvoiceNumber,
        invoiceDate,
        receivedDate,
        dueDate,
        paymentTerms: supplierContact?.paymentTerms ?? null,
        lineItems: savedLines,
        retention,
        notes,
      })
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[820px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">New Supplier Invoice</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          {/* Source selector */}
          <div>
            <label className={labelCls}>Source</label>
            <div className="flex flex-wrap gap-2">
              <Btn
                sm type="button"
                variant={source === SI_SOURCE.DIRECT_PO ? 'success' : 'ghost'}
                onClick={changeSource(SI_SOURCE.DIRECT_PO)}
              >
                Direct against PO
              </Btn>
              <Btn
                sm type="button"
                variant={source === SI_SOURCE.PROGRESS_CLAIM ? 'success' : 'ghost'}
                onClick={changeSource(SI_SOURCE.PROGRESS_CLAIM)}
              >
                From approved claim
              </Btn>
            </div>
          </div>

          {/* Source document picker */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {source === SI_SOURCE.DIRECT_PO ? (
              <div>
                <label className={labelCls}>Purchase Order <span className="text-brand-red">*</span></label>
                <select className={inputCls} value={selectedId} onChange={selectPo} required autoFocus>
                  <option value="" disabled>
                    {invoiceablePOs.length === 0 ? 'No sent/closed POs…' : 'Select a PO…'}
                  </option>
                  {invoiceablePOs.map(p => (
                    <option key={p.id} value={p.id}>{p.poNumber} — {p.supplierName}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label className={labelCls}>Approved Progress Claim <span className="text-brand-red">*</span></label>
                <select className={inputCls} value={selectedId} onChange={selectClaim} required autoFocus>
                  <option value="" disabled>
                    {invoiceableClaims.length === 0 ? 'No invoiceable approved claims…' : 'Select an approved claim…'}
                  </option>
                  {invoiceableClaims.map(c => (
                    <option key={c.id} value={c.id}>{c.claimNumber} — {c.poNumber} — {c.supplierName}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className={labelCls}>Supplier Invoice # <span className="text-brand-red">*</span></label>
              <input
                className={inputCls}
                placeholder="Supplier's own invoice number"
                value={supplierInvoiceNumber}
                onChange={e => setSupplierInvoiceNumber(e.target.value)}
              />
            </div>
          </div>

          {hasSource && (
            <p className="m-0 -mt-1 text-[12px] text-brand-muted">
              Supplier <span className="text-brand-text font-semibold">{supplierName || '—'}</span>
              {' · '}PO <span className="text-brand-text font-semibold">{po ? po.poNumber : (claim?.poNumber || '—')}</span>
              {claim && <> · Claim <span className="text-brand-text font-semibold">{claim.claimNumber}</span></>}
            </p>
          )}

          {/* Dates */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Invoice Date <span className="text-brand-red">*</span></label>
              <input type="date" className={inputCls} value={invoiceDate} onChange={changeInvoiceDate} />
            </div>
            <div>
              <label className={labelCls}>Received Date</label>
              <input type="date" className={inputCls} value={receivedDate} onChange={e => setReceivedDate(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Due Date</label>
              <input
                type="date" className={inputCls} value={dueDate}
                onChange={e => { setDueTouched(true); setDueDate(e.target.value) }}
              />
            </div>
          </div>

          {/* Line items */}
          {hasSource && (
            <div>
              <label className={labelCls}>
                Line Items (ex-GST){source === SI_SOURCE.PROGRESS_CLAIM && ' — certified amounts are fixed'}
              </label>
              <div className="flex flex-col gap-2">
                {builtLines.map((line, idx) => {
                  const over = overLineIdx.has(idx)
                  return (
                    <div key={idx} className="grid grid-cols-2 sm:grid-cols-[2fr_2fr_1fr_1.2fr] gap-2 items-center">
                      <p className="m-0 text-[12px] text-brand-text truncate">{line.costCodeName || '—'}</p>
                      <p className="m-0 text-[12px] text-brand-muted truncate">{line.description || '—'}</p>
                      {claim ? (
                        <p className={`m-0 text-[12px] whitespace-nowrap ${over ? 'text-brand-amber' : 'text-brand-text'}`}>
                          {money(line.amount)}{over ? ' ⚠' : ''}
                        </p>
                      ) : (
                        <input
                          type="number" min="0" step="any"
                          className={inputCls}
                          placeholder={`of ${money(sourceLines[idx]?.lineTotal || 0)}`}
                          value={amounts[idx] ?? ''}
                          onChange={setAmount(idx)}
                        />
                      )}
                      <TaxSelect value={taxCodes[idx] || TAX_CODE.GST} onChange={setTax(idx)} />
                    </div>
                  )
                })}
              </div>
              {source === SI_SOURCE.DIRECT_PO && (
                <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
                  Enter the invoiced amount per PO line; leave unused lines at zero. ⚠ marks invoiced-to-date above the PO line value.
                </p>
              )}
            </div>
          )}

          {/* Retention + notes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Retention (ex-GST)</label>
              <input
                type="number" min="0" step="any"
                className={inputCls}
                value={retention}
                onChange={e => setRetention(e.target.value)}
                readOnly={!!claim}
              />
              {claim && <p className="m-0 mt-1 text-[11px] text-brand-muted">Carried from the approved claim.</p>}
            </div>
            <div>
              <label className={labelCls}>Notes</label>
              <input className={inputCls} placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
          </div>

          {overPoTotal && (
            <p className="m-0 text-[12px] text-brand-amber">⚠ Invoiced-to-date would exceed this PO's total. Allowed, but check for a variation.</p>
          )}
          {dupWarnings.map((w, i) => (
            <p key={i} className="m-0 text-[12px] text-brand-amber">⚠ {w.message}</p>
          ))}
          {gstAdvisory && <p className="m-0 text-[12px] text-brand-amber">⚠ {gstAdvisory}</p>}
          {reconcileError && <p className="m-0 text-[12px] text-brand-red">{reconcileError}</p>}

          {hasSource && <TotalsFooter totals={totals} currencyCode={currencyCode} />}

          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving || !valid}>{saving ? 'Saving…' : 'Create Draft Invoice'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Read-only supplier invoice detail ────────────────────────────────────────

function DetailRow({ label, value }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className="m-0 text-[13px] text-brand-text break-words">{value || '—'}</p>
    </div>
  )
}

// Opened from the SI number. Everything below the header is DERIVED at read time
// from posted Supplier Payments and posted Supplier Credit Notes — no supplier
// invoice document is ever written with a balance, a payment status, a credited
// total, or any back-reference (ADR-24/ADR-31).
function InvoiceDetailModal({ invoice, reconciliation, allocatedPayments, creditNotes, creditStateUnknown = false, currencyCode, onClose }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const hasRetention = (invoice.retentionTotal || 0) > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[900px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">
            {invoice.invoiceNumber} — {SI_STATUS_LABELS[invoice.status] ?? invoice.status}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            <DetailRow label="Supplier" value={invoice.supplierName} />
            <DetailRow label="Supplier Invoice #" value={invoice.supplierInvoiceNumber} />
            <DetailRow label="Source" value={invoice.source === SI_SOURCE.PROGRESS_CLAIM ? 'From approved claim' : 'Direct against PO'} />
            <DetailRow label="Purchase Order" value={invoice.poNumber} />
            <DetailRow label="Progress Claim" value={invoice.claimNumber} />
            <DetailRow label="Invoice Date" value={invoice.invoiceDate} />
            <DetailRow label="Received Date" value={invoice.receivedDate} />
            <DetailRow label="Due Date" value={invoice.dueDate} />
            <DetailRow label="Currency (audit snapshot)" value={invoice.currency} />
          </div>

          {/* Line items — ex-GST canonical, per-line tax code. */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-y border-brand-border">
                  {['Cost Code', 'Description', 'Amount (ex-GST)', 'Tax', 'GST'].map(h => (
                    <th key={h} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(invoice.lineItems ?? []).map((li, i) => (
                  <tr key={i} className="border-b border-brand-border last:border-b-0">
                    <td className="px-3.5 py-2.5 text-[12px] text-brand-text">{li.costCodeName || '—'}</td>
                    <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{li.description || '—'}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(li.amount || 0)}</td>
                    <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{TAX_CODE_LABELS[li.taxCode] ?? li.taxCode}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{money(li.gstAmount || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <TotalsFooter totals={invoice} currencyCode={currencyCode} />

          {/* ── Payment reconciliation (read-time) ─────────────────────────── */}
          {reconciliation && (
            <div className="border-t border-brand-border pt-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2.5">
                <p className="text-[13px] font-bold text-brand-text m-0">Payment reconciliation</p>
                {creditStateUnknown
                  ? <span className="text-[12px] text-brand-muted">Unavailable</span>
                  : <Badge
                      label={RECONCILIATION_LABELS[reconciliation.state]}
                      variant={RECONCILIATION_BADGE_VARIANTS[reconciliation.state]}
                      sm
                    />}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
                <DetailRow label="Net Payable" value={money(reconciliation.payableTotal)} />
                <DetailRow label="Paid to Date" value={money(reconciliation.paid)} />
                <DetailRow
                  label="Credited"
                  value={creditStateUnknown ? '—' : (reconciliation.credited ? `−${money(reconciliation.credited)}` : '—')}
                />
                <div>
                  <p className={labelCls}>Remaining Payable</p>
                  <p className={`m-0 text-[13px] font-semibold ${!creditStateUnknown && reconciliation.remaining < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
                    {creditStateUnknown ? '—' : money(reconciliation.remaining)}
                  </p>
                </div>
              </div>
              {creditStateUnknown && (
                <p className="m-0 mt-2 text-[12px] text-brand-amber">
                  ⚠ Supplier Credit Notes could not be read, so Credited and Remaining Payable are unavailable
                  rather than shown as though no credits exist.
                </p>
              )}
              {!creditStateUnknown && reconciliation.remaining < 0 && (
                <p className="m-0 mt-2 text-[12px] text-brand-amber">
                  ⚠ Payments plus credit notes exceed this invoice&apos;s payable — the excess is money recoverable
                  from the supplier. Nothing is refunded automatically (refund workflow not yet modelled).
                </p>
              )}
              {hasRetention && (
                <p className="m-0 mt-2 text-[11px] text-brand-muted">
                  Retention of {money(invoice.retentionTotal)} is withheld and is <span className="font-semibold">not
                  payable</span> on this invoice, so it is excluded from every figure above. Retention release is not
                  yet modelled in Constrapp.
                </p>
              )}

              {allocatedPayments.length > 0 ? (
                <div className="overflow-x-auto mt-3">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-brand-card border-y border-brand-border">
                        {['Payment', 'Payment Date', 'Method', 'Bank Ref', 'Remittance Ref', 'Allocated'].map(h => (
                          <th key={h} className={thCls}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {allocatedPayments.map((p, i) => (
                        <tr key={i} className="border-b border-brand-border last:border-b-0">
                          <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">{p.paymentNumber}</td>
                          <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{p.paymentDate || '—'}</td>
                          <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{paymentMethodLabel(p.paymentMethod, p.paymentMethodOther)}</td>
                          <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{p.bankReference || '—'}</td>
                          <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{p.remittanceReference || '—'}</td>
                          <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(p.allocatedAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="m-0 mt-2 text-[12px] text-brand-muted">
                  No posted supplier payments have been allocated to this invoice yet.
                </p>
              )}

              {/* ── Credit notes against this invoice ─────────────────────── */}
              {(creditNotes ?? []).length > 0 && (
                <div className="overflow-x-auto mt-3">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-brand-card border-y border-brand-border">
                        {['Credit Note', 'Credit Ref', 'Date', 'Reason', 'Gross', 'Status'].map(h => (
                          <th key={h} className={thCls}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {creditNotes.map((cn) => (
                        <tr key={cn.id} className="border-b border-brand-border last:border-b-0">
                          <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">{cn.creditNumber}</td>
                          <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{cn.supplierCreditReference || '—'}</td>
                          <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{cn.creditDate || '—'}</td>
                          <td className="px-3.5 py-2.5 text-[12px] text-brand-muted max-w-[220px] truncate" title={cn.reason || ''}>{cn.reason || '—'}</td>
                          <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">−{money(cn.grossTotal || 0)}</td>
                          <td className="px-3.5 py-2.5">
                            <Badge label={SCN_STATUS_LABELS[cn.status] ?? cn.status} variant={SCN_BADGE_VARIANTS[cn.status]} sm />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {hasRetention && (
                <p className="m-0 mt-2 text-[11px] text-brand-muted">
                  {RETAINED_INVOICE_BLOCK_TEXT}
                </p>
              )}
            </div>
          )}

          {invoice.notes && <DetailRow label="Notes" value={invoice.notes} />}

          <p className="m-0 text-[11px] text-brand-muted border-t border-brand-border pt-3">
            Amounts are ex-GST plus per-line Australian GST, shown in this project&apos;s currency ({currencyCode}).
            Paid to Date, Credited, and Remaining Payable are derived at read time from posted Supplier Payments and
            posted Supplier Credit Notes and are never written onto this invoice — it carries no balance field, no
            payment status, no credited total, and no back-reference.
          </p>
        </div>
      </div>
    </div>
  )
}

function RowActions({ invoice, onTransition, onRecordPayment, onRecordCredit, creditActionsDisabled = false }) {
  const confirmThen = (label, nextStatus) => () => {
    if (window.confirm(`${label} ${invoice.invoiceNumber}?`)) onTransition(invoice, nextStatus)
  }
  if (invoice.status === SI_STATUS.DRAFT) {
    return (
      <div className="flex gap-1.5 justify-end">
        <Btn sm variant="success" onClick={confirmThen('Approve', SI_STATUS.APPROVED)}>Approve</Btn>
        <Btn sm variant="ghost" onClick={confirmThen('Cancel', SI_STATUS.CANCELLED)}>Cancel</Btn>
      </div>
    )
  }
  if (invoice.status === SI_STATUS.APPROVED) {
    return (
      <div className="flex gap-1.5 justify-end">
        <Btn sm variant="success" onClick={confirmThen('Post', SI_STATUS.POSTED)}>Post</Btn>
        <Btn sm variant="ghost" onClick={confirmThen('Cancel', SI_STATUS.CANCELLED)}>Cancel</Btn>
      </div>
    )
  }
  // Posted is the financial commit point — the only status a payment may settle
  // and the only status a credit note may reduce. Retained invoices cannot be
  // credited in this foundation (rules-enforced), so no credit action appears.
  if (invoice.status === SI_STATUS.POSTED) {
    return (
      <div className="flex gap-1.5 justify-end">
        {/* Raising a credit needs the EXISTING credits to apply the cumulative
            over-credit cap, so the action is disabled while that list is
            unknown. */}
        {isCreditableInvoice(invoice) && (
          <Btn sm variant="ghost" disabled={creditActionsDisabled} onClick={() => onRecordCredit(invoice)}>Record credit note</Btn>
        )}
        <Btn sm variant="ghost" onClick={() => onRecordPayment(invoice)}>Record payment</Btn>
      </div>
    )
  }
  return null
}

// ── Supplier Credit Note editor (create / draft edit) ────────────────────────
//
// The target invoice is chosen BEFORE this modal opens (from the invoice row or
// detail) and is FROZEN — retargeting a saved draft is a void plus a new credit
// note, matching the rules. Lines are restricted to the target invoice's cost
// codes, and the cumulative cap against payableTotal is HARD-BLOCKED here
// (the rules enforce the single-document cap; the cumulative cap across
// sibling credit notes cannot be rules-enforced — Deferred Control 25).
const blankCreditRow = () => ({ costCodeId: '', description: '', amount: '', taxCode: TAX_CODE.GST })

function CreditNoteModal({ invoice, creditNote, creditNotes, currencyCode, onClose, onSave }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const isEdit = !!creditNote

  const [supplierCreditReference, setSupplierCreditReference] = useState(creditNote?.supplierCreditReference || '')
  const [creditDate, setCreditDate] = useState(creditNote?.creditDate || todayIso())
  const [reason, setReason]         = useState(creditNote?.reason || '')
  const [notes, setNotes]           = useState(creditNote?.notes || '')
  const [rows, setRows] = useState(() => (
    creditNote?.lineItems?.length
      ? creditNote.lineItems.map(li => ({
          costCodeId: li.costCodeId || '',
          description: li.description || '',
          amount: String(li.amount ?? ''),
          taxCode: li.taxCode || TAX_CODE.GST,
        }))
      : [blankCreditRow()]
  ))
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const costCodes = targetInvoiceCostCodes(invoice)

  const setRow = (idx, patch) => setRows(rs => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const addRow = () => setRows(rs => [...rs, blankCreditRow()])
  const removeRow = (idx) => setRows(rs => (rs.length === 1 ? [blankCreditRow()] : rs.filter((_, i) => i !== idx)))

  // Canonical lines: ex-GST amount + per-line GST, exactly like the invoice
  // lines they reverse. Empty rows are dropped.
  const builtLines = buildCreditNoteLineItems(
    rows.map(r => ({
      costCodeId:  r.costCodeId,
      description: r.description,
      amount:      Number(r.amount) || 0,
      taxCode:     r.taxCode,
      gstAmount:   gstForLine(Number(r.amount) || 0, r.taxCode),
    })),
    costCodes,
  )
  const totals = creditNoteTotals(builtLines)

  const alreadyCredited = postedCreditedGrossForInvoice(creditNotes, invoice.id, { excludeCreditNoteId: creditNote?.id ?? null })
  const remainingCreditable = roundMoney((invoice.payableTotal || 0) - alreadyCredited)

  const dupWarnings = duplicateCreditWarnings(creditNotes, {
    id: creditNote?.id ?? null,
    supplierId: invoice.supplierId ?? null,
    supplierName: invoice.supplierName || '',
    supplierCreditReference,
  })

  // One validation path — the same checks the hook re-runs on save. The
  // over-credit branch is a HARD BLOCK, not a warn-and-acknowledge.
  const validationError = validateCreditNoteDraft(
    { supplierInvoiceId: invoice.id, creditDate, reason, lineItems: builtLines },
    { invoice, creditNotes, excludeCreditNoteId: creditNote?.id ?? null },
  )
  const valid = !validationError

  // Over-credit is detected through the DOMAIN function, so the threshold has
  // exactly one definition — this only decides how it is worded on screen.
  // It is surfaced separately from the generic validation line because it must
  // appear as soon as the AMOUNTS are wrong, without waiting for the reason
  // field: otherwise the Create button silently disables with no explanation.
  const overCredit = overCreditError({
    invoice,
    proposedGross: totals.grossTotal,
    creditNotes,
    excludeCreditNoteId: creditNote?.id ?? null,
  })
  // The generic line still covers every other error, but never repeats the
  // over-credit case in different words.
  const showValidation = validationError && !overCredit && builtLines.length > 0 && reason.trim()

  async function handleSubmit(e) {
    e.preventDefault()
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      await onSave({ supplierCreditReference, creditDate, reason, lineItems: builtLines, notes })
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[820px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">
            {isEdit ? `Edit ${creditNote.creditNumber}` : 'New Supplier Credit Note'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          {/* Frozen target — chosen before the modal opened, never changeable. */}
          <div className="bg-brand-card border border-brand-border rounded-lg px-3.5 py-2.5">
            <p className="m-0 text-[12px] text-brand-muted">
              Credits <span className="text-brand-text font-semibold">{invoice.invoiceNumber}</span>
              {invoice.supplierInvoiceNumber ? <> · <span className="text-brand-text">{invoice.supplierInvoiceNumber}</span></> : null}
              {' '}— {invoice.supplierName || '—'} · Net payable <span className="text-brand-text font-semibold">{money(invoice.payableTotal || 0)}</span>
              {alreadyCredited > 0 && <> · Already credited <span className="text-brand-text font-semibold">{money(alreadyCredited)}</span></>}
            </p>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              The target invoice is fixed for this credit note — to credit a different invoice, void this one and
              record a new credit note. Maximum creditable: {money(Math.max(remainingCreditable, 0))} (gross).
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Supplier Credit Ref</label>
              <input
                className={inputCls}
                placeholder="Supplier's credit note number"
                value={supplierCreditReference}
                onChange={e => setSupplierCreditReference(e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls}>Credit Date <span className="text-brand-red">*</span></label>
              <input type="date" className={inputCls} value={creditDate} onChange={e => setCreditDate(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Notes</label>
              <input className={inputCls} placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
          </div>

          <div>
            <label className={labelCls}>Reason <span className="text-brand-red">*</span></label>
            <input
              className={inputCls}
              placeholder="Why did the supplier issue this credit? (e.g. over-claimed quantities, rejected work, back-charge)"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>

          {/* Lines — cost codes restricted to the target invoice's lines. */}
          <div>
            <label className={labelCls}>Credit Lines (ex-GST) — cost codes from {invoice.invoiceNumber}</label>
            <div className="flex flex-col gap-2">
              {rows.map((row, idx) => (
                <div key={idx} className="grid grid-cols-2 sm:grid-cols-[1.6fr_2fr_1fr_1.2fr_auto] gap-2 items-center">
                  <select
                    className={inputCls}
                    value={row.costCodeId}
                    onChange={e => setRow(idx, { costCodeId: e.target.value })}
                  >
                    <option value="" disabled>Cost code…</option>
                    {costCodes.map(cc => (
                      <option key={cc.costCodeId} value={cc.costCodeId}>{cc.costCodeName || cc.costCodeId}</option>
                    ))}
                  </select>
                  <input
                    className={inputCls}
                    placeholder="Description"
                    value={row.description}
                    onChange={e => setRow(idx, { description: e.target.value })}
                  />
                  <input
                    type="number" min="0" step="any"
                    className={inputCls}
                    placeholder="0.00"
                    value={row.amount}
                    onChange={e => setRow(idx, { amount: e.target.value })}
                  />
                  <TaxSelect value={row.taxCode} onChange={e => setRow(idx, { taxCode: e.target.value })} />
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    aria-label="Remove line"
                    className="text-brand-muted hover:text-brand-red text-lg leading-none cursor-pointer min-w-[36px] min-h-[36px]"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2">
              <Btn sm type="button" variant="ghost" onClick={addRow}>+ Add line</Btn>
            </div>
            <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
              A credit may only reduce cost codes the invoice charged. Amounts are positive — the credit note
              itself is the reduction.
            </p>
          </div>

          {dupWarnings.map((w, i) => (
            <p key={i} className="m-0 text-[12px] text-brand-amber">⚠ {w.message}</p>
          ))}
          {showValidation && <p className="m-0 text-[12px] text-brand-red">{validationError}</p>}

          <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
            <p className="m-0">Subtotal (ex-GST) <span className="font-semibold ml-2">{money(totals.subtotal)}</span></p>
            <p className="m-0 text-brand-muted">GST <span className="ml-2">{money(totals.gstTotal)}</span></p>
            <p className={`m-0 font-bold ${overCredit ? 'text-brand-red' : ''}`}>
              Gross credit total (inc. GST) <span className="ml-2">{money(totals.grossTotal)}</span>
            </p>
          </div>

          {/* Sits between the gross total and the save button so the reason the
              button is disabled is next to both the figure that caused it and
              the control it blocks. */}
          {overCredit && (
            <p className="m-0 text-[12px] text-brand-red font-semibold">
              Credit exceeds the remaining creditable amount of {money(Math.max(remainingCreditable, 0))}.
              {alreadyCredited > 0 && (
                <span className="font-normal">
                  {' '}({invoice.invoiceNumber} has a payable total of {money(invoice.payableTotal || 0)}, of which{' '}
                  {money(alreadyCredited)} is already credited.)
                </span>
              )}
            </p>
          )}

          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving || !valid}>
              {saving ? 'Saving…' : isEdit ? 'Save Draft' : 'Create Draft Credit Note'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

// Void requires a written reason (rules-enforced non-whitespace). Voiding a
// posted credit note restores Invoiced/Actual and the invoice's remaining
// payable at the next render — no reversal document is written.
function VoidCreditNoteModal({ creditNote, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!reason.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(creditNote, reason)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to void. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[480px] bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">Void {creditNote.creditNumber}</h2>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3">
          <p className="m-0 text-[12px] text-brand-muted">
            Voiding is terminal and cannot be undone. The credit note keeps its number and its record; every figure
            it reduced is restored at the next render. No reversal document is created.
          </p>
          <div>
            <label className={labelCls}>Reason <span className="text-brand-red">*</span></label>
            <textarea
              className={inputCls}
              rows={2}
              placeholder="Why is this credit note being voided?"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>
          {error && <p className="m-0 text-[12px] text-brand-red">{error}</p>}
          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm variant="danger" disabled={saving || !reason.trim()}>
              {saving ? 'Voiding…' : 'Void credit note'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function ProjectInvoices() {
  const navigate = useNavigate()
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { supplierInvoices, supplierInvoicesLoading, createSupplierInvoice, transitionStatus } = useSupplierInvoices(projectId)
  const { supplierPayments } = useSupplierPayments(projectId)
  const {
    supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError,
    createSupplierCreditNote, updateSupplierCreditNote, postSupplierCreditNote, voidSupplierCreditNote,
  } = useSupplierCreditNotes(projectId)

  // ⚠️ A FAILED OR PENDING CREDIT-NOTE READ IS UNKNOWN, NEVER ZERO. Posted
  // credit notes reduce each invoice's remaining payable, so treating an
  // unreadable list as empty would OVERSTATE what is still owed. Every
  // credit-dependent figure below renders unavailable, and every credit-note
  // action is disabled — raising a credit needs the existing credits in order
  // to apply the cumulative over-credit cap, and posting one needs them too.
  const creditStateUnknown = supplierCreditNotesError || supplierCreditNotesLoading
  // Credit-dependent money renders "—" rather than an overstated figure.
  const apMoney = (n) => (creditStateUnknown ? '—' : money(n))
  const { purchaseOrders, purchaseOrdersLoading } = usePurchaseOrders(projectId)
  const { progressClaims } = useProgressClaims(projectId)
  const { contacts } = useContacts()
  const [showCreate, setShowCreate]   = useState(false)
  const [detail, setDetail]           = useState(null)
  const [actionError, setActionError] = useState(null)
  const [search, setSearch]           = useState('')
  const [statusFilter, setStatusFilter]   = useState('all')
  const [supplierFilter, setSupplierFilter] = useState('all')
  // { invoice, creditNote | null } — credit-note editor; target frozen on open.
  const [creditEditor, setCreditEditor]   = useState(null)
  const [creditVoiding, setCreditVoiding] = useState(null)

  // ── Payment + credit reconciliation, all derived at read time ──────────────
  // Nothing here is written onto a supplier invoice document.
  const payables = useMemo(
    () => payablesSummary(supplierInvoices, supplierPayments, supplierCreditNotes),
    [supplierInvoices, supplierPayments, supplierCreditNotes],
  )
  const reconciliationById = useMemo(
    () => new Map(payables.rows.map(r => [r.id, r])),
    [payables.rows],
  )
  const exceptions = useMemo(
    () => allocationExceptions(supplierPayments, supplierInvoices),
    [supplierPayments, supplierInvoices],
  )
  const creditExceptions = useMemo(
    () => creditNoteExceptions(supplierCreditNotes, supplierInvoices),
    [supplierCreditNotes, supplierInvoices],
  )
  const creditSummary = useMemo(
    () => creditNoteSummary(supplierCreditNotes, supplierInvoices),
    [supplierCreditNotes, supplierInvoices],
  )

  const goToPayments = () => navigate(`/projects/${projectId}/commercial/supplier-payments`)

  // "Record payment" hands off through ONE-SHOT route state, which the Supplier
  // Payments page consumes once and then clears from history — so navigating
  // back never reopens the editor.
  const handleRecordPayment = (invoice) => {
    navigate(`/projects/${projectId}/commercial/supplier-payments`, {
      state: { recordPayment: { supplierId: invoice.supplierId, supplierInvoiceId: invoice.id } },
    })
  }

  const invoiceablePOs = purchaseOrders.filter(po => INVOICEABLE_PO_STATUSES.includes(po.status))
  const invoiceableClaims = progressClaims.filter(c =>
    c.status === CLAIM_STATUS.APPROVED && !claimHasActiveInvoice(supplierInvoices, c.id)
  )
  const canCreate = invoiceablePOs.length > 0

  const noPOs = !purchaseOrdersLoading && invoiceablePOs.length === 0
  const goToPOs = () => navigate(`/projects/${projectId}/purchase-orders`)

  // Supplier options for the filter — distinct supplier names on the register.
  const supplierNames = [...new Set(supplierInvoices.map(i => i.supplierName).filter(Boolean))].sort()

  const filtered = supplierInvoices.filter(inv => {
    if (statusFilter !== 'all' && inv.status !== statusFilter) return false
    if (supplierFilter !== 'all' && inv.supplierName !== supplierFilter) return false
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      const hay = [inv.invoiceNumber, inv.supplierInvoiceNumber, inv.supplierName, inv.poNumber, inv.claimNumber]
        .filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  async function handleTransition(invoice, nextStatus) {
    setActionError(null)
    try {
      await transitionStatus(invoice, nextStatus)
    } catch {
      setActionError('Failed to update status. Check your connection and try again.')
    }
  }

  // Posting re-runs the target and cumulative-cap checks against current data
  // in the hook — a cancelled target or a sibling credit posted since the
  // draft was saved blocks the post with a specific message.
  async function handlePostCreditNote(creditNote) {
    if (!window.confirm(`Post ${creditNote.creditNumber} against ${creditNote.invoiceNumber}?`)) return
    setActionError(null)
    try {
      await postSupplierCreditNote(creditNote, { invoices: supplierInvoices })
    } catch (err) {
      setActionError(err?.message || 'Failed to post the credit note. Check your connection and try again.')
    }
  }

  const invoiceById = useMemo(
    () => new Map(supplierInvoices.map(inv => [inv.id, inv])),
    [supplierInvoices],
  )

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          {noPOs
            ? 'Send a purchase order before recording supplier invoices.'
            : 'Supplier invoices (accounts payable) against this project’s POs and approved claims.'}
        </p>
        <div className="flex items-center gap-2">
          {noPOs && <Btn variant="ghost" sm onClick={goToPOs}>Go to Purchase Orders</Btn>}
          <Btn variant="ghost" sm onClick={goToPayments}>Supplier Payments</Btn>
          <Btn sm onClick={() => setShowCreate(true)} disabled={purchaseOrdersLoading || !canCreate}>
            + New Supplier Invoice
          </Btn>
        </div>
      </div>

      {actionError && <p className="text-[12px] text-brand-red mb-3">{actionError}</p>}

      {supplierCreditNotesError && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">
            Supplier Credit Notes could not be loaded — payable figures are unavailable
          </p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            Posted credit notes reduce each invoice&apos;s remaining payable and its contribution to Invoiced and
            Actual. Because they cannot be read, Constrapp will <span className="font-semibold">not</span> show
            those balances as though no credits exist. Credit-note actions are disabled — raising one requires the
            existing credits to apply the cumulative cap. Recording a payment is still reachable from the Supplier
            Payments view, which applies the same guard. Reload the page; if this persists, check your connection
            and permissions.
          </p>
        </Card>
      )}

      {/* ── Compact accounts-payable summary ───────────────────────────────── */}
      {payables.count > 0 && (
        <Card className="mb-3.5">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3.5 flex-1">
              <div>
                <p className={labelCls}>Total Posted Supplier Invoices</p>
                <p className="text-lg font-bold text-brand-text">{money(payables.postedPayable)}</p>
                <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{payables.count} posted · net payable after retention</p>
              </div>
              <div>
                <p className={labelCls}>Paid to Date</p>
                <p className="text-lg font-bold text-brand-text">{money(payables.paid)}</p>
                <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">Posted Supplier Payments allocated here</p>
              </div>
              <div>
                <p className={labelCls}>Credited</p>
                <p className="text-lg font-bold text-brand-text">{apMoney(payables.credited)}</p>
                <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">
                  {creditStateUnknown ? 'Unavailable — credit notes could not be read' : 'Posted Supplier Credit Notes'}
                </p>
              </div>
              <div>
                <p className={labelCls}>Remaining Payable</p>
                <p className="text-lg font-bold text-brand-text">{apMoney(payables.remaining)}</p>
                <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">
                  {creditStateUnknown ? 'Unavailable' : 'After payments and credit notes'}
                </p>
              </div>
            </div>
            <Btn variant="ghost" sm onClick={goToPayments}>Open Supplier Payments</Btn>
          </div>
          {!creditStateUnknown && payables.overReconciled < 0 && (
            <p className="m-0 mt-3 text-[12px] text-brand-amber">
              ⚠ Over-settled by {money(Math.abs(payables.overReconciled))} — payments plus credit notes exceed the
              payable on at least one invoice. That excess is money recoverable from the supplier; nothing is
              refunded automatically (a supplier refund workflow is not yet modelled).
            </p>
          )}
          <p className="m-0 mt-3 text-[11px] text-brand-muted">
            Derived at read time from posted Supplier Payments and posted Supplier Credit Notes — nothing is written
            onto an invoice, and no invoice is ever marked <span className="font-semibold">paid</span>. Full AP
            ageing is on the Supplier Payments view.
          </p>
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
                <span className="font-semibold">{x.paymentNumber}</span> → {allocationInvoiceLabel(x)}
                {' '}({money(x.allocatedAmount)}) — {x.reason}
              </p>
            ))}
          </div>
        </Card>
      )}

      {/* ── Credit-note exceptions (broken targets contribute ZERO) ─────────── */}
      {creditExceptions.length > 0 && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">Credit-note exceptions</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">{CREDIT_EXCEPTION_REMEDY}</p>
          <div className="flex flex-col gap-1 mt-2.5">
            {creditExceptions.map((x, i) => (
              <p key={i} className="m-0 text-[12px] text-brand-text">
                <span className="font-semibold">{x.creditNumber}</span> → {x.invoiceNumber}
                {' '}({money(x.grossTotal)}) — {x.reason}
              </p>
            ))}
          </div>
        </Card>
      )}

      {/* Filters */}
      {supplierInvoices.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3.5">
          <input
            className={`${inputCls} max-w-[240px]`}
            placeholder="Search invoice #, supplier, PO…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className={`${inputCls} max-w-[180px]`} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {Object.values(SI_STATUS).map(s => (
              <option key={s} value={s}>{SI_STATUS_LABELS[s]}</option>
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
        </div>
      )}

      <Card padding={false}>
        {supplierInvoicesLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading supplier invoices…</div>
        ) : supplierInvoices.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {noPOs
                ? 'Send a purchase order before recording supplier invoices.'
                : 'No supplier invoices yet. Record your first supplier bill.'}
            </p>
            {noPOs ? (
              <Btn variant="ghost" onClick={goToPOs}>Go to Purchase Orders</Btn>
            ) : (
              <Btn onClick={() => setShowCreate(true)} disabled={!canCreate}>+ Create your first supplier invoice</Btn>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">No invoices match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['SI #', 'Supplier Inv #', 'Supplier', 'PO', 'Claim', 'Invoice Date', 'Due', 'Subtotal', 'GST', 'Gross', 'Retention', 'Net Payable', 'Paid to Date', 'Credited', 'Remaining Payable', 'Reconciliation', 'Status', ''].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(inv => {
                  // Payment-aware past due: POSTED, past its due date, AND still
                  // payable. The old date-only isOverdue() would mark a fully
                  // paid invoice overdue (see lib/supplierInvoices.js).
                  const recon = reconciliationById.get(inv.id) ?? null
                  const pastDue = isPastDuePayable(inv, recon?.remaining ?? 0)
                  const days = pastDue ? daysPastDue(inv.dueDate) : null
                  return (
                    <tr key={inv.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setDetail(inv)}
                          className="text-brand-accent hover:underline cursor-pointer"
                        >
                          {inv.invoiceNumber}
                        </button>
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{inv.supplierInvoiceNumber || '—'}</td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-text">{inv.supplierName || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{inv.poNumber || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{inv.claimNumber || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{inv.invoiceDate || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] whitespace-nowrap">
                        {inv.dueDate
                          ? <span className={pastDue ? 'text-brand-red font-semibold' : 'text-brand-muted'}>
                              {inv.dueDate}{pastDue ? ` • Past due ${days}d` : ''}
                            </span>
                          : <span className="text-brand-muted">—</span>}
                      </td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-text whitespace-nowrap">{money(inv.subtotal || 0)}</td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">{money(inv.gstTotal || 0)}</td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">{money(inv.grossTotal || 0)}</td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">{inv.retentionTotal ? `−${money(inv.retentionTotal)}` : '—'}</td>
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{money(inv.payableTotal || 0)}</td>
                      {/* Paid to Date / Credited / Remaining Payable /
                          Reconciliation are DERIVED from posted supplier
                          payments and posted credit notes on every render —
                          never stored here. Only posted invoices are payable. */}
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">
                        {recon ? money(recon.paid) : '—'}
                      </td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">
                        {creditStateUnknown ? '—' : (recon && recon.credited ? `−${money(recon.credited)}` : '—')}
                      </td>
                      <td className="px-3.5 py-3 text-[13px] font-semibold whitespace-nowrap">
                        {recon && !creditStateUnknown
                          ? <span className={recon.remaining < 0 ? 'text-brand-red' : 'text-brand-text'}>{money(recon.remaining)}</span>
                          : <span className="text-brand-muted">—</span>}
                      </td>
                      <td className="px-3.5 py-3">
                        {recon && !creditStateUnknown
                          ? <Badge
                              label={RECONCILIATION_LABELS[recon.state]}
                              variant={RECONCILIATION_BADGE_VARIANTS[recon.state]}
                              sm
                            />
                          : <span className="text-[12px] text-brand-muted">—</span>}
                      </td>
                      <td className="px-3.5 py-3">
                        <Badge label={SI_STATUS_LABELS[inv.status] ?? inv.status} variant={SI_BADGE_VARIANTS[inv.status]} sm />
                      </td>
                      <td className="px-3.5 py-3">
                        <RowActions
                          invoice={inv}
                          onTransition={handleTransition}
                          onRecordPayment={handleRecordPayment}
                          creditActionsDisabled={creditStateUnknown}
                          onRecordCredit={(invoice) => setCreditEditor({ invoice, creditNote: null })}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Supplier Credit Notes register ─────────────────────────────────── */}
      {supplierCreditNotes.length > 0 && (
        <Card className="mt-3.5" padding={false}>
          <div className="px-5 pt-4 pb-2 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[13px] font-bold text-brand-text m-0">Supplier Credit Notes</p>
            <p className="m-0 text-[11px] text-brand-muted">
              Posted (counting): {money(creditSummary.postedGross)}
              {creditSummary.exceptionCount > 0 && <> · exceptions: {money(creditSummary.exceptionGross)}</>}
              {creditSummary.draftCount > 0 && <> · drafts: {money(creditSummary.draftGross)}</>}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-y border-brand-border">
                  {['SCN #', 'Credits', 'Supplier', 'Credit Ref', 'Date', 'Subtotal', 'GST', 'Gross', 'Reason', 'Status', ''].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {supplierCreditNotes.map(cn => {
                  const target = invoiceById.get(cn.supplierInvoiceId) ?? null
                  return (
                    <tr key={cn.id} className="border-b border-brand-border last:border-b-0 hover:bg-brand-card transition-colors">
                      <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">{cn.creditNumber}</td>
                      <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">
                        {cn.invoiceNumber || '—'}{cn.supplierInvoiceNumber ? ` · ${cn.supplierInvoiceNumber}` : ''}
                      </td>
                      <td className="px-3.5 py-2.5 text-[13px] text-brand-text">{cn.supplierName || '—'}</td>
                      <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{cn.supplierCreditReference || '—'}</td>
                      <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{cn.creditDate || '—'}</td>
                      <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(cn.subtotal || 0)}</td>
                      <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{money(cn.gstTotal || 0)}</td>
                      <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">−{money(cn.grossTotal || 0)}</td>
                      <td className="px-3.5 py-2.5 text-[12px] text-brand-muted max-w-[220px] truncate" title={cn.reason || ''}>
                        {cn.status === SCN_STATUS.VOID && cn.voidReason ? `Voided: ${cn.voidReason}` : (cn.reason || '—')}
                      </td>
                      <td className="px-3.5 py-2.5">
                        <Badge label={SCN_STATUS_LABELS[cn.status] ?? cn.status} variant={SCN_BADGE_VARIANTS[cn.status]} sm />
                      </td>
                      <td className="px-3.5 py-2.5">
                        <div className="flex gap-1.5 justify-end">
                          {cn.status === SCN_STATUS.DRAFT && target && (
                            <Btn sm variant="ghost" onClick={() => setCreditEditor({ invoice: target, creditNote: cn })}>Edit</Btn>
                          )}
                          {cn.status === SCN_STATUS.DRAFT && (
                            <Btn sm variant="success" onClick={() => handlePostCreditNote(cn)}>Post</Btn>
                          )}
                          {(cn.status === SCN_STATUS.DRAFT || cn.status === SCN_STATUS.POSTED) && (
                            <Btn sm variant="ghost" onClick={() => setCreditVoiding(cn)}>Void</Btn>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="m-0 px-5 py-3 text-[11px] text-brand-muted border-t border-brand-border">
            {CREDIT_NOTE_NOTICE} {RETAINED_INVOICE_BLOCK_TEXT}
          </p>
        </Card>
      )}

      {showCreate && (
        <CreateInvoiceModal
          currencyCode={currencyCode}
          invoiceablePOs={invoiceablePOs}
          invoiceableClaims={invoiceableClaims}
          purchaseOrders={purchaseOrders}
          supplierInvoices={supplierInvoices}
          contacts={contacts}
          onClose={() => setShowCreate(false)}
          onSave={createSupplierInvoice}
        />
      )}

      {detail && (
        <InvoiceDetailModal
          invoice={detail}
          reconciliation={reconciliationById.get(detail.id) ?? null}
          allocatedPayments={paymentsForInvoice(supplierPayments, detail.id)}
          creditNotes={creditNotesForInvoice(supplierCreditNotes, detail.id)}
          creditStateUnknown={creditStateUnknown}
          currencyCode={currencyCode}
          onClose={() => setDetail(null)}
        />
      )}

      {creditEditor && (
        <CreditNoteModal
          key={creditEditor.creditNote?.id ?? `new_${creditEditor.invoice.id}`}
          invoice={creditEditor.invoice}
          creditNote={creditEditor.creditNote}
          creditNotes={supplierCreditNotes}
          currencyCode={currencyCode}
          onClose={() => setCreditEditor(null)}
          onSave={creditEditor.creditNote
            ? (data) => updateSupplierCreditNote(creditEditor.creditNote, { invoice: creditEditor.invoice, ...data })
            : (data) => createSupplierCreditNote({ invoice: creditEditor.invoice, ...data })}
        />
      )}

      {creditVoiding && (
        <VoidCreditNoteModal
          creditNote={creditVoiding}
          onClose={() => setCreditVoiding(null)}
          onConfirm={voidSupplierCreditNote}
        />
      )}
    </div>
  )
}
