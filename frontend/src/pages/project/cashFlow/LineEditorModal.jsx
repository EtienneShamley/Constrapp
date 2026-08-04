import { useMemo, useState } from 'react'
import Btn from '../../../components/Btn'
import { formatCurrency } from '../../../lib/formatters'
import { roundMoney } from '../../../lib/purchaseOrders'
import {
  CFL_DIRECTION, CFL_SOURCE_TYPE, CFL_SOURCE_TYPE_LABELS,
  sourceTypesForDirection, isCoverageSourceType, isCostCodedSourceType,
  validateCashFlowLineDraft, coverageOverWarning, gstSuggestedGross,
  monthLabel,
} from '../../../lib/cashFlow'

// ── Cash Flow timing line editor (create / edit / retime) ────────────────────
//
// Authors ONE gross-cash timing line. Pure UI over lib/cashFlow.js validation:
//   · direction first — it filters the source list
//   · cost-side sources require a cost code with a positive untimed balance
//   · the ex-GST coverage field PRE-FILLS a visible, editable suggestion equal
//     to the source's remaining untimed balance — never a silent default
//   · "+ GST 10%" fills the gross amount ONLY when pressed (per-line tax codes
//     make it a suggestion, not a calculation)
//   · months start at the current month — past months are actual-only, so a
//     line can never be created in (or retimed into) the past
//   · over-coverage is WARNED with an explicit acknowledgement, never blocked
//     (rules cannot sum sibling lines — client-enforced)

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'

