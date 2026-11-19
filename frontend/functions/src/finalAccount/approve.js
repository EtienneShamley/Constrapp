import { CODE, fail } from '../lib/errors.js'
import { userRef, assertActiveRole } from '../lib/authz.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import { FieldValue } from '../lib/firebaseAdmin.js'
import * as calc from '../generated/finalAccountCalc.js'

// ── approveFinalAccount — the ONE financial operation in the trusted backend ──
// (ADR-77, a narrowly scoped exception to the ADR-72 "no financial logic" rule)
//
// A Final Account revision becomes APPROVED — immutable, forever — only here.
// Security Rules give no client a path to `status: 'approved'`. The request
// carries identifiers and a concurrency guard, never an amount:
//
//   { projectId, number, expectedRevision, acknowledged: true }
//
// ONE read-write transaction:
//   1. the caller's membership, read INSIDE the transaction (active, of a
//      company, company_admin or project_manager) — the company comes from
//      that document, never from the request;
//   2. the project and the draft under THAT company (another tenant's project
//      id is simply not found);
//   3. every financial register the calculation reads — the same queries the
//      browser hooks run — all through the transaction;
//   4. the figures, computed by the generated copy of lib/finalAccount.js;
//   5. the readiness gate, then strict agreement between the draft the
//      approver reviewed and those figures;
//   6. the write: status, the SERVER's own figures / rows / provenance, the
//      approver, the server time, and one audit event.
//
// CONSISTENCY. A Firestore read-write transaction is serializable: this
// transaction's reads (documents AND query results) and its write take effect
// as one instant. A register written while it runs either commits first — the
// transaction is retried and sees it — or commits after, and then appears to
// the user as drift against the approved revision. `sourcesReadAt` records the
// latest read time the transaction observed. tests/functions/finalAccount.*
// exercise both orders against the emulator.
//
// IDEMPOTENCE. A retry after an uncertain outcome (timeout, lost response)
// finds the revision approved by the same caller at expectedRevision + 1 and
// returns the same answer without writing again.

const docsOf = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }))
const one = (snap) => (snap.exists ? { id: snap.id, ...snap.data() } : null)
const millis = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0)

// The registers, by the name lib/commercialReport.js gives each source, with
// the SAME ordering clause its browser hook uses (a document lacking the
// ordered field is excluded on both sides alike).
const ORDERED = [
  'budgetLines', 'purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes',
  'variations', 'supplierPayments', 'retentionReleases', 'clientInvoices', 'clientReceipts',
]

// The most documents ONE register may hold for an approval. The transaction
// reads every register whole; a bound keeps it far inside the function's
// memory and time and the 270-second transaction limit. Each query asks for
// one more than the bound, so a register over it is DETECTED and the approval
// refused by name — never silently truncated into a smaller total.
export const SOURCE_DOCUMENT_LIMIT = 5000

