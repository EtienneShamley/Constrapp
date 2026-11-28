import { CODE, fail } from '../lib/errors.js'
import { userRef, assertActiveRole } from '../lib/authz.js'
import { requireCommercialActivationInTx } from '../lib/commercialActivation.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import { FieldValue } from '../lib/firebaseAdmin.js'
import { segregationGuard, createdEditorStamp, editorStamp } from '../lib/approvalPolicy.js'
import * as calc from '../generated/variationCalc.js'
import { VARIATION_ROLES } from './contracts.js'

// ── Creating, approving and applying variations (ADR-90) ─────────────────────
//
// THE TRUSTED TRANSACTION BOUNDARY FOR VARIATIONS. A variation is CREATED, its
// DRAFT is EDITED, it becomes APPROVED, and its commitment stamps are written,
// only here. Security Rules give a browser no path to any of the four
// (`variations`: no create, no content edit, no approve branch, no branch that
// admits a commitment stamp); they keep the read and the content-free submit /
// reject / withdraw transitions.
//
// NOTHING STORED IS TRUSTED WHEN IT IS ABOUT TO BECOME AUTHORITATIVE. A
// variation may have been written before this boundary existed, under Rules
// that cannot look inside its lines. So an APPROVAL re-derives the submitted
// side under the document's own calculation version and checks every line's
// cost code against the purchase order or the company library; and an APPLY
// does the same for the approved side — before anything is written. An
// approved variation is never recalculated or rewritten by either.
//
// ONE read-write transaction per request, EVERY read before ANY write:
//   1. the caller's membership, read INSIDE the transaction (active, of a
//      company, company_admin / project_manager / qs) — the company comes from
//      that document, never from the request, so another tenant's project,
//      purchase order, RFI or cost code is simply not found;
//   2. the documents the operation depends on, each by its own reference — a
//      FIXED set per operation, never a register:
//        create   company, project, the variation id, the type's number
//                 counter, the purchase order (if named), the originating RFI
//                 (if named) and one cost code per distinct new-scope line —
//                 at most 4 + 1 + 1 + 200 documents (the line ceiling);
//        edit     project, variation, its purchase order (if a line names
//                 one), the originating RFI (if it is being changed) and one
//                 cost code per distinct new-scope line (≤ 200);
//        approve  project, variation, its purchase order (if linked) and one
//                 cost code per distinct new-scope line (≤ 200);
//        apply    project, variation, purchase order, and the same cost codes;
//   3. the decision and EVERY derived figure — from the generated copy of the
//      browser's own modules (generated/variationCalc.js), under the
//      variation's own calculation version (ADR-91);
//   4. the writes — the variation, plus on create the counter and the project
//      currency lock — and ONE audit event, together or not at all.
//
// IDEMPOTENCE. A repeat after an uncertain outcome (timeout, lost response) is
// answered `alreadyApplied: true` with nothing written and no second audit
// event: a create whose variation id already exists and was created by the
// same caller; an approve of a variation already approved by the same caller
// with the same certified amounts; an apply of a variation whose stamps are
// already present. Anything else that finds the work done is told so.
//
// CONTENTION. A variation's own document is the only one two approvals or
// applies contend on. A create also writes the company-wide number counter of
// its type — the existing contention point of every numbered document (about
// one create per second per company and type; ARCHITECTURE.md → Capacity).

// gRPC ABORTED — the transaction lost to concurrent writes on every attempt.
// It is the ONE transport failure with a certain outcome: nothing committed.
// Every OTHER unexpected failure is rethrown untyped: its outcome is NOT
// certain, the client says so, and a retry is safe (idempotence, above).
const GRPC_ABORTED = 10
export const VARIATION_MAX_ATTEMPTS = 5

async function runGuarded(db, log, context, body, attemptsSoFar) {
  try {
    return await db.runTransaction(body, { maxAttempts: VARIATION_MAX_ATTEMPTS })
  } catch (err) {
    if (!err?.details?.code && err?.code === GRPC_ABORTED) {
      log.warn('variation request aborted by contention', { ...context, attempts: attemptsSoFar() })
      fail(CODE.VARIATION_BUSY, { attempts: attemptsSoFar() })
    }
    throw err
  }
}

