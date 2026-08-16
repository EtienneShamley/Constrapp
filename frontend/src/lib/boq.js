import { roundMoney } from './purchaseOrders'
import { toCents } from './payments'
import { CURRENCY_DISPLAY_LOCALE } from './currency'

// ── Bill of Quantities (measured schedule; read-time budget comparison) ──────
//
// A BOQ item is a MEASURED, cost-coded, optionally-priced line in the project's
// Bill of Quantities: description, quantity, unit, and — once priced — a rate
// and a derived amount. It is the provenance layer for the Approved Budget, not
// a second budget: BOQ items feed NO financial figure anywhere in the app.
// Budgeted, Committed, Actual, Invoiced, Forecast, Margin, and Cash Flow are
// all computed exactly as before, from the same sources as before. The ONLY
// output of this module beyond the register itself is a read-time comparison
// of the BOQ against the Approved Budget, per cost code, shown on the BOQ page
// and never stored (ADR-3/ADR-4/ADR-32).
//
// ⚠️ NULL MEANS UNPRICED, NEVER ZERO. A BOQ is measured before it is priced,
// so `rate: null` (and therefore `amount: null`) is a first-class "not yet
// priced" state — exactly the forecast-lines idiom, where a null
// uncommittedCostToComplete means "not forecast" while 0 means "reviewed,
// nothing further". An unpriced item contributes NOTHING to any total, stays
// visibly unpriced in the register, and SUPPRESSES the BOQ-vs-budget variance
// (a partially-priced BOQ must never manufacture a flattering comparison).
//
// ⚠️ EX-GST. A BOQ amount is an ex-GST estimate figure, compared only against
// other ex-GST figures (Budgeted). GST enters the lifecycle at the PO, never
// here.
//
// This module is pure: no React, no Firebase, no Firestore reads. Amount
// arithmetic passes through toCents (lib/payments.js) because Firestore rules
// enforce `cents(quantity × rate) == cents(amount)` with the SAME rounding —
// a write this module considers valid is never rejected by the rules for
// floating-point reasons (and vice versa).

export const BOQ_STATUS = {
  ACTIVE: 'active',
  VOID:   'void',
}

export const BOQ_STATUS_LABELS = {
  [BOQ_STATUS.ACTIVE]: 'Active',
  [BOQ_STATUS.VOID]:   'Void',
}

// Maps each status onto an existing Badge variant — no new colours.
export const BOQ_BADGE_VARIANTS = {
  [BOQ_STATUS.ACTIVE]: 'active',
  [BOQ_STATUS.VOID]:   'danger',
}

// Forward-only lifecycle: active items are freely editable (a BOQ item has no
// financial commit point, so there is nothing for an approval to protect —
// the cashFlowLines reasoning, ADR-25); void is the terminal exit and requires
// a reason. There is no delete.
export const BOQ_TRANSITIONS = {
  [BOQ_STATUS.ACTIVE]: [BOQ_STATUS.VOID],
  [BOQ_STATUS.VOID]:   [],
}

export const canTransition = (from, to) => (BOQ_TRANSITIONS[from] ?? []).includes(to)

// ── Pricing ──────────────────────────────────────────────────────────────────

// Form inputs arrive as strings; an empty rate field means UNPRICED, which is
// stored as null — never coerced to 0 (Number('') is 0, which would silently
// turn "not yet priced" into "priced at nothing").
export const normalizeRate = (value) =>
  value === null || value === undefined || value === '' ? null : Number(value)

// An item is priced once it carries an authored rate. Zero IS a price
// ("reviewed, no cost against this item"), exactly as a zero forecast input is
// a forecast — only null/undefined means unpriced.
export const isPriced = (rate) => rate !== null && rate !== undefined

