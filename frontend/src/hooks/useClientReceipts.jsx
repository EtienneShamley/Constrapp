import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions } from '../lib/firebase'
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
import { clientReceiptTextError } from '../lib/clientEntryShape'
import { runClientReceiptPost, runClientReceiptVoid, CLIENT_FINANCE_CALL_TIMEOUT_MS } from '../lib/clientLedgerActions'

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
// WHAT THIS HOOK WRITES (ADR-89): DRAFTS ONLY — create, edit, and the void of a
// draft. Firestore Rules allow a browser nothing more. POSTING a receipt, and
// voiding a POSTED one, are the trusted callables `postClientReceipt` /
// `voidClientReceipt`: the server re-derives the receipt's totals, checks every
// allocated invoice, enforces the over-allocation acknowledgement, and records
// what each allocation adds to its invoice's ledger. The checks below are the
// UX mirror — the server and the Rules are the boundary.

// One trusted callable by name; resolves to its result.
const callClientFinance = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: CLIENT_FINANCE_CALL_TIMEOUT_MS })(data)).data

// Whether the browser still holds a signed-in user — what tells an App Check
// refusal from an ended session when a callable answers `unauthenticated`.
const isSignedIn = () => auth.currentUser != null

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
    }) ?? clientReceiptTextError({ paymentMethodOther, bankReference, externalReference, notes })
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
    }) ?? clientReceiptTextError({ paymentMethodOther, bankReference, externalReference, notes })
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
  // never carries content changes, and it is the trusted callable's: the
  // request names the receipt and says whether over-allocating an invoice was
  // acknowledged, nothing else.
  //
  // `acknowledgeOverAllocation` — the user ticked the acknowledgement. Whether
  // one was NEEDED is decided by the server from each invoice's balance as it
  // stands at posting; without it, a receipt that would over-allocate an
  // invoice is refused and names the invoice.
  //
  // A FUTURE-DATED receipt cannot be posted: posting asserts money has actually
  // been received. The check here is a hint; the server refuses a date more
  // than a day ahead of its own.
  const postClientReceipt = useCallback(async (receipt, { acknowledgeOverAllocation = false } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(receipt.status, PAYMENT_STATUS.POSTED)) {
      throw new Error(`Cannot post a ${receipt.status} receipt`)
    }
    const blocked = postBlockedReason(receipt)
    if (blocked) throw new Error(blocked)

    return runClientReceiptPost({
      call: callClientFinance, isSignedIn, projectId, receiptId: receipt.id, acknowledgeOverAllocation,
    })
  }, [companyId, projectId, user])

  // Voiding is terminal and available from draft or posted. A non-empty reason
  // is required — here, by Firestore Rules (a draft) and by the server (a
  // posted receipt). Financial records are never deleted (ADR-12); the receipt
  // number is retained, so a voided receipt leaves a visible, intentional gap.
  //
  // A DRAFT is voided by a direct write. A POSTED receipt is voided by the
  // trusted callable, which takes its allocations back out of each invoice's
  // ledger; no reversal document is written.
  const voidClientReceipt = useCallback(async (receipt, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(receipt.status, PAYMENT_STATUS.VOID)) {
      throw new Error(`Cannot void a ${receipt.status} receipt`)
    }
    return runClientReceiptVoid({
      db, runTransaction, serverTimestamp, uid: user.uid,
      receiptRef: doc(db, 'companies', companyId, 'projects', projectId, 'clientReceipts', receipt.id),
      reason: voidReason, call: callClientFinance, isSignedIn, projectId,
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