const withId = (snap) => (snap.exists ? { ...snap.data(), id: snap.id } : null)
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const isDateOrEmpty = (v) => typeof v === 'string' && (v === '' || DATE_RE.test(v))

// The caller, read inside the transaction, and the project under THE CALLER'S
// company. Returns the references every operation starts from.
async function callerScope(tx, db, uid, projectId) {
  const profileSnap = await tx.get(userRef(db, uid))
  const profile = assertActiveRole(profileSnap.exists ? profileSnap.data() : null, VARIATION_ROLES, CODE.VARIATION_FORBIDDEN)
  await requireCommercialActivationInTx(tx, db, profile.companyId)
  const companyRef = db.collection('companies').doc(profile.companyId)
  const projectRef = companyRef.collection('projects').doc(projectId)
  return { companyId: profile.companyId, companyRef, projectRef }
}

const cents = (amount) => (typeof amount === 'number' ? Math.round(amount * 100) : null)

// The cost-code documents named by `ids`, read through the transaction, as a
// Map of the ones that exist.
async function readCostCodes(tx, companyRef, ids) {
  const found = new Map()
  if (ids.length === 0) return found
  const snaps = await tx.getAll(...ids.map(id => companyRef.collection('costCodes').doc(id)))
  ids.forEach((id, i) => { if (snaps[i].exists) found.set(id, snaps[i].data()) })
  return found
}

// A number counter is a positive whole number below this bound, or it is not
// used: a tampered or corrupt counter is refused, never guessed around.
export const COUNTER_MAX = 999_999_999

// ── createVariation ──────────────────────────────────────────────────────────

const CREATE_REFUSAL = {
  [calc.CREATE_PROBLEM.PO_INVALID]:        CODE.VARIATION_PO_INVALID,
  [calc.CREATE_PROBLEM.PO_LINE_INVALID]:   CODE.VARIATION_COST_CODE_INVALID,
  [calc.CREATE_PROBLEM.COST_CODE_INVALID]: CODE.VARIATION_COST_CODE_INVALID,
  [calc.CREATE_PROBLEM.RFI_INVALID]:       CODE.VARIATION_RFI_INVALID,
  [calc.CREATE_PROBLEM.OUT_OF_RANGE]:      CODE.VARIATION_AMOUNT_OUT_OF_RANGE,
}

