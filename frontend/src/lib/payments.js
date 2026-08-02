import { roundMoney } from './purchaseOrders'

// ── Payments & Receipts — shared, direction-agnostic primitives ──────────────
//
// This module holds ONLY what both cash directions genuinely share:
//
//   · Client Receipts   — money IN  (implemented; lib/clientReceipts.js)
//   · Supplier Payments — money OUT (a separate future branch)
//
// It is deliberately free of document shapes, builders, and UI logic for either
// direction: those live in the direction adapter. Nothing here knows what a
// client, a supplier, or an invoice is — it knows amounts, allocations,
// balances, lifecycle, and ageing.
//
// ⚠️ CASH, NOT ACCRUAL. A payment/receipt amount is ACTUAL GROSS MONEY that
// moved. It carries no GST, no tax code, no net amount, and no revenue or profit
// meaning. Tax was already recorded on the invoice being reconciled; a cash
// movement is not a new taxable supply, so recomputing GST here would both
// double-count the tax and disagree with the invoice on a partial payment.
//
// ⚠️ NOTHING IS STORED ON AN INVOICE. Every balance below is derived at READ
// TIME from transaction documents (ADR-3/ADR-4). No received total, balance,
// reconciliation state, or transaction reference is ever written onto an invoice.

// ── Lifecycle ────────────────────────────────────────────────────────────────
//
// Forward-only, matching the app's other financial lifecycles.
//
//   draft ──▶ posted ──▶ void        (void is terminal)
//     └────────────────▶ void
//
// `posted` (not "confirmed" or "reconciled") is the financial commit point,
// matching supplierInvoices. "Reconciled" is deliberately NOT used as a
// transaction status: it names the DERIVED state of an invoice, and reusing it
// here would blur the two ideas the module exists to keep apart.
export const PAYMENT_STATUS = {
  DRAFT:  'draft',
  POSTED: 'posted',
  VOID:   'void',
}

export const PAYMENT_STATUS_LABELS = {
  [PAYMENT_STATUS.DRAFT]:  'Draft',
  [PAYMENT_STATUS.POSTED]: 'Posted',
  [PAYMENT_STATUS.VOID]:   'Void',
}

// Maps each status onto an existing Badge variant — no new colours.
export const PAYMENT_BADGE_VARIANTS = {
  [PAYMENT_STATUS.DRAFT]:  'soon',
  [PAYMENT_STATUS.POSTED]: 'active',
  [PAYMENT_STATUS.VOID]:   'danger',
}

// Void is terminal; there is no un-post and no return to draft. Corrections are
// a void plus a new transaction, preserving the audit story (ADR-11/ADR-12).
//
// These transitions are ALSO enforced by Firestore rules (see
// frontend/firestore.rules → clientReceipts). This map stays the single
// client-side source of truth so the UI and the rules cannot drift.
export const PAYMENT_TRANSITIONS = {
  [PAYMENT_STATUS.DRAFT]:  [PAYMENT_STATUS.POSTED, PAYMENT_STATUS.VOID],
  [PAYMENT_STATUS.POSTED]: [PAYMENT_STATUS.VOID],
  [PAYMENT_STATUS.VOID]:   [],
}

export const canTransition = (from, to) => (PAYMENT_TRANSITIONS[from] ?? []).includes(to)

// The single counting point. A draft has moved no money and a void transaction
// never moved money; only `posted` contributes to any balance.
export const PAYMENT_COUNTING_STATUSES = [PAYMENT_STATUS.POSTED]

// Content (amount, date, method, references, allocations) is editable only
// while draft. Posting freezes everything — rules-enforced.
export const PAYMENT_EDITABLE_STATUSES = [PAYMENT_STATUS.DRAFT]

export const isPosted = (txn) => txn?.status === PAYMENT_STATUS.POSTED
export const isDraft  = (txn) => txn?.status === PAYMENT_STATUS.DRAFT
export const isVoid   = (txn) => txn?.status === PAYMENT_STATUS.VOID

