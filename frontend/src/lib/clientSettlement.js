import { toCents, fromCents, isWholeCents, MAX_SUPPORTED_RECEIPT_CENTS } from './money'
import { isIsoDateShape, isPaymentMethod } from './payments'
import { postedReceiptAllocations } from './clientReceiptPosting'

// ── Client settlement: refunds and receipt applications (Phase 2 step 5,
// ADR-95; D6–D8) — PURE ────────────────────────────────────────────────────
//
// Two separate, auditable facts, each written ONLY by the trusted backend
// (functions/src/clientFinance/settlement.js) in one transaction with the
// ledger(s) it moves and one audit event. Firestore Rules give no client a
// write to either collection.
//
//   clientRefunds/{id}               CRF-####   money ACTUALLY returned to the
//                                               client, outside the app (a bank
//                                               transfer, a cheque). Never a
//                                               negative receipt.
//   clientReceiptApplications/{id}   CRA-####   a posted receipt's UNALLOCATED
//                                               funds allocated, later, to an
//                                               issued invoice. Moves no cash.
//
// WHAT A REFUND MAY SETTLE (both exist in the ledger model already):
//   · source `receipt` — the unallocated balance of ONE posted receipt (money on
//     account that was never matched to an invoice);
//   · source `invoice` — the OVERPAYMENT of one issued invoice: what it holds
//     beyond what is now receivable on it (a receipt over-allocated with the
//     user's acknowledgement, or a credit note posted after payment). That is
//     the existing "Owed to client" figure.
// An invoice's overpayment is never moved to another invoice (D6): the remedy is
// a refund, then a new receipt. Only a receipt's UNALLOCATED funds may be
// applied.
//
// THE BOUNDARIES (D7): every relationship is within one company, one project,
// one client and one currency — derived by the server from the documents it
// reads, never from the request. No cross-project, no cross-currency, no wallet.
//
// THE PER-RECEIPT LEDGER (server-only, `clientReceiptLedgers/{receiptId}`):
// `appliedCents` and `refundedCents` against that receipt. What a receipt can
// still settle = its stored unallocated amount − applied − refunded, never
// below zero. Both kinds of fact are new, so a missing receipt ledger means
// exactly zero — no historical baseline is needed for it. (What a receipt
// allocated to INVOICES at posting is in the invoice ledgers through the
// existing receipt baseline, ADR-89.)
//
// VOIDING a refund or an application CORRECTS AN ERRONEOUS RECORD. It is not a
// reversal of a real payment and is never presented as one: the audit event
// says `correction: true`, and the money a corrected refund recorded is simply
// no longer counted as returned.
//
// All money in the decisions is WHOLE CENTS (integers); a document stores
// `amount` as a decimal of whole cents, like a receipt.

export const SETTLEMENT_STATUS = { POSTED: 'posted', VOID: 'void' }

export const REFUND_SOURCE = { RECEIPT: 'receipt', INVOICE: 'invoice' }
export const REFUND_SOURCES = Object.values(REFUND_SOURCE)

export const CLIENT_REFUND_DOC_TYPE = 'client_refund'
export const CLIENT_APPLICATION_DOC_TYPE = 'client_receipt_application'

// Server-only counters (Firestore Rules refuse every client read and write).
export const CLIENT_REFUND_COUNTER_ID = 'clientRefunds'
export const CLIENT_APPLICATION_COUNTER_ID = 'clientReceiptApplications'
export const SETTLEMENT_COUNTER_MAX = 999_999_999
// The counter value after `n` is issued.
export const counterAfter = (n) => n + 1
export const clientRefundNumberOf = (n) => `CRF-${String(n).padStart(4, '0')}`
export const clientApplicationNumberOf = (n) => `CRA-${String(n).padStart(4, '0')}`

export const SETTLEMENT_LIMITS = { REFERENCE: 100, REASON: 500, NOTES: 1000 }

const isText = (v, max, { required = false } = {}) =>
  typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0)

// The amount a request names: a positive number of WHOLE cents inside the
// supported receipt range — or null.
export function requestCents(amount) {
  if (typeof amount !== 'number' || !isWholeCents(amount)) return null
  const cents = toCents(amount)
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_SUPPORTED_RECEIPT_CENTS) return null
  return cents
}

