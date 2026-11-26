import {
  CCN_STATUS, CCN_DOC_TYPE, formatClientCreditNoteNumber,
  buildClientCreditNote, validateClientCreditDraft, CLIENT_ENTRY_STALE_TEXT,
} from './clientCreditNotes'
import {
  CRR_STATUS, CRR_DOC_TYPE, formatClientRetentionReleaseNumber,
  buildClientRetentionRelease, validateClientReleaseDraft,
} from './clientRetention'
import { CLIENT_ENTRY_SHAPES, clientEntryTextError, invoiceSnapshot, pristineLifecycle } from './clientEntryShape'
import { PAYMENT_STATUS } from './payments'
import { fromCents } from './money'

// ── Client credit notes, retention releases and receipts — the browser's writes
// (ADR-87 / ADR-88; the trusted transaction boundary of ADR-89)
//
// SDK injected (`runTransaction`, `serverTimestamp`, the callable) and
// references passed in, so every path runs in the Node test runner with no
// React and no Firebase import (the budgetAdjustmentActions precedent).
//
// WHAT THE BROWSER MAY WRITE — and Firestore Rules allow nothing more:
//   · CREATE a draft, EDIT a draft, VOID a DRAFT. Each is one transaction that
//     reads the invoice and its current ledger first and builds what it stores
//     from them (lib/clientCreditNotes.js, lib/clientRetention.js).
//
// WHAT THE BROWSER MAY NOT WRITE:
//   · the per-invoice LEDGER — no client can create or change one;
//   · `posted`, and the void of a POSTED entry. Those are the six trusted
//     callables (functions/src/clientFinance/): postClientCreditNote,
//     voidClientCreditNote, postClientRetentionRelease,
//     voidClientRetentionRelease, postClientReceipt, voidClientReceipt. A
//     request carries the project and entry ids, for a void a reason, and for
//     a receipt whether over-allocation was acknowledged — NEVER an amount.
//     The server re-derives every figure from records it reads itself,
//     requires the stored draft to equal that derivation, advances the ledger
//     and writes the audit event in one transaction. It decides whether an
//     invoice is over-allocated, and whether receipts still fit when a posted
//     release is voided, from the invoice's ledger.
//
// Client RECEIPT drafts are still created and edited in
// hooks/useClientReceipts.jsx, as before; only their posting and the void of a
// posted receipt moved here.
//
// Nothing in this file is a control. A draft's figures are a PROPOSAL: they
// take effect only if the server, at posting, derives the same ones. The checks
// that remain here exist so a legitimate request is well-formed and the user
// gets a clear message early — the server decides.

const invoiceOf = (snap) => (snap.exists() ? { id: snap.id, ...snap.data() } : null)
const ledgerOf = (snap) => (snap.exists() ? snap.data() : null)

const text = (v) => String(v || '').trim()

// ── The trusted callables ────────────────────────────────────────────────────

// The browser waits LONGER than a callable may run (120 s, functions/src/
// index.js → CLIENT_FINANCE_CALL_OPTIONS), so the server's own answer arrives
// before the client gives up. The SDK default is 70 s.
export const CLIENT_FINANCE_CALL_TIMEOUT_MS = 130000

// The bound the server puts on a void reason (functions/src/clientFinance/
// contracts.js → VOID_REASON_MAX).
export const VOID_REASON_MAX = 500

const CREDIT_NOTE = {
  noun: 'credit note', Noun: 'Credit note', idKey: 'creditNoteId', status: CCN_STATUS,
  postFn: 'postClientCreditNote', voidFn: 'voidClientCreditNote',
  dependents: 'Void the dependent entries first.',
}
const RETENTION_RELEASE = {
  noun: 'retention release', Noun: 'Retention release', idKey: 'releaseId', status: CRR_STATUS,
  postFn: 'postClientRetentionRelease', voidFn: 'voidClientRetentionRelease',
  dependents: 'Void the credit notes posted after this release first.',
}
const RECEIPT = {
  noun: 'receipt', Noun: 'Receipt', idKey: 'receiptId', status: PAYMENT_STATUS,
  postFn: 'postClientReceipt', voidFn: 'voidClientReceipt', dependents: '',
}

// ── Messages that name documents ─────────────────────────────────────────────

const money = (cents) => fromCents(cents).toFixed(2)

// "A", "A and B", "A, B and C", "A, B, C and 2 more".
function listUpToThree(items) {
  const shown = items.slice(0, 3)
  const more = items.length - shown.length
  if (more > 0) return `${shown.join(', ')} and ${more} more`
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0]
}