function ModalShell({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[640px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
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

export default function LineEditorModal({
  line,            // existing line when editing/retiming, null when creating
  nowMonth,
  currencyCode,
  cashFlowLines,   // all lines — for coverage warnings (self excluded)
  balances,        // { availableToInvoice, remainingCommittedByCostCode, uncommittedCtcByCostCode, uninvoicedClaimByCostCode, costCodeNames }
  baselineEstablished,
  onSave,          // async (fields) => void
  onClose,
}) {
  const money = (n) => formatCurrency(n, currencyCode)

  const [direction, setDirection]   = useState(line?.direction || CFL_DIRECTION.IN)
  const [sourceType, setSourceType] = useState(line?.sourceType || '')
  const [costCodeId, setCostCodeId] = useState(line?.costCodeId || '')
  const [monthKey, setMonthKey]     = useState(line?.monthKey && line.monthKey >= nowMonth ? line.monthKey : nowMonth)
  const [amount, setAmount]         = useState(line ? String(line.amount ?? '') : '')
  const [coverage, setCoverage]     = useState(
    line?.sourceAmountExGst != null ? String(line.sourceAmountExGst) : '',
  )
  const [description, setDescription] = useState(line?.description || '')
  const [sourceRef, setSourceRef]     = useState(line?.sourceRef || '')
  const [counterpartyName, setCounterpartyName] = useState(line?.counterpartyName || '')
  const [notes, setNotes]             = useState(line?.notes || '')
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const costCoded = isCostCodedSourceType(sourceType)
  const covered   = isCoverageSourceType(sourceType)

  // Cost-code options for the chosen source, each with its balance so the
  // picker shows what remains to time. Options carry a POSITIVE balance only.
  const costCodeOptions = useMemo(() => {
    if (!costCoded) return []
    const map = sourceType === CFL_SOURCE_TYPE.UNCOMMITTED_CTC
      ? balances.uncommittedCtcByCostCode
      : sourceType === CFL_SOURCE_TYPE.UNINVOICED_CLAIM
        ? balances.uninvoicedClaimByCostCode
        : balances.remainingCommittedByCostCode
    return Object.entries(map || {})
      .filter(([, v]) => v > 0)
      .map(([id, v]) => ({ id, balance: v, name: balances.costCodeNames?.[id] || id }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [costCoded, sourceType, balances])

  // The remaining UNTIMED balance for the chosen source — the visible,
  // editable coverage suggestion. Under the corrected model, uninvoiced_claim
  // and remaining_committed share ONE committed balance per cost code.
  const suggestion = useMemo(() => {
    if (!covered) return null
    const others = (cashFlowLines || []).filter(l => l.id !== line?.id)
    const warning = coverageOverWarning({
      sourceType, costCodeId: costCodeId || null,
      sourceAmountExGst: 0, lines: others, balances,
    })
    // coverageOverWarning(0) never warns; derive the residual directly instead.
    void warning
    if (sourceType === CFL_SOURCE_TYPE.CONTRACT_REVENUE) {
      const base = Math.max(0, roundMoney(Number(balances.availableToInvoice) || 0))
      const used = others.filter(l => l.status === 'active' && l.sourceType === CFL_SOURCE_TYPE.CONTRACT_REVENUE)
        .reduce((s, l) => s + (Number(l.sourceAmountExGst) || 0), 0)
      return Math.max(0, roundMoney(base - used))
    }
    if (!costCodeId) return null
    if (sourceType === CFL_SOURCE_TYPE.UNCOMMITTED_CTC) {
      const base = roundMoney(Number(balances.uncommittedCtcByCostCode?.[costCodeId]) || 0)
      const used = others.filter(l => l.status === 'active' && l.sourceType === CFL_SOURCE_TYPE.UNCOMMITTED_CTC && l.costCodeId === costCodeId)
        .reduce((s, l) => s + (Number(l.sourceAmountExGst) || 0), 0)
      return Math.max(0, roundMoney(base - used))
    }
    // remaining_committed and uninvoiced_claim: one shared committed balance.
    const base = roundMoney(Number(balances.remainingCommittedByCostCode?.[costCodeId]) || 0)
    const used = others.filter(l => l.status === 'active' && l.costCodeId === costCodeId
      && (l.sourceType === CFL_SOURCE_TYPE.REMAINING_COMMITTED || l.sourceType === CFL_SOURCE_TYPE.UNINVOICED_CLAIM))
      .reduce((s, l) => s + (Number(l.sourceAmountExGst) || 0), 0)
    return Math.max(0, roundMoney(base - used))
  }, [covered, sourceType, costCodeId, cashFlowLines, line?.id, balances])

  const changeDirection = (e) => {
    setDirection(e.target.value)
    setSourceType('')
    setCostCodeId('')
    setCoverage('')
    setAcknowledged(false)
  }

  const changeSourceType = (e) => {
    const t = e.target.value
    setSourceType(t)
    setCostCodeId('')
    setAcknowledged(false)
    // Manual lines carry no coverage; coverage types get the suggestion once a
    // cost code is chosen (or immediately for contract revenue).
    setCoverage('')
  }

  const changeCostCode = (e) => {
    setCostCodeId(e.target.value)
    setAcknowledged(false)
  }

  // Pre-fill the VISIBLE coverage suggestion when it becomes known and the
  // field is still empty — the user always sees and can change it.
  const coveragePlaceholder = suggestion !== null ? String(suggestion) : ''
  const applySuggestion = () => { if (suggestion !== null) setCoverage(String(suggestion)) }

  // "+ GST 10%" — fills the GROSS amount from the ex-GST coverage ONLY when
  // pressed. Never automatic.
  const applyGst = () => {
    const ex = Number(coverage !== '' ? coverage : coveragePlaceholder)
    if (Number.isFinite(ex) && ex > 0) setAmount(String(gstSuggestedGross(ex)))
  }

  const fields = {
    direction, sourceType,
    monthKey,
    amount,
    sourceAmountExGst: sourceType === CFL_SOURCE_TYPE.MANUAL ? null : (coverage === '' ? null : Number(coverage)),
    costCodeId: costCoded ? (costCodeId || null) : null,
    costCodeName: costCoded ? (balances.costCodeNames?.[costCodeId] || '') : '',
    sourceRef, counterpartyName, description, notes,
  }

  const overWarning = useMemo(() => {
    if (!covered || fields.sourceAmountExGst == null) return null
    return coverageOverWarning({
      sourceType, costCodeId: costCoded ? (costCodeId || null) : null,
      sourceAmountExGst: fields.sourceAmountExGst,
      lines: cashFlowLines, excludeLineId: line?.id ?? null, balances,
    })
  }, [covered, costCoded, sourceType, costCodeId, fields.sourceAmountExGst, cashFlowLines, line?.id, balances])

  async function handleSubmit(e) {
    e.preventDefault()
    const validationError = validateCashFlowLineDraft(fields, nowMonth)
    if (validationError) { setError(validationError); return }
    if (overWarning && !acknowledged) {
      setError('Tick the acknowledgement to save with coverage above the remaining source balance.')
      return
    }
    setSaving(true); setError(null)
    try {
      await onSave(fields)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  const contractRevenueUnavailable = sourceType === CFL_SOURCE_TYPE.CONTRACT_REVENUE && !baselineEstablished

  return (
    <ModalShell title={line ? `Edit timing line — ${monthLabel(line.monthKey)}` : 'Add timing line'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Direction *</label>
            <select className={inputCls} value={direction} onChange={changeDirection}>
              <option value={CFL_DIRECTION.IN}>Cash in</option>
              <option value={CFL_DIRECTION.OUT}>Cash out</option>
            </select>
          </div>

          <div>
            <label className={labelCls}>Source *</label>
            <select className={inputCls} value={sourceType} onChange={changeSourceType}>
              <option value="">— Choose a source —</option>
              {sourceTypesForDirection(direction).map(t => (
                <option key={t} value={t}>{CFL_SOURCE_TYPE_LABELS[t]}</option>
              ))}
            </select>
            {sourceType === CFL_SOURCE_TYPE.UNINVOICED_CLAIM && (
              <p className="m-0 mt-1 text-[10.5px] text-brand-muted">
                Approved claim awaiting invoice — included within Remaining Committed. Its coverage counts
                against the same cost-code committed balance.
              </p>
            )}
          </div>

          {contractRevenueUnavailable && (
            <p className="sm:col-span-2 m-0 text-[11.5px] text-brand-amber">
              Remaining uninvoiced contract value needs a commercial baseline — set one on the Margin view first.
            </p>
          )}

          {costCoded && (
            <div className="sm:col-span-2">
              <label className={labelCls}>Cost code *</label>
              <select className={inputCls} value={costCodeId} onChange={changeCostCode}>
                <option value="">— Choose a cost code —</option>
                {costCodeOptions.map(o => (
                  <option key={o.id} value={o.id}>{o.name} — {money(o.balance)} (ex-GST)</option>
                ))}
              </select>
              {costCodeOptions.length === 0 && (
                <p className="m-0 mt-1 text-[10.5px] text-brand-muted">
                  No cost code carries a positive balance for this source.
                </p>
              )}
            </div>
          )}

          <div>
            <label className={labelCls}>Month *</label>
            <input
              type="month"
              className={inputCls}
              min={nowMonth}
              value={monthKey}
              onChange={(e) => setMonthKey(e.target.value)}
            />
            <p className="m-0 mt-1 text-[10.5px] text-brand-muted">
              Current month ({monthLabel(nowMonth)}) or later — past months are actual-only.
            </p>
          </div>

          <div>
            <label className={labelCls}>Expected gross cash ({currencyCode}) *</label>
            <div className="flex gap-2">
              <input
                type="number" min="0" step="any"
                className={inputCls}
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {covered && (
                <button
                  type="button"
                  onClick={applyGst}
                  className="shrink-0 px-2.5 min-h-[44px] text-[11.5px] font-semibold text-brand-accent border border-brand-border rounded-lg hover:text-brand-text cursor-pointer"
                >
                  + GST 10%
                </button>
              )}
            </div>
            <p className="m-0 mt-1 text-[10.5px] text-brand-muted">
              Gross, inc. GST — what will move through the bank. “+ GST 10%” is an Australian-rate suggestion
              from the ex-GST source amount; check GST-free and input-taxed items.
            </p>
          </div>

          {covered ? (
            <div className="sm:col-span-2">
              <label className={labelCls}>Source amount (ex-GST) — completeness only *</label>
              <input
                type="number" min="0" step="any"
                className={inputCls}
                placeholder={coveragePlaceholder || '0'}
                value={coverage}
                onChange={(e) => { setCoverage(e.target.value); setAcknowledged(false) }}
              />
              <p className="m-0 mt-1 text-[10.5px] text-brand-muted">
                The ex-GST source value this line times. It drives coverage percentages only and never appears
                in a cash column.
                {suggestion !== null && (
                  <> Remaining untimed: <span className="text-brand-text font-semibold">{money(suggestion)}</span>{' '}
                    <button type="button" onClick={applySuggestion} className="text-brand-accent hover:underline cursor-pointer">Use remaining</button>
                  </>
                )}
              </p>
            </div>
          ) : sourceType === CFL_SOURCE_TYPE.MANUAL && (
            <p className="sm:col-span-2 m-0 text-[10.5px] text-brand-muted">
              A manual adjustment carries no source coverage — it appears in the cash months but not in
              completeness. Use it for cash Constrapp cannot derive (e.g. an expected retention release).
            </p>
          )}

          <div className="sm:col-span-2">
            <label className={labelCls}>Description *</label>
            <input
              className={inputCls}
              placeholder="e.g. Final claim on practical completion"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <label className={labelCls}>Reference</label>
            <input
              className={inputCls}
              placeholder="e.g. CV-0003 · PO-0012 · PC-0007"
              value={sourceRef}
              onChange={(e) => setSourceRef(e.target.value)}
            />
            <p className="m-0 mt-1 text-[10.5px] text-brand-muted">A label only — it links nothing and changes no figure.</p>
          </div>

          <div>
            <label className={labelCls}>Counterparty</label>
            <input
              className={inputCls}
              placeholder="Optional"
              value={counterpartyName}
              onChange={(e) => setCounterpartyName(e.target.value)}
            />
          </div>

          <div className="sm:col-span-2">
            <label className={labelCls}>Notes</label>
            <input className={inputCls} placeholder="Optional" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        {overWarning && (
          <div className="mt-4 border border-brand-amber/40 rounded-lg p-3">
            <p className="m-0 text-[12px] text-brand-amber">⚠ {overWarning.message}</p>
            <label className="flex items-start gap-2 mt-2 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span className="text-[11.5px] text-brand-text">
                I understand the combined coverage exceeds the remaining source balance and want to save anyway.
              </span>
            </label>
          </div>
        )}

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red">{error}</p>}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
          <Btn type="submit" disabled={saving}>{saving ? 'Saving…' : line ? 'Save line' : 'Add line'}</Btn>
        </div>
      </form>
    </ModalShell>
  )
}
