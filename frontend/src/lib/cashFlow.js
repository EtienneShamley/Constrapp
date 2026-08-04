import { roundMoney } from './purchaseOrders'
import { safeAmount, toCents, todayIso } from './payments'

// ── Cash Flow (read-time monthly aggregation: actual + forecast) ─────────────
//
// Pure month-key arithmetic and monthly aggregation over three layers:
//
//   LAYER 1 — ACTUAL: the cash-row adapters
//     · lib/clientReceipts.js  → cashInRows()   (posted Client Receipts,  money IN)
//     · lib/supplierPayments.js → cashOutRows() (posted Supplier Payments, money OUT)
//   LAYER 2 — NEAR-TERM FORECAST: open invoice balances by due date
//     · clientInvoiceReconciliationRows()   (issued Client Invoices,  gross)
//     · supplierInvoiceReconciliationRows() (posted Supplier Invoices, payableTotal)
//   LAYER 3 — LONGER-TERM FORECAST: manually timed cashFlowLines
//     · authored gross cash amounts with ex-GST source coverage tracked separately
//
// This module is a PURE consumer. It contains no React, no Firebase, no
// formatting, and no Firestore reads of its own; callers hand it rows the
// existing lib/ helpers already derive. Nothing computed here is ever stored
// (ADR-3/ADR-4) — every monthly figure, coverage figure, and the peak-funding
// trough are derived on every render.
//
// ⚠️ THE BOUNDARY RULE. Months strictly before the current month are ACTUAL
// ONLY: no forecast amount — automatic or manual — ever lands in a past month.
// That is what makes actual-vs-forecast provably non-double-counting: for any
// past month the forecast contribution is structurally zero, so an actual and
// the forecast it fulfilled can never both be counted.
//
// ⚠️ GROSS, NOT ACCRUAL. Cash amounts (actual and forecast alike) are gross,
// inc. GST — the total that moves through the bank, never allocatedTotal.
// `sourceAmountExGst` on a manual line is ex-GST SOURCE COVERAGE, used only for
// completeness, never in a cash column. Gross cash and ex-GST source values are
// never added together into one total.
//
// ⚠️ NOT A BANK BALANCE. The cumulative position starts at ZERO: it is the
// project's net recorded-plus-projected cash movement, not an account balance.
// Constrapp models no bank account, no opening cash position, no financing,
// and no GST/BAS remittance.

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

// ═════════════════════════════════════════════════════════════════════════════
// FORECAST CASH FLOW (layers 2 and 3)
// ═════════════════════════════════════════════════════════════════════════════

// ── cashFlowLines — constants and vocabulary ─────────────────────────────────
//
// A cashFlowLine is an AUTHORED monthly timing input stored at
// companies/{companyId}/projects/{projectId}/cashFlowLines/{lineId}. It carries
// an expected GROSS cash amount (`amount`, the only cash figure) plus an
// optional ex-GST source coverage figure (`sourceAmountExGst`, completeness
// only). Lines never reference or mutate a source financial document — the
// cost-side link is the cost-code spine (`costCodeId` + frozen `costCodeName`).

export const CFL_STATUS = {
  ACTIVE: 'active',
  VOID:   'void',
}

export const CFL_DIRECTION = {
  IN:  'in',
  OUT: 'out',
}

// The only basis in this foundation. `ex_gst` is deliberately NOT defined —
// adding a basis requires a rules change and its own security review.
export const CFL_BASIS_GROSS = 'gross'

// Allowed source types, per direction. `client_invoice` and `supplier_invoice`
// are deliberately EXCLUDED: open invoice balances are timed automatically by
// due date (layer 2), so a manual line against an invoice would double-count
// it. They are reserved for a future invoice-retiming feature. Approved client
// variations are already inside the Current Contract Sum (never a separate
// source), and supplier variations are never in Forecast Final Cost (ADR-19) —
// their expected cost reaches Cash Flow through Uncommitted Cost to Complete.
export const CFL_SOURCE_TYPE = {
  CONTRACT_REVENUE:    'contract_revenue',    // in  — Remaining Uninvoiced Contract Value
  UNINVOICED_CLAIM:    'uninvoiced_claim',    // out — approved claim awaiting a supplier invoice
  REMAINING_COMMITTED: 'remaining_committed', // out — open PO commitment, net of posted invoicing
  UNCOMMITTED_CTC:     'uncommitted_ctc',     // out — Uncommitted Cost to Complete
  MANUAL:              'manual',              // either — no source, no coverage
}

