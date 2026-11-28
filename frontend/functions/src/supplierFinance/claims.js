import { FieldValue } from '../lib/firebaseAdmin.js'
import { createdEditorStamp, editorStamp } from '../lib/approvalPolicy.js'
import { CODE, fail } from '../lib/errors.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import * as calc from '../generated/supplierFinanceCalc.js'
import {
  runGuarded, withId, cents, callerScope, requireBaseline, nextNumber, poClaimLedgerEntry, writePoClaimLedger,
  failProblem, requireRevision,
} from './context.js'

// ── Progress claims (ADR-93) ─────────────────────────────────────────────────
//
// create   reads: membership, company, project, baseline marker, the claim id,
//          the number counter, the PO, its claim ledger, and each variation a
//          line names (≤ the 200-line ceiling) — a FIXED set, never a register.
//          Writes: counter, claim, PO claim ledger (the claim is now open),
//          the project currency lock if not yet engaged, one audit event.
// update   reads: membership, project, marker, claim, its PO claim ledger.
//          Writes: the claim (re-derived, version 2). No audit event (no fact).
// approve  reads: membership, project, marker, claim, PO, its claim ledger,
//          each variation a line names. Verifies the stored submitted side
//          (claimSubmittedSideProblem) and certifies under the claim's OWN
//          version. Writes: claim, ledger (certified amounts added, claim
//          closed), one audit event.
// reject   reads: membership, project, marker, claim, its ledger. Writes:
//          claim, ledger (closed), one audit event.
//
// CONTENTION: the PO claim ledger is the one document every claim operation on
// that PO writes — at most one open claim per PO, so it serialises exactly
// the operations that must not interleave (two creates; an approve racing a
// create). Claims on different POs never contend.

const auditAfter = (projectId, claimId, d) => ({
  projectId, claimId, claimNumber: d.claimNumber ?? null, poId: d.poId ?? null, status: d.status ?? null, calcVersion: d.calcVersion ?? null,
  revision: d.revision ?? null, lineCount: Array.isArray(d.lineItems) ? d.lineItems.length : null,
})

async function readCommon(tx, deps, uid, projectId, claimId) {
  const scope = await callerScope(tx, deps.db, uid, projectId)
  const claimRef = scope.claims.doc(claimId)
  const [companySnap, projectSnap, markerSnap, claimSnap] = await tx.getAll(scope.companyRef, scope.projectRef, scope.baselineRef, claimRef)
  if (!companySnap.exists || !projectSnap.exists) fail(CODE.NOT_FOUND)
  requireBaseline(markerSnap)
  return { scope, claimRef, companySnap, projectSnap, claim: withId(claimSnap) }
}

async function readVariations(tx, scope, ids) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const snaps = await tx.getAll(...unique.map(id => scope.variations.doc(id)))
  return snaps.map(withId)
}

export async function createProgressClaim(deps, { uid, input, requestId = null }) {
  const { db, now, log } = deps
  let attempts = 0
  const result = await runGuarded(db, log, { uid, op: 'claim.create' }, async (tx) => {
    attempts += 1
    const { scope, claimRef, companySnap, projectSnap, claim } = await readCommon(tx, deps, uid, input.projectId, input.claimId)
    const counterRef = scope.companyRef.collection('counters').doc(calc.CLAIM_COUNTER_ID)
    const poRef = scope.purchaseOrders.doc(input.poId)
    const ledgerRef = scope.poClaimLedgers.doc(input.poId)
    const [counterSnap, poSnap, ledgerSnap] = await tx.getAll(counterRef, poRef, ledgerRef)
    const variations = await readVariations(tx, scope, input.lines.filter(l => l.variationId !== null).map(l => l.variationId))
    if (claim) {
      if (claim.createdBy !== uid) fail(CODE.SF_ID_CONFLICT)
      return { alreadyApplied: true, claimNumber: claim.claimNumber ?? null }
    }
    const next = nextNumber(counterSnap)
    const project = withId(projectSnap)
    const currency = calc.resolveProjectCurrency(project, withId(companySnap))
    const ledger = poClaimLedgerEntry(ledgerSnap)
    const stamp = FieldValue.serverTimestamp()
    const built = calc.buildClaimDraft({ input, po: withId(poSnap), variations, ledger, uid, now: stamp, claimNumber: calc.formatClaimNumber(next), currency })
    if (built.problem) failProblem(built)
    tx.set(counterRef, { next: next + 1 }, { merge: true })
    tx.create(claimRef, { ...built.document, ...createdEditorStamp(uid) })
    writePoClaimLedger(tx, ledgerRef, calc.applyClaimOpened(ledger, input.claimId), { now: stamp, poId: input.poId })
    if (project.currencyLocked !== true) tx.update(scope.projectRef, { currencyLocked: true }, { lastUpdateTime: projectSnap.updateTime })
    const d = built.document
    auditInTx(tx, db, scope.companyId, {
      type: AUDIT.PROGRESS_CLAIM_CREATED, actorUid: uid, requestId, before: null,
      after: { ...auditAfter(input.projectId, input.claimId, d), claimedSubtotalCents: cents(d.claimedSubtotal), claimedGstCents: cents(d.claimedGst), claimedTotalCents: cents(d.claimedTotal), retentionCents: cents(d.retention) },
    }, now())
    return { alreadyApplied: false, claimNumber: d.claimNumber }
  }, () => attempts)
  log.info('claim create', { uid, projectId: input.projectId, claimId: input.claimId, alreadyApplied: result.alreadyApplied, attempts })
  return { claimId: input.claimId, ...result, attempts }
}