// Derived amount = quantity × rate, or null while unpriced. Rounded via
// toCents/100 — NOT roundMoney — so the client-computed amount always
// satisfies the rules' `cents(quantity * rate) == cents(amount)` check:
// both sides round the identical IEEE-754 product the identical way.
// (roundMoney's Number.EPSILON nudge can differ from math.round at exact
// half-cent float boundaries, which would make a valid-looking write fail.)
export function boqLineAmount(quantity, rate) {
  if (!isPriced(rate)) return null
  const qty = Number(quantity)
  const r   = Number(rate)
  if (!Number.isFinite(qty) || !Number.isFinite(r)) return null
  return toCents(qty * r) / 100
}

// ── Status filters ───────────────────────────────────────────────────────────

export const activeBoqItems = (items) => (items ?? []).filter(i => i?.status === BOQ_STATUS.ACTIVE)
export const voidBoqItems   = (items) => (items ?? []).filter(i => i?.status === BOQ_STATUS.VOID)

// ── Totals (active items only; unpriced contributes NOTHING) ─────────────────

// pricedTotal sums the priced active amounts and is always a number — it is
// honest only alongside unpricedCount, which the page must surface with it.
export function boqTotals(items) {
  const active = activeBoqItems(items)
  let pricedTotal = 0
  let unpricedCount = 0
  for (const item of active) {
    if (isPriced(item.rate) && typeof item.amount === 'number') {
      pricedTotal = roundMoney(pricedTotal + item.amount)
    } else {
      unpricedCount += 1
    }
  }
  return {
    itemCount:     active.length,
    pricedCount:   active.length - unpricedCount,
    unpricedCount,
    pricedTotal:   roundMoney(pricedTotal),
  }
}

// Approved Budget total — the same Σ budgeted the Budget page computes.
export function budgetedTotal(budgetLines) {
  return roundMoney((budgetLines ?? []).reduce((sum, l) => sum + (Number(l?.budgeted) || 0), 0))
}

// Headline Variance = Approved Budget − BOQ total (positive ⇒ BOQ under
// budget — the varianceToBudget sign convention, ADR-19). NULL — never 0 and
// never a partial figure — while the BOQ is empty or any active item is
// unpriced: an incomplete BOQ must not manufacture a variance. The UI renders
// null as "—" with the unpriced count alongside.
export function boqVarianceToBudget(budgetedTotalValue, totals) {
  if (!totals || totals.itemCount === 0 || totals.unpricedCount > 0) return null
  return roundMoney((Number(budgetedTotalValue) || 0) - totals.pricedTotal)
}

// ── Per-cost-code grouping & budget comparison ───────────────────────────────

// { costCodeId: { amount, itemCount, unpricedCount, costCodeName } } over
// ACTIVE items. `amount` sums only priced items; a code whose items are all
// unpriced keeps amount 0 but is distinguished by unpricedCount == itemCount.
export function boqByCostCode(items) {
  const map = {}
  for (const item of activeBoqItems(items)) {
    if (!item.costCodeId) continue
    const entry = map[item.costCodeId] ?? (map[item.costCodeId] = {
      amount: 0, itemCount: 0, unpricedCount: 0, costCodeName: '',
    })
    entry.itemCount += 1
    if (isPriced(item.rate) && typeof item.amount === 'number') {
      entry.amount = roundMoney(entry.amount + item.amount)
    } else {
      entry.unpricedCount += 1
    }
    if (item.costCodeName) entry.costCodeName = item.costCodeName
  }
  return map
}