export const CFL_IN_SOURCE_TYPES  = [CFL_SOURCE_TYPE.CONTRACT_REVENUE, CFL_SOURCE_TYPE.MANUAL]
export const CFL_OUT_SOURCE_TYPES = [
  CFL_SOURCE_TYPE.UNINVOICED_CLAIM,
  CFL_SOURCE_TYPE.REMAINING_COMMITTED,
  CFL_SOURCE_TYPE.UNCOMMITTED_CTC,
  CFL_SOURCE_TYPE.MANUAL,
]

export const CFL_SOURCE_TYPE_LABELS = {
  [CFL_SOURCE_TYPE.CONTRACT_REVENUE]:    'Remaining uninvoiced contract value',
  [CFL_SOURCE_TYPE.UNINVOICED_CLAIM]:    'Approved claim awaiting invoice',
  [CFL_SOURCE_TYPE.REMAINING_COMMITTED]: 'Remaining committed (PO)',
  [CFL_SOURCE_TYPE.UNCOMMITTED_CTC]:     'Uncommitted cost to complete',
  [CFL_SOURCE_TYPE.MANUAL]:              'Manual adjustment',
}

// Source types whose ex-GST coverage is tracked for completeness. `manual`
// lines carry sourceAmountExGst: null and contribute NO coverage.
export const CFL_COVERAGE_SOURCE_TYPES = [
  CFL_SOURCE_TYPE.CONTRACT_REVENUE,
  CFL_SOURCE_TYPE.UNINVOICED_CLAIM,
  CFL_SOURCE_TYPE.REMAINING_COMMITTED,
  CFL_SOURCE_TYPE.UNCOMMITTED_CTC,
]

// Cost-side coverage types — these REQUIRE a costCodeId (+ frozen costCodeName
// snapshot), because every cost-side denominator is derived per cost code by
// the existing Budget/Forecast helpers. Revenue sits above the cost-code spine
// (the recorded ADR-20/ADR-22 exception), so contract_revenue carries none.
export const CFL_COST_CODED_SOURCE_TYPES = [
  CFL_SOURCE_TYPE.UNINVOICED_CLAIM,
  CFL_SOURCE_TYPE.REMAINING_COMMITTED,
  CFL_SOURCE_TYPE.UNCOMMITTED_CTC,
]

export const sourceTypesForDirection = (direction) =>
  direction === CFL_DIRECTION.IN ? CFL_IN_SOURCE_TYPES : CFL_OUT_SOURCE_TYPES

export const isCoverageSourceType = (t) => CFL_COVERAGE_SOURCE_TYPES.includes(t)
export const isCostCodedSourceType = (t) => CFL_COST_CODED_SOURCE_TYPES.includes(t)

// ── Line sets ────────────────────────────────────────────────────────────────

export const activeCashFlowLines = (lines) =>
  (lines ?? []).filter(l => l?.status === CFL_STATUS.ACTIVE)

export const voidCashFlowLines = (lines) =>
  (lines ?? []).filter(l => l?.status === CFL_STATUS.VOID)

// Active lines stranded in a PAST month. They contribute to NO month, NO
// cumulative figure, and NO peak funding — the boundary rule — but they are
// never silently deleted or moved: they surface in the stale-forecast panel,
// where the user may retime them (to the current month or later) or void them
// with a reason. A line stranded in a past month is real signal — cash that was
// expected and did not arrive.
export const staleCashFlowLines = (lines, nowMonth) =>
  activeCashFlowLines(lines).filter(l => isMonthKey(l.monthKey) && l.monthKey < nowMonth)

// Active lines that count: valid month key, current month or later.
const countedCashFlowLines = (lines, nowMonth) =>
  activeCashFlowLines(lines).filter(l => isMonthKey(l.monthKey) && l.monthKey >= nowMonth)

// ── Layer 3: manual lines by month ───────────────────────────────────────────

// { 'YYYY-MM': Σ amount } across ACTIVE lines of one direction, current month
// onward. Stale (past-month) and void lines contribute nothing.
export function manualForecastByMonth(lines, direction, nowMonth) {
  const map = {}
  for (const l of countedCashFlowLines(lines, nowMonth)) {
    if (l.direction !== direction) continue
    map[l.monthKey] = roundMoney((map[l.monthKey] || 0) + safeAmount(l.amount))
  }
  return map
}