// ── Request shapes (authored content and identifiers only) ───────────────────

export const REFUND_REQUEST_KEYS = ['projectId', 'refundId', 'source', 'receiptId', 'clientInvoiceId', 'amount', 'refundDate', 'method', 'reference', 'reason']
export const APPLICATION_REQUEST_KEYS = ['projectId', 'applicationId', 'receiptId', 'clientInvoiceId', 'amount', 'applicationDate', 'notes']

// Why a refund request's AUTHORED content is not acceptable (a field name), or
// null. Identifiers are checked by the caller (lib/validation isValidId).
export function refundRequestProblem(input) {
  if (!REFUND_SOURCES.includes(input?.source)) return 'source'
  if (input.source === REFUND_SOURCE.RECEIPT && (typeof input.receiptId !== 'string' || input.clientInvoiceId !== null)) return 'receiptId'
  if (input.source === REFUND_SOURCE.INVOICE && (typeof input.clientInvoiceId !== 'string' || input.receiptId !== null)) return 'clientInvoiceId'
  if (requestCents(input.amount) === null) return 'amount'
  if (!isIsoDateShape(input.refundDate)) return 'refundDate'
  if (!isPaymentMethod(input.method)) return 'method'
  if (!isText(input.reference, SETTLEMENT_LIMITS.REFERENCE, { required: true })) return 'reference'
  if (!isText(input.reason, SETTLEMENT_LIMITS.REASON, { required: true })) return 'reason'
  return null
}

export function applicationRequestProblem(input) {
  if (typeof input?.receiptId !== 'string') return 'receiptId'
  if (typeof input.clientInvoiceId !== 'string') return 'clientInvoiceId'
  if (requestCents(input.amount) === null) return 'amount'
  if (!isIsoDateShape(input.applicationDate)) return 'applicationDate'
  if (!isText(input.notes, SETTLEMENT_LIMITS.NOTES)) return 'notes'
  return null
}

// ── A posted receipt's unallocated money (strict) ────────────────────────────
//
// What the receipt was NOT allocated to any invoice when it was posted, in
// whole cents — read STRICTLY from the stored amount and allocations (both
// frozen once posted). A figure that is not valid is a refusal naming it,
// never zero.
export function postedReceiptUnallocatedCents(receipt) {
  if (typeof receipt?.amount !== 'number' || !isWholeCents(receipt.amount)) return { field: 'amount' }
  const amountCents = toCents(receipt.amount)
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { field: 'amount' }
  const parsed = postedReceiptAllocations(receipt)
  if (parsed.field) return { field: parsed.field }
  const allocatedCents = parsed.allocations.reduce((sum, a) => sum + a.cents, 0)
  if (!Number.isSafeInteger(allocatedCents) || allocatedCents > amountCents) return { field: 'allocations' }
  return { cents: amountCents - allocatedCents, amountCents, allocatedCents }
}

// ── The per-receipt ledger (server-only) ─────────────────────────────────────

export const RECEIPT_LEDGER_KIND = {
  APPLICATION: 'application', APPLICATION_VOID: 'application_void',
  REFUND: 'refund', REFUND_VOID: 'refund_void',
}

const isLedgerCents = (v) => Number.isSafeInteger(v) && v >= 0
const RECEIPT_LEDGER_FIGURES = ['seq', 'appliedCents', 'refundedCents']

// Why a STORED receipt ledger cannot be trusted, or null (absent = zero).
export function receiptLedgerProblem(doc) {
  if (!doc) return null
  for (const key of RECEIPT_LEDGER_FIGURES) {
    if (!isLedgerCents(doc[key])) return `The receipt ledger figure ${key} is not a whole, non-negative number of cents.`
  }
  return null
}

export const readReceiptLedger = (doc) => ({
  seq: doc?.seq ?? 0, appliedCents: doc?.appliedCents ?? 0, refundedCents: doc?.refundedCents ?? 0,
})

