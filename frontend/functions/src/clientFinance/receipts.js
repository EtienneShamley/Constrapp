import { CODE, fail } from '../lib/errors.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import { isValidId } from '../lib/validation.js'
import * as calc from '../generated/clientFinanceCalc.js'
import { runGuarded, readCallerAndDocument } from './transactions.js'
import { invoiceRangeProblem } from './agreement.js'
import {
  dataOf, invoiceRef, ledgerRef, receiptRef, readStoredLedger, writeLedger, stampReceiptPosted, stampVoid,
} from './persistence.js'

// ── Posting and voiding client receipts (ADR-89) ─────────────────────────────
//
// A client receipt becomes POSTED, and a posted one VOID, only here. WHY: a
// decision that depends on receipts — above all, voiding a retention release —
// must not scan a project's receipt history, which only grows. So each posted
// allocation is recorded where the decision reads: `receivedCents` in the
// ledger of the invoice it settles. Posting a receipt and voiding a release
// therefore WRITE THE SAME DOCUMENT and are serialised by Firestore.
//
//   postClientReceipt({ projectId, receiptId, acknowledgeOverAllocation })
//   voidClientReceipt({ projectId, receiptId, reason })
//
// POST — one transaction, every read before any write:
//   1. the caller's membership, the project's receipt-baseline marker and the
//      receipt, under the caller's company;
//   2. the draft is EXACTLY the document the app writes, its totals are
//      re-derived from its amount and allocations (never trusted), and its
//      amount is inside the supported range (lib/money.js);
//   3. its date is not ahead of the server's by more than a day;
//   4. for EACH allocation, the invoice and that invoice's ledger: the invoice
//      exists, is issued, is the receipt's client and currency, carries the
//      number the allocation froze and is inside the supported range;
//   5. THE OVER-ALLOCATION POLICY, enforced here: an allocation above what its
//      invoice is still owed is allowed ONLY when the request acknowledges it.
//      A receipt prepared in a tab that pre-dates a credit note or a release
//      void is therefore never silently over-allocated — it is refused naming
//      the invoice, what remains and the excess, and nothing is written;
//   6. the writes: the receipt (status, stamps, `allocatedInvoiceIds`), ONE
//      ledger per allocated invoice, ONE audit event. A receipt with no
//      allocations writes no ledger.
//
// `receivedCents` IS EXACT. Receipts posted before posting became a backend
// operation are in the ledgers through the project's receipt baseline
// (baseline.js), whose marker this transaction reads and requires; so check 5
// is judged against everything the invoice has ever been allocated.
//
// VOID — a posted receipt takes back, from each invoice's ledger, exactly what
// it put there, in the transaction that turns it `void`. That status change is
// the exactly-once guard: a repeat finds the receipt void and moves nothing.
// This holds for a receipt posted BEFORE this module too (no
// `allocatedInvoiceIds`): the baseline put its allocations in the ledgers, so
// its void takes them out. Its allocations are read strictly — a malformed one
// is a refusal, never skipped. NOTHING IS CLAMPED: a ledger that records less
// than the void would take back (or does not exist) is an invariant breach and
// the void is refused with nothing written. The invoice need not still be
// issued. A draft is voided with no ledger write.

const STATUS = calc.PAYMENT_STATUS

// ── POST ─────────────────────────────────────────────────────────────────────