// ── Layer 2: open invoice balances by due month ──────────────────────────────
//
// Input rows are the EXISTING read-time reconciliation rows —
// clientInvoiceReconciliationRows() (issued invoices, gross remaining) and
// supplierInvoiceReconciliationRows() (posted invoices, payableTotal remaining,
// already net of retention). This function never re-derives a balance.
//
// Classification of each positive remaining balance:
//   · due month ≥ current month  →  timed into that month (byMonth)
//   · due month <  current month →  pastDue — NOT timed. Past months are
//       actual-only, and fabricating a recovery date would be false precision;
//       the balance waits in a dedicated untimed bucket until a future
//       invoice-retiming feature lets the user move it.
//   · blank/invalid due date     →  noDueDate — NOT timed.
//   · remaining < 0 (over-reconciled) → EXCLUDED from every month and returned
//       separately as a signed total — a credit position must never offset a
//       genuine expected receipt or payment.
//
// ⚠️ MONTH-level, not day-level: an invoice due earlier in the CURRENT month is
// still automatically timed (into the current month), not past-due bucketed.
export function classifyInvoiceBalances(rows, nowMonth) {
  const byMonth = {}
  let pastDue = 0
  let noDueDate = 0
  let overReconciled = 0 // signed (≤ 0)

  for (const row of rows ?? []) {
    const remaining = roundMoney(safeAmount(row?.remaining))
    if (toCents(remaining) === 0) continue
    if (toCents(remaining) < 0) {
      overReconciled = roundMoney(overReconciled + remaining)
      continue
    }
    const dueMonth = monthKeyFromDate(row.dueDate)
    if (!dueMonth) {
      noDueDate = roundMoney(noDueDate + remaining)
    } else if (dueMonth < nowMonth) {
      pastDue = roundMoney(pastDue + remaining)
    } else {
      byMonth[dueMonth] = roundMoney((byMonth[dueMonth] || 0) + remaining)
    }
  }
  return { byMonth, pastDue, noDueDate, overReconciled }
}

// Retention withheld on the invoices behind the AP rows — reported alongside
// the forecast because payableTotal EXCLUDES it and retention release is not
// modelled: forecast Cash Out omits it, and no release date is ever invented.
export function sumRetentionWithheld(apRows) {
  return roundMoney((apRows ?? []).reduce((sum, r) => sum + safeAmount(r?.retentionTotal), 0))
}

// ── Combined monthly rows (actual + forecast) ────────────────────────────────
//
// One row per month, DENSE across the union of: actual cash months, automatic
// invoice-forecast months, counted manual-line months, and the current month
// (so the actual/forecast boundary is always visible when any data exists).
//
//   ForecastCashIn(M)  = 0 for M < now, else AR due M + manual in-lines in M
//   ForecastCashOut(M) = 0 for M < now, else AP due M + manual out-lines in M
//   TotalCashIn(M)     = ActualCashIn(M)  + ForecastCashIn(M)
//   TotalCashOut(M)    = ActualCashOut(M) + ForecastCashOut(M)
//   MonthlyNet(M)      = TotalCashIn(M) − TotalCashOut(M)
//   CumulativePosition = 0 + running Σ MonthlyNet      (zero opening position —
//                        project cash movement, NOT a bank balance)
//
// Each row carries isPast/isCurrent so the UI can render past-month forecast
// cells as "—" (not applicable) rather than a fabricated $0 forecast.
export function buildMonthlyCombinedRows({
  inRows = [], outRows = [],
  arForecastByMonth = {}, apForecastByMonth = {},
  manualInByMonth = {}, manualOutByMonth = {},
  nowMonth,
}) {
  const actualIn = cashInByMonth(inRows)
  const actualOut = cashOutByMonth(outRows)

  const keys = [
    ...Object.keys(actualIn), ...Object.keys(actualOut),
    ...Object.keys(arForecastByMonth), ...Object.keys(apForecastByMonth),
    ...Object.keys(manualInByMonth), ...Object.keys(manualOutByMonth),
  ]
  if (keys.length === 0) return []
  if (isMonthKey(nowMonth)) keys.push(nowMonth)

  const sorted = keys.sort(compareMonthKeys)
  let cumulative = 0
  return monthKeyRange(sorted[0], sorted[sorted.length - 1]).map((monthKey) => {
    const isPast = monthKey < nowMonth
    const actualCashIn = roundMoney(actualIn[monthKey] || 0)
    const actualCashOut = roundMoney(actualOut[monthKey] || 0)
    // THE BOUNDARY RULE: no forecast amount ever lands in a past month.
    const forecastCashIn = isPast ? 0
      : roundMoney((arForecastByMonth[monthKey] || 0) + (manualInByMonth[monthKey] || 0))
    const forecastCashOut = isPast ? 0
      : roundMoney((apForecastByMonth[monthKey] || 0) + (manualOutByMonth[monthKey] || 0))
    const totalCashIn = roundMoney(actualCashIn + forecastCashIn)
    const totalCashOut = roundMoney(actualCashOut + forecastCashOut)
    const net = roundMoney(totalCashIn - totalCashOut)
    cumulative = roundMoney(cumulative + net)
    return {
      monthKey,
      isPast,
      isCurrent: monthKey === nowMonth,
      actualCashIn, actualCashOut,
      forecastCashIn, forecastCashOut,
      totalCashIn, totalCashOut,
      net,
      cumulativePosition: cumulative,
    }
  })
}

