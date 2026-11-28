import { CODE, fail } from '../lib/errors.js'
import { userRef, assertActiveRole } from '../lib/authz.js'
import { requireCommercialActivationInTx } from '../lib/commercialActivation.js'
import * as calc from '../generated/supplierFinanceCalc.js'

// ── Shared transaction plumbing for the supplier-finance callables ───────────
//
// ADR-93 / ADR-94. Every operation is ONE read-write transaction, every read
// before any write, the caller's membership read INSIDE it (active, of a
// company, company_admin / project_manager / qs) and the company taken from
// that document — never from the request — so another tenant's project or
// document is simply not found.

export const SUPPLIER_FINANCE_ROLES = calc.CLAIM_PROCESSING_ROLES
export const SF_MAX_ATTEMPTS = 5
export const COUNTER_MAX = 999_999_999

// gRPC ABORTED — the transaction lost to concurrent writes on every attempt:
// the ONE transport failure with a certain outcome (nothing committed). Every
// other unexpected failure is rethrown untyped — its outcome is not certain
// and a retry is safe (each operation is idempotent by state).
const GRPC_ABORTED = 10

export async function runGuarded(db, log, context, body, attemptsSoFar) {
  try {
    return await db.runTransaction(body, { maxAttempts: SF_MAX_ATTEMPTS })
  } catch (err) {
    if (!err?.details?.code && err?.code === GRPC_ABORTED) {
      log.warn('supplier-finance request aborted by contention', { ...context, attempts: attemptsSoFar() })
      fail(CODE.SF_BUSY, { attempts: attemptsSoFar() })
    }
    throw err
  }
}

export const withId = (snap) => (snap.exists ? { ...snap.data(), id: snap.id } : null)
export const cents = (amount) => (typeof amount === 'number' ? Math.round(amount * 100) : null)

export function projectScope(db, companyId, projectId) {
  const companyRef = db.collection('companies').doc(companyId)
  const projectRef = companyRef.collection('projects').doc(projectId)
  return {
    companyId, companyRef, projectRef,
    claims: projectRef.collection('progressClaims'),
    invoices: projectRef.collection('supplierInvoices'),
    credits: projectRef.collection('supplierCreditNotes'),
    releases: projectRef.collection('retentionReleases'),
    payments: projectRef.collection('supplierPayments'),
    purchaseOrders: projectRef.collection('purchaseOrders'),
    variations: projectRef.collection('variations'),
    invoiceLedgers: projectRef.collection('supplierInvoiceLedgers'),
    poClaimLedgers: projectRef.collection('poClaimLedgers'),
    baselineRef: projectRef.collection('supplierFinanceState').doc('baseline'),
  }
}

// The caller, read inside the transaction; the scope of THE CALLER'S company.
export async function callerScope(tx, db, uid, projectId) {
  const profileSnap = await tx.get(userRef(db, uid))
  const profile = assertActiveRole(profileSnap.exists ? profileSnap.data() : null, SUPPLIER_FINANCE_ROLES, CODE.SUPPLIER_FINANCE_FORBIDDEN)
  await requireCommercialActivationInTx(tx, db, profile.companyId)
  return { ...projectScope(db, profile.companyId, projectId), profile }
}

// The project's baseline marker must exist AND be `complete`
// (ensureSupplierBaseline runs before every operation); read inside the
// transaction, so an operation can never act on a baseline that is absent,
// still building, or being rebuilt — and never interleaves with one unseen.
export function requireBaseline(markerSnap) {
  if (!markerSnap.exists || markerSnap.data().state !== 'complete') fail(CODE.SF_BASELINE_INVALID, { reason: markerSnap.exists ? 'incomplete' : 'missing' })
}

// A number counter is a positive whole number up to COUNTER_MAX, or refused.
export function nextNumber(counterSnap) {
  const next = counterSnap.exists ? counterSnap.data().next : 1
  if (!Number.isSafeInteger(next) || next < 1 || next > COUNTER_MAX) fail(CODE.SF_UNSUPPORTED_RECORD, { reason: 'counter' })
  return next
}

// A stored invoice ledger as { state, problem, ledger, exists }. Once the
// project baseline exists a missing ledger means nothing has been posted
// against the invoice. A malformed stored figure is refused, never zero.
export function invoiceLedgerEntry(snap) {
  if (!snap.exists) return { exists: false, state: 'established', problem: null, ledger: calc.emptySupplierLedger(), malformedEntryIds: [], malformedOverflow: false }
  const doc = snap.data()
  // An INCONSISTENT ledger may carry a negative figure (a malformed historical
  // entry summed in): it is still readable — as whole numbers — so that the
  // one void that removes the entry can run. Postings never run on it, and a
  // void must leave no negative figure (the corrective-void rule). Anything
  // that is not a safe whole number is refused in every state.
  const inconsistent = doc.state === 'inconsistent'
  const stored = inconsistent
    ? ([...['seq', ...calc.SUPPLIER_LEDGER_TOTAL_KEYS].map(k => doc[k]), ...Object.values(doc.groups ?? {}).flatMap(g => [g?.amountCents, g?.gstCents])]
      .some(v => v !== undefined && !Number.isSafeInteger(v)) ? 'A ledger figure is not a whole number of cents.' : null)
    : calc.storedSupplierLedgerProblem(doc)
  if (stored) fail(CODE.SF_LEDGER_INCONSISTENT, { reason: 'stored', message: stored })
  return {
    exists: true, state: doc.state === 'inconsistent' ? 'inconsistent' : 'established', problem: doc.problem ?? null, ledger: calc.readSupplierLedger(doc),
    malformedEntryIds: Array.isArray(doc.malformedEntryIds) ? doc.malformedEntryIds.filter(i => typeof i === 'string') : [], malformedOverflow: doc.malformedOverflow === true,
  }
}