// ── Payment method ───────────────────────────────────────────────────────────
//
// A small controlled list. It is NOT defaulted for the user: an unselected
// method is an unanswered question, and silently recording "bank transfer" for
// cash received over the counter would fabricate a fact.
//
// Firestore rules validate the SHAPE of `paymentMethod` (a non-empty, bounded
// string), NOT membership of this enum. ADR-21's reasoning applies: an enum
// duplicated into a manually-published rules file drifts out of sync with this
// module and starts rejecting valid writes. The enum check is client-side.
export const PAYMENT_METHOD = {
  BANK_TRANSFER: 'bank_transfer',
  CARD:          'card',
  CASH:          'cash',
  CHEQUE:        'cheque',
  DIRECT_DEBIT:  'direct_debit',
  OTHER:         'other',
}

export const PAYMENT_METHODS = Object.values(PAYMENT_METHOD)

export const PAYMENT_METHOD_LABELS = {
  [PAYMENT_METHOD.BANK_TRANSFER]: 'Bank transfer',
  [PAYMENT_METHOD.CARD]:          'Card',
  [PAYMENT_METHOD.CASH]:          'Cash',
  [PAYMENT_METHOD.CHEQUE]:        'Cheque',
  [PAYMENT_METHOD.DIRECT_DEBIT]:  'Direct debit',
  [PAYMENT_METHOD.OTHER]:         'Other',
}

export const isPaymentMethod = (m) => PAYMENT_METHODS.includes(m)

export const paymentMethodLabel = (method, other = '') =>
  method === PAYMENT_METHOD.OTHER && String(other || '').trim()
    ? `Other — ${String(other).trim()}`
    : (PAYMENT_METHOD_LABELS[method] ?? method ?? '—')

// ── Allocation limits ────────────────────────────────────────────────────────
//
// Bounds the embedded array so one document cannot approach Firestore's 1 MiB
// limit (the ADR-6 embedded-array trade-off). Mirrored in firestore.rules, which
// CAN check `allocations.size()` even though it cannot inspect the elements.
export const MAX_ALLOCATIONS = 100

// ── Allocation arithmetic ────────────────────────────────────────────────────
//
// Every figure passes through roundMoney (round-half-up to cents, ADR-10) so
// totals reconcile to the cent against accounting exports later.

export const safeAmount = (n) => {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) ? v : 0
}

// Σ of allocated amounts on one transaction.
export function allocatedTotal(allocations) {
  return roundMoney((allocations ?? []).reduce((sum, a) => sum + safeAmount(a?.allocatedAmount), 0))
}

// Unallocated Amount = Transaction Amount − Allocated Total.
//
// Stored alongside allocatedTotal at write time SPECIFICALLY so Firestore rules
// can enforce the one arithmetic invariant they are capable of:
//
//     allocatedTotal + unallocatedAmount == amount    (compared in whole cents)
//
// Rules cannot iterate the allocations array, so they cannot verify that
// allocatedTotal equals its sum — that remains client-enforced. What they DO
// prevent is a document CLAIMING more allocation than the transaction amount.
export function unallocatedAmount(amount, allocated) {
  return roundMoney(safeAmount(amount) - safeAmount(allocated))
}

// The pair, derived together so a caller can never write one without the other.
export function allocationTotals(amount, allocations) {
  const allocated = allocatedTotal(allocations)
  return { allocatedTotal: allocated, unallocatedAmount: unallocatedAmount(amount, allocated) }
}

// True when the scalar invariant holds to the cent. Mirrors the rules check, so
// a write the client considers valid is never rejected by the rules for
// floating-point reasons (and vice versa). Money is decimal; IEEE-754 addition
// of 0.10 + 0.20 is 0.30000000000000004, so exact equality is unusable — both
// sides compare WHOLE CENTS instead. This is a representation fix, not a
// loosened invariant: any difference of one cent or more still fails.
export const toCents = (n) => Math.round(safeAmount(n) * 100)

export const scalarInvariantHolds = (amount, allocated, unallocated) =>
  toCents(allocated) + toCents(unallocated) === toCents(amount)

// ── Reconciliation state (derived — NEVER an authored invoice status) ────────
//
// An invoice's payment position is a FUNCTION of posted allocations, computed on
// every render. It is never stored, and the words "paid"/"unpaid" are never used
// as an invoice status anywhere in the product (ADR-22).
export const RECONCILIATION_STATE = {
  UNRECONCILED: 'unreconciled',
  PARTLY:       'partly_reconciled',
  FULLY:        'fully_reconciled',
  OVER:         'over_reconciled',
}

