import { useEffect, useState, useCallback, useMemo } from 'react'
import { collection, doc, onSnapshot, query, orderBy } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { SF_CALLABLE, SF_CALL_TIMEOUT_MS, runSupplierFinance } from '../lib/supplierFinanceActions'
import { SCN_STATUS, canTransition } from '../lib/supplierCreditNotes'

// ADR-94: supplier credit notes are created, edited, posted and voided only by the
// supplier-finance backend, which moves the invoice ledger(s) on posting and
// voiding. Firestore Rules admit no client write to the collection.
const callSupplierFinance = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: SF_CALL_TIMEOUT_MS })(data)).data
const revisionOf = (doc) => (Number.isSafeInteger(doc?.revision) ? doc.revision : 0)
const cents2 = (v) => Math.round((Number(v) || 0) * 100) / 100
const settle = (operation, request) => runSupplierFinance(callSupplierFinance, SF_CALLABLE.SETTLEMENT, operation, request)
export function useSupplierCreditNotes(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()

  const companyId = company?.id ?? null

  // Live subscription state, tagged with the target (`key`) it belongs to. The
  // effect is subscription-only: state is written ONLY from the onSnapshot
  // callbacks, never synchronously in the effect body, so loading/error are
  // derived at render time below (matching useClientInvoices).
  const [snap, setSnap] = useState({ key: null, creditNotes: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'supplierCreditNotes')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        creditNotes: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully rather than crashing the page.
      () => setSnap({ key, creditNotes: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  // Memoised so the write callbacks below (which validate against the live
  // list) keep stable dependencies across renders.
  const supplierCreditNotes = useMemo(
    () => (settled ? snap.creditNotes : []),
    [settled, snap.creditNotes],
  )
  const supplierCreditNotesLoading = targetKey !== null && !settled
  const supplierCreditNotesError = settled ? snap.error : false

  // A credit note credits cost-code / tax-code groups of its posted invoice
  // (ADR-94). The backend derives each line's GST as a share of the invoice's
  // STORED GST and, on a retained invoice, the retained share (G1); a draft
  // carries those previewed figures, and POSTING re-derives them against the
  // invoice ledger and refuses if they moved.
  const creditLines = (lineItems) => (lineItems ?? []).map(li => ({
    costCodeId: li.costCodeId, taxCode: li.taxCode, description: String(li.description ?? '').trim(), amount: cents2(li.amount),
  }))
  const creditRequest = (creditNoteId, expectedRevision, { invoice, supplierInvoiceId, supplierCreditReference, creditDate, reason, lineItems, notes }) => ({
    projectId, creditNoteId, expectedRevision, supplierInvoiceId: invoice?.id ?? supplierInvoiceId,
    supplierCreditReference: String(supplierCreditReference ?? '').trim(), creditDate: creditDate || '',
    reason: String(reason ?? '').trim(), notes: String(notes ?? '').trim(), lines: creditLines(lineItems),
  })

  const createSupplierCreditNote = useCallback(async (data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const id = data.creditNoteId ?? doc(collection(db, 'companies', companyId, 'projects', projectId, 'supplierCreditNotes')).id
    const out = await settle('saveCredit', creditRequest(id, null, data))
    return out.id
  }, [companyId, projectId, user]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateSupplierCreditNote = useCallback(async (creditNote, data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (creditNote.status !== SCN_STATUS.DRAFT) throw new Error('Only draft credit notes can be edited')
    return settle('saveCredit', creditRequest(creditNote.id, revisionOf(creditNote), { ...data, supplierInvoiceId: creditNote.supplierInvoiceId }))
  }, [companyId, projectId, user]) // eslint-disable-line react-hooks/exhaustive-deps

  const postSupplierCreditNote = useCallback(async (creditNote) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(creditNote.status, SCN_STATUS.POSTED)) throw new Error(`Cannot post a ${creditNote.status} credit note`)
    return settle('postCredit', { projectId, documentId: creditNote.id, expectedRevision: revisionOf(creditNote) })
  }, [companyId, projectId, user])

  // Voiding corrects a record entered in error; it reverses the credit's
  // ledger effect and is refused while that would break a dependent state.
  const voidSupplierCreditNote = useCallback(async (creditNote, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(creditNote.status, SCN_STATUS.VOID)) throw new Error(`Cannot void a ${creditNote.status} credit note`)
    const reason = String(voidReason ?? '').trim()
    if (!reason) throw new Error('Enter a reason for voiding this credit note')
    return settle('voidCredit', { projectId, documentId: creditNote.id, expectedRevision: revisionOf(creditNote), voidReason: reason })
  }, [companyId, projectId, user])

  return {
    supplierCreditNotes,
    supplierCreditNotesLoading,
    supplierCreditNotesError,
    createSupplierCreditNote,
    updateSupplierCreditNote,
    postSupplierCreditNote,
    voidSupplierCreditNote,
  }
}