export function poClaimLedgerEntry(snap) {
  if (!snap.exists) return calc.emptyPoClaimLedger()
  const doc = snap.data()
  const stored = calc.storedPoClaimLedgerProblem(doc)
  if (stored) fail(CODE.SF_LEDGER_INCONSISTENT, { reason: 'stored', message: stored })
  return calc.readPoClaimLedger(doc)
}

// Writes a ledger state: `set` with merge keeps the baseline record, which is
// written once and never rewritten. A ledger that was inconsistent becomes
// established again only when the state it now holds passes every invariant.
export function writeInvoiceLedger(tx, ref, ledger, { now, invoiceId, state = 'established', problem = null, malformedEntryIds = [] }) {
  tx.set(ref, { ...calc.supplierLedgerDocument(ledger), invoiceId, state, problem, malformedEntryIds, version: calc.SUPPLIER_LEDGER_VERSION, updatedAt: now }, { merge: true })
}

export function writePoClaimLedger(tx, ref, ledger, { now, poId }) {
  tx.set(ref, { ...calc.poClaimLedgerDocument(ledger), poId, state: 'established', problem: null, updatedAt: now }, { merge: true })
}

// Maps a domain problem to a typed failure.
const PROBLEM_CODE = {
  [calc.CLAIM_PROBLEM.PO_INVALID]: CODE.SF_INVALID,
  [calc.CLAIM_PROBLEM.OPEN_CLAIM]: CODE.SF_OPEN_CLAIM,
  [calc.CLAIM_PROBLEM.LINES_INVALID]: CODE.SF_INVALID,
  [calc.CLAIM_PROBLEM.VARIATION_LINE]: CODE.SF_INVALID,
  [calc.CLAIM_PROBLEM.DRAFT_INVALID]: CODE.SF_INVALID,
  [calc.CLAIM_PROBLEM.OUT_OF_RANGE]: CODE.SF_OUT_OF_RANGE,
  [calc.CLAIM_PROBLEM.FIGURES]: CODE.SF_FIGURES_INCONSISTENT,
  [calc.CLAIM_PROBLEM.LEDGER]: CODE.SF_LEDGER_INCONSISTENT,
  [calc.INVOICE_PROBLEM.CLAIM_INVALID]: CODE.SF_INVALID,
  [calc.INVOICE_PROBLEM.CLAIM_STALE]: CODE.SF_STALE,
  [calc.INVOICE_PROBLEM.ALREADY_INVOICED]: CODE.SF_ALREADY_INVOICED,
  [calc.INVOICE_PROBLEM.LEGACY_CLAIM]: CODE.SF_LEGACY_CLAIM,
  [calc.INVOICE_PROBLEM.NOT_RECONCILED]: CODE.SF_FIGURES_INCONSISTENT,
  [calc.INVOICE_PROBLEM.NOT_LINKED]: CODE.SF_NOT_LINKED,
  [calc.SETTLEMENT_PROBLEM.INVOICE_INVALID]: CODE.SF_INVALID,
  [calc.SETTLEMENT_PROBLEM.LEDGER]: CODE.SF_LEDGER_INCONSISTENT,
  [calc.SETTLEMENT_PROBLEM.CAP]: CODE.SF_CAP_EXCEEDED,
  [calc.SETTLEMENT_PROBLEM.DRAFT_INVALID]: CODE.SF_INVALID,
  [calc.SETTLEMENT_PROBLEM.FIGURES_MOVED]: CODE.SF_FIGURES_MOVED,
  [calc.SETTLEMENT_PROBLEM.DEPENDENCY]: CODE.SF_DEPENDENCY,
  [calc.SETTLEMENT_PROBLEM.FUTURE_DATED]: CODE.SF_FUTURE_DATED,
  [calc.SETTLEMENT_PROBLEM.SUPPLIER]: CODE.SF_INVALID,
}

export function failProblem(built) {
  const { problem, message, ...detail } = built
  fail(PROBLEM_CODE[problem] ?? CODE.SF_INVALID, { problem, message, ...detail })
}

// The revision gate shared by every edit and transition.
export function requireRevision(live, expected) {
  const stored = Number.isSafeInteger(live?.revision) ? live.revision : 0
  if (stored !== expected) fail(CODE.SF_STALE, { revision: stored })
}
