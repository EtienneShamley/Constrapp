import { FieldValue } from '../lib/firebaseAdmin.js'
import { createdEditorStamp, editorStamp } from '../lib/approvalPolicy.js'
import { CODE, fail } from '../lib/errors.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import * as calc from '../generated/supplierFinanceCalc.js'
import {
  runGuarded, withId, cents, callerScope, requireBaseline, nextNumber, invoiceLedgerEntry, writeInvoiceLedger,
  failProblem, requireRevision,
} from './context.js'

// ── Supplier settlement: credit notes, retention releases, payments (ADR-94) ─
//
// Drafts are created and edited here (their figures previewed against the
// invoice ledger); POSTING and VOIDING move the invoice ledger(s) in the same
// transaction and write one audit event. A posting re-derives the draft's
// figures against the ledger AS IT STANDS and refuses when they moved
// (`supplier-finance-figures-moved`: save again, review, post) — so what is
// posted is what was reviewed, and what the ledger accepts.
//
// Reads per operation (fixed sets):
//   credit / release   membership, company, project, marker, document, its
//                      invoice, that invoice's ledger (+ counter on create);
//   payment            membership, company, project, marker, document, the
//                      supplier contact, and per allocation its invoice and
//                      ledger — at most MAX_ALLOCATIONS (100) of each.
// Writes: the document, the ledger(s) on post / void, one audit event on post
// / void, the counter and currency lock on create. A payment posting writes at
// most 100 ledgers + 3 documents — far inside a transaction's 500.
//
// CONTENTION: each invoice ledger serialises the postings and voids against
// that invoice — exactly the operations whose caps interact. A payment
// allocated across many invoices contends on each of them.

const KIND = {
  credit: {
    collection: 'credits', numberField: 'creditNumber', format: calc.formatSupplierCreditNoteNumber,
    cosmetic: ['notes', 'supplierCreditReference'],
    counter: calc.SETTLEMENT_COUNTER_ID.credit, posted: calc.SCN_STATUS.POSTED, void: calc.SCN_STATUS.VOID, draft: calc.SCN_STATUS.DRAFT,
    postAudit: AUDIT.SUPPLIER_CREDIT_POSTED, voidAudit: AUDIT.SUPPLIER_CREDIT_VOIDED,
  },
  release: {
    collection: 'releases', numberField: 'releaseNumber', format: calc.formatRetentionReleaseNumber,
    cosmetic: ['notes'],
    counter: calc.SETTLEMENT_COUNTER_ID.release, posted: calc.RR_STATUS.POSTED, void: calc.RR_STATUS.VOID, draft: calc.RR_STATUS.DRAFT,
    postAudit: AUDIT.RETENTION_RELEASE_POSTED, voidAudit: AUDIT.RETENTION_RELEASE_VOIDED,
  },
  payment: {
    collection: 'payments', numberField: 'paymentNumber', format: calc.formatSupplierPaymentNumber,
    cosmetic: ['notes', 'bankReference', 'remittanceReference', 'externalReference'],
    counter: calc.SETTLEMENT_COUNTER_ID.payment, posted: calc.PAYMENT_STATUS.POSTED, void: calc.PAYMENT_STATUS.VOID, draft: calc.PAYMENT_STATUS.DRAFT,
    postAudit: AUDIT.SUPPLIER_PAYMENT_POSTED, voidAudit: AUDIT.SUPPLIER_PAYMENT_VOIDED,
  },
}

async function readCommon(tx, deps, uid, projectId) {
  const scope = await callerScope(tx, deps.db, uid, projectId)
  const [companySnap, projectSnap, markerSnap] = await tx.getAll(scope.companyRef, scope.projectRef, scope.baselineRef)
  if (!companySnap.exists || !projectSnap.exists) fail(CODE.NOT_FOUND)
  requireBaseline(markerSnap)
  return { scope, companySnap, projectSnap }
}

const documentId = (kind, input) => (kind === 'credit' ? input.creditNoteId : kind === 'release' ? input.releaseId : input.paymentId)

