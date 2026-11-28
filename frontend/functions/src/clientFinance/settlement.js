import { FieldValue } from '../lib/firebaseAdmin.js'
import { CODE, fail } from '../lib/errors.js'
import { userRef, assertActiveRole } from '../lib/authz.js'
import { requireCommercialActivationInTx } from '../lib/commercialActivation.js'
import { segregationGuard } from '../lib/approvalPolicy.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import * as calc from '../generated/clientFinanceCalc.js'
import { CLIENT_FINANCE_ROLES } from './contracts.js'
import { runGuarded } from './transactions.js'
import { invoiceRangeProblem } from './agreement.js'
import {
  dataOf, projectRefs, invoiceRef, ledgerRef, receiptRef, receiptBaselineRef, readStoredLedger, writeLedger, ledgerTotals,
} from './persistence.js'

// ── Client refunds, receipt applications and the trusted void of an issued
// client invoice (Phase 2 step 5, ADR-95; D6–D8) ───────────────────────────
//
//   postClientRefund({ projectId, refundId, source, receiptId, clientInvoiceId,
//                      amount, refundDate, method, reference, reason })
//   voidClientRefund({ projectId, refundId, reason })
//   postClientReceiptApplication({ projectId, applicationId, receiptId,
//                      clientInvoiceId, amount, applicationDate, notes })
//   voidClientReceiptApplication({ projectId, applicationId, reason })
//   voidClientInvoice({ projectId, invoiceId, reason })
//
// The request carries AUTHORED content (an amount the user decided to refund
// or apply, a date, a reference, a reason) and identifiers. The company comes
// from the caller's membership, read inside the transaction; the client, the
// currency and the project relationship are derived from the receipt and the
// invoice the transaction reads (D7) — never from the request.
//
// ONE read-write transaction per request, every read before any write:
//   1. the caller's membership (active, of a company, a financial role);
//   2. the company, the project, the project's receipt-baseline marker (a
//      missing baseline is never read as zero received — ADR-89), the record
//      itself, the server-only counter (posting), the receipt and its
//      receipt ledger, the invoice and its invoice ledger — only the ones the
//      operation names;
//   3. the decision, from the generated copy of the browser's own modules;
//   4. the writes: the record (`create` — a client-chosen id makes a repeat
//      after a lost response idempotent), the ledger(s) it moves, the
//      counter, ONE audit event.
//
// WHAT IS PREVENTED (each by a ledger the transaction reads and writes, so two
// requests on the same money are serialised by Firestore and the second is
// decided against the first's result):
//   · over-refunding or over-applying a receipt — its receipt ledger;
//   · refunding more than an invoice's overpayment — its invoice ledger;
//   · applying more than an invoice still owes (no application creates an
//     overpayment: that would be a silent transfer between invoices);
//   · a refund or application against a receipt that is not posted, or an
//     invoice that is not issued; another client, currency or project;
//   · voiding an application when money refunded out of the invoice would no
//     longer be covered (S1);
//   · voiding an issued invoice while ANY money is recorded against it —
//     receipt allocations (including those that pre-date the backend, through
//     the receipt baseline), applications, refunds, credit notes, releases.
//
// A VOID of a refund or an application CORRECTS AN ERRONEOUS RECORD. It is not
// a reversal of a real payment: the audit event says `correction: true`.

const STATUS = calc.SETTLEMENT_STATUS
const REFUNDS = 'clientRefunds'
const APPLICATIONS = 'clientReceiptApplications'

const refundRef = (projectRef, id) => projectRef.collection(REFUNDS).doc(id)
const applicationRef = (projectRef, id) => projectRef.collection(APPLICATIONS).doc(id)
const receiptLedgerRef = (projectRef, receiptId) => projectRef.collection('clientReceiptLedgers').doc(receiptId)
const counterRef = (db, companyId, id) => db.collection('companies').doc(companyId).collection('counters').doc(id)