export async function createVariation(deps, { uid, input, requestId = null }) {
  const { db, now, log, hooks = {} } = deps
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId: input.projectId, op: 'create' }, async (tx) => {
    attempts += 1
    const { companyId, companyRef, projectRef } = await callerScope(tx, db, uid, input.projectId)
    const variationRef = projectRef.collection('variations').doc(input.variationId)
    const counterRef = companyRef.collection('counters').doc(calc.VARIATION_COUNTER_ID[input.variationType])

    const [companySnap, projectSnap, variationSnap, counterSnap] = await tx.getAll(companyRef, projectRef, variationRef, counterRef)
    if (!companySnap.exists || !projectSnap.exists) fail(CODE.NOT_FOUND)

    // A repeat of a request that already committed — or somebody else's id.
    if (variationSnap.exists) {
      const stored = variationSnap.data()
      if (stored.createdBy !== uid) fail(CODE.VARIATION_ID_CONFLICT)
      return { alreadyApplied: true, companyId, variationNumber: stored.variationNumber ?? null }
    }

    // The sources the request names, each read by reference.
    const poRef = input.poId === null ? null : projectRef.collection('purchaseOrders').doc(input.poId)
    const rfiRef = input.originRfiId === null ? null : projectRef.collection('rfis').doc(input.originRfiId)
    const costCodeIds = calc.requestedCostCodeIds(input)
    const sourceRefs = [
      ...(poRef ? [poRef] : []), ...(rfiRef ? [rfiRef] : []),
      ...costCodeIds.map(id => companyRef.collection('costCodes').doc(id)),
    ]
    const sourceSnaps = sourceRefs.length > 0 ? await tx.getAll(...sourceRefs) : []
    let cursor = 0
    const po = poRef ? withId(sourceSnaps[cursor++]) : null
    const rfi = rfiRef ? withId(sourceSnaps[cursor++]) : null
    const costCodes = new Map()
    for (const id of costCodeIds) {
      const snap = sourceSnaps[cursor++]
      if (snap.exists) costCodes.set(id, snap.data())
    }
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts, op: 'create' })

    // The number: read and advanced in this transaction (ADR-5). A counter
    // that is not a positive integer is never guessed around.
    const next = counterSnap.exists ? counterSnap.data().next : 1
    if (!Number.isSafeInteger(next) || next < 1 || next > COUNTER_MAX) fail(CODE.VARIATION_UNSUPPORTED_RECORD, { reason: 'counter' })

    const project = { ...projectSnap.data(), id: projectSnap.id }
    const currency = calc.resolveProjectCurrency(project, { ...companySnap.data(), id: companySnap.id })
    const built = calc.buildVariationDraft({ input, number: next, currency, po, costCodes, rfi, uid, now: FieldValue.serverTimestamp() })
    if (!built.ok) fail(CREATE_REFUSAL[built.problem] ?? CODE.VARIATION_INVALID, { problem: built.problem, ...built.detail })

    tx.set(counterRef, { next: next + 1 }, { merge: true })
    // `create` fails if the document appeared meanwhile: one id, one variation.
    tx.create(variationRef, { ...built.document, ...createdEditorStamp(uid) })
    // A variation is monetary data: engage the project currency ratchet in the
    // same commit (hooks/projectCurrencyLock.js does this for the browser).
    if (project.currencyLocked !== true) tx.update(projectRef, { currencyLocked: true }, { lastUpdateTime: projectSnap.updateTime })

    const d = built.document
    auditInTx(tx, db, companyId, {
      type: AUDIT.VARIATION_CREATED, actorUid: uid, requestId,
      before: null,
      after: {
        projectId: input.projectId, variationId: input.variationId, variationNumber: d.variationNumber,
        variationType: d.variationType, status: d.status, currency: d.currency, calcVersion: d.calcVersion, revision: d.revision,
        poId: d.poId, originRfiId: d.originRfiId, lineCount: d.lineItems.length,
        submittedSubtotalCents: cents(d.submittedSubtotal), submittedGstCents: cents(d.submittedGst), submittedTotalCents: cents(d.submittedTotal),
      },
    }, now())
    return { alreadyApplied: false, companyId, variationNumber: d.variationNumber }
  }, () => attempts)

  log.info('variation create', { uid, projectId: input.projectId, variationId: input.variationId, alreadyApplied: result.alreadyApplied, attempts })
  return { variationId: input.variationId, variationNumber: result.variationNumber, alreadyApplied: result.alreadyApplied, attempts }
}

// ── updateVariationDraft ─────────────────────────────────────────────────────

const DRAFT_REFUSAL = {
  ...CREATE_REFUSAL,
  [calc.DRAFT_PROBLEM.REFS_INVALID]: CODE.VARIATION_INVALID,
}

