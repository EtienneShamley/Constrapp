import { useEffect, useMemo, useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import WriteFeedback from '../../components/WriteFeedback'
import { useWriteAction } from '../../hooks/useWriteAction'
import { formatCurrency } from '../../lib/formatters'
import { roundMoney } from '../../lib/purchaseOrders'
import { useAuth } from '../../hooks/useAuth'
import { useProfile } from '../../hooks/useProfile'
import { useCompany } from '../../hooks/useCompany'
import { usePrintMoment } from '../../hooks/usePrintMoment'
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
  AGEING_BUCKETS,
  gstForLine, invoiceTotals, suggestDueDate, paymentTermsLabel, daysPastDue,
  contractControl, ageingByDueDate, variationInvoicingRows, invoiceableClientVariations,
  resolveVariationCostCode, contractOverInvoiceWarning, variationOverInvoiceWarnings,
  retentionError, retentionFromPercent, invoiceRetention, hasRetention,
} from '../../lib/clientInvoices'
import { useClientReceipts } from '../../hooks/useClientReceipts'
import { useClientCreditNotes } from '../../hooks/useClientCreditNotes'
import { useClientRetentionReleases } from '../../hooks/useClientRetentionReleases'
import { useClientInvoiceLedgers } from '../../hooks/useClientInvoiceLedgers'
import { fromCents } from '../../lib/money'
import {
  clientFinanceActivated, retentionToSave, showClientFinanceRecords, CLIENT_FINANCE_NOT_ACTIVATED_TEXT,
} from '../../lib/clientFinanceActivation'
import { receivableContext, ledgerExceptions } from '../../lib/clientReceivables'
import {
  CCN_STATUS, CCN_STATUS_LABELS, CCN_BADGE_VARIANTS,
  postedClientCreditNotes, creditNotesForInvoice, clientCreditExceptions,
  CLIENT_CREDIT_NOTE_NOTICE, CLIENT_CREDIT_EXCEPTION_REMEDY, CLIENT_CREDIT_READ_UNAVAILABLE_NOTICE,
} from '../../lib/clientCreditNotes'
import {
  CRR_STATUS_LABELS, CRR_BADGE_VARIANTS, postedClientRetentionReleases,
  CLIENT_RETENTION_HELD_NOTICE, CLIENT_RETENTION_READ_UNAVAILABLE_NOTICE,
} from '../../lib/clientRetention'
import ClientCreditNoteModal from './clientCredit/ClientCreditNoteModal'
import ClientCreditPostModal from './clientCredit/ClientCreditPostModal'
import ClientCreditVoidModal from './clientCredit/ClientCreditVoidModal'
import ClientCreditDetailModal from './clientCredit/ClientCreditDetailModal'
import ClientCreditNotePrint from './clientCredit/ClientCreditNotePrint'
import {
  clientReconciliationLabel, owedToClientDescription, OWED_TO_CLIENT_REMEDY,
} from './clientCredit/clientReconciliation'
import { RECONCILIATION_BADGE_VARIANTS, paymentMethodLabel } from '../../lib/payments'
import {
  AR_RECONCILIATION_NOTICE, ALLOCATION_EXCEPTION_REMEDY,
  receivedByInvoice, receivablesSummary, receiptsForInvoice,
  allocationExceptions, isPastDueUnreconciled,
} from '../../lib/clientReceipts'

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

