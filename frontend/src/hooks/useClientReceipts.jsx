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
import { PAYMENT_STATUS, canTransition, allocationTotals } from '../lib/payments'
import {
  CR_DOC_TYPE, CLIENT_RECEIPT_COUNTER_ID,
  formatClientReceiptNumber, validateReceiptDraft, postBlockedReason,
} from '../lib/clientReceipts'

// ── Client Receipts (accounts receivable — money IN) ──────────────────────────
//
// Records cash actually received from a head-contract client, with embedded
// allocations against issued Client Invoices. Reads are restricted to internal
// financial roles by Firestore rules.
//
// This hook writes ONLY client receipt documents (plus the company-wide counter
// and the project currency ratchet, both inside the create transaction). It
// NEVER mutates client invoices, the commercial baseline, variations, budget
// lines, purchase orders, progress claims, or supplier invoices — every
// reconciliation figure is derived at read time in lib/clientReceipts.js.
//
// LIFECYCLE NOTE. Like clientInvoices (and unlike the older collections), the
// receipt lifecycle is ALSO enforced by Firestore rules: create is draft-only,
// draft edits cannot rewrite the receipt number/currency/creation stamps,
// posting and voiding may touch only their own audit fields, and a posted
// receipt is otherwise immutable. The checks below are the UX mirror — the rules
// are the boundary.
export function useClientReceipts(projectId) {
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
  // derived at render time below (matching useClientInvoices).
  const [snap, setSnap] = useState({ key: null, receipts: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'clientReceipts')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        receipts: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully rather than crashing the page.
      () => setSnap({ key, receipts: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const clientReceipts = settled ? snap.receipts : []
  const clientReceiptsLoading = targetKey !== null && !settled
  const clientReceiptsError = settled ? snap.error : false

  // Creates a DRAFT client receipt. The company-wide counter is read and
  // incremented in the same transaction as the receipt write (ADR-5), and the
  // project currency ratchet is staged in the same transaction (ADR-21) — a
  // receipt is monetary data, so the record and the lock must commit or roll
  // back together. A failed create therefore consumes no number.
  //
  // The caller supplies the frozen client snapshot and built allocations
  // (clientInvoiceId + frozen invoiceNumber + allocatedAmount); the allocated
  // and unallocated totals are derived here so a caller can never write one
  // without the other.
  const createClientReceipt = useCallback(async ({
    clientId, clientName,
    receiptDate, amount,
    paymentMethod, paymentMethodOther,
    bankReference, externalReference,
    allocations, notes,
    invoices = null,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateReceiptDraft({
      clientId, clientName, receiptDate, amount,
      paymentMethod, paymentMethodOther, allocations, invoices,
    })
    if (validationError) throw new Error(validationError)

    const cash    = roundMoney(Number(amount))
    const totals  = allocationTotals(cash, allocations)

    const counterRef = doc(db, 'companies', companyId, 'counters', CLIENT_RECEIPT_COUNTER_ID)
    const receiptRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'clientReceipts'))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this receipt and the project lock succeed or fail
      // together. Firestore requires all transaction reads before any writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      tx.set(receiptRef, {
        receiptNumber: formatClientReceiptNumber(next),
        status:        PAYMENT_STATUS.DRAFT,
        docType:       CR_DOC_TYPE.RECEIPT,

        // Client identity — FROZEN at creation so later contact edits never
        // rewrite the cash record. Both are REQUIRED non-empty (rules-enforced):
        // a receipt with no client is not a record.
        clientId,
        clientName: (clientName || '').trim(),

        // The date the money was RECEIVED — a calendar date off a bank
        // statement, stored as 'YYYY-MM-DD' like every other financial date in
        // the app. This, never createdAt/postedAt, is what the future Cash Flow
        // module consumes as the date cash moved.
        receiptDate,

        // Actual GROSS cash received. No GST, no tax code, no net amount: a cash
        // movement is not a new taxable supply, and the tax was already recorded
        // on the invoice being reconciled.
        amount: cash,

        paymentMethod,
        paymentMethodOther: paymentMethod === 'other' ? (paymentMethodOther || '').trim() : '',
        bankReference:      (bankReference || '').trim(),
        externalReference:  (externalReference || '').trim(),

        // Embedded allocations (ADR-6 idiom) with a frozen invoiceNumber
        // snapshot, so a register row renders without reading invoice documents.
        // NOTHING is written onto the invoices themselves.
        allocations,
        allocatedTotal:    totals.allocatedTotal,
        unallocatedAmount: totals.unallocatedAmount,

        // Audit snapshot of the currency this receipt was taken in. The PROJECT
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
    return receiptRef.id
  }, [companyId, projectId, user, projectCurrency])

  // Draft-only edits. The receipt number, currency, docType, revision, and
  // creation stamps are never written here — and Firestore rules reject an
  // update that changes any of them.
  const updateClientReceipt = useCallback(async (receipt, {
    clientId, clientName,
    receiptDate, amount,
    paymentMethod, paymentMethodOther,
    bankReference, externalReference,
    allocations, notes,
    invoices = null,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (receipt.status !== PAYMENT_STATUS.DRAFT) throw new Error('Only draft receipts can be edited')

    const validationError = validateReceiptDraft({
      clientId, clientName, receiptDate, amount,
      paymentMethod, paymentMethodOther, allocations, invoices,
    })
    if (validationError) throw new Error(validationError)

    const cash   = roundMoney(Number(amount))
    const totals = allocationTotals(cash, allocations)
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'clientReceipts', receipt.id)

    await updateDoc(ref, {
      clientId,
      clientName: (clientName || '').trim(),
      receiptDate,
      amount: cash,
      paymentMethod,
      paymentMethodOther: paymentMethod === 'other' ? (paymentMethodOther || '').trim() : '',
      bankReference:      (bankReference || '').trim(),
      externalReference:  (externalReference || '').trim(),
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
  // A FUTURE-DATED receipt cannot be posted: posting asserts money has actually
  // been received. ⚠️ That check is CLIENT-ENFORCED — rules validate only the
  // 'YYYY-MM-DD' shape of receiptDate, so a direct SDK call can bypass it.
  const postClientReceipt = useCallback(async (receipt) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(receipt.status, PAYMENT_STATUS.POSTED)) {
      throw new Error(`Cannot post a ${receipt.status} receipt`)
    }
    const blocked = postBlockedReason(receipt)
    if (blocked) throw new Error(blocked)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'clientReceipts', receipt.id)
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
  // never deleted (ADR-12); the receipt number is retained, so a voided receipt
  // leaves a visible, intentional gap in the sequence.
  //
  // No reversal document is written: every invoice balance is derived at read
  // time from posted receipts, so voiding restores those balances immediately.
  const voidClientReceipt = useCallback(async (receipt, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(receipt.status, PAYMENT_STATUS.VOID)) {
      throw new Error(`Cannot void a ${receipt.status} receipt`)
    }
    const reason = (voidReason || '').trim()
    if (!reason) throw new Error('Enter a reason for voiding this receipt')

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'clientReceipts', receipt.id)
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
    clientReceipts,
    clientReceiptsLoading,
    clientReceiptsError,
    createClientReceipt,
    updateClientReceipt,
    postClientReceipt,
    voidClientReceipt,
  }
}