// Projected closing position = the cumulative position of the LAST month in
// the range (null when there is no data at all).
export function projectedClosingPosition(combinedRows) {
  if (!combinedRows?.length) return null
  return combinedRows[combinedRows.length - 1].cumulativePosition
}

// ── Source coverage (ex-GST — completeness only, NEVER a cash figure) ────────

// Σ sourceAmountExGst across ACTIVE lines of one sourceType. Void lines
// contribute nothing; `manual` lines carry null and contribute nothing. Stale
// lines DO still count as coverage — the source value is claimed even though
// the cash month must be corrected.
export function coverageByType(lines, sourceType) {
  return roundMoney(
    activeCashFlowLines(lines)
      .filter(l => l.sourceType === sourceType)
      .reduce((sum, l) => sum + safeAmount(l.sourceAmountExGst), 0),
  )
}

// Per-cost-code combined COST coverage. ⚠️ THE CORRECTED MODEL: approved-claim
// cost awaiting a supplier invoice sits INSIDE Remaining Committed (an approved
// claim consumes PO commitment, and maturedCommitted subtracts only POSTED
// INVOICING), so `uninvoiced_claim` coverage counts against the SAME
// remaining-committed balance as `remaining_committed` coverage — never
// against a second, additive denominator.
export function committedCoverageByCostCode(lines) {
  const map = {}
  for (const l of activeCashFlowLines(lines)) {
    if (l.sourceType !== CFL_SOURCE_TYPE.REMAINING_COMMITTED
      && l.sourceType !== CFL_SOURCE_TYPE.UNINVOICED_CLAIM) continue
    if (!l.costCodeId) continue
    map[l.costCodeId] = roundMoney((map[l.costCodeId] || 0) + safeAmount(l.sourceAmountExGst))
  }
  return map
}

export function ctcCoverageByCostCode(lines) {
  const map = {}
  for (const l of activeCashFlowLines(lines)) {
    if (l.sourceType !== CFL_SOURCE_TYPE.UNCOMMITTED_CTC) continue
    if (!l.costCodeId) continue
    map[l.costCodeId] = roundMoney((map[l.costCodeId] || 0) + safeAmount(l.sourceAmountExGst))
  }
  return map
}

// ── Untimed forecast values (ex-GST source basis) ────────────────────────────
//
// ⚠️ THE CORRECTED COST MODEL (approved decision):
//
//   D_cost                    = remainingCommittedTotal + uncommittedCtcTotal
//                               (= Cost to Complete — the figure the Forecast
//                                tab already publishes; no new arithmetic)
//   Untimed Remaining Committed = max(0, remainingCommittedTotal
//                                        − coverage('remaining_committed')
//                                        − coverage('uninvoiced_claim'))
//   Untimed Uncommitted CTC     = max(0, uncommittedCtcTotal
//                                        − coverage('uncommitted_ctc'))
//
// Approved-claim cost awaiting an invoice is NOT a second denominator and NOT
// an additional untimed total — it is a labelled breakdown WITHIN Remaining
// Committed ("Approved claim awaiting invoice — included within Remaining
// Committed"). Presenting it additively would double-count it.