export async function postClientReceipt(deps, { uid, projectId, entryId: receiptId, acknowledgeOverAllocation, requestId = null }) {
  const { db, now, log, hooks = {} } = deps
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId, receiptId, operation: AUDIT.CLIENT_RECEIPT_POSTED }, async (tx) => {
    attempts += 1
    const ctx = await readCallerAndDocument(tx, db, { uid, projectId }, (project) => receiptRef(project, receiptId))
    const receipt = dataOf(ctx.snap)

    if (receipt.status === STATUS.POSTED) {
      // The same caller's own earlier success — answer it again, write nothing.
      if (receipt.postedBy === uid) {
        return { replay: true, allocatedInvoiceIds: Array.isArray(receipt.allocatedInvoiceIds) ? receipt.allocatedInvoiceIds : [], overAllocated: [] }
      }
      fail(CODE.CLIENT_ENTRY_NOT_DRAFT, { entryStatus: receipt.status })
    }
    if (receipt.status !== STATUS.DRAFT) fail(CODE.CLIENT_ENTRY_NOT_DRAFT, { entryStatus: receipt.status ?? null })

    // 2. The draft as an untrusted document, then its money re-derived.
    const field = calc.clientReceiptDraftProblem(receipt)
    if (field) fail(CODE.CLIENT_ENTRY_INVALID, { field })
    const money = calc.deriveReceiptTotals(receipt)
    if (money.outOfRange) fail(CODE.CLIENT_AMOUNT_OUT_OF_RANGE, { field: money.field, maxCents: money.maxCents })
    if (money.field) fail(CODE.CLIENT_ENTRY_INVALID, { field: money.field })
    if (money.allocations.some(a => !isValidId(a.clientInvoiceId))) fail(CODE.CLIENT_ENTRY_INVALID, { field: 'allocations' })

    // 3. Posting asserts the money HAS been received.
    const latest = calc.latestPostableReceiptDate(now())
    if (receipt.receiptDate > latest) fail(CODE.CLIENT_RECEIPT_FUTURE_DATED, { receiptDate: receipt.receiptDate, latest })

    // 4. Every allocated invoice and its ledger — and nothing else.
    const targets = money.allocations.map(a => ({
      ...a, invoiceRef: invoiceRef(ctx.projectRef, a.clientInvoiceId), ledgerRef: ledgerRef(ctx.projectRef, a.clientInvoiceId),
    }))
    const invoiceSnaps = targets.length > 0 ? await tx.getAll(...targets.map(t => t.invoiceRef)) : []
    const ledgerSnaps = targets.length > 0 ? await tx.getAll(...targets.map(t => t.ledgerRef)) : []
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })

    const positions = {}
    for (const [i, t] of targets.entries()) {
      const invoice = dataOf(invoiceSnaps[i])
      t.ledgerSnap = ledgerSnaps[i]
      t.before = readStoredLedger(t.ledgerSnap).state
      const named = { invoiceId: t.clientInvoiceId, invoiceNumber: t.invoiceNumber }
      if (!invoice || invoice.status !== calc.CI_STATUS.ISSUED) fail(CODE.CLIENT_INVOICE_NOT_ISSUED, { ...named, invoiceStatus: invoice?.status ?? null })
      if ((invoice.clientId ?? null) !== receipt.clientId) fail(CODE.CLIENT_INVOICE_MISMATCH, { ...named, field: 'clientId' })
      if (invoice.currency !== receipt.currency) fail(CODE.CLIENT_INVOICE_MISMATCH, { ...named, field: 'currency' })
      if ((invoice.invoiceNumber || '') !== t.invoiceNumber) fail(CODE.CLIENT_INVOICE_MISMATCH, { ...named, field: 'invoiceNumber' })
      const range = invoiceRangeProblem(invoice)
      if (range) fail(range.code, { ...named, ...range.details })
      positions[t.clientInvoiceId] = { invoice, ledgerState: t.before }
    }

    // 5. The over-allocation policy.
    const overAllocated = calc.receiptOverAllocations(money.allocations, positions)
    if (overAllocated.length > 0 && acknowledgeOverAllocation !== true) {
      fail(CODE.CLIENT_RECEIPT_OVER_ALLOCATED, { invoices: overAllocated })
    }

    // 6. The writes.
    const allocated = []
    for (const t of targets) {
      const next = calc.applyReceipt(t.before, t.cents, receiptId)
      writeLedger(tx, t.ledgerRef, t.ledgerSnap, next, uid)
      allocated.push({
        invoiceId: t.clientInvoiceId, invoiceNumber: t.invoiceNumber, allocatedCents: t.cents,
        receivedBeforeCents: t.before.receivedCents, receivedAfterCents: next.receivedCents, seq: next.seq,
      })
    }
    const allocatedInvoiceIds = calc.allocatedInvoiceIds(money.allocations)
    stampReceiptPosted(tx, ctx.ref, ctx.snap, STATUS.POSTED, uid, allocatedInvoiceIds)
    auditInTx(tx, db, ctx.companyId, {
      type: AUDIT.CLIENT_RECEIPT_POSTED, actorUid: uid, requestId,
      before: { status: STATUS.DRAFT },
      after: {
        projectId, receiptId, number: receipt.receiptNumber, status: STATUS.POSTED, currency: receipt.currency,
        clientId: receipt.clientId, receiptDate: receipt.receiptDate,
        amountCents: money.amountCents, allocatedCents: money.allocatedCents, unallocatedCents: money.unallocatedCents,
        allocations: allocated,
        overAllocationAcknowledged: overAllocated.length > 0,
        overAllocated: overAllocated.map(o => ({ invoiceId: o.invoiceId, remainingCents: o.remainingCents, excessCents: o.excessCents })),
      },
    }, now())
    return { replay: false, allocatedInvoiceIds, overAllocated }
  }, () => attempts)

  log.info('client receipt post', { uid, projectId, receiptId, replay: result.replay, attempts, invoices: result.allocatedInvoiceIds.length })
  return {
    status: STATUS.POSTED, receiptId, allocatedInvoiceIds: result.allocatedInvoiceIds,
    overAllocationAcknowledged: result.overAllocated.length > 0, alreadyApplied: result.replay, attempts,
  }
}

// ── VOID ─────────────────────────────────────────────────────────────────────

