import { useState, useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency } from '../../lib/formatters'
import { useVariations } from '../../hooks/useVariations'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useContacts } from '../../hooks/useContacts'
import { useCostCodes } from '../../hooks/useCostCodes'
import { selectableCostCodes } from '../../lib/costCodes'
import { useRfis } from '../../hooks/useRfis'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useForecastLines } from '../../hooks/useForecastLines'
import { PO_STATUS_LABELS } from '../../lib/purchaseOrders'
import { commitmentEffectPreview, PO_LINK_STATE } from '../../lib/variationCommitment'
import { CONTACT_TYPE, PO_SUPPLIER_TYPES } from '../../lib/contacts'
import {
  VARIATION_TYPE, VARIATION_TYPE_LABELS, VARIATION_TYPE_HELP,
  VARIATION_STATUS, VARIATION_STATUS_LABELS, VARIATION_BADGE_VARIANTS,
  VARIATION_PO_STATUSES, VARIATION_PENDING_STATUSES,
  TAX_CODES, TAX_CODE_LABELS,
  VARIATION_REASON, VARIATION_REASON_LABELS,
  variationTotals, buildApprovedLineItems,
  approvalNeedsNotes, validateApprovedAmounts, duplicateVariationWarnings,
  approvedSupplierVariationsTotal, pendingSupplierVariationExposureTotal,
  approvedClientVariationsTotal, pendingClientVariationExposureTotal,
  openVariationCount,
  eligibleOriginRfis, normaliseOriginRfi, originRfiLabel, hasOriginRfi,
  EMPTY_VARIATION_FORM_LINE, variationLineToForm, buildVariationLineItem, validateVariationDraft,
  INCORPORATION_STATE, INCORPORATION_STATE_LABELS, INCORPORATION_STATE_HELP, variationIncorporation, commitmentApplyEligibility,
  appliedSupplierVariationsTotal, unappliedSupplierVariationsTotal,
  COMMITMENT_LINE_ISSUE_LABELS,
} from '../../lib/variations'
import { VariationWriteError } from '../../lib/variationActions'

// A guarded refusal (stale copy, invalid content, permission, offline —
// ADR-59) carries its reason; anything else keeps the generic text.
const writeErrorMessage = (err, fallback) =>
  (err instanceof VariationWriteError && err.message ? err.message : fallback)

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

const pad2 = (n) => String(n).padStart(2, '0')
function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const EMPTY_LINE = EMPTY_VARIATION_FORM_LINE

function TaxSelect({ value, onChange, disabled }) {
  return (
    <select className={inputCls} value={value} onChange={onChange} disabled={disabled}>
      {TAX_CODES.map(tc => (
        <option key={tc} value={tc}>{TAX_CODE_LABELS[tc]}</option>
      ))}
    </select>
  )
}

function SummaryCards({ variations, purchaseOrders, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)

  // Approved supplier variations (gross) = applied (inside Committed) +
  // unapplied (exposure) — ADR-62. Shown as the two parts, never both ways.
  const cards = [
    { label: 'Applied Supplier Variations',   value: appliedSupplierVariationsTotal(variations, purchaseOrders), help: 'inside Committed' },
    { label: 'Unapplied Supplier Exposure',   value: unappliedSupplierVariationsTotal(variations, purchaseOrders), help: `of ${money(approvedSupplierVariationsTotal(variations))} approved` },
    { label: 'Pending Supplier Exposure',     value: pendingSupplierVariationExposureTotal(variations) },
    { label: 'Approved Client Variations',    value: approvedClientVariationsTotal(variations) },
    { label: 'Pending Client Exposure',       value: pendingClientVariationExposureTotal(variations) },
  ]
  return (
    <Card className="mb-3.5">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
        {cards.map(c => (
          <div key={c.label}>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">{c.label}</p>
            <p className="text-lg font-bold text-brand-text">{money(c.value)}</p>
            {c.help && <p className="m-0 text-[11px] text-brand-muted">{c.help}</p>}
          </div>
        ))}
        <div>
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Open Variations</p>
          <p className="text-lg font-bold text-brand-text">{openVariationCount(variations)}</p>
        </div>
      </div>
      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        All figures are ex-GST and derived at read time. Only approved variations count. An approved supplier
        variation APPLIED to its purchase order adjusts that PO's Committed figure and is matured by the same claims and
        invoices; positive new-scope lines whose scope is COMMITTED are committed, claimable lines in their own right.
        Unapplied amounts (legacy approvals not yet applied, new scope not yet committed, negative new scope) are exposure only.
      </p>
    </Card>
  )
}

// ── Editor (create + edit draft — ADR-35) ────────────────────────────────────
// ONE editor for both modes. CREATE (`variation` null) chooses the type and the
// counterparty; EDIT DRAFT (`variation` = the LIVE draft document) renders the
// type, counterparty and PO context read-only from the stored snapshots — the
// original contact or PO need not still be active or selectable — and lets the
// user correct the authored content: title, reason, description, reference,
// dates, line items and the originating RFI. Approved values, totals on the
// approved side, status, stamps and identity are never touched. Line mapping
// and validation are the shared pure helpers in lib/variations.js.

