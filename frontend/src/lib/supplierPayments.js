import { roundMoney } from './purchaseOrders'
import { SI_STATUS } from './supplierInvoices'
import { creditedByInvoice } from './supplierCreditNotes'
import {
  PAYMENT_STATUS, PAYMENT_COUNTING_STATUSES, MAX_ALLOCATIONS,
  allocatedTotal, allocationTotals, invoiceBalance, remainingBalance,
  reconciliationState, RECONCILIATION_STATE,
  ageBalances, toCents, safeAmount,
  isFutureDate, isIsoDateShape, todayIso, daysPastDue,
  validateAmount, validatePaymentMethod, validateAllocations,
} from './payments'

// ── Supplier Payments (accounts payable — money OUT) ─────────────────────────
//
// The AP-specific adapter over lib/payments.js, and the exact mirror of
// lib/clientReceipts.js on the money-in side. A Supplier Payment records CASH
// ACTUALLY PAID to a supplier or subcontractor, with embedded allocations
// against POSTED Supplier Invoices.
//
// ⚠️ NOTHING HERE WRITES TO A SUPPLIER INVOICE. Paid to Date, Remaining Payable,
// reconciliation state, and the AP ageing are ALL derived at read time from
// payment documents (ADR-3/ADR-4). Invoice documents are never stamped, never
// given a balance field, never given a payment back-reference, and — decisively
// — `status` is never moved to `paid` and `paidAt` is never set (ADR-24).
// This is also why voiding a payment restores every balance for free.
//
// ⚠️ CASH IS NOT COST. A payment settles an Actual cost that a POSTED supplier
// invoice already recognised. It feeds no budget figure, no forecast figure and
// no margin figure: Budgeted, Committed, Claimed, Invoiced, Actual, Remaining
// Committed, Forecast Final Cost and every margin figure are unchanged by this
// module.
//
// ⚠️ PAYMENTS SETTLE `payableTotal`, NEVER `grossTotal`. See below.

export const SUPPLIER_PAYMENT_COUNTER_ID = 'supplierPayments'

export const SP_DOC_TYPE = {
  PAYMENT: 'payment',
  REFUND:  'refund', // reserved — a refund is money moving BACK from a supplier
                     // and is a different event from voiding a mis-keyed payment.
}

export const formatSupplierPaymentNumber = (n) => `SP-${String(n).padStart(4, '0')}`

// ── Payment sets ─────────────────────────────────────────────────────────────

export const postedSupplierPayments = (payments) =>
  (payments ?? []).filter(p => PAYMENT_COUNTING_STATUSES.includes(p.status))

export const draftSupplierPayments = (payments) =>
  (payments ?? []).filter(p => p.status === PAYMENT_STATUS.DRAFT)

// The invoices a payment can settle. `posted` is the FINANCIAL COMMIT POINT of a
// supplier invoice (ADR-17) — `approved` means internally certified only, so
// paying an approved-but-unposted invoice would let cash leave before the Actual
// cost exists. Draft and cancelled invoices are excluded for the same reason.
//
// NOTE: SI_COUNTING_STATUSES also contains the deprecated `paid` (see
// lib/supplierInvoices.js). It is deliberately NOT used here: reconciliation is
// derived from payment allocations, so a forged `paid` invoice must not appear
// as a payable balance. It still counts toward Invoiced/Actual over there, which
// is the safe failure mode.
export const isPayableInvoice = (inv) => inv?.status === SI_STATUS.POSTED

export const postedSupplierInvoices = (invoices) =>
  (invoices ?? []).filter(isPayableInvoice)

// ── Payable basis ────────────────────────────────────────────────────────────
//
// ⚠️ ALLOCATIONS RECONCILE AGAINST `payableTotal`, NEVER `grossTotal`.
//
//     payableTotal = grossTotal − retentionTotal
//
// `grossTotal` is the FULL TAXABLE SUPPLY — the face value of the supplier's tax
// invoice. `payableTotal` is what is actually DUE on it, already net of the
// retention withheld (and of retention's own GST — see lib/supplierInvoices.js →
// invoiceTotals). For a claim-sourced invoice `payableTotal` equals the approved
// claim's `approvedTotal` by construction.
//
// Using gross would present RETAINED money as currently payable and would leave
// a permanent phantom balance on every retained invoice that could never be
// settled. Retention becomes payable through a future Retention Release
// document, which is NOT modelled — and no payment ever writes, clears or
// reduces `retention`, `retentionGst` or `retentionTotal`.
export const payableBasis = (invoice) => roundMoney(safeAmount(invoice?.payableTotal))