// ── Drafts (create / update) ─────────────────────────────────────────────────

export async function saveSettlementDraft(deps, { uid, input, kind }) {
  const { db, log } = deps
  const k = KIND[kind]
  const id = documentId(kind, input)
  const creating = input.expectedRevision === null
  let attempts = 0
  const result = await runGuarded(db, log, { uid, op: `${kind}.${creating ? 'create' : 'update'}` }, async (tx) => {
    attempts += 1
    const { scope, companySnap, projectSnap } = await readCommon(tx, deps, uid, input.projectId)
    const ref = scope[k.collection].doc(id)
    const counterRef = scope.companyRef.collection('counters').doc(k.counter)
    const [docSnap, counterSnap] = await tx.getAll(ref, counterRef)
    const live = withId(docSnap)
    const stamp = FieldValue.serverTimestamp()
    const project = withId(projectSnap)
    const currency = calc.resolveProjectCurrency(project, withId(companySnap))

    // The sources: the target invoice and its ledger, or the supplier and every
    // allocated invoice with its ledger.
    let built
    if (kind === 'payment') {
      const ids = input.allocations.map(a => a.supplierInvoiceId)
      const snaps = ids.length > 0 ? await tx.getAll(...ids.flatMap(i => [scope.invoices.doc(i), scope.invoiceLedgers.doc(i)])) : []
      const supplier = withId(await tx.get(scope.companyRef.collection('contacts').doc(input.supplierId)))
      const invoices = new Map()
      const ledgers = new Map()
      ids.forEach((i, n) => {
        const inv = withId(snaps[2 * n])
        if (inv) invoices.set(i, inv)
        ledgers.set(i, invoiceLedgerEntry(snaps[2 * n + 1]))
      })
      const fields = calc.buildPaymentFields({ input, supplier, invoices, ledgers })
      if (fields.problem) failProblem(fields)
      built = creating
        ? { document: calc.buildPaymentDraft({ fields: fields.fields, paymentNumber: null, currency, uid, now: stamp }) }
        : { update: { ...fields.fields, revision: (Number(live?.revision) || 0) + 1, updatedAt: stamp, updatedBy: uid } }
    } else {
      const invoiceId = creating ? input.supplierInvoiceId : (live?.supplierInvoiceId ?? input.supplierInvoiceId)
      const [invoiceSnap, ledgerSnap] = await tx.getAll(scope.invoices.doc(invoiceId), scope.invoiceLedgers.doc(invoiceId))
      const invoice = withId(invoiceSnap)
      const ledgerEntry = invoiceLedgerEntry(ledgerSnap)
      if (kind === 'credit') {
        built = creating
          ? calc.buildCreditDraft({ input, invoice, ledgerEntry, creditNumber: null, uid, now: stamp })
          : (live ? calc.buildCreditDraftUpdate({ input, live, invoice, ledgerEntry, uid, now: stamp }) : null)
      } else {
        built = creating
          ? calc.buildReleaseDraft({ input, invoice, ledgerEntry, releaseNumber: null, currency, uid, now: stamp })
          : (live ? calc.buildReleaseDraftUpdate({ input, live, invoice, ledgerEntry, uid, now: stamp }) : null)
      }
    }

    if (creating) {
      if (live) {
        if (live.createdBy !== uid) fail(CODE.SF_ID_CONFLICT)
        return { alreadyApplied: true, number: live[k.numberField] ?? null }
      }
      if (built?.problem) failProblem(built)
      const next = nextNumber(counterSnap)
      const document = { ...built.document, [k.numberField]: k.format(next), ...createdEditorStamp(uid) }
      tx.set(counterRef, { next: next + 1 }, { merge: true })
      tx.create(ref, document)
      if (project.currencyLocked !== true) tx.update(scope.projectRef, { currencyLocked: true }, { lastUpdateTime: projectSnap.updateTime })
      return { alreadyApplied: false, number: document[k.numberField] }
    }
    if (!live) fail(CODE.NOT_FOUND)
    if (built && !built.problem && live.updatedBy === uid && live.revision === input.expectedRevision + 1
      && Object.entries(built.update).every(([key, v]) => ['revision', 'updatedAt', 'updatedBy'].includes(key) || JSON.stringify(live[key] ?? null) === JSON.stringify(v ?? null))) {
      return { alreadyApplied: true, number: live[k.numberField] ?? null }
    }
    if (live.status !== k.draft) fail(CODE.SF_INVALID, { reason: 'not-draft', status: live.status ?? null })
    requireRevision(live, input.expectedRevision)
    if (built?.problem) failProblem(built)
    tx.update(ref, { ...built.update, ...editorStamp(live, uid, built.update, k.cosmetic) })
    return { alreadyApplied: false, number: live[k.numberField] ?? null }
  }, () => attempts)
  log.info(`${kind} draft`, { uid, projectId: input.projectId, id, creating, alreadyApplied: result.alreadyApplied, attempts })
  return { id, ...result, attempts }
}