export async function voidClientReceipt(deps, { uid, projectId, entryId: receiptId, reason, requestId = null }) {
  const { db, now, log, hooks = {} } = deps
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId, receiptId, operation: AUDIT.CLIENT_RECEIPT_VOIDED }, async (tx) => {
    attempts += 1
    const ctx = await readCallerAndDocument(tx, db, { uid, projectId }, (project) => receiptRef(project, receiptId))
    const receipt = dataOf(ctx.snap)
    const wasPosted = receipt.status === STATUS.POSTED
    // A receipt posted before this module existed: in the ledgers through the baseline.
    const legacy = wasPosted && receipt.allocatedInvoiceIds === undefined
    // EVERY posted receipt is in its invoices' ledgers. What it put there is
    // read strictly, one row per invoice.
    let targets = []
    if (wasPosted) {
      const parsed = calc.postedReceiptAllocations(receipt)
      if (parsed.field) fail(CODE.CLIENT_ENTRY_INVALID, { field: parsed.field })
      if (parsed.allocations.some(a => !isValidId(a.clientInvoiceId))) fail(CODE.CLIENT_ENTRY_INVALID, { field: 'allocations' })
      // The baseline summed the legacy receipts posted BEFORE it. One stamped
      // as posted after it never passed through a ledger (no client can write
      // that; a privileged write could) — taking it "back" would remove money
      // other receipts put there.
      const postedAt = receipt.postedAt
      const establishedAt = ctx.baseline?.establishedAt
      if (legacy && typeof postedAt?.toMillis === 'function' && typeof establishedAt?.toMillis === 'function' && postedAt.toMillis() > establishedAt.toMillis()) {
        fail(CODE.CLIENT_RECEIPT_BASELINE_INCONSISTENT, { receiptId, number: receipt.receiptNumber ?? null, reason: 'legacy-receipt-posted-after-the-baseline' })
      }
      targets = parsed.allocations.map(a => ({ ...a, ledgerRef: ledgerRef(ctx.projectRef, a.clientInvoiceId) }))
    }
    const snaps = targets.length > 0 ? await tx.getAll(...targets.map(t => t.ledgerRef)) : []
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })

    if (receipt.status === STATUS.VOID) {
      // The same caller's own earlier void, for the same reason.
      if (receipt.voidedBy === uid && receipt.voidReason === reason) return { replay: true, ledgerMoves: 0 }
      fail(CODE.CLIENT_ENTRY_NOT_POSTED, { entryStatus: receipt.status })
    }
    if (!wasPosted && receipt.status !== STATUS.DRAFT) fail(CODE.CLIENT_ENTRY_INVALID, { entryStatus: receipt.status ?? null })

    const allocated = []
    // Decide for EVERY ledger before writing any.
    const moves = targets.map((t, i) => {
      const before = readStoredLedger(snaps[i]).state
      // Exact figures: the ledger must record at least what this receipt put
      // there. A missing ledger records zero. Never clamped.
      if (before.receivedCents < t.cents) {
        fail(CODE.CLIENT_LEDGER_INVARIANT, {
          invariant: 'The invoice ledger records less received than this receipt allocated to it.',
          invoiceId: t.clientInvoiceId, invoiceNumber: t.invoiceNumber, receivedCents: before.receivedCents, allocatedCents: t.cents,
          number: receipt.receiptNumber ?? null,
        })
      }
      return { t, snap: snaps[i], before, next: calc.applyReceiptVoid(before, t.cents, receiptId) }
    })
    for (const { t, snap, before, next } of moves) {
      writeLedger(tx, t.ledgerRef, snap, next, uid)
      allocated.push({
        invoiceId: t.clientInvoiceId, invoiceNumber: t.invoiceNumber, allocatedCents: t.cents,
        receivedBeforeCents: before.receivedCents, receivedAfterCents: next.receivedCents, seq: next.seq,
      })
    }
    stampVoid(tx, ctx.ref, ctx.snap, STATUS.VOID, uid, reason)
    auditInTx(tx, db, ctx.companyId, {
      type: AUDIT.CLIENT_RECEIPT_VOIDED, actorUid: uid, requestId,
      before: { status: receipt.status },
      after: {
        projectId, receiptId, number: receipt.receiptNumber ?? null, status: STATUS.VOID, currency: receipt.currency ?? null, reason,
        amountCents: calc.toCents(receipt.amount),
        // false for a draft, and for a posted receipt with no allocations: neither moved a ledger.
        ledgerMoved: allocated.length > 0,
        // true when the receipt reached the ledgers through the baseline.
        fromBaseline: legacy,
        allocations: allocated,
      },
    }, now())
    return { replay: false, ledgerMoves: allocated.length }
  }, () => attempts)

  log.info('client receipt void', { uid, projectId, receiptId, replay: result.replay, attempts, ledgerMoves: result.ledgerMoves })
  return { status: STATUS.VOID, receiptId, alreadyApplied: result.replay, attempts }
}
