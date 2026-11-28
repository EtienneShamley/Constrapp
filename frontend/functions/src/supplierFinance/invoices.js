import { FieldValue } from '../lib/firebaseAdmin.js'
import { createdEditorStamp, editorStamp } from '../lib/approvalPolicy.js'
import { CODE, fail } from '../lib/errors.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import * as calc from '../generated/supplierFinanceCalc.js'
import { runGuarded, withId, cents, callerScope, requireBaseline, nextNumber, failProblem, requireRevision } from './context.js'

// ── Supplier invoices (ADR-93) ───────────────────────────────────────────────
//
// create   reads: membership, company, project, marker, the invoice id, the
//          counter, then the PO (direct) or the claim (claim-sourced), and the
//          supplier contact (payment-terms snapshot). Writes: counter,
//          invoice, on claim-sourced the claim's link (ADR-68 pairing — the
//          claim document is the concurrency boundary: two creates against one
//          claim contend on it and the second finds it linked), the currency
//          lock, one audit event.
// update   reads: membership, project, marker, invoice, its PO (direct).
//          Writes: the invoice. No audit event.
// approve  reads: membership, project, marker, invoice, PO, claim (claim-
// / post   sourced). Verifies everything stored (invoiceStoredProblem) under
//          the invoice's OWN version; posting a claim-sourced invoice also
//          requires its claim to link it. Writes: invoice, one audit event.
// cancel   reads: membership, project, marker, invoice, claim. Writes: invoice,
//          the claim's unlink when it links THIS invoice, one audit event.
// link     reads: membership, project, marker, claim, invoice. Writes: the
//          claim's link, one audit event.

async function readCommon(tx, deps, uid, projectId) {
  const scope = await callerScope(tx, deps.db, uid, projectId)
  const [companySnap, projectSnap, markerSnap] = await tx.getAll(scope.companyRef, scope.projectRef, scope.baselineRef)
  if (!companySnap.exists || !projectSnap.exists) fail(CODE.NOT_FOUND)
  requireBaseline(markerSnap)
  return { scope, companySnap, projectSnap }
}

const auditAfter = (projectId, d, id) => ({
  projectId, invoiceId: id, invoiceNumber: d.invoiceNumber ?? null, source: d.source ?? null, poId: d.poId ?? null,
  progressClaimId: d.progressClaimId ?? null, status: d.status ?? null, calcVersion: d.calcVersion ?? null, revision: d.revision ?? null,
  payableTotalCents: cents(d.payableTotal), payableGstCents: cents(d.payableGst), grossTotalCents: cents(d.grossTotal), retentionCents: cents(d.retention),
})

const claimLink = (uid, invoiceId, live, stamp) => ({
  supplierInvoiceId: invoiceId, supplierInvoiceLinkedAt: stamp, supplierInvoiceLinkedBy: uid,
  revision: (Number(live.revision) || 0) + 1, updatedAt: stamp, updatedBy: uid,
})

export async function createSupplierInvoice(deps, { uid, input, requestId = null }) {
  const { db, now, log } = deps
  let attempts = 0
  const result = await runGuarded(db, log, { uid, op: 'invoice.create' }, async (tx) => {
    attempts += 1
    const { scope, companySnap, projectSnap } = await readCommon(tx, deps, uid, input.projectId)
    const invoiceRef = scope.invoices.doc(input.invoiceId)
    const counterRef = scope.companyRef.collection('counters').doc(calc.INVOICE_COUNTER_ID)
    const claimSourced = input.source === calc.SI_SOURCE.PROGRESS_CLAIM
    const sourceRef = claimSourced ? scope.claims.doc(input.sourceId) : scope.purchaseOrders.doc(input.sourceId)
    const [invoiceSnap, counterSnap, sourceSnap] = await tx.getAll(invoiceRef, counterRef, sourceRef)
    const source = withId(sourceSnap)
    const supplierId = source?.supplierId ?? null
    const contact = supplierId ? withId(await tx.get(scope.companyRef.collection('contacts').doc(supplierId))) : null
    if (invoiceSnap.exists) {
      const stored = invoiceSnap.data()
      if (stored.createdBy !== uid) fail(CODE.SF_ID_CONFLICT)
      return { alreadyApplied: true, invoiceNumber: stored.invoiceNumber ?? null }
    }
    const next = nextNumber(counterSnap)
    const project = withId(projectSnap)
    const currency = calc.resolveProjectCurrency(project, withId(companySnap))
    const stamp = FieldValue.serverTimestamp()
    const common = { input, invoiceNumber: calc.formatSupplierInvoiceNumber(next), currency, paymentTerms: contact?.paymentTerms ?? null, uid, now: stamp }
    const built = claimSourced ? calc.buildClaimSourcedInvoice({ ...common, claim: source }) : calc.buildDirectInvoice({ ...common, po: source })
    if (built.problem) failProblem(built)
    tx.set(counterRef, { next: next + 1 }, { merge: true })
    tx.create(invoiceRef, { ...built.document, ...createdEditorStamp(uid) })
    if (claimSourced) tx.update(sourceRef, claimLink(uid, input.invoiceId, source, stamp))
    if (project.currencyLocked !== true) tx.update(scope.projectRef, { currencyLocked: true }, { lastUpdateTime: projectSnap.updateTime })
    auditInTx(tx, db, scope.companyId, { type: AUDIT.SUPPLIER_INVOICE_CREATED, actorUid: uid, requestId, before: null, after: auditAfter(input.projectId, built.document, input.invoiceId) }, now())
    return { alreadyApplied: false, invoiceNumber: built.document.invoiceNumber }
  }, () => attempts)
  log.info('invoice create', { uid, projectId: input.projectId, invoiceId: input.invoiceId, alreadyApplied: result.alreadyApplied, attempts })
  return { invoiceId: input.invoiceId, ...result, attempts }
}

