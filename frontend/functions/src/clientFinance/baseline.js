import { FieldValue } from '../lib/firebaseAdmin.js'
import { CODE, fail } from '../lib/errors.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import { isValidId } from '../lib/validation.js'
import * as calc from '../generated/clientFinanceCalc.js'
import { runGuarded } from './transactions.js'
import { projectRefs, ledgerRef, receiptBaselineRef } from './persistence.js'

// ── The historical receipt baseline (ADR-89, final pass) ─────────────────────
//
// `receivedCents` in an invoice's ledger must be EXACT — it decides whether a
// receipt over-allocates an invoice and whether a retention release may be
// voided. Receipts posted BEFORE posting became a backend operation ("legacy":
// status `posted`, no `allocatedInvoiceIds`) are in no ledger. So, ONCE per
// project, they are brought in:
//
//   companies/{c}/projects/{p}/clientFinanceState/receiptBaseline   (the marker)
//
// The marker is server-only: no Security Rule matches `clientFinanceState`, so
// no client can read or write it. While it is ABSENT every one of the six
// callables refuses (`client-receipt-baseline-missing`) — a missing baseline
// is never read as zero. Once it EXISTS, every posted receipt of the project
// is in its invoices' ledgers: the legacy ones through this baseline, every
// later one through the transaction that posted it (the Rules give a browser
// no other way to post). A missing ledger then means exactly zero received.
//
// `ensureReceiptBaseline` is ONE read-write transaction, every read before any
// write:
//   1. the marker — present: return, nothing else is read;
//   2. the company and the project (another tenant's project id is not found);
//   3. the project's POSTED receipts, by one equality query INSIDE the
//      transaction — so a receipt cannot be posted between the sum and the
//      marker. EVERY result must be legacy: a posted receipt that already
//      carries `allocatedInvoiceIds` while no marker exists is a state this
//      code never produces, and is refused (`…-inconsistent`);
//   4. every allocation of every such receipt, STRICTLY and summed per invoice
//      in whole cents (the bundle's `receiptBaselineSums` — no arithmetic
//      here): a malformed, non-positive or
//      fraction-of-a-cent allocation is refused NAMING THE RECEIPT
//      (`…-invalid`) — never skipped, so the sum can never be short;
//   5. the ledger of each invoice those allocations name (the invoice itself
//      is not read: history is recorded as it is, whatever became of it);
//   6. the writes — per invoice, `receivedCents` = the legacy sum and a
//      permanent `receiptBaseline` record; the marker (`create`); ONE audit
//      event. All of it, or none of it.
//
// No historical receipt and no invoice is ever written.
//
// ⚠️ THE ONE BOUND. A transaction holds at most 500 writes, so a project whose
// legacy receipts touch more than RECEIPT_BASELINE_MAX_INVOICES invoices is
// refused (`…-too-large`) and needs an operator baseline. This bounds ONLY the
// history that existed before the cutover: it is fixed on the day posting
// becomes a backend operation and can never grow, because every later receipt
// is posted through the ledger. It is not a limit on a project's receipts —
// the per-operation transactions read no receipt register at all.
//
// CONCURRENCY. Two calls on one project both read the marker; Firestore orders
// them, the second is retried, finds the marker and returns. Exactly one
// marker, one audit event and one baseline per ledger
// (tests/functions/clientReceiptBaseline.test.js).

export const RECEIPT_BASELINE_VERSION = 1
// The writes of one baseline: one ledger per invoice, the marker and the audit
// event — kept under 450 of the 500 a transaction may hold.
export const RECEIPT_BASELINE_MAX_WRITES = 450
export const RECEIPT_BASELINE_MAX_INVOICES = 448

// The empty ledger as it is stored: `ledgerDocument` of the bundle's empty
// state, without the two "last entry" fields — nothing has been posted.
function emptyLedgerDocument(receivedCents) {
  const state = { ...calc.readLedger(null), receivedCents }
  const problem = calc.ledgerStateProblem(state)
  if (problem) return { problem }
  const { lastEntryId: _id, lastEntryKind: _kind, ...doc } = calc.ledgerDocument(state)
  void _id
  void _kind
  return { doc }
}

