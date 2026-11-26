import { toCents, isWholeCents, MAX_SUPPORTED_RECEIPT_CENTS } from './money'
import { toIsoDate } from './payments'
import { ledgerRemainingCents } from './clientLedger'

// ── Posting a client receipt — what is derived, never trusted (ADR-89) ───────
//
// A draft receipt is a PROPOSAL. When it is posted, the trusted backend
// (functions/src/clientFinance/receipts.js, through the generated bundle)
// re-derives every figure below from the amount and the allocations and
// requires the stored draft to agree. PURE — whole cents throughout — and the
// same module the browser can preview with.

const DAY_MS = 24 * 60 * 60 * 1000

// The latest `receiptDate` a receipt may be POSTED with: the day after `now`,
// read in UTC. Posting asserts money HAS been received, so a later date is
// refused; one day of grace is the most a calendar date east of UTC can be
// ahead of the server's own (Auckland in summer is UTC+13). Backdating is
// always allowed.
export function latestPostableReceiptDate(now = new Date()) {
  const next = new Date(now.getTime() + DAY_MS)
  return toIsoDate(new Date(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()))
}

// The receipt's money, re-derived:
//   allocatedTotal    = Σ allocations
//   unallocatedAmount = amount − allocatedTotal
// Returns `{ field }` naming the first stored figure that is not valid or does
// not agree, or the figures in whole cents. `allocations` is assumed to be the
// shape lib/clientEntryShape.js requires (objects, one per invoice).
export function deriveReceiptTotals(receipt) {
  if (!isWholeCents(receipt?.amount) || toCents(receipt.amount) <= 0) return { field: 'amount' }
  const amountCents = toCents(receipt.amount)
  // Above the supported range (lib/money.js) nothing is established exact.
  if (amountCents > MAX_SUPPORTED_RECEIPT_CENTS) return { field: 'amount', outOfRange: true, maxCents: MAX_SUPPORTED_RECEIPT_CENTS }
  const allocations = []
  let allocatedCents = 0
  for (const [i, a] of (receipt.allocations ?? []).entries()) {
    if (!isWholeCents(a?.allocatedAmount) || toCents(a.allocatedAmount) <= 0) return { field: `allocations[${i}].allocatedAmount` }
    const cents = toCents(a.allocatedAmount)
    allocations.push({ clientInvoiceId: a.clientInvoiceId, invoiceNumber: a.invoiceNumber, cents })
    allocatedCents += cents
  }
  // The money does not exist: a receipt can never allocate more than it is.
  if (allocatedCents > amountCents) return { field: 'allocations' }
  if (!isWholeCents(receipt.allocatedTotal) || toCents(receipt.allocatedTotal) !== allocatedCents) return { field: 'allocatedTotal' }
  if (!isWholeCents(receipt.unallocatedAmount) || toCents(receipt.unallocatedAmount) !== amountCents - allocatedCents) return { field: 'unallocatedAmount' }
  return { amountCents, allocatedCents, unallocatedCents: amountCents - allocatedCents, allocations }
}

// What a POSTED receipt has allocated, per invoice, in whole cents — STRICTLY:
// what the receipt baseline sums and what a void takes back. A posted receipt
// is history and is read as it stands, but never loosely: an allocation that is
// not an object naming an invoice with a positive, whole-cent, safe amount is
// NAMED (`{ field }`) and the caller refuses — it is never skipped, rounded or
// read as zero, because either would make the received figure inexact. Two
// allocations to one invoice are added together.
// Returns `{ field }` or `{ allocations: [{ clientInvoiceId, invoiceNumber, cents }], count }`
// (one row per invoice, in first-appearance order; `count` = stored rows).
export function postedReceiptAllocations(receipt) {
  if (!Array.isArray(receipt?.allocations)) return { field: 'allocations' }
  const byInvoice = new Map()
  for (const [i, a] of receipt.allocations.entries()) {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return { field: `allocations[${i}]` }
    if (typeof a.clientInvoiceId !== 'string' || a.clientInvoiceId.length === 0) return { field: `allocations[${i}].clientInvoiceId` }
    const cents = toCents(a.allocatedAmount)
    if (!isWholeCents(a.allocatedAmount) || cents <= 0 || !Number.isSafeInteger(cents)) return { field: `allocations[${i}].allocatedAmount` }
    const row = byInvoice.get(a.clientInvoiceId)
    if (row) row.cents += cents
    else byInvoice.set(a.clientInvoiceId, { clientInvoiceId: a.clientInvoiceId, invoiceNumber: typeof a.invoiceNumber === 'string' ? a.invoiceNumber : '', cents })
  }
  const allocations = [...byInvoice.values()]
  if (allocations.some(row => !Number.isSafeInteger(row.cents))) return { field: 'allocations' }
  return { allocations, count: receipt.allocations.length }
}