// The over-allocation refusal ALWAYS starts with this sentence, so a dialog
// recognises it by contract (`message.startsWith(…)`), never by its wording.
export const CLIENT_RECEIPT_OVER_ALLOCATION_PREFIX = 'The balance of an invoice changed since this receipt was prepared.'

// `invoices` — [{ invoiceNumber, remainingCents, excessCents }] from the server.
export function clientReceiptOverAllocationMessage(invoices) {
  const rows = (Array.isArray(invoices) ? invoices : [])
    .map(i => `${i.invoiceNumber || 'An invoice'} has ${money(i.remainingCents)} remaining and this receipt allocates ${money(i.excessCents)} more than that`)
  const detail = rows.length > 0 ? ` ${listUpToThree(rows)}.` : ''
  return `${CLIENT_RECEIPT_OVER_ALLOCATION_PREFIX}${detail} Nothing was posted. `
    + 'Review the allocations, or tick the over-allocation acknowledgement to post anyway.'
}

// A void refused by a ledger invariant: the entries posted AFTER it that still
// stand, when the server could name them; otherwise the generic wording.
function invariantMessage(kind, details, operation) {
  const generic = `${details?.invariant || 'This would leave the invoice in a position that is not allowed.'} `
    + (operation === 'void' ? kind.dependents : `This ${kind.noun} cannot be posted.`)
  const numbers = (details?.blockingEntries ?? []).map(e => e?.number).filter(Boolean)
  if (operation !== 'void' || numbers.length === 0) return generic
  const names = listUpToThree(numbers)
  return `${details.number || `This ${kind.noun}`} cannot be voided while ${names}, posted after it, still ${numbers.length === 1 ? 'stands' : 'stand'}. `
    + `Void ${names} first.`
}

// A release void refused because receipts rely on the released retention.
// The server lists the receipts it can FIND. Receipts recorded before posting
// moved to the server count in the invoice's received figure but cannot be
// looked up by invoice, so when the listed receipts do not explain the whole
// figure (`unlistedReceivedCents`) the message says so — it never implies the
// list is complete.
function receiptsDependMessage(kind, details) {
  const receipts = (details?.blockingReceipts ?? []).filter(r => r?.number)
  const unlisted = details?.unlistedReceivedCents > 0
  if (receipts.length === 0 && !unlisted) {
    return 'Receipts are already allocated against this released retention, so the server refused to void it. '
      + 'Void or re-allocate those receipts before voiding the release.'
  }
  const subject = details.number || `This ${kind.noun}`
  if (unlisted) {
    const since = typeof details.receiptBaselineAt === 'string' ? details.receiptBaselineAt.slice(0, 10) : ''
    const others = since ? `receipts recorded before ${since}` : 'other receipts not listed here'
    const who = receipts.length === 0
      ? `${others[0].toUpperCase()}${others.slice(1)} have`
      : `${receipts.length === 1 ? 'receipt' : 'receipts'} ${listUpToThree(receipts.map(r => r.number))} and ${others} have together`
    return `${subject} cannot be voided: ${who} allocated ${money(details.receivedCents)} to this invoice, `
      + `more than the ${money(details.receivableBasisAfterCents ?? 0)} it would be owed without this release. `
      + 'Void or re-allocate receipts on this invoice first — check the receipts list for every receipt allocated to it.'
  }
  const names = listUpToThree(receipts.map(r => r.number))
  if (receipts.length === 1) {
    return `${subject} cannot be voided: receipt ${names} has allocated ${money(details.receivedCents ?? receipts[0].allocatedCents)} to this invoice, `
      + `more than the ${money(details.receivableBasisAfterCents ?? 0)} it would be owed without this release. Void or re-allocate ${names} first.`
  }
  return `${subject} cannot be voided: receipts ${names} have allocated ${money(details.receivedCents)} to this invoice, `
    + `more than the ${money(details.receivableBasisAfterCents)} it would be owed without this release. Void or re-allocate them first.`
}