// Resolves to `{ established, attempts }` — `established` true only for the
// call that wrote the baseline. Throws a typed refusal, nothing written:
//   not-found · client-receipt-baseline-inconsistent · …-invalid · …-too-large
//   · client-finance-busy (contention on every attempt).
export async function ensureReceiptBaseline(db, { companyId, projectId, uid }, { now = () => new Date(), log = { info() {}, warn() {} }, requestId = null } = {}) {
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId, operation: AUDIT.CLIENT_RECEIPT_BASELINE_ESTABLISHED }, async (tx) => {
    attempts += 1
    const refs = projectRefs(db, companyId, projectId)
    const marker = receiptBaselineRef(refs.project)

    // 1. Established already — the answer for every call but the first.
    if ((await tx.get(marker)).exists) return { established: false }

    // 2. The project, under the CALLER'S company.
    const [companySnap, projectSnap] = await tx.getAll(refs.company, refs.project)
    if (!companySnap.exists || !projectSnap.exists) fail(CODE.NOT_FOUND)

    // 3–4. Every posted receipt, and every allocation of each, strictly.
    const posted = await tx.get(refs.project.collection('clientReceipts').where('status', '==', calc.PAYMENT_STATUS.POSTED))
    const sums = calc.receiptBaselineSums(posted.docs.map(doc => ({ id: doc.id, ...doc.data() })), isValidId)
    if (sums.problem) {
      const { kind, ...named } = sums.problem
      if (kind === 'inconsistent') fail(CODE.CLIENT_RECEIPT_BASELINE_INCONSISTENT, { ...named, reason: 'posted-by-the-backend-without-a-baseline' })
      if (kind === 'invalid') fail(CODE.CLIENT_RECEIPT_BASELINE_INVALID, named)
      fail(CODE.CLIENT_AMOUNT_OUT_OF_RANGE, { ...named, field: 'allocations' })
    }
    if (sums.invoices.length > RECEIPT_BASELINE_MAX_INVOICES) {
      fail(CODE.CLIENT_RECEIPT_BASELINE_TOO_LARGE, { invoices: sums.invoices.length, maxInvoices: RECEIPT_BASELINE_MAX_INVOICES })
    }

    // 5. The ledger of each invoice with history.
    const ledgers = sums.invoices.map(row => ledgerRef(refs.project, row.invoiceId))
    const ledgerSnaps = ledgers.length > 0 ? await tx.getAll(...ledgers) : []

    // 6. The writes.
    for (const [i, { invoiceId, cents, receipts }] of sums.invoices.entries()) {
      const snap = ledgerSnaps[i]
      const receiptBaseline = { legacyCents: cents, legacyReceipts: receipts, establishedAt: FieldValue.serverTimestamp() }
      const stamps = { updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }
      const empty = emptyLedgerDocument(cents)
      if (empty.problem) fail(CODE.CLIENT_AMOUNT_OUT_OF_RANGE, { invoiceId, field: 'receivedCents' })
      if (!snap.exists) {
        tx.create(ledgers[i], { ...empty.doc, receiptBaseline, ...stamps, createdAt: FieldValue.serverTimestamp(), createdBy: uid })
        continue
      }
      // A ledger from credit notes or releases posted before the baseline: it
      // may carry no received figure yet. Anything else would be added twice.
      const stored = snap.data()
      if (calc.storedLedgerProblem(stored) || stored.receiptBaseline !== undefined || (stored.receivedCents ?? 0) !== 0) {
        fail(CODE.CLIENT_RECEIPT_BASELINE_INCONSISTENT, { invoiceId, reason: 'ledger-already-carries-receipts' })
      }
      tx.update(ledgers[i], { receivedCents: cents, receiptBaseline, ...stamps }, { lastUpdateTime: snap.updateTime })
    }
    const summary = {
      legacyPostedReceipts: sums.legacyPostedReceipts, legacyAllocations: sums.legacyAllocations,
      invoices: sums.invoices.length, legacyCents: sums.legacyCents,
    }
    tx.create(marker, {
      version: RECEIPT_BASELINE_VERSION, establishedAt: FieldValue.serverTimestamp(), establishedBy: uid, ...summary,
    })
    auditInTx(tx, db, companyId, {
      type: AUDIT.CLIENT_RECEIPT_BASELINE_ESTABLISHED, actorUid: uid, requestId,
      before: null, after: { projectId, version: RECEIPT_BASELINE_VERSION, ...summary },
    }, now())
    return { established: true, ...summary }
  }, () => attempts)

  if (result.established) log.info('client receipt baseline established', { uid, projectId, attempts, ...result })
  return { established: result.established, attempts }
}