// ── The historical receipt baseline (ADR-89, final pass) ─────────────────────
//
// What the receipts posted BEFORE posting became a backend operation allocated
// to each invoice, summed in whole cents — the figures the trusted backend
// writes into the invoice ledgers ONCE per project
// (functions/src/clientFinance/baseline.js).
//
// `postedReceipts` — every POSTED receipt of the project, `{ id, ...data }`.
// EVERY one must be a legacy receipt and must be readable strictly, or the
// whole baseline is refused naming the receipt — a record is never skipped,
// because a sum that is short would silently under-state what was received:
//   · `{ problem: { kind: 'inconsistent', receiptId, number } }` — a receipt
//     that already carries `allocatedInvoiceIds` (posted by the backend) where
//     no baseline exists;
//   · `{ problem: { kind: 'invalid', receiptId, number, field } }` — an
//     allocation that is malformed, not positive, not whole cents, or names
//     an invoice id `isInvoiceId` rejects;
//   · `{ problem: { kind: 'range', … } }` — a sum that is not a safe integer.
// Otherwise `{ invoices: [{ invoiceId, cents, receipts }], legacyPostedReceipts,
// legacyAllocations, legacyCents }` — `receipts` counts the receipts that
// allocated to that invoice; a receipt with no allocations counts in
// `legacyPostedReceipts` only.
export function receiptBaselineSums(postedReceipts, isInvoiceId = () => true) {
  const byInvoice = new Map()
  let legacyAllocations = 0
  let legacyCents = 0
  for (const receipt of postedReceipts ?? []) {
    const named = { receiptId: receipt?.id ?? null, number: typeof receipt?.receiptNumber === 'string' ? receipt.receiptNumber : null }
    if (receipt?.allocatedInvoiceIds !== undefined) return { problem: { kind: 'inconsistent', ...named } }
    const parsed = postedReceiptAllocations(receipt)
    if (parsed.field) return { problem: { kind: 'invalid', ...named, field: parsed.field } }
    for (const a of parsed.allocations) {
      if (!isInvoiceId(a.clientInvoiceId)) return { problem: { kind: 'invalid', ...named, field: 'allocations' } }
      const row = byInvoice.get(a.clientInvoiceId) ?? { invoiceId: a.clientInvoiceId, cents: 0, receipts: 0 }
      row.cents += a.cents
      row.receipts += 1
      byInvoice.set(a.clientInvoiceId, row)
      legacyCents += a.cents
      if (!Number.isSafeInteger(row.cents) || !Number.isSafeInteger(legacyCents)) return { problem: { kind: 'range', ...named } }
    }
    legacyAllocations += parsed.count
  }
  return { invoices: [...byInvoice.values()], legacyPostedReceipts: (postedReceipts ?? []).length, legacyAllocations, legacyCents }
}

// What the receipts a lookup FOUND do not explain of an invoice's received
// figure (whole cents, never negative): receipts recorded before the backend
// took over count in the figure but cannot be listed by invoice.
// `listed` — [{ allocatedCents }].
export function unlistedReceivedCents(receivedCents, listed) {
  let explained = 0
  for (const r of listed ?? []) explained += r.allocatedCents
  return Math.max(0, receivedCents - explained)
}

// The allocations a POSTED receipt carries, in whole cents, read LENIENTLY —
// for display only (naming the receipts that block a void). Never used to move
// a ledger: that is `postedReceiptAllocations`.
export function storedReceiptAllocations(receipt) {
  return (Array.isArray(receipt?.allocations) ? receipt.allocations : [])
    .filter(a => typeof a?.clientInvoiceId === 'string' && a.clientInvoiceId.length > 0 && toCents(a.allocatedAmount) > 0)
    .map(a => ({ clientInvoiceId: a.clientInvoiceId, invoiceNumber: a.invoiceNumber ?? '', cents: toCents(a.allocatedAmount) }))
}

// The sorted, distinct invoice ids a receipt allocates to — stored on the
// posted receipt (`allocatedInvoiceIds`) so "which receipts touch this
// invoice" is one indexed lookup.
export const allocatedInvoiceIds = (allocations) =>
  [...new Set((allocations ?? []).map(a => a.clientInvoiceId))].sort()

// ── Over-allocation (the approved warn-and-acknowledge policy) ───────────────
//
// An allocation OVER-ALLOCATES its invoice when it exceeds what the invoice is
// still owed: receivable basis − received, as the invoice's ledger reads at
// posting. An invoice already owed nothing (or owing the client) has 0
// available. Over-allocating is allowed ONLY with an explicit acknowledgement;
// this names every invoice that needs one.
//
// `receivedCents` in the ledger is EXACT: it includes the receipts posted
// before posting became a backend operation, brought in once per project by
// the receipt baseline (lib/clientLedger.js → RECEIVED).
//
// `positions` — { [clientInvoiceId]: { invoice, ledgerState } }.
export function receiptOverAllocations(allocations, positions) {
  const out = []
  for (const a of allocations ?? []) {
    const position = positions?.[a.clientInvoiceId]
    if (!position) continue
    const remainingCents = Math.max(0, ledgerRemainingCents(position.invoice, position.ledgerState))
    if (a.cents > remainingCents) {
      out.push({
        invoiceId: a.clientInvoiceId,
        invoiceNumber: position.invoice?.invoiceNumber || a.invoiceNumber || '',
        allocatedCents: a.cents,
        remainingCents,
        excessCents: a.cents - remainingCents,
      })
    }
  }
  return out
}