export async function readFinalAccountSources(tx, { companyRef, projectRef }, limit = SOURCE_DOCUMENT_LIMIT) {
  const sub = (name) => projectRef.collection(name)
  // Any read that fails rejects the whole set: the transaction function
  // throws, nothing is written, and no figure is built from a partial read.
  const reads = await Promise.all([
    ...ORDERED.map(name => tx.get(sub(name).orderBy('createdAt', 'desc').limit(limit + 1))),
    tx.get(sub('forecastLines').limit(limit + 1)),
    tx.get(companyRef.collection('costCodes').orderBy('code', 'asc').limit(limit + 1)),
    tx.get(sub('commercial').doc('baseline')),
    tx.get(sub('approvedBudget').doc('current')),
  ])
  const n = ORDERED.length
  const over = [...ORDERED, 'forecastLines', 'costCodes'].filter((_name, i) => reads[i].size > limit)
  if (over.length > 0) fail(CODE.FINAL_ACCOUNT_TOO_LARGE, { registers: over, limit })
  const sources = {}
  ORDERED.forEach((name, i) => { sources[name] = docsOf(reads[i]) })
  sources.forecastLines = docsOf(reads[n])
  sources.costCodes = docsOf(reads[n + 1])
  sources.baseline = one(reads[n + 2])
  const pointer = one(reads[n + 3])

  // The approved-budget composite, exactly as hooks/useApprovedBudget.jsx
  // assembles it (the original version is not read: no figure here uses it).
  const settled = { pointerLoading: false, pointerError: false, headerLoading: false, headerError: false,
    snapshotLoading: false, snapshotError: false, originalLoading: false, originalError: false,
    originalRequested: false, originalSnapshot: null, adjustmentsLoading: false, adjustmentsError: false }
  let header = null
  let snapshot = null
  let adjustments = []
  const more = []
  const activeId = typeof pointer?.activeApprovalId === 'string' && pointer.activeApprovalId ? pointer.activeApprovalId : null
  if (activeId) {
    const [h, s] = await Promise.all([
      tx.get(sub('budgetApprovals').doc(activeId)),
      tx.get(sub('budgetApprovalSnapshots').doc(activeId)),
    ])
    header = one(h); snapshot = one(s); more.push(h, s)
    if (Number.isInteger(pointer.adjustmentCount) && pointer.adjustmentCount > 0) {
      const a = await tx.get(sub('budgetAdjustments').where('baseApprovalId', '==', activeId).limit(limit + 1))
      if (a.size > limit) fail(CODE.FINAL_ACCOUNT_TOO_LARGE, { registers: ['budgetAdjustments'], limit })
      adjustments = docsOf(a); more.push(a)
    }
  }
  sources.approvedBudget = { ...settled, pointer, header, snapshot, adjustments }

  const readAt = Math.max(0, ...[...reads, ...more].map(r => millis(r.readTime)))
  return { sources, readAt }
}

// gRPC ABORTED — the transaction lost to concurrent writes on every attempt.
// It is the ONE transport failure with a certain outcome: an aborted
// transaction committed nothing. It becomes a typed refusal the client can
// state truthfully ("nothing was approved, try again"). Every OTHER unexpected
// failure (deadline, unavailable, internal) is rethrown untyped: its outcome is
// NOT certain, the client says so, and a retry is safe because an approval
// that did land is answered idempotently.
const GRPC_ABORTED = 10
export const APPROVAL_MAX_ATTEMPTS = 5

async function runApproval(db, log, context, body, attemptsSoFar) {
  try {
    return await db.runTransaction(body, { maxAttempts: APPROVAL_MAX_ATTEMPTS })
  } catch (err) {
    if (!err?.details?.code && err?.code === GRPC_ABORTED) {
      log.warn('final account approval aborted by contention', { ...context, attempts: attemptsSoFar() })
      fail(CODE.FINAL_ACCOUNT_BUSY, { attempts: attemptsSoFar() })
    }
    throw err
  }
}