export async function updateProgressClaimDraft(deps, { uid, input }) {
  const { db, log } = deps
  let attempts = 0
  const result = await runGuarded(db, log, { uid, op: 'claim.update' }, async (tx) => {
    attempts += 1
    const { scope, claimRef, claim } = await readCommon(tx, deps, uid, input.projectId, input.claimId)
    if (!claim) fail(CODE.NOT_FOUND)
    const ledgerSnap = await tx.get(scope.poClaimLedgers.doc(claim.poId))
    const ledger = poClaimLedgerEntry(ledgerSnap)
    if (calc.calcVersionOf(claim) === null) fail(CODE.SF_UNSUPPORTED_RECORD, { reason: 'calc-version' })
    const built = calc.buildClaimDraftUpdate({ input, live: claim, ledger, uid, now: FieldValue.serverTimestamp() })
    if (!built.problem && claim.updatedBy === uid && claim.revision === input.expectedRevision + 1 && calc.claimDraftAlreadyHolds(claim, built.update)) {
      return { alreadyApplied: true }
    }
    if (claim.status !== calc.CLAIM_STATUS.DRAFT) fail(CODE.SF_INVALID, { reason: 'not-draft', status: claim.status ?? null })
    requireRevision(claim, input.expectedRevision)
    if (built.problem) failProblem(built)
    tx.update(claimRef, { ...built.update, ...editorStamp(claim, uid, built.update, ['claimRef', 'notes']) })
    return { alreadyApplied: false }
  }, () => attempts)
  log.info('claim update', { uid, projectId: input.projectId, claimId: input.claimId, alreadyApplied: result.alreadyApplied, attempts })
  return { claimId: input.claimId, ...result, attempts }
}