// What a receipt can still settle: its unallocated money less what has been
// applied and refunded from it (whole cents; negative only for a ledger that
// is already broken — the backend refuses that state, never clamps it).
export const receiptAvailableCents = (unallocatedCents, ledger) =>
  unallocatedCents - (ledger?.appliedCents ?? 0) - (ledger?.refundedCents ?? 0)

export function moveReceiptLedger(ledger, { appliedCents = 0, refundedCents = 0 }, kind, entryId) {
  return {
    seq: (ledger?.seq ?? 0) + 1,
    appliedCents: (ledger?.appliedCents ?? 0) + appliedCents,
    refundedCents: (ledger?.refundedCents ?? 0) + refundedCents,
    lastEntryId: entryId,
    lastEntryKind: kind,
  }
}

export function receiptLedgerStateProblem(state) {
  for (const key of RECEIPT_LEDGER_FIGURES) {
    if (!isLedgerCents(state?.[key])) return `The receipt ledger figure ${key} would not be a whole, non-negative number of cents.`
  }
  return null
}

// ── The documents (the backend adds the server timestamps) ───────────────────

export function buildClientRefund({
  refundNumber, source, receipt = null, invoice = null, clientId, clientName, currency,
  cents, refundDate, method, reference, reason, uid,
}) {
  return {
    docType:         CLIENT_REFUND_DOC_TYPE,
    refundNumber,
    status:          SETTLEMENT_STATUS.POSTED,
    source,
    receiptId:       receipt?.id ?? null,
    receiptNumber:   receipt?.receiptNumber ?? null,
    clientInvoiceId: invoice?.id ?? null,
    invoiceNumber:   invoice?.invoiceNumber ?? null,
    clientId,
    clientName:      clientName || '',
    currency,
    amount:          fromCents(cents),
    refundDate,
    method,
    reference:       reference.trim(),
    reason:          reason.trim(),
    postedBy:        uid,
    voidedBy:        null,
    voidReason:      '',
    createdBy:       uid,
    updatedBy:       uid,
  }
}

export function buildReceiptApplication({
  applicationNumber, receipt, invoice, cents, applicationDate, notes, uid,
}) {
  return {
    docType:         CLIENT_APPLICATION_DOC_TYPE,
    applicationNumber,
    status:          SETTLEMENT_STATUS.POSTED,
    receiptId:       receipt.id,
    receiptNumber:   receipt.receiptNumber ?? null,
    clientInvoiceId: invoice.id,
    invoiceNumber:   invoice.invoiceNumber ?? null,
    clientId:        receipt.clientId,
    clientName:      receipt.clientName || '',
    currency:        receipt.currency,
    amount:          fromCents(cents),
    applicationDate,
    notes:           (notes ?? '').trim(),
    postedBy:        uid,
    voidedBy:        null,
    voidReason:      '',
    createdBy:       uid,
    updatedBy:       uid,
  }
}

// ── Read-time selectors (every figure the app shows is derived here) ─────────

const posted = (list) => (list ?? []).filter(d => d?.status === SETTLEMENT_STATUS.POSTED)
export const postedRefunds = (refunds) => posted(refunds)
export const postedApplications = (applications) => posted(applications)

const centsOf = (d) => (typeof d?.amount === 'number' && isWholeCents(d.amount) ? toCents(d.amount) : 0)
const add = (map, key, field, cents) => {
  if (!key) return
  map[key] ??= { appliedCents: 0, refundedCents: 0 }
  map[key][field] += cents
}

// { invoiceId: { appliedCents, refundedCents } } — applications TO an invoice
// and refunds OUT OF an invoice's overpayment (source `invoice`).
export function settlementByInvoice({ refunds = [], applications = [] } = {}) {
  const map = {}
  for (const a of postedApplications(applications)) add(map, a.clientInvoiceId, 'appliedCents', centsOf(a))
  for (const r of postedRefunds(refunds)) if (r.source === REFUND_SOURCE.INVOICE) add(map, r.clientInvoiceId, 'refundedCents', centsOf(r))
  return map
}