// The callable's `details.code` (functions/src/lib/errors.js) → what the user
// is told. Every one of these is a REFUSAL: the server wrote nothing.
const SERVER_REFUSALS = {
  'unauthenticated':                   () => 'Your session has ended. Nothing was changed — sign in again and retry.',
  'no-membership':                     () => 'You do not have permission to do this. Nothing was changed.',
  'membership-inactive':               () => 'Your membership is no longer active. Nothing was changed.',
  'client-finance-forbidden':          () => 'Only a Company Admin, Project Manager or QS can post or void this. Nothing was changed.',
  'invalid-argument':                  () => 'The server rejected this request. Nothing was changed.',
  'not-found':                         () => 'This project could not be found. Nothing was changed — reload the page.',
  'client-entry-not-found':            (k) => `This ${k.noun} no longer exists. Nothing was changed — reload the page.`,
  'client-entry-invalid':              (k, d) => `This ${k.noun} is not stored as Constrap writes one${d?.field ? ` (${d.field})` : ''}, so it cannot be posted or voided. Nothing was changed.`,
  'client-entry-not-draft':            (k) => `This ${k.noun} is no longer a draft — it has already been posted or voided. Nothing was changed.`,
  'client-entry-not-posted':           (k) => `This ${k.noun} is already void. Nothing was changed.`,
  'client-invoice-not-issued':         (k, d) => `${d?.invoiceNumber || 'The client invoice'} is missing or is no longer issued. Nothing was changed.`,
  'client-invoice-mismatch':           (k, d) => `${d?.invoiceNumber || 'The client invoice'} belongs to a different client or currency than this ${k.noun}, or no longer carries that number. Nothing was changed.`,
  'client-invoice-inconsistent':       () => 'The client invoice stores totals that do not reconcile to its own lines, so nothing can be posted against it. Nothing was changed.',
  // EXACTLY this text: the post dialogs offer "Refresh figures" when they see it.
  'client-entry-figures-changed':      () => CLIENT_ENTRY_STALE_TEXT,
  'client-ledger-invariant':           (k, d, op) => invariantMessage(k, d, op),
  'client-receipts-depend-on-release': (k, d) => receiptsDependMessage(k, d),
  'client-receipt-over-allocated':     (k, d) => clientReceiptOverAllocationMessage(d?.invoices),
  'client-receipt-future-dated':       (k, d) => `The receipt date${d?.receiptDate ? ` (${d.receiptDate})` : ''} is in the future. A receipt records money already received, so it can only be posted on or after that date. Nothing was posted.`,
  'client-receipt-disabled':           () => 'Posting and voiding client receipts is temporarily unavailable. Nothing was changed.',
  'client-finance-disabled':           () => 'Posting and voiding credit notes and retention releases is temporarily unavailable. Nothing was changed.',
  'client-finance-busy':               () => 'This invoice was being changed at the same moment. Nothing was changed — try again.',
  // EXACTLY the server's own text (functions/src/lib/errors.js).
  'client-finance-not-activated':      () => 'Client credit notes and retention releases are not yet available for this company. Nothing was changed.',
  'client-receipt-baseline-missing':   () => 'The receipt history of this project has not been brought into the invoice ledgers yet, so nothing can be posted or voided. Nothing was changed — try again.',
  'client-receipt-baseline-inconsistent': (k, d) => `The receipt history of this project does not agree with its invoice ledgers${d?.number ? ` (receipt ${d.number})` : ''}, so nothing can be posted or voided until it is reviewed. Nothing was changed — contact support.`,
  'client-receipt-baseline-invalid':   (k, d) => `${d?.number ? `Receipt ${d.number}` : 'A receipt'}, posted earlier on this project, is not stored as Constrap writes one${d?.field ? ` (${d.field})` : ''}, so the receipt history cannot be brought into the invoice ledgers. Nothing was changed — contact support.`,
  'client-receipt-baseline-too-large': () => 'The earlier receipt history of this project is too large to be brought into the invoice ledgers automatically. Nothing was changed — contact support.',
  'client-amount-out-of-range':        (k, d) => `${d?.invoiceNumber || (d?.field === 'amount' ? `This ${k.noun}` : 'The client invoice')} is above the largest amount Constrap supports, so nothing can be posted. Nothing was changed.`,
}

// An outcome the server did NOT state. `code` is a status lib/writeOutcome.js
// knows as ambiguous, so a dialog reports it as unconfirmed — never as "nothing
// was saved". Repeating the request is safe: the callables answer a request
// that already landed without moving the ledger again.
export class ClientFinanceUncertainError extends Error {
  constructor(code, cause) {
    super('The server did not confirm this. It may still have completed — check the list before trying again.', { cause })
    this.name = 'ClientFinanceUncertainError'
    this.code = code
  }
}