export const RETENTION_HELPER_TEXT =
  'Payments settle the net payable on each invoice, after retention withheld. Retention is not payable on ' +
  'this invoice and is never reduced by a payment. Retention release is not yet modelled in Constrapp.'

// ── Supplier identity matching ───────────────────────────────────────────────
//
// Mirrors the module-private `normaliseName` in lib/supplierInvoices.js (used by
// duplicateInvoiceWarnings). It is reproduced rather than imported because that
// helper is not exported and this branch changes only comments in that file —
// keep the two implementations identical if either is ever touched.
export const normaliseSupplierName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

// True when a supplier invoice belongs to the selected supplier.
//
// A NEW Supplier Payment always carries a real `supplierId` (rules-enforced).
// Supplier INVOICES may legitimately carry `supplierId: null` — they were raised
// against pre-Contacts POs and are never backfilled (ADR-15). Those are matched
// on the frozen `supplierName` snapshot instead.
//
// ⚠️ CLIENT-ENFORCED. Firestore rules cannot iterate an allocations array or
// get() per element, so neither branch below is verified server-side. A direct
// SDK call can allocate a payment to any supplier's invoice.
export function supplierMatchesInvoice(invoice, supplierId, supplierName) {
  if (!invoice) return false
  if (invoice.supplierId) return !!supplierId && invoice.supplierId === supplierId
  return normaliseSupplierName(invoice.supplierName) === normaliseSupplierName(supplierName)
}

// True when the match was made on the frozen NAME because the invoice predates
// the Contacts module. Surfaced in the UI so the user knows the link is fuzzy.
export const isLegacyNameMatch = (invoice) => !!invoice && !invoice.supplierId

export const LEGACY_SUPPLIER_MATCH_NOTE =
  'Matched by supplier name — this invoice predates the Contacts module.'

// ── Read-time invoice reconciliation ─────────────────────────────────────────

// { supplierInvoiceId: Σ allocatedAmount } across POSTED payments only.
//
// Drafts have moved no money; void payments moved none either (or the record was
// wrong). Both are excluded here, which is exactly why voiding a posted payment
// restores the invoice's Remaining Payable immediately at the next render — with
// no reversal document and no write to the invoice.
export function paidByInvoice(payments) {
  const map = {}
  for (const p of postedSupplierPayments(payments)) {
    for (const a of p.allocations ?? []) {
      if (!a?.supplierInvoiceId) continue
      map[a.supplierInvoiceId] = roundMoney((map[a.supplierInvoiceId] || 0) + safeAmount(a.allocatedAmount))
    }
  }
  return map
}

// Remaining Payable for ONE supplier invoice, net of everything that settled
// or reduced it: payableTotal − paid − credited. SIGNED and never clamped: an
// overpaid or over-credited invoice shows a negative balance, because hiding
// an over-reconciled position is precisely the problem this module exists to
// expose. A negative balance whose cause includes a posted credit note is
// money recoverable FROM the supplier — surfaced, never auto-refunded
// (refunds remain unmodelled).
export function remainingPayable(invoice, paid, credited = 0) {
  return remainingBalance(payableBasis(invoice), roundMoney(safeAmount(paid) + safeAmount(credited)))
}

// One invoice's full derived AP position: { total, settled, remaining, state }.
// `settled` blends cash paid AND posted valid-target credits — both reduce
// what remains payable; callers needing the split use the reconciliation rows.
export function invoiceReconciliation(invoice, paidMap = {}, creditedMap = {}) {
  return invoiceBalance(
    payableBasis(invoice),
    roundMoney((paidMap[invoice?.id] || 0) + (creditedMap[invoice?.id] || 0)),
  )
}

