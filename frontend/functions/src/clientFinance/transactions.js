import { CODE, fail } from '../lib/errors.js'
import { segregationGuard } from '../lib/approvalPolicy.js'
import { userRef, assertActiveRole } from '../lib/authz.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import { isValidId } from '../lib/validation.js'
import * as calc from '../generated/clientFinanceCalc.js'
import { CLIENT_FINANCE_ROLES } from './contracts.js'
import { invoiceProblem, draftProblem, deriveCreditNote, deriveRetentionRelease } from './agreement.js'
import {
  dataOf, projectRefs, entryRef, invoiceRef, ledgerRef, receiptBaselineRef, readStoredLedger, writeLedger,
  stampPosted, stampVoid, ledgerTotals,
} from './persistence.js'
import { attachBlockers } from './blocking.js'

// ── Posting and voiding client credit notes and retention releases (ADR-89) ──
//
// THE TRUSTED TRANSACTION BOUNDARY FOR CLIENT FINANCE. A client credit note or
// client retention release becomes POSTED, and a posted one becomes VOID, only
// here; and the per-invoice ledger is written only here. Security Rules give a
// browser no path to either (`clientInvoiceLedgers`: `allow write: if false`).
// The request carries identifiers and, for a void, a reason — never an amount.
//
// ONE read-write transaction per request, EVERY read before ANY write:
//   1. the caller's membership, read INSIDE the transaction (active, of a
//      company, company_admin / project_manager / qs) — the company comes from
//      that document, never from the request;
//   2. the company, the project, the project's receipt-baseline marker and
//      the entry under THAT company (another tenant's ids are simply not
//      found). The company must be ACTIVATED for client credit notes and
//      retention releases (`clientFinanceEnabled === true`, a field only an
//      operator script writes) — receipts are not gated — and the marker must
//      exist: a project whose historical receipts have not been brought into
//      the ledgers is refused, never read as "nothing received";
//   3. the entry's invoice and that invoice's ledger;
//   4. NOTHING ELSE. In particular no receipt: what posted receipts have
//      allocated to the invoice is `receivedCents` in that one ledger document,
//      maintained by the receipt callables (receipts.js), so the void of a
//      release reads the same handful of documents however many receipts the
//      project holds;
//   5. the decision — every figure from the generated copy of the browser's
//      own modules (agreement.js, generated/clientFinanceCalc.js);
//   6. the writes: the ledger, the entry's status and stamps, ONE audit event.
//
// POSTING treats the whole draft as untrusted (Rules validate very little of
// one): it must be exactly the shape the app writes, and the entry re-derived
// from the invoice and the ledger as they stand must equal the stored draft in
// every figure and every line. A draft prepared before another posting, a
// draft whose lines were never valid and a draft carrying anything the app
// does not write are refused alike, and nothing is written.
//
// CONSISTENCY. A Firestore read-write transaction is serializable: its reads
// (documents AND query results) and its writes take effect as one instant. Two
// requests against one invoice both read its ledger, so one of them is retried
// against the other's result and is then refused if it no longer fits. Posting
// a receipt WRITES the ledger of every invoice it allocates to, so a receipt
// and a release void on one invoice serialise the same way: whichever commits
// second sees the first. tests/functions/clientFinance.test.js and
// clientReceipts.test.js exercise both orders.
//
// A REFUSED VOID NAMES WHAT BLOCKS IT. After the decision — never before, and
// never changing it — the entries or receipts that stand in the way are looked
// up and attached to the refusal (blocking.js).
//
// IDEMPOTENCE. A repeat after an uncertain outcome (timeout, lost response)
// finds the entry already posted — or already void, for the same reason — by
// the SAME caller, and is answered again with no second ledger movement and no
// second audit event. Anyone else is told the entry is no longer a draft, or
// is already void.

// gRPC ABORTED — the transaction lost to concurrent writes on every attempt.
// It is the ONE transport failure with a certain outcome: nothing committed.
// Every OTHER unexpected failure (deadline, unavailable, internal) is rethrown
// untyped: its outcome is NOT certain, the client says so, and a retry is safe
// because a request that did land is answered idempotently.
const GRPC_ABORTED = 10
export const CLIENT_FINANCE_MAX_ATTEMPTS = 5

