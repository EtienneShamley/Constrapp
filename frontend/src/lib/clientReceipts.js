import { roundMoney } from './purchaseOrders'
import { CI_STATUS, isPastDue } from './clientInvoices'
import {
  PAYMENT_STATUS, PAYMENT_COUNTING_STATUSES, MAX_ALLOCATIONS,
  allocatedTotal, allocationTotals, invoiceBalance, remainingBalance,
  reconciliationState, RECONCILIATION_STATE,
  ageBalances, toCents, safeAmount,
  isFutureDate, isIsoDateShape, todayIso,
  validateAmount, validatePaymentMethod, validateAllocations,
} from './payments'

// ── Client Receipts (accounts receivable — money IN) ─────────────────────────
//
// The AR-specific adapter over lib/payments.js. A Client Receipt records CASH
// ACTUALLY RECEIVED from a head-contract client, with embedded allocations
// against issued Client Invoices.
//
// ⚠️ NOTHING HERE WRITES TO A CLIENT INVOICE. Received to Date, Remaining to
// Reconcile, reconciliation state, and the corrected AR ageing are ALL derived
// at read time from receipt documents (ADR-3/ADR-4). Invoice documents are never
// stamped, never given a balance field, and never given a receipt back-reference
// — which is also why voiding a receipt restores every balance for free.
//
// ⚠️ CASH IS NOT REVENUE. A receipt amount is gross money received. It feeds no
// budget figure, no forecast, no margin figure, and no revenue recognition.

export const CLIENT_RECEIPT_COUNTER_ID = 'clientReceipts'

export const CR_DOC_TYPE = {
  RECEIPT: 'receipt',
  REFUND:  'refund', // reserved — a refund is money moving BACK to the client and
                     // is a different event from voiding a mis-keyed receipt.
}

export const formatClientReceiptNumber = (n) => `CR-${String(n).padStart(4, '0')}`

// ── Receipt sets ─────────────────────────────────────────────────────────────

export const postedClientReceipts = (receipts) =>
  (receipts ?? []).filter(r => PAYMENT_COUNTING_STATUSES.includes(r.status))

export const draftClientReceipts = (receipts) =>
  (receipts ?? []).filter(r => r.status === PAYMENT_STATUS.DRAFT)

// ── Read-time invoice reconciliation ─────────────────────────────────────────

// { clientInvoiceId: Σ allocatedAmount } across POSTED receipts only.
//
// Drafts have moved no money; void receipts moved none either (or the record was
// wrong). Both are excluded here, which is exactly why voiding a posted receipt
// restores the invoice's balance immediately at the next render — with no
// reversal document and no write to the invoice.
export function receivedByInvoice(receipts) {
  const map = {}
  for (const r of postedClientReceipts(receipts)) {
    for (const a of r.allocations ?? []) {
      if (!a?.clientInvoiceId) continue
      map[a.clientInvoiceId] = roundMoney((map[a.clientInvoiceId] || 0) + safeAmount(a.allocatedAmount))
    }
  }
  return map
}

// Remaining to Reconcile for ONE client invoice.
//
// Measured against grossTotal (inc. GST), because gross is what the client was
// actually billed and therefore what they pay. (Client invoices carry no
// retention and no payable/gross split — ADR-22 — so gross is unambiguous.)
// SIGNED and never clamped.
export function remainingToReconcile(invoice, received) {
  return remainingBalance(invoice?.grossTotal, received)
}

// One invoice's full derived AR position.
export function invoiceReconciliation(invoice, receivedMap = {}) {
  return invoiceBalance(invoice?.grossTotal, receivedMap[invoice?.id] || 0)
}