// Reconciliation rows for the POSTED supplier invoices of a project.
// `creditNotes` are Supplier Credit Notes: posted, valid-target credits reduce
// the remaining payable by their GROSS total (lib/supplierCreditNotes.js).
// Cash paid and credit reduction are carried as SEPARATE columns — they are
// different facts — and only their sum settles the payable.
export function supplierInvoiceReconciliationRows(invoices, payments, creditNotes = []) {
  const paid = paidByInvoice(payments)
  const credited = creditedByInvoice(creditNotes, invoices)
  return postedSupplierInvoices(invoices).map(inv => {
    const paidAmount     = roundMoney(paid[inv.id] || 0)
    const creditedAmount = roundMoney(credited[inv.id] || 0)
    return {
      id:                    inv.id,
      invoiceNumber:         inv.invoiceNumber,
      supplierInvoiceNumber: inv.supplierInvoiceNumber || '',
      supplierId:            inv.supplierId ?? null,
      supplierName:          inv.supplierName || '',
      invoiceDate:           inv.invoiceDate || '',
      dueDate:               inv.dueDate || '',
      grossTotal:            roundMoney(safeAmount(inv.grossTotal)),
      retentionTotal:        roundMoney(safeAmount(inv.retentionTotal)),
      payableTotal:          payableBasis(inv),
      paid:                  paidAmount,
      credited:              creditedAmount,
      remaining:             remainingPayable(inv, paidAmount, creditedAmount),
      state:                 reconciliationState(payableBasis(inv), roundMoney(paidAmount + creditedAmount)),
    }
  })
}

// Project-level payables totals, all read-time.
export function payablesSummary(invoices, payments, creditNotes = []) {
  const rows = supplierInvoiceReconciliationRows(invoices, payments, creditNotes)
  let postedPayable = 0
  let paid = 0
  let credited = 0
  let remaining = 0
  let overReconciled = 0
  for (const r of rows) {
    postedPayable = roundMoney(postedPayable + r.payableTotal)
    paid          = roundMoney(paid + r.paid)
    credited      = roundMoney(credited + r.credited)
    // Only positive balances are payable. A negative (over-reconciled) balance
    // is reported separately so it can never silently offset genuine arrears in
    // a single netted number.
    if (toCents(r.remaining) > 0) remaining = roundMoney(remaining + r.remaining)
    if (toCents(r.remaining) < 0) overReconciled = roundMoney(overReconciled + r.remaining)
  }
  return { rows, postedPayable, paid, credited, remaining, overReconciled, count: rows.length }
}

export const overReconciledPayableRows = (rows) =>
  (rows ?? []).filter(r => r.state === RECONCILIATION_STATE.OVER)

// ── Payment-side summaries ───────────────────────────────────────────────────

// Cash actually paid, plus how much of it is matched to an invoice.
//
// `unallocated` is surfaced on its own and is NEVER netted against any invoice:
// money paid on account has not been matched to a debt, and auto-applying it
// would be an accounting policy Constrapp is not making on the user's behalf.
export function paymentSummary(payments) {
  const posted = postedSupplierPayments(payments)
  const drafts = draftSupplierPayments(payments)

  let postedAmount = 0
  let allocated = 0
  let unallocated = 0
  for (const p of posted) {
    postedAmount = roundMoney(postedAmount + safeAmount(p.amount))
    allocated    = roundMoney(allocated + safeAmount(p.allocatedTotal))
    unallocated  = roundMoney(unallocated + safeAmount(p.unallocatedAmount))
  }

  let draftAmount = 0
  for (const p of drafts) draftAmount = roundMoney(draftAmount + safeAmount(p.amount))

  return {
    postedCount: posted.length,
    postedAmount,
    allocated,
    unallocated,
    draftCount: drafts.length,
    draftAmount,
  }
}