// The caller, then the company, project and receipt-baseline marker under the
// CALLER'S company, plus `extra(projectRef)` read in the same call.
async function readScope(tx, db, { uid, projectId }, extra = () => [], { requireActivation = true } = {}) {
  const profileSnap = await tx.get(userRef(db, uid))
  const profile = assertActiveRole(profileSnap.exists ? profileSnap.data() : null, CLIENT_FINANCE_ROLES, CODE.CLIENT_FINANCE_FORBIDDEN)
  const companyId = profile.companyId
  // Every operation of this module is Phase 2 (refunds, applications, the void
  // of an issued invoice): the company must be activated, read in this transaction.
  await requireCommercialActivationInTx(tx, db, companyId)
  const refs = projectRefs(db, companyId, projectId)
  const more = extra(refs.project, companyId)
  const [companySnap, projectSnap, baselineSnap, ...snaps] = await tx.getAll(refs.company, refs.project, receiptBaselineRef(refs.project), ...more)
  if (!companySnap.exists || !projectSnap.exists) fail(CODE.NOT_FOUND)
  if (requireActivation && !calc.clientFinanceActivated(companySnap.data())) fail(CODE.CLIENT_FINANCE_NOT_ACTIVATED)
  if (!baselineSnap.exists) fail(CODE.CLIENT_RECEIPT_BASELINE_MISSING)
  return { companyId, projectRef: refs.project, snaps }
}

// The next number from a server-only counter: absent → 1; otherwise a positive
// whole number not above the bound, or a refusal (fail closed, operator repair).
function counterValue(counterSnap) {
  if (!counterSnap.exists) return 1
  const next = counterSnap.data()?.next
  if (!Number.isSafeInteger(next) || next < 1 || next > calc.SETTLEMENT_COUNTER_MAX) fail(CODE.CLIENT_SETTLEMENT_COUNTER_INVALID)
  return next
}

function readReceiptLedgerSnap(snap) {
  const doc = snap.exists ? snap.data() : null
  const problem = calc.receiptLedgerProblem(doc)
  if (problem) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: problem, receiptId: snap.id })
  return calc.readReceiptLedger(doc)
}

function writeReceiptLedger(tx, ref, snap, next, uid) {
  const problem = calc.receiptLedgerStateProblem(next)
  if (problem) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: problem, receiptId: ref.id })
  const body = { ...next, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }
  if (snap.exists) tx.update(ref, body, { lastUpdateTime: snap.updateTime })
  else tx.create(ref, { ...body, createdAt: FieldValue.serverTimestamp(), createdBy: uid })
}

// A posted receipt's unallocated money, or a refusal naming the bad field.
function receiptUnallocated(receipt) {
  if (!receipt || receipt.status !== calc.PAYMENT_STATUS.POSTED) fail(CODE.CLIENT_RECEIPT_NOT_POSTED, { receiptStatus: receipt?.status ?? null })
  const un = calc.postedReceiptUnallocatedCents(receipt)
  if (un.field) fail(CODE.CLIENT_ENTRY_INVALID, { field: un.field, receiptId: receipt.id })
  return un.cents
}

// What a receipt can still settle. Below zero only for a ledger already broken
// (more applied and refunded than the receipt left unallocated): refused,
// never clamped.
function availableOn(receipt, unallocatedCents, ledger) {
  const available = calc.receiptAvailableCents(unallocatedCents, ledger)
  if (available < 0) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: 'The receipt ledger records more applied and refunded than the receipt left unallocated.', receiptNumber: receipt.receiptNumber ?? null })
  return available
}

function issuedInvoice(invoice) {
  if (!invoice || invoice.status !== calc.CI_STATUS.ISSUED) fail(CODE.CLIENT_INVOICE_NOT_ISSUED, { invoiceStatus: invoice?.status ?? null, invoiceNumber: invoice?.invoiceNumber ?? null })
  const range = invoiceRangeProblem(invoice)
  if (range) fail(range.code, { invoiceNumber: invoice.invoiceNumber ?? null, ...range.details })
  return invoice
}