export const RECONCILIATION_LABELS = {
  [RECONCILIATION_STATE.UNRECONCILED]: 'Unreconciled',
  [RECONCILIATION_STATE.PARTLY]:       'Partly reconciled',
  [RECONCILIATION_STATE.FULLY]:        'Fully reconciled',
  [RECONCILIATION_STATE.OVER]:         'Over-reconciled',
}

export const RECONCILIATION_BADGE_VARIANTS = {
  [RECONCILIATION_STATE.UNRECONCILED]: 'soon',
  [RECONCILIATION_STATE.PARTLY]:       'pending',
  [RECONCILIATION_STATE.FULLY]:        'active',
  [RECONCILIATION_STATE.OVER]:         'danger',
}

// Remaining balance on one invoice. SIGNED and never clamped: an over-settled
// invoice shows a negative balance, because hiding an over-reconciled position
// is precisely the problem this module exists to expose (the same posture as
// Available to Invoice).
export function remainingBalance(invoiceTotal, settled) {
  return roundMoney(safeAmount(invoiceTotal) - safeAmount(settled))
}

// Compared in whole cents so a cent-exact settlement reads as FULLY reconciled
// rather than leaving a floating-point crumb behind.
export function reconciliationState(invoiceTotal, settled) {
  const total = toCents(invoiceTotal)
  const paid  = toCents(settled)
  if (paid <= 0)     return RECONCILIATION_STATE.UNRECONCILED
  if (paid < total)  return RECONCILIATION_STATE.PARTLY
  if (paid === total) return RECONCILIATION_STATE.FULLY
  return RECONCILIATION_STATE.OVER
}

// One invoice's full derived position, used by both the register and the ageing.
export function invoiceBalance(invoiceTotal, settled) {
  const total    = roundMoney(safeAmount(invoiceTotal))
  const received = roundMoney(safeAmount(settled))
  return {
    total,
    settled:   received,
    remaining: remainingBalance(total, received),
    state:     reconciliationState(total, received),
  }
}

// ── Dates ────────────────────────────────────────────────────────────────────
//
// Transaction dates are 'YYYY-MM-DD' STRINGS, matching every other human-entered
// financial date in the app (invoiceDate, dueDate, receivedDate, periodEnding).
// A cash date is the calendar date on a bank statement, not an instant — storing
// a Timestamp would attach timezone semantics to a fact that has none, and the
// future Cash Flow module can group by month with `date.slice(0, 7)` without
// constructing a Date at all.

const pad2 = (n) => String(n).padStart(2, '0')

export const toIsoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

export const todayIso = (now = new Date()) => toIsoDate(now)

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const isIsoDateShape = (s) => typeof s === 'string' && ISO_DATE_PATTERN.test(s)

// True when a transaction date is later than the viewer's current calendar day.
//
// ⚠️ Compared in the VIEWER'S LOCAL TIMEZONE — there is no timezone
// normalisation, so a date can read as "future" a few hours early or late for a
// user in another timezone. The same documented limitation as daysPastDue.
export function isFutureDate(dateStr, now = new Date()) {
  if (!isIsoDateShape(dateStr)) return false
  return dateStr > todayIso(now)
}

// Days a date string is past `now` (negative when still in the future). Date-only
// comparison in the viewer's local timezone — see the note above.
export function daysPastDue(dueDate, now = new Date()) {
  if (!dueDate) return null
  const due = new Date(`${dueDate}T00:00:00`)
  if (Number.isNaN(due.getTime())) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((today - due) / 86400000)
}

// ── Ageing ───────────────────────────────────────────────────────────────────
//
// Generic bucketing by due date over a caller-supplied BALANCE. Shared so the
// future accounts-payable ageing reuses this exact logic rather than
// re-deriving it.
//
// ⚠️ The caller supplies the balance, and that is the whole point: ageing must
// age what is still OUTSTANDING, never the original invoice value. A fully
// reconciled invoice contributes zero and drops out.
export const AGEING_BUCKETS = [
  { key: 'noDueDate', label: 'No due date' },
  { key: 'notYetDue', label: 'Not yet due' },
  { key: 'd1_30',     label: 'Past due 1–30 days' },
  { key: 'd31_60',    label: 'Past due 31–60 days' },
  { key: 'd61_90',    label: 'Past due 61–90 days' },
  { key: 'd90plus',   label: 'Past due 90+ days' },
]

