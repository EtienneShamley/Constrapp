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
} from '../lib/supplierInvoices'

export function useSupplierInvoices(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  const [supplierInvoices, setSupplierInvoices]               = useState([])
  const [supplierInvoicesLoading, setSupplierInvoicesLoading] = useState(true)

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
      },
      () => {
        setSupplierInvoices([])
        setSupplierInvoicesLoading(false)
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

        // Reserved for future modules (Payments, Credit Notes, Storage, accounting).
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

  // Draft-only edits — everything freezes once an invoice leaves draft.
  const updateSupplierInvoice = useCallback(async (invoice, { supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, lineItems, retention, notes }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (invoice.status !== SI_STATUS.DRAFT) throw new Error('Only draft supplier invoices can be edited')
    const ref    = doc(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices', invoice.id)
    const totals = invoiceTotals(lineItems, retention)
    await updateDoc(ref, {
      supplierInvoiceNumber: supplierInvoiceNumber?.trim() || '',
      invoiceDate:  invoiceDate  || '',
      receivedDate: receivedDate || '',
      dueDate:      dueDate      || '',
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
      notes:     notes?.trim() || '',
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

  return { supplierInvoices, supplierInvoicesLoading, createSupplierInvoice, updateSupplierInvoice, transitionStatus }
}