// Posting asserts the money HAS moved: not later than the server's day + 1
// (the receipt rule, lib/clientReceiptPosting.js).
function notFutureDated(date, now, field) {
  const latest = calc.latestPostableReceiptDate(now)
  if (date > latest) fail(CODE.CLIENT_SETTLEMENT_INVALID, { field, latest })
}

const stamps = (uid) => ({
  postedAt: FieldValue.serverTimestamp(), voidedAt: null,
  createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid,
})

// The authored content a repeat must match to be the SAME request.
const sameRefund = (stored, input, cents) =>
  stored.source === input.source && (stored.receiptId ?? null) === (input.receiptId ?? null)
  && (stored.clientInvoiceId ?? null) === (input.clientInvoiceId ?? null)
  && calc.toCents(stored.amount) === cents && stored.refundDate === input.refundDate
  && stored.method === input.method && stored.reference === input.reference.trim() && stored.reason === input.reason.trim()
const sameApplication = (stored, input, cents) =>
  stored.receiptId === input.receiptId && stored.clientInvoiceId === input.clientInvoiceId
  && calc.toCents(stored.amount) === cents && stored.applicationDate === input.applicationDate
  && stored.notes === (input.notes ?? '').trim()

// ── Refunds ──────────────────────────────────────────────────────────────────

export async function postClientRefund(deps, input) {
  const { db, now, log, hooks = {} } = deps
  const { uid, projectId, refundId, requestId = null } = input
  const cents = calc.requestCents(input.amount)
  const fromReceipt = input.source === calc.REFUND_SOURCE.RECEIPT
  const sourceId = fromReceipt ? input.receiptId : input.clientInvoiceId
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId, refundId, operation: AUDIT.CLIENT_REFUND_POSTED }, async (tx) => {
    attempts += 1
    const ctx = await readScope(tx, db, { uid, projectId }, (project, companyId) => [
      refundRef(project, refundId),
      counterRef(db, companyId, calc.CLIENT_REFUND_COUNTER_ID),
      fromReceipt ? receiptRef(project, sourceId) : invoiceRef(project, sourceId),
      fromReceipt ? receiptLedgerRef(project, sourceId) : ledgerRef(project, sourceId),
    ])
    const [refundSnap, counterSnap, sourceSnap, sourceLedgerSnap] = ctx.snaps
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })

    if (refundSnap.exists) {
      const stored = refundSnap.data()
      if (stored.createdBy === uid && stored.docType === calc.CLIENT_REFUND_DOC_TYPE && sameRefund(stored, input, cents)) {
        return { replay: true, refundNumber: stored.refundNumber, status: stored.status }
      }
      fail(CODE.CLIENT_SETTLEMENT_ID_CONFLICT)
    }
    const number = counterValue(counterSnap)
    notFutureDated(input.refundDate, now(), 'refundDate')
    const source = dataOf(sourceSnap)

    let receipt = null
    let invoice = null
    let ledgerBefore
    let ledgerAfter
    let availableBeforeCents
    let availableAfterCents
    if (fromReceipt) {
      receipt = source
      const unallocatedCents = receiptUnallocated(receipt)
      ledgerBefore = readReceiptLedgerSnap(sourceLedgerSnap)
      availableBeforeCents = availableOn(receipt, unallocatedCents, ledgerBefore)
      if (cents > availableBeforeCents) fail(CODE.CLIENT_SETTLEMENT_UNAVAILABLE, { availableCents: availableBeforeCents, requestedCents: cents, receiptNumber: receipt.receiptNumber ?? null })
      ledgerAfter = calc.moveReceiptLedger(ledgerBefore, { refundedCents: cents }, calc.RECEIPT_LEDGER_KIND.REFUND, refundId)
      availableAfterCents = calc.receiptAvailableCents(unallocatedCents, ledgerAfter)
    } else {
      invoice = issuedInvoice(source)
      ledgerBefore = readStoredLedger(sourceLedgerSnap).state
      availableBeforeCents = calc.ledgerRefundableCents(invoice, ledgerBefore)
      if (cents > availableBeforeCents) fail(CODE.CLIENT_SETTLEMENT_UNAVAILABLE, { availableCents: availableBeforeCents, requestedCents: cents, invoiceNumber: invoice.invoiceNumber ?? null })
      ledgerAfter = calc.applyInvoiceRefund(ledgerBefore, cents, refundId)
      const broken = calc.settlementInvariantError(invoice, ledgerAfter)
      if (broken) fail(CODE.CLIENT_REFUNDS_DEPEND, { invariant: broken })
      availableAfterCents = calc.ledgerRefundableCents(invoice, ledgerAfter)
    }

    const owner = receipt ?? invoice
    const refundNumber = calc.clientRefundNumberOf(number)
    tx.set(counterSnap.ref, { next: calc.counterAfter(number) }, { merge: true })
    tx.create(refundSnap.ref, {
      ...calc.buildClientRefund({
        refundNumber, source: input.source, receipt: receipt ? { id: sourceId, ...receipt } : null,
        invoice: invoice ? { id: sourceId, ...invoice } : null,
        clientId: owner.clientId ?? null, clientName: owner.clientName, currency: owner.currency,
        cents, refundDate: input.refundDate, method: input.method, reference: input.reference, reason: input.reason, uid,
      }),
      ...stamps(uid),
    })
    if (fromReceipt) writeReceiptLedger(tx, sourceLedgerSnap.ref, sourceLedgerSnap, ledgerAfter, uid)
    else writeLedger(tx, sourceLedgerSnap.ref, sourceLedgerSnap, ledgerAfter, uid)
    auditInTx(tx, db, ctx.companyId, {
      type: AUDIT.CLIENT_REFUND_POSTED, actorUid: uid, requestId,
      before: { availableCents: availableBeforeCents },
      after: {
        projectId, refundId, number: refundNumber, status: STATUS.POSTED, source: input.source,
        receiptId: fromReceipt ? sourceId : null, invoiceId: fromReceipt ? null : sourceId,
        clientId: owner.clientId ?? null, currency: owner.currency, amountCents: cents,
        refundDate: input.refundDate, method: input.method,
        availableAfterCents,
        ledger: fromReceipt ? { appliedCents: ledgerAfter.appliedCents, refundedCents: ledgerAfter.refundedCents, seq: ledgerAfter.seq }
          : { ...ledgerTotals(ledgerAfter), refundedCents: ledgerAfter.refundedCents },
      },
    }, now())
    return { replay: false, refundNumber, status: STATUS.POSTED }
  }, () => attempts)

  log.info('client refund post', { uid, projectId, refundId, replay: result.replay, attempts })
  return { status: result.status, refundId, refundNumber: result.refundNumber, alreadyApplied: result.replay, attempts }
}