// A figure whose inputs could not be read is UNKNOWN, never zero.
const Unavailable = () => <span className="text-[12px] font-normal text-brand-muted">Unavailable</span>

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
  contractSum, issuedExGst, availableNow, creditedByVariation, creditsUnknown,
  currencyCode, showTaxNotice, financeActive, onClose, onSave,
}) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
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
  // Client retention (ADR-88): an authored ex-GST AMOUNT. The percentage is a
  // helper only — while it is filled the amount is proposed from the current
  // subtotal; the percentage itself is never stored.
  const [retention, setRetention] = useState(
    invoice && Number(invoice.retention) > 0 ? String(invoice.retention) : '',
  )
  const [retentionPct, setRetentionPct] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const write = useWriteAction('Client invoice draft')

  const client = clientContacts.find(c => c.id === clientId) ?? null
  const terms  = client?.paymentTerms ?? null

  // Approved client variations that may still be billed. Pending variations and
  // negative (credit) variations are excluded in lib/clientInvoices.js.
  const variationRows = useMemo(
    () => invoiceableClientVariations(variations, clientInvoices, creditedByVariation),
    [variations, clientInvoices, creditedByVariation],
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
      // With credit notes unreadable the remaining balance is unknown, so no
      // amount is proposed.
      amount:      row && !creditsUnknown ? String(row.remaining) : lines[idx].amount,
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

  const lineTotals = invoiceTotals(builtLines)
  // `financeActive` — the company is activated for client retention
  // (lib/clientFinanceActivation.js). When it is not, no retention is offered
  // and the draft is always saved with zero retention. UX only: the Rules
  // refuse a retention amount from such a company whatever this editor sends.
  const retentionInput = !financeActive
    ? ''
    : retentionPct !== ''
      ? String(retentionFromPercent(lineTotals.subtotal, retentionPct))
      : retention
  const retentionAmount = retentionToSave(financeActive, retentionInput === '' ? 0 : Number(retentionInput))
  const retentionProblem = retentionError(retentionInput === '' ? '' : retentionAmount, lineTotals.subtotal)
  // A draft that already stores retention, opened by a company that is not
  // activated (not reachable through the app): the amount is stated, never
  // silently dropped.
  const storedRetentionDropped = !financeActive && hasRetention(invoice)
  // Subtotal, GST and gross are the FULL billed value; retention only splits
  // the gross into what is withheld and what is receivable now.
  const totals = retentionProblem ? lineTotals : invoiceTotals(builtLines, retentionAmount)

  const changeRetentionPct = (e) => {
    // Clearing the percentage keeps the amount it last proposed.
    if (e.target.value === '') setRetention(retentionInput)
    setRetentionPct(e.target.value)
  }
  const changeRetention = (e) => {
    setRetentionPct('')
    setRetention(e.target.value)
  }

  // Contract control, live. Editing an existing DRAFT does not change the
  // issued total (drafts have billed nothing), so the comparison is always
  // "issued so far + this invoice".
  // Issued is NET of posted credit notes, so with credit notes unreadable
  // neither warning can be evaluated — said below rather than computed wrongly.
  const contractWarning = creditsUnknown ? null : contractOverInvoiceWarning({
    currentContractSum: contractSum,
    issuedExGst,
    thisInvoiceExGst: totals.subtotal,
  })
  const variationWarnings = creditsUnknown
    ? []
    : variationOverInvoiceWarnings(builtLines, variations, clientInvoices, creditedByVariation)
  const warnings = [...(contractWarning ? [contractWarning] : []), ...variationWarnings]
  const needsAck = warnings.length > 0

  const hasClient = !!clientId
  const hasAmount = builtLines.some(l => l.amount !== 0)
  const allDescribed = builtLines.every(l => l.description.length > 0)
  const noNegative = builtLines.every(l => l.amount >= 0)
  const valid = hasClient && !!invoiceDate && hasAmount && allDescribed && noNegative
    && !retentionProblem && (!needsAck || acknowledged)

  function handleSubmit(e) {
    e.preventDefault()
    if (!valid) return
    write.run(() => onSave({
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
      retention: retentionAmount,
    }), { onConfirmed: onClose })
  }

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
            <Metric label="Issued Client Invoices" value={creditsUnknown ? <Unavailable /> : money(issuedExGst)} help="Ex-GST · net of credit notes" />
            <Metric
              label="Available to Invoice"
              value={creditsUnknown ? <Unavailable /> : money(availableNow)}
              danger={!creditsUnknown && availableNow < 0}
              help="Before this invoice"
            />
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
                      {row.variationNumber} approved {money(row.approved)} ·{' '}
                      {creditsUnknown
                        ? 'invoiced and remaining unavailable'
                        : <>
                            invoiced {money(row.invoiced)} ·
                            {' '}<span className={row.remaining < 0 ? 'text-brand-red font-semibold' : 'text-brand-text font-semibold'}>remaining {money(row.remaining)}</span>
                          </>}
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

        {/* Client retention — offered to an activated company only. */}
        {storedRetentionDropped && (
          <p className="m-0 text-[12px] text-brand-amber">
            ⚠ This draft records {money(invoice.retentionTotal)} of client retention (inc. GST).
            {' '}{CLIENT_FINANCE_NOT_ACTIVATED_TEXT} Saving this draft will remove the retention.
          </p>
        )}
        {financeActive && (
        <div className="rounded-lg border border-brand-border p-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_2fr] gap-3 items-start">
            <div>
              <label className={labelCls} htmlFor="ci-retention">Retention Withheld (ex-GST)</label>
              <input
                id="ci-retention"
                type="number" min="0" step="0.01"
                className={inputCls}
                placeholder="0.00"
                value={retentionInput}
                onChange={changeRetention}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="ci-retention-pct">% of Subtotal (helper)</label>
              <input
                id="ci-retention-pct"
                type="number" min="0" max="100" step="0.01"
                className={inputCls}
                placeholder="e.g. 5"
                value={retentionPct}
                onChange={changeRetentionPct}
              />
            </div>
            <p className="m-0 text-[11px] text-brand-muted sm:pt-5">
              Optional. The amount the client withholds from this invoice under the contract. Typing a percentage
              proposes an amount from the subtotal; only the <span className="font-semibold">amount</span> is
              stored, and it freezes when the invoice is issued. Retention is not a reduction in what is billed —
              Issued and Available to Invoice count the full subtotal. The GST withheld is this invoice&apos;s own
              GST in proportion.
            </p>
          </div>
          {retentionProblem && <p className="m-0 mt-2 text-[12px] text-brand-red">{retentionProblem}</p>}
        </div>
        )}

        {showTaxNotice && (
          <p className="m-0 text-[12px] text-brand-amber">⚠ {TAX_LIMITATION_NOTICE}</p>
        )}

        {creditsUnknown && (
          <p className="m-0 text-[12px] text-brand-amber">
            ⚠ {CLIENT_CREDIT_READ_UNAVAILABLE_NOTICE} The over-invoicing warnings cannot be evaluated for this draft.
          </p>
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
                Constrap warns but never blocks over-invoicing, and cannot prevent two users invoicing the same
                remaining value at the same time.
              </span>
            </span>
          </label>
        )}

        {/* Totals */}
        <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
          <p className="m-0">Subtotal (ex-GST) <span className="font-semibold ml-2">{money(totals.subtotal)}</span></p>
          <p className="m-0 text-brand-muted">GST <span className="ml-2">{money(totals.gstTotal)}</span></p>
          <p className="m-0 font-bold">Invoice total — billed (inc. GST) <span className="ml-2">{money(totals.grossTotal)}</span></p>
          {financeActive && (
            <>
              <p className="m-0 text-brand-muted">
                Retention withheld{' '}
                <span className="ml-1">{money(totals.retention)} + {money(totals.retentionGst)} GST =</span>
                <span className="ml-2 text-brand-text">{money(totals.retentionTotal)}</span>
              </p>
              <p className="m-0 font-bold">Receivable now <span className="ml-2">{money(totals.receivableTotal)}</span></p>
            </>
          )}
        </div>

        <WriteFeedback write={write} />

        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || !valid}>
            {write.busy ? 'Saving…' : write.waiting ? 'Waiting for confirmation…' : isEdit ? 'Save draft' : 'Create draft invoice'}
          </Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Void ─────────────────────────────────────────────────────────────────────

