import { useMemo, useState } from 'react'
import Btn from '../../../components/Btn'
import ActivityDialog from '../timeline/ActivityDialog'
import { formatCurrency } from '../../../lib/formatters'
import { activeCostCodes, costCodeDisplayName } from '../../../lib/costCodes'
import { adjustedByCostCode } from '../../../lib/budgetApproval'
import {
  BUDGET_ADJUSTMENT_TYPE, BUDGET_ADJUSTMENT_TYPES, BUDGET_ADJUSTMENT_TYPE_LABELS, BUDGET_ADJUSTMENT_TYPE_HINTS,
  BUDGET_ADJUSTMENT_LIMITS, validateBudgetAdjustmentDraft, normaliseBudgetAdjustmentDraft, adjustmentPreview,
} from '../../../lib/budgetAdjustment'

// ── Prepare a budget ADJUSTMENT — a DRAFT movement (ADR-71) ──────────────────
//
// Increase, decrease, or transfer (a contingency reallocation is a transfer
// from the contingency cost code). The dialog shows, from the CURRENT
// ADJUSTED APPROVED figures the shared adapter resolved, what each affected
// cost code would become if this movement were approved — and refuses a
// result below zero before anything is written. The draft is bound to the
// active approved version; the approver re-checks the balances against a
// fresh server read. A draft moves no figure.
//
// The document id is minted ONCE when the dialog opens, so a double-click
// or a retry after a timed-out save finds its own draft rather than writing
// a second one.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const hintCls  = 'm-0 mt-1 text-[10.5px] text-brand-muted'