export async function voidClientRefund(deps, { uid, projectId, refundId, reason, requestId = null }) {
  const { db, now, log, hooks = {} } = deps
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId, refundId, operation: AUDIT.CLIENT_REFUND_VOIDED }, async (tx) => {
    attempts += 1
    // The refund first, so the ledger it moved can be named.
    const first = await readScope(tx, db, { uid, projectId }, (project) => [refundRef(project, refundId)])
    const [refundSnap] = first.snaps
    if (!refundSnap.exists) fail(CODE.CLIENT_ENTRY_NOT_FOUND)
    const refund = refundSnap.data()
    if (refund.docType !== calc.CLIENT_REFUND_DOC_TYPE) fail(CODE.CLIENT_ENTRY_INVALID)
    const fromReceipt = refund.source === calc.REFUND_SOURCE.RECEIPT
    const sourceId = fromReceipt ? refund.receiptId : refund.clientInvoiceId
    if (typeof sourceId !== 'string' || sourceId.length === 0) fail(CODE.CLIENT_ENTRY_INVALID, { field: fromReceipt ? 'receiptId' : 'clientInvoiceId' })
    const ledgerSnap = await tx.get(fromReceipt ? receiptLedgerRef(first.projectRef, sourceId) : ledgerRef(first.projectRef, sourceId))
    // D3 #47 (architect decision): RECORDING a refund money already returned
    // stays single-person; VOIDING a posted refund corrects an established
    // financial fact — with segregation enabled it needs an independent
    // authorised member, not the person who recorded it. Read in this
    // transaction (policy changes and membership are ordered against it).
    const segregation = segregationGuard(db, uid, { label: 'void of a posted client refund' })
    await segregation.read(tx, { companyId: first.companyId })
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })

    if (refund.status === STATUS.VOID) {
      if (refund.voidedBy === uid && refund.voidReason === reason) return { replay: true }
      fail(CODE.CLIENT_ENTRY_NOT_POSTED, { entryStatus: refund.status })
    }
    if (refund.status !== STATUS.POSTED) fail(CODE.CLIENT_ENTRY_INVALID, { entryStatus: refund.status ?? null })
    const cents = calc.requestCents(refund.amount)
    if (cents === null) fail(CODE.CLIENT_ENTRY_INVALID, { field: 'amount' })
    const recorder = refund.createdBy ?? refund.postedBy ?? null
    segregation.check({ createdBy: recorder, lastMaterialEditBy: recorder })

    let after
    if (fromReceipt) {
      const before = readReceiptLedgerSnap(ledgerSnap)
      if (before.refundedCents < cents) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: 'The receipt ledger records less refunded than this refund.', receiptId: sourceId })
      after = calc.moveReceiptLedger(before, { refundedCents: -cents }, calc.RECEIPT_LEDGER_KIND.REFUND_VOID, refundId)
      writeReceiptLedger(tx, ledgerSnap.ref, ledgerSnap, after, uid)
    } else {
      const before = readStoredLedger(ledgerSnap).state
      if (before.refundedCents < cents) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: 'The invoice ledger records less refunded than this refund.', invoiceId: sourceId })
      after = calc.applyInvoiceRefundVoid(before, cents, refundId)
      writeLedger(tx, ledgerSnap.ref, ledgerSnap, after, uid)
    }
    tx.update(refundSnap.ref, {
      status: STATUS.VOID, voidedAt: FieldValue.serverTimestamp(), voidedBy: uid, voidReason: reason,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid,
    }, { lastUpdateTime: refundSnap.updateTime })
    auditInTx(tx, db, first.companyId, {
      type: AUDIT.CLIENT_REFUND_VOIDED, actorUid: uid, requestId,
      before: { status: STATUS.POSTED },
      after: {
        projectId, refundId, number: refund.refundNumber ?? null, status: STATUS.VOID, reason,
        // A correction of an erroneous record — NOT a reversal of money paid.
        correction: true, cashReversed: false,
        source: refund.source, receiptId: fromReceipt ? sourceId : null, invoiceId: fromReceipt ? null : sourceId,
        currency: refund.currency ?? null, amountCents: cents, ledgerRefundedAfterCents: after.refundedCents,
        segregation: segregation.record(),
      },
    }, now())
    return { replay: false }
  }, () => attempts)

  log.info('client refund void', { uid, projectId, refundId, replay: result.replay, attempts })
  return { status: STATUS.VOID, refundId, alreadyApplied: result.replay, attempts }
}