function VoidModal({ invoice, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const write = useWriteAction('Client invoice void')

  function submit(e) {
    e.preventDefault()
    if (!reason.trim()) return
    write.run(() => onConfirm(invoice, reason), { onConfirmed: onClose })
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
        <WriteFeedback write={write} />
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || !reason.trim()}>{write.busy ? 'Voiding…' : write.waiting ? 'Waiting for confirmation…' : 'Void invoice'}</Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Issue ────────────────────────────────────────────────────────────────────
//
// The confirmation that used to be a native window.confirm: issuing is
// irreversible (an issued invoice can only be voided), so it is confirmed in
// the page's own dialog, where the write's outcome is shown as well.

function IssueModal({ invoice, currencyCode, onClose, onConfirm }) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const write = useWriteAction('Client invoice issue')
  // The dialog is handed the LIVE invoice: only a draft can be issued.
  const notDraft = invoice.status !== CI_STATUS.DRAFT

  function submit(e) {
    e.preventDefault()
    if (notDraft) return
    write.run(() => onConfirm(invoice), { onConfirmed: onClose })
  }

  return (
    <ModalShell title={`Issue ${invoice.invoiceNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Issuing counts this invoice as billed. An issued invoice cannot be edited — only voided — and its
          lines, tax codes and retention freeze.
        </p>
        <div className="grid grid-cols-3 gap-3 rounded-lg border border-brand-border p-3">
          <Metric label="Subtotal (ex-GST)" value={money(invoice.subtotal)} />
          <Metric label="GST" value={money(invoice.gstTotal)} />
          <Metric label="Billed (inc. GST)" value={money(invoice.grossTotal)} />
        </div>
        <p className="m-0 text-[12px] text-brand-muted">
          {invoice.clientName || '—'} · dated {invoice.invoiceDate || '—'}
          {hasRetention(invoice) ? ` · retention to withhold ${money(invoice.retentionTotal)}` : ''}
        </p>
        <WriteFeedback write={write} />
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || notDraft}>{write.busy ? 'Issuing…' : write.waiting ? 'Waiting for confirmation…' : 'Issue invoice'}</Btn>
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
      <div className="m-0 text-[13px] text-brand-text break-words">{value || '—'}</div>
    </div>
  )
}

// `receivableUnknown` — credit notes or retention releases could not be read;
// `receivedUnknown` — receipts could not be read. Either way the figures that
// depend on them render Unavailable, never as though nothing had been posted.
function DetailModal({
  invoice, reconciliation, position, allocatedReceipts, creditNotes, releases,
  creditsUnknown, receivableUnknown, receivedUnknown, currencyCode, financeActive, onClose, onOpenRetention,
}) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const addr = invoice.clientAddress ?? {}
  const addrText = [addr.street, addr.suburb, addr.state, addr.postcode].filter(Boolean).join(', ')
  // The retention this invoice STORES (zero for an invoice written before
  // client retention existed).
  const stored = invoiceRetention(invoice)
  const isIssued = invoice.status === CI_STATUS.ISSUED
  const withheld = hasRetention(invoice)
  const balanceUnknown = receivableUnknown || receivedUnknown
  const owed = !balanceUnknown && reconciliation && reconciliation.remaining < 0

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
          <p className="m-0 font-bold">Invoice total — billed (inc. GST) <span className="ml-2">{money(invoice.grossTotal)}</span></p>
          <p className="m-0 text-brand-muted">
            Retention withheld{' '}
            <span className="ml-1">{money(fromCents(stored.retentionCents))} + {money(fromCents(stored.retentionGstCents))} GST =</span>
            <span className="ml-2 text-brand-text">{money(fromCents(stored.retentionTotalCents))}</span>
          </p>
          <p className="m-0 font-bold">
            Receivable now <span className="ml-2">{money(fromCents(stored.receivableCents))}</span>
          </p>
          {isIssued && (
            <p className="m-0 text-[11px] text-brand-muted">
              As issued — before any credit note or retention release. The live position is below.
            </p>
          )}
        </div>

        {/* Client retention — derived at read time; the invoice's own retention
            figures never change. */}
        {isIssued && withheld && (
          <div className="border-t border-brand-border pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2.5">
              <p className="text-[13px] font-bold text-brand-text m-0">Client retention</p>
              {/* The register is offered to an activated company only; the
                  figures below are shown regardless. */}
              {financeActive && (
                <Btn sm variant="ghost" type="button" onClick={onOpenRetention}>Open Client Retention</Btn>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
              <DetailRow label="Withheld (inc. GST)" value={money(fromCents(stored.retentionTotalCents))} />
              <DetailRow label="Released" value={receivableUnknown || !position ? <Unavailable /> : money(position.releasedTotal)} />
              <DetailRow label="Reduced by Credit Notes" value={receivableUnknown || !position ? <Unavailable /> : money(position.creditedRetention)} />
              <DetailRow label="Still Held" value={receivableUnknown || !position ? <Unavailable /> : money(position.retentionHeld)} />
            </div>
            <p className="m-0 mt-2 text-[11px] text-brand-muted">{CLIENT_RETENTION_HELD_NOTICE}</p>
            {!receivableUnknown && releases.length > 0 && (
              <div className="overflow-x-auto mt-3">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-brand-card border-y border-brand-border">
                      {['Release', 'Release Date', 'Reason', 'Total (inc. GST)', 'Status'].map(h => (
                        <th key={h} className={thCls}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {releases.map(r => (
                      <tr key={r.id} className="border-b border-brand-border last:border-b-0">
                        <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">{r.releaseNumber}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{r.releaseDate || '—'}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{r.reason || '—'}</td>
                        <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(r.releaseTotal)}</td>
                        <td className="px-3.5 py-2.5">
                          <Badge label={CRR_STATUS_LABELS[r.status] ?? r.status} variant={CRR_BADGE_VARIANTS[r.status]} sm />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Credit notes against this invoice. A company not activated for
            client credit notes sees this only when there is a record (or the
            read failed) — never an empty invitation. */}
        {isIssued && (creditsUnknown || showClientFinanceRecords(financeActive, creditNotes.length)) && (
          <div className="border-t border-brand-border pt-3">
            <p className="text-[13px] font-bold text-brand-text m-0 mb-2.5">Credit notes against this invoice</p>
            {creditsUnknown ? (
              <p className="m-0 text-[12px] text-brand-amber">{CLIENT_CREDIT_READ_UNAVAILABLE_NOTICE}</p>
            ) : creditNotes.length === 0 ? (
              <p className="m-0 text-[12px] text-brand-muted">No credit note has been recorded against this invoice.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-brand-card border-y border-brand-border">
                      {['Credit Note', 'Credit Date', 'Reason', 'Ex-GST', 'Total (inc. GST)', 'Status'].map(h => (
                        <th key={h} className={thCls}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {creditNotes.map(cn => (
                      <tr key={cn.id} className="border-b border-brand-border last:border-b-0">
                        <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">{cn.creditNumber}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{cn.creditDate || '—'}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{cn.reason || '—'}</td>
                        <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{money(cn.subtotal)}</td>
                        <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(cn.grossTotal)}</td>
                        <td className="px-3.5 py-2.5">
                          <Badge label={CCN_STATUS_LABELS[cn.status] ?? cn.status} variant={CCN_BADGE_VARIANTS[cn.status]} sm />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="m-0 mt-2 text-[11px] text-brand-muted">
              Only posted credit notes reduce a figure. A credit note corrects this invoice; it does not change the
              contract sum and moves no cash.
            </p>
          </div>
        )}

        {/* Reconciliation — derived at read time from the invoice, posted
            credit notes, posted retention releases and posted receipts.
            Nothing below is stored on this invoice document. */}
        {isIssued && reconciliation && (
          <div className="border-t border-brand-border pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2.5">
              <p className="text-[13px] font-bold text-brand-text m-0">Reconciliation</p>
              {/* Client-side wording: a negative balance is "Owed to client"
                  (clientCredit/clientReconciliation.js). */}
              {balanceUnknown
                ? <Unavailable />
                : <span title={owed ? owedToClientDescription(money(-reconciliation.remaining)) : undefined}>
                    <Badge
                      label={clientReconciliationLabel(reconciliation.state)}
                      variant={RECONCILIATION_BADGE_VARIANTS[reconciliation.state]}
                      sm
                    />
                  </span>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
              <DetailRow label="Billed (inc. GST)" value={money(reconciliation.grossTotal)} />
              <DetailRow label="Credited" value={receivableUnknown ? <Unavailable /> : money(reconciliation.credited)} />
              <DetailRow label="Retention Still Held" value={receivableUnknown ? <Unavailable /> : money(reconciliation.retentionHeld)} />
              <DetailRow label="Receivable (before receipts)" value={receivableUnknown ? <Unavailable /> : money(reconciliation.receivableBasis)} />
              <DetailRow label="Received to Date" value={receivedUnknown ? <Unavailable /> : money(reconciliation.received)} />
              <div>
                <p className={labelCls}>{owed ? 'Owed to Client' : 'Remaining to Reconcile'}</p>
                <p className={`m-0 text-[13px] font-semibold ${owed ? 'text-brand-red' : 'text-brand-text'}`}>
                  {balanceUnknown
                    ? <Unavailable />
                    : owed ? money(-reconciliation.remaining) : money(reconciliation.remaining)}
                </p>
              </div>
            </div>

            {owed && (
              <p className="m-0 mt-2.5 text-[12px] text-brand-red">
                {money(-reconciliation.remaining)} is owed to the client: more has been received against this invoice
                than it is now owed. This invoice is not simply settled. {OWED_TO_CLIENT_REMEDY}
              </p>
            )}

            {receivedUnknown ? (
              <p className="m-0 mt-2 text-[12px] text-brand-amber">
                Client Receipts could not be loaded, so the receipts allocated to this invoice are unavailable.
              </p>
            ) : allocatedReceipts.length > 0 ? (
              <div className="overflow-x-auto mt-3">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-brand-card border-y border-brand-border">
                      {['Receipt', 'Receipt Date', 'Method', 'Bank Ref', 'Allocated'].map(h => (
                        <th key={h} className={thCls}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allocatedReceipts.map((r, i) => (
                      <tr key={i} className="border-b border-brand-border last:border-b-0">
                        <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">{r.receiptNumber}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{r.receiptDate || '—'}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{paymentMethodLabel(r.paymentMethod, r.paymentMethodOther)}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{r.bankReference || '—'}</td>
                        <td className="px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap">{money(r.allocatedAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="m-0 mt-2 text-[12px] text-brand-muted">
                No posted receipts have been allocated to this invoice yet.
              </p>
            )}
          </div>
        )}

        {invoice.notes && <DetailRow label="Notes" value={invoice.notes} />}
        {invoice.status === CI_STATUS.VOID && <DetailRow label="Void Reason" value={invoice.voidReason} />}

        <p className="m-0 text-[11px] text-brand-muted border-t border-brand-border pt-3">
          Amounts are ex-GST plus per-line Australian GST, shown in this project&apos;s currency ({currencyCode}).
          Constrap does not produce a compliant Australian Tax Invoice — company legal name, ABN, and address are
          not captured — so issue the tax invoice from your accounting system and record its reference above.
        </p>
      </div>
    </ModalShell>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectClientInvoices() {
  const navigate = useNavigate()
  const { project, projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })

  const { user } = useAuth()
  const { profile, profileLoading } = useProfile()
  const { company } = useCompany()
  // Company-scoped activation of client credit notes and client retention.
  // UX ONLY — Firestore Rules and the backend are the enforcement. A company
  // that is loading or could not be read is null here, so NOT activated.
  const financeActive = clientFinanceActivated(company)

  // ── Printing ONE credit note (the ADR-79 print mechanism) ──────────────────
  // The document is mounted only while a print is in progress — synchronously,
  // see usePrintMoment — and only when a credit note has been chosen: by the
  // row's or the detail's Print button, or because its detail is open when the
  // browser's own Print command is used. With no credit note chosen, printing
  // this page is unchanged. `afterprint` forgets the choice.
  const { printAt, print } = usePrintMoment()
  const [printCreditId, setPrintCreditId] = useState(null)
  const [creditDetailId, setCreditDetailId] = useState(null)
  useEffect(() => {
    const forget = () => setPrintCreditId(null)
    window.addEventListener('afterprint', forget)
    return () => window.removeEventListener('afterprint', forget)
  }, [])
  const printCreditNote = (creditNote) => {
    setPrintCreditId(creditNote.id)
    print()
  }

  const canView = isFinancialRole(profile?.role)
  // Non-financial roles never trigger the commercially-sensitive reads (rules
  // would deny them anyway — this is the UX mirror; rules are the boundary).
  const mid = canView ? projectId : null

  const {
    clientInvoices, clientInvoicesLoading, clientInvoicesError,
    createClientInvoice, updateClientInvoice, issueClientInvoice, voidClientInvoice,
  } = useClientInvoices(mid)
  const { baseline, baselineLoading } = useProjectCommercial(mid)
  const { clientReceipts, clientReceiptsError } = useClientReceipts(mid)
  const {
    clientCreditNotes, clientCreditNotesLoading, clientCreditNotesError,
    createClientCreditNote, updateClientCreditNote, postClientCreditNote, voidClientCreditNote,
  } = useClientCreditNotes(mid)
  const {
    clientRetentionReleases, clientRetentionReleasesLoading, clientRetentionReleasesError,
  } = useClientRetentionReleases(mid)
  const {
    clientInvoiceLedgers, clientInvoiceLedgersLoading, clientInvoiceLedgersError,
  } = useClientInvoiceLedgers(mid)
  const { variations } = useVariations(mid)
  const { contacts } = useContacts()

  const [editing, setEditing] = useState(null)   // invoice | 'new' | null
  const [voiding, setVoiding] = useState(null)
  const [issuing, setIssuing] = useState(null)
  const [detail, setDetail]   = useState(null)
  // Credit-note dialog targets are held as ids and resolved against the live
  // lists, so a dialog always shows the record as it stands now.
  const [crediting, setCrediting] = useState(null) // { invoiceId, creditNoteId? }
  const [postingCreditId, setPostingCreditId] = useState(null)
  const [voidingCreditId, setVoidingCreditId] = useState(null)
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
  // ── The ONE receivable contract (lib/clientReceivables.js) ─────────────────
  // Posted credit notes and posted retention releases, applied to the issued
  // invoices ONCE; every derivation below is handed the same positions, totals
  // and per-variation credits, so no two figures on this page can disagree.
  const ctx = useMemo(
    () => receivableContext(clientInvoices, clientCreditNotes, clientRetentionReleases),
    [clientInvoices, clientCreditNotes, clientRetentionReleases],
  )

  // ⚠️ A FAILED READ IS UNKNOWN, NEVER ZERO.
  //   creditsUnknown    — net Issued, Available to Invoice, Credited and the
  //                       variation balances depend on posted credit notes;
  //   receivableUnknown — retention held and what is receivable also depend on
  //                       posted retention releases;
  //   balanceUnknown    — a remaining balance also depends on posted receipts.
  const creditsUnknown = clientCreditNotesError
  const receivableUnknown = clientCreditNotesError || clientRetentionReleasesError
  const receivedUnknown = clientReceiptsError
  const balanceUnknown = receivableUnknown || receivedUnknown
  // A credit note is prepared and posted against its invoice's CURRENT ledger.
  const creditActionsUnavailable = receivableUnknown || clientInvoiceLedgersError || clientInvoiceLedgersLoading

  const control = useMemo(
    () => contractControl(clientInvoices, contractSum, ctx.totals),
    [clientInvoices, contractSum, ctx.totals],
  )
  // ── Reconciliation, all derived at read time ───────────────────────────────
  // Nothing here is written onto a client invoice document.
  const received = useMemo(() => receivedByInvoice(clientReceipts), [clientReceipts])
  const receivables = useMemo(
    () => receivablesSummary(clientInvoices, clientReceipts, ctx.positions),
    [clientInvoices, clientReceipts, ctx.positions],
  )
  const reconciliationById = useMemo(
    () => new Map(receivables.rows.map(r => [r.id, r])),
    [receivables.rows],
  )
  const exceptions = useMemo(
    () => allocationExceptions(clientReceipts, clientInvoices),
    [clientReceipts, clientInvoices],
  )

  // Ageing now ages the REMAINING balance after posted receipts — fully
  // reconciled invoices drop out, partially reconciled invoices age only their
  // remainder, and invoices with an amount owed to the client (a negative
  // balance) are excluded into `overSettled`.
  const ageing = useMemo(
    () => ageingByDueDate(clientInvoices, received, undefined, ctx.positions),
    [clientInvoices, received, ctx.positions],
  )
  const variationRows = useMemo(
    () => variationInvoicingRows(variations, clientInvoices, ctx.creditedByVariation),
    [variations, clientInvoices, ctx.creditedByVariation],
  )

  const invoiceById = useMemo(() => new Map(clientInvoices.map(inv => [inv.id, inv])), [clientInvoices])
  const ledgerById = useMemo(() => new Map(clientInvoiceLedgers.map(l => [l.id, l])), [clientInvoiceLedgers])
  const owedRows = useMemo(() => receivables.rows.filter(r => r.remaining < 0), [receivables.rows])

  // Issued invoices that carry a posted credit note or a posted retention
  // release. Firestore Rules refuse to void such an invoice (its ledger is not
  // nil), so the Void action is disabled for them — the Rules are the boundary.
  const encumbered = useMemo(
    () => new Set([
      ...postedClientCreditNotes(clientCreditNotes).map(cn => cn.clientInvoiceId),
      ...postedClientRetentionReleases(clientRetentionReleases).map(r => r.clientInvoiceId),
    ]),
    [clientCreditNotes, clientRetentionReleases],
  )

  const creditProblems = useMemo(
    () => (creditsUnknown ? [] : clientCreditExceptions(clientCreditNotes, clientInvoices)),
    [creditsUnknown, clientCreditNotes, clientInvoices],
  )
  const ledgerProblems = useMemo(
    () => (receivableUnknown || clientInvoiceLedgersError || clientInvoiceLedgersLoading
      ? []
      : ledgerExceptions(clientInvoices, clientInvoiceLedgers, clientCreditNotes, clientRetentionReleases)),
    [receivableUnknown, clientInvoiceLedgersError, clientInvoiceLedgersLoading,
      clientInvoices, clientInvoiceLedgers, clientCreditNotes, clientRetentionReleases],
  )
  const sortedCreditNotes = useMemo(
    () => [...clientCreditNotes].sort(
      (a, b) => (b.creditNumber || '').localeCompare(a.creditNumber || ''),
    ),
    [clientCreditNotes],
  )

  const established = isBaselineEstablished(baseline)
  const showTaxNotice = needsTaxLimitationNotice(company?.countryCode)
  const canCreate = established && clientContacts.length > 0

  const clientNames = [...new Set(clientInvoices.map(i => i.clientName).filter(Boolean))].sort()

  const filtered = clientInvoices.filter(inv => {
    if (statusFilter !== 'all' && inv.status !== statusFilter) return false
    if (clientFilter !== 'all' && inv.clientName !== clientFilter) return false
    // Past due AND still owing — a fully reconciled invoice is not past due in
    // any sense that matters, even when its due date has passed.
    // With a balance input unreadable, "still owing" is unknown: the filter is
    // disabled below rather than applied to a balance that may be wrong.
    if (pastDueOnly && !balanceUnknown
      && !isPastDueUnreconciled(inv, reconciliationById.get(inv.id)?.remaining ?? 0)) return false
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
  // Loading is not zero either: credit notes and releases change Issued and
  // every receivable, so no figure renders until both have settled.
  if (baselineLoading || clientInvoicesLoading || clientCreditNotesLoading || clientRetentionReleasesLoading) {
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

  const fig = (unknown, value) => (unknown ? <Unavailable /> : money(value))
  const goToRetention = () => navigate(`/projects/${projectId}/commercial/client-retention`)

  const creditInvoice = crediting ? invoiceById.get(crediting.invoiceId) ?? null : null
  const creditDraft = crediting?.creditNoteId
    ? clientCreditNotes.find(cn => cn.id === crediting.creditNoteId) ?? null
    : null
  const postingCredit = postingCreditId ? clientCreditNotes.find(cn => cn.id === postingCreditId) ?? null : null
  const voidingCredit = voidingCreditId ? clientCreditNotes.find(cn => cn.id === voidingCreditId) ?? null : null
  const remainingOf = (invoiceId) => (balanceUnknown ? null : reconciliationById.get(invoiceId)?.remaining ?? null)

  const creditDetail = creditDetailId ? clientCreditNotes.find(cn => cn.id === creditDetailId) ?? null : null
  const printTargetId = printCreditId ?? creditDetailId
  const printCredit = printAt && printTargetId ? clientCreditNotes.find(cn => cn.id === printTargetId) ?? null : null
  // A credit note stores only the uid of who posted it. The signed-in user's
  // own name is the one name this page can vouch for; anyone else's is stated
  // as not recorded rather than guessed.
  const people = user?.uid && profile?.name ? { [user.uid]: profile.name } : null

  // "Refresh figures": the same lines and details, re-saved against the
  // invoice's current ledger.
  const refreshCreditNote = (cn) => updateClientCreditNote(cn, {
    creditDate: cn.creditDate,
    reason: cn.reason,
    clientCreditReference: cn.clientCreditReference || '',
    notes: cn.notes || '',
    rows: (cn.lineItems ?? []).map(li => ({ invoiceLineIndex: li.invoiceLineIndex, amount: li.amount })),
  })

  return (
    <>
    {/* The printed credit note: mounted only while printing, never shown on
        screen. Everything else on the page is hidden in that print. */}
    {printCredit && (
      <ClientCreditNotePrint
        creditNote={printCredit}
        invoice={invoiceById.get(printCredit.clientInvoiceId) ?? null}
        projectName={project?.name ?? ''}
        currencyCode={currencyCode}
        people={people}
        generatedAt={printAt}
      />
    )}
    <div data-print-hide>
      {/* ── Unavailability, honestly ───────────────────────────────────────── */}
      {/* The ledgers serve credit notes only, so a failed ledger read is said
          only to a company that can record them. */}
      {(receivableUnknown || receivedUnknown || (clientInvoiceLedgersError && financeActive)) && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-red m-0">Some receivable figures are unavailable</p>
          <ul className="m-0 mt-2 pl-4 text-[12px] text-brand-muted list-disc space-y-1">
            {clientCreditNotesError && <li>{CLIENT_CREDIT_READ_UNAVAILABLE_NOTICE}</li>}
            {clientRetentionReleasesError && <li>{CLIENT_RETENTION_READ_UNAVAILABLE_NOTICE}</li>}
            {clientReceiptsError && (
              <li>
                Client Receipts could not be loaded, so Received to Date and every remaining balance are shown as
                Unavailable rather than as though nothing had been received.
              </li>
            )}
            {clientInvoiceLedgersError && financeActive && (
              <li>
                The invoice ledgers could not be loaded. A credit note is prepared and posted against its
                invoice&apos;s current ledger, so recording, editing and posting credit notes are disabled.
              </li>
            )}
          </ul>
        </Card>
      )}

      {/* ── Contract control ───────────────────────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3.5">
          <Metric label="Current Contract Sum" value={money(control.currentContractSum)} help="Ex-GST · original + approved client variations" />
          <Metric
            label="Issued Client Invoices"
            value={fig(creditsUnknown, control.issued.subtotal)}
            help={`Ex-GST · ${control.issued.count} issued · net of posted credit notes`}
          />
          <Metric
            label="Credited"
            value={fig(creditsUnknown, control.credited.subtotal)}
            help="Ex-GST · posted credit notes · re-opened under Available to Invoice"
          />
          <Metric
            label="Available to Invoice"
            value={fig(creditsUnknown, control.availableToInvoice)}
            help="Unbilled contract value (ex-GST)"
            danger={!creditsUnknown && control.availableToInvoice < 0}
          />
          <Metric label="Issued (inc. GST)" value={fig(creditsUnknown, control.issued.grossTotal)} help="Billed, net of posted credit notes" />
          <Metric label="Draft Client Invoices" value={money(control.drafts.subtotal)} help={`Ex-GST · ${control.drafts.count} draft · not counted above`} />
          <Metric label="Pending Client Variation Exposure" value={money(pendingClientExposure)} help="Not invoiceable · not in the contract sum" />
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          All contract figures are ex-GST and derived at read time — nothing is written back to the commercial
          baseline or to variations. Retention a client withholds is still billed, so it stays inside Issued; a
          posted credit note is an invoice correction, so it leaves Issued and never changes the Current Contract Sum.
          Over-invoicing is <span className="font-semibold">warned, never blocked</span>,
          and the limit cannot be enforced by Firestore rules (they cannot sum sibling documents), so two users can
          invoice the same remaining value at the same time.
        </p>
      </Card>

      {/* ── Accounts receivable ────────────────────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2.5">
          <p className="text-[13px] font-bold text-brand-text m-0">Accounts Receivable — ageing by due date</p>
          <p className="m-0 text-[11px] text-brand-muted">Gross (inc. GST) · after credit notes, retention held and posted receipts</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <Metric
            label="Receivable"
            value={fig(receivableUnknown, receivables.receivable)}
            help="Billed, less credit notes and retention held — before receipts"
          />
          <Metric
            label="Client Retention Held"
            value={fig(receivableUnknown, ctx.totals.retentionHeld)}
            help="Billed, not receivable until released"
          />
          <Metric label="Received to Date" value={fig(receivedUnknown, receivables.received)} help="Posted receipts allocated to invoices" />
          <Metric label="Remaining to Reconcile" value={fig(balanceUnknown, ageing.total)} help="Issued invoices still owing" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5 mt-3.5">
          {AGEING_BUCKETS.map(b => (
            <Metric
              key={b.key}
              label={b.label}
              value={fig(balanceUnknown, ageing.buckets[b.key].amount)}
              help={balanceUnknown
                ? 'Unavailable'
                : `${ageing.buckets[b.key].count} invoice${ageing.buckets[b.key].count === 1 ? '' : 's'}`}
              danger={!balanceUnknown && (b.key === 'd61_90' || b.key === 'd90plus')}
            />
          ))}
        </div>

        {/* A negative balance is an amount OWED TO THE CLIENT — never clamped
            to zero, never shown as a settled invoice, never netted off what
            other invoices owe. */}
        {!balanceUnknown && owedRows.length > 0 && (
          <div className="mt-3 pt-3 border-t border-brand-border">
            <p className="m-0 text-[12px] font-bold text-brand-red">
              Owed to client — {money(receivables.owedToClient)}
            </p>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              More has been received against these invoices than they are now owed — a credit note or a voided
              retention release after the money arrived, or an over-allocated receipt. The amounts are owed to the
              client: they are kept out of the ageing buckets above so they cannot offset genuine arrears, and the
              invoices are not treated as settled. Constrap records no refund — the remedy is to void the receipt
              and re-record it with the surplus unallocated.
            </p>
            <div className="flex flex-wrap gap-3 mt-2">
              {owedRows.map(r => (
                <span key={r.id} className="text-[12px] text-brand-text">
                  <span className="font-semibold">{r.invoiceNumber}</span>{' '}
                  <span className="text-brand-red font-semibold">Owed to client {money(-r.remaining)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <p className="m-0 mt-3 text-[11px] text-brand-muted">{AR_RECONCILIATION_NOTICE}</p>
        <p className="m-0 mt-1 text-[11px] text-brand-muted">{CLIENT_RETENTION_HELD_NOTICE}</p>
      </Card>

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

      {/* ── Credit note exceptions ─────────────────────────────────────────── */}
      {creditProblems.length > 0 && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">Credit note exceptions</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">{CLIENT_CREDIT_EXCEPTION_REMEDY}</p>
          <div className="flex flex-col gap-1 mt-2.5">
            {creditProblems.map(x => (
              <p key={x.creditNoteId} className="m-0 text-[12px] text-brand-text">
                <span className="font-semibold">{x.creditNumber}</span> → {x.invoiceNumber} ({money(x.grossTotal)}) — {x.reason}
              </p>
            ))}
          </div>
        </Card>
      )}

      {/* ── Ledger exceptions ──────────────────────────────────────────────── */}
      {ledgerProblems.length > 0 && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-red m-0">Invoice ledger exceptions</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            This cannot arise through Constrap — it means a record was changed outside the app. The figures on this
            page still follow the posted credit notes and retention releases themselves; new postings against these
            invoices may be refused until it is investigated.
          </p>
          <div className="flex flex-col gap-1 mt-2.5">
            {ledgerProblems.map(x => (
              <p key={x.invoiceId} className="m-0 text-[12px] text-brand-text">{x.reason}</p>
            ))}
          </div>
        </Card>
      )}

      {/* ── Variation invoicing ────────────────────────────────────────────── */}
      {variationRows.length > 0 && (
        <Card className="mb-3.5" padding={false}>
          <div className="px-5 pt-4 pb-2">
            <p className="text-[13px] font-bold text-brand-text m-0">Approved client variations</p>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Ex-GST, derived at read time from issued invoices net of posted credit notes. Variation documents are
              never modified by invoicing. Negative (credit) variations reduce the Current Contract Sum but cannot
              be invoiced — and a Client Credit Note is not how they are billed: it corrects an issued invoice only.
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
                    <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">{fig(creditsUnknown, r.invoiced)}</td>
                    <td className={`px-3.5 py-2.5 text-[13px] font-semibold whitespace-nowrap ${!creditsUnknown && r.remaining < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
                      {fig(creditsUnknown, r.remaining)}
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
            aria-label="Search client invoices"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className={`${inputCls} max-w-[170px]`} aria-label="Filter by status"
            value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            {[CI_STATUS.DRAFT, CI_STATUS.ISSUED, CI_STATUS.VOID].map(s => (
              <option key={s} value={s}>{CI_STATUS_LABELS[s]}</option>
            ))}
          </select>
          {clientNames.length > 0 && (
            <select
              className={`${inputCls} max-w-[220px]`} aria-label="Filter by client"
              value={clientFilter} onChange={e => setClientFilter(e.target.value)}
            >
              <option value="all">All clients</option>
              {clientNames.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}
          <Btn
            sm variant={pastDueOnly && !balanceUnknown ? 'success' : 'ghost'}
            disabled={balanceUnknown}
            title={balanceUnknown ? 'Unavailable — remaining balances could not be loaded' : undefined}
            onClick={() => setPastDueOnly(v => !v)}
          >
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
                  {['CI #', 'Client', 'Client Ref', 'Invoice Date', 'Due', 'Ex-GST', 'Billed (inc. GST)', 'Receivable', 'Received', 'Remaining', 'Reconciliation', 'Status'].map(h => (
                    <th key={h} className={thCls}>{h}</th>
                  ))}
                  <th className={thCls}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(inv => {
                  const recon = reconciliationById.get(inv.id) ?? null
                  const isIssued = inv.status === CI_STATUS.ISSUED
                  const pastDue = !balanceUnknown && isPastDueUnreconciled(inv, recon?.remaining ?? 0)
                  const days = pastDue ? daysPastDue(inv.dueDate) : null
                  const owed = !balanceUnknown && recon && recon.remaining < 0
                  const voidRefused = isIssued && encumbered.has(inv.id)
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
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{inv.invoiceDate || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] whitespace-nowrap">
                        {inv.dueDate
                          ? <span className={pastDue ? 'text-brand-red font-semibold' : 'text-brand-muted'}>
                              {inv.dueDate}{pastDue ? ` • Past due ${days}d` : ''}
                            </span>
                          : <span className="text-brand-muted">—</span>}
                      </td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-text whitespace-nowrap">{money(inv.subtotal)}</td>
                      {/* What was BILLED never changes. Credits and retention
                          are stated beneath it rather than netted into it, so
                          the row stays readable without two more columns. */}
                      <td className="px-3.5 py-3 text-[13px] whitespace-nowrap">
                        <span className="font-semibold text-brand-text">{money(inv.grossTotal)}</span>
                        {isIssued && recon && (receivableUnknown ? (
                          <span className="block text-[11px] text-brand-muted">Credited / retention held unavailable</span>
                        ) : (
                          <>
                            {recon.credited > 0 && (
                              <span className="block text-[11px] text-brand-muted">Credited {money(recon.credited)}</span>
                            )}
                            {recon.retentionHeld > 0 && (
                              <span className="block text-[11px] text-brand-muted">Retention held {money(recon.retentionHeld)}</span>
                            )}
                          </>
                        ))}
                        {inv.status === CI_STATUS.DRAFT && hasRetention(inv) && (
                          <span className="block text-[11px] text-brand-muted">Retention to withhold {money(inv.retentionTotal)}</span>
                        )}
                      </td>
                      {/* Receivable / Received / Remaining / Reconciliation are
                          DERIVED on every render — never stored here. */}
                      <td className="px-3.5 py-3 text-[13px] text-brand-text whitespace-nowrap">
                        {recon ? fig(receivableUnknown, recon.receivableBasis) : '—'}
                      </td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">
                        {recon ? fig(receivedUnknown, recon.received) : '—'}
                      </td>
                      <td className="px-3.5 py-3 text-[13px] font-semibold whitespace-nowrap">
                        {!recon
                          ? <span className="text-brand-muted">—</span>
                          : balanceUnknown
                            ? <Unavailable />
                            : owed
                              ? <span className="text-brand-red">Owed to client {money(-recon.remaining)}</span>
                              : <span className="text-brand-text">{money(recon.remaining)}</span>}
                      </td>
                      <td className="px-3.5 py-3">
                        {!recon
                          ? <span className="text-[12px] text-brand-muted">—</span>
                          : balanceUnknown
                            ? <Unavailable />
                            : <span title={owed ? owedToClientDescription(money(-recon.remaining)) : undefined}>
                                <Badge
                                  label={clientReconciliationLabel(recon.state)}
                                  variant={RECONCILIATION_BADGE_VARIANTS[recon.state]}
                                  sm
                                />
                              </span>}
                      </td>
                      <td className="px-3.5 py-3">
                        <Badge label={CI_STATUS_LABELS[inv.status] ?? inv.status} variant={CI_BADGE_VARIANTS[inv.status]} sm />
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex gap-1.5 justify-end">
                          {inv.status === CI_STATUS.DRAFT && (
                            <>
                              <Btn sm variant="ghost" onClick={() => setEditing(inv)}>Edit</Btn>
                              <Btn sm variant="success" onClick={() => setIssuing(inv)}>Issue</Btn>
                            </>
                          )}
                          {isIssued && financeActive && (
                            <Btn
                              sm variant="ghost"
                              disabled={creditActionsUnavailable}
                              title={creditActionsUnavailable
                                ? 'Unavailable — the records a credit note is prepared from could not be loaded'
                                : 'Record a credit note correcting this invoice'}
                              onClick={() => setCrediting({ invoiceId: inv.id })}
                            >
                              Record credit note
                            </Btn>
                          )}
                          {isIssued && financeActive && hasRetention(inv) && (
                            <Btn sm variant="ghost" title="Open the Client Retention register" onClick={goToRetention}>
                              Client retention
                            </Btn>
                          )}
                          {(inv.status === CI_STATUS.DRAFT || isIssued) && (
                            <Btn
                              sm variant="ghost"
                              disabled={voidRefused}
                              title={voidRefused
                                ? 'This invoice has a posted credit note or a posted retention release, so it cannot be voided. Void those first.'
                                : undefined}
                              onClick={() => setVoiding(inv)}
                            >
                              Void
                            </Btn>
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

      {/* ── Client credit notes ────────────────────────────────────────────── */}
      {/* A company not activated for client credit notes sees this register
          only when it holds a record (or the read failed, which is said) —
          existing records are never hidden. */}
      {(clientCreditNotesError || showClientFinanceRecords(financeActive, sortedCreditNotes.length)) && (
      <Card padding={false} className="mt-3.5">
        <div className="px-5 py-4 border-b border-brand-border">
          <h2 className="text-[14px] font-bold text-brand-text m-0">Client credit notes</h2>
          <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
            {financeActive
              ? 'Corrections against issued client invoices. Start one with “Record credit note” on an issued invoice above. A draft changes nothing until it is posted.'
              : `Corrections against issued client invoices. ${CLIENT_FINANCE_NOT_ACTIVATED_TEXT}`}
          </p>
        </div>
        {clientCreditNotesError ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">Unavailable — client credit notes could not be loaded.</p>
        ) : sortedCreditNotes.length === 0 ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">No client credit notes have been recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['CCN #', 'Credit Date', 'Invoice', 'Reason', 'Total (inc. GST)', 'Status'].map(h => (
                    <th key={h} className={thCls}>{h}</th>
                  ))}
                  <th className={thCls}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {sortedCreditNotes.map(cn => {
                  const isDraft = cn.status === CCN_STATUS.DRAFT
                  const isPosted = cn.status === CCN_STATUS.POSTED
                  return (
                    <tr key={cn.id} className="border-b border-brand-border last:border-b-0 hover:bg-brand-card transition-colors">
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setCreditDetailId(cn.id)}
                          className="text-brand-accent hover:underline cursor-pointer"
                        >
                          {cn.creditNumber}
                        </button>
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{cn.creditDate || '—'}</td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-text whitespace-nowrap">
                        {cn.invoiceNumber || '—'}
                        {cn.clientCreditReference && (
                          <span className="block text-[11px] text-brand-muted">{cn.clientCreditReference}</span>
                        )}
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted max-w-[280px]">
                        {cn.reason || '—'}
                        {cn.status === CCN_STATUS.VOID && cn.voidReason && (
                          <span className="block text-[11px]">Voided: {cn.voidReason}</span>
                        )}
                      </td>
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{money(cn.grossTotal)}</td>
                      <td className="px-3.5 py-3">
                        <Badge label={CCN_STATUS_LABELS[cn.status] ?? cn.status} variant={CCN_BADGE_VARIANTS[cn.status]} sm />
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex gap-1.5 justify-end">
                          <Btn
                            sm variant="ghost"
                            title={`Print ${cn.creditNumber} or save it as a PDF`}
                            onClick={() => printCreditNote(cn)}
                          >
                            Print
                          </Btn>
                          {isDraft && financeActive && (
                            <>
                              <Btn
                                sm variant="ghost"
                                disabled={creditActionsUnavailable || !invoiceById.has(cn.clientInvoiceId)}
                                title={creditActionsUnavailable
                                  ? 'Unavailable — the records a credit note is prepared from could not be loaded'
                                  : undefined}
                                onClick={() => setCrediting({ invoiceId: cn.clientInvoiceId, creditNoteId: cn.id })}
                              >
                                Edit
                              </Btn>
                              <Btn
                                sm variant="success"
                                disabled={receivableUnknown}
                                title="Apply this credit to the invoice"
                                onClick={() => setPostingCreditId(cn.id)}
                              >
                                Post
                              </Btn>
                            </>
                          )}
                          {(isDraft || isPosted) && (
                            <Btn sm variant="ghost" onClick={() => setVoidingCreditId(cn.id)}>Void</Btn>
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
        <div className="px-5 py-4 border-t border-brand-border">
          <p className="m-0 text-[11.5px] text-brand-muted">{CLIENT_CREDIT_NOTE_NOTICE}</p>
        </div>
      </Card>
      )}

      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        Constrap records what has been invoiced and what has been received against it. It does
        {' '}<span className="font-semibold">not</span> yet produce a compliant Australian Tax Invoice — company legal
        name, ABN, and address are not captured — so issue the tax invoice from your accounting system and record its
        reference on each invoice. GST is a flat Australian 10% regardless of the project&apos;s currency. Received
        and remaining balances come from posted receipts on the
        {' '}<button
          type="button"
          onClick={() => navigate(`/projects/${projectId}/commercial/receipts`)}
          className="text-brand-accent hover:underline cursor-pointer"
        >
          Receipts
        </button>{' '}
        view and are never written onto an invoice.
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
          availableNow={control.availableToInvoice}
          creditedByVariation={ctx.creditedByVariation}
          creditsUnknown={creditsUnknown}
          currencyCode={currencyCode}
          showTaxNotice={showTaxNotice}
          financeActive={financeActive}
          onClose={() => setEditing(null)}
          onSave={editing === 'new'
            ? createClientInvoice
            : (data) => updateClientInvoice(editing, data)}
        />
      )}

      {voiding && (
        <VoidModal invoice={voiding} onClose={() => setVoiding(null)} onConfirm={voidClientInvoice} />
      )}

      {issuing && invoiceById.has(issuing.id) && (
        <IssueModal
          invoice={invoiceById.get(issuing.id)}
          currencyCode={currencyCode}
          onClose={() => setIssuing(null)}
          onConfirm={issueClientInvoice}
        />
      )}

      {detail && (
        <DetailModal
          invoice={detail}
          reconciliation={reconciliationById.get(detail.id) ?? null}
          position={ctx.positions[detail.id] ?? null}
          allocatedReceipts={receiptsForInvoice(clientReceipts, detail.id)}
          creditNotes={creditNotesForInvoice(clientCreditNotes, detail.id)}
          releases={clientRetentionReleases.filter(r => r.clientInvoiceId === detail.id)}
          creditsUnknown={creditsUnknown}
          receivableUnknown={receivableUnknown}
          receivedUnknown={receivedUnknown}
          currencyCode={currencyCode}
          financeActive={financeActive}
          onClose={() => setDetail(null)}
          onOpenRetention={goToRetention}
        />
      )}

      {crediting && creditInvoice && (
        <ClientCreditNoteModal
          key={`${crediting.invoiceId}/${crediting.creditNoteId ?? 'new'}`}
          invoice={creditInvoice}
          creditNote={creditDraft}
          ledgerDoc={ledgerById.get(creditInvoice.id) ?? null}
          remaining={remainingOf(creditInvoice.id)}
          currencyCode={currencyCode}
          onClose={() => setCrediting(null)}
          onSave={creditDraft
            ? (input) => updateClientCreditNote(creditDraft, input)
            : createClientCreditNote}
        />
      )}

      {postingCredit && (
        <ClientCreditPostModal
          creditNote={postingCredit}
          invoice={invoiceById.get(postingCredit.clientInvoiceId) ?? null}
          ledgerDoc={ledgerById.get(postingCredit.clientInvoiceId) ?? null}
          ledgerUnavailable={clientInvoiceLedgersError || clientInvoiceLedgersLoading}
          remaining={remainingOf(postingCredit.clientInvoiceId)}
          currencyCode={currencyCode}
          onClose={() => setPostingCreditId(null)}
          onConfirm={postClientCreditNote}
          onRefresh={refreshCreditNote}
        />
      )}

      {voidingCredit && (
        <ClientCreditVoidModal
          creditNote={voidingCredit}
          currencyCode={currencyCode}
          onClose={() => setVoidingCreditId(null)}
          onConfirm={voidClientCreditNote}
        />
      )}

      {creditDetail && (
        <ClientCreditDetailModal
          creditNote={creditDetail}
          invoice={invoiceById.get(creditDetail.clientInvoiceId) ?? null}
          currencyCode={currencyCode}
          people={people}
          onClose={() => setCreditDetailId(null)}
          onPrint={() => printCreditNote(creditDetail)}
        />
      )}
    </div>
    </>
  )
}
