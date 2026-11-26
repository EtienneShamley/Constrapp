import { CODE } from '../lib/errors.js'
import * as calc from '../generated/clientFinanceCalc.js'

// ── What must hold before an entry is posted (ADR-89) — PURE ─────────────────
//
// Nothing here is a formula. Every figure comes from the generated copy of the
// browser's own modules (lib/clientInvoices.js, lib/clientCreditNotes.js,
// lib/clientRetention.js); this file only COMPARES what is stored with what
// those modules derive, in whole cents.
//
//   1. The INVOICE is a source record, so it is checked before it is trusted:
//      issued, of the entry's client and currency, and internally consistent.
//   2. The DRAFT is an untrusted document — Rules validate very little of one —
//      so it must be EXACTLY the shape the app writes (lib/clientEntryShape.js):
//      no unknown key, no missing key, pristine lifecycle fields, and the
//      invoice's own snapshots.
//   3. The ENTRY is re-derived from the invoice, the invoice's current ledger
//      and the amounts the draft names — nothing else of the draft is used —
//      and the stored draft must equal that derivation in every figure. The
//      person posting therefore posts exactly what they reviewed, and a draft
//      whose lines were never valid can never become a posted entry.

// The same stored value as the derived one: a number, with no fraction of a
// cent, and the same number of cents.
const sameMoney = (stored, derived) =>
  typeof stored === 'number' && calc.isWholeCents(stored) && calc.toCents(stored) === calc.toCents(derived)

const RETENTION_FIELDS = ['retention', 'retentionGst', 'retentionTotal', 'receivableTotal']

// The stored field on which an invoice disagrees with its own lines, or null.
// Rules pin `retentionGst` only to within half a cent of the proportional
// share; here every header must be EXACTLY what `invoiceTotals` derives. An
// invoice written before client retention existed carries none of the four
// retention fields and is read as withholding nothing (ADR-88).
export function invoiceInconsistency(invoice) {
  const lines = invoice?.lineItems
  if (!Array.isArray(lines) || lines.length === 0) return 'lineItems'
  if (lines.some(li => !calc.isWholeCents(li?.amount) || !calc.isWholeCents(li?.gstAmount))) return 'lineItems'
  const carriesRetention = RETENTION_FIELDS.some(key => invoice[key] !== undefined)
  const derived = calc.invoiceTotals(lines, carriesRetention ? invoice.retention : 0)
  const pinned = carriesRetention ? ['subtotal', 'gstTotal', 'grossTotal', ...RETENTION_FIELDS] : ['subtotal', 'gstTotal', 'grossTotal']
  const off = pinned.find(key => !sameMoney(invoice[key], derived[key]))
  if (off) return off
  if (calc.toCents(invoice.retention) > calc.toCents(invoice.subtotal)) return 'retention'
  return null
}

// THE SUPPORTED RANGE is the server's to enforce (lib/money.js →
// MAX_SUPPORTED_AMOUNT_CENTS; the invoice editor's own check is a courtesy).
// Nothing is posted against an invoice whose ex-GST subtotal is above it.
export function invoiceRangeProblem(invoice) {
  return calc.toCents(invoice?.subtotal) > calc.MAX_SUPPORTED_AMOUNT_CENTS
    ? { code: CODE.CLIENT_AMOUNT_OUT_OF_RANGE, details: { field: 'subtotal', maxCents: calc.MAX_SUPPORTED_AMOUNT_CENTS } }
    : null
}

// Why nothing may be posted against `invoice` by `entry`: `{ code, details }`,
// or null.
export function invoiceProblem(invoice, entry) {
  if (!invoice || invoice.status !== calc.CI_STATUS.ISSUED) {
    return { code: CODE.CLIENT_INVOICE_NOT_ISSUED, details: { invoiceStatus: invoice?.status ?? null } }
  }
  if (typeof invoice.currency !== 'string' || invoice.currency.length === 0 || invoice.currency !== entry.currency) {
    return { code: CODE.CLIENT_INVOICE_MISMATCH, details: { field: 'currency' } }
  }
  if ((invoice.clientId ?? null) !== (entry.clientId ?? null)) {
    return { code: CODE.CLIENT_INVOICE_MISMATCH, details: { field: 'clientId' } }
  }
  const range = invoiceRangeProblem(invoice)
  if (range) return range
  const field = invoiceInconsistency(invoice)
  return field ? { code: CODE.CLIENT_INVOICE_INCONSISTENT, details: { field } } : null
}

// Why a stored draft is not a document the app writes: `{ code, details }`
// naming the first offending field, or null. `shape` is one of
// calc.CLIENT_ENTRY_SHAPES. Number UNIQUENESS is not checked — it would need a
// query per posting, and the number comes from a counter the Rules guard.
export function draftProblem(shape, entry, invoice) {
  const field = calc.clientEntryDraftProblem(shape, entry, invoice)
  return field ? { code: CODE.CLIENT_ENTRY_INVALID, details: { field } } : null
}

const LINE_MONEY = ['amount', 'gstAmount']
const CREDIT_HEADERS = ['subtotal', 'gstTotal', 'grossTotal', 'retentionAmount', 'retentionGst', 'retentionTotal', 'receivableTotal']

// A draft CREDIT NOTE against the invoice and its current ledger.
// Returns `{ figures }` — the derivation, which is what the ledger is advanced
// by — or `{ mismatch }` naming why the stored draft is not that derivation:
// `reason` when no credit can be derived from its rows at all (a line that
// does not exist, is named twice or exceeds what is left to credit), otherwise
// the first `field` that differs.
export function deriveCreditNote(invoice, ledgerDoc, entry) {
  const stored = Array.isArray(entry.lineItems) ? entry.lineItems : []
  // ONLY the line index and the ex-GST amount are taken from the draft.
  const rows = stored.map(li => ({ invoiceLineIndex: li?.invoiceLineIndex, amount: li?.amount }))
  const built = calc.buildClientCreditNote(invoice, ledgerDoc, rows)
  if (built.error) return { mismatch: { reason: built.error } }
  if (stored.length !== built.lineItems.length) return { mismatch: { field: 'lineItems' } }
  // The WHOLE rebuilt line: its figures, and every snapshot it copies from the
  // invoice line (description, tax code, variation, cost code) — a credit
  // cannot change how the invoice line was taxed or attributed.
  for (const [i, line] of built.lineItems.entries()) {
    const li = stored[i]
    const off = calc.CLIENT_CREDIT_LINE_KEYS.find(key =>
      (LINE_MONEY.includes(key) ? !sameMoney(li[key], line[key]) : li[key] !== line[key]))
    if (off) return { mismatch: { field: `lineItems[${i}].${off}` } }
  }
  const off = CREDIT_HEADERS.find(key => !sameMoney(entry[key], built.totals[key]))
  if (off) return { mismatch: { field: off } }
  return { figures: { lineItems: built.lineItems, ...built.totals } }
}

const RELEASE_FIGURES = ['amount', 'gstAmount', 'releaseTotal']

// A draft RETENTION RELEASE, the same way: only its ex-GST `amount` is used.
export function deriveRetentionRelease(invoice, ledgerDoc, entry) {
  if (typeof entry.amount !== 'number') return { mismatch: { field: 'amount' } }
  const built = calc.buildClientRetentionRelease(invoice, ledgerDoc, entry.amount)
  if (built.error) return { mismatch: { reason: built.error } }
  const off = RELEASE_FIGURES.find(key => !sameMoney(entry[key], built[key]))
  if (off) return { mismatch: { field: off } }
  return { figures: { amount: built.amount, gstAmount: built.gstAmount, releaseTotal: built.releaseTotal } }
}