// One row per cost code appearing in the BOQ OR the Approved Budget — the
// buildForecastRows union discipline: a code must never disappear merely
// because it is inactive, missing, or present on one side only. Names resolve
// live from the cost-code list, falling back to the stored snapshots.
//
// Row semantics (all read-time; nothing here is ever stored):
//   · boqAmount   number — the priced BOQ sum — or NULL when the code has no
//                 priced items (no items at all, or all unpriced)
//   · budgeted    number, or NULL when the code has no budget line
//   · variance    budgeted − boqAmount (positive ⇒ BOQ under budget), or NULL
//                 whenever either side is null OR the code still has unpriced
//                 items — a partial BOQ sum must not be compared as complete
export function boqVsBudgetRows({ costCodes = [], boqItems = [], budgetLines = [] }) {
  const boqMap = boqByCostCode(boqItems)

  const budgetedMap = {}
  const budgetNameMap = {}
  for (const l of budgetLines ?? []) {
    if (!l?.costCodeId) continue
    budgetedMap[l.costCodeId] = roundMoney((budgetedMap[l.costCodeId] || 0) + (Number(l.budgeted) || 0))
    if (l.costCodeName) budgetNameMap[l.costCodeId] = l.costCodeName
  }

  const codeMap = {}
  for (const cc of costCodes ?? []) codeMap[cc.id] = cc

  const ids = new Set([...Object.keys(boqMap), ...Object.keys(budgetedMap)])

  const rows = []
  for (const id of ids) {
    const cc  = codeMap[id]
    const boq = boqMap[id] ?? null
    const costCodeName = cc
      ? `${cc.code} — ${cc.name}`
      : (boq?.costCodeName || budgetNameMap[id] || 'Unknown cost code')

    const hasBudget = Object.prototype.hasOwnProperty.call(budgetedMap, id)
    const boqAmount = boq && boq.unpricedCount < boq.itemCount ? boq.amount : null
    const budgeted  = hasBudget ? budgetedMap[id] : null
    const unpricedCount = boq?.unpricedCount ?? 0

    rows.push({
      costCodeId: id,
      costCodeName,
      isInactive: !!cc && cc.isActive === false,
      isMissing:  !cc,
      boqItemCount:  boq?.itemCount ?? 0,
      boqUnpricedCount: unpricedCount,
      boqAmount,
      budgeted,
      variance: boqAmount !== null && budgeted !== null && unpricedCount === 0
        ? roundMoney(budgeted - boqAmount)
        : null,
    })
  }

  rows.sort((a, b) => a.costCodeName.localeCompare(b.costCodeName))
  return rows
}

// ── Register ordering ────────────────────────────────────────────────────────

// Section, then item number (natural order, so "2.10" follows "2.9"), then
// entry order. Does not mutate the input.
export function sortBoqItems(items) {
  return [...(items ?? [])].sort((a, b) =>
    (a.section || '').localeCompare(b.section || '')
    || (a.itemNumber || '').localeCompare(b.itemNumber || '', undefined, { numeric: true })
    || ((a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0)),
  )
}

// ── Display ──────────────────────────────────────────────────────────────────

// Quantities are measurements, not money — up to three decimals, the app's one
// pinned display locale (ADR-21), never a currency symbol.
const quantityFormatter = new Intl.NumberFormat(CURRENCY_DISPLAY_LOCALE, { maximumFractionDigits: 3 })

export function formatQuantity(quantity) {
  const n = typeof quantity === 'number' ? quantity : Number(quantity)
  if (quantity === null || quantity === undefined || quantity === '' || !Number.isFinite(n)) return '—'
  return quantityFormatter.format(n)
}

// ── Draft validation (shared by the hook and the editor modal) ───────────────

export function validateBoqItemDraft({ description, quantity, unit, rate, costCodeId, costCodeName }) {
  if (!costCodeId) return 'Choose the cost code this item measures.'
  if (!String(costCodeName || '').trim()) return 'The chosen cost code has no display name.'
  if (!String(description || '').trim()) return 'Enter a description.'
  if (!String(unit || '').trim()) return 'Enter a unit of measure.'

  const qty = Number(quantity)
  if (quantity === null || quantity === undefined || quantity === '' || !Number.isFinite(qty)) {
    return 'Enter the measured quantity as a number.'
  }
  if (qty < 0) return 'The quantity cannot be negative.'

  const r = normalizeRate(rate)
  if (r !== null) {
    if (!Number.isFinite(r)) return 'Enter the rate as a number, or leave it blank while unpriced.'
    if (r < 0) return 'The rate cannot be negative. To price an item at nothing, enter 0.'
  }
  return null
}