// Whatever a callable threw → the error the hook rejects with.
//   · a typed refusal            → a plain Error carrying the user-ready message
//                                  (lib/writeOutcome.js shows a plain Error's
//                                  own text, as a definite failure)
//   · refused before the handler → the same, for a rejected session or App Check
//     ran                          token, and for a server that does not have
//                                  the callable yet
//   · anything else              → ClientFinanceUncertainError: a timeout, a
//                                  dropped connection, an internal error
//
// An UNTYPED `unauthenticated` has two causes the server cannot tell apart for
// us: the session ended, or App Check refused the app before the handler ran.
// `isSignedIn()` — whether the browser still holds a signed-in user — does:
// with a user present it was App Check (tracker D3 #38).
export const APP_CHECK_REFUSED_TEXT =
  'The server could not verify this app (App Check), so the request was refused. Nothing was changed — reload the page and try again.'

export function clientFinanceCallError(err, kind, operation, isSignedIn = () => false) {
  const typed = SERVER_REFUSALS[err?.details?.code]
  if (typed) return refusal(typed(kind, err.details, operation), err.details.code)
  const code = String(err?.code ?? '').replace(/^functions\//, '')
  if (code === 'unauthenticated') return refusal(isSignedIn() ? APP_CHECK_REFUSED_TEXT : SERVER_REFUSALS.unauthenticated(), code)
  if (code === 'permission-denied') return refusal(SERVER_REFUSALS['no-membership'](), code)
  if (code === 'not-found' || code === 'unimplemented') {
    return refusal('Posting and voiding is not available on this server yet. Nothing was changed.', code)
  }
  return new ClientFinanceUncertainError(code === 'unavailable' || code === 'deadline-exceeded' ? code : 'unknown', err)
}

// A plain Error on purpose, with no `code` and no `cause`: lib/writeOutcome.js
// reads either as a transport status and would replace this message.
function refusal(message, serverCode) {
  const error = new Error(message)
  error.serverCode = serverCode
  return error
}

// `call(name, data)` invokes one callable and resolves to its result.
async function callClientFinance(call, data, kind, operation = 'post', isSignedIn = undefined) {
  try {
    return await call(operation === 'void' ? kind.voidFn : kind.postFn, data)
  } catch (err) {
    throw clientFinanceCallError(err, kind, operation, isSignedIn)
  }
}

// The shared void. One client transaction reads the entry: a DRAFT is voided
// in it; a POSTED entry is left untouched and handed to the callable, which
// re-reads everything itself (an entry posted or voided in between is the
// server's to answer).
async function voidEntry({ db, runTransaction, serverTimestamp, uid, ref, reason, call, projectId, isSignedIn }, kind) {
  const voidReason = text(reason)
  if (!voidReason) throw new Error(`Enter a reason for voiding this ${kind.noun}.`)
  if (voidReason.length > VOID_REASON_MAX) throw new Error(`The reason cannot be longer than ${VOID_REASON_MAX} characters.`)
  const found = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error(`${kind.Noun} not found.`)
    const status = snap.data().status
    if (status === kind.status.VOID) throw new Error(`This ${kind.noun} is already void.`)
    if (status !== kind.status.DRAFT) return status
    tx.update(ref, {
      status: kind.status.VOID,
      voidedAt: serverTimestamp(), voidedBy: uid, voidReason,
      updatedAt: serverTimestamp(), updatedBy: uid,
    })
    return status
  })
  if (found === kind.status.DRAFT) return { status: kind.status.VOID, [kind.idKey]: ref.id }
  return callClientFinance(call, { projectId, [kind.idKey]: ref.id, reason: voidReason }, kind, 'void', isSignedIn)
}

// ── Credit notes ─────────────────────────────────────────────────────────────

function creditBody(invoice, built, input) {
  return {
    creditDate:            input.creditDate,
    reason:                text(input.reason),
    clientCreditReference: text(input.clientCreditReference),
    notes:                 text(input.notes),
    lineItems:             built.lineItems,
    ...built.totals,
    ledgerSeq:             built.ledgerSeq,
  }
}

