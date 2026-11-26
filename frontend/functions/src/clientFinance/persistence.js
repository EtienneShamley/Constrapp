import { FieldValue } from '../lib/firebaseAdmin.js'
import { CODE, fail } from '../lib/errors.js'
import * as calc from '../generated/clientFinanceCalc.js'

// ── Client-finance callables — references, reads and writes (ADR-89) ─────────
//
// The ONLY documents an operation writes: the entry (a credit note, a release
// or a receipt), the ledger of each invoice it moves and one audit event.
// Nothing is ever written onto a client invoice, a budget line or any other
// register. (The once-per-project receipt baseline — baseline.js — writes
// ledgers, its marker and one audit event, and nothing else.)
//
// Every write carries a `lastUpdateTime` precondition (or is a `create`), so a
// document that changed after the transaction read it can never be overwritten.

export const dataOf = (snap) => (snap.exists ? { id: snap.id, ...snap.data() } : null)

// Every path is built under the CALLER'S company (transactions.js): another
// tenant's project or entry id resolves to a document that does not exist.
export function projectRefs(db, companyId, projectId) {
  const company = db.collection('companies').doc(companyId)
  return { company, project: company.collection('projects').doc(projectId) }
}

export const entryRef = (projectRef, collection, entryId) => projectRef.collection(collection).doc(entryId)
export const invoiceRef = (projectRef, invoiceId) => projectRef.collection('clientInvoices').doc(invoiceId)
// ONE ledger per invoice — its id IS the invoice id (lib/clientLedger.js).
export const ledgerRef = (projectRef, invoiceId) => projectRef.collection('clientInvoiceLedgers').doc(invoiceId)

// The marker of the project's historical receipt baseline (baseline.js). No
// Security Rule matches `clientFinanceState`: it is server-only.
export const receiptBaselineRef = (projectRef) => projectRef.collection('clientFinanceState').doc('receiptBaseline')

// A stored ledger as the operation may use it — or a refusal. A figure that is
// present but not a whole, non-negative, safe number of cents is NEVER read as
// zero: the request is refused and nothing is written. A ledger that does not
// exist is the empty state — exactly zero, because the project's receipt
// baseline exists (the transaction has just read its marker).
export function readStoredLedger(ledgerSnap) {
  const doc = ledgerSnap.exists ? ledgerSnap.data() : null
  const problem = calc.storedLedgerProblem(doc)
  if (problem) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: problem, invoiceId: ledgerSnap.id })
  return { doc, state: calc.readLedger(doc) }
}

// The next ledger state: a create by the first posting against the invoice,
// an update afterwards (`lines` is replaced whole, as one field). An UPDATE
// names exactly the fields of `ledgerDocument`, so the permanent
// `receiptBaseline` record of a ledger is never rewritten and never dropped.
// Every figure written is a whole, non-negative, SAFE number of cents — a
// total that is not is refused here, whatever produced it.
export function writeLedger(tx, ref, ledgerSnap, next, uid) {
  const problem = calc.ledgerStateProblem(next)
  if (problem) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: problem, invoiceId: ref.id })
  const body = { ...calc.ledgerDocument(next), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }
  if (ledgerSnap.exists) tx.update(ref, body, { lastUpdateTime: ledgerSnap.updateTime })
  else tx.create(ref, { ...body, createdAt: FieldValue.serverTimestamp(), createdBy: uid })
}

// Posting changes the status and its stamps — never a figure: the stored
// figures were just proven equal to the server's own derivation.
export function stampPosted(tx, ref, entrySnap, status, uid) {
  tx.update(ref, {
    status,
    postedAt: FieldValue.serverTimestamp(), postedBy: uid,
    updatedAt: FieldValue.serverTimestamp(), updatedBy: uid,
  }, { lastUpdateTime: entrySnap.updateTime })
}

export function stampVoid(tx, ref, entrySnap, status, uid, reason) {
  tx.update(ref, {
    status,
    voidedAt: FieldValue.serverTimestamp(), voidedBy: uid, voidReason: reason,
    updatedAt: FieldValue.serverTimestamp(), updatedBy: uid,
  }, { lastUpdateTime: entrySnap.updateTime })
}

// The ledger figures an audit event carries: `seq`, the six running totals and
// what posted receipts have allocated to the invoice.
export const ledgerTotals = (state) => ({
  seq: state.seq,
  ...Object.fromEntries(calc.LEDGER_TOTAL_KEYS.map(key => [key, state[key]])),
  receivedCents: state.receivedCents,
})

export const receiptRef = (projectRef, receiptId) => projectRef.collection('clientReceipts').doc(receiptId)

// A posted receipt also records WHICH invoices it allocated to, as an array the
// server writes, so "the receipts that touch this invoice" is one indexed
// lookup and never a scan of the register.
export function stampReceiptPosted(tx, ref, receiptSnap, status, uid, allocatedInvoiceIds) {
  tx.update(ref, {
    status, allocatedInvoiceIds,
    postedAt: FieldValue.serverTimestamp(), postedBy: uid,
    updatedAt: FieldValue.serverTimestamp(), updatedBy: uid,
  }, { lastUpdateTime: receiptSnap.updateTime })
}