// ── Receipt applications ─────────────────────────────────────────────────────

export async function postClientReceiptApplication(deps, input) {
  const { db, now, log, hooks = {} } = deps
  const { uid, projectId, applicationId, receiptId, clientInvoiceId, requestId = null } = input
  const cents = calc.requestCents(input.amount)
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId, applicationId, operation: AUDIT.CLIENT_APPLICATION_POSTED }, async (tx) => {
    attempts += 1
    const ctx = await readScope(tx, db, { uid, projectId }, (project, companyId) => [
      applicationRef(project, applicationId),
      counterRef(db, companyId, calc.CLIENT_APPLICATION_COUNTER_ID),
      receiptRef(project, receiptId), receiptLedgerRef(project, receiptId),
      invoiceRef(project, clientInvoiceId), ledgerRef(project, clientInvoiceId),
    ])
    const [appSnap, counterSnap, receiptSnap, receiptLedgerSnap, invoiceSnap, invoiceLedgerSnap] = ctx.snaps
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })

    if (appSnap.exists) {
      const stored = appSnap.data()
      if (stored.createdBy === uid && stored.docType === calc.CLIENT_APPLICATION_DOC_TYPE && sameApplication(stored, input, cents)) {
        return { replay: true, applicationNumber: stored.applicationNumber, status: stored.status }
      }
      fail(CODE.CLIENT_SETTLEMENT_ID_CONFLICT)
    }
    const number = counterValue(counterSnap)
    notFutureDated(input.applicationDate, now(), 'applicationDate')

    const receipt = dataOf(receiptSnap)
    const unallocatedCents = receiptUnallocated(receipt)
    const invoice = issuedInvoice(dataOf(invoiceSnap))
    // D7 — the same client and the same currency (the project is the path).
    if ((invoice.clientId ?? null) !== (receipt.clientId ?? null)) fail(CODE.CLIENT_SETTLEMENT_MISMATCH, { field: 'clientId' })
    if (invoice.currency !== receipt.currency) fail(CODE.CLIENT_SETTLEMENT_MISMATCH, { field: 'currency' })

    const receiptBefore = readReceiptLedgerSnap(receiptLedgerSnap)
    const availableCents = availableOn(receipt, unallocatedCents, receiptBefore)
    if (cents > availableCents) fail(CODE.CLIENT_SETTLEMENT_UNAVAILABLE, { availableCents, requestedCents: cents, receiptNumber: receipt.receiptNumber ?? null })
    const invoiceBefore = readStoredLedger(invoiceLedgerSnap).state
    const owedCents = calc.ledgerOwedCents(invoice, invoiceBefore)
    // An application never creates an overpayment (D6: no silent transfer of
    // money between invoices).
    if (cents > owedCents) fail(CODE.CLIENT_SETTLEMENT_UNAVAILABLE, { invoiceRemainingCents: owedCents, requestedCents: cents, invoiceNumber: invoice.invoiceNumber ?? null })

    const receiptAfter = calc.moveReceiptLedger(receiptBefore, { appliedCents: cents }, calc.RECEIPT_LEDGER_KIND.APPLICATION, applicationId)
    const invoiceAfter = calc.applyApplication(invoiceBefore, cents, applicationId)
    const broken = calc.ledgerInvariantError(invoice, invoiceAfter) ?? calc.settlementInvariantError(invoice, invoiceAfter)
    if (broken) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: broken })

    const applicationNumber = calc.clientApplicationNumberOf(number)
    tx.set(counterSnap.ref, { next: calc.counterAfter(number) }, { merge: true })
    tx.create(appSnap.ref, {
      ...calc.buildReceiptApplication({
        applicationNumber, receipt: { id: receiptId, ...receipt }, invoice: { id: clientInvoiceId, ...invoice },
        cents, applicationDate: input.applicationDate, notes: input.notes, uid,
      }),
      ...stamps(uid),
    })
    writeReceiptLedger(tx, receiptLedgerSnap.ref, receiptLedgerSnap, receiptAfter, uid)
    writeLedger(tx, invoiceLedgerSnap.ref, invoiceLedgerSnap, invoiceAfter, uid)
    auditInTx(tx, db, ctx.companyId, {
      type: AUDIT.CLIENT_APPLICATION_POSTED, actorUid: uid, requestId,
      before: { receiptAvailableCents: availableCents, invoiceRemainingCents: owedCents },
      after: {
        projectId, applicationId, number: applicationNumber, status: STATUS.POSTED,
        receiptId, receiptNumber: receipt.receiptNumber ?? null, invoiceId: clientInvoiceId, invoiceNumber: invoice.invoiceNumber ?? null,
        clientId: receipt.clientId ?? null, currency: receipt.currency, amountCents: cents,
        applicationDate: input.applicationDate,
        receiptAvailableAfterCents: calc.receiptAvailableCents(unallocatedCents, receiptAfter), invoiceReceivedAfterCents: invoiceAfter.receivedCents,
        // An application moves no cash.
        cash: false,
      },
    }, now())
    return { replay: false, applicationNumber, status: STATUS.POSTED }
  }, () => attempts)

  log.info('client receipt application post', { uid, projectId, applicationId, replay: result.replay, attempts })
  return { status: result.status, applicationId, applicationNumber: result.applicationNumber, alreadyApplied: result.replay, attempts }
}