// ── Post / void ──────────────────────────────────────────────────────────────

const auditFigures = (kind, d) => (kind === 'credit'
  ? { subtotalCents: cents(d.subtotal), gstCents: cents(d.gstTotal), grossCents: cents(d.grossTotal), retentionCents: cents(d.retentionAmount ?? 0), retentionGstCents: cents(d.retentionGst ?? 0), supplierInvoiceId: d.supplierInvoiceId }
  : kind === 'release'
    ? { amountCents: cents(d.amount), gstCents: cents(d.gstAmount), releaseTotalCents: cents(d.releaseTotal), supplierInvoiceId: d.supplierInvoiceId }
    : { amountCents: cents(d.amount), allocatedCents: cents(d.allocatedTotal), unallocatedCents: cents(d.unallocatedAmount), allocations: (d.allocations ?? []).map(a => ({ supplierInvoiceId: a.supplierInvoiceId, cents: cents(a.allocatedAmount) })) })

export async function settleDocument(deps, { uid, input, kind, action, requestId = null, segregation = null }) {
  const { db, now, log } = deps
  const k = KIND[kind]
  const posting = action === 'post'
  let attempts = 0
  const result = await runGuarded(db, log, { uid, op: `${kind}.${action}` }, async (tx) => {
    attempts += 1
    const { scope } = await readCommon(tx, deps, uid, input.projectId)
    const ref = scope[k.collection].doc(input.documentId)
    const live = withId(await tx.get(ref))
    if (!live) fail(CODE.NOT_FOUND)

    // The invoices and ledgers this document moves.
    const invoiceIds = kind === 'payment'
      ? [...new Set((Array.isArray(live.allocations) ? live.allocations : []).map(a => a?.supplierInvoiceId).filter(i => typeof i === 'string' && i))]
      : (typeof live.supplierInvoiceId === 'string' && live.supplierInvoiceId ? [live.supplierInvoiceId] : [])
    const snaps = invoiceIds.length > 0 ? await tx.getAll(...invoiceIds.flatMap(i => [scope.invoices.doc(i), scope.invoiceLedgers.doc(i)])) : []
    const invoices = new Map()
    const ledgers = new Map()
    invoiceIds.forEach((i, n) => {
      const inv = withId(snaps[2 * n])
      if (inv) invoices.set(i, inv)
      ledgers.set(i, invoiceLedgerEntry(snaps[2 * n + 1]))
    })
    if (segregation) await segregation.read(tx, scope)

    const target = posting ? k.posted : k.void
    const byField = posting ? 'postedBy' : 'voidedBy'
    if (live.status === target && live[byField] === uid && live.revision === input.expectedRevision + 1) return { alreadyApplied: true }
    if (live.status !== (posting ? k.draft : k.posted)) fail(CODE.SF_INVALID, { reason: 'transition', status: live.status ?? null })
    requireRevision(live, input.expectedRevision)
    // Posting: the D4 preparers. Voiding: the creator and last material editor,
    // named explicitly — after posting, `updatedBy` is the poster, who may void.
    if (segregation) segregation.check(posting ? live : { createdBy: live.createdBy, lastMaterialEditBy: live.lastMaterialEditBy ?? live.createdBy })

    let moved
    if (kind === 'payment') {
      moved = posting
        ? calc.paymentPosting({ live, invoices, ledgers, nowMillis: deps.clock ? deps.clock() : Date.now() })
        : calc.paymentVoiding({ live, ledgers })
      if (moved.problem) failProblem(moved)
    } else {
      const invoice = invoices.get(invoiceIds[0]) ?? null
      const ledgerEntry = ledgers.get(invoiceIds[0]) ?? { state: 'established', ledger: calc.emptySupplierLedger() }
      if (!invoice) fail(CODE.SF_INVALID, { reason: 'invoice-missing' })
      const step = kind === 'credit'
        ? (posting ? calc.creditPosting : calc.creditVoiding)
        : (posting ? calc.releasePosting : calc.releaseVoiding)
      const one = step({ live, invoice, ledgerEntry })
      if (one.problem) failProblem(one)
      moved = { ledgers: new Map([[invoiceIds[0], one.ledger]]) }
    }

    const stamp = FieldValue.serverTimestamp()
    tx.update(ref, posting
      ? { status: target, postedAt: stamp, postedBy: uid, revision: (Number(live.revision) || 0) + 1, updatedAt: stamp, updatedBy: uid }
      : { status: target, voidedAt: stamp, voidedBy: uid, voidReason: input.voidReason.trim(), revision: (Number(live.revision) || 0) + 1, updatedAt: stamp, updatedBy: uid })
    for (const [invoiceId, ledger] of moved.ledgers) {
      // An inconsistent ledger is established again ONLY when the state it now
      // holds passes every invariant, its invoice reconciles, and no malformed
      // historical entry is still posted against it. A posting never runs on
      // an inconsistent ledger (usableLedger), so only a void reaches here
      // with `wasInconsistent`.
      const before = ledgers.get(invoiceId)
      const invoice = invoices.get(invoiceId)
      const figures = invoice ? calc.supplierInvoiceFigures(invoice) : null
      const malformedEntryIds = (before?.malformedEntryIds ?? []).filter(i => posting || i !== live.id)
      const stillBad = !figures || figures.problem ? (figures?.problem ?? 'The invoice does not exist.')
        : (calc.supplierLedgerProblem(figures, ledger)
          ?? (before?.malformedOverflow ? 'More malformed historical entries than can be tracked are posted against this invoice; it needs review.' : null)
          ?? (malformedEntryIds.length > 0 ? `A malformed historical entry is still posted against this invoice (${malformedEntryIds.length}); void it to restore the ledger.` : null))
      const wasInconsistent = before?.state === 'inconsistent'
      writeInvoiceLedger(tx, scope.invoiceLedgers.doc(invoiceId), ledger, {
        now: stamp, invoiceId, malformedEntryIds,
        state: wasInconsistent && stillBad ? 'inconsistent' : 'established',
        problem: wasInconsistent && stillBad ? stillBad : null,
      })
    }
    auditInTx(tx, db, scope.companyId, {
      type: posting ? k.postAudit : k.voidAudit, actorUid: uid, requestId,
      before: { status: live.status, revision: live.revision ?? null },
      after: {
        projectId: input.projectId, documentId: live.id, number: live[k.numberField] ?? null, status: target,
        ...auditFigures(kind, live), ...(posting ? {} : { voidReason: input.voidReason.trim(), correction: 'record-voided-not-a-cash-reversal' }),
        actor: { isCreator: live.createdBy === uid, isLastEditor: live.updatedBy === uid, isLastMaterialEditor: (live.lastMaterialEditBy ?? live.updatedBy) === uid },
        segregation: segregation ? segregation.record() : null,
      },
    }, now())
    return { alreadyApplied: false }
  }, () => attempts)
  log.info(`${kind} ${action}`, { uid, projectId: input.projectId, id: input.documentId, alreadyApplied: result.alreadyApplied, attempts })
  return { id: input.documentId, ...result, attempts }
}