export async function runGuarded(db, log, context, body, attemptsSoFar) {
  try {
    return await db.runTransaction(body, { maxAttempts: CLIENT_FINANCE_MAX_ATTEMPTS })
  } catch (err) {
    if (!err?.details?.code && err?.code === GRPC_ABORTED) {
      log.warn('client finance request aborted by contention', { ...context, attempts: attemptsSoFar() })
      fail(CODE.CLIENT_FINANCE_BUSY, { attempts: attemptsSoFar() })
    }
    throw err
  }
}

// ── The two kinds of entry ───────────────────────────────────────────────────

const CREDIT_NOTE = {
  collection: 'clientCreditNotes',
  idKey: 'creditNoteId',
  numberKey: 'creditNumber',
  docType: calc.CCN_DOC_TYPE,
  shape: calc.CLIENT_ENTRY_SHAPES.creditNote,
  status: calc.CCN_STATUS,
  derive: deriveCreditNote,
  apply: calc.applyCredit,
  applyVoid: calc.applyCreditVoid,
  postKind: calc.LEDGER_KIND.CREDIT,
  voidKind: calc.LEDGER_KIND.CREDIT_VOID,
  auditPosted: AUDIT.CLIENT_CREDIT_NOTE_POSTED,
  auditVoided: AUDIT.CLIENT_CREDIT_NOTE_VOIDED,
  kindName: 'credit_note',
  // A void RAISES what is receivable, so no receipt can depend on it.
  voidLowersReceivable: false,
}

const RETENTION_RELEASE = {
  collection: 'clientRetentionReleases',
  idKey: 'releaseId',
  numberKey: 'releaseNumber',
  docType: calc.CRR_DOC_TYPE,
  shape: calc.CLIENT_ENTRY_SHAPES.retentionRelease,
  status: calc.CRR_STATUS,
  derive: deriveRetentionRelease,
  apply: calc.applyRelease,
  applyVoid: calc.applyReleaseVoid,
  postKind: calc.LEDGER_KIND.RELEASE,
  voidKind: calc.LEDGER_KIND.RELEASE_VOID,
  auditPosted: AUDIT.CLIENT_RETENTION_RELEASE_POSTED,
  auditVoided: AUDIT.CLIENT_RETENTION_RELEASE_VOIDED,
  kindName: 'retention_release',
  // A void LOWERS what is receivable: what posted receipts have allocated to
  // the invoice must still fit (formerly Deferred Control 49, which no Rule
  // could provide).
  voidLowersReceivable: true,
}

// Steps 1–2 for ANY document of a project (also used by receipts.js): the
// caller, then the company, the project, the receipt-baseline marker and
// `docRef(projectRef)` under the CALLER'S company only. Decides who is
// calling, whether the documents exist, whether the company is activated
// (`requireActivation` — the credit-note and release operations) and that the
// baseline exists.
//
// WHY THE MARKER IS RE-READ HERE, though the handler has just ensured it: this
// transaction then PROVES, by its own read, that every posted receipt of the
// project is in a ledger — so a ledger that is missing, or carries no
// `receivedCents`, means exactly zero received, and the over-allocation and
// release-void decisions below are exact. Without the marker that would be an
// assumption; so its absence is a refusal, never a zero.
export async function readCallerAndDocument(tx, db, { uid, projectId }, docRef, { requireActivation = false } = {}) {
  // 1. The caller — inside the transaction, so a role change or deactivation
  //    is serialised against the request.
  const profileSnap = await tx.get(userRef(db, uid))
  const profile = assertActiveRole(profileSnap.exists ? profileSnap.data() : null, CLIENT_FINANCE_ROLES, CODE.CLIENT_FINANCE_FORBIDDEN)
  const companyId = profile.companyId

  // 2. Another tenant's project or document id resolves to nothing.
  const refs = projectRefs(db, companyId, projectId)
  const ref = docRef(refs.project)
  const [companySnap, projectSnap, baselineSnap, snap] = await tx.getAll(refs.company, refs.project, receiptBaselineRef(refs.project), ref)
  if (!companySnap.exists || !projectSnap.exists) fail(CODE.NOT_FOUND)
  if (requireActivation && !calc.clientFinanceActivated(companySnap.data())) fail(CODE.CLIENT_FINANCE_NOT_ACTIVATED)
  if (!baselineSnap.exists) fail(CODE.CLIENT_RECEIPT_BASELINE_MISSING)
  if (!snap.exists) fail(CODE.CLIENT_ENTRY_NOT_FOUND)
  return { companyId, projectRef: refs.project, ref, snap, baseline: baselineSnap.data() }
}

