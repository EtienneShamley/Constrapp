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
// from posted Supplier Payments — no supplier invoice document is ever written
// with a balance, a payment status, or a payment back-reference (ADR-24).
function InvoiceDetailModal({ invoice, reconciliation, allocatedPayments, currencyCode, onClose }) {
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
                <Badge
                  label={RECONCILIATION_LABELS[reconciliation.state]}
                  variant={RECONCILIATION_BADGE_VARIANTS[reconciliation.state]}
                  sm
                />
              </div>
              <div className="grid grid-cols-3 gap-3.5">
                <DetailRow label="Net Payable" value={money(reconciliation.payableTotal)} />
                <DetailRow label="Paid to Date" value={money(reconciliation.paid)} />
                <div>
                  <p className={labelCls}>Remaining Payable</p>
                  <p className={`m-0 text-[13px] font-semibold ${reconciliation.remaining < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
                    {money(reconciliation.remaining)}
                  </p>
                </div>
              </div>
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
            </div>
          )}

          {invoice.notes && <DetailRow label="Notes" value={invoice.notes} />}

          <p className="m-0 text-[11px] text-brand-muted border-t border-brand-border pt-3">
            Amounts are ex-GST plus per-line Australian GST, shown in this project&apos;s currency ({currencyCode}).
            Paid to Date and Remaining Payable are derived at read time from posted Supplier Payments and are never
            written onto this invoice — it carries no balance field, no payment status, and no payment reference.
          </p>
        </div>
      </div>
    </div>
  )
}

function RowActions({ invoice, onTransition, onRecordPayment }) {
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
  // Posted is the financial commit point — the only status a payment may settle.
  if (invoice.status === SI_STATUS.POSTED) {
    return (
      <div className="flex gap-1.5 justify-end">
        <Btn sm variant="ghost" onClick={() => onRecordPayment(invoice)}>Record payment</Btn>
      </div>
    )
  }
  return null
}

export default function ProjectInvoices() {
  const navigate = useNavigate()
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { supplierInvoices, supplierInvoicesLoading, createSupplierInvoice, transitionStatus } = useSupplierInvoices(projectId)
  const { supplierPayments } = useSupplierPayments(projectId)
  const { purchaseOrders, purchaseOrdersLoading } = usePurchaseOrders(projectId)
  const { progressClaims } = useProgressClaims(projectId)
  const { contacts } = useContacts()
  const [showCreate, setShowCreate]   = useState(false)
  const [detail, setDetail]           = useState(null)
  const [actionError, setActionError] = useState(null)
  const [search, setSearch]           = useState('')
  const [statusFilter, setStatusFilter]   = useState('all')
  const [supplierFilter, setSupplierFilter] = useState('all')

  // ── Payment reconciliation, all derived at read time ───────────────────────
  // Nothing here is written onto a supplier invoice document.
  const payables = useMemo(
    () => payablesSummary(supplierInvoices, supplierPayments),
    [supplierInvoices, supplierPayments],
  )
  const reconciliationById = useMemo(
    () => new Map(payables.rows.map(r => [r.id, r])),
    [payables.rows],
  )
  const exceptions = useMemo(
    () => allocationExceptions(supplierPayments, supplierInvoices),
    [supplierPayments, supplierInvoices],
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

      {/* ── Compact accounts-payable summary ───────────────────────────────── */}
      {payables.count > 0 && (
        <Card className="mb-3.5">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 flex-1">
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
                <p className={labelCls}>Remaining Payable</p>
                <p className="text-lg font-bold text-brand-text">{money(payables.remaining)}</p>
                <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">Still owing on posted invoices</p>
              </div>
            </div>
            <Btn variant="ghost" sm onClick={goToPayments}>Open Supplier Payments</Btn>
          </div>
          <p className="m-0 mt-3 text-[11px] text-brand-muted">
            Derived at read time from posted Supplier Payments — nothing is written onto an invoice, and no invoice
            is ever marked <span className="font-semibold">paid</span>. Full AP ageing is on the Supplier Payments
            view.
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
                  {['SI #', 'Supplier Inv #', 'Supplier', 'PO', 'Claim', 'Invoice Date', 'Due', 'Subtotal', 'GST', 'Gross', 'Retention', 'Net Payable', 'Paid to Date', 'Remaining Payable', 'Reconciliation', 'Status', ''].map((h, i) => (
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
                      {/* Paid to Date / Remaining Payable / Reconciliation are
                          DERIVED from posted supplier payments on every render —
                          never stored here. Only posted invoices are payable. */}
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">
                        {recon ? money(recon.paid) : '—'}
                      </td>
                      <td className="px-3.5 py-3 text-[13px] font-semibold whitespace-nowrap">
                        {recon
                          ? <span className={recon.remaining < 0 ? 'text-brand-red' : 'text-brand-text'}>{money(recon.remaining)}</span>
                          : <span className="text-brand-muted">—</span>}
                      </td>
                      <td className="px-3.5 py-3">
                        {recon
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
                        <RowActions invoice={inv} onTransition={handleTransition} onRecordPayment={handleRecordPayment} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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
          currencyCode={currencyCode}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}
