import { roundMoney } from './purchaseOrders'
import { safeAmount, todayIso } from './payments'

// ── Cash Flow (actual — read-time monthly aggregation) ───────────────────────
//
// Pure month-key arithmetic and monthly aggregation over the cash-row adapters:
//
//   · lib/clientReceipts.js  → cashInRows()   (posted Client Receipts,  money IN)
//   · lib/supplierPayments.js → cashOutRows() (posted Supplier Payments, money OUT)
//
// This module is a PURE consumer. It contains no React, no Firebase, no
// formatting, and no document shapes of its own; it knows month keys, amounts,
// and running totals. Nothing computed here is ever stored (ADR-3/ADR-4) — the
// monthly rows and cumulative position are derived on every render.
//
// ⚠️ ACTUAL CASH ONLY. Everything here is recorded cash movement. Forecast Cash
// Flow (invoice due-date collections, manual monthly timing, peak funding) is a
// separate, later foundation — no forecast figure exists in this module.
//
// ⚠️ GROSS, NOT ACCRUAL. Cash rows carry the TOTAL transaction amount (never
// allocatedTotal — an unallocated advance is still cash that moved), dated by
// receiptDate/paymentDate (never createdAt/postedAt). Cash is gross (inc. GST)
// and must never be added to an ex-GST budget, forecast, or margin figure.
//
// ⚠️ NOT A BANK BALANCE. The cumulative position starts at ZERO: it is the
// project's net recorded cash movement, not an account balance. Constrapp
// models no bank account, no opening cash position, and no financing.

// ── Month keys ───────────────────────────────────────────────────────────────
//
// A month key is a 'YYYY-MM' string. Transaction dates are 'YYYY-MM-DD' strings
// whose shape is rules-enforced on both cash collections, so a month key is
// derived with `date.slice(0, 7)` — no Date construction, no timezone
// semantics, and lexicographic order IS chronological order.

export const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

export const isMonthKey = (s) => typeof s === 'string' && MONTH_KEY_PATTERN.test(s)

// 'YYYY-MM-DD' → 'YYYY-MM', or null when the input is not a plausible ISO date
// string. Null (never a guessed month) keeps a malformed date out of the table;
// the transaction-date shape is rules-enforced, so this is defensive only.
export function monthKeyFromDate(dateString) {
  if (typeof dateString !== 'string') return null
  const key = dateString.slice(0, 7)
  return isMonthKey(key) && /^\d{4}-\d{2}-\d{2}$/.test(dateString) ? key : null
}

// The month containing "now", from the same local-calendar clock the cash
// modules already use (lib/payments.js → todayIso). Deliberately the app's ONE
// timezone-sensitive value — do not introduce a second clock.
export const currentMonthKey = (now = new Date()) => todayIso(now).slice(0, 7)

// ── Month labels ─────────────────────────────────────────────────────────────
//
// A fixed lookup, NOT toLocaleDateString: the app's date formatter is pinned to
// en-AU (a recorded limitation, ADR-21), and a month label must not inherit a
// locale at all — 'Aug 2026' is unambiguous everywhere.

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function monthLabel(monthKey) {
  if (!isMonthKey(monthKey)) return '—'
  return `${MONTH_NAMES[Number(monthKey.slice(5, 7)) - 1]} ${monthKey.slice(0, 4)}`
}

// ── Month ordering & ranges ──────────────────────────────────────────────────

