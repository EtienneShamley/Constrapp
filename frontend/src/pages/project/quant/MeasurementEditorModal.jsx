import { useState } from 'react'
import Btn from '../../../components/Btn'
import { inputCls, labelCls, modalShellCls, modalCardCls } from './styles'
import { activeCostCodes, costCodeDisplayName } from '../../../lib/costCodes'
import {
  KIND_LABELS, LABEL_MAX, formatMeasurementQuantity, measurementQuantity, validateLabel, measurementBoqItemId,
} from '../../../lib/quant'
import {
  linkableBoqItems, boqItemPickerLabel, measurementLinkState, LINK_STATE, LINK_STATE_LABELS, UNIT_DIMENSION_LABELS,
} from '../../../lib/quantBoq'

// ── Name a measurement, give it a cost code — and optionally link a BOQ item ─
//
// One modal for both saving a freshly drawn measurement (`measurement` carries
// no id) and editing an existing one's label / cost code / link. Geometry is
// never edited here — the quantity is PREVIEWED from the geometry and the
// page's current calibration, exactly as the list computes it, and is never
// typed.
//
// The cost code is the commercial spine (ADR-0a): required, chosen from the
// company's ACTIVE codes (an inactive code already on the record stays
// selectable so a rename does not strand it).
//
// The BOQ link (ADR-52) is OPTIONAL and offers only ACTIVE items on the SAME
// cost code whose unit accepts this measurement's kind (lib/quantBoq.js).
// Linking writes an identity onto the measurement and nothing onto the BOQ
// item: applying the measured quantity is a later, explicit step on the BOQ
// tab. Changing the cost code clears the link, with a visible notice.

