import { useMemo, useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency } from '../../lib/formatters'
import { roundMoney } from '../../lib/purchaseOrders'
import { useProfile } from '../../hooks/useProfile'
import { useCompany } from '../../hooks/useCompany'
import { useClientInvoices } from '../../hooks/useClientInvoices'
import { useProjectCommercial } from '../../hooks/useProjectCommercial'
import { useVariations } from '../../hooks/useVariations'
import { useContacts } from '../../hooks/useContacts'
import { CONTACT_TYPE } from '../../lib/contacts'
import { needsTaxLimitationNotice, TAX_LIMITATION_NOTICE } from '../../lib/currency'
import { isFinancialRole, isBaselineEstablished, currentContractSum } from '../../lib/margin'
import {
  approvedClientVariationsTotal, pendingClientVariationExposureTotal,
} from '../../lib/variations'
import {
  CI_STATUS, CI_STATUS_LABELS, CI_BADGE_VARIANTS,
  TAX_CODE, TAX_CODES, TAX_CODE_LABELS,
  AGEING_BUCKETS, AR_LIMITATION_NOTICE,
  gstForLine, invoiceTotals, suggestDueDate, paymentTermsLabel, isPastDue, daysPastDue,
  contractControl, ageingByDueDate, variationInvoicingRows, invoiceableClientVariations,
  resolveVariationCostCode, contractOverInvoiceWarning, variationOverInvoiceWarnings,
} from '../../lib/clientInvoices'

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

function todayIso() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

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

const blankLine = () => ({ variationId: '', description: '', amount: '', taxCode: TAX_CODE.GST })