// Posted payments that allocated against one invoice — the "allocated payments"
// table on the supplier invoice detail view.
export function paymentsForInvoice(payments, supplierInvoiceId) {
  const out = []
  for (const p of postedSupplierPayments(payments)) {
    for (const a of p.allocations ?? []) {
      if (a?.supplierInvoiceId !== supplierInvoiceId) continue
      out.push({
        id:                  p.id,
        paymentNumber:       p.paymentNumber,
        paymentDate:         p.paymentDate || '',
        paymentMethod:       p.paymentMethod || '',
        paymentMethodOther:  p.paymentMethodOther || '',
        bankReference:       p.bankReference || '',
        remittanceReference: p.remittanceReference || '',
        allocatedAmount:     roundMoney(safeAmount(a.allocatedAmount)),
      })
    }
  }
  return out
}

// ── Allocation targets ───────────────────────────────────────────────────────

// The invoices a payment may allocate against: POSTED, in THIS project,
// belonging to the SELECTED SUPPLIER (by id, or by frozen name for legacy
// pre-Contacts invoices).
//
// ⚠️ CLIENT-ENFORCED. Firestore rules cannot verify any of this — checking each
// allocation's target would need a get() per array element, and rules cannot
// iterate an array. A direct SDK call can allocate against anything.
//
// `excludePaymentId` removes the payment being edited from the "already paid"
// figures, so editing a draft never double-counts its own allocations.
//
// Sorted OLDEST FIRST (invoiceDate, then invoiceNumber) so the picker order and
// the "Allocate oldest first" proposal agree.
export function allocatableSupplierInvoices(invoices, supplierId, supplierName, payments, { excludePaymentId = null, creditNotes = [] } = {}) {
  const others = (payments ?? []).filter(p => p.id !== excludePaymentId)
  const paid = paidByInvoice(others)
  // Posted credit notes REDUCE what remains payable, so the picker offers the
  // net figure — paying a credited slice would over-reconcile immediately.
  const credited = creditedByInvoice(creditNotes, invoices)
  return postedSupplierInvoices(invoices)
    .filter(inv => !!supplierId && supplierMatchesInvoice(inv, supplierId, supplierName))
    .map(inv => ({
      id:                    inv.id,
      invoiceNumber:         inv.invoiceNumber,
      supplierInvoiceNumber: inv.supplierInvoiceNumber || '',
      invoiceDate:           inv.invoiceDate || '',
      dueDate:               inv.dueDate || '',
      grossTotal:            roundMoney(safeAmount(inv.grossTotal)),
      retentionTotal:        roundMoney(safeAmount(inv.retentionTotal)),
      payableTotal:          payableBasis(inv),
      paid:                  roundMoney(paid[inv.id] || 0),
      credited:              roundMoney(credited[inv.id] || 0),
      remaining:             remainingPayable(inv, paid[inv.id] || 0, credited[inv.id] || 0),
      legacyNameMatch:       isLegacyNameMatch(inv),
    }))
    .sort((a, b) => (a.invoiceDate || '').localeCompare(b.invoiceDate || '')
                 || (a.invoiceNumber || '').localeCompare(b.invoiceNumber || ''))
}

// Proposes allocations across the oldest outstanding invoices first.
//
// ⚠️ THIS NEVER RUNS ON ITS OWN. It is invoked only from an explicit
// "Allocate oldest first" button press and returns a PROPOSAL the user can edit
// or discard before saving. It must never fire when the editor opens, when the
// supplier changes, when the amount changes, when an invoice is added, or when a
// payment is posted. Constrapp does not silently decide which debt a payment
// settles — that is an accounting policy decision.
export function allocateOldestFirst(amount, rows) {
  let remainingCash = toCents(amount)
  const out = []
  for (const row of rows ?? []) {
    if (remainingCash <= 0) break
    const owed = toCents(row.remaining)
    if (owed <= 0) continue
    const take = Math.min(owed, remainingCash)
    remainingCash -= take
    out.push({
      supplierInvoiceId:     row.id,
      invoiceNumber:         row.invoiceNumber,
      supplierInvoiceNumber: row.supplierInvoiceNumber || '',
      allocatedAmount:       roundMoney(take / 100),
    })
  }
  return out
}