export const PAST_DUE_BUCKET_KEYS = ['d1_30', 'd31_60', 'd61_90', 'd90plus']

export function ageingBucketKey(days) {
  if (days === null) return 'noDueDate'
  if (days <= 0)  return 'notYetDue'
  if (days <= 30) return 'd1_30'
  if (days <= 60) return 'd31_60'
  if (days <= 90) return 'd61_90'
  return 'd90plus'
}

// Buckets `items` by due date on their remaining balance.
//
// `dueDateOf(item)` → 'YYYY-MM-DD' | ''    `balanceOf(item)` → number
//
// Items with a balance of zero or less are EXCLUDED entirely: a settled invoice
// is not receivable, and a NEGATIVE (over-reconciled) balance would silently
// offset genuine arrears in the same bucket. Over-reconciled items are returned
// separately in `overSettled` so the caller can surface them in their own
// callout rather than hiding them inside an ageing total.
export function ageBalances(items, { dueDateOf, balanceOf }, now = new Date()) {
  const buckets = {}
  for (const b of AGEING_BUCKETS) buckets[b.key] = { amount: 0, count: 0 }

  let total = 0
  let pastDue = 0
  const overSettled = []

  for (const item of items ?? []) {
    const balance = roundMoney(safeAmount(balanceOf(item)))
    if (toCents(balance) < 0) {
      overSettled.push(item)
      continue
    }
    if (toCents(balance) === 0) continue

    const key = ageingBucketKey(daysPastDue(dueDateOf(item), now))
    buckets[key].amount = roundMoney(buckets[key].amount + balance)
    buckets[key].count += 1
    total = roundMoney(total + balance)
    if (PAST_DUE_BUCKET_KEYS.includes(key)) pastDue = roundMoney(pastDue + balance)
  }

  return { buckets, total: roundMoney(total), pastDue: roundMoney(pastDue), overSettled }
}

// ── Shared validation ────────────────────────────────────────────────────────
//
// ⚠️ CLIENT-ENFORCED. These run in the hook and the UI. Firestore rules enforce
// the document's SHAPE and lifecycle, not these business checks — a direct SDK
// call bypasses everything below. Never describe them as enforced.

// The transaction amount: real money, so strictly positive.
export function validateAmount(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return 'Enter the amount as a number.'
  if (n <= 0) return 'Amount must be greater than zero.'
  return null
}

// Method must be explicitly chosen; "other" must be described.
export function validatePaymentMethod(paymentMethod, paymentMethodOther) {
  if (!paymentMethod) return 'Select how the money was transferred.'
  if (!isPaymentMethod(paymentMethod)) return 'Select a payment method from the list.'
  if (paymentMethod === PAYMENT_METHOD.OTHER && !String(paymentMethodOther || '').trim()) {
    return 'Describe the payment method.'
  }
  return null
}

// Structural allocation checks that apply in both directions. `idKey` names the
// target-invoice field ('clientInvoiceId' here, 'supplierInvoiceId' later).
//
// Over-allocating the TRANSACTION is hard-blocked here (the money does not
// exist). Over-allocating an INVOICE is not checked here — it is warned with an
// explicit acknowledgement by the direction adapter, because it cannot be
// enforced anywhere (rules cannot sum sibling documents).
export function validateAllocations(allocations, amount, idKey) {
  const list = allocations ?? []
  if (list.length > MAX_ALLOCATIONS) {
    return `A single transaction cannot carry more than ${MAX_ALLOCATIONS} allocations.`
  }

  const seen = new Set()
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (!a?.[idKey]) return `Allocation ${i + 1}: choose an invoice.`
    if (seen.has(a[idKey])) return 'The same invoice is allocated twice — combine those rows instead.'
    seen.add(a[idKey])

    const amt = Number(a.allocatedAmount)
    if (!Number.isFinite(amt)) return `Allocation ${i + 1}: amount must be a number.`
    if (amt <= 0) return `Allocation ${i + 1}: amount must be greater than zero.`
  }

  const allocated = allocatedTotal(list)
  if (toCents(allocated) > toCents(amount)) {
    return 'Allocations exceed the amount of this transaction. Reduce an allocation, or increase the amount.'
  }
  return null
}