export async function approveProgressClaim(deps, { uid, input, requestId = null, segregation = null }) {
  const { db, now, log } = deps
  let attempts = 0
  const result = await runGuarded(db, log, { uid, op: 'claim.approve' }, async (tx) => {
    attempts += 1
    const { scope, claimRef, claim } = await readCommon(tx, deps, uid, input.projectId, input.claimId)
    if (!claim) fail(CODE.NOT_FOUND)
    const ledgerRef = scope.poClaimLedgers.doc(claim.poId)
    const [poSnap, ledgerSnap] = await tx.getAll(scope.purchaseOrders.doc(claim.poId), ledgerRef)
    const variations = await readVariations(tx, scope, (claim.lineItems ?? []).filter(l => typeof l?.variationId === 'string' && l.variationId).map(l => l.variationId))
    if (segregation) await segregation.read(tx, scope)
    if (calc.sameClaimApproval(claim, uid, input.approvedAmounts) && claim.revision === input.expectedRevision + 1) return { alreadyApplied: true }
    if (!calc.CLAIM_APPROVABLE_STATUSES.includes(claim.status)) fail(CODE.SF_INVALID, { reason: 'not-submitted', status: claim.status ?? null })
    requireRevision(claim, input.expectedRevision)
    const ledger = poClaimLedgerEntry(ledgerSnap)
    if (ledger.state === 'inconsistent') fail(CODE.SF_LEDGER_INCONSISTENT, { message: ledger.problem })
    const verified = calc.claimSubmittedSideProblem({ claim, po: withId(poSnap), variations, ledger })
    if (verified) failProblem(verified)
    if (segregation) segregation.check(claim)
    const stamp = FieldValue.serverTimestamp()
    const built = calc.buildClaimApproval({ claim, approvedAmounts: input.approvedAmounts, assessmentNotes: input.assessmentNotes, uid, now: stamp })
    if (built.problem) failProblem(built)
    tx.update(claimRef, built.update)
    writePoClaimLedger(tx, ledgerRef, calc.applyClaimApproval(ledger, claim.id, built.update.lineItems), { now: stamp, poId: claim.poId })
    const u = built.update
    auditInTx(tx, db, scope.companyId, {
      type: AUDIT.PROGRESS_CLAIM_APPROVED, actorUid: uid, requestId,
      before: { status: claim.status, revision: claim.revision ?? null },
      after: {
        ...auditAfter(input.projectId, claim.id, { ...claim, ...u }), approvedSubtotalCents: cents(u.approvedSubtotal), approvedGstCents: cents(u.approvedGst), approvedTotalCents: cents(u.approvedTotal),
        approver: { isCreator: claim.createdBy === uid, isSubmitter: claim.submittedBy === uid, isLastEditor: claim.updatedBy === uid },
        segregation: segregation ? segregation.record() : null,
      },
    }, now())
    return { alreadyApplied: false }
  }, () => attempts)
  log.info('claim approve', { uid, projectId: input.projectId, claimId: input.claimId, alreadyApplied: result.alreadyApplied, attempts })
  return { claimId: input.claimId, ...result, attempts }
}

export async function rejectProgressClaim(deps, { uid, input, requestId = null }) {
  const { db, now, log } = deps
  let attempts = 0
  const result = await runGuarded(db, log, { uid, op: 'claim.reject' }, async (tx) => {
    attempts += 1
    const { scope, claimRef, claim } = await readCommon(tx, deps, uid, input.projectId, input.claimId)
    if (!claim) fail(CODE.NOT_FOUND)
    const ledgerRef = scope.poClaimLedgers.doc(claim.poId)
    const ledger = poClaimLedgerEntry(await tx.get(ledgerRef))
    if (claim.status === calc.CLAIM_STATUS.REJECTED && claim.rejectedBy === uid && claim.revision === input.expectedRevision + 1) return { alreadyApplied: true }
    if (!calc.CLAIM_REJECTABLE_STATUSES.includes(claim.status)) fail(CODE.SF_INVALID, { reason: 'not-open', status: claim.status ?? null })
    requireRevision(claim, input.expectedRevision)
    const stamp = FieldValue.serverTimestamp()
    const notes = input.assessmentNotes.trim()
    tx.update(claimRef, {
      status: calc.CLAIM_STATUS.REJECTED, rejectedAt: stamp, rejectedBy: uid,
      ...(notes ? { assessmentNotes: notes } : {}),
      revision: (Number(claim.revision) || 0) + 1, updatedAt: stamp, updatedBy: uid,
    })
    // Closing the claim frees the PO for the next one — whatever the ledger
    // state, since closing can only reduce the open set.
    const closed = calc.applyClaimClosed(ledger, claim.id)
    // A ledger that was inconsistent ONLY because several claims were open
    // (DC36 history) becomes established once at most one remains open.
    const recovered = ledger.problemKind === 'open-claims' && closed.openClaimIds.length <= 1
    tx.set(ledgerRef, {
      ...calc.poClaimLedgerDocument(closed), poId: claim.poId, updatedAt: stamp,
      ...(recovered ? { state: 'established', problem: null, problemKind: null } : {}),
    }, { merge: true })
    auditInTx(tx, db, scope.companyId, {
      type: AUDIT.PROGRESS_CLAIM_REJECTED, actorUid: uid, requestId,
      before: { status: claim.status, revision: claim.revision ?? null },
      after: auditAfter(input.projectId, claim.id, { ...claim, status: calc.CLAIM_STATUS.REJECTED, revision: (Number(claim.revision) || 0) + 1 }),
    }, now())
    return { alreadyApplied: false }
  }, () => attempts)
  log.info('claim reject', { uid, projectId: input.projectId, claimId: input.claimId, alreadyApplied: result.alreadyApplied, attempts })
  return { claimId: input.claimId, ...result, attempts }
}