export async function updateSupplierInvoiceDraft(deps, { uid, input }) {
  const { db, log } = deps
  let attempts = 0
  const result = await runGuarded(db, log, { uid, op: 'invoice.update' }, async (tx) => {
    attempts += 1
    const { scope } = await readCommon(tx, deps, uid, input.projectId)
    const invoiceRef = scope.invoices.doc(input.invoiceId)
    const live = withId(await tx.get(invoiceRef))
    if (!live) fail(CODE.NOT_FOUND)
    const po = live.source === calc.SI_SOURCE.DIRECT_PO && live.poId ? withId(await tx.get(scope.purchaseOrders.doc(live.poId))) : null
    const built = calc.buildInvoiceDraftUpdate({ input, live, po, uid, now: FieldValue.serverTimestamp() })
    if (!built.problem && live.updatedBy === uid && live.revision === input.expectedRevision + 1 && calc.invoiceDraftAlreadyHolds(live, built.update)) return { alreadyApplied: true }
    if (live.status !== calc.SI_STATUS.DRAFT) fail(CODE.SF_INVALID, { reason: 'not-draft', status: live.status ?? null })
    requireRevision(live, input.expectedRevision)
    if (built.problem) failProblem(built)
    tx.update(invoiceRef, { ...built.update, ...editorStamp(live, uid, built.update, ['notes']) })
    return { alreadyApplied: false }
  }, () => attempts)
  log.info('invoice update', { uid, projectId: input.projectId, invoiceId: input.invoiceId, alreadyApplied: result.alreadyApplied, attempts })
  return { invoiceId: input.invoiceId, ...result, attempts }
}

const TRANSITION_AUDIT = {
  approve: AUDIT.SUPPLIER_INVOICE_APPROVED,
  post: AUDIT.SUPPLIER_INVOICE_POSTED,
  cancel: AUDIT.SUPPLIER_INVOICE_CANCELLED,
}