// Steps 1–3 for a credit note or a retention release.
async function readContext(tx, db, kind, { uid, projectId, entryId }) {
  const { companyId, projectRef, ref, snap: entrySnap } =
    await readCallerAndDocument(tx, db, { uid, projectId }, (project) => entryRef(project, kind.collection, entryId), { requireActivation: true })
  const refs = { project: projectRef }
  const entry = dataOf(entrySnap)
  if (entry.docType !== kind.docType || !isValidId(entry.clientInvoiceId)) fail(CODE.CLIENT_ENTRY_INVALID)

  // 3. The invoice and its ledger.
  const invoiceId = entry.clientInvoiceId
  const ledger = ledgerRef(refs.project, invoiceId)
  const [invoiceSnap, ledgerSnap] = await tx.getAll(invoiceRef(refs.project, invoiceId), ledger)
  // A stored figure that is not a whole, non-negative, safe number of cents is
  // refused here — never coerced.
  const { doc: ledgerDoc, state: ledgerState } = readStoredLedger(ledgerSnap)
  return {
    companyId, projectRef: refs.project, entryRef: ref, entrySnap, entry, invoiceId,
    invoice: dataOf(invoiceSnap), ledgerRef: ledger, ledgerSnap, ledgerDoc, ledgerState,
  }
}

// The `seq` a repeated request reports: the movement it made, while the ledger
// still names that movement as its latest. Once another entry or a receipt has
// moved the ledger the original `seq` is no longer recorded anywhere but the
// audit event, and null is returned rather than a later movement's number.
const replaySeq = (ledgerDoc, entryId, ledgerKind) =>
  (ledgerDoc?.lastEntryId === entryId && ledgerDoc?.lastEntryKind === ledgerKind ? ledgerDoc.seq : null)

const answer = (kind, { status, entryId, invoiceId, seq, replay }, attempts) => ({
  status, [kind.idKey]: entryId, invoiceId, seq, alreadyApplied: replay, attempts,
})

// ── POST ─────────────────────────────────────────────────────────────────────