export function untimedForecastRevenue({ availableToInvoice, lines }) {
  const remaining = Math.max(0, roundMoney(safeAmount(availableToInvoice)))
  return Math.max(0, roundMoney(remaining - coverageByType(lines, CFL_SOURCE_TYPE.CONTRACT_REVENUE)))
}

export function untimedRemainingCommitted({ remainingCommittedTotal, lines }) {
  return Math.max(0, roundMoney(
    safeAmount(remainingCommittedTotal)
    - coverageByType(lines, CFL_SOURCE_TYPE.REMAINING_COMMITTED)
    - coverageByType(lines, CFL_SOURCE_TYPE.UNINVOICED_CLAIM),
  ))
}

export function untimedUncommittedCtc({ uncommittedCtcTotal, lines }) {
  return Math.max(0, roundMoney(
    safeAmount(uncommittedCtcTotal) - coverageByType(lines, CFL_SOURCE_TYPE.UNCOMMITTED_CTC),
  ))
}

// ── Completeness ─────────────────────────────────────────────────────────────
//
// Percentages are null (rendered "—", NEVER 0% or 100%) whenever the basis is
// unavailable — the same guard lib/margin.js applies to margin percentages.

// Revenue coverage % = Σ contract_revenue coverage ÷ Remaining Uninvoiced
// Contract Value. Returns:
//   { pct, state } where state ∈ 'ok' | 'no_baseline' | 'over_invoiced'
export function revenueCoverage({ baselineEstablished, availableToInvoice, lines }) {
  if (!baselineEstablished) return { pct: null, state: 'no_baseline' }
  const denominator = roundMoney(safeAmount(availableToInvoice))
  if (toCents(denominator) <= 0) return { pct: null, state: 'over_invoiced' }
  const covered = coverageByType(lines, CFL_SOURCE_TYPE.CONTRACT_REVENUE)
  return { pct: roundMoney((covered / denominator) * 100), state: 'ok' }
}

// Cost coverage % = (remaining_committed + uninvoiced_claim + uncommitted_ctc
// coverage) ÷ D_cost, where D_cost = Cost to Complete (the corrected model —
// see above). `incompleteBasis` flags an understated denominator when cost
// codes remain unforecast (unforecastedCount > 0).
export function costCoverage({ remainingCommittedTotal, uncommittedCtcTotal, unforecastedCount = 0, lines }) {
  const denominator = roundMoney(safeAmount(remainingCommittedTotal) + safeAmount(uncommittedCtcTotal))
  const incompleteBasis = safeAmount(unforecastedCount) > 0
  if (toCents(denominator) <= 0) return { pct: null, state: 'no_cost_basis', incompleteBasis }
  const covered = roundMoney(
    coverageByType(lines, CFL_SOURCE_TYPE.REMAINING_COMMITTED)
    + coverageByType(lines, CFL_SOURCE_TYPE.UNINVOICED_CLAIM)
    + coverageByType(lines, CFL_SOURCE_TYPE.UNCOMMITTED_CTC),
  )
  return { pct: roundMoney((covered / denominator) * 100), state: 'ok', incompleteBasis }
}

export const COMPLETENESS_STATE = {
  COMPLETE:    'complete',
  PARTIAL:     'partially_timed',
  INCOMPLETE:  'incomplete_forecast',
  UNAVAILABLE: 'unavailable',
}

// The three-state indicator (plus 'unavailable' when either basis is missing).
// Complete additionally requires NO untimed AR/AP — an invoice balance with no
// due date, or past due and not retimed, is known money without a month.
export function completenessState({ revenue, cost, untimedAR = 0, pastDueAR = 0, untimedAP = 0, pastDueAP = 0 }) {
  if (revenue?.pct === null || cost?.pct === null) return COMPLETENESS_STATE.UNAVAILABLE
  const untimedInvoices = toCents(untimedAR) > 0 || toCents(pastDueAR) > 0
    || toCents(untimedAP) > 0 || toCents(pastDueAP) > 0
  if (revenue.pct >= 100 && cost.pct >= 100 && !untimedInvoices && !cost.incompleteBasis) {
    return COMPLETENESS_STATE.COMPLETE
  }
  if (revenue.pct > 0 || cost.pct > 0) return COMPLETENESS_STATE.PARTIAL
  return COMPLETENESS_STATE.INCOMPLETE
}

