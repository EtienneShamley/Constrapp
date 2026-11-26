import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy, runTransaction, serverTimestamp,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { useProject } from './useProject'
import { stageProjectCurrencyLock } from './projectCurrencyLock'
import { resolveProjectCurrency } from '../lib/currency'
import { CLIENT_CREDIT_NOTE_COUNTER_ID } from '../lib/clientCreditNotes'
import {
  runClientCreditCreate, runClientCreditUpdate, runClientCreditPost, runClientCreditVoid,
  CLIENT_FINANCE_CALL_TIMEOUT_MS,
} from '../lib/clientLedgerActions'

// ── Client Credit Notes (ADR-87) ─────────────────────────────────────────────
//
// Reductions against issued Client Invoices. Reads are restricted to internal
// financial roles by Firestore Rules. This hook WRITES drafts only — create,
// edit, and the void of a draft — each one transaction in
// lib/clientLedgerActions.js. POSTING, and voiding a POSTED credit note, are
// the trusted callables `postClientCreditNote` / `voidClientCreditNote`
// (ADR-89): they receive identifiers and a reason, re-derive every figure and
// move the invoice's ledger, which no browser can write. Nothing is ever
// written onto a client invoice.

// One trusted callable by name; resolves to its result.
const callClientFinance = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: CLIENT_FINANCE_CALL_TIMEOUT_MS })(data)).data

// Whether the browser still holds a signed-in user — what tells an App Check
// refusal from an ended session when a callable answers `unauthenticated`.
const isSignedIn = () => auth.currentUser != null

export function useClientCreditNotes(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  const companyId = company?.id ?? null
  const projectCurrency = resolveProjectCurrency(project, company)

  const [snap, setSnap] = useState({ key: null, creditNotes: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined
    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'clientCreditNotes')
    return onSnapshot(
      query(ref, orderBy('createdAt', 'desc')),
      (querySnap) => setSnap({ key, creditNotes: querySnap.docs.map(d => ({ id: d.id, ...d.data() })), error: false }),
      () => setSnap({ key, creditNotes: [], error: true }),
    )
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const clientCreditNotes = settled ? snap.creditNotes : []
  const clientCreditNotesLoading = targetKey !== null && !settled
  const clientCreditNotesError = settled ? snap.error : false

  const refs = useCallback((clientInvoiceId, creditNoteId = null) => {
    const base = ['companies', companyId, 'projects', projectId]
    return {
      creditRef: creditNoteId
        ? doc(db, ...base, 'clientCreditNotes', creditNoteId)
        : doc(collection(db, ...base, 'clientCreditNotes')),
      invoiceRef: doc(db, ...base, 'clientInvoices', clientInvoiceId),
      ledgerRef:  doc(db, ...base, 'clientInvoiceLedgers', clientInvoiceId),
    }
  }, [companyId, projectId])

  const guard = useCallback(() => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
  }, [companyId, projectId, user])

  const createClientCreditNote = useCallback(async ({ clientInvoiceId, ...input }) => {
    guard()
    return runClientCreditCreate({
      db, runTransaction, serverTimestamp, uid: user.uid, currency: projectCurrency,
      counterRef: doc(db, 'companies', companyId, 'counters', CLIENT_CREDIT_NOTE_COUNTER_ID),
      ...refs(clientInvoiceId),
      stageCurrencyLock: (tx) => stageProjectCurrencyLock(tx, companyId, projectId),
      input,
    })
  }, [guard, refs, user, companyId, projectId, projectCurrency])

  const updateClientCreditNote = useCallback(async (creditNote, input) => {
    guard()
    return runClientCreditUpdate({
      db, runTransaction, serverTimestamp, uid: user.uid,
      ...refs(creditNote.clientInvoiceId, creditNote.id), input,
    })
  }, [guard, refs, user])

  const postClientCreditNote = useCallback(async (creditNote) => {
    guard()
    return runClientCreditPost({ call: callClientFinance, isSignedIn, projectId, creditNoteId: creditNote.id })
  }, [guard, projectId])

  const voidClientCreditNote = useCallback(async (creditNote, reason) => {
    guard()
    return runClientCreditVoid({
      db, runTransaction, serverTimestamp, uid: user.uid,
      creditRef: refs(creditNote.clientInvoiceId, creditNote.id).creditRef,
      reason, call: callClientFinance, isSignedIn, projectId,
    })
  }, [guard, refs, user, projectId])

  return {
    clientCreditNotes, clientCreditNotesLoading, clientCreditNotesError,
    createClientCreditNote, updateClientCreditNote, postClientCreditNote, voidClientCreditNote,
  }
}