export async function approveFinalAccount(deps, { uid, projectId, number, expectedRevision, requestId = null }) {
  const { db, now, log, hooks = {}, sourceLimit = SOURCE_DOCUMENT_LIMIT } = deps
  let attempts = 0

  const result = await runApproval(db, log, { uid, projectId, number }, async (tx) => {
    attempts += 1

    // 1. The caller — inside the transaction, so a role change or deactivation
    //    is serialised against the approval.
    const profileSnap = await tx.get(userRef(db, uid))
    const profile = assertActiveRole(profileSnap.exists ? profileSnap.data() : null, calc.FINAL_ACCOUNT_APPROVE_ROLES, CODE.NOT_APPROVER)
    const companyId = profile.companyId

    // 2. The project and the draft, under the CALLER'S company only.
    const companyRef = db.collection('companies').doc(companyId)
    const projectRef = companyRef.collection('projects').doc(projectId)
    const accountRef = projectRef.collection('finalAccounts').doc(String(number))
    const [companySnap, projectSnap, accountSnap] = await tx.getAll(companyRef, projectRef, accountRef)
    if (!companySnap.exists || !projectSnap.exists || !accountSnap.exists) fail(CODE.NOT_FOUND)
    const account = accountSnap.data()

    if (account.status === calc.FINAL_ACCOUNT_STATUS.APPROVED) {
      // The same caller's own earlier success — answer it again, write nothing.
      if (account.approvedBy === uid && account.revision === expectedRevision + 1) {
        return { replay: true, companyId, number, revision: account.revision }
      }
      fail(CODE.FINAL_ACCOUNT_NOT_DRAFT)
    }
    if (account.status !== calc.FINAL_ACCOUNT_STATUS.DRAFT) fail(CODE.FINAL_ACCOUNT_NOT_DRAFT)
    if (account.number !== number || account.revision !== expectedRevision) fail(CODE.FINAL_ACCOUNT_STALE)
    if (account.openItemsAcknowledged !== true) fail(CODE.FINAL_ACCOUNT_CHANGED)

    // 3. Every source, through the transaction.
    const { sources, readAt } = await readFinalAccountSources(tx, { companyRef, projectRef }, sourceLimit)
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })

    // 4. The calculation — the generated copy of the browser's own module.
    const project = { id: projectSnap.id, ...projectSnap.data() }
    const currencyCode = calc.resolveProjectCurrency(project, { id: companySnap.id, ...companySnap.data() })
    if (account.currency !== currencyCode) fail(CODE.FINAL_ACCOUNT_CHANGED)
    const computation = calc.computeFinalAccount({ project, currencyCode, sources, sourceStates: calc.settledSourceStates() })

    // 5. Readiness, then agreement with what the approver reviewed.
    if (!computation.ready || !computation.figures) fail(CODE.FINAL_ACCOUNT_NOT_READY, { blockers: calc.blockerCodes(computation) })
    if (!calc.draftAgreesWith(account, computation)) fail(CODE.FINAL_ACCOUNT_CHANGED)
    const content = calc.finalAccountContent(computation)
    if (calc.estimateFinalAccountBytes({ ...account, ...content }) > calc.FINAL_ACCOUNT_MAX_BYTES) fail(CODE.FINAL_ACCOUNT_TOO_LARGE)

    // 6. The write. Figures, rows and provenance are THIS computation's — the
    //    draft's own numbers are replaced, never trusted.
    const selfApproved = account.createdBy === uid
    tx.update(accountRef, {
      ...content,
      status: calc.FINAL_ACCOUNT_STATUS.APPROVED,
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: uid,
      approvedByName: typeof profile.name === 'string' ? profile.name.slice(0, calc.FINAL_ACCOUNT_LIMITS.NAME) : '',
      approvedByRole: profile.role,
      selfApproved,
      sourcesReadAt: readAt > 0 ? new Date(readAt) : now(),
      revision: expectedRevision + 1,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    }, { lastUpdateTime: accountSnap.updateTime })
    auditInTx(tx, db, companyId, {
      type: AUDIT.FINAL_ACCOUNT_APPROVED, actorUid: uid, requestId,
      before: { status: calc.FINAL_ACCOUNT_STATUS.DRAFT, revision: expectedRevision },
      after: {
        projectId, number, status: calc.FINAL_ACCOUNT_STATUS.APPROVED, revision: expectedRevision + 1, selfApproved,
        currency: currencyCode, finalContractSum: content.figures.finalContractSum, finalCost: content.figures.finalCost,
        budgetApprovalId: content.sources.budgetApprovalId,
      },
    }, now())
    return { replay: false, companyId, number, revision: expectedRevision + 1, selfApproved }
  }, () => attempts)

  log.info('final account approval', { uid, projectId, number, replay: result.replay, attempts })
  return { number: result.number, revision: result.revision, status: calc.FINAL_ACCOUNT_STATUS.APPROVED, alreadyApproved: result.replay, attempts }
}
