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
import { useRfis } from '../../hooks/useRfis'
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
} from '../../lib/variations'

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

function SummaryCards({ variations, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const cards = [
    { label: 'Approved Supplier Variations',  value: approvedSupplierVariationsTotal(variations) },
    { label: 'Pending Supplier Exposure',     value: pendingSupplierVariationExposureTotal(variations) },
    { label: 'Approved Client Variations',    value: approvedClientVariationsTotal(variations) },
    { label: 'Pending Client Exposure',       value: pendingClientVariationExposureTotal(variations) },
  ]
  return (
    <Card className="mb-3.5">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3.5">
        {cards.map(c => (
          <div key={c.label}>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">{c.label}</p>
            <p className="text-lg font-bold text-brand-text">{money(c.value)}</p>
          </div>
        ))}
        <div>
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Open Variations</p>
          <p className="text-lg font-bold text-brand-text">{openVariationCount(variations)}</p>
        </div>
      </div>
      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        All figures are ex-GST and derived at read time. Only approved variations count. Approved Supplier
        Variation amounts feed Commitment Exposure on the Budget tab — they do not yet mature against progress
        claims or supplier invoices.
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
      setError(err?.message || 'Failed to save. Check your connection and try again.')
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
                            {costCodes.map(cc => (
                              <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                            ))}
                          </select>
                        )}
                        {usesPoLines && !poLine ? (
                          <select className={inputCls} value={line.costCodeId} onChange={setLine(idx, 'costCodeId')}>
                            <option value="" disabled>Cost code…</option>
                            {costCodes.map(cc => (
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

// ── Assess ───────────────────────────────────────────────────────────────────

function AssessVariationModal({ variation, currencyCode, onClose, onTransition }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const [approvedAmounts, setApprovedAmounts] = useState(
    (variation.lineItems ?? []).map(li => String(li.submittedAmount ?? 0))
  )
  const [assessmentNotes, setAssessmentNotes] = useState('')
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

  async function handle(nextStatus) {
    if (nextStatus === VARIATION_STATUS.APPROVED && validationError) return
    if (nextStatus === VARIATION_STATUS.APPROVED && !window.confirm(`Approve ${variation.variationNumber}? Approved amounts freeze permanently.`)) return
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
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[760px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
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

          {validationError && <p className="m-0 text-[12px] text-brand-red">{validationError}</p>}
          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn variant="danger" sm type="button" disabled={saving} onClick={() => handle(VARIATION_STATUS.REJECTED)}>Reject</Btn>
            <Btn sm type="button" disabled={saving || !!validationError} onClick={() => handle(VARIATION_STATUS.APPROVED)}>
              {saving ? 'Saving…' : 'Approve'}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

function RowActions({ variation, onTransition, onAssess, onEdit }) {
  const confirmThen = (label, nextStatus) => () => {
    if (window.confirm(`${label} ${variation.variationNumber}?`)) onTransition(variation, nextStatus).catch(() => {})
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

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectVariations() {
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { variations, variationsLoading, createVariation, updateVariation, transitionStatus } = useVariations(projectId)
  const { purchaseOrders } = usePurchaseOrders(projectId)
  const { contacts } = useContacts()
  const { costCodes } = useCostCodes()
  // Originating-RFI candidates (evidence link, ADR-34) — read only; the
  // variations page never writes an RFI.
  const { rfis } = useRfis(projectId)
  const eligibleRfis = useMemo(() => eligibleOriginRfis(rfis), [rfis])
  const [editing, setEditing]         = useState(null)   // 'new' | draft variation | null
  const [assessing, setAssessing]     = useState(null)
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
      setActionError(err?.message || 'Failed to update status. Check your connection and try again.')
      throw err
    }
  }

  // Draft edit — stale-editor guard (ADR-35). The save path resolves the LIVE
  // document from the subscribed collection by id and refuses to write unless
  // it is STILL a draft, so an editor left open across a submit / withdraw by
  // another action, tab or user can never write stale draft content back.
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
      <SummaryCards variations={variations} currencyCode={currencyCode} />

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
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{v.poNumber || '—'}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text whitespace-nowrap">{money(v.submittedTotal || 0)}</td>
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                      {v.approvedTotal == null ? '—' : money(v.approvedTotal)}
                    </td>
                    <td className="px-3.5 py-3">
                      <Badge label={VARIATION_STATUS_LABELS[v.status] ?? v.status} variant={VARIATION_BADGE_VARIANTS[v.status]} sm />
                    </td>
                    <td className="px-3.5 py-3">
                      <RowActions variation={v} onTransition={handleTransition} onAssess={setAssessing} onEdit={setEditing} />
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
          onClose={() => setAssessing(null)}
          onTransition={handleTransition}
        />
      )}
    </div>
  )
}