// Reconciliation rows for the issued, non-void invoices of a project.
//
// Only ISSUED invoices can be reconciled: a draft has billed nothing, and a void
// invoice is nothing forever. Both are excluded from every AR figure.
export function clientInvoiceReconciliationRows(invoices, receipts) {
  const received = receivedByInvoice(receipts)
  return (invoices ?? [])
    .filter(inv => inv.status === CI_STATUS.ISSUED)
    .map(inv => ({
      id:             inv.id,
      invoiceNumber:  inv.invoiceNumber,
      clientId:       inv.clientId ?? null,
      clientName:     inv.clientName || '',
      invoiceDate:    inv.invoiceDate || '',
      dueDate:        inv.dueDate || '',
      grossTotal:     roundMoney(safeAmount(inv.grossTotal)),
      received:       roundMoney(received[inv.id] || 0),
      remaining:      remainingToReconcile(inv, received[inv.id] || 0),
      state:          reconciliationState(inv.grossTotal, received[inv.id] || 0),
    }))
}

// Project-level receivables totals, all read-time.
export function receivablesSummary(invoices, receipts) {
  const rows = clientInvoiceReconciliationRows(invoices, receipts)
  let issuedGross = 0
  let received = 0
  let remaining = 0
  let overReconciled = 0
  for (const r of rows) {
    issuedGross = roundMoney(issuedGross + r.grossTotal)
    received    = roundMoney(received + r.received)
    // Only positive balances are receivable. A negative (over-reconciled)
    // balance is reported separately so it can never silently offset genuine
    // arrears in a single netted number.
    if (toCents(r.remaining) > 0) remaining = roundMoney(remaining + r.remaining)
    if (toCents(r.remaining) < 0) overReconciled = roundMoney(overReconciled + r.remaining)
  }
  return { rows, issuedGross, received, remaining, overReconciled }
}

export const overReconciledRows = (rows) =>
  (rows ?? []).filter(r => r.state === RECONCILIATION_STATE.OVER)

// ── Receipt-side summaries ───────────────────────────────────────────────────

// Cash actually received, plus how much of it is matched to an invoice.
//
// `unallocated` is surfaced on its own and is NEVER netted against any invoice:
// money on account has not been matched to a debt, and auto-applying it would be
// an accounting policy Constrapp is not making on the user's behalf.
export function receiptSummary(receipts) {
  const posted = postedClientReceipts(receipts)
  const drafts = draftClientReceipts(receipts)

  let postedAmount = 0
  let allocated = 0
  let unallocated = 0
  for (const r of posted) {
    postedAmount = roundMoney(postedAmount + safeAmount(r.amount))
    allocated    = roundMoney(allocated + safeAmount(r.allocatedTotal))
    unallocated  = roundMoney(unallocated + safeAmount(r.unallocatedAmount))
  }

  let draftAmount = 0
  for (const r of drafts) draftAmount = roundMoney(draftAmount + safeAmount(r.amount))

  return {
    postedCount: posted.length,
    postedAmount,
    allocated,
    unallocated,
    draftCount: drafts.length,
    draftAmount,
  }
}

// Posted receipts that allocated against one invoice — the "linked receipts"
// table on the invoice detail view.
export function receiptsForInvoice(receipts, clientInvoiceId) {
  const out = []
  for (const r of postedClientReceipts(receipts)) {
    for (const a of r.allocations ?? []) {
      if (a?.clientInvoiceId !== clientInvoiceId) continue
      out.push({
        id:              r.id,
        receiptNumber:   r.receiptNumber,
        receiptDate:     r.receiptDate || '',
        paymentMethod:   r.paymentMethod || '',
        paymentMethodOther: r.paymentMethodOther || '',
        bankReference:   r.bankReference || '',
        allocatedAmount: roundMoney(safeAmount(a.allocatedAmount)),
      })
    }
  }
  return out
}

// ── Allocation targets ───────────────────────────────────────────────────────

