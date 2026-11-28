import { CODE, fail } from '../lib/errors.js'
import { commercialActivated } from '../lib/commercialActivation.js'
import { userRef, assertActiveRole } from '../lib/authz.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import { FieldValue } from '../lib/firebaseAdmin.js'
import { SOURCE_DOCUMENT_LIMIT } from '../finalAccount/approve.js'
import * as calc from '../generated/boqBudgetTransferCalc.js'

// ── transferBoqToBudget — the SECOND financial operation in the trusted backend
// (ADR-81, a narrowly scoped exception to the ADR-72 "no financial logic" rule,
// beside ADR-77's approveFinalAccount)
//
// A priced Bill of Quantities becomes WORKING budget lines only here. The
// request carries identifiers and guards, never an amount:
//
//   { projectId, reviewKey, setToZero: [costCodeId, …] }
//
// WHY A FUNCTION. The Web SDK's Transaction.get() reads one document
// reference; it cannot read a query. A browser transaction therefore cannot
// see a BOQ item or a manual budget line created while it runs. The Admin SDK
// can read whole queries inside a transaction, so this one can.
//
// ONE read-write transaction, EVERY read before ANY write:
//   1. the caller's membership, read INSIDE the transaction (active, of a
//      company, company_admin / project_manager / qs) — the company comes from
//      that document, never from the request;
//   2. the company and the project under THAT company (another tenant's
//      project id is simply not found);
//   3. the COMPLETE boqItems, budgetLines and costCodes registers, as queries
//      through the transaction — unordered, so a document that lacks an
//      ordering field is still seen;
//   4. the proposal, recomputed by the generated copy of
//      src/lib/boqBudgetTransfer.js, in the project's own resolved currency;
//   5. the review guard: the recomputed reviewKey must equal the request's —
//      otherwise the request is either a repeat of one that already committed
//      (answered ALREADY APPLIED, nothing written) or a stale review (refused,
//      nothing written);
//   6. the writes: one create or update per changed cost code, the project
//      currency lock when it is not yet set, and ONE audit event.
//
// IT NEVER WRITES budgetApprovals, budgetApprovalSnapshots, approvedBudget or
// budgetAdjustments, and it never reads them: an approved budget version
// changes only through the existing SHIELD approval (ADR-70 / ADR-71).
//
// CONSISTENCY. A Firestore read-write transaction is serializable: its reads
// (documents AND query results) and its writes take effect as one instant. A
// BOQ item or budget line written while it runs either commits first — the
// transaction is retried and sees it, and the review no longer matches — or
// commits after. tests/functions/boqBudgetTransfer.test.js exercises both
// orders against the emulator.
//
// IDEMPOTENCE. Every line this writes stores the request's key and the key of
// the state the request produced. A repeat after an uncertain outcome is
// answered ALREADY APPLIED when that state is still the current state; if
// anything has changed since, it is a stale review. A repeat never creates a
// second line (the id is deterministic and created with `tx.create`) and never
// writes a second audit event.

const docsOf = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }))

const GRPC_ABORTED = 10
export const TRANSFER_MAX_ATTEMPTS = 5

// The three registers, read WHOLE. One more than the bound is asked for, so a
// register over it is detected and the transfer refused by name — never
// silently truncated into a smaller budget. The bound is the Final Account's
// (finalAccount/approve.js); it is a safety stop, not a product limit.
export async function readTransferSources(tx, { companyRef, projectRef }, limit = SOURCE_DOCUMENT_LIMIT) {
  const [boq, lines, codes] = await Promise.all([
    tx.get(projectRef.collection('boqItems').limit(limit + 1)),
    tx.get(projectRef.collection('budgetLines').limit(limit + 1)),
    tx.get(companyRef.collection('costCodes').limit(limit + 1)),
  ])
  const names = ['boqItems', 'budgetLines', 'costCodes']
  const over = names.filter((_n, i) => [boq, lines, codes][i].size > limit)
  if (over.length > 0) fail(CODE.BOQ_TRANSFER_TOO_LARGE, { registers: over, limit })
  const updateTimes = new Map(lines.docs.map(d => [d.id, d.updateTime]))
  return { boqItems: docsOf(boq), budgetLines: docsOf(lines), costCodes: docsOf(codes), updateTimes }
}