export default function MeasurementEditorModal({
  measurement, calibration, costCodes, boqItems, boqItemsLoading, boqItemsError, onSave, onClose,
}) {
  const isNew = !measurement?.id
  const initialLink = measurementBoqItemId(measurement)
  const [label, setLabel] = useState(measurement?.label ?? '')
  const [costCodeId, setCostCodeId] = useState(measurement?.costCodeId ?? '')
  const [boqItemId, setBoqItemId] = useState(initialLink ?? '')
  const [linkNotice, setLinkNotice] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const options = activeCostCodes(costCodes)
  const current = (costCodes ?? []).find(c => c.id === measurement?.costCodeId)
  if (current && !options.some(c => c.id === current.id)) options.push(current)
  const selected = (costCodes ?? []).find(c => c.id === costCodeId)
  const costCodeName = selected ? costCodeDisplayName(selected) : (measurement?.costCodeName ?? '')

  const quantity = measurementQuantity(measurement, calibration)

  // BOQ items this measurement may link to under the CHOSEN cost code.
  const linkable = linkableBoqItems(boqItems, { kind: measurement?.kind, costCodeId })
  // The existing link, judged against the items as loaded — shown even when
  // it is no longer a valid target, so the user can see it and clear it.
  const existing = measurementLinkState(measurement, boqItems)
  const existingShown = !!initialLink && boqItemId === initialLink && !linkable.some(i => i.id === initialLink)
  const boqUnavailable = !!boqItemsError
  const linkDisabled = boqUnavailable || boqItemsLoading || !costCodeId

  const changeCostCode = (nextId) => {
    setCostCodeId(nextId)
    // A link is only valid on the SAME cost code: moving the code clears it,
    // visibly, in this same save (lib/quantActions.js does the same server-side).
    if (boqItemId && nextId !== costCodeId) {
      setBoqItemId('')
      setLinkNotice('The BOQ item link was cleared because the cost code changed. Choose an item on the new cost code to link again.')
    }
  }

  async function submit(e) {
    e.preventDefault()
    const labelError = validateLabel(label)
    if (labelError) { setError(labelError); return }
    if (!costCodeId) { setError('Choose the cost code this measurement belongs to.'); return }
    if (!costCodeName) { setError('The chosen cost code has no display name.'); return }
    setSaving(true); setError(null)
    try {
      await onSave({ label: label.trim(), costCodeId, costCodeName, boqItemId: boqItemId || null })
      onClose()
    } catch (err) {
      setError(err?.message || 'The measurement could not be saved. Nothing was saved.')
      setSaving(false)
    }
  }

  return (
    <div className={modalShellCls}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`${modalCardCls} max-w-[520px]`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">
            {isNew ? `Save ${KIND_LABELS[measurement?.kind]?.toLowerCase() ?? 'measurement'}` : 'Edit measurement details'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>
        <form onSubmit={submit} className="p-5">
          <dl className="m-0 grid grid-cols-3 gap-3 rounded-lg bg-brand-bg/60 px-3 py-2.5">
            <div>
              <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Type</dt>
              <dd className="m-0 mt-0.5 text-[13px] font-semibold text-brand-text">{KIND_LABELS[measurement?.kind] ?? '—'}</dd>
            </div>
            <div>
              <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Points</dt>
              <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">{measurement?.points?.length ?? 0}</dd>
            </div>
            <div>
              <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Quantity</dt>
              <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">{formatMeasurementQuantity(quantity)}</dd>
            </div>
          </dl>

          <label className={`${labelCls} mt-4`} htmlFor="quant-label">Label *</label>
          <input
            id="quant-label"
            className={inputCls}
            placeholder="e.g. Ground floor slab edge"
            maxLength={LABEL_MAX}
            value={label}
            onChange={e => setLabel(e.target.value)}
            autoFocus
          />

          <label className={`${labelCls} mt-4`} htmlFor="quant-cost-code">Cost code *</label>
          <select id="quant-cost-code" className={inputCls} value={costCodeId} onChange={e => changeCostCode(e.target.value)}>
            <option value="">Choose a cost code…</option>
            {options.map(cc => (
              <option key={cc.id} value={cc.id}>{costCodeDisplayName(cc)}{cc.isActive === false ? ' (inactive)' : ''}</option>
            ))}
          </select>
          {selected?.unit && (
            <p className="m-0 mt-1.5 text-[11.5px] text-brand-muted">
              Cost code unit: <span className="font-semibold text-brand-text">{selected.unit}</span> — shown for reference. Quant records
              the measurement in {quantity.unit || 'its own unit'}; the link below is checked against the BOQ item&apos;s own unit.
            </p>
          )}

          <label className={`${labelCls} mt-4`} htmlFor="quant-boq-item">BOQ item (optional)</label>
          <select
            id="quant-boq-item"
            className={inputCls}
            value={boqItemId}
            onChange={e => { setBoqItemId(e.target.value); setLinkNotice(null) }}
            disabled={linkDisabled}
            aria-describedby="quant-boq-item-help"
          >
            <option value="">
              {boqUnavailable ? 'BOQ unavailable — linking disabled'
                : boqItemsLoading ? 'Loading BOQ items…'
                : !costCodeId ? 'Choose a cost code first'
                : linkable.length === 0 ? `No active ${UNIT_DIMENSION_LABELS[measurement?.kind] ?? ''} items on this cost code`
                : 'Not linked'}
            </option>
            {existingShown && existing.item && (
              <option value={initialLink}>{boqItemPickerLabel(existing.item)} — {LINK_STATE_LABELS[existing.state].toLowerCase()}</option>
            )}
            {existingShown && !existing.item && (
              <option value={initialLink}>Linked item not found ({initialLink})</option>
            )}
            {linkable.map(item => (
              <option key={item.id} value={item.id}>{boqItemPickerLabel(item)}</option>
            ))}
          </select>
          <p id="quant-boq-item-help" className="m-0 mt-1.5 text-[11.5px] text-brand-muted">
            Only active items on the same cost code with a compatible unit are offered. Linking records the connection;
            applying the measured quantity to the BOQ is a later, explicit step on the BOQ tab.
          </p>
          {existingShown && existing.state !== LINK_STATE.OK && existing.state !== LINK_STATE.NONE && (
            <p className="m-0 mt-1.5 text-[11.5px] text-brand-amber" role="status">
              {LINK_STATE_LABELS[existing.state]}. Choose “Not linked” to clear it, or pick a valid item.
            </p>
          )}
          {linkNotice && <p className="m-0 mt-1.5 text-[11.5px] text-brand-amber" role="status">{linkNotice}</p>}

          {error && <p className="m-0 mt-3 text-[12px] text-brand-red" role="alert">{error}</p>}

          <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} disabled={saving}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? 'Saving…' : isNew ? 'Save measurement' : 'Save changes'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