export async function updateVariationDraft(deps, { uid, input }) {
  const { db, log, hooks = {} } = deps
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId: input.projectId, op: 'update' }, async (tx) => {
    attempts += 1
    const { companyRef, projectRef } = await callerScope(tx, db, uid, input.projectId)
    const variationRef = projectRef.collection('variations').doc(input.variationId)
    const [projectSnap, variationSnap] = await tx.getAll(projectRef, variationRef)
    if (!projectSnap.exists || !variationSnap.exists) fail(CODE.NOT_FOUND)
    const live = withId(variationSnap)
    if (calc.variationCalcVersion(live) === null) fail(CODE.VARIATION_UNSUPPORTED_RECORD, { reason: 'calc-version' })

    // The sources the edit names, each by reference: the variation's OWN
    // purchase order when a line names one of its lines, the RFI when the link
    // is being changed, and one cost code per distinct new-scope line.
    const needsPo = input.lines.some(l => l.poLineIndex !== null) && typeof live.poId === 'string' && live.poId.length > 0
    const po = needsPo ? withId(await tx.get(projectRef.collection('purchaseOrders').doc(live.poId))) : null
    const rfi = input.changeOriginRfi && input.originRfiId !== null
      ? withId(await tx.get(projectRef.collection('rfis').doc(input.originRfiId)))
      : null
    const costCodes = await readCostCodes(tx, companyRef, calc.requestedCostCodeIds(input))
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts, op: 'update' })

    const built = calc.buildVariationDraftUpdate({ input, live, po, costCodes, rfi, uid, now: FieldValue.serverTimestamp() })

    // A repeat of an edit that already committed: the stored draft is one
    // revision on from the edited one, was last written by this caller, and
    // already holds exactly what this request derives.
    if (built.ok && live.updatedBy === uid && calc.storedRevision(live) === input.expectedRevision + 1 && calc.draftAlreadyHolds(live, built.update)) {
      return { alreadyApplied: true }
    }
    if (live.status !== calc.VARIATION_STATUS.DRAFT) fail(CODE.VARIATION_NOT_DRAFT, { status: live.status ?? null })
    // The edit replaces the exact draft that was opened.
    if (calc.storedRevision(live) !== input.expectedRevision) fail(CODE.VARIATION_STALE, { revision: calc.storedRevision(live) })
    if (!built.ok) fail(DRAFT_REFUSAL[built.problem] ?? CODE.VARIATION_INVALID, { problem: built.problem, ...built.detail })

    // No audit event: a draft edit creates no financial fact. Who last wrote
    // the draft, and when, are the stamps on the document itself.
    tx.update(variationRef, { ...built.update, ...editorStamp(live, uid, built.update, ['notes', 'clientRef', 'supplierRef']) }, { lastUpdateTime: variationSnap.updateTime })
    return { alreadyApplied: false }
  }, () => attempts)

  log.info('variation draft update', { uid, projectId: input.projectId, variationId: input.variationId, alreadyApplied: result.alreadyApplied, attempts })
  return { variationId: input.variationId, alreadyApplied: result.alreadyApplied, calcVersion: calc.CURRENT_CALC_VERSION, attempts }
}

// ── approveVariation ─────────────────────────────────────────────────────────