// ── Peak funding ─────────────────────────────────────────────────────────────

// Peak Funding Requirement = |lowest negative projected cumulative position|.
// The EARLIEST month wins a tie — the first date funding is needed is the
// actionable one. When the position never goes negative the requirement is 0
// and `negative` is false (the UI says "No funding shortfall projected",
// never "$0").
export function peakFunding(combinedRows) {
  if (!combinedRows?.length) {
    return { requirement: 0, monthKey: null, lowestPosition: null, lowestMonthKey: null, negative: false }
  }
  let lowest = combinedRows[0].cumulativePosition
  let lowestKey = combinedRows[0].monthKey
  for (const row of combinedRows) {
    if (toCents(row.cumulativePosition) < toCents(lowest)) {
      lowest = row.cumulativePosition
      lowestKey = row.monthKey
    }
  }
  const negative = toCents(lowest) < 0
  return {
    requirement: negative ? roundMoney(Math.abs(lowest)) : 0,
    monthKey: negative ? lowestKey : null,
    lowestPosition: lowest,
    lowestMonthKey: lowestKey,
    negative,
  }
}

// Suppression: the HEADLINE peak-funding figure is withheld while significant
// known amounts remain untimed or a basis is unavailable — untimed cost makes
// the trough shallower than reality, so an unqualified number would UNDERSTATE
// the funding need (the dangerous direction). The computed value may then be
// shown only as a clearly-labelled lower bound.
//
// Unallocated cash and retention withheld WARN but never suppress: unallocated
// cash is already correctly counted in actuals, and retention release is not
// modellable at all — suppressing on it would disable peak funding on every
// project that withholds retention. Both exclusions are stated beside the
// figure instead.
export function peakFundingSuppression({
  untimedRevenue = 0, untimedCommitted = 0, untimedCtc = 0,
  untimedAR = 0, pastDueAR = 0, untimedAP = 0, pastDueAP = 0,
  revenueBasisUnavailable = false, costBasisUnavailable = false, costBasisIncomplete = false,
}) {
  const reasons = []
  if (revenueBasisUnavailable) reasons.push('revenue basis unavailable (no baseline, or contract fully/over-invoiced)')
  if (costBasisUnavailable) reasons.push('cost basis unavailable')
  if (costBasisIncomplete) reasons.push('Cost to Complete is incomplete (unforecast cost codes)')
  if (toCents(untimedRevenue) > 0) reasons.push('untimed remaining contract revenue')
  if (toCents(untimedCommitted) > 0) reasons.push('untimed remaining committed cost')
  if (toCents(untimedCtc) > 0) reasons.push('untimed uncommitted cost to complete')
  if (toCents(untimedAR) > 0) reasons.push('client invoice balances with no due date')
  if (toCents(pastDueAR) > 0) reasons.push('past-due client invoice balances not retimed')
  if (toCents(untimedAP) > 0) reasons.push('supplier invoice balances with no due date')
  if (toCents(pastDueAP) > 0) reasons.push('past-due supplier invoice balances not retimed')
  return { suppressed: reasons.length > 0, reasons }
}

// ── GST suggestion (explicit user action ONLY) ───────────────────────────────
//
// Backs the "+ GST 10%" button beside the gross-amount field. NEVER applied
// automatically — per-line tax codes mean a flat 10% is a suggestion, not a
// calculation, and the user must press the button (the allocateOldestFirst /
// remainingBudgetSuggestion precedent).
export function gstSuggestedGross(sourceAmountExGst) {
  return roundMoney(safeAmount(sourceAmountExGst) * 1.1)
}