async function runTransfer(db, log, context, body, attemptsSoFar) {
  try {
    return await db.runTransaction(body, { maxAttempts: TRANSFER_MAX_ATTEMPTS })
  } catch (err) {
    // ABORTED is the one transport failure with a certain outcome: nothing
    // committed. Every other unexpected failure is rethrown untyped — its
    // outcome is NOT certain, and the client says so.
    if (!err?.details?.code && err?.code === GRPC_ABORTED) {
      log.warn('boq transfer aborted by contention', { ...context, attempts: attemptsSoFar() })
      fail(CODE.BOQ_TRANSFER_BUSY, { attempts: attemptsSoFar() })
    }
    throw err
  }
}

export async function transferBoqToBudget(deps, { uid, projectId, reviewKey, setToZero, estimateId = null, requestId = null }) {
  const { db, now, log, hooks = {}, sourceLimit = SOURCE_DOCUMENT_LIMIT } = deps
  let attempts = 0

  const result = await runTransfer(db, log, { uid, projectId }, async (tx) => {
    attempts += 1

    // 1. The caller — inside the transaction, so a role change or deactivation
    //    is serialised against the transfer.
    const profileSnap = await tx.get(userRef(db, uid))
    const profile = assertActiveRole(profileSnap.exists ? profileSnap.data() : null, calc.BOQ_TRANSFER_ROLES, CODE.BOQ_TRANSFER_FORBIDDEN)
    const companyId = profile.companyId

    // 2. The company and the project, under the CALLER'S company only.
    const companyRef = db.collection('companies').doc(companyId)
    const projectRef = companyRef.collection('projects').doc(projectId)
    const [companySnap, projectSnap] = await tx.getAll(companyRef, projectRef)
    if (!companySnap.exists || !projectSnap.exists) fail(CODE.NOT_FOUND)

    // 3. Every source, through the transaction.
    const sources = await readTransferSources(tx, { companyRef, projectRef }, sourceLimit)
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts })

    // 4. The proposal — the generated copy of the browser's own module.
    const project = { id: projectSnap.id, ...projectSnap.data() }
    const currencyCode = calc.resolveProjectCurrency(project, { id: companySnap.id, ...companySnap.data() })
    const inputs = { boqItems: sources.boqItems, budgetLines: sources.budgetLines, costCodes: sources.costCodes, currencyCode }
    const proposal = calc.buildTransferProposal(inputs)
    const requestKey = calc.transferRequestKey(reviewKey, setToZero, estimateId)

    // ADR-97 — the OPTIONAL estimate provenance. A transfer is recorded as the
    // handover of an approved estimate revision ONLY while the live BOQ this
    // transaction read is still the BOQ that revision priced; otherwise it is
    // refused (the transfer stays available without the claim). The transfer
    // itself is unchanged: it moves the BOQ's cost-coded COST amounts — never
    // a selling price — and never needs an estimate.
    let estimate = null
    if (estimateId !== null) {
      // Recording an estimate's handover is Phase 2: the company must be
      // activated (read in this transaction). A transfer WITHOUT an estimate is
      // the ADR-81 workflow and is never gated.
      if (!commercialActivated(companySnap.data())) fail(CODE.COMMERCIAL_NOT_ACTIVATED)
      const estimateSnap = await tx.get(projectRef.collection('estimates').doc(estimateId))
      const header = estimateSnap.exists ? estimateSnap.data() : null
      if (!header || header.state !== 'approved' || typeof header.sourceKey !== 'string') fail(CODE.BOQ_TRANSFER_ESTIMATE_INVALID)
      estimate = { estimateId, revisionNumber: header.revisionNumber ?? null, number: header.number ?? null, sourceKey: header.sourceKey, contentSha256: header.contentSha256 ?? null }
    }

    // 5. The review guard.
    if (proposal.reviewKey !== reviewKey) {
      const applied = calc.findAppliedRequest(sources.budgetLines, requestKey, proposal.reviewKey)
      if (applied) return { outcome: calc.TRANSFER_OUTCOME.ALREADY_APPLIED, companyId, byCaller: applied.by === uid }
      fail(CODE.BOQ_TRANSFER_STALE)
    }
    if (estimate && calc.estimateSourceKey(sources.boqItems) !== estimate.sourceKey) fail(CODE.BOQ_TRANSFER_ESTIMATE_DRIFT)
    const planned = calc.transferOperations(proposal, setToZero)
    if (!planned.ok) fail(CODE.BOQ_TRANSFER_BLOCKED, { costCodeIds: planned.invalidZero })
    const summary = calc.transferSummary(proposal, setToZero)
    if (planned.operations.length === 0) {
      // A genuine no-op: nothing written, no audit event.
      return { outcome: calc.TRANSFER_OUTCOME.UNCHANGED, companyId, summary }
    }
    const resultKey = calc.resultKeyAfter(inputs, planned.operations)

    // 6. The writes. Amounts are THIS computation's.
    const existing = new Map(sources.budgetLines.map(l => [l.id, l]))
    for (const op of planned.operations) {
      const lineRef = projectRef.collection('budgetLines').doc(op.lineId)
      const previous = existing.get(op.lineId) ?? null
      const latest = {
        at: FieldValue.serverTimestamp(),
        by: uid,
        amount: op.amount,
        itemCount: op.itemCount,
        fingerprint: op.fingerprint,
        operation: op.type,
        transferCount: (Number.isInteger(previous?.boqSource?.latest?.transferCount) ? previous.boqSource.latest.transferCount : 0) + 1,
        requestKey,
        resultKey,
        // ADR-97: present ONLY on a transfer verified against an approved estimate revision.
        ...(estimate ? { estimate } : {}),
      }
      if (op.type === calc.TRANSFER_OPERATION.CREATE) {
        // tx.create fails if the document exists: a second BOQ-sourced line
        // for a cost code cannot be written.
        tx.create(lineRef, {
          costCodeId: op.costCodeId,
          costCodeName: op.costCodeName,
          budgeted: op.amount,
          committed: 0,
          actual: 0,
          invoiced: 0,
          notes: '',
          boqSource: {
            first: { at: FieldValue.serverTimestamp(), by: uid, amount: op.amount, itemCount: op.itemCount, fingerprint: op.fingerprint },
            latest,
          },
          createdAt: FieldValue.serverTimestamp(),
          createdBy: uid,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: uid,
        })
      } else {
        // `budgeted` and the latest-transfer evidence move together;
        // `boqSource.first` is not named and so is preserved.
        tx.update(lineRef, {
          budgeted: op.amount,
          'boqSource.latest': latest,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: uid,
        }, { lastUpdateTime: sources.updateTimes.get(op.lineId) })
      }
    }
    // A budget line is monetary data: engage the project currency ratchet in
    // the same commit (hooks/projectCurrencyLock.js does this for the browser).
    if (project.currencyLocked !== true) tx.update(projectRef, { currencyLocked: true }, { lastUpdateTime: projectSnap.updateTime })

    auditInTx(tx, db, companyId, {
      type: AUDIT.BOQ_BUDGET_TRANSFERRED, actorUid: uid, requestId,
      before: { amount: calc.centsToAmount(summary.beforeCents) },
      after: {
        projectId, currency: currencyCode,
        created: summary.createCount, refreshed: summary.refreshCount, zeroed: summary.zeroCount,
        amount: calc.centsToAmount(summary.afterCents),
        requestKey, resultKey, estimate,
        lines: planned.operations.map(op => ({
          costCodeId: op.costCodeId, operation: op.type,
          from: op.fromCents === null ? null : calc.centsToAmount(op.fromCents), to: op.amount,
          itemCount: op.itemCount, fingerprint: op.fingerprint,
        })),
      },
    }, now())
    return { outcome: calc.TRANSFER_OUTCOME.APPLIED, companyId, summary, resultKey }
  }, () => attempts)

  log.info('boq budget transfer', { uid, projectId, outcome: result.outcome, attempts, operations: result.summary?.operationCount ?? 0 })
  const s = result.summary ?? null
  return {
    outcome: result.outcome,
    created: s?.createCount ?? 0,
    refreshed: s?.refreshCount ?? 0,
    zeroed: s?.zeroCount ?? 0,
    blocked: s?.blockedCount ?? 0,
    before: s ? calc.centsToAmount(s.beforeCents) : null,
    after: s ? calc.centsToAmount(s.afterCents) : null,
    resultKey: result.resultKey ?? null,
    byCaller: result.byCaller ?? null,
    estimateId: result.outcome === calc.TRANSFER_OUTCOME.UNCHANGED ? null : estimateId,
    attempts,
  }
}