export function PreviewTable({ preview, money }) {
  if (!preview || preview.rows.length === 0) return null
  return (
    <table className="w-full border-collapse mt-1">
      <thead>
        <tr className="border-b border-brand-border">
          {['Cost code', 'Approved now', 'Change', 'After approval'].map((h, i) => (
            <th key={h} className={`px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {preview.rows.map(r => (
          <tr key={r.costCodeId} className="border-b border-brand-border">
            <td className="px-2 py-1.5 text-[12px] text-brand-text">{r.costCodeName || r.costCodeId}</td>
            <td className="px-2 py-1.5 text-[12px] text-right tabular-nums text-brand-muted">{money(r.before)}</td>
            <td className={`px-2 py-1.5 text-[12px] text-right tabular-nums ${r.change < 0 ? 'text-brand-accent' : 'text-brand-amber'}`}>
              {r.change < 0 ? '−' : '+'}{money(Math.abs(r.change))}
            </td>
            <td className={`px-2 py-1.5 text-[12px] text-right tabular-nums font-semibold ${r.negative ? 'text-brand-red' : 'text-brand-text'}`}>
              {money(r.after)}{r.negative && ' — below zero'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function BudgetAdjustmentPrepareModal({ budget, costCodes, currencyCode, newId, onPrepare, onClose }) {
  const money = (n) => formatCurrency(n, currencyCode)
  // ONE id for this submission, kept across retries.
  const [id] = useState(() => newId())
  const [form, setForm] = useState({ type: BUDGET_ADJUSTMENT_TYPE.INCREASE, costCodeId: '', fromCostCodeId: '', amount: '', reason: '', reference: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const perCode = adjustedByCostCode(budget)
  const codeMap = useMemo(() => new Map((costCodes ?? []).filter(c => c?.id).map(c => [c.id, c])), [costCodes])
  const nameOf = (cid) => (codeMap.get(cid) ? costCodeDisplayName(codeMap.get(cid)) : (budget.costCodeNames?.[cid] ?? cid))
  // Destination of an increase / transfer: any ACTIVE code. Source of a
  // decrease / transfer: a code that holds approved budget now (an inactive
  // code may — it can still give budget up).
  const destinations = activeCostCodes(costCodes).map(c => ({ id: c.id, label: costCodeDisplayName(c) }))
  const sources = Object.keys(perCode).filter(cid => perCode[cid] > 0)
    .map(cid => ({ id: cid, label: `${nameOf(cid)} · ${money(perCode[cid])}` }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const isTransfer = form.type === BUDGET_ADJUSTMENT_TYPE.TRANSFER
  const isDecrease = form.type === BUDGET_ADJUSTMENT_TYPE.DECREASE
  const input = { ...form, fromCostCodeId: isTransfer ? form.fromCostCodeId : '' }
  const problem = validateBudgetAdjustmentDraft(input, codeMap)
  // A cheap pure computation over a handful of codes — recomputed per render.
  const preview = validateBudgetAdjustmentDraft({ ...input, reason: input.reason || 'preview' }, codeMap) !== null
    ? null
    : adjustmentPreview(perCode, {
      ...normaliseBudgetAdjustmentDraft(input, codeMap),
      currency: currencyCode,
      baseApprovalId: budget.pointer?.activeApprovalId ?? '',
    })

  async function handleSubmit(e) {
    e.preventDefault()
    if (problem) { setError(problem); return }
    if (preview && !preview.ok) { setError('This movement would take a cost code\'s approved budget below zero.'); return }
    setSaving(true); setError(null)
    try {
      const result = await onPrepare(id, input)
      onClose(result)
    } catch (err) {
      setError(err?.message || 'The adjustment could not be saved. Nothing was written.')
      setSaving(false)
    }
  }

  return (
    <ActivityDialog title="Prepare budget adjustment" titleId="budget-adjustment-prepare-title" onClose={() => onClose(null)} busy={saving} panelClassName="max-w-[620px]">
      <form onSubmit={handleSubmit} className="p-5">
        <p className="m-0 mb-3 text-[12px] text-brand-text-soft">
          An adjustment changes the <strong className="text-brand-text">Approved Budget</strong> of version {budget.version} without
          a full re-approval. It is saved as a draft and counts only once approved by a Company Admin or Project
          Manager. It never changes a working budget line, an actual cost, a commitment, the forecast final cost or cash.
        </p>

        <fieldset className="m-0 p-0 border-0">
          <legend className={labelCls}>Type *</legend>
          <div className="grid grid-cols-3 gap-1.5" role="radiogroup">
            {BUDGET_ADJUSTMENT_TYPES.map(t => (
              <label key={t} className={`flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg border px-2 text-[12.5px] font-semibold ${form.type === t ? 'border-brand-accent bg-brand-accent/10 text-brand-text' : 'border-brand-border text-brand-text-soft'}`}>
                <input type="radio" name="adjustment-type" value={t} className="sr-only" checked={form.type === t} onChange={set('type')} disabled={saving} />
                {BUDGET_ADJUSTMENT_TYPE_LABELS[t]}
              </label>
            ))}
          </div>
          <p className={hintCls}>{BUDGET_ADJUSTMENT_TYPE_HINTS[form.type]}</p>
        </fieldset>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {isTransfer && (
            <div>
              <label className={labelCls} htmlFor="adj-from">From cost code *</label>
              <select id="adj-from" className={inputCls} value={form.fromCostCodeId} onChange={set('fromCostCodeId')} disabled={saving}>
                <option value="">Choose…</option>
                {sources.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          )}
          <div className={isTransfer ? '' : 'sm:col-span-2'}>
            <label className={labelCls} htmlFor="adj-to">{isTransfer ? 'To cost code *' : 'Cost code *'}</label>
            <select id="adj-to" className={inputCls} value={form.costCodeId} onChange={set('costCodeId')} disabled={saving}>
              <option value="">Choose…</option>
              {(isDecrease ? sources : destinations).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="adj-amount">Amount (ex-GST) *</label>
            <input id="adj-amount" className={inputCls} inputMode="decimal" placeholder="e.g. 25000.00" value={form.amount} onChange={set('amount')} disabled={saving} />
            <p className={hintCls}>A positive amount, at most two decimal places, in {currencyCode}. The direction comes from the type.</p>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-brand-border p-3">
          <p className="m-0 text-[12.5px] font-bold text-brand-text">Resulting approved budget</p>
          {!preview ? (
            <p className="m-0 mt-1 text-[12px] text-brand-muted">Choose the type, cost code{isTransfer ? 's' : ''} and amount to see the effect.</p>
          ) : (
            <>
              <PreviewTable preview={preview} money={money} />
              <p className="m-0 mt-2 text-[11.5px] text-brand-text-soft">
                Project Approved Budget: {money(budget.total)} → <strong className="text-brand-text">{money(budget.total + (preview.net ?? 0))}</strong>
                {preview.net === 0 && ' (a transfer leaves the total unchanged)'}
              </p>
              {!preview.ok && <p className="m-0 mt-1 text-[12px] text-brand-red" role="alert">A cost code would fall below zero. Reduce the amount.</p>}
            </>
          )}
        </div>

        <div className="mt-3">
          <label className={labelCls} htmlFor="adj-reason">Reason *</label>
          <textarea id="adj-reason" className={`${inputCls} min-h-[64px]`} maxLength={BUDGET_ADJUSTMENT_LIMITS.reason}
            placeholder="e.g. Client-instructed additional slab thickening" value={form.reason} onChange={set('reason')} disabled={saving} />
        </div>
        <div className="mt-3">
          <label className={labelCls} htmlFor="adj-reference">Reference</label>
          <input id="adj-reference" className={inputCls} maxLength={BUDGET_ADJUSTMENT_LIMITS.reference}
            placeholder="e.g. CV-0004, site instruction SI-12" value={form.reference} onChange={set('reference')} disabled={saving} />
          <p className={hintCls}>Supporting evidence as a reference. Nothing is linked or posted automatically.</p>
        </div>

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red" role="alert">{error}</p>}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={() => onClose(null)} disabled={saving}>Cancel</Btn>
          <Btn type="submit" disabled={saving || Boolean(problem) || (preview && !preview.ok) || !id}>
            {saving ? 'Saving…' : 'Save draft adjustment'}
          </Btn>
        </div>
      </form>
    </ActivityDialog>
  )
}