// Creates a DRAFT credit note against `invoiceRef`. `stageCurrencyLock(tx)` is
// the project currency ratchet (hooks/projectCurrencyLock.js).
export async function runClientCreditCreate({
  db, runTransaction, serverTimestamp, uid, currency,
  counterRef, creditRef, invoiceRef, ledgerRef, stageCurrencyLock, input,
}) {
  await runTransaction(db, async (tx) => {
    const counterSnap = await tx.get(counterRef)
    const invoice = invoiceOf(await tx.get(invoiceRef))
    const ledgerDoc = ledgerOf(await tx.get(ledgerRef))
    const commitLock = await stageCurrencyLock(tx)

    if (!invoice) throw new Error('The client invoice could not be found on this project.')
    const error = validateClientCreditDraft({ ...input, clientInvoiceId: invoice.id }, { invoice, ledgerDoc })
      ?? clientEntryTextError(CLIENT_ENTRY_SHAPES.creditNote, input)
    if (error) throw new Error(error)
    const built = buildClientCreditNote(invoice, ledgerDoc, input.rows)

    const next = counterSnap.exists() ? counterSnap.data().next : 1
    tx.set(counterRef, { next: next + 1 }, { merge: true })
    tx.set(creditRef, {
      creditNumber: formatClientCreditNoteNumber(next),
      status:       CCN_STATUS.DRAFT,
      docType:      CCN_DOC_TYPE,
      // The TARGET and its snapshots — frozen for the life of the document.
      ...invoiceSnapshot(invoice),
      ...creditBody(invoice, built, input),
      currency:  invoice.currency || currency,
      revision:  1,
      ...pristineLifecycle(),
      createdAt: serverTimestamp(), createdBy: uid,
      updatedAt: serverTimestamp(), updatedBy: uid,
    })
    commitLock()
  })
  return creditRef.id
}

// Re-saves a DRAFT against the invoice's CURRENT ledger (also the way a stale
// draft is refreshed).
export async function runClientCreditUpdate({
  db, runTransaction, serverTimestamp, uid, creditRef, invoiceRef, ledgerRef, input,
}) {
  await runTransaction(db, async (tx) => {
    const creditSnap = await tx.get(creditRef)
    const invoice = invoiceOf(await tx.get(invoiceRef))
    const ledgerDoc = ledgerOf(await tx.get(ledgerRef))
    if (!creditSnap.exists()) throw new Error('Credit note not found.')
    if (creditSnap.data().status !== CCN_STATUS.DRAFT) throw new Error('Only a draft credit note can be edited.')
    if (!invoice) throw new Error('The client invoice could not be found on this project.')
    const error = validateClientCreditDraft({ ...input, clientInvoiceId: invoice.id }, { invoice, ledgerDoc })
      ?? clientEntryTextError(CLIENT_ENTRY_SHAPES.creditNote, input)
    if (error) throw new Error(error)
    const built = buildClientCreditNote(invoice, ledgerDoc, input.rows)
    tx.update(creditRef, {
      ...creditBody(invoice, built, input),
      updatedAt: serverTimestamp(), updatedBy: uid,
    })
  })
}

// Posting is the trusted callable `postClientCreditNote`: identifiers only.
export async function runClientCreditPost({ call, projectId, creditNoteId, isSignedIn }) {
  return callClientFinance(call, { projectId, creditNoteId }, CREDIT_NOTE, 'post', isSignedIn)
}

// Void. A DRAFT has moved nothing and is voided here, by a client transaction
// the Rules allow. A POSTED credit note is taken back out of the ledger by the
// trusted callable `voidClientCreditNote` — the browser cannot write a ledger.
export async function runClientCreditVoid({
  db, runTransaction, serverTimestamp, uid, creditRef, reason, call, projectId, isSignedIn,
}) {
  return voidEntry({ db, runTransaction, serverTimestamp, uid, ref: creditRef, reason, call, projectId, isSignedIn }, CREDIT_NOTE)
}

// ── Retention releases ───────────────────────────────────────────────────────

const releaseBody = (built, input) => ({
  releaseDate: input.releaseDate,
  reason:      text(input.reason),
  notes:       text(input.notes),
  amount:       built.amount,
  gstAmount:    built.gstAmount,
  releaseTotal: built.releaseTotal,
  ledgerSeq:    built.ledgerSeq,
})