// Zero-padded ISO month keys sort lexicographically in chronological order.
export const compareMonthKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// Dense inclusive range: every month from startKey to endKey, crossing year
// boundaries by pure integer arithmetic (no Date). Invalid or inverted bounds
// yield an empty array.
export function monthKeyRange(startKey, endKey) {
  if (!isMonthKey(startKey) || !isMonthKey(endKey) || startKey > endKey) return []
  const out = []
  let year = Number(startKey.slice(0, 4))
  let month = Number(startKey.slice(5, 7))
  const endYear = Number(endKey.slice(0, 4))
  const endMonth = Number(endKey.slice(5, 7))
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`)
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  return out
}

// ── Monthly grouping ─────────────────────────────────────────────────────────
//
// Rows are grouped by their TRANSACTION date — receiptDate for cash in,
// paymentDate for cash out. Those are the dates money moved; createdAt and
// postedAt are entry/commit facts and are never consulted. Every accumulation
// passes through roundMoney (ADR-10) so monthly totals reconcile to the cent.

// Generic: { 'YYYY-MM': Σ amount } over rows keyed by `dateField`. Rows whose
// date does not parse to a month key are skipped (defensive — the date shape is
// rules-enforced on both source collections). Does not mutate `rows`.
function amountsByMonth(rows, dateField) {
  const map = {}
  for (const row of rows ?? []) {
    const key = monthKeyFromDate(row?.[dateField])
    if (!key) continue
    map[key] = roundMoney((map[key] || 0) + safeAmount(row.amount))
  }
  return map
}

// { 'YYYY-MM': cash in } across cashInRows (posted receipts), by receiptDate.
export const cashInByMonth = (inRows) => amountsByMonth(inRows, 'receiptDate')

// { 'YYYY-MM': cash out } across cashOutRows (posted payments), by paymentDate.
export const cashOutByMonth = (outRows) => amountsByMonth(outRows, 'paymentDate')

// The earliest and latest months holding any posted cash, in either direction.
// Returns { earliest, latest } or null when there is no posted cash at all.
export function cashMonthSpan(inRows, outRows) {
  const keys = [
    ...Object.keys(cashInByMonth(inRows)),
    ...Object.keys(cashOutByMonth(outRows)),
  ].sort(compareMonthKeys)
  if (keys.length === 0) return null
  return { earliest: keys[0], latest: keys[keys.length - 1] }
}

// ── Totals ───────────────────────────────────────────────────────────────────
//
// Whole-project actuals over the TOTAL transaction amounts. Independent of any
// month grouping, so a (theoretical) malformed date can never drop cash from
// the headline totals.

export function totalActualCashIn(inRows) {
  return roundMoney((inRows ?? []).reduce((sum, r) => sum + safeAmount(r.amount), 0))
}

export function totalActualCashOut(outRows) {
  return roundMoney((outRows ?? []).reduce((sum, r) => sum + safeAmount(r.amount), 0))
}

// Actual Net Cash = Actual Cash In − Actual Cash Out.
export function actualNetCash(cashIn, cashOut) {
  return roundMoney(safeAmount(cashIn) - safeAmount(cashOut))
}

// ── Monthly actual rows ──────────────────────────────────────────────────────
//
// One row per month, DENSE from the earliest to the latest posted-cash month —
// a gap month renders as a zero row rather than disappearing, because a
// cumulative curve with holes misstates timing.
//
//   Monthly Actual Net    = Actual Cash In − Actual Cash Out        (per month)
//   Cumulative Position   = 0 + running Σ of Monthly Actual Net
//
// The cumulative position starts at ZERO by design: it is net recorded cash
// movement on this project, NOT a bank balance (no opening balance exists or
// is implied). Returns [] when there is no posted cash.
export function buildMonthlyActualRows(inRows, outRows) {
  const inByMonth = cashInByMonth(inRows)
  const outByMonth = cashOutByMonth(outRows)
  const span = cashMonthSpan(inRows, outRows)
  if (!span) return []

  let cumulative = 0
  return monthKeyRange(span.earliest, span.latest).map((monthKey) => {
    const actualCashIn = roundMoney(inByMonth[monthKey] || 0)
    const actualCashOut = roundMoney(outByMonth[monthKey] || 0)
    const actualNet = roundMoney(actualCashIn - actualCashOut)
    cumulative = roundMoney(cumulative + actualNet)
    return { monthKey, actualCashIn, actualCashOut, actualNet, cumulativePosition: cumulative }
  })
}

// Unallocated cash totals are NOT re-derived here. The page reuses the existing
// receiptSummary() (lib/clientReceipts.js) and paymentSummary()
// (lib/supplierPayments.js) — one derivation per figure, never two.