// The invoices a receipt may allocate against: ISSUED, non-void, belonging to
// the SELECTED CLIENT, in THIS project.
//
// ⚠️ CLIENT-ENFORCED. Firestore rules cannot verify any of this — checking each
// allocation's target would need a get() per array element, and rules cannot
// iterate an array. A direct SDK call can allocate against anything.
//
// `excludeReceiptId` removes the receipt being edited from the "already
// received" figures, so editing a draft does not double-count its own
// allocations (drafts contribute nothing anyway, but a posted-receipt edit path
// must never silently misreport a balance).
export function allocatableInvoices(invoices, clientId, receipts, { excludeReceiptId = null } = {}) {
  const others = (receipts ?? []).filter(r => r.id !== excludeReceiptId)
  const received = receivedByInvoice(others)
  return (invoices ?? [])
    .filter(inv => inv.status === CI_STATUS.ISSUED)
    .filter(inv => !!clientId && inv.clientId === clientId)
    .map(inv => ({
      id:            inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate:   inv.invoiceDate || '',
      dueDate:       inv.dueDate || '',
      grossTotal:    roundMoney(safeAmount(inv.grossTotal)),
      received:      roundMoney(received[inv.id] || 0),
      remaining:     remainingToReconcile(inv, received[inv.id] || 0),
    }))
    .sort((a, b) => (a.invoiceDate || '').localeCompare(b.invoiceDate || '')
                 || (a.invoiceNumber || '').localeCompare(b.invoiceNumber || ''))
}

// Proposes allocations across the oldest outstanding invoices first.
//
// ⚠️ THIS NEVER RUNS ON ITS OWN. It is invoked only from an explicit
// "Allocate oldest first" button press and returns a PROPOSAL the user can edit
// or discard before saving. Constrapp does not silently decide which debt a
// client's money settles.
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
      clientInvoiceId: row.id,
      invoiceNumber:   row.invoiceNumber,
      allocatedAmount: roundMoney(take / 100),
    })
  }
  return out
}

// ── Over-allocation (warned, never blocked) ──────────────────────────────────
//
// ⚠️ NOT ENFORCED, AND NOT ENFORCEABLE. Firestore rules have no list, query, or
// count, so no rule can sum what OTHER receipts have already allocated to an
// invoice. Two users can allocate the same remaining balance concurrently and
// both writes succeed. These are advisory warnings requiring an explicit
// acknowledgement — never a guarantee. See docs/SECURITY.md → Deferred Controls.
export function invoiceOverAllocationWarnings(allocations, invoices, receipts, { excludeReceiptId = null } = {}) {
  const others = (receipts ?? []).filter(r => r.id !== excludeReceiptId)
  const received = receivedByInvoice(others)
  const byId = new Map((invoices ?? []).map(inv => [inv.id, inv]))

  const warnings = []
  for (const a of allocations ?? []) {
    const inv = byId.get(a?.clientInvoiceId)
    if (!inv) continue
    const alreadyReceived = received[inv.id] || 0
    const remaining = remainingToReconcile(inv, alreadyReceived)
    const excess = roundMoney(safeAmount(a.allocatedAmount) - remaining)
    if (toCents(excess) <= 0) continue
    warnings.push({
      field: 'allocation',
      clientInvoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      excess,
      message:
        `${inv.invoiceNumber} would be reconciled beyond its remaining balance by ${excess.toFixed(2)}. ` +
        'This is allowed — check for a duplicate receipt or a credit still to be raised.',
    })
  }
  return warnings
}

// ── Allocation exceptions ────────────────────────────────────────────────────
//
// An issued invoice can be voided AFTER a receipt was posted against it. Rules
// cannot prevent that (voiding needs no cross-document read), so it is surfaced
// rather than automated:
//
//   · the CASH STAYS REAL — the receipt keeps its amount and stays counted;
//   · the ALLOCATION becomes an exception, shown here;
//   · the void invoice stays out of ageing (it is void);
//   · nothing is deleted, reassigned, or reversed automatically.
//
// Remedy (documented, manual): void the receipt and re-record it against the
// correct invoice, or leave it and allocate a new receipt.
export function allocationExceptions(receipts, invoices) {
  const byId = new Map((invoices ?? []).map(inv => [inv.id, inv]))
  const out = []
  for (const r of postedClientReceipts(receipts)) {
    for (const a of r.allocations ?? []) {
      const inv = byId.get(a?.clientInvoiceId)
      const reason = !inv
        ? 'The allocated invoice no longer exists or is not readable.'
        : inv.status === CI_STATUS.VOID
          ? `${inv.invoiceNumber} was voided after this receipt was posted.`
          : inv.status !== CI_STATUS.ISSUED
            ? `${inv.invoiceNumber} is not an issued invoice.`
            : null
      if (!reason) continue
      out.push({
        receiptId:       r.id,
        receiptNumber:   r.receiptNumber,
        invoiceNumber:   a.invoiceNumber || inv?.invoiceNumber || '—',
        allocatedAmount: roundMoney(safeAmount(a.allocatedAmount)),
        reason,
      })
    }
  }
  return out
}

