import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { useProject } from './useProject'
import { stageProjectCurrencyLock } from './projectCurrencyLock'
import { resolveProjectCurrency } from '../lib/currency'
import {
  SI_STATUS, SI_DOC_TYPE, SI_SOURCE,
  canTransition, invoiceTotals, formatSupplierInvoiceNumber, claimHasActiveInvoice,
  claimReconciliationError,
  isEditableInvoice, isClaimSourced, buildInvoiceLine, invoiceLineInputCountError,
  validateInvoiceDraft, claimSourcedDriftError,
} from '../lib/supplierInvoices'

export function useSupplierInvoices(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  const [supplierInvoices, setSupplierInvoices]               = useState([])
  const [supplierInvoicesLoading, setSupplierInvoicesLoading] = useState(true)
  // True when the live read failed (connection loss or a rules rejection).
  // Consumers deriving financial figures must treat a failed read as
  // UNAVAILABLE — never as a genuine zero. Set only from the async snapshot
  // callbacks; existing consumers may ignore it.
  const [supplierInvoicesError, setSupplierInvoicesError]     = useState(false)

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD for records predating the
  // Company Country & Currency foundation.
  const projectCurrency = resolveProjectCurrency(project, company)

  useEffect(() => {
    if (!companyId || !projectId) {
      setSupplierInvoices([])
      setSupplierInvoicesLoading(false)
      return
    }

    setSupplierInvoicesLoading(true)
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setSupplierInvoices(snap.docs.map(d => ({ id: d.id, ...d.data() })))
        setSupplierInvoicesLoading(false)
        setSupplierInvoicesError(false)
      },
      () => {
        setSupplierInvoices([])
        setSupplierInvoicesLoading(false)
        setSupplierInvoicesError(true)
      }
    )
    return unsubscribe
  }, [companyId, projectId])

  // Creates a draft supplier invoice. The company-wide counter is read and
  // incremented in the same transaction as the invoice write, matching POs and
  // claims. The caller supplies supplier/PO/claim snapshots and built line items
  // (ex-GST amount + taxCode + gstAmount per line); totals are derived here.
  const createSupplierInvoice = useCallback(async ({
    source, supplierId, supplierName, poId, poNumber,
    progressClaimId, claimNumber, claimApprovedGst, claimApprovedTotal,
    supplierInvoiceNumber,
    invoiceDate, receivedDate, dueDate, paymentTerms,
    lineItems, retention, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    // One approved claim may carry only one non-cancelled supplier invoice.
    if (progressClaimId && claimHasActiveInvoice(supplierInvoices, progressClaimId)) {
      throw new Error('This progress claim already has an active supplier invoice')
    }

    const totals = invoiceTotals(lineItems, retention)
    // A claim-sourced invoice must pay exactly the approved claim's certified
    // GST and total — block creation if it does not reconcile.
    if (source === SI_SOURCE.PROGRESS_CLAIM) {
      const reconcileError = claimReconciliationError(totals, { approvedGst: claimApprovedGst, approvedTotal: claimApprovedTotal })
      if (reconcileError) throw new Error(reconcileError)
    }

    const counterRef  = doc(db, 'companies', companyId, 'counters', 'supplierInvoices')
    const invoiceRef  = doc(collection(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices'))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this invoice and the project lock succeed or fail
      // together — the project can never hold amounts with a still-changeable
      // currency. Firestore requires all transaction reads before any writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      tx.set(invoiceRef, {
        invoiceNumber:         formatSupplierInvoiceNumber(next),
        supplierInvoiceNumber: supplierInvoiceNumber?.trim() || '',
        status:                SI_STATUS.DRAFT,
        docType:               SI_DOC_TYPE.INVOICE,
        source,

        // Supplier identity — snapshot from the PO/claim, never re-read.
        supplierId:   supplierId ?? null,
        supplierName: (supplierName || '').trim(),

        // Source references.
        poId:            poId ?? null,
        poNumber:        poNumber ?? null,
        progressClaimId: progressClaimId ?? null,
        claimNumber:     claimNumber ?? null,

        // Dates and terms.
        invoiceDate:  invoiceDate  || '',
        receivedDate: receivedDate || '',
        dueDate:      dueDate      || '',
        paymentTerms: paymentTerms ?? null,

        // Money — ex-GST canonical, per-line GST. Gross describes the full
        // taxable supply; payable is what is due after retention (see
        // invoiceTotals). retentionGst keeps a claim-sourced invoice reconciled
        // to the approved claim's net-based GST.
        lineItems,
        retention:      totals.retention,
        retentionGst:   totals.retentionGst,
        retentionTotal: totals.retentionTotal,
        subtotal:       totals.subtotal,
        gstTotal:       totals.gstTotal,
        grossTotal:     totals.grossTotal,
        net:            totals.net,
        payableGst:     totals.payableGst,
        payableTotal:   totals.payableTotal,
        // Audit snapshot of the currency this document was raised in (the frozen
        // supplierName/costCodeName idiom). The PROJECT currency remains the
        // display authority — this field is never read for rendering, so a
        // project can never show mixed currencies. Historical documents keep
        // their stored 'AUD' and are never rewritten.
        currency:  projectCurrency,
        revision:  1,

        notes: notes?.trim() || '',

        // Audit stamps.
        approvedAt:  null,
        approvedBy:  null,
        postedAt:    null,
        postedBy:    null,
        cancelledAt: null,

        // ⚠️ paidAt is DEPRECATED IN PLACE (ADR-24), not reserved. It is written
        // once as null at creation and is NEVER updated — Supplier Payments
        // shipped without activating it, because payment state derives from
        // posted Supplier Payment allocations (lib/supplierPayments.js) and
        // setting a date here would create a second source of payment truth.
        // The write is kept so new documents keep the same shape as historical
        // ones; removing it would silently fork the schema for no benefit.
        //
        // adjustsInvoiceId / attachments / externalRefs remain genuinely
        // reserved for Credit Notes, Storage, and accounting sync.
        paidAt:          null,
        adjustsInvoiceId: null,
        attachments:      [],
        externalRefs:     {},

        createdAt: serverTimestamp(),
        createdBy: user.uid,
      })
      commitLock()
    })
    return invoiceRef.id
  }, [companyId, projectId, user, supplierInvoices, projectCurrency])

  // ── Draft-only edits (ADR-38) ──────────────────────────────────────────────
  //
  // Corrects a DRAFT supplier invoice in place. `approved` is the authoring
  // freeze point (`posted`, later, is the financial counting point), so this
  // refuses anything that is not still a draft. That guard, like every
  // immutability below, is CLIENT-SIDE ONLY — Firestore rules on this collection
  // check role and tenancy and nothing else (docs/SECURITY.md -> Deferred
  // Controls 1 and 2), so a direct-SDK caller can still rewrite an approved or
  // posted invoice.
  //
  // THE CALLER SUPPLIES NO LINE ITEMS. Every line is rebuilt over the STORED
  // document, which makes it the sole authority for line identity: poLineIndex,
  // costCodeId, costCodeName and description are structurally unwritable, and
  // `gstAmount` is always re-derived from the amount and tax code rather than
  // believed. The stored line SET is likewise fixed — there is no add, remove,
  // reorder or reseed channel, because poLineIndex is the identity
  // postedInvoicedByPoLine keys off to mature Committed.
  //
  // Nothing outside the authored set is written: invoiceNumber, status, docType,
  // source, supplier / PO / claim identity, paymentTerms, currency, revision,
  // every lifecycle stamp, paidAt, adjustsInvoiceId, attachments, externalRefs
  // and createdAt/createdBy are all absent from every payload below and survive
  // the partial updateDoc untouched.
  //
  // No transaction, no counter and no currency ratchet: no number is allocated,
  // and the project currency lock was already committed when the invoice was
  // created — re-staging it on an already-locked project would be REJECTED for a
  // `qs` user by the deliberately narrow rule on that field.
  const updateSupplierInvoice = useCallback(async (invoice, {
    supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, notes,
    amounts, taxCodes, retention,
  } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!isEditableInvoice(invoice)) throw new Error('Only draft supplier invoices can be edited')

    const storedLines = Array.isArray(invoice.lineItems) ? invoice.lineItems : []
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices', invoice.id)

    // The authored header — the only fields BOTH sources may change.
    const header = {
      supplierInvoiceNumber: supplierInvoiceNumber?.trim() || '',
      invoiceDate:  invoiceDate  || '',
      receivedDate: receivedDate || '',
      dueDate:      dueDate      || '',
      notes:        notes?.trim() || '',
    }

    // ── progress_claim: HEADER ONLY ──────────────────────────────────────────
    // The line amounts, tax codes and retention ARE the approved claim's
    // certified values, and the invoice must keep paying exactly the claim's
    // certified GST and total. That invariant is made structurally unbreakable
    // rather than merely validated: `amounts`, `taxCodes` and `retention` are
    // IGNORED here, and the payload carries no financial field at all — so no
    // caller, editor or otherwise, has a channel to move certified money.
    //
    // The rebuild below writes nothing. It exists only to prove the stored
    // document still reconciles with itself before a header correction is
    // allowed; a draft whose stored gstAmount disagrees with its own amount and
    // tax code (legacy or forged) is REFUSED with a clear message rather than
    // being mutated into agreement. No progress claim is read or modified.
    if (isClaimSourced(invoice)) {
      const lineItems = storedLines.map(li => buildInvoiceLine(li, { amount: li.amount, taxCode: li.taxCode }))
      const draftError = validateInvoiceDraft({
        lineItems,
        supplierInvoiceNumber,
        invoiceDate,
        retention:     invoice.retention,
        authoredLines: false,
      })
      if (draftError) throw new Error(draftError)
      const driftError = claimSourcedDriftError(invoice, invoiceTotals(lineItems, invoice.retention))
      if (driftError) throw new Error(driftError)
      await updateDoc(ref, header)
      return
    }

    // ── direct_po: header + per-line amount / tax code + retention ───────────
    // Exact positional pairing — one amount and one tax code per STORED line, in
    // stored order. A mismatch would silently pair authored values with the wrong
    // lines, so nothing is written.
    const countError = invoiceLineInputCountError(storedLines, amounts, taxCodes)
    if (countError) throw new Error(countError)

    const lineItems = storedLines.map((li, idx) =>
      buildInvoiceLine(li, { amount: amounts[idx], taxCode: taxCodes[idx] })
    )
    const draftError = validateInvoiceDraft({ lineItems, supplierInvoiceNumber, invoiceDate, retention })
    if (draftError) throw new Error(draftError)

    const totals = invoiceTotals(lineItems, retention)
    await updateDoc(ref, {
      ...header,
      lineItems,
      retention:      totals.retention,
      retentionGst:   totals.retentionGst,
      retentionTotal: totals.retentionTotal,
      subtotal:       totals.subtotal,
      gstTotal:       totals.gstTotal,
      grossTotal:     totals.grossTotal,
      net:            totals.net,
      payableGst:     totals.payableGst,
      payableTotal:   totals.payableTotal,
    })
  }, [companyId, projectId, user])

  // Lifecycle transitions. approve/post carry the acting user; all stamp a
  // timestamp. Posting is the financial commit point and is terminal here —
  // posted invoices cannot be cancelled or unposted (corrections use Credit
  // Notes, a future module). Legality is client-checked (server enforcement
  // is deferred, matching POs/claims).
  const transitionStatus = useCallback(async (invoice, nextStatus) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(invoice.status, nextStatus)) {
      throw new Error(`Cannot move a ${invoice.status} supplier invoice to ${nextStatus}`)
    }
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices', invoice.id)
    const extra =
      nextStatus === SI_STATUS.APPROVED  ? { approvedAt: serverTimestamp(), approvedBy: user.uid } :
      nextStatus === SI_STATUS.POSTED    ? { postedAt:   serverTimestamp(), postedBy:   user.uid } :
      nextStatus === SI_STATUS.CANCELLED ? { cancelledAt: serverTimestamp() } :
      {}
    await updateDoc(ref, { status: nextStatus, ...extra })
  }, [companyId, projectId, user])

  return { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError, createSupplierInvoice, updateSupplierInvoice, transitionStatus }
}
