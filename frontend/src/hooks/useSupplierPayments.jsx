import { useEffect, useState, useCallback } from 'react'
import { collection, doc, onSnapshot, query, orderBy } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { SF_CALLABLE, SF_CALL_TIMEOUT_MS, runSupplierFinance } from '../lib/supplierFinanceActions'
import { PAYMENT_STATUS, PAYMENT_METHOD, canTransition } from '../lib/payments'

// ADR-94: supplier payments are created, edited, posted and voided only by the
// supplier-finance backend, which moves the invoice ledger(s) on posting and
// voiding. Firestore Rules admit no client write to the collection.
const callSupplierFinance = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: SF_CALL_TIMEOUT_MS })(data)).data
const revisionOf = (doc) => (Number.isSafeInteger(doc?.revision) ? doc.revision : 0)
const cents2 = (v) => Math.round((Number(v) || 0) * 100) / 100
const settle = (operation, request) => runSupplierFinance(callSupplierFinance, SF_CALLABLE.SETTLEMENT, operation, request)
export function useSupplierPayments(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()

  const companyId = company?.id ?? null


  // Live subscription state, tagged with the target (`key`) it belongs to. The
  // effect is subscription-only: state is written ONLY from the onSnapshot
  // callbacks, never synchronously in the effect body, so loading/error are
  // derived at render time below (matching useClientReceipts).
  const [snap, setSnap] = useState({ key: null, payments: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'supplierPayments')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        payments: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully rather than crashing the page.
      () => setSnap({ key, payments: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const supplierPayments = settled ? snap.payments : []
  const supplierPaymentsLoading = targetKey !== null && !settled
  const supplierPaymentsError = settled ? snap.error : false

  // A payment's allocations are capped by what remains payable on each
  // invoice (Deferred Control 18, ADR-94): cash paid beyond that is recorded
  // as the payment's unallocated amount. The backend checks every allocation
  // against the invoice ledger when the draft is saved and again — the
  // authoritative check — when it is posted.
  const paymentRequest = (paymentId, expectedRevision, data) => ({
    projectId, paymentId, expectedRevision, supplierId: data.supplierId, paymentDate: data.paymentDate || '',
    amount: cents2(data.amount), paymentMethod: data.paymentMethod,
    paymentMethodOther: data.paymentMethod === PAYMENT_METHOD.OTHER ? String(data.paymentMethodOther ?? '').trim() : '',
    bankReference: String(data.bankReference ?? '').trim(), remittanceReference: String(data.remittanceReference ?? '').trim(),
    externalReference: String(data.externalReference ?? '').trim(), notes: String(data.notes ?? '').trim(),
    allocations: (data.allocations ?? []).map(a => ({ supplierInvoiceId: a.supplierInvoiceId, allocatedAmount: cents2(a.allocatedAmount) })),
  })

  const createSupplierPayment = useCallback(async (data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const id = data.paymentId ?? doc(collection(db, 'companies', companyId, 'projects', projectId, 'supplierPayments')).id
    const out = await settle('savePayment', paymentRequest(id, null, data))
    return out.id
  }, [companyId, projectId, user]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateSupplierPayment = useCallback(async (payment, data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (payment.status !== PAYMENT_STATUS.DRAFT) throw new Error('Only draft payments can be edited')
    return settle('savePayment', paymentRequest(payment.id, revisionOf(payment), data))
  }, [companyId, projectId, user]) // eslint-disable-line react-hooks/exhaustive-deps

  const postSupplierPayment = useCallback(async (payment) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(payment.status, PAYMENT_STATUS.POSTED)) throw new Error(`Cannot post a ${payment.status} payment`)
    return settle('postPayment', { projectId, documentId: payment.id, expectedRevision: revisionOf(payment) })
  }, [companyId, projectId, user])

  // Voiding corrects a payment recorded in error — it is not a refund.
  const voidSupplierPayment = useCallback(async (payment, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(payment.status, PAYMENT_STATUS.VOID)) throw new Error(`Cannot void a ${payment.status} payment`)
    const reason = String(voidReason ?? '').trim()
    if (!reason) throw new Error('Enter a reason for voiding this payment')
    return settle('voidPayment', { projectId, documentId: payment.id, expectedRevision: revisionOf(payment), voidReason: reason })
  }, [companyId, projectId, user])

  return {
    supplierPayments,
    supplierPaymentsLoading,
    supplierPaymentsError,
    createSupplierPayment,
    updateSupplierPayment,
    postSupplierPayment,
    voidSupplierPayment,
  }
}