export const ALLOCATION_EXCEPTION_REMEDY =
  'The receipt and its cash remain recorded — nothing is reversed automatically. To correct it, void the ' +
  'receipt and record a new one against the correct invoice. Voided invoices stay out of ageing.'

// ── Corrected AR ageing ──────────────────────────────────────────────────────
//
// Ages the REMAINING BALANCE of each issued invoice after posted receipt
// allocations — not the invoice's original gross value.
//
//   · fully reconciled invoices contribute zero and leave ageing entirely;
//   · partially reconciled invoices age only their remainder;
//   · over-reconciled invoices are excluded and returned in `overSettled` for a
//     dedicated callout (a negative balance must never offset real arrears);
//   · voiding a receipt restores the balance at the next render;
//   · unallocated receipts reduce NO invoice balance and appear nowhere here.
export function arAgeing(invoices, receipts, now = new Date()) {
  const rows = clientInvoiceReconciliationRows(invoices, receipts)
  return ageBalances(
    rows,
    { dueDateOf: (r) => r.dueDate, balanceOf: (r) => r.remaining },
    now,
  )
}

// Past its due date AND still owing.
//
// `isPastDue` in lib/clientInvoices.js is deliberately DATE-ONLY: an invoice can
// be past its due date and fully reconciled. Anything that presents a past-due
// figure as money must combine the two, which is what this does.
export function isPastDueUnreconciled(invoice, remaining, now = new Date()) {
  return isPastDue(invoice, now) && toCents(remaining) > 0
}

// Replaces the pre-Receipts disclaimer. Still honest about what is NOT enforced.
export const AR_RECONCILIATION_NOTICE =
  'Balances reflect posted receipts allocated to each invoice. Constrapp warns but does not block ' +
  'over-allocation, and cannot prevent two users allocating the same balance concurrently. Unallocated ' +
  'receipts are shown separately and do not reduce any invoice balance.'

// ── Validation (client-enforced) ─────────────────────────────────────────────

// Returns an error message, or null when the draft is saveable.
//
// ⚠️ Firestore rules enforce the document's SHAPE and lifecycle only. The
// business checks below (client match, invoice status, allocation targets) are
// client-side and bypassable by a direct SDK call.
export function validateReceiptDraft({
  clientId, clientName, receiptDate, amount,
  paymentMethod, paymentMethodOther, allocations,
  invoices = null,
}) {
  if (!clientId) return 'Select the client this money was received from.'
  if (!String(clientName || '').trim()) return 'The selected client has no display name.'
  if (!isIsoDateShape(receiptDate)) return 'Enter the date the money was received.'

  const amountError = validateAmount(amount)
  if (amountError) return amountError

  const methodError = validatePaymentMethod(paymentMethod, paymentMethodOther)
  if (methodError) return methodError

  const allocationError = validateAllocations(allocations, amount, 'clientInvoiceId')
  if (allocationError) return allocationError

  // Target checks, when the caller supplies the invoice list.
  if (invoices) {
    const byId = new Map(invoices.map(inv => [inv.id, inv]))
    for (const a of allocations ?? []) {
      const inv = byId.get(a.clientInvoiceId)
      if (!inv) return 'An allocated invoice could not be found on this project.'
      if (inv.status !== CI_STATUS.ISSUED) {
        return `${inv.invoiceNumber} is ${inv.status} — only issued invoices can be reconciled.`
      }
      if (inv.clientId !== clientId) {
        return `${inv.invoiceNumber} belongs to a different client. Every allocated invoice must belong to the selected client.`
      }
    }
  }
  return null
}