async function postEntry(deps, kind, { uid, projectId, entryId, requestId = null }) {
  const { db, now, log, hooks = {} } = deps
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId, entryId, operation: kind.auditPosted }, async (tx) => {
    attempts += 1
    const ctx = await readContext(tx, db, kind, { uid, projectId, entryId })
    const { entry, invoice, invoiceId, ledgerDoc } = ctx
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })

    if (entry.status === kind.status.POSTED) {
      // The same caller's own earlier success — answer it again, write nothing.
      if (entry.postedBy === uid) {
        return { replay: true, status: kind.status.POSTED, entryId, invoiceId, seq: replaySeq(ledgerDoc, entryId, kind.postKind) }
      }
      fail(CODE.CLIENT_ENTRY_NOT_DRAFT, { entryStatus: entry.status })
    }
    if (entry.status !== kind.status.DRAFT) fail(CODE.CLIENT_ENTRY_NOT_DRAFT, { entryStatus: entry.status ?? null })
    // ADR-96: posting a client credit note or retention release changes what is
    // owed — segregated when the company policy enables it.
    const segregation = segregationGuard(db, uid, { label: kind.idKey === 'creditNoteId' ? 'client credit note' : 'client retention release' })
    await segregation.read(tx, { companyId: ctx.companyId })
    segregation.check(entry)

    // 5. The invoice as a source record; the draft as an untrusted document;
    //    then the entry re-derived from the invoice and its ledger.
    const problem = invoiceProblem(invoice, entry) ?? draftProblem(kind.shape, entry, invoice)
    if (problem) fail(problem.code, problem.details)
    const derived = kind.derive(invoice, ledgerDoc, entry)
    if (derived.mismatch) fail(CODE.CLIENT_FIGURES_CHANGED, derived.mismatch)

    const before = ctx.ledgerState
    // The ledger advances by the SERVER'S derivation, never by the stored draft.
    const next = kind.apply(before, { id: entryId, ...derived.figures })
    const broken = calc.ledgerInvariantError(invoice, next)
    if (broken) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: broken })
    // Phase 2 step 5 (S1): a release RAISES what is receivable — money already
    // refunded to the client out of this invoice must still be covered.
    const unsettled = calc.settlementInvariantError(invoice, next)
    if (unsettled) fail(CODE.CLIENT_REFUNDS_DEPEND, { invariant: unsettled, number: entry[kind.numberKey] ?? null })

    // 6. The writes.
    writeLedger(tx, ctx.ledgerRef, ctx.ledgerSnap, next, uid)
    stampPosted(tx, ctx.entryRef, ctx.entrySnap, kind.status.POSTED, uid)
    auditInTx(tx, db, ctx.companyId, {
      type: kind.auditPosted, actorUid: uid, requestId,
      before: { status: kind.status.DRAFT, ledger: ledgerTotals(before) },
      after: {
        projectId, invoiceId, [kind.idKey]: entryId, number: entry[kind.numberKey] ?? null,
        status: kind.status.POSTED, currency: invoice.currency, seq: next.seq, ledger: ledgerTotals(next),
        segregation: segregation.record(),
      },
    }, now())
    return { replay: false, status: kind.status.POSTED, entryId, invoiceId, seq: next.seq }
  }, () => attempts)

  log.info('client finance post', { uid, projectId, entryId, operation: kind.auditPosted, replay: result.replay, attempts })
  return answer(kind, result, attempts)
}

// ── VOID ─────────────────────────────────────────────────────────────────────