export async function transitionSupplierInvoice(deps, { uid, input, transition, requestId = null, segregation = null }) {
  const { db, now, log } = deps
  const rule = calc.INVOICE_TRANSITION[transition]
  let attempts = 0
  const result = await runGuarded(db, log, { uid, op: `invoice.${transition}` }, async (tx) => {
    attempts += 1
    const { scope } = await readCommon(tx, deps, uid, input.projectId)
    const invoiceRef = scope.invoices.doc(input.invoiceId)
    const live = withId(await tx.get(invoiceRef))
    if (!live) fail(CODE.NOT_FOUND)
    const claimSourced = live.source === calc.SI_SOURCE.PROGRESS_CLAIM && typeof live.progressClaimId === 'string' && live.progressClaimId !== ''
    const claimRef = claimSourced ? scope.claims.doc(live.progressClaimId) : null
    const [poSnap, claimSnap] = await Promise.all([
      live.poId && !claimSourced ? tx.get(scope.purchaseOrders.doc(live.poId)) : Promise.resolve(null),
      claimRef ? tx.get(claimRef) : Promise.resolve(null),
    ])
    const po = poSnap ? withId(poSnap) : null
    const claim = claimSnap ? withId(claimSnap) : null
    let approvalIndependent = null
    if (segregation) await segregation.read(tx, scope)
    if (live.status === rule.to && live[rule.by] === uid && live.revision === input.expectedRevision + 1) return { alreadyApplied: true }
    if (!rule.from.includes(live.status)) fail(CODE.SF_INVALID, { reason: 'transition', status: live.status ?? null })
    requireRevision(live, input.expectedRevision)
    if (transition !== 'cancel') {
      const stored = calc.invoiceStoredProblem({ invoice: live, po, claim })
      if (stored) failProblem(stored)
      if (transition === 'post') {
        const pairing = calc.postPairingProblem(live, claim)
        if (pairing) failProblem(pairing)
      }
      if (segregation && transition === 'approve') segregation.check(live)
      if (segregation && transition === 'post') {
        // Posting cannot change an approved invoice (no edit is admitted after
        // approval; the stored figures were just re-verified) — so a posting
        // that follows an INDEPENDENT approval needs no second checker. But an
        // approval given by a preparer (before the policy was enabled, or on a
        // legacy invoice) is not an independent approval: then the POSTER must
        // be independent, or posting would complete a single-person approval.
        const prepared = { createdBy: live.createdBy, lastMaterialEditBy: live.lastMaterialEditBy ?? live.createdBy }
        approvalIndependent = typeof live.approvedBy === 'string' && live.approvedBy !== '' && live.approvedBy !== prepared.createdBy && live.approvedBy !== prepared.lastMaterialEditBy
        if (!approvalIndependent) segregation.check(prepared)
      }
    }
    const stamp = FieldValue.serverTimestamp()
    tx.update(invoiceRef, { status: rule.to, [rule.at]: stamp, [rule.by]: uid, revision: (Number(live.revision) || 0) + 1, updatedAt: stamp, updatedBy: uid })
    let unlinked = false
    if (transition === 'cancel' && claim && calc.claimInvoiceLinkOf(claim).invoiceId === live.id) {
      tx.update(claimRef, { supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null, revision: (Number(claim.revision) || 0) + 1, updatedAt: stamp, updatedBy: uid })
      unlinked = true
    }
    auditInTx(tx, db, scope.companyId, {
      type: TRANSITION_AUDIT[transition], actorUid: uid, requestId,
      before: { status: live.status, revision: live.revision ?? null },
      after: {
        ...auditAfter(input.projectId, { ...live, status: rule.to, revision: (Number(live.revision) || 0) + 1 }, live.id), unlinkedClaim: unlinked,
        actor: { isCreator: live.createdBy === uid, isLastEditor: live.updatedBy === uid, isApprover: live.approvedBy === uid },
        segregation: segregation ? { ...segregation.record(), ...(transition === 'post' ? { approvalIndependent } : {}) } : null,
      },
    }, now())
    return { alreadyApplied: false, unlinked }
  }, () => attempts)
  log.info(`invoice ${transition}`, { uid, projectId: input.projectId, invoiceId: input.invoiceId, alreadyApplied: result.alreadyApplied, attempts })
  return { invoiceId: input.invoiceId, ...result, attempts }
}

export async function linkExistingInvoice(deps, { uid, input, requestId = null }) {
  const { db, now, log } = deps
  let attempts = 0
  const result = await runGuarded(db, log, { uid, op: 'invoice.link' }, async (tx) => {
    attempts += 1
    const { scope } = await readCommon(tx, deps, uid, input.projectId)
    const claimRef = scope.claims.doc(input.claimId)
    const [claimSnap, invoiceSnap] = await tx.getAll(claimRef, scope.invoices.doc(input.invoiceId))
    const claim = withId(claimSnap)
    const invoice = withId(invoiceSnap)
    if (claim && calc.claimInvoiceLinkOf(claim).invoiceId === input.invoiceId && claim.supplierInvoiceLinkedBy === uid && claim.revision === input.expectedClaimRevision + 1) return { alreadyApplied: true }
    const bad = calc.existingLinkProblem(claim, invoice)
    if (bad) failProblem(bad)
    requireRevision(claim, input.expectedClaimRevision)
    const stamp = FieldValue.serverTimestamp()
    tx.update(claimRef, claimLink(uid, input.invoiceId, claim, stamp))
    auditInTx(tx, db, scope.companyId, {
      type: AUDIT.SUPPLIER_INVOICE_LINKED, actorUid: uid, requestId, before: { claimRevision: claim.revision ?? null, link: claim.supplierInvoiceId ?? 'absent' },
      after: { projectId: input.projectId, claimId: claim.id, claimNumber: claim.claimNumber ?? null, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber ?? null },
    }, now())
    return { alreadyApplied: false }
  }, () => attempts)
  log.info('invoice link', { uid, projectId: input.projectId, claimId: input.claimId, alreadyApplied: result.alreadyApplied, attempts })
  return { claimId: input.claimId, invoiceId: input.invoiceId, ...result, attempts }
}