// ── Over-reconciliation (warned, never blocked) ──────────────────────────────
//
// ⚠️ NOT ENFORCED, AND NOT ENFORCEABLE. Firestore rules have no list, query, or
// count, so no rule can sum what OTHER payments have already allocated to an
// invoice. Two users can allocate the same remaining payable concurrently and
// both writes succeed. These are advisory warnings requiring an explicit
// acknowledgement — never a guarantee. See docs/SECURITY.md → Deferred Controls.
export function invoiceOverPaymentWarnings(allocations, invoices, payments, { excludePaymentId = null, creditNotes = [] } = {}) {
  const others = (payments ?? []).filter(p => p.id !== excludePaymentId)
  const paid = paidByInvoice(others)
  const credited = creditedByInvoice(creditNotes, invoices)
  const byId = new Map((invoices ?? []).map(inv => [inv.id, inv]))

  const warnings = []
  for (const a of allocations ?? []) {
    const inv = byId.get(a?.supplierInvoiceId)
    if (!inv) continue
    const alreadyPaid = paid[inv.id] || 0
    const remaining = remainingPayable(inv, alreadyPaid, credited[inv.id] || 0)
    const excess = roundMoney(safeAmount(a.allocatedAmount) - remaining)
    if (toCents(excess) <= 0) continue
    warnings.push({
      field: 'allocation',
      supplierInvoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      excess,
      message:
        `${inv.invoiceNumber} would be paid beyond its remaining payable by ${excess.toFixed(2)}. ` +
        'This is allowed — check for a duplicate payment or a supplier credit still to be raised.',
    })
  }
  return warnings
}

// ── Allocation exceptions ────────────────────────────────────────────────────
//
// A posted supplier invoice can be CANCELLED after a payment was posted against
// it. Rules cannot prevent that — supplier-invoice lifecycle legality is still
// client-enforced (docs/SECURITY.md → Deferred Controls 1 and 2), so a direct
// SDK call can cancel a posted invoice. Constrapp surfaces the result rather
// than automating a fix:
//
//   · the CASH STAYS REAL — the payment keeps its amount and stays counted;
//   · the ALLOCATION becomes an exception, shown here;
//   · the cancelled invoice stays out of AP ageing (it is cancelled);
//   · nothing is deleted, reassigned, or reversed automatically.
//
// The same panel reports a supplier mismatch and an unreadable/missing invoice.
export function allocationExceptions(payments, invoices) {
  const byId = new Map((invoices ?? []).map(inv => [inv.id, inv]))
  const out = []
  for (const p of postedSupplierPayments(payments)) {
    for (const a of p.allocations ?? []) {
      const inv = byId.get(a?.supplierInvoiceId)
      const reason = !inv
        ? 'The allocated supplier invoice no longer exists or is not readable.'
        : inv.status === SI_STATUS.CANCELLED
          ? `${inv.invoiceNumber} was cancelled after this payment was posted. Posted supplier-invoice lifecycle is not yet enforced by Firestore rules, so this can happen through a direct SDK call.`
          : !isPayableInvoice(inv)
            ? `${inv.invoiceNumber} is ${inv.status} — only posted supplier invoices can be paid.`
            : !supplierMatchesInvoice(inv, p.supplierId, p.supplierName)
              ? `${inv.invoiceNumber} belongs to a different supplier (${inv.supplierName || 'unknown'}) than this payment.`
              : null
      if (!reason) continue
      out.push({
        paymentId:             p.id,
        paymentNumber:         p.paymentNumber,
        invoiceNumber:         a.invoiceNumber || inv?.invoiceNumber || '—',
        supplierInvoiceNumber: a.supplierInvoiceNumber || inv?.supplierInvoiceNumber || '',
        allocatedAmount:       roundMoney(safeAmount(a.allocatedAmount)),
        reason,
      })
    }
  }
  return out
}

export const ALLOCATION_EXCEPTION_REMEDY =
  'The payment and its cash remain recorded — nothing is reversed automatically. Investigate first; where the ' +
  'payment itself was wrong, void it and record a new one against the correct invoice. Cancelled invoices stay ' +
  'out of AP ageing.'