// ── Over-coverage warning (warned + acknowledged, NEVER blocked) ─────────────
//
// ⚠️ NOT ENFORCED, AND NOT ENFORCEABLE. Firestore rules cannot sum sibling
// cashFlowLines, so no rule can stop several lines together claiming more
// ex-GST coverage than a source balance holds. Two users can also time the
// same balance concurrently. This is an advisory warning requiring an explicit
// acknowledgement — the Deferred-Control 14/16/18 posture.
//
// `balances` supplies the source denominators the caller already derives:
//   { availableToInvoice, remainingCommittedByCostCode, uncommittedCtcByCostCode }
// Under the corrected model, remaining_committed and uninvoiced_claim lines
// share one balance per cost code.
export function coverageOverWarning({ sourceType, costCodeId, sourceAmountExGst, lines, excludeLineId = null, balances = {} }) {
  if (!isCoverageSourceType(sourceType)) return null
  const others = activeCashFlowLines(lines).filter(l => l.id !== excludeLineId)

  let balance
  let alreadyCovered
  if (sourceType === CFL_SOURCE_TYPE.CONTRACT_REVENUE) {
    balance = Math.max(0, roundMoney(safeAmount(balances.availableToInvoice)))
    alreadyCovered = coverageByType(others, CFL_SOURCE_TYPE.CONTRACT_REVENUE)
  } else if (sourceType === CFL_SOURCE_TYPE.UNCOMMITTED_CTC) {
    balance = roundMoney(safeAmount(balances.uncommittedCtcByCostCode?.[costCodeId]))
    alreadyCovered = roundMoney(safeAmount(ctcCoverageByCostCode(others)[costCodeId]))
  } else {
    // remaining_committed and uninvoiced_claim share ONE balance per cost code.
    balance = roundMoney(safeAmount(balances.remainingCommittedByCostCode?.[costCodeId]))
    alreadyCovered = roundMoney(safeAmount(committedCoverageByCostCode(others)[costCodeId]))
  }

  const excess = roundMoney(safeAmount(sourceAmountExGst) + alreadyCovered - balance)
  if (toCents(excess) <= 0) return null
  return {
    excess,
    message:
      `Combined coverage for this source would exceed its remaining balance by ${excess.toFixed(2)} (ex-GST). ` +
      'This is allowed — check whether another timing line already covers the same balance.',
  }
}

// ── Line validation (client-enforced) ────────────────────────────────────────
//
// ⚠️ Firestore rules enforce shape only (month-key pattern, direction, basis,
// positive amount, coverage-shape, non-empty description, currency shape,
// lifecycle). Everything below — the allowed source types per direction, the
// cost-code requirement, the coverage requirement, and ABOVE ALL the
// no-past-month rule — is client-side and bypassable by a direct SDK call.
// Rules validate the YYYY-MM shape but have no calendar to compare against.
export function validateCashFlowLineDraft({
  direction, sourceType, monthKey, amount, sourceAmountExGst,
  costCodeId, costCodeName, description,
}, nowMonth) {
  if (direction !== CFL_DIRECTION.IN && direction !== CFL_DIRECTION.OUT) {
    return 'Choose whether this line is cash in or cash out.'
  }
  if (!sourceTypesForDirection(direction).includes(sourceType)) {
    return 'Choose a source for this line.'
  }
  if (!isMonthKey(monthKey)) return 'Enter the month as YYYY-MM.'
  // A forecast line in a past month is fabricated history: past months are
  // actual-only. Existing lines BECOME stale naturally as the calendar moves;
  // creating or editing one into the past is blocked here.
  if (nowMonth && monthKey < nowMonth) {
    return `The month (${monthKey}) is in the past. Forecast months start at the current month (${nowMonth}).`
  }

  const cash = Number(amount)
  if (!Number.isFinite(cash)) return 'Enter the expected gross cash amount as a number.'
  if (cash <= 0) return 'The gross cash amount must be greater than zero. For a reduction, add a line in the opposite direction.'

  if (sourceType === CFL_SOURCE_TYPE.MANUAL) {
    if (sourceAmountExGst !== null && sourceAmountExGst !== undefined && sourceAmountExGst !== '') {
      return 'A manual adjustment carries no source coverage — leave the source amount blank.'
    }
  } else {
    const cov = Number(sourceAmountExGst)
    if (sourceAmountExGst === null || sourceAmountExGst === undefined || sourceAmountExGst === ''
      || !Number.isFinite(cov)) {
      return 'Enter the ex-GST source amount this line represents (used for completeness only).'
    }
    if (cov < 0) return 'The ex-GST source amount cannot be negative.'
  }

  if (isCostCodedSourceType(sourceType)) {
    if (!costCodeId) return 'Choose the cost code this line times.'
    if (!String(costCodeName || '').trim()) return 'The chosen cost code has no display name.'
  } else if (costCodeId) {
    return 'This source has no cost code — contract revenue and manual adjustments sit above the cost-code spine.'
  }

  if (!String(description || '').trim()) return 'Enter a description.'
  return null
}