export async function voidClientReceiptApplication(deps, { uid, projectId, applicationId, reason, requestId = null }) {
  const { db, now, log, hooks = {} } = deps
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId, applicationId, operation: AUDIT.CLIENT_APPLICATION_VOIDED }, async (tx) => {
    attempts += 1
    const first = await readScope(tx, db, { uid, projectId }, (project) => [applicationRef(project, applicationId)])
    const [appSnap] = first.snaps
    if (!appSnap.exists) fail(CODE.CLIENT_ENTRY_NOT_FOUND)
    const app = appSnap.data()
    if (app.docType !== calc.CLIENT_APPLICATION_DOC_TYPE || typeof app.receiptId !== 'string' || typeof app.clientInvoiceId !== 'string'
      || app.receiptId.length === 0 || app.clientInvoiceId.length === 0) fail(CODE.CLIENT_ENTRY_INVALID)
    const [receiptLedgerSnap, invoiceSnap, invoiceLedgerSnap] = await tx.getAll(
      receiptLedgerRef(first.projectRef, app.receiptId), invoiceRef(first.projectRef, app.clientInvoiceId), ledgerRef(first.projectRef, app.clientInvoiceId))
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })

    if (app.status === STATUS.VOID) {
      if (app.voidedBy === uid && app.voidReason === reason) return { replay: true }
      fail(CODE.CLIENT_ENTRY_NOT_POSTED, { entryStatus: app.status })
    }
    if (app.status !== STATUS.POSTED) fail(CODE.CLIENT_ENTRY_INVALID, { entryStatus: app.status ?? null })
    const cents = calc.requestCents(app.amount)
    if (cents === null) fail(CODE.CLIENT_ENTRY_INVALID, { field: 'amount' })

    const receiptBefore = readReceiptLedgerSnap(receiptLedgerSnap)
    if (receiptBefore.appliedCents < cents) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: 'The receipt ledger records less applied than this application.', receiptId: app.receiptId })
    const invoiceBefore = readStoredLedger(invoiceLedgerSnap).state
    if (invoiceBefore.receivedCents < cents) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: 'The invoice ledger records less received than this application.', invoiceId: app.clientInvoiceId })
    const receiptAfter = calc.moveReceiptLedger(receiptBefore, { appliedCents: -cents }, calc.RECEIPT_LEDGER_KIND.APPLICATION_VOID, applicationId)
    const invoiceAfter = calc.applyApplicationVoid(invoiceBefore, cents, applicationId)
    const invoice = dataOf(invoiceSnap)
    // S1 — money refunded out of this invoice must still be covered.
    if (invoice) {
      const broken = calc.settlementInvariantError(invoice, invoiceAfter)
      if (broken) fail(CODE.CLIENT_REFUNDS_DEPEND, { invariant: broken, invoiceNumber: invoice.invoiceNumber ?? null })
    } else if (invoiceAfter.refundedCents > 0) {
      fail(CODE.CLIENT_REFUNDS_DEPEND, { invariant: 'The invoice cannot be read, and money has been refunded out of it.' })
    }

    writeReceiptLedger(tx, receiptLedgerSnap.ref, receiptLedgerSnap, receiptAfter, uid)
    writeLedger(tx, invoiceLedgerSnap.ref, invoiceLedgerSnap, invoiceAfter, uid)
    tx.update(appSnap.ref, {
      status: STATUS.VOID, voidedAt: FieldValue.serverTimestamp(), voidedBy: uid, voidReason: reason,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid,
    }, { lastUpdateTime: appSnap.updateTime })
    auditInTx(tx, db, first.companyId, {
      type: AUDIT.CLIENT_APPLICATION_VOIDED, actorUid: uid, requestId,
      before: { status: STATUS.POSTED },
      after: {
        projectId, applicationId, number: app.applicationNumber ?? null, status: STATUS.VOID, reason, correction: true,
        receiptId: app.receiptId, invoiceId: app.clientInvoiceId, currency: app.currency ?? null, amountCents: cents,
        receiptAppliedAfterCents: receiptAfter.appliedCents, invoiceReceivedAfterCents: invoiceAfter.receivedCents,
      },
    }, now())
    return { replay: false }
  }, () => attempts)

  log.info('client receipt application void', { uid, projectId, applicationId, replay: result.replay, attempts })
  return { status: STATUS.VOID, applicationId, alreadyApplied: result.replay, attempts }
}