async function voidEntry(deps, kind, { uid, projectId, entryId, reason, requestId = null }) {
  const { db, now, log, hooks = {} } = deps
  let attempts = 0
  // What a refusal needs to name its blockers, noted by the transaction body.
  let refused = null

  const result = await runGuarded(db, log, { uid, projectId, entryId, operation: kind.auditVoided }, async (tx) => {
    attempts += 1
    const ctx = await readContext(tx, db, kind, { uid, projectId, entryId })
    const { entry, invoice, invoiceId, ledgerDoc } = ctx
    const wasPosted = entry.status === kind.status.POSTED
    refused = {
      projectRef: ctx.projectRef, invoiceId, entryId, postedAt: entry.postedAt ?? null, number: entry[kind.numberKey] ?? null,
      receiptBaseline: ledgerDoc?.receiptBaseline ?? null,
    }
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })

    if (entry.status === kind.status.VOID) {
      // The same caller's own earlier void, for the same reason — answer it
      // again, write nothing.
      if (entry.voidedBy === uid && entry.voidReason === reason) {
        return { replay: true, status: kind.status.VOID, entryId, invoiceId, seq: replaySeq(ledgerDoc, entryId, kind.voidKind) }
      }
      fail(CODE.CLIENT_ENTRY_NOT_POSTED, { entryStatus: entry.status })
    }

    // ADR-96 (final-batch ruling B): taking back a POSTED entry undoes a fact
    // an independent approver posted, so with segregation enabled it is itself
    // an independent decision — not the entry's creator or last material
    // editor. (After posting, `updatedBy` is the poster, who MAY void: the
    // preparers are named explicitly.) A draft has moved nothing.
    const segregation = segregationGuard(db, uid, { label: kind.idKey === 'creditNoteId' ? 'void of a posted client credit note' : 'void of a posted client retention release' })
    await segregation.read(tx, { companyId: ctx.companyId })
    if (wasPosted) segregation.check({ createdBy: entry.createdBy, lastMaterialEditBy: entry.lastMaterialEditBy ?? entry.createdBy })

    const before = ctx.ledgerState
    let next = before
    if (wasPosted) {
      // The invoice's stored figures are what every invariant is measured
      // against. It need not still be issued: taking an entry back out is how
      // a posting against it is corrected.
      if (!invoice) fail(CODE.CLIENT_INVOICE_NOT_ISSUED, { invoiceStatus: null })
      next = kind.applyVoid(before, entry)
      const broken = calc.ledgerInvariantError(invoice, next)
      if (broken) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: broken, number: refused.number })
      // Phase 2 step 5 (S1): voiding a credit note RAISES what is receivable —
      // a settlement (a refund of the overpayment the credit created) that it
      // would invalidate is corrected first, or the client pays again.
      const unsettled = calc.settlementInvariantError(invoice, next)
      if (unsettled) fail(CODE.CLIENT_REFUNDS_DEPEND, { invariant: unsettled, number: refused.number })
      if (kind.voidLowersReceivable) {
        // What is receivable once the release is taken back must still cover
        // what posted receipts have allocated to this invoice — both read from
        // the ONE ledger document, never from the receipts. `receivedCents` is
        // exact: it includes the receipts posted before the backend took over
        // (the baseline whose marker this transaction read).
        // Since Phase 2 step 5 the money the invoice HOLDS is received less
        // refunded (identical to `receivedCents` until a refund exists).
        const receivableBasisAfterCents = calc.ledgerPosition(invoice, next).receivableBasisCents
        const heldCents = calc.netReceivedCents(next)
        if (receivableBasisAfterCents < heldCents) {
          fail(CODE.CLIENT_RECEIPTS_DEPEND, { receivedCents: heldCents, receivableBasisAfterCents, number: refused.number })
        }
      }
      writeLedger(tx, ctx.ledgerRef, ctx.ledgerSnap, next, uid)
    } else if (entry.status !== kind.status.DRAFT) {
      fail(CODE.CLIENT_ENTRY_INVALID, { entryStatus: entry.status ?? null })
    }
    // A DRAFT has moved nothing: it is voided with no ledger write.

    stampVoid(tx, ctx.entryRef, ctx.entrySnap, kind.status.VOID, uid, reason)
    auditInTx(tx, db, ctx.companyId, {
      type: kind.auditVoided, actorUid: uid, requestId,
      before: { status: entry.status, ledger: ledgerTotals(before) },
      after: {
        projectId, invoiceId, [kind.idKey]: entryId, number: entry[kind.numberKey] ?? null,
        status: kind.status.VOID, currency: entry.currency ?? null, reason,
        ledgerMoved: wasPosted, seq: wasPosted ? next.seq : null, ledger: ledgerTotals(next),
        segregation: wasPosted ? segregation.record() : null,
      },
    }, now())
    return { replay: false, status: kind.status.VOID, entryId, invoiceId, seq: wasPosted ? next.seq : null }
  }, () => attempts).catch(err => attachBlockers(db, log, err, refused))

  log.info('client finance void', { uid, projectId, entryId, operation: kind.auditVoided, replay: result.replay, attempts })
  return answer(kind, result, attempts)
}

// ── The four operations ──────────────────────────────────────────────────────
//
// Each takes `(deps, { uid, projectId, entryId, reason?, requestId? })` and
// resolves to identifiers and a status only:
//   { status, creditNoteId | releaseId, invoiceId, seq, alreadyApplied, attempts }
// (the two receipt operations are in receipts.js)

export const postClientCreditNote = (deps, input) => postEntry(deps, CREDIT_NOTE, input)
export const voidClientCreditNote = (deps, input) => voidEntry(deps, CREDIT_NOTE, input)
export const postClientRetentionRelease = (deps, input) => postEntry(deps, RETENTION_RELEASE, input)
export const voidClientRetentionRelease = (deps, input) => voidEntry(deps, RETENTION_RELEASE, input)