export async function runClientReleaseCreate({
  db, runTransaction, serverTimestamp, uid, currency,
  counterRef, releaseRef, invoiceRef, ledgerRef, stageCurrencyLock, input,
}) {
  await runTransaction(db, async (tx) => {
    const counterSnap = await tx.get(counterRef)
    const invoice = invoiceOf(await tx.get(invoiceRef))
    const ledgerDoc = ledgerOf(await tx.get(ledgerRef))
    const commitLock = await stageCurrencyLock(tx)

    if (!invoice) throw new Error('The client invoice could not be found on this project.')
    const error = validateClientReleaseDraft({ ...input, clientInvoiceId: invoice.id }, { invoice, ledgerDoc })
      ?? clientEntryTextError(CLIENT_ENTRY_SHAPES.retentionRelease, input)
    if (error) throw new Error(error)
    const built = buildClientRetentionRelease(invoice, ledgerDoc, input.amount)

    const next = counterSnap.exists() ? counterSnap.data().next : 1
    tx.set(counterRef, { next: next + 1 }, { merge: true })
    tx.set(releaseRef, {
      releaseNumber: formatClientRetentionReleaseNumber(next),
      status:        CRR_STATUS.DRAFT,
      docType:       CRR_DOC_TYPE,
      ...invoiceSnapshot(invoice),
      ...releaseBody(built, input),
      currency:  invoice.currency || currency,
      revision:  1,
      ...pristineLifecycle(),
      createdAt: serverTimestamp(), createdBy: uid,
      updatedAt: serverTimestamp(), updatedBy: uid,
    })
    commitLock()
  })
  return releaseRef.id
}

export async function runClientReleaseUpdate({
  db, runTransaction, serverTimestamp, uid, releaseRef, invoiceRef, ledgerRef, input,
}) {
  await runTransaction(db, async (tx) => {
    const releaseSnap = await tx.get(releaseRef)
    const invoice = invoiceOf(await tx.get(invoiceRef))
    const ledgerDoc = ledgerOf(await tx.get(ledgerRef))
    if (!releaseSnap.exists()) throw new Error('Retention release not found.')
    if (releaseSnap.data().status !== CRR_STATUS.DRAFT) throw new Error('Only a draft retention release can be edited.')
    if (!invoice) throw new Error('The client invoice could not be found on this project.')
    const error = validateClientReleaseDraft({ ...input, clientInvoiceId: invoice.id }, { invoice, ledgerDoc })
      ?? clientEntryTextError(CLIENT_ENTRY_SHAPES.retentionRelease, input)
    if (error) throw new Error(error)
    const built = buildClientRetentionRelease(invoice, ledgerDoc, input.amount)
    tx.update(releaseRef, { ...releaseBody(built, input), updatedAt: serverTimestamp(), updatedBy: uid })
  })
}

// Posting is the trusted callable `postClientRetentionRelease`.
export async function runClientReleasePost({ call, projectId, releaseId, isSignedIn }) {
  return callClientFinance(call, { projectId, releaseId }, RETENTION_RELEASE, 'post', isSignedIn)
}

// Void. A DRAFT is voided here; a POSTED release by the trusted callable
// `voidClientRetentionRelease`, which reads what posted receipts have allocated
// to the invoice from the invoice's ledger and refuses the void when that would
// no longer fit what is receivable — naming the receipts. The browser sends no
// receipt figure and decides nothing.
export async function runClientReleaseVoid({
  db, runTransaction, serverTimestamp, uid, releaseRef, reason, call, projectId, isSignedIn,
}) {
  return voidEntry({ db, runTransaction, serverTimestamp, uid, ref: releaseRef, reason, call, projectId, isSignedIn }, RETENTION_RELEASE)
}

// ── Client receipts ──────────────────────────────────────────────────────────

// Posting is the trusted callable `postClientReceipt`. `acknowledgeOverAllocation`
// says only whether the user ticked the acknowledgement; whether one was NEEDED
// is the server's decision, from each invoice's ledger as it stands at posting.
// A receipt prepared before a credit note or a release void lowered an
// invoice's balance is refused with CLIENT_RECEIPT_OVER_ALLOCATION_PREFIX…
// unless it was acknowledged.
export async function runClientReceiptPost({ call, projectId, receiptId, acknowledgeOverAllocation = false, isSignedIn }) {
  return callClientFinance(call, { projectId, receiptId, acknowledgeOverAllocation: acknowledgeOverAllocation === true }, RECEIPT, 'post', isSignedIn)
}

// Void. A DRAFT receipt moved no money and is voided here; a POSTED receipt is
// voided by the trusted callable `voidClientReceipt`, which takes its
// allocations back out of each invoice's ledger.
export async function runClientReceiptVoid({
  db, runTransaction, serverTimestamp, uid, receiptRef, reason, call, projectId, isSignedIn,
}) {
  return voidEntry({ db, runTransaction, serverTimestamp, uid, ref: receiptRef, reason, call, projectId, isSignedIn }, RECEIPT)
}