// ── AP ageing ────────────────────────────────────────────────────────────────
//
// Ages the REMAINING PAYABLE of each posted supplier invoice after posted
// payment allocations — not the invoice's original gross or payable value.
//
//   · fully reconciled invoices contribute zero and leave ageing entirely;
//   · partially reconciled invoices age only their remainder;
//   · over-reconciled invoices are excluded and returned in `overSettled` for a
//     dedicated callout (a negative balance must never offset real arrears);
//   · voiding a payment restores the balance at the next render;
//   · unallocated payments reduce NO invoice balance and appear nowhere here;
//   · posted valid-target CREDIT NOTES reduce the aged balance — a credited
//     slice is no longer owed, so it must not age as arrears;
//   · RETENTION IS EXCLUDED throughout — the basis is payableTotal, which is
//     already net of retention withheld.
export function apAgeing(invoices, payments, creditNotes = [], now = new Date()) {
  const rows = supplierInvoiceReconciliationRows(invoices, payments, creditNotes)
  return ageBalances(
    rows,
    { dueDateOf: (r) => r.dueDate, balanceOf: (r) => r.remaining },
    now,
  )
}

// Past its due date AND still payable.
//
// ⚠️ Use THIS, not `isOverdue` in lib/supplierInvoices.js, for anything that
// presents a past-due FIGURE or badge. `isOverdue` is deliberately DATE-ONLY and
// has no knowledge of payments, so it reports a fully-paid invoice as overdue.
//
// Deliberately NOT named "unpaid": *paid* and *unpaid* are never used as an
// authored supplier-invoice status (ADR-24). The user-facing wording is
// "Past due".
export function isPastDuePayable(invoice, remaining, now = new Date()) {
  if (!isPayableInvoice(invoice)) return false
  if (!invoice?.dueDate) return false
  const due = new Date(`${invoice.dueDate}T00:00:00`)
  if (Number.isNaN(due.getTime())) return false
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!(due < today)) return false
  return toCents(remaining) > 0
}

// Still honest about what is NOT enforced.
export const AP_RECONCILIATION_NOTICE =
  'Balances reflect posted Supplier Payments allocated to each invoice, net of posted Supplier Credit Notes. ' +
  'Constrapp warns but does not block over-reconciliation, and cannot prevent two users allocating the same ' +
  'remaining payable concurrently. Unallocated payments are shown separately and reduce no invoice balance. ' +
  'Retention withheld is excluded — retention release is not modelled.'

// ── Validation (client-enforced) ─────────────────────────────────────────────

// Returns an error message, or null when the draft is saveable.
//
// ⚠️ Firestore rules enforce the document's SHAPE, lifecycle, and the scalar
// amount invariant only. The business checks below (supplier match, invoice
// status, allocation targets, payable basis) are client-side and bypassable by a
// direct SDK call. Never describe them as enforced.
export function validatePaymentDraft({
  supplierId, supplierName, paymentDate, amount,
  paymentMethod, paymentMethodOther, allocations,
  invoices = null,
}) {
  if (!supplierId) return 'Select the supplier this money was paid to.'
  if (!String(supplierName || '').trim()) return 'The selected supplier has no display name.'
  if (!isIsoDateShape(paymentDate)) return 'Enter the date the money left your account.'

  const amountError = validateAmount(amount)
  if (amountError) return amountError

  const methodError = validatePaymentMethod(paymentMethod, paymentMethodOther)
  if (methodError) return methodError

  const allocationError = validateAllocations(allocations, amount, 'supplierInvoiceId')
  if (allocationError) return allocationError

  // Target checks, when the caller supplies the invoice list.
  if (invoices) {
    const byId = new Map(invoices.map(inv => [inv.id, inv]))
    for (const a of allocations ?? []) {
      const inv = byId.get(a.supplierInvoiceId)
      if (!inv) return 'An allocated supplier invoice could not be found on this project.'
      if (!isPayableInvoice(inv)) {
        return `${inv.invoiceNumber} is ${inv.status} — only posted supplier invoices can be paid.`
      }
      if (!supplierMatchesInvoice(inv, supplierId, supplierName)) {
        return `${inv.invoiceNumber} belongs to a different supplier. Every allocated invoice must belong to the selected supplier.`
      }
    }
  }
  return null
}

