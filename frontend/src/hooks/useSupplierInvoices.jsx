import { useEffect, useState, useCallback, useMemo } from 'react'
import { collection, doc, onSnapshot, query, orderBy } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { SI_STATUS, SI_SOURCE, canTransition, claimHasActiveInvoice, retentionFloorError, isEditableInvoice, isClaimSourced } from '../lib/supplierInvoices'
import { isClaimInvoiceable } from '../lib/progressClaims'
import { SupplierInvoiceWriteError, SI_WRITE_ERROR } from '../lib/supplierInvoiceActions'
import { SF_CALLABLE, SF_CALL_TIMEOUT_MS, runSupplierFinance, claimLineIndexOf } from '../lib/supplierFinanceActions'

// ADR-93: a supplier invoice is created, its draft edited, approved, posted and
// cancelled only by the supplier-finance backend. Firestore Rules admit no
// client write to the collection.
const callSupplierFinance = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: SF_CALL_TIMEOUT_MS })(data)).data

const revisionOf = (doc) => (Number.isSafeInteger(doc?.revision) ? doc.revision : 0)
const header = ({ supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, notes }) => ({
  supplierInvoiceNumber: String(supplierInvoiceNumber ?? '').trim(), invoiceDate: invoiceDate || '',
  receivedDate: receivedDate || '', dueDate: dueDate || '', notes: String(notes ?? '').trim(),
})
const cents2 = (v) => Math.round((Number(v) || 0) * 100) / 100

export function useSupplierInvoices(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, so
  // supplierInvoices/loading/error are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // `error` is true when the live read failed (connection loss or a rules
  // rejection). Consumers deriving financial figures MUST treat a failed read
  // as UNAVAILABLE — never as a genuine zero. It is exposed only once the
  // CURRENT target has settled, so a project switch never flashes a stale
  // unavailable banner under the new project.
  const [snap, setSnap] = useState({ key: null, supplierInvoices: [], error: false })

  const companyId = company?.id ?? null


  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        supplierInvoices: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read must NOT look like an empty register — "none" and "we
      // could not load them" are opposite facts, and confusing them on a
      // financial register fabricates a zero.
      () => setSnap({ key, supplierInvoices: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no data, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // hides the previous project's rows immediately.
  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  // Memoised so the write callbacks below (which validate against the live
  // list) keep stable dependencies across renders.
  const supplierInvoices = useMemo(
    () => (settled ? snap.supplierInvoices : []),
    [settled, snap.supplierInvoices],
  )
  const supplierInvoicesLoading = targetKey !== null && !settled
  const supplierInvoicesError = settled ? snap.error : false

  // Creates a draft supplier invoice (ADR-93). A DIRECT invoice names the
  // purchase-order line of each priced line with its amount and tax code; a
  // CLAIM-SOURCED invoice names the claim line of each certified line with its
  // tax code only — the amounts, the retention and the payable GST and total
  // are the claim's certified figures, and the backend pairs the invoice with
  // the claim (ADR-68) in the same transaction. The checks below are the UX
  // fast-path; the backend decides.
  const createSupplierInvoice = useCallback(async ({
    source, poId, claim = null, progressClaimId,
    supplierInvoiceNumber, invoiceDate, receivedDate, dueDate,
    lineItems, retention, notes, invoiceId = null,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (progressClaimId && claimHasActiveInvoice(supplierInvoices, progressClaimId)) {
      throw new Error('This progress claim already has an active supplier invoice')
    }
    const claimSourced = source === SI_SOURCE.PROGRESS_CLAIM
    if (claimSourced) {
      if (!claim?.id || claim.id !== progressClaimId) throw new Error('Select the approved progress claim this invoice is raised from.')
      if (!isClaimInvoiceable(claim)) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.LEGACY_UNRECONCILED)
    } else {
      const retentionError = retentionFloorError(retention)
      if (retentionError) throw new Error(retentionError)
    }
    const lines = (lineItems ?? []).map(li => (claimSourced
      ? { lineIndex: claimLineIndexOf(claim, li), amount: null, taxCode: li.taxCode }
      : { lineIndex: li.poLineIndex, amount: cents2(li.amount), taxCode: li.taxCode }))
    if (lines.some(l => !Number.isInteger(l.lineIndex) || l.lineIndex < 0)) throw new Error('An invoice line no longer matches its source line. Close the editor and start again.')
    const id = invoiceId ?? doc(collection(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices')).id
    const out = await runSupplierFinance(callSupplierFinance, SF_CALLABLE.INVOICE, 'create', {
      projectId, invoiceId: id, source, sourceId: claimSourced ? claim.id : poId,
      expectedSourceRevision: claimSourced ? revisionOf(claim) : null,
      ...header({ supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, notes }),
      retention: claimSourced ? null : cents2(retention), lines,
    })
    return out.invoiceId
  }, [companyId, projectId, user, supplierInvoices])

  // Draft-only edit (ADR-38 contract, ADR-93 authority). A claim-sourced draft
  // is corrected on its header only; a direct draft names one amount and tax
  // code per STORED line, in stored order, and the backend re-derives the
  // lines and totals (calculation version 2). The revision is the one the
  // editor was OPENED on.
  const updateSupplierInvoice = useCallback(async (invoice, {
    supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, notes,
    amounts, taxCodes, retention,
  } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!isEditableInvoice(invoice)) throw new Error('Only draft supplier invoices can be edited')
    const claimSourced = isClaimSourced(invoice)
    const stored = Array.isArray(invoice.lineItems) ? invoice.lineItems : []
    return runSupplierFinance(callSupplierFinance, SF_CALLABLE.INVOICE, 'update', {
      projectId, invoiceId: invoice.id, expectedRevision: revisionOf(invoice),
      ...header({ supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, notes }),
      retention: claimSourced ? null : cents2(retention),
      lines: claimSourced ? null : stored.map((_, i) => ({ lineIndex: i, amount: cents2(amounts?.[i]), taxCode: taxCodes?.[i] })),
    })
  }, [companyId, projectId, user])

  // Lifecycle transitions — approve (authoring freeze), post (the financial
  // counting point) and cancel — each verified by the backend under the
  // invoice's own calculation version (ADR-93). Cancelling a claim-sourced
  // invoice its claim links unlinks the claim in the same commit (ADR-68).
  const transitionStatus = useCallback(async (invoice, nextStatus) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(invoice.status, nextStatus)) {
      throw new Error(`Cannot move a ${invoice.status} supplier invoice to ${nextStatus}`)
    }
    const operation = nextStatus === SI_STATUS.APPROVED ? 'approve' : nextStatus === SI_STATUS.POSTED ? 'post' : nextStatus === SI_STATUS.CANCELLED ? 'cancel' : null
    if (!operation) throw new Error(`A move to ${nextStatus} has no application path.`)
    return runSupplierFinance(callSupplierFinance, SF_CALLABLE.INVOICE, operation, { projectId, invoiceId: invoice.id, expectedRevision: revisionOf(invoice) })
  }, [companyId, projectId, user])

  return { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError, createSupplierInvoice, updateSupplierInvoice, transitionStatus }
}