export async function approveVariation(deps, { uid, input, requestId = null }) {
  const { db, now, log, hooks = {} } = deps
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId: input.projectId, op: 'approve' }, async (tx) => {
    attempts += 1
    const { companyId, companyRef, projectRef } = await callerScope(tx, db, uid, input.projectId)
    const variationRef = projectRef.collection('variations').doc(input.variationId)
    const [projectSnap, variationSnap] = await tx.getAll(projectRef, variationRef)
    if (!projectSnap.exists || !variationSnap.exists) fail(CODE.NOT_FOUND)
    const live = withId(variationSnap)

    // The calculation policy of this document; an unknown one is never guessed.
    const version = calc.variationCalcVersion(live)
    if (version === null) fail(CODE.VARIATION_UNSUPPORTED_RECORD, { reason: 'calc-version' })

    // A repeat of an approval that already committed.
    if (live.status === calc.VARIATION_STATUS.APPROVED && live.approvedBy === uid && calc.sameApproval(live, input.approvedAmounts)) {
      return { alreadyApplied: true, companyId, commitmentApplied: calc.isCommitmentApplied(live) }
    }
    if (!calc.APPROVABLE_STATUSES.includes(live.status)) fail(CODE.VARIATION_NOT_SUBMITTED, { status: live.status ?? null })
    // The approval must land on the exact revision that was reviewed.
    if (calc.storedRevision(live) !== input.expectedRevision) fail(CODE.VARIATION_STALE, { revision: calc.storedRevision(live) })
    if (!Array.isArray(live.lineItems) || live.lineItems.length < 1) fail(CODE.VARIATION_UNSUPPORTED_RECORD, { reason: 'lines' })
    if (!isDateOrEmpty(live.effectiveDate ?? '') || !isDateOrEmpty(live.approvedDate ?? '')) fail(CODE.VARIATION_UNSUPPORTED_RECORD, { reason: 'dates' })

    // What is about to be certified must reconcile — under the document's OWN
    // calculation version, legacy or exact. Nothing stored is trusted.
    const submittedProblem = calc.submittedSideProblem(live)
    if (submittedProblem) fail(CODE.VARIATION_FIGURES_INCONSISTENT, { reason: submittedProblem })

    // ADR-62: a PO-linked supplier variation is approved AND applied in one
    // write, and only while its purchase order is sent or closed ON THE SERVER.
    // A missing, draft, pending or cancelled order REFUSES the approval.
    if (!('poId' in live)) fail(CODE.VARIATION_UNSUPPORTED_RECORD, { reason: 'po-link' })
    let applyCommitment = false
    let po = null
    if (live.poId !== null) {
      if (!calc.isPoLinkedSupplierVariation(live)) fail(CODE.VARIATION_UNSUPPORTED_RECORD, { reason: 'po-link' })
      po = withId(await tx.get(projectRef.collection('purchaseOrders').doc(live.poId)))
      if (!calc.shouldApplyOnApproval(live, po)) {
        const name = live.variationNumber || 'This variation'
        fail(CODE.VARIATION_PO_INVALID, {
          poStatus: po?.status ?? null,
          message: po
            ? `${po.poNumber || live.poNumber || 'The linked purchase order'} is not sent or closed; a supplier variation can only be approved while its purchase order is sent or closed. Nothing was changed. Withdraw or reject ${name}, or raise it again against a current purchase order.`
            : `${live.poNumber || 'The linked purchase order'} could not be found in this project, so ${name} cannot be approved. Nothing was changed. Withdraw or reject it, or raise it again against a current purchase order.`,
        })
      }
      applyCommitment = true
    }

    // Every line's cost code is the purchase-order line's own, or exists in
    // the company library — checked against records read here.
    const costCodes = await readCostCodes(tx, companyRef, calc.storedCostCodeIds(live))
    const sources = calc.lineSources(live, { po, costCodes })
    if (!sources.ok) fail(CODE.VARIATION_FIGURES_INCONSISTENT, { reason: sources.reason, line: sources.line })
    // ADR-96: approval segregation — the company policy, read in this
    // transaction; refused when enabled and the approver prepared the document.
    const segregation = segregationGuard(db, uid, { label: 'variation' })
    await segregation.read(tx, { companyId })
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts, op: 'approve' })
    segregation.check(live)

    let update
    try {
      update = calc.transitionUpdate(
        live, calc.VARIATION_STATUS.APPROVED,
        { approvedAmounts: input.approvedAmounts, assessmentNotes: input.assessmentNotes, applyCommitment },
        uid, FieldValue.serverTimestamp(), input.approvedDate,
      )
    } catch (err) {
      // The domain module's own readable refusal (a count mismatch, differing
      // amounts without notes). Anything else is unexpected and rethrown.
      if (err instanceof calc.VariationWriteError) fail(CODE.VARIATION_INVALID, { message: `${err.message}. Nothing was changed.` })
      throw err
    }
    if (!calc.approvedHeaderSupported(update)) fail(CODE.VARIATION_AMOUNT_OUT_OF_RANGE)
    // The cost-code NAME of each certified line is taken from its authoritative
    // source now; the id was verified above.
    update.lineItems = calc.withAuthoritativeNames(update.lineItems, sources.names)

    tx.update(variationRef, update, { lastUpdateTime: variationSnap.updateTime })
    auditInTx(tx, db, companyId, {
      type: AUDIT.VARIATION_APPROVED, actorUid: uid, requestId,
      before: { status: live.status, revision: calc.storedRevision(live) },
      after: {
        projectId: input.projectId, variationId: input.variationId, variationNumber: live.variationNumber ?? null,
        variationType: live.variationType ?? null, status: update.status, calcVersion: version, revision: update.revision,
        poId: live.poId, commitmentApplied: applyCommitment, lineCount: update.lineItems.length,
        submittedSubtotalCents: cents(live.submittedSubtotal),
        approvedSubtotalCents: cents(update.approvedSubtotal), approvedGstCents: cents(update.approvedGst), approvedTotalCents: cents(update.approvedTotal),
        ...calc.approvalActorEvidence(live, uid),
        segregation: segregation.record(),
      },
    }, now())
    return { alreadyApplied: false, companyId, commitmentApplied: applyCommitment }
  }, () => attempts)

  log.info('variation approve', { uid, projectId: input.projectId, variationId: input.variationId, alreadyApplied: result.alreadyApplied, commitmentApplied: result.commitmentApplied, attempts })
  return { variationId: input.variationId, alreadyApplied: result.alreadyApplied, commitmentApplied: result.commitmentApplied, attempts }
}