// { receiptId: { appliedCents, refundedCents } } — what each receipt's
// unallocated money has been applied or refunded.
export function settlementByReceipt({ refunds = [], applications = [] } = {}) {
  const map = {}
  for (const a of postedApplications(applications)) add(map, a.receiptId, 'appliedCents', centsOf(a))
  for (const r of postedRefunds(refunds)) if (r.source === REFUND_SOURCE.RECEIPT) add(map, r.receiptId, 'refundedCents', centsOf(r))
  return map
}

// Posted refunds as cash rows — money OUT of what was received, so NEGATIVE.
// Net cash received = posted receipts − posted refunds; an application is not
// cash and never appears here.
export function refundCashRows(refunds, { projectId = null } = {}) {
  return postedRefunds(refunds).map(r => ({
    refundId:      r.id,
    refundNumber:  r.refundNumber,
    receiptNumber: r.refundNumber,
    amount:        fromCents(-centsOf(r)),
    receiptDate:   r.refundDate || '',
    projectId,
    clientId:      r.clientId ?? null,
    clientName:    r.clientName || '',
    currency:      r.currency || '',
    kind:          'refund',
  }))
}

export function settlementSummary({ refunds = [], applications = [] } = {}) {
  const pr = postedRefunds(refunds)
  const pa = postedApplications(applications)
  const sum = (list) => list.reduce((s, d) => s + centsOf(d), 0)
  return {
    refundedCents: sum(pr),
    refundedFromReceiptsCents: sum(pr.filter(r => r.source === REFUND_SOURCE.RECEIPT)),
    refundedFromInvoicesCents: sum(pr.filter(r => r.source === REFUND_SOURCE.INVOICE)),
    appliedCents: sum(pa),
    refundCount: pr.length,
    applicationCount: pa.length,
  }
}

// ── Read-time integrity (the Final Account gate and the receipts page) ───────
//
// A POSTED refund or application the records do not support — the source
// receipt missing or not posted, the target invoice missing or void, the
// client or currency not the receipt's / invoice's, or a receipt settled
// beyond its unallocated money. None of these can be produced through the
// backend; finding one means a record was written another way, and a Final
// Account is never frozen over it.
export function settlementExceptions({ refunds = [], applications = [], receipts = [], invoices = [] } = {}) {
  const receiptById = new Map((receipts ?? []).map(r => [r.id, r]))
  const invoiceById = new Map((invoices ?? []).map(i => [i.id, i]))
  const out = []
  const flag = (d, kind, problem) => out.push({ id: d.id, number: d.refundNumber ?? d.applicationNumber ?? d.id, kind, problem })
  const receiptOk = (d) => {
    const r = receiptById.get(d.receiptId)
    if (!r || r.status !== 'posted') return 'receipt-not-posted'
    if (r.clientId !== d.clientId) return 'client-mismatch'
    if (r.currency !== d.currency) return 'currency-mismatch'
    return null
  }
  const invoiceOk = (d) => {
    const i = invoiceById.get(d.clientInvoiceId)
    if (!i || i.status !== 'issued') return 'invoice-not-issued'
    if ((i.clientId ?? null) !== d.clientId) return 'client-mismatch'
    if (i.currency !== d.currency) return 'currency-mismatch'
    return null
  }
  for (const a of postedApplications(applications)) {
    const p = (centsOf(a) <= 0 && 'amount') || receiptOk(a) || invoiceOk(a)
    if (p) flag(a, 'application', p)
  }
  for (const r of postedRefunds(refunds)) {
    const p = (centsOf(r) <= 0 && 'amount') || (r.source === REFUND_SOURCE.RECEIPT ? receiptOk(r) : r.source === REFUND_SOURCE.INVOICE ? invoiceOk(r) : 'source')
    if (p) flag(r, 'refund', p)
  }
  const byReceipt = settlementByReceipt({ refunds, applications })
  for (const [receiptId, used] of Object.entries(byReceipt)) {
    const r = receiptById.get(receiptId)
    if (!r || r.status !== 'posted') continue
    const un = postedReceiptUnallocatedCents(r)
    if (un.field || used.appliedCents + used.refundedCents > un.cents) {
      out.push({ id: receiptId, number: r.receiptNumber ?? receiptId, kind: 'receipt', problem: 'receipt-over-settled' })
    }
  }
  return out
}
