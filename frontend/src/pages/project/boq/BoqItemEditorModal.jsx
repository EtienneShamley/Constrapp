import { useState } from 'react'
import Btn from '../../../components/Btn'
import { formatCurrency } from '../../../lib/formatters'
import {
  normalizeRate, boqLineAmount, validateBoqItemDraft,
} from '../../../lib/boq'

// ── Add / edit a BOQ item ────────────────────────────────────────────────────
//
// One modal for both create and active edit (`item` null ⇒ create). The amount
// is DERIVED (quantity × rate) and previewed live — never typed. A blank rate
// means UNPRICED and stores null/null; the unit prefills from the chosen cost
// code's `unit` but stays editable (a code measured in m2 may carry an item
// measured in m3).

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'

export default function BoqItemEditorModal({ item, costCodes, currencyCode, onSave, onClose }) {
  const isNew = !item

  const [form, setForm] = useState(() => ({
    costCodeId:  item?.costCodeId  ?? '',
    itemNumber:  item?.itemNumber  ?? '',
    section:     item?.section     ?? '',
    description: item?.description ?? '',
    unit:        item?.unit        ?? '',
    quantity:    item?.quantity !== undefined && item?.quantity !== null ? String(item.quantity) : '',
    rate:        item?.rate !== undefined && item?.rate !== null ? String(item.rate) : '',
    notes:       item?.notes ?? '',
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  // Choosing a cost code prefills the unit from the company taxonomy — only
  // when the unit field is still empty, so an authored unit is never clobbered.
  const onCostCodeChange = (e) => {
    const costCodeId = e.target.value
    const cc = costCodes.find(c => c.id === costCodeId)
    setForm(f => ({
      ...f,
      costCodeId,
      unit: f.unit.trim() ? f.unit : (cc?.unit || ''),
    }))
  }

  const selectedCode = costCodes.find(cc => cc.id === form.costCodeId)
  const costCodeName = selectedCode ? `${selectedCode.code} — ${selectedCode.name}`
    : (item?.costCodeName || '')

  // Live derived-amount preview — the same arithmetic the hook stores.
  const previewAmount = boqLineAmount(Number(form.quantity), normalizeRate(form.rate))
  const unpriced = normalizeRate(form.rate) === null

  async function handleSubmit(e) {
    e.preventDefault()
    const draft = { ...form, costCodeName }
    const validationError = validateBoqItemDraft(draft)
    if (validationError) { setError(validationError); return }

    setSaving(true)
    setError(null)
    try {
      await onSave(draft)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[560px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">{isNew ? 'New BOQ Item' : 'Edit BOQ Item'}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          <div>
            <label className={labelCls}>Cost Code <span className="text-brand-red">*</span></label>
            <select
              className={inputCls}
              value={form.costCodeId}
              onChange={onCostCodeChange}
              required
              autoFocus={isNew}
            >
              <option value="" disabled>Select a cost code…</option>
              {costCodes.map(cc => (
                <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3.5">
            <div>
              <label className={labelCls}>Item No.</label>
              <input className={inputCls} placeholder="e.g. 2.1 (optional)" value={form.itemNumber} onChange={set('itemNumber')} maxLength={40} />
            </div>
            <div>
              <label className={labelCls}>Section</label>
              <input className={inputCls} placeholder="e.g. Substructure (optional)" value={form.section} onChange={set('section')} />
            </div>
          </div>

          <div>
            <label className={labelCls}>Description <span className="text-brand-red">*</span></label>
            <input className={inputCls} placeholder="e.g. Concrete in slab on ground, N32" value={form.description} onChange={set('description')} required />
          </div>

          <div className="grid grid-cols-3 gap-3.5">
            <div>
              <label className={labelCls}>Quantity <span className="text-brand-red">*</span></label>
              <input type="number" min="0" step="any" className={inputCls} placeholder="0" value={form.quantity} onChange={set('quantity')} required />
            </div>
            <div>
              <label className={labelCls}>Unit <span className="text-brand-red">*</span></label>
              <input className={inputCls} placeholder="e.g. m3" value={form.unit} onChange={set('unit')} maxLength={40} required />
            </div>
            <div>
              <label className={labelCls}>Rate ({currencyCode})</label>
              <input type="number" min="0" step="any" className={inputCls} placeholder="Blank = unpriced" value={form.rate} onChange={set('rate')} />
            </div>
          </div>

          {/* Derived amount — read-only preview of quantity × rate. */}
          <div className="bg-brand-bg border border-brand-border rounded-lg px-3 py-2.5 flex items-center justify-between">
            <span className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px]">Amount (ex-GST, derived)</span>
            {unpriced ? (
              <span className="text-[13px] font-semibold text-brand-amber">Unpriced</span>
            ) : (
              <span className="text-[13px] font-bold text-brand-text">
                {previewAmount === null ? '—' : formatCurrency(previewAmount, currencyCode, { precise: true })}
              </span>
            )}
          </div>
          <p className="m-0 -mt-2 text-[11px] text-brand-muted">
            Amount = quantity × rate. Leave the rate blank while the item is measured but not yet priced —
            an unpriced item counts toward nothing and suppresses the budget variance until priced.
          </p>

          <div>
            <label className={labelCls}>Notes</label>
            <input className={inputCls} placeholder="Optional" value={form.notes} onChange={set('notes')} />
          </div>

          {error && <p className="m-0 text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-3 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} disabled={saving}>Cancel</Btn>
            <Btn type="submit" disabled={saving}>{saving ? 'Saving…' : isNew ? 'Add Item' : 'Save Changes'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