function InvoiceEditorModal({
  invoice, clientContacts, defaultClientId, variations, clientInvoices,
  contractSum, issuedExGst, currencyCode, showTaxNotice, onClose, onSave,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const isEdit = !!invoice

  const [clientId, setClientId] = useState(invoice?.clientId || defaultClientId || '')
  const [clientRef, setClientRef] = useState(invoice?.clientRef || '')
  const [externalRef, setExternalRef] = useState(invoice?.externalInvoiceReference || '')
  const [description, setDescription] = useState(invoice?.description || '')
  const [periodEnding, setPeriodEnding] = useState(invoice?.periodEnding || '')
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoiceDate || todayIso())
  const [dueDate, setDueDate] = useState(invoice?.dueDate || '')
  const [dueTouched, setDueTouched] = useState(!!invoice?.dueDate)
  const [notes, setNotes] = useState(invoice?.notes || '')
  const [lines, setLines] = useState(() =>
    invoice?.lineItems?.length
      ? invoice.lineItems.map(li => ({
          variationId: li.variationId || '',
          description: li.description || '',
          amount:      String(li.amount ?? ''),
          taxCode:     li.taxCode || TAX_CODE.GST,
        }))
      : [blankLine()],
  )
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const client = clientContacts.find(c => c.id === clientId) ?? null
  const terms  = client?.paymentTerms ?? null

  // Approved client variations that may still be billed. Pending variations and
  // negative (credit) variations are excluded in lib/clientInvoices.js.
  const variationRows = useMemo(
    () => invoiceableClientVariations(variations, clientInvoices),
    [variations, clientInvoices],
  )
  const variationById = useMemo(
    () => new Map((variations ?? []).map(v => [v.id, v])),
    [variations],
  )

  // Re-suggest the due date from the client's terms until the user edits it.
  function applyDueSuggestion(nextInvoiceDate, nextTerms) {
    if (dueTouched) return
    setDueDate(suggestDueDate(nextInvoiceDate, nextTerms) || '')
  }
  const changeClient = (e) => {
    const next = clientContacts.find(c => c.id === e.target.value) ?? null
    setClientId(e.target.value)
    applyDueSuggestion(invoiceDate, next?.paymentTerms ?? null)
  }
  const changeInvoiceDate = (e) => {
    setInvoiceDate(e.target.value)
    applyDueSuggestion(e.target.value, terms)
  }

  const setLine = (idx, patch) => setLines(ls => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  const addLine = () => setLines(ls => [...ls, blankLine()])
  const removeLine = (idx) => setLines(ls => (ls.length === 1 ? [blankLine()] : ls.filter((_, i) => i !== idx)))

  // Selecting a variation seeds the description and the remaining balance.
  const selectVariation = (idx) => (e) => {
    const variationId = e.target.value
    const row = variationRows.find(r => r.id === variationId)
    setLine(idx, {
      variationId,
      description: row ? `${row.variationNumber} — ${row.title}`.trim() : lines[idx].description,
      amount:      row ? String(row.remaining) : lines[idx].amount,
    })
  }

  // Canonical (ex-GST) lines, built exactly as they will be stored. A row that
  // is entirely empty (no description and no amount) is a not-yet-filled editor
  // row, not a line — it is dropped rather than blocking the save.
  const builtLines = lines.map((l, idx) => {
    const amount = roundMoney(Number(l.amount) || 0)
    const v = l.variationId ? variationById.get(l.variationId) ?? null : null
    const cc = v ? resolveVariationCostCode(v) : { costCodeId: null, costCodeName: null }
    return {
      description:          l.description.trim(),
      amount,
      taxCode:              l.taxCode,
      gstAmount:            gstForLine(amount, l.taxCode),
      variationId:          v ? v.id : null,
      variationNumber:      v ? v.variationNumber : null,
      variationDescription: v ? (v.title || '') : null,
      costCodeId:           cc.costCodeId,
      costCodeName:         cc.costCodeName,
      sortOrder:            idx,
    }
  })

    .filter(l => l.description.length > 0 || l.amount !== 0)
    .map((l, i) => ({ ...l, sortOrder: i }))

  const totals = invoiceTotals(builtLines)

  // Contract control, live. Editing an existing DRAFT does not change the
  // issued total (drafts have billed nothing), so the comparison is always
  // "issued so far + this invoice".
  const contractWarning = contractOverInvoiceWarning({
    currentContractSum: contractSum,
    issuedExGst,
    thisInvoiceExGst: totals.subtotal,
  })
  const variationWarnings = variationOverInvoiceWarnings(builtLines, variations, clientInvoices)
  const warnings = [...(contractWarning ? [contractWarning] : []), ...variationWarnings]
  const needsAck = warnings.length > 0

  const hasClient = !!clientId
  const hasAmount = builtLines.some(l => l.amount !== 0)
  const allDescribed = builtLines.every(l => l.description.length > 0)
  const noNegative = builtLines.every(l => l.amount >= 0)
  const valid = hasClient && !!invoiceDate && hasAmount && allDescribed && noNegative && (!needsAck || acknowledged)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      await onSave({
        clientId,
        clientName:      client?.displayName || '',
        clientLegalName: client?.legalName || '',
        clientAbn:       client?.abn || '',
        clientEmail:     client?.email || '',
        clientPhone:     client?.phone || '',
        clientAddress:   client?.address || null,
        clientRef,
        externalInvoiceReference: externalRef,
        description,
        periodEnding,
        invoiceDate,
        dueDate,
        paymentTerms: terms,
        lineItems: builtLines,
        notes,
      })
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  const availableNow = roundMoney(contractSum - issuedExGst)

  return (
    <ModalShell wide title={isEdit ? `Edit ${invoice.invoiceNumber}` : 'New Client Invoice'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
        {/* Client + references */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Client <span className="text-brand-red">*</span></label>
            <select className={inputCls} value={clientId} onChange={changeClient} required>
              <option value="" disabled>Select the client…</option>
              {clientContacts.map(c => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </select>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Client-type contacts only. Name, legal name, ABN, email, phone, and address are
              snapshotted onto this invoice at save, so later contact edits never rewrite it.
            </p>
          </div>
          <div>
            <label className={labelCls}>Client Reference</label>
            <input
              className={inputCls}
              placeholder="The client's contract or PO reference"
              value={clientRef}
              onChange={e => setClientRef(e.target.value)}
            />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">The client&apos;s own reference — not your invoice number.</p>
          </div>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Invoice Date <span className="text-brand-red">*</span></label>
            <input type="date" className={inputCls} value={invoiceDate} onChange={changeInvoiceDate} />
          </div>
          <div>
            <label className={labelCls}>Due Date</label>
            <input
              type="date" className={inputCls} value={dueDate}
              onChange={e => { setDueTouched(true); setDueDate(e.target.value) }}
            />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              {terms
                ? <>Suggested from {client?.displayName}&apos;s payment terms ({paymentTermsLabel(terms)}). Editable.</>
                : <>No payment terms recorded for this client — left blank rather than assuming a term. Set terms on the contact, or enter a date.</>}
            </p>
          </div>
          <div>
            <label className={labelCls}>Period Ending</label>
            <input type="date" className={inputCls} value={periodEnding} onChange={e => setPeriodEnding(e.target.value)} />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">Optional — the period this invoice covers.</p>
          </div>
        </div>

        {/* Contract availability */}
        <div className="rounded-lg border border-brand-border p-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric label="Current Contract Sum" value={money(contractSum)} help="Ex-GST" />
            <Metric label="Issued Client Invoices" value={money(issuedExGst)} help="Ex-GST" />
            <Metric label="Available to Invoice" value={money(availableNow)} danger={availableNow < 0} help="Before this invoice" />
            <Metric label="This Invoice" value={money(totals.subtotal)} help="Ex-GST" />
          </div>
        </div>

        {/* Lines */}
        <div>
          <label className={labelCls}>Line Items (ex-GST)</label>
          <div className="flex flex-col gap-2">
            {lines.map((line, idx) => {
              const row = line.variationId ? variationRows.find(r => r.id === line.variationId) : null
              return (
                <div key={idx} className="rounded-lg border border-brand-border p-2.5 flex flex-col gap-2">
                  <div className="grid grid-cols-1 sm:grid-cols-[1.4fr_2fr_1fr_1.2fr_auto] gap-2 items-start">
                    <select className={inputCls} value={line.variationId} onChange={selectVariation(idx)}>
                      <option value="">Contract line</option>
                      {variationRows.map(r => (
                        <option key={r.id} value={r.id}>{r.variationNumber}</option>
                      ))}
                    </select>
                    <input
                      className={inputCls}
                      placeholder="Description"
                      value={line.description}
                      onChange={e => setLine(idx, { description: e.target.value })}
                    />
                    <input
                      type="number" min="0" step="any"
                      className={inputCls}
                      placeholder="Amount"
                      value={line.amount}
                      onChange={e => setLine(idx, { amount: e.target.value })}
                    />
                    <select className={inputCls} value={line.taxCode} onChange={e => setLine(idx, { taxCode: e.target.value })}>
                      {TAX_CODES.map(tc => (
                        <option key={tc} value={tc}>{TAX_CODE_LABELS[tc]}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeLine(idx)}
                      aria-label="Remove line"
                      className="text-brand-muted hover:text-brand-red text-lg leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
                    >
                      ×
                    </button>
                  </div>
                  {row && (
                    <p className="m-0 text-[11px] text-brand-muted">
                      {row.variationNumber} approved {money(row.approved)} · invoiced {money(row.invoiced)} ·
                      {' '}<span className={row.remaining < 0 ? 'text-brand-red font-semibold' : 'text-brand-text font-semibold'}>remaining {money(row.remaining)}</span>
                      {row.costCodeId
                        ? ` · cost code ${row.costCodeName}`
                        : ' · spans several cost codes — no cost code snapshotted'}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            <Btn sm variant="ghost" type="button" onClick={addLine}>+ Add line</Btn>
          </div>
          <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
            Each line is either a <span className="font-semibold">contract line</span> (billed against the contract sum,
            no cost code — head-contract revenue sits above the cost-code spine) or an
            {' '}<span className="font-semibold">approved client variation</span>, chosen in the first column.
            {variationRows.length === 0
              ? ' There are no approved client variations available to invoice.'
              : ' Pending variations and negative (credit) variations are deliberately not offered.'}
          </p>
        </div>

        {/* External reference + description */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>External Invoice Reference</label>
            <input
              className={inputCls}
              placeholder="e.g. Xero INV-0421"
              value={externalRef}
              onChange={e => setExternalRef(e.target.value)}
            />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Optional. The reference of the invoice you actually issued to the client from Xero, MYOB,
              QuickBooks, or a manual process. Editable while draft; frozen once issued.
            </p>
          </div>
          <div>
            <label className={labelCls}>Description</label>
            <input className={inputCls} placeholder="Optional header description" value={description} onChange={e => setDescription(e.target.value)} />
          </div>
        </div>

        <div>
          <label className={labelCls}>Notes</label>
          <input className={inputCls} placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        {showTaxNotice && (
          <p className="m-0 text-[12px] text-brand-amber">⚠ {TAX_LIMITATION_NOTICE}</p>
        )}

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
              I understand this invoice exceeds the available contract or variation value and want to save it anyway.
              <span className="block text-brand-muted mt-0.5">
                Constrapp warns but never blocks over-invoicing, and cannot prevent two users invoicing the same
                remaining value at the same time.
              </span>
            </span>
          </label>
        )}

        {/* Totals */}
        <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
          <p className="m-0">Subtotal (ex-GST) <span className="font-semibold ml-2">{money(totals.subtotal)}</span></p>
          <p className="m-0 text-brand-muted">GST <span className="ml-2">{money(totals.gstTotal)}</span></p>
          <p className="m-0 font-bold">Invoice total (inc. GST) <span className="ml-2">{money(totals.grossTotal)}</span></p>
        </div>

        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}

        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !valid}>
            {saving ? 'Saving…' : isEdit ? 'Save draft' : 'Create draft invoice'}
          </Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Void ─────────────────────────────────────────────────────────────────────

function VoidModal({ invoice, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!reason.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(invoice, reason)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to void. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell title={`Void ${invoice.invoiceNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Voiding is permanent — a voided invoice can never be re-issued or edited, and its number is
          retained, leaving an intentional gap in the sequence. It contributes nothing to invoiced value
          or receivables. Financial records are never deleted.
        </p>
        <div>
          <label className={labelCls}>Reason <span className="text-brand-red">*</span></label>
          <input
            className={inputCls}
            placeholder="Why is this invoice being voided?"
            value={reason}
            onChange={e => setReason(e.target.value)}
            autoFocus
          />
        </div>
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !reason.trim()}>{saving ? 'Voiding…' : 'Void invoice'}</Btn>
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

function DetailModal({ invoice, currencyCode, onClose }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const addr = invoice.clientAddress ?? {}
  const addrText = [addr.street, addr.suburb, addr.state, addr.postcode].filter(Boolean).join(', ')

  return (
    <ModalShell wide title={`${invoice.invoiceNumber} — ${CI_STATUS_LABELS[invoice.status] ?? invoice.status}`} onClose={onClose}>
      <div className="px-5 py-4 flex flex-col gap-3.5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
          <DetailRow label="Client" value={invoice.clientName} />
          <DetailRow label="Client Legal Name" value={invoice.clientLegalName} />
          <DetailRow label="Client ABN" value={invoice.clientAbn} />
          <DetailRow label="Client Email" value={invoice.clientEmail} />
          <DetailRow label="Client Phone" value={invoice.clientPhone} />
          <DetailRow label="Billing Address" value={addrText} />
          <DetailRow label="Client Reference" value={invoice.clientRef} />
          <DetailRow label="External Invoice Reference" value={invoice.externalInvoiceReference} />
          <DetailRow label="Period Ending" value={invoice.periodEnding} />
          <DetailRow label="Invoice Date" value={invoice.invoiceDate} />
          <DetailRow label="Due Date" value={invoice.dueDate} />
          <DetailRow
            label="Payment Terms (snapshot)"
            value={invoice.paymentTerms ? paymentTermsLabel(invoice.paymentTerms) : 'None recorded'}
          />
        </div>

        {invoice.description && <DetailRow label="Description" value={invoice.description} />}

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-brand-card border-b border-brand-border">
                {['Variation', 'Description', 'Cost Code', 'Ex-GST', 'Tax', 'GST'].map(h => (
                  <th key={h} className={thCls}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(invoice.lineItems ?? []).map((li, i) => (
                <tr key={i} className="border-b border-brand-border">
                  <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{li.variationNumber || '—'}</td>
                  <td className="px-3.5 py-2.5 text-[13px] text-brand-text">{li.description || '—'}</td>
                  <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{li.costCodeName || '—'}</td>
                  <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(li.amount)}</td>
                  <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{TAX_CODE_LABELS[li.taxCode] ?? li.taxCode}</td>
                  <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{money(li.gstAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
          <p className="m-0">Subtotal (ex-GST) <span className="font-semibold ml-2">{money(invoice.subtotal)}</span></p>
          <p className="m-0 text-brand-muted">GST <span className="ml-2">{money(invoice.gstTotal)}</span></p>
          <p className="m-0 font-bold">Invoice total (inc. GST) <span className="ml-2">{money(invoice.grossTotal)}</span></p>
        </div>

        {invoice.notes && <DetailRow label="Notes" value={invoice.notes} />}
        {invoice.status === CI_STATUS.VOID && <DetailRow label="Void Reason" value={invoice.voidReason} />}

        <p className="m-0 text-[11px] text-brand-muted border-t border-brand-border pt-3">
          Amounts are ex-GST plus per-line Australian GST, shown in this project&apos;s currency ({currencyCode}).
          Constrapp does not produce a compliant Australian Tax Invoice — company legal name, ABN, and address are
          not captured — so issue the tax invoice from your accounting system and record its reference above.
        </p>
      </div>
    </ModalShell>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectClientInvoices() {
  const navigate = useNavigate()
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { profile, profileLoading } = useProfile()
  const { company } = useCompany()

  const canView = isFinancialRole(profile?.role)
  // Non-financial roles never trigger the commercially-sensitive reads (rules
  // would deny them anyway — this is the UX mirror; rules are the boundary).
  const mid = canView ? projectId : null

  const {
    clientInvoices, clientInvoicesLoading, clientInvoicesError,
    createClientInvoice, updateClientInvoice, issueClientInvoice, voidClientInvoice,
  } = useClientInvoices(mid)
  const { baseline, baselineLoading } = useProjectCommercial(mid)
  const { variations } = useVariations(mid)
  const { contacts } = useContacts()

  const [editing, setEditing] = useState(null)   // invoice | 'new' | null
  const [voiding, setVoiding] = useState(null)
  const [detail, setDetail]   = useState(null)
  const [actionError, setActionError] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [clientFilter, setClientFilter] = useState('all')
  const [pastDueOnly, setPastDueOnly] = useState(false)

  const clientContacts = useMemo(
    () => contacts.filter(c => c.isActive !== false && (c.contactTypes ?? []).includes(CONTACT_TYPE.CLIENT)),
    [contacts],
  )

  // Current Contract Sum — the EXISTING read-time derivation (lib/margin.js over
  // the baseline plus approved client variations). Not recomputed here.
  const contractSum = useMemo(
    () => currentContractSum(baseline?.originalContractValue ?? 0, approvedClientVariationsTotal(variations)),
    [baseline?.originalContractValue, variations],
  )
  const pendingClientExposure = useMemo(
    () => pendingClientVariationExposureTotal(variations),
    [variations],
  )
  const control = useMemo(
    () => contractControl(clientInvoices, contractSum),
    [clientInvoices, contractSum],
  )
  const ageing = useMemo(() => ageingByDueDate(clientInvoices), [clientInvoices])
  const variationRows = useMemo(
    () => variationInvoicingRows(variations, clientInvoices),
    [variations, clientInvoices],
  )

  const established = isBaselineEstablished(baseline)
  const showTaxNotice = needsTaxLimitationNotice(company?.countryCode)
  const canCreate = established && clientContacts.length > 0

  const clientNames = [...new Set(clientInvoices.map(i => i.clientName).filter(Boolean))].sort()

  const filtered = clientInvoices.filter(inv => {
    if (statusFilter !== 'all' && inv.status !== statusFilter) return false
    if (clientFilter !== 'all' && inv.clientName !== clientFilter) return false
    if (pastDueOnly && !isPastDue(inv)) return false
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      const hay = [
        inv.invoiceNumber, inv.clientName, inv.clientRef, inv.externalInvoiceReference, inv.description,
        ...(inv.lineItems ?? []).map(li => li.variationNumber),
      ].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  async function handleIssue(invoice) {
    if (!window.confirm(`Issue ${invoice.invoiceNumber}? Issued invoices cannot be edited — only voided.`)) return
    setActionError(null)
    try {
      await issueClientInvoice(invoice)
    } catch (err) {
      setActionError(err?.message || 'Failed to issue. Check your connection and try again.')
    }
  }

  // ── Gates ──────────────────────────────────────────────────────────────────
  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!canView) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Client invoices are restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          Client invoices and receivables are visible to Company Admin, Project Manager, and QS roles only.
          Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }
  if (baselineLoading || clientInvoicesLoading) {
    return <div className="text-[13px] text-brand-muted">Loading client invoices…</div>
  }
  if (!established) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Set the commercial baseline first</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1 mb-3">
          Client invoices are controlled against the Current Contract Sum, so this project needs an
          Original Contract Value before invoices can be raised.
        </p>
        <Btn sm variant="ghost" onClick={() => navigate(`/projects/${projectId}/commercial`)}>Go to Margin</Btn>
      </Card>
    )
  }

  return (
    <div>
      {/* ── Contract control ───────────────────────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
          <Metric label="Current Contract Sum" value={money(control.currentContractSum)} help="Ex-GST · original + approved client variations" />
          <Metric label="Issued Client Invoices" value={money(control.issued.subtotal)} help={`Ex-GST · ${control.issued.count} issued`} />
          <Metric
            label="Available to Invoice"
            value={money(control.availableToInvoice)}
            help="Unbilled contract value (ex-GST)"
            danger={control.availableToInvoice < 0}
          />
          <Metric label="Issued (inc. GST)" value={money(control.issued.grossTotal)} help="What has been billed" />
          <Metric label="Draft Client Invoices" value={money(control.drafts.subtotal)} help={`Ex-GST · ${control.drafts.count} draft · not counted above`} />
          <Metric label="Pending Client Variation Exposure" value={money(pendingClientExposure)} help="Not invoiceable · not in the contract sum" />
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          All contract figures are ex-GST and derived at read time — nothing is written back to the commercial
          baseline or to variations. Over-invoicing is <span className="font-semibold">warned, never blocked</span>,
          and the limit cannot be enforced by Firestore rules (they cannot sum sibling documents), so two users can
          invoice the same remaining value at the same time.
        </p>
      </Card>

      {/* ── Accounts receivable ────────────────────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2.5">
          <p className="text-[13px] font-bold text-brand-text m-0">Accounts Receivable — ageing by due date</p>
          <p className="m-0 text-[11px] text-brand-muted">Gross (inc. GST) · issued invoices only</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
          <Metric label="Issued, not yet reconciled" value={money(ageing.total)} help="Every issued, non-void invoice" />
          {AGEING_BUCKETS.map(b => (
            <Metric
              key={b.key}
              label={b.label}
              value={money(ageing.buckets[b.key].amount)}
              help={`${ageing.buckets[b.key].count} invoice${ageing.buckets[b.key].count === 1 ? '' : 's'}`}
              danger={b.key === 'd61_90' || b.key === 'd90plus'}
            />
          ))}
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-amber">⚠ {AR_LIMITATION_NOTICE}</p>
      </Card>

      {/* ── Variation invoicing ────────────────────────────────────────────── */}
      {variationRows.length > 0 && (
        <Card className="mb-3.5" padding={false}>
          <div className="px-5 pt-4 pb-2">
            <p className="text-[13px] font-bold text-brand-text m-0">Approved client variations</p>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Ex-GST, derived at read time from issued invoices. Variation documents are never modified by
              invoicing. Negative (credit) variations reduce the Current Contract Sum but cannot be invoiced —
              a future Credit Note bills them.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-y border-brand-border">
                  {['Variation', 'Title', 'Cost Code', 'Approved', 'Invoiced', 'Remaining'].map(h => (
                    <th key={h} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {variationRows.map(r => (
                  <tr key={r.id} className="border-b border-brand-border last:border-b-0">
                    <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">{r.variationNumber}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-text">{r.title || '—'}</td>
                    <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{r.costCodeName || <span title="Spans several cost codes">—</span>}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(r.approved)}</td>
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{money(r.invoiced)}</td>
                    <td className={`px-3.5 py-2.5 text-[13px] font-semibold whitespace-nowrap ${r.remaining < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
                      {money(r.remaining)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ── Register ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          Client invoices issued against this project&apos;s contract sum and approved client variations.
        </p>
        <div className="flex items-center gap-2">
          {clientContacts.length === 0 && (
            <Btn variant="ghost" sm onClick={() => navigate('/contacts')}>Add a client contact</Btn>
          )}
          <Btn sm onClick={() => setEditing('new')} disabled={!canCreate}>+ New Client Invoice</Btn>
        </div>
      </div>

      {actionError && <p className="text-[12px] text-brand-red mb-3">{actionError}</p>}
      {clientInvoicesError && (
        <p className="text-[12px] text-brand-amber mb-3">Couldn&apos;t load client invoices — check your connection and access.</p>
      )}
      {showTaxNotice && (
        <p className="text-[12px] text-brand-amber mb-3">⚠ {TAX_LIMITATION_NOTICE}</p>
      )}

      {clientInvoices.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3.5">
          <input
            className={`${inputCls} max-w-[260px]`}
            placeholder="Search CI #, client, reference, variation…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className={`${inputCls} max-w-[170px]`} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {[CI_STATUS.DRAFT, CI_STATUS.ISSUED, CI_STATUS.VOID].map(s => (
              <option key={s} value={s}>{CI_STATUS_LABELS[s]}</option>
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
          <Btn sm variant={pastDueOnly ? 'success' : 'ghost'} onClick={() => setPastDueOnly(v => !v)}>
            Past due date
          </Btn>
        </div>
      )}

      <Card padding={false}>
        {clientInvoices.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {clientContacts.length === 0
                ? 'Add a client-type contact before raising client invoices.'
                : 'No client invoices yet. Raise your first invoice against the contract sum.'}
            </p>
            {clientContacts.length === 0
              ? <Btn variant="ghost" onClick={() => navigate('/contacts')}>Go to Contacts</Btn>
              : <Btn onClick={() => setEditing('new')}>+ Create your first client invoice</Btn>}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">No invoices match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['CI #', 'Client', 'Client Ref', 'External Ref', 'Invoice Date', 'Due', 'Ex-GST', 'GST', 'Total', 'Variations', 'Status', ''].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(inv => {
                  const pastDue = isPastDue(inv)
                  const days = pastDue ? daysPastDue(inv.dueDate) : null
                  const varCount = (inv.lineItems ?? []).filter(li => li.variationId).length
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
                      <td className="px-3.5 py-3 text-[13px] text-brand-text">{inv.clientName || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{inv.clientRef || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{inv.externalInvoiceReference || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{inv.invoiceDate || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] whitespace-nowrap">
                        {inv.dueDate
                          ? <span className={pastDue ? 'text-brand-red font-semibold' : 'text-brand-muted'}>
                              {inv.dueDate}{pastDue ? ` • Past due ${days}d` : ''}
                            </span>
                          : <span className="text-brand-muted">—</span>}
                      </td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-text whitespace-nowrap">{money(inv.subtotal)}</td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">{money(inv.gstTotal)}</td>
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{money(inv.grossTotal)}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{varCount || '—'}</td>
                      <td className="px-3.5 py-3">
                        <Badge label={CI_STATUS_LABELS[inv.status] ?? inv.status} variant={CI_BADGE_VARIANTS[inv.status]} sm />
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex gap-1.5 justify-end">
                          {inv.status === CI_STATUS.DRAFT && (
                            <>
                              <Btn sm variant="ghost" onClick={() => setEditing(inv)}>Edit</Btn>
                              <Btn sm variant="success" onClick={() => handleIssue(inv)}>Issue</Btn>
                            </>
                          )}
                          {(inv.status === CI_STATUS.DRAFT || inv.status === CI_STATUS.ISSUED) && (
                            <Btn sm variant="ghost" onClick={() => setVoiding(inv)}>Void</Btn>
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
        Constrapp records what has been invoiced. It does <span className="font-semibold">not</span> yet produce a
        compliant Australian Tax Invoice — company legal name, ABN, and address are not captured — so issue the tax
        invoice from your accounting system and record its reference on each invoice. GST is a flat Australian 10%
        regardless of the project&apos;s currency.
      </p>

      {editing && (
        <InvoiceEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          invoice={editing === 'new' ? null : editing}
          clientContacts={clientContacts}
          defaultClientId={baseline?.clientId || ''}
          variations={variations}
          clientInvoices={clientInvoices}
          contractSum={contractSum}
          issuedExGst={control.issued.subtotal}
          currencyCode={currencyCode}
          showTaxNotice={showTaxNotice}
          onClose={() => setEditing(null)}
          onSave={editing === 'new'
            ? createClientInvoice
            : (data) => updateClientInvoice(editing, data)}
        />
      )}

      {voiding && (
        <VoidModal invoice={voiding} onClose={() => setVoiding(null)} onConfirm={voidClientInvoice} />
      )}

      {detail && (
        <DetailModal invoice={detail} currencyCode={currencyCode} onClose={() => setDetail(null)} />
      )}
    </div>
  )
}