function VariationEditorModal({ variation = null, variations, purchaseOrders, contacts, costCodes, eligibleRfis, currencyCode, onClose, onSave }) {
  const money  = (n) => formatCurrency(n, currencyCode)
  const isEdit = !!variation

  const [variationType, setVariationType] = useState(variation?.variationType ?? '')
  const [originRfiId, setOriginRfiId] = useState(variation?.originRfiId ?? '') // '' = none — evidence link only (ADR-34)
  const [title, setTitle]             = useState(variation?.title ?? '')
  const [description, setDescription] = useState(variation?.description ?? '')
  const [reason, setReason]           = useState(variation?.reason ?? '')
  const [clientId, setClientId]       = useState('')
  const [clientRef, setClientRef]     = useState(variation?.clientRef ?? '')
  const [supplierMode, setSupplierMode] = useState(isEdit ? (variation.poId ? 'po' : 'manual') : 'po') // 'po' | 'manual'
  const [poId, setPoId]               = useState('')
  const [supplierId, setSupplierId]   = useState('')
  const [supplierRef, setSupplierRef] = useState(variation?.supplierRef ?? '')
  const [identifiedDate, setIdentifiedDate]   = useState(isEdit ? (variation.identifiedDate || '') : todayIso())
  const [submittedDate]                       = useState('') // set on the submit transition, not at create
  const [responseDueDate, setResponseDueDate] = useState(variation?.responseDueDate ?? '')
  const [effectiveDate, setEffectiveDate]     = useState(variation?.effectiveDate ?? '')
  const [notes]                               = useState('') // create only — on edit the stored notes pass through untouched
  const [lines, setLines]             = useState(() =>
    isEdit && (variation.lineItems ?? []).length > 0
      ? variation.lineItems.map(variationLineToForm)
      : [{ ...EMPTY_LINE }]
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const isClient   = variationType === VARIATION_TYPE.CLIENT
  const isSupplier = variationType === VARIATION_TYPE.SUPPLIER

  const clients = contacts.filter(c =>
    c.isActive !== false && (c.contactTypes ?? []).includes(CONTACT_TYPE.CLIENT)
  )
  const suppliers = contacts.filter(c =>
    c.isActive !== false && (c.contactTypes ?? []).some(t => PO_SUPPLIER_TYPES.includes(t))
  )
  const selectablePOs = purchaseOrders.filter(po => VARIATION_PO_STATUSES.includes(po.status))

  const selectedClient   = clients.find(c => c.id === clientId) ?? null
  const selectedSupplier = suppliers.find(c => c.id === supplierId) ?? null
  // On edit the PO is the stored one, resolved from ALL project POs — its
  // status may have moved since the draft was raised, and the draft must still
  // render and edit from its original commercial context. The PO is never
  // modified.
  const po = isEdit
    ? (isSupplier && variation.poId ? (purchaseOrders.find(p => p.id === variation.poId) ?? null) : null)
    : (isSupplier && supplierMode === 'po' ? (selectablePOs.find(p => p.id === poId) ?? null) : null)
  const poMissing = isEdit && isSupplier && !!variation.poId && !po

  // Supplier identity is locked from the PO snapshot when a PO is selected; on
  // edit it is the stored snapshot, full stop.
  const supplierName = isEdit
    ? (variation.supplierName ?? '')
    : isSupplier
      ? (supplierMode === 'po' ? (po ? po.supplierName : '') : (selectedSupplier?.displayName ?? ''))
      : ''
  const resolvedSupplierId = isEdit
    ? (variation.supplierId ?? null)
    : isSupplier
      ? (supplierMode === 'po' ? (po?.supplierId ?? null) : (selectedSupplier?.id ?? null))
      : null

  const usesPoLines = isSupplier && supplierMode === 'po' && !!po

  // Historical link (ADR-34/35): a stored RFI that is no longer eligible
  // (cancelled since) is still shown so an untouched save PRESERVES it — it is
  // never silently turned into null. It cannot be chosen as a NEW link.
  const historicalOriginRfi = isEdit && hasOriginRfi(variation) && !eligibleRfis.some(r => r.id === variation.originRfiId)
    ? variation
    : null

  // Live-status guard: the page passes the LIVE document, so if it left draft
  // while this editor was open the form goes read-only and the save is refused.
  const stale = isEdit && variation.status !== VARIATION_STATUS.DRAFT

  const setLine = (idx, key) => (e) => {
    const value = e.target.value
    setLines(ls => ls.map((l, i) => (i === idx ? { ...l, [key]: value } : l)))
  }
  const selectPoLine = (idx) => (e) => {
    const value = e.target.value
    setLines(ls => ls.map((l, i) => {
      if (i !== idx) return l
      const next = { ...l, poLineIndex: value }
      if (value !== '' && po) {
        const pl = (po.lineItems ?? [])[Number(value)]
        if (pl && !l.description.trim()) next.description = pl.description || ''
        next.costCodeId = '' // cost code is inherited from the PO line, not chosen
      }
      return next
    }))
  }
  const addLine    = () => setLines(ls => [...ls, { ...EMPTY_LINE }])
  const removeLine = (idx) => setLines(ls => ls.filter((_, i) => i !== idx))

  const builtLines = lines.map(l => buildVariationLineItem(l, { po: usesPoLines ? po : null, costCodes }))
  // NEW authoring offers ACTIVE cost codes only (ADR-39/55); a code this draft
  // already carries stays selectable. Line building still reads the FULL library.
  const pickerCostCodes = selectableCostCodes(costCodes, lines.map(l => l.costCodeId))
  const totals     = variationTotals(builtLines, 'submitted')
  const draftError = validateVariationDraft({ title, lineItems: builtLines })

  const counterpartyValid = isEdit ? true :
    isClient ? !!clientId :
    isSupplier ? (supplierMode === 'po' ? !!po : !!selectedSupplier) :
    false

  const valid = !!variationType && !draftError && counterpartyValid && !poMissing && !stale

  const dupWarnings = variationType
    ? duplicateVariationWarnings(variations, isClient
        ? { id: variation?.id ?? null, variationType, clientId: isEdit ? variation.clientId : clientId, clientName: isEdit ? variation.clientName : selectedClient?.displayName, clientRef }
        : { id: variation?.id ?? null, variationType, supplierId: resolvedSupplierId, supplierName, supplierRef, poId: po ? po.id : null })
    : []

  const chooseType = (t) => () => {
    setVariationType(t)
    setLines([{ ...EMPTY_LINE }])
    setError(null)
  }

  // The originating RFI to send. Create: the chosen eligible RFI or null.
  // Edit: undefined when the selection is UNCHANGED (the hook then leaves the
  // stored triple alone — including a historical, no-longer-eligible link),
  // null to remove, or the newly chosen eligible RFI.
  function originRfiPayload() {
    if (!isEdit) return eligibleRfis.find(r => r.id === originRfiId) ?? null
    if (originRfiId === (variation.originRfiId ?? '')) return undefined
    if (originRfiId === '') return null
    const rfi = eligibleRfis.find(r => r.id === originRfiId)
    if (!rfi) throw new Error('The selected RFI is no longer eligible. Choose another RFI or None.')
    return rfi
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      if (isEdit) {
        await onSave({
          title, description, reason,
          clientRef:   isClient ? clientRef : null,
          supplierRef: isSupplier ? supplierRef : null,
          identifiedDate, responseDueDate, effectiveDate,
          lineItems: builtLines,
          // notes deliberately omitted — the stored value passes through
          originRfi: originRfiPayload(),
        })
      } else {
        await onSave({
          variationType,
          title, description, reason,
          clientId:   isClient ? clientId : null,
          clientName: isClient ? (selectedClient?.displayName ?? '') : null,
          clientRef:  isClient ? clientRef : null,
          supplierId:   isSupplier ? resolvedSupplierId : null,
          supplierName: isSupplier ? supplierName : null,
          supplierRef:  isSupplier ? supplierRef : null,
          poId:     po ? po.id : null,
          poNumber: po ? po.poNumber : null,
          identifiedDate, submittedDate, responseDueDate, effectiveDate,
          lineItems: builtLines,
          notes,
          originRfi: originRfiPayload(),
        })
      }
      onClose()
    } catch (err) {
      // A guarded refusal keeps the editor open with every entry intact and
      // names the reason (e.g. the draft was submitted or edited underneath).
      setError(err instanceof VariationWriteError
        ? err.message
        : (err?.message || 'Failed to save. Check your connection and try again.'))
      setSaving(false)
    }
  }

  const infoCls = 'm-0 text-[13px] text-brand-text'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[820px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">{isEdit ? `Edit ${variation.variationNumber}` : 'New Variation'}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          {stale && (
            <p className="m-0 text-[12px] text-brand-red">
              This variation is no longer Draft. Close the editor and review the latest version.
            </p>
          )}

          {isEdit ? (
            /* Immutable context — read-only information, not disabled controls. */
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg border border-brand-border bg-brand-bg px-3.5 py-3">
              <div>
                <p className={labelCls}>Variation Type</p>
                <p className={infoCls}>{VARIATION_TYPE_LABELS[variationType]}</p>
                <p className="m-0 text-[11px] text-brand-muted">{VARIATION_TYPE_HELP[variationType]}</p>
              </div>
              <div>
                <p className={labelCls}>{isClient ? 'Client' : 'Supplier / Subcontractor'}</p>
                <p className={infoCls}>{(isClient ? variation.clientName : variation.supplierName) || '—'}</p>
              </div>
              {isSupplier && (
                <div>
                  <p className={labelCls}>Purchase Order</p>
                  <p className={infoCls}>{variation.poNumber || 'No PO (manual)'}</p>
                  {poMissing && <p className="m-0 text-[11px] text-brand-red">The PO could not be loaded — lines cannot be resolved.</p>}
                </div>
              )}
              <p className="m-0 sm:col-span-3 text-[11px] text-brand-muted">
                Type, counterparty and PO are fixed once a variation is raised. If they are wrong, withdraw and recreate.
              </p>
            </div>
          ) : (
            /* Type selector — choose first, then render only relevant fields */
            <div>
              <label className={labelCls}>Variation Type <span className="text-brand-red">*</span></label>
              <div className="flex flex-wrap gap-2">
                {[VARIATION_TYPE.CLIENT, VARIATION_TYPE.SUPPLIER].map(t => (
                  <Btn
                    key={t} sm type="button"
                    variant={variationType === t ? 'success' : 'ghost'}
                    onClick={chooseType(t)}
                  >
                    {VARIATION_TYPE_LABELS[t]}
                  </Btn>
                ))}
              </div>
              {variationType && (
                <p className="m-0 mt-1 text-[11px] text-brand-muted">{VARIATION_TYPE_HELP[variationType]}</p>
              )}
            </div>
          )}

          {variationType && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Title <span className="text-brand-red">*</span></label>
                  <input className={inputCls} placeholder="Short variation title" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
                </div>
                <div>
                  <label className={labelCls}>Reason</label>
                  <select className={inputCls} value={reason} onChange={e => setReason(e.target.value)}>
                    <option value="">—</option>
                    {Object.values(VARIATION_REASON).map(r => (
                      <option key={r} value={r}>{VARIATION_REASON_LABELS[r]}</option>
                    ))}
                  </select>
                </div>
              </div>

              <OriginRfiSelect value={originRfiId} onChange={setOriginRfiId} eligibleRfis={eligibleRfis} historical={historicalOriginRfi} />

              {/* Counterparty */}
              {isClient ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {!isEdit && (
                    <div>
                      <label className={labelCls}>Client <span className="text-brand-red">*</span></label>
                      <select className={inputCls} value={clientId} onChange={e => setClientId(e.target.value)} required>
                        <option value="" disabled>
                          {clients.length === 0 ? 'No client contacts yet…' : 'Select a client…'}
                        </option>
                        {clients.map(c => (
                          <option key={c.id} value={c.id}>{c.displayName}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div>
                    <label className={labelCls}>Client Reference</label>
                    <input className={inputCls} placeholder="Client / superintendent VO no. (optional)" value={clientRef} onChange={e => setClientRef(e.target.value)} />
                  </div>
                </div>
              ) : (
                <>
                  {!isEdit && (
                    <div>
                      <label className={labelCls}>Against</label>
                      <div className="flex flex-wrap gap-2">
                        <Btn sm type="button" variant={supplierMode === 'po' ? 'success' : 'ghost'}
                          onClick={() => { setSupplierMode('po'); setSupplierId(''); setLines([{ ...EMPTY_LINE }]) }}>
                          A Purchase Order
                        </Btn>
                        <Btn sm type="button" variant={supplierMode === 'manual' ? 'success' : 'ghost'}
                          onClick={() => { setSupplierMode('manual'); setPoId(''); setLines([{ ...EMPTY_LINE }]) }}>
                          No PO (manual)
                        </Btn>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {!isEdit && (supplierMode === 'po' ? (
                      <div>
                        <label className={labelCls}>Purchase Order <span className="text-brand-red">*</span></label>
                        <select className={inputCls} value={poId}
                          onChange={e => { setPoId(e.target.value); setLines([{ ...EMPTY_LINE }]) }} required>
                          <option value="" disabled>
                            {selectablePOs.length === 0 ? 'No sent/closed POs…' : 'Select a PO…'}
                          </option>
                          {selectablePOs.map(p => (
                            <option key={p.id} value={p.id}>{p.poNumber} — {p.supplierName}</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div>
                        <label className={labelCls}>Supplier / Subcontractor <span className="text-brand-red">*</span></label>
                        <select className={inputCls} value={supplierId} onChange={e => setSupplierId(e.target.value)} required>
                          <option value="" disabled>
                            {suppliers.length === 0 ? 'No supplier contacts yet…' : 'Select a supplier…'}
                          </option>
                          {suppliers.map(c => (
                            <option key={c.id} value={c.id}>{c.displayName}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                    <div>
                      <label className={labelCls}>Supplier Reference</label>
                      <input className={inputCls} placeholder="Supplier's variation / quote no. (optional)" value={supplierRef} onChange={e => setSupplierRef(e.target.value)} />
                    </div>
                  </div>
                  {!isEdit && supplierMode === 'po' && po && (
                    <p className="m-0 -mt-1 text-[12px] text-brand-muted">
                      Supplier <span className="text-brand-text font-semibold">{po.supplierName}</span> is locked from {po.poNumber}. The PO is never modified.
                    </p>
                  )}
                </>
              )}

              {/* Line items */}
              <div>
                <label className={labelCls}>Line Items (ex-GST) <span className="text-brand-red">*</span></label>
                <div className="flex flex-col gap-2">
                  {lines.map((line, idx) => {
                    const poLine = usesPoLines && line.poLineIndex !== '' ? (po.lineItems ?? [])[Number(line.poLineIndex)] : null
                    return (
                      <div key={idx} className="grid grid-cols-2 sm:grid-cols-[2fr_2fr_1fr_1.2fr_auto] gap-2 items-center">
                        {usesPoLines ? (
                          poLine ? (
                            <p className="m-0 text-[12px] text-brand-text truncate" title={poLine.costCodeName}>{poLine.costCodeName || '—'}</p>
                          ) : (
                            <select className={inputCls} value={line.poLineIndex} onChange={selectPoLine(idx)}>
                              <option value="">New scope — pick cost code →</option>
                              {(po.lineItems ?? []).map((pl, i) => (
                                <option key={i} value={i}>{pl.costCodeName}</option>
                              ))}
                            </select>
                          )
                        ) : (
                          <select className={inputCls} value={line.costCodeId} onChange={setLine(idx, 'costCodeId')} required>
                            <option value="" disabled>Cost code…</option>
                            {pickerCostCodes.map(cc => (
                              <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                            ))}
                          </select>
                        )}
                        {usesPoLines && !poLine ? (
                          <select className={inputCls} value={line.costCodeId} onChange={setLine(idx, 'costCodeId')}>
                            <option value="" disabled>Cost code…</option>
                            {pickerCostCodes.map(cc => (
                              <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                            ))}
                          </select>
                        ) : (
                          <input className={inputCls} placeholder="Description" value={line.description} onChange={setLine(idx, 'description')} />
                        )}
                        <input
                          type="number" step="any"
                          className={inputCls}
                          placeholder="Amount"
                          value={line.submittedAmount}
                          onChange={setLine(idx, 'submittedAmount')}
                        />
                        <TaxSelect value={line.taxCode} onChange={setLine(idx, 'taxCode')} />
                        <button
                          type="button"
                          onClick={() => removeLine(idx)}
                          disabled={lines.length === 1}
                          aria-label="Remove line"
                          className="text-brand-muted hover:text-brand-red disabled:opacity-30 disabled:cursor-not-allowed text-lg leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
                        >
                          ×
                        </button>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-2">
                  <Btn variant="ghost" type="button" sm onClick={addLine}>+ Add line</Btn>
                </div>
                <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
                  Every line needs a cost code. Amounts may be negative for credits / omissions. GST is derived per line from its tax code.
                  {usesPoLines && ' Selecting an existing PO line inherits and locks its cost code; leave as “New scope” for added work.'}
                </p>
              </div>

              {/* Dates */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>Identified Date</label>
                  <input type="date" className={inputCls} value={identifiedDate} onChange={e => setIdentifiedDate(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Response Due</label>
                  <input type="date" className={inputCls} value={responseDueDate} onChange={e => setResponseDueDate(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Effective Date</label>
                  <input type="date" className={inputCls} value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} />
                </div>
              </div>

              <div>
                <label className={labelCls}>Description / Notes</label>
                <input className={inputCls} placeholder="Optional" value={description} onChange={e => setDescription(e.target.value)} />
              </div>

              {dupWarnings.map((w, i) => (
                <p key={i} className="m-0 text-[12px] text-brand-amber">⚠ {w.message}</p>
              ))}

              <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
                <p className="m-0">Submitted subtotal <span className="font-semibold ml-2">{money(totals.subtotal)}</span></p>
                <p className="m-0 text-brand-muted">GST <span className="ml-2">{money(totals.gst)}</span></p>
                <p className="m-0 font-bold">Submitted total <span className="ml-2">{money(totals.total)}</span></p>
              </div>
            </>
          )}

          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving || !valid}>{saving ? 'Saving…' : isEdit ? 'Save draft' : 'Create Draft Variation'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Originating RFI (evidence link, ADR-34) ──────────────────────────────────
// Zero or one current-project RFI, open/answered/closed only. Choosing one
// changes no amount, total, status or date — it records where the change came
// from. `historical` is a draft's EXISTING link whose RFI is no longer
// eligible (cancelled since): it is listed, clearly labelled, as the current
// selection so an untouched save preserves it — never as a fresh choice.

function OriginRfiSelect({ value, onChange, eligibleRfis, historical = null }) {
  const none = eligibleRfis.length === 0 && !historical
  return (
    <div>
      <label className={labelCls}>Originating RFI <span className="normal-case font-semibold tracking-normal">(optional)</span></label>
      <select className={inputCls} value={value} onChange={e => onChange(e.target.value)} disabled={none}>
        <option value="">{none ? 'No open, answered or closed RFIs in this project' : 'None'}</option>
        {historical && (
          <option value={historical.originRfiId}>{originRfiLabel(historical)} (no longer eligible)</option>
        )}
        {eligibleRfis.map(r => (
          <option key={r.id} value={r.id}>{originRfiLabel(normaliseOriginRfi(r))}</option>
        ))}
      </select>
      <p className="m-0 mt-1 text-[11px] text-brand-muted">
        {historical && value === historical.originRfiId
          ? 'This RFI has been cancelled since it was linked. The existing link is kept unless you change it.'
          : none
            ? 'Raise an RFI first — draft and cancelled RFIs cannot originate a variation.'
            : 'Evidence only — the RFI does not change this variation\u2019s value. Draft and cancelled RFIs are not listed.'}
      </p>
    </div>
  )
}

// ── Commercial effect (M3-B1, ADR-62) ────────────────────────────────────────
// Shown in the Assess modal (for a PO-linked supplier variation) and in the
// legacy Apply dialog: per PO line the current value, what has been recognised,
// the remaining commitment, and the revised value and remaining commitment
// after application; new-scope and invalid lines listed apart; and, per
// affected cost code, the saved Uncommitted Cost to Complete — because the
// pre-M3-B1 guidance told the QS to fold expected variation cost into it. A
// positive CTC is a WARNING that the variation MAY already be in it; it proves
// nothing, nothing is subtracted automatically, and the QS must review it
// (acknowledged explicitly before confirming). Everything shown is
// lib/variationCommitment.js → commitmentEffectPreview over live subscriptions.

function CommitmentEffectPanel({ preview, mode, currencyCode, acknowledged, onAcknowledge }) {
  const money = (n) => formatCurrency(n, currencyCode)
  if (!preview?.applicable) return null
  const {
    po, poState, willApply, willCommitScope, alreadyScopeCommitted, poLines, newScopePositive, newScopeNegative, invalid, costCodes,
    ctcWarning, overRecognitionWarning, overRecognisedPoLines, totals,
  } = preview
  const poLabel = po?.poNumber || 'the linked purchase order'
  const cellCls = 'px-2 py-1.5 text-[12px] text-brand-text whitespace-nowrap'
  const headCls = 'px-2 py-1.5 text-[10.5px] font-bold text-brand-muted uppercase tracking-[0.4px] text-left whitespace-nowrap'
  const verb = mode === 'apply' ? 'Applying' : 'Approving'
  // One acknowledgement covers both warnings (CTC overlap, over-recognition).
  const needsAck = ctcWarning || overRecognitionWarning

  return (
    <div className="border border-brand-border rounded-lg px-3 py-3 flex flex-col gap-2.5" data-testid="commitment-effect">
      <p className="m-0 text-[12px] font-bold text-brand-text">Commercial effect on {poLabel}</p>

      {poState === PO_LINK_STATE.MISSING && (
        <p className="m-0 text-[12px] text-brand-red" role="alert">
          ⚠ {poLabel} could not be found in this project. {mode === 'apply'
            ? 'The variation cannot be applied to a commitment.'
            : 'This variation cannot be approved: a supplier variation that names a purchase order is approved and applied together, and its purchase order must exist and be sent or closed. Withdraw or reject it, or raise it again against a current purchase order.'}
        </p>
      )}
      {poState === PO_LINK_STATE.NOT_COMMITTED && (
        <p className="m-0 text-[12px] text-brand-red" role="alert">
          ⚠ {poLabel} is {PO_STATUS_LABELS[po.status] ?? po.status}, not sent or closed. {mode === 'apply'
            ? 'The variation cannot be applied to its commitment.'
            : 'This variation cannot be approved while its purchase order is not sent or closed (the database refuses the write too). Withdraw or reject it, or raise it again against a current purchase order.'}
        </p>
      )}

      {willApply && poLines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-brand-border">
                {['PO line', 'Current value', 'Recognised', 'Remaining now', 'This variation', 'Revised value', 'Remaining after'].map(h => (
                  <th key={h} className={headCls}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {poLines.map(r => (
                <tr key={r.poLineIndex} className="border-b border-brand-border">
                  <td className={`${cellCls} whitespace-normal`}>
                    Line {r.poLineIndex + 1} · {r.costCodeName || '—'}
                    {r.currentAdjustment !== 0 && (
                      <span className="block text-[11px] text-brand-muted">PO {money(r.original)} + applied SVs {money(r.currentAdjustment)}</span>
                    )}
                  </td>
                  <td className={cellCls}>{money(r.currentRevised)}</td>
                  <td className={cellCls}>{money(r.recognised)}</td>
                  <td className={cellCls}>{money(r.currentRemaining)}</td>
                  <td className={`${cellCls} font-semibold`}>{r.delta >= 0 ? '+' : ''}{money(r.delta)}</td>
                  <td className={`${cellCls} font-semibold ${r.negativeAfter ? 'text-brand-red' : ''}`}>{money(r.revisedAfter)}{r.negativeAfter ? ' ⚠' : ''}</td>
                  <td className={`${cellCls} font-semibold`}>{money(r.remainingAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
            Remaining commitment on these lines moves from {money(totals.remainingBefore)} to {money(totals.remainingAfter)}. Recognised = posted supplier
            invoices + approved claims not yet invoiced on the line; a negative variation lowers the ceiling and never creates a credit note or reduces Actual.
          </p>
        </div>
      )}

      {willApply && poLines.length === 0 && newScopePositive.length === 0 && (
        <p className="m-0 text-[12px] text-brand-amber">
          ⚠ No line of this variation extends an existing PO line and none is positive new scope, so nothing matures into {poLabel}'s commitment. It will be
          recorded as applied, and its amount stays as signed exposure.
        </p>
      )}

      {newScopePositive.length > 0 && (
        <div className="text-[12px]" data-testid="new-scope-effect">
          <p className={`m-0 font-semibold ${willCommitScope ? 'text-brand-text' : 'text-brand-amber'}`}>
            {willCommitScope ? '✓' : '⚠'} {newScopePositive.length} new-scope {newScopePositive.length === 1 ? 'line' : 'lines'} ({money(totals.newScopeCommittable)}) {newScopePositive.length === 1 ? 'is' : 'are'} not on an existing PO line.
          </p>
          <ul className="m-0 mt-1 pl-4 list-disc text-brand-text">
            {newScopePositive.map(l => (
              <li key={l.lineIndex}>Line {l.lineIndex + 1}{l.costCodeName ? ` (${l.costCodeName})` : ''}{l.description ? ` — ${l.description}` : ''}: {money(l.amount)}</li>
            ))}
          </ul>
          <p className="m-0 mt-1 text-brand-muted">
            {willCommitScope
              ? `${verb} commits this new scope: each line becomes committed, claimable scope in its own right (ceiling = its approved amount, on its own cost code), enters Remaining Committed and Forecast Final Cost now, and is matured by the progress claims and invoices raised against it. It is never attributed to a PO line.`
              : alreadyScopeCommitted
                ? 'This new scope is already committed and claimable; nothing changes for it.'
                : 'New-scope amounts stay as unapplied exposure and are not claimable until the scope commit is recorded.'}
          </p>
        </div>
      )}

      {newScopeNegative.length > 0 && (
        <div className="text-[12px] text-brand-amber" data-testid="negative-new-scope">
          <p className="m-0 font-semibold">⚠ {newScopeNegative.length} negative new-scope {newScopeNegative.length === 1 ? 'line' : 'lines'} ({money(totals.newScopeNegative)}) — accounting review required.</p>
          <ul className="m-0 mt-1 pl-4 list-disc">
            {newScopeNegative.map(l => (
              <li key={l.lineIndex}>Line {l.lineIndex + 1}{l.costCodeName ? ` (${l.costCodeName})` : ''}: {money(l.amount)}</li>
            ))}
          </ul>
          <p className="m-0 mt-1 text-brand-muted">
            A negative amount on no PO line is never matured into commitment, never claimed and never turned into a credit note automatically. It stays
            as signed exposure and is listed on SHIELD. To reduce a PO line, raise the reduction against that line; to recover money already invoiced,
            raise a supplier credit note.
          </p>
        </div>
      )}

      {overRecognitionWarning && (
        <div className="text-[12px] text-brand-red" data-testid="over-recognition-warning">
          <p className="m-0 font-semibold">
            ⚠ Potential overlap: {poLabel} already has recognition above its revised line value on {overRecognisedPoLines.length === 1 ? 'one line' : `${overRecognisedPoLines.length} lines`}.
          </p>
          <ul className="m-0 mt-1 pl-4 list-disc">
            {overRecognisedPoLines.map(r => (
              <li key={r.poLineIndex}>Line {r.poLineIndex + 1}{r.costCodeName ? ` (${r.costCodeName})` : ''}: recognised {money(r.recognised)} against a revised value of {money(r.revised)} (excess {money(r.excess)})</li>
            ))}
          </ul>
          <p className="m-0 mt-1 text-brand-muted">
            New-scope work may already have been claimed against a base PO line before it could be claimed in its own right. Committing this new scope
            would then carry that work in Remaining Committed as well as in Actual. This is a possibility, not proof: nothing is reassigned or rewritten.
            Review the claims on {poLabel} before confirming; the acknowledgement below is required.
          </p>
        </div>
      )}

      {invalid.length > 0 && (
        <div className="text-[12px] text-brand-red">
          <p className="m-0 font-semibold">⚠ {invalid.length} {invalid.length === 1 ? 'line cannot' : 'lines cannot'} be incorporated ({money(totals.invalid)}):</p>
          <ul className="m-0 mt-1 pl-4 list-disc">
            {invalid.map(l => (
              <li key={l.lineIndex}>Line {l.lineIndex + 1}{l.costCodeName ? ` (${l.costCodeName})` : ''}: {COMMITMENT_LINE_ISSUE_LABELS[l.issue] ?? l.issue}</li>
            ))}
          </ul>
          <p className="m-0 mt-1 text-brand-muted">These amounts stay in unapplied exposure and are listed on SHIELD. They are never counted against another PO line or cost code.</p>
        </div>
      )}

      {willApply && costCodes.length > 0 && (
        <div>
          <p className="m-0 text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Uncommitted Cost to Complete on affected cost codes</p>
          <ul className="m-0 pl-0 list-none flex flex-col gap-0.5">
            {costCodes.map(c => (
              <li key={c.costCodeId} className={`text-[12px] ${c.ctcWarning ? 'text-brand-amber' : 'text-brand-text'}`}>
                {c.costCodeName || c.costCodeId}: commitment {c.delta >= 0 ? '+' : ''}{money(c.delta)} · saved Uncommitted CTC {c.uncommittedCtc === null ? 'not forecast' : money(c.uncommittedCtc)}
                {c.ctcWarning && ' ⚠'}
              </li>
            ))}
          </ul>
          {ctcWarning ? (
            <>
              <p className="m-0 mt-1.5 text-[12px] text-brand-amber">
                ⚠ A positive Uncommitted Cost to Complete is saved on a cost code this variation adjusts. Before M3-B1 the Forecast tab asked you to fold approved
                supplier variations into that input, so this variation MAY already be inside it — {verb.toLowerCase()} it adds the same amount to Remaining Committed,
                which would double-count Forecast Final Cost. This warning does not prove an overlap exists. Nothing is subtracted automatically: review the Forecast tab
                after confirming.
              </p>
            </>
          ) : (
            <p className="m-0 mt-1 text-[11px] text-brand-muted">No positive Uncommitted Cost to Complete is saved on these cost codes, so no overlap is possible there.</p>
          )}
        </div>
      )}

      {needsAck && (
        <label className="flex items-start gap-2 mt-1.5 text-[12px] text-brand-text cursor-pointer min-h-[44px]">
          <input type="checkbox" className="mt-1" checked={!!acknowledged} onChange={e => onAcknowledge?.(e.target.checked)} />
          <span>
            I have reviewed the warnings above
            {ctcWarning ? ` (saved Uncommitted Cost to Complete on ${costCodes.filter(c => c.ctcWarning).map(c => c.costCodeName || c.costCodeId).join(', ')})` : ''}
            {overRecognitionWarning ? ` (recognition above the revised value on ${poLabel})` : ''}
            {' '}and understand that nothing is adjusted automatically.
          </span>
        </label>
      )}

      <p className="m-0 text-[11px] text-brand-muted">
        The purchase order document is never modified. {willApply
          ? 'Applied amounts revise the PO line’s contractual value and are matured by the same claims and invoices as the original line; committed new-scope lines are commitment lines in their own right. Every amount is counted once, in Remaining Committed.'
          : 'Nothing is applied to a commitment by this action.'}
        {alreadyScopeCommitted && willApply ? ' New scope on this variation is already committed.' : ''}
      </p>
    </div>
  )
}

// ── Legacy Apply to commitment (M3-B1, ADR-62) ───────────────────────────────
// For an APPROVED, PO-linked supplier variation that carries no commitment
// stamps (approved before M3-B1, or while its PO was not sent/closed). One
// explicit confirmation; the hook's guarded transaction re-reads the variation
// and the PO on the server, and the rules refuse a repeat (the stored stamps
// must be null) — so two tabs or two users cannot both apply it.

function ApplyCommitmentModal({ variation, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines, currencyCode, onClose, onApply }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const eligibility = commitmentApplyEligibility(variation, purchaseOrders)
  const preview = commitmentEffectPreview({ variation, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines })
  const needsAck = (preview.ctcWarning || preview.overRecognitionWarning) && !acknowledged
  const valid = eligibility.eligible && !needsAck
  // Legacy variations come in two shapes (ADR-62 / ADR-63): never applied (the
  // action applies AND commits new scope), or applied under M3-B1 with the new
  // scope not yet committed (the action commits the new scope only).
  const scopeOnly = eligibility.eligible && !eligibility.missing.applied && eligibility.missing.scope
  const actionLabel = scopeOnly ? 'Commit new scope' : 'Apply to commitment'

  async function handle() {
    if (!valid) return
    const target = eligibility.po?.poNumber ?? variation.poNumber
    const text = scopeOnly
      ? `Commit ${variation.variationNumber}'s new scope on ${target}? ${money(preview.totals.newScopeCommittable)} of new-scope work becomes committed, claimable scope and enters Remaining Committed. This is recorded once and cannot be undone.`
      : `Apply ${variation.variationNumber} to ${target}'s commitment? ${money(preview.totals.matured)} will enter Remaining Committed${preview.willCommitScope ? ` (including ${money(preview.totals.newScopeCommittable)} of committed new scope)` : ''}. This is recorded once and cannot be undone.`
    if (!window.confirm(text)) return
    setSaving(true)
    setError(null)
    try {
      await onApply(variation)
      onClose()
    } catch (err) {
      setError(writeErrorMessage(err, 'Failed to apply. Check your connection and try again.'))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[820px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">
            {scopeOnly ? `Commit ${variation.variationNumber}'s new scope` : `Apply ${variation.variationNumber} to commitment`} — {variation.poNumber || '—'}
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center">×</button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3.5">
          <p className="m-0 text-[12px] text-brand-muted">
            {scopeOnly
              ? <>This variation is applied to {variation.poNumber || 'the PO'}'s commitment, but its new-scope lines were approved before new scope could be
                  committed and claimed in its own right, so they have been shown as exposure only. Committing the new scope makes each positive new-scope
                  line a committed, claimable line (ceiling = its approved amount) inside Remaining Committed. The approval and the existing-line
                  application are unchanged.</>
              : <>This variation was approved before applied commitments existed (or while its purchase order was not sent or closed), so its approved value
                  {' '}{money(variation.approvedSubtotal || 0)} has been shown as exposure only. Applying it moves the amounts on existing PO lines into
                  {' '}{variation.poNumber || 'the PO'}'s Remaining Committed and commits any positive new-scope lines as claimable scope. The approval
                  itself — amounts, notes, dates, approver — is unchanged.</>}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[12px] text-brand-text">
            <div><span className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px]">Variation</span>{variation.variationNumber} · {variation.title}</div>
            <div><span className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px]">Purchase order</span>{variation.poNumber || '—'} · {variation.supplierName || '—'}</div>
            <div><span className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px]">Approved (ex-GST)</span>{money(variation.approvedSubtotal || 0)}</div>
          </div>
          {!eligibility.eligible && <p className="m-0 text-[12px] text-brand-red">{eligibility.message}</p>}
          <CommitmentEffectPanel preview={preview} mode="apply" currencyCode={currencyCode} acknowledged={acknowledged} onAcknowledge={setAcknowledged} />
          {error && <p className="m-0 text-[12px] text-brand-red">{error}</p>}
          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn sm type="button" disabled={saving || !valid} onClick={handle}>{saving ? 'Saving…' : actionLabel}</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Assess ───────────────────────────────────────────────────────────────────

function AssessVariationModal({ variation, purchaseOrders = [], progressClaims = [], supplierInvoices = [], variations = [], forecastLines = [], currencyCode, onClose, onTransition }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const [approvedAmounts, setApprovedAmounts] = useState(
    (variation.lineItems ?? []).map(li => String(li.submittedAmount ?? 0))
  )
  const [assessmentNotes, setAssessmentNotes] = useState('')
  const [ctcAcknowledged, setCtcAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const setAmount = (idx) => (e) => {
    const value = e.target.value
    setApprovedAmounts(vals => vals.map((v, i) => (i === idx ? value : v)))
  }

  const previewLines = buildApprovedLineItems(variation.lineItems, approvedAmounts)
  const totals       = variationTotals(previewLines, 'approved')
  const needsNotes   = approvalNeedsNotes(variation.lineItems, approvedAmounts)
  const validationError = validateApprovedAmounts(variation.lineItems, approvedAmounts, assessmentNotes)

  // Commercial effect of THESE certified amounts on the linked PO (ADR-62) —
  // approval of a PO-linked supplier variation applies them in the same write
  // while the PO is sent/closed. A positive saved Uncommitted CTC on an affected
  // cost code must be acknowledged before approving (see the panel).
  const preview = commitmentEffectPreview({
    variation: { ...variation, lineItems: previewLines }, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines,
  })
  const needsAck = (preview.ctcWarning || preview.overRecognitionWarning) && !ctcAcknowledged
  // Correction A (ADR-62): a PO-linked supplier variation is approved AND
  // applied in one write, so a missing / cancelled / draft PO blocks approval
  // here (UX mirror) and in the transaction and the rules (the controls).
  // ADR-63: the same write commits any positive new scope.
  const poBlocksApproval = preview.applicable && !preview.willApply
  const confirmText = preview.willApply
    ? `Approve ${variation.variationNumber}? Approved amounts freeze permanently, and ${money(preview.totals.matured)} is applied to ${preview.po?.poNumber ?? variation.poNumber}'s commitment${preview.willCommitScope ? ` (including ${money(preview.totals.newScopeCommittable)} of new scope committed as claimable)` : ''}.`
    : `Approve ${variation.variationNumber}? Approved amounts freeze permanently.`

  async function handle(nextStatus) {
    if (nextStatus === VARIATION_STATUS.APPROVED && (validationError || needsAck || poBlocksApproval)) return
    if (nextStatus === VARIATION_STATUS.APPROVED && !window.confirm(confirmText)) return
    if (nextStatus === VARIATION_STATUS.REJECTED && !window.confirm(`Reject ${variation.variationNumber}?`)) return
    setSaving(true)
    setError(null)
    try {
      await onTransition(variation, nextStatus, {
        approvedAmounts: approvedAmounts.map(a => Number(a) || 0),
        assessmentNotes,
      })
      onClose()
    } catch (err) {
      // A STALE / INVALID / PERMISSION refusal keeps the modal open with the
      // certified amounts and notes intact and shows the reason (ADR-59).
      setError(writeErrorMessage(err, 'Failed to save. Check your connection and try again.'))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[820px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">
            Assess {variation.variationNumber} — {variation.clientName || variation.supplierName || '—'}
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
          <div>
            <label className={labelCls}>Approved Amounts (ex-GST)</label>
            <div className="flex flex-col gap-2">
              {(variation.lineItems ?? []).map((li, idx) => (
                <div key={idx} className="grid grid-cols-2 sm:grid-cols-[2fr_2fr_1fr_1.2fr] gap-2 items-center">
                  <p className="m-0 text-[12px] text-brand-text truncate">{li.costCodeName || '—'}</p>
                  <p className="m-0 text-[12px] text-brand-muted truncate">{li.description || '—'}</p>
                  <p className="m-0 text-[12px] text-brand-muted whitespace-nowrap">
                    submitted {money(li.submittedAmount || 0)} · {TAX_CODE_LABELS[li.taxCode]}
                  </p>
                  <input
                    type="number" step="any"
                    className={inputCls}
                    value={approvedAmounts[idx] ?? ''}
                    onChange={setAmount(idx)}
                  />
                </div>
              ))}
            </div>
            <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
              Approved amounts are unbounded — above, below, equal, zero or negative are all valid. Assessment notes are required when any line differs from its submitted amount.
            </p>
          </div>

          <div>
            <label className={labelCls}>
              Assessment Notes {needsNotes && <span className="text-brand-red">*</span>}
            </label>
            <input
              className={inputCls}
              placeholder={needsNotes ? 'Required — why approved differs from submitted' : 'Optional'}
              value={assessmentNotes}
              onChange={e => setAssessmentNotes(e.target.value)}
            />
          </div>

          <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
            <p className="m-0">Approved subtotal <span className="font-semibold ml-2">{money(totals.subtotal)}</span></p>
            <p className="m-0 text-brand-muted">GST <span className="ml-2">{money(totals.gst)}</span></p>
            <p className="m-0 font-bold">Approved total <span className="ml-2">{money(totals.total)}</span></p>
          </div>

          <CommitmentEffectPanel preview={preview} mode="approve" currencyCode={currencyCode} acknowledged={ctcAcknowledged} onAcknowledge={setCtcAcknowledged} />

          {validationError && <p className="m-0 text-[12px] text-brand-red">{validationError}</p>}
          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn variant="danger" sm type="button" disabled={saving} onClick={() => handle(VARIATION_STATUS.REJECTED)}>Reject</Btn>
            <Btn sm type="button" disabled={saving || !!validationError || needsAck || poBlocksApproval} onClick={() => handle(VARIATION_STATUS.APPROVED)}>
              {saving ? 'Saving…' : preview.willApply ? (preview.willCommitScope ? 'Approve, apply & commit new scope' : 'Approve & apply to commitment') : 'Approve'}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

function RowActions({ variation, purchaseOrders, onTransition, onAssess, onEdit, onApply }) {
  const confirmThen = (label, nextStatus) => () => {
    if (window.confirm(`${label} ${variation.variationNumber}?`)) onTransition(variation, nextStatus).catch(() => {})
  }
  // Legacy Apply (ADR-62) / Commit new scope (ADR-63): an approved, PO-linked
  // supplier variation missing a stamp pair, whose PO is sent/closed.
  if (variation.status === VARIATION_STATUS.APPROVED) {
    const eligibility = commitmentApplyEligibility(variation, purchaseOrders)
    if (!eligibility.eligible) return null
    const scopeOnly = !eligibility.missing.applied && eligibility.missing.scope
    return (
      <div className="flex gap-1.5 justify-end">
        <Btn sm variant="success" onClick={() => onApply(variation)}>{scopeOnly ? 'Commit new scope' : 'Apply to commitment'}</Btn>
      </div>
    )
  }
  if (variation.status === VARIATION_STATUS.DRAFT) {
    return (
      <div className="flex gap-1.5 justify-end">
        <Btn sm variant="ghost" onClick={() => onEdit(variation)}>Edit</Btn>
        <Btn sm variant="success" onClick={() => onTransition(variation, VARIATION_STATUS.SUBMITTED).catch(() => {})}>Submit</Btn>
        <Btn sm variant="ghost" onClick={confirmThen('Withdraw', VARIATION_STATUS.WITHDRAWN)}>Withdraw</Btn>
      </div>
    )
  }
  if (variation.status === VARIATION_STATUS.SUBMITTED) {
    return (
      <div className="flex gap-1.5 justify-end">
        <Btn sm variant="success" onClick={() => onAssess(variation)}>Assess</Btn>
        <Btn sm variant="ghost" onClick={confirmThen('Withdraw', VARIATION_STATUS.WITHDRAWN)}>Withdraw</Btn>
      </div>
    )
  }
  return null
}

// The register's incorporation label (ADR-62) — how much of an approved
// supplier variation has reached its PO's commitment. Nothing for client or
// manual-mode variations, or before approval.
function IncorporationTag({ variation, purchaseOrders, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const inc = variationIncorporation(variation, purchaseOrders)
  if (inc.state === INCORPORATION_STATE.NOT_APPLICABLE || inc.state === INCORPORATION_STATE.NOT_APPROVED) return null
  const cls = inc.state === INCORPORATION_STATE.INCORPORATED ? 'text-brand-accent'
    : inc.state === INCORPORATION_STATE.EXCEPTION ? 'text-brand-red'
    : 'text-brand-amber'
  // The PROCESS stamps and the AMOUNTS are shown apart (Correction C): gross
  // approved · incorporated into commitment · still separate exposure.
  return (
    <span className="block text-[11px] text-brand-muted whitespace-nowrap" title={INCORPORATION_STATE_HELP[inc.state]}>
      <span className={`font-semibold ${cls}`}>{INCORPORATION_STATE_LABELS[inc.state]}</span>
      {inc.applied ? ' · applied' : ' · not applied'}
      {inc.counts.newScopePositive > 0 ? (inc.scopeCommitted ? ' · new scope committed' : ' · new scope uncommitted') : ''}
      <span className="block">approved {money(inc.gross)} · in commitment {money(inc.matured)} · exposure {money(inc.outstanding)}</span>
    </span>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectVariations() {
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { variations, variationsLoading, createVariation, updateVariation, transitionStatus, applyVariationCommitment } = useVariations(projectId)
  const { purchaseOrders } = usePurchaseOrders(projectId)
  // Read for the commercial-effect preview only (ADR-62): what the linked PO
  // has recognised and the saved Uncommitted CTC per cost code. The page
  // writes none of them.
  const { progressClaims } = useProgressClaims(projectId)
  const { supplierInvoices } = useSupplierInvoices(projectId)
  const { forecastLines } = useForecastLines(projectId)
  const { contacts, contactsError } = useContacts()
  const { costCodes, costCodesError } = useCostCodes()
  // Originating-RFI candidates (evidence link, ADR-34) — read only; the
  // variations page never writes an RFI.
  const { rfis } = useRfis(projectId)
  const eligibleRfis = useMemo(() => eligibleOriginRfis(rfis), [rfis])
  const [editing, setEditing]         = useState(null)   // 'new' | draft variation | null
  const [assessing, setAssessing]     = useState(null)
  const [applying, setApplying]       = useState(null)   // approved variation awaiting legacy Apply
  const [actionError, setActionError] = useState(null)
  const [typeTab, setTypeTab]         = useState('all')  // 'all' | 'client' | 'supplier'
  const [search, setSearch]           = useState('')
  const [statusFilter, setStatusFilter]           = useState('all')
  const [counterpartyFilter, setCounterpartyFilter] = useState('all')
  const [costCodeFilter, setCostCodeFilter]         = useState('all')

  const counterpartyOf = (v) => v.variationType === VARIATION_TYPE.CLIENT ? (v.clientName || '') : (v.supplierName || '')
  const counterpartyNames = [...new Set(variations.map(counterpartyOf).filter(Boolean))].sort()
  const costCodesInUse = useMemo(() => {
    const ids = new Set()
    for (const v of variations) for (const li of v.lineItems ?? []) if (li.costCodeId) ids.add(li.costCodeId)
    return costCodes.filter(cc => ids.has(cc.id))
  }, [variations, costCodes])

  const filtered = variations.filter(v => {
    if (typeTab !== 'all' && v.variationType !== typeTab) return false
    if (statusFilter !== 'all' && v.status !== statusFilter) return false
    if (counterpartyFilter !== 'all' && counterpartyOf(v) !== counterpartyFilter) return false
    if (costCodeFilter !== 'all' && !(v.lineItems ?? []).some(li => li.costCodeId === costCodeFilter)) return false
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      const hay = [v.variationNumber, v.title, v.description, counterpartyOf(v), v.clientRef, v.supplierRef, v.poNumber, v.originRfiNumber, v.originRfiTitle]
        .filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  async function handleTransition(variation, nextStatus, extras) {
    setActionError(null)
    try {
      await transitionStatus(variation, nextStatus, extras)
    } catch (err) {
      setActionError(writeErrorMessage(err, 'Failed to update status. Check your connection and try again.'))
      throw err
    }
  }

  // Legacy Apply (ADR-62) — the LIVE copy is resolved by id so a stale row can
  // never be applied; the hook's transaction re-reads the server copies.
  async function handleApply(variation) {
    setActionError(null)
    const live = variations.find(v => v.id === variation.id) ?? variation
    try {
      await applyVariationCommitment(live)
    } catch (err) {
      setActionError(writeErrorMessage(err, 'Failed to apply the variation to its commitment. Check your connection and try again.'))
      throw err
    }
  }

  // Draft edit — stale-editor guard (ADR-35). The save path resolves the LIVE
  // document from the subscribed collection by id and refuses to write unless
  // it is STILL a draft, so an editor left open across a submit / withdraw by
  // another action, tab or user can never write stale draft content back.
  // The hook then runs a revision-guarded transaction against the SERVER copy
  // (ADR-59), which catches what the subscription has not yet delivered.
  async function handleUpdate(variationId, data) {
    const live = variations.find(v => v.id === variationId)
    if (!live || live.status !== VARIATION_STATUS.DRAFT) {
      throw new Error('This variation is no longer Draft. Close the editor and review the latest version.')
    }
    await updateVariation(live, data)
  }

  const liveEditing = editing && editing !== 'new'
    ? (variations.find(v => v.id === editing.id) ?? editing)
    : null

  const pendingCount = variations.filter(v => VARIATION_PENDING_STATUSES.includes(v.status)).length

  return (
    <div>
      <SummaryCards variations={variations} purchaseOrders={purchaseOrders} currencyCode={currencyCode} />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3.5">
        <div className="flex gap-1">
          {[['all', 'All'], [VARIATION_TYPE.CLIENT, 'Client'], [VARIATION_TYPE.SUPPLIER, 'Supplier']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setTypeTab(val)}
              className={`px-3 py-1.5 text-[12.5px] font-semibold rounded-lg transition-colors ${typeTab === val ? 'bg-brand-accent/15 text-brand-accent' : 'text-brand-muted hover:text-brand-text'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <Btn sm onClick={() => setEditing('new')}>+ New Variation</Btn>
      </div>

      {actionError && <p className="text-[12px] text-brand-red mb-3">{actionError}</p>}
      {(costCodesError || contactsError) && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">
            {costCodesError && contactsError ? 'Cost codes and contacts could not be loaded'
              : costCodesError ? 'Cost codes could not be loaded' : 'Contacts could not be loaded'}
          </p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            The empty picker is a failed read, not an empty library. Reload the page, and check your connection and
            permissions if this persists.
          </p>
        </Card>
      )}

      {/* Filters */}
      {variations.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3.5">
          <input
            className={`${inputCls} max-w-[240px]`}
            placeholder="Search number, title, ref, PO, RFI…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className={`${inputCls} max-w-[170px]`} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {[VARIATION_STATUS.DRAFT, VARIATION_STATUS.SUBMITTED, VARIATION_STATUS.APPROVED, VARIATION_STATUS.REJECTED, VARIATION_STATUS.WITHDRAWN].map(s => (
              <option key={s} value={s}>{VARIATION_STATUS_LABELS[s]}</option>
            ))}
          </select>
          {counterpartyNames.length > 0 && (
            <select className={`${inputCls} max-w-[220px]`} value={counterpartyFilter} onChange={e => setCounterpartyFilter(e.target.value)}>
              <option value="all">All counterparties</option>
              {counterpartyNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          {costCodesInUse.length > 0 && (
            <select className={`${inputCls} max-w-[220px]`} value={costCodeFilter} onChange={e => setCostCodeFilter(e.target.value)}>
              <option value="all">All cost codes</option>
              {costCodesInUse.map(cc => <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>)}
            </select>
          )}
        </div>
      )}

      <Card padding={false}>
        {variationsLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading variations…</div>
        ) : variations.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              No variations yet. Record a client (head-contract) or supplier (subcontract) change.
            </p>
            <Btn onClick={() => setEditing('new')}>+ Create your first variation</Btn>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">No variations match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['Variation #', 'Type', 'Title', 'Counterparty', 'PO', 'Submitted', 'Approved', 'Status', ''].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(v => (
                  <tr key={v.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{v.variationNumber}</td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">
                      {v.variationType === VARIATION_TYPE.CLIENT ? 'Client' : 'Supplier'}
                    </td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text">
                      {v.title || '—'}
                      {originRfiLabel(v) && (
                        <span className="block text-[11px] text-brand-muted mt-0.5">{originRfiLabel(v)}</span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text">{counterpartyOf(v) || '—'}</td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">
                      {v.poNumber || '—'}
                      <IncorporationTag variation={v} purchaseOrders={purchaseOrders} currencyCode={currencyCode} />
                    </td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text whitespace-nowrap">{money(v.submittedTotal || 0)}</td>
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                      {v.approvedTotal == null ? '—' : money(v.approvedTotal)}
                    </td>
                    <td className="px-3.5 py-3">
                      <Badge label={VARIATION_STATUS_LABELS[v.status] ?? v.status} variant={VARIATION_BADGE_VARIANTS[v.status]} sm />
                    </td>
                    <td className="px-3.5 py-3">
                      <RowActions variation={v} purchaseOrders={purchaseOrders} onTransition={handleTransition} onAssess={setAssessing} onEdit={setEditing} onApply={setApplying} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pendingCount > 0 && (
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          Pending variations are exposure only — they count nowhere until approved. Rejected and withdrawn variations contribute nothing.
        </p>
      )}

      {editing && (
        <VariationEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          variation={liveEditing}
          currencyCode={currencyCode}
          variations={variations}
          purchaseOrders={purchaseOrders}
          contacts={contacts}
          costCodes={costCodes}
          eligibleRfis={eligibleRfis}
          onClose={() => setEditing(null)}
          onSave={editing === 'new' ? createVariation : (data) => handleUpdate(editing.id, data)}
        />
      )}
      {assessing && (
        <AssessVariationModal
          currencyCode={currencyCode}
          variation={assessing}
          purchaseOrders={purchaseOrders}
          progressClaims={progressClaims}
          supplierInvoices={supplierInvoices}
          variations={variations}
          forecastLines={forecastLines}
          onClose={() => setAssessing(null)}
          onTransition={handleTransition}
        />
      )}
      {applying && (
        <ApplyCommitmentModal
          key={applying.id}
          currencyCode={currencyCode}
          variation={variations.find(v => v.id === applying.id) ?? applying}
          purchaseOrders={purchaseOrders}
          progressClaims={progressClaims}
          supplierInvoices={supplierInvoices}
          variations={variations}
          forecastLines={forecastLines}
          onClose={() => setApplying(null)}
          onApply={handleApply}
        />
      )}
    </div>
  )
}
