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
import { roundMoney } from '../lib/purchaseOrders'
import { PAYMENT_STATUS, PAYMENT_METHOD, canTransition, allocationTotals } from '../lib/payments'
import {
  SP_DOC_TYPE, SUPPLIER_PAYMENT_COUNTER_ID,
  formatSupplierPaymentNumber, validatePaymentDraft, postBlockedReason,
} from '../lib/supplierPayments'

// ── Supplier Payments (accounts payable — money OUT) ──────────────────────────
//
// Records cash actually paid to a supplier or subcontractor, with embedded
// allocations against POSTED Supplier Invoices. Reads are restricted to internal
// financial roles by Firestore rules.
//
// This hook writes ONLY supplier payment documents (plus the company-wide
// counter and the project currency ratchet, both inside the create
// transaction). It NEVER mutates supplier invoices, purchase orders, progress
// claims, budget lines, variations, forecast lines, the commercial baseline,
// client invoices, or client receipts — every reconciliation figure is derived
// at read time in lib/supplierPayments.js.
//
// In particular it NEVER writes `status: 'paid'`, `paidAt`, a balance field, or
// a payment back-reference onto a supplier invoice (ADR-24).
//
// LIFECYCLE NOTE. Like clientInvoices and clientReceipts (and unlike the older
// collections), the payment lifecycle is ALSO enforced by Firestore rules:
// create is draft-only, draft edits cannot rewrite the payment number/currency/
// creation stamps, posting and voiding may touch only their own audit fields,
// and a posted payment is otherwise immutable. The checks below are the UX
// mirror — the rules are the boundary.
export function useSupplierPayments(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD.
  const projectCurrency = resolveProjectCurrency(project, company)

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

  // Creates a DRAFT supplier payment. The company-wide counter is read and
  // incremented in the same transaction as the payment write (ADR-5), and the
  // project currency ratchet is staged in the same transaction (ADR-21) — a
  // payment is monetary data, so the record and the lock must commit or roll
  // back together. A failed create therefore consumes no number, writes no
  // payment, and locks no currency.
  //
  // The caller supplies the frozen supplier snapshot and built allocations
  // (supplierInvoiceId + frozen invoiceNumber + frozen supplierInvoiceNumber +
  // allocatedAmount); the allocated and unallocated totals are derived here so a
  // caller can never write one without the other.
  const createSupplierPayment = useCallback(async ({
    supplierId, supplierName,
    paymentDate, amount,
    paymentMethod, paymentMethodOther,
    bankReference, remittanceReference, externalReference,
    allocations, notes,
    invoices = null,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validatePaymentDraft({
      supplierId, supplierName, paymentDate, amount,
      paymentMethod, paymentMethodOther, allocations, invoices,
    })
    if (validationError) throw new Error(validationError)

    const cash   = roundMoney(Number(amount))
    const totals = allocationTotals(cash, allocations)

    const counterRef = doc(db, 'companies', companyId, 'counters', SUPPLIER_PAYMENT_COUNTER_ID)
    const paymentRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'supplierPayments'))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this payment and the project lock succeed or fail
      // together. Firestore requires all transaction reads before any writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      tx.set(paymentRef, {
        paymentNumber: formatSupplierPaymentNumber(next),
        status:        PAYMENT_STATUS.DRAFT,
        docType:       SP_DOC_TYPE.PAYMENT,

        // Supplier identity — FROZEN at creation so later contact edits never
        // rewrite the cash record. Both are REQUIRED non-empty (rules-enforced):
        // a payment made to nobody is not a record. Unlike supplier INVOICES,
        // which may carry a legacy `supplierId: null`, a new payment never can.
        supplierId,
        supplierName: (supplierName || '').trim(),

        // The date the money LEFT THE ACCOUNT — a calendar date off a bank
        // statement, stored as 'YYYY-MM-DD' like every other financial date in
        // the app. This, never createdAt/postedAt, is what the future Cash Flow
        // module consumes as the date cash moved.
        paymentDate,

        // Actual GROSS cash paid. No GST, no tax code, no net amount: a cash
        // movement is not a new taxable supply, and the tax was already recorded
        // on the supplier invoice being settled.
        amount: cash,

        paymentMethod,
        paymentMethodOther:  paymentMethod === PAYMENT_METHOD.OTHER ? (paymentMethodOther || '').trim() : '',
        bankReference:       (bankReference || '').trim(),
        remittanceReference: (remittanceReference || '').trim(),
        externalReference:   (externalReference || '').trim(),

        // Embedded allocations (ADR-6 idiom) freezing BOTH invoice references —
        // Constrapp's SI-#### and the supplier's own number — so a register row
        // renders without reading invoice documents. NOTHING is written onto the
        // invoices themselves.
        allocations,
        allocatedTotal:    totals.allocatedTotal,
        unallocatedAmount: totals.unallocatedAmount,

        // Audit snapshot of the currency this payment was made in. The PROJECT
        // currency remains the display authority — this field is never read for
        // rendering, so a project can never show mixed currencies.
        currency: projectCurrency,
        revision: 1,

        notes: (notes || '').trim(),

        // Lifecycle audit stamps. Rules require these to be null at create.
        postedAt:   null,
        postedBy:   null,
        voidedAt:   null,
        voidedBy:   null,
        voidReason: '',

        // Reserved for future modules (refunds, Storage, accounting sync).
        attachments:  [],
        externalRefs: {},

        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
      commitLock()
    })
    return paymentRef.id
  }, [companyId, projectId, user, projectCurrency])

  // Draft-only edits. The payment number, currency, docType, revision, and
  // creation stamps are never written here — and Firestore rules reject an
  // update that changes any of them.
  const updateSupplierPayment = useCallback(async (payment, {
    supplierId, supplierName,
    paymentDate, amount,
    paymentMethod, paymentMethodOther,
    bankReference, remittanceReference, externalReference,
    allocations, notes,
    invoices = null,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (payment.status !== PAYMENT_STATUS.DRAFT) throw new Error('Only draft payments can be edited')

    const validationError = validatePaymentDraft({
      supplierId, supplierName, paymentDate, amount,
      paymentMethod, paymentMethodOther, allocations, invoices,
    })
    if (validationError) throw new Error(validationError)

    const cash   = roundMoney(Number(amount))
    const totals = allocationTotals(cash, allocations)
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'supplierPayments', payment.id)

    await updateDoc(ref, {
      supplierId,
      supplierName: (supplierName || '').trim(),
      paymentDate,
      amount: cash,
      paymentMethod,
      paymentMethodOther:  paymentMethod === PAYMENT_METHOD.OTHER ? (paymentMethodOther || '').trim() : '',
      bankReference:       (bankReference || '').trim(),
      remittanceReference: (remittanceReference || '').trim(),
      externalReference:   (externalReference || '').trim(),
      allocations,
      allocatedTotal:    totals.allocatedTotal,
      unallocatedAmount: totals.unallocatedAmount,
      notes: (notes || '').trim(),
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  // Posting is a SEPARATE operation performed after the draft is saved — it
  // never carries content changes. Firestore rules permit this update to touch
  // only status/postedAt/postedBy/updatedAt/updatedBy, require postedBy to be
  // the calling user, and require postedAt to be the server request time.
  //
  // A FUTURE-DATED payment cannot be posted: posting asserts money has actually
  // left the account. ⚠️ That check is CLIENT-ENFORCED — rules validate only the
  // 'YYYY-MM-DD' shape of paymentDate, so a direct SDK call can bypass it.
  const postSupplierPayment = useCallback(async (payment) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(payment.status, PAYMENT_STATUS.POSTED)) {
      throw new Error(`Cannot post a ${payment.status} payment`)
    }
    const blocked = postBlockedReason(payment)
    if (blocked) throw new Error(blocked)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'supplierPayments', payment.id)
    await updateDoc(ref, {
      status:    PAYMENT_STATUS.POSTED,
      postedAt:  serverTimestamp(),
      postedBy:  user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  // Voiding is terminal and available from draft or posted. A non-empty reason
  // is required — by this hook AND by Firestore rules. Financial records are
  // never deleted (ADR-12); the payment number is retained, so a voided payment
  // leaves a visible, intentional gap in the sequence.
  //
  // No reversal, refund, or bank-reversal document is written: every invoice
  // balance is derived at read time from posted payments, so voiding restores
  // those balances immediately.
  const voidSupplierPayment = useCallback(async (payment, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(payment.status, PAYMENT_STATUS.VOID)) {
      throw new Error(`Cannot void a ${payment.status} payment`)
    }
    const reason = (voidReason || '').trim()
    if (!reason) throw new Error('Enter a reason for voiding this payment')

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'supplierPayments', payment.id)
    await updateDoc(ref, {
      status:     PAYMENT_STATUS.VOID,
      voidedAt:   serverTimestamp(),
      voidedBy:   user.uid,
      voidReason: reason,
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
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