// Why a draft cannot be posted yet, or null when it can.
//
// A FUTURE-DATED draft may be SAVED (so a receipt can be prepared ahead of a
// known settlement) but must not be POSTED: posting asserts that money has
// actually been received, and Cash Flow will consume receiptDate as real cash.
//
// ⚠️ CLIENT-ENFORCED. Firestore rules validate only the 'YYYY-MM-DD' SHAPE of
// receiptDate — rules have no reliable calendar comparison against the caller's
// local date, so a direct SDK call can post a future-dated receipt. Backdating
// is always allowed (entering last month's bank statement is the normal case).
export function postBlockedReason(receipt, now = new Date()) {
  if (!receipt) return 'Receipt not found.'
  if (receipt.status !== PAYMENT_STATUS.DRAFT) {
    return `Only a draft receipt can be posted — this one is ${receipt.status}.`
  }
  if (isFutureDate(receipt.receiptDate, now)) {
    return `The receipt date (${receipt.receiptDate}) is in the future. A receipt records money already ` +
           `received, so it can only be posted on or after that date — or correct the date to ${todayIso(now)} or earlier.`
  }
  return null
}

export const isFutureDatedReceipt = (receipt, now = new Date()) =>
  isFutureDate(receipt?.receiptDate, now)

// Builds the stored allocation array from editor rows, dropping empty rows and
// freezing the invoice-number snapshot so a register row renders without reading
// invoice documents (the frozen supplierName/costCodeName idiom).
export function buildAllocations(rows, invoices) {
  const byId = new Map((invoices ?? []).map(inv => [inv.id, inv]))
  return (rows ?? [])
    .filter(r => r.clientInvoiceId && Number(r.allocatedAmount) > 0)
    .map(r => {
      const inv = byId.get(r.clientInvoiceId)
      return {
        clientInvoiceId: r.clientInvoiceId,
        invoiceNumber:   inv?.invoiceNumber || r.invoiceNumber || '',
        allocatedAmount: roundMoney(Number(r.allocatedAmount)),
      }
    })
}

// ── Cash Flow rows (data only) ───────────────────────────────────────────────
//
// One row per POSTED, non-void receipt — the money-IN mirror of
// lib/supplierPayments.js → cashOutRows(). `projectId` is supplied by the
// caller because it is NOT stored on the document — the collection path already
// carries it (adding a redundant copy would create a second, driftable source
// of truth).
//
// ⚠️ CASH IN IS THE TOTAL `amount`, NEVER `allocatedTotal`. The whole amount
// was banked; an unallocated receipt is real cash in even though it settles no
// invoice yet. The allocated/unallocated split travels alongside for analysis,
// never instead of the cash figure.
//
// ⚠️ Cash Flow must group by `receiptDate` (e.g. `receiptDate.slice(0, 7)`) and
// NEVER by `createdAt`/`postedAt`, and must never sum across currencies — one
// currency per project, and there is no FX.
export function cashInRows(receipts, { projectId } = {}) {
  return postedClientReceipts(receipts).map(r => ({
    receiptId:         r.id,
    receiptNumber:     r.receiptNumber,
    amount:            roundMoney(safeAmount(r.amount)),
    receiptDate:       r.receiptDate || '',
    projectId:         projectId ?? null,
    clientId:          r.clientId ?? null,
    clientName:        r.clientName || '',
    currency:          r.currency || '',
    allocatedTotal:    roundMoney(safeAmount(r.allocatedTotal)),
    unallocatedAmount: roundMoney(safeAmount(r.unallocatedAmount)),
  }))
}

// Re-exported so pages import ONE module for receipt behaviour.
export { allocatedTotal, allocationTotals, MAX_ALLOCATIONS }