// Why a draft cannot be posted yet, or null when it can.
//
// A FUTURE-DATED draft may be SAVED (so a payment can be prepared ahead of a
// scheduled run) but must not be POSTED: posting asserts that money has actually
// left the account, and Cash Flow will consume paymentDate as real Cash Out.
//
// ⚠️ CLIENT-ENFORCED. Firestore rules validate only the 'YYYY-MM-DD' SHAPE of
// paymentDate — rules have no reliable calendar comparison against the caller's
// local date, so a direct SDK call can post a future-dated payment. Backdating
// is always allowed (entering last month's bank statement is the normal case).
export function postBlockedReason(payment, now = new Date()) {
  if (!payment) return 'Payment not found.'
  if (payment.status !== PAYMENT_STATUS.DRAFT) {
    return `Only a draft payment can be posted — this one is ${payment.status}.`
  }
  if (isFutureDate(payment.paymentDate, now)) {
    return `The payment date (${payment.paymentDate}) is in the future. A payment records money already ` +
           `paid, so it can only be posted on or after that date — or correct the date to ${todayIso(now)} or earlier.`
  }
  return null
}

export const isFutureDatedPayment = (payment, now = new Date()) =>
  isFutureDate(payment?.paymentDate, now)

// Builds the stored allocation array from editor rows, dropping empty rows and
// freezing BOTH invoice references so a register row renders without reading
// invoice documents (the frozen supplierName/costCodeName idiom):
//
//   · invoiceNumber         — Constrapp's SI-#### number
//   · supplierInvoiceNumber — the supplier's own reference (e.g. INV-4471),
//                             which is what AP staff reconcile against
//
// A supplier invoice with no supplier reference snapshots '' rather than
// inventing one.
export function buildAllocations(rows, invoices) {
  const byId = new Map((invoices ?? []).map(inv => [inv.id, inv]))
  return (rows ?? [])
    .filter(r => r.supplierInvoiceId && Number(r.allocatedAmount) > 0)
    .map(r => {
      const inv = byId.get(r.supplierInvoiceId)
      return {
        supplierInvoiceId:     r.supplierInvoiceId,
        invoiceNumber:         inv?.invoiceNumber || r.invoiceNumber || '',
        supplierInvoiceNumber: inv?.supplierInvoiceNumber || r.supplierInvoiceNumber || '',
        allocatedAmount:       roundMoney(Number(r.allocatedAmount)),
      }
    })
}

// Both invoice references, for display and search: "SI-0007 · INV-4471".
export function allocationInvoiceLabel(allocation) {
  const si  = allocation?.invoiceNumber || '—'
  const ref = String(allocation?.supplierInvoiceNumber || '').trim()
  return ref ? `${si} · ${ref}` : si
}

// ── Cash Flow readiness (data only — no Cash Flow UI in this branch) ─────────
//
// One row per POSTED, non-void payment. `projectId` is supplied by the caller
// because it is NOT stored on the document — the collection path already carries
// it (adding a redundant copy would create a second, driftable source of truth).
//
// ⚠️ CASH OUT IS THE TOTAL `amount`, NEVER `allocatedTotal`. The whole amount
// left the bank; a supplier advance is real cash out even though it settles
// nothing yet. The allocated/unallocated split travels alongside for analysis,
// never instead of the cash figure.
//
// ⚠️ Cash Flow must group by `paymentDate` (e.g. `paymentDate.slice(0, 7)`) and
// NEVER by `createdAt`/`postedAt`, and must never sum across currencies — one
// currency per project, and there is no FX.
export function cashOutRows(payments, { projectId } = {}) {
  return postedSupplierPayments(payments).map(p => ({
    paymentId:         p.id,
    paymentNumber:     p.paymentNumber,
    amount:            roundMoney(safeAmount(p.amount)),
    paymentDate:       p.paymentDate || '',
    projectId:         projectId ?? null,
    supplierId:        p.supplierId ?? null,
    supplierName:      p.supplierName || '',
    currency:          p.currency || '',
    allocatedTotal:    roundMoney(safeAmount(p.allocatedTotal)),
    unallocatedAmount: roundMoney(safeAmount(p.unallocatedAmount)),
  }))
}

// Re-exported so pages import ONE module for supplier-payment behaviour.
export { allocatedTotal, allocationTotals, MAX_ALLOCATIONS, daysPastDue }