// ── applyVariationCommitment (the one-time legacy Apply / Commit new scope) ──

export async function applyVariationCommitment(deps, { uid, input, requestId = null }) {
  const { db, now, log, hooks = {} } = deps
  let attempts = 0

  const result = await runGuarded(db, log, { uid, projectId: input.projectId, op: 'apply' }, async (tx) => {
    attempts += 1
    const { companyId, companyRef, projectRef } = await callerScope(tx, db, uid, input.projectId)
    const variationRef = projectRef.collection('variations').doc(input.variationId)
    const [projectSnap, variationSnap] = await tx.getAll(projectRef, variationRef)
    if (!projectSnap.exists || !variationSnap.exists) fail(CODE.NOT_FOUND)
    const live = withId(variationSnap)

    // Both pairs present: the work is done. Never rewritten.
    if (calc.isCommitmentApplied(live) && calc.isScopeCommitted(live)) {
      return { alreadyApplied: true, companyId, byCaller: live.scopeCommittedBy === uid || live.commitmentAppliedBy === uid, applied: false, scopeCommitted: false }
    }
    if (calc.storedRevision(live) !== input.expectedRevision) fail(CODE.VARIATION_STALE, { revision: calc.storedRevision(live) })

    const po = typeof live.poId === 'string' && live.poId.length > 0
      ? withId(await tx.get(projectRef.collection('purchaseOrders').doc(live.poId)))
      : null
    if (hooks.afterRead) await hooks.afterRead({ attempt: attempts, op: 'apply' })

    const eligibility = calc.commitmentApplyEligibility(live, po ? [po] : [])
    if (!eligibility.eligible) {
      if (eligibility.blocker === calc.COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED) {
        return { alreadyApplied: true, companyId, byCaller: false, applied: false, scopeCommitted: false }
      }
      fail(CODE.VARIATION_NOT_APPLICABLE, { blocker: eligibility.blocker, message: `${eligibility.message} Nothing was changed.` })
    }

    // What is about to become COMMITMENT must reconcile: the certified side
    // under the document's own calculation version, and every line's cost code
    // against the purchase order or the company library. The approved
    // variation itself is not changed either way — one that does not reconcile
    // is simply not applied, and stays visible as unapplied exposure.
    const approvedProblem = calc.approvedSideProblem(live)
    if (approvedProblem) fail(CODE.VARIATION_FIGURES_INCONSISTENT, { reason: approvedProblem })
    const costCodes = await readCostCodes(tx, companyRef, calc.storedCostCodeIds(live))
    const sources = calc.lineSources(live, { po, costCodes })
    if (!sources.ok) fail(CODE.VARIATION_FIGURES_INCONSISTENT, { reason: sources.reason, line: sources.line })

    const update = calc.applyCommitmentUpdate(live, uid, FieldValue.serverTimestamp())
    tx.update(variationRef, update, { lastUpdateTime: variationSnap.updateTime })
    auditInTx(tx, db, companyId, {
      type: AUDIT.VARIATION_COMMITMENT_APPLIED, actorUid: uid, requestId,
      before: { revision: calc.storedRevision(live), commitmentApplied: calc.isCommitmentApplied(live), scopeCommitted: calc.isScopeCommitted(live) },
      after: {
        projectId: input.projectId, variationId: input.variationId, variationNumber: live.variationNumber ?? null,
        poId: live.poId, revision: update.revision,
        commitmentApplied: true, scopeCommitted: true,
        appliedNow: eligibility.missing.applied, scopeCommittedNow: eligibility.missing.scope,
      },
    }, now())
    return { alreadyApplied: false, companyId, byCaller: true, applied: eligibility.missing.applied, scopeCommitted: eligibility.missing.scope }
  }, () => attempts)

  log.info('variation apply', { uid, projectId: input.projectId, variationId: input.variationId, alreadyApplied: result.alreadyApplied, attempts })
  return {
    variationId: input.variationId, alreadyApplied: result.alreadyApplied, byCaller: result.byCaller,
    applied: result.applied, scopeCommitted: result.scopeCommitted, attempts,
  }
}