// ── The void of an ISSUED client invoice (D8) ────────────────────────────────
//
// Refused while ANY money is recorded against the invoice in its ledger:
// receipt allocations — including those posted before the backend took over,
// which the project's receipt baseline (whose marker this transaction reads)
// put there — applications, refunds, credit notes and retention releases.
// A DRAFT invoice is voided by the browser under Firestore Rules (it has
// billed nothing); an issued one only here.
export async function voidClientInvoice(deps, { uid, projectId, invoiceId, reason, requestId = null }) {
  const { db, now, log, hooks = {} } = deps
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId, invoiceId, operation: AUDIT.CLIENT_INVOICE_VOIDED }, async (tx) => {
    attempts += 1
    const ctx = await readScope(tx, db, { uid, projectId }, (project) => [invoiceRef(project, invoiceId), ledgerRef(project, invoiceId)], { requireActivation: false })
    const [invoiceSnap, ledgerSnap] = ctx.snaps
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })
    if (!invoiceSnap.exists) fail(CODE.CLIENT_ENTRY_NOT_FOUND)
    const invoice = invoiceSnap.data()
    if (invoice.status === calc.CI_STATUS.VOID) {
      if (invoice.voidedBy === uid && invoice.voidReason === reason) return { replay: true }
      fail(CODE.CLIENT_ENTRY_NOT_POSTED, { entryStatus: invoice.status })
    }
    if (invoice.status !== calc.CI_STATUS.ISSUED) fail(CODE.CLIENT_INVOICE_NOT_ISSUED, { invoiceStatus: invoice.status ?? null, invoiceNumber: invoice.invoiceNumber ?? null })
    const ledger = readStoredLedger(ledgerSnap).state
    const held = {
      receivedCents: ledger.receivedCents, refundedCents: ledger.refundedCents,
      creditedSubtotalCents: ledger.creditedSubtotalCents, releasedRetentionCents: ledger.releasedRetentionCents,
    }
    if (Object.values(held).some(v => v !== 0)) fail(CODE.CLIENT_INVOICE_HAS_MONEY, { invoiceNumber: invoice.invoiceNumber ?? null, ...held })

    tx.update(invoiceSnap.ref, {
      status: calc.CI_STATUS.VOID, voidedAt: FieldValue.serverTimestamp(), voidedBy: uid, voidReason: reason,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid,
    }, { lastUpdateTime: invoiceSnap.updateTime })
    auditInTx(tx, db, ctx.companyId, {
      type: AUDIT.CLIENT_INVOICE_VOIDED, actorUid: uid, requestId,
      before: { status: calc.CI_STATUS.ISSUED },
      after: { projectId, invoiceId, number: invoice.invoiceNumber ?? null, status: calc.CI_STATUS.VOID, reason, currency: invoice.currency ?? null, ledger: held },
    }, now())
    return { replay: false }
  }, () => attempts)

  log.info('client invoice void', { uid, projectId, invoiceId, replay: result.replay, attempts })
  return { status: calc.CI_STATUS.VOID, invoiceId, alreadyApplied: result.replay, attempts }
}
