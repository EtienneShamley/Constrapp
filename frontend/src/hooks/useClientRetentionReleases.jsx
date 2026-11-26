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
import { CLIENT_RETENTION_RELEASE_COUNTER_ID } from '../lib/clientRetention'
import {
  runClientReleaseCreate, runClientReleaseUpdate, runClientReleasePost, runClientReleaseVoid,
  CLIENT_FINANCE_CALL_TIMEOUT_MS,
} from '../lib/clientLedgerActions'

// ── Client Retention Releases (ADR-88) ───────────────────────────────────────
//
// Authorisations that make retention ALREADY WITHHELD on an issued Client
// Invoice receivable. Financial-role reads (Rules). This hook WRITES drafts
// only — create, edit, and the void of a draft — each one transaction in
// lib/clientLedgerActions.js. POSTING, and voiding a POSTED release, are the
// trusted callables `postClientRetentionRelease` / `voidClientRetentionRelease`
// (ADR-89), which move the invoice's ledger; no browser can write one.
// Nothing is written onto an invoice.

// One trusted callable by name; resolves to its result.
const callClientFinance = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: CLIENT_FINANCE_CALL_TIMEOUT_MS })(data)).data

// Whether the browser still holds a signed-in user — what tells an App Check
// refusal from an ended session when a callable answers `unauthenticated`.
const isSignedIn = () => auth.currentUser != null

export function useClientRetentionReleases(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  const companyId = company?.id ?? null
  const projectCurrency = resolveProjectCurrency(project, company)

  const [snap, setSnap] = useState({ key: null, releases: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined
    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'clientRetentionReleases')
    return onSnapshot(
      query(ref, orderBy('createdAt', 'desc')),
      (querySnap) => setSnap({ key, releases: querySnap.docs.map(d => ({ id: d.id, ...d.data() })), error: false }),
      () => setSnap({ key, releases: [], error: true }),
    )
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const clientRetentionReleases = settled ? snap.releases : []
  const clientRetentionReleasesLoading = targetKey !== null && !settled
  const clientRetentionReleasesError = settled ? snap.error : false

  const refs = useCallback((clientInvoiceId, releaseId = null) => {
    const base = ['companies', companyId, 'projects', projectId]
    return {
      releaseRef: releaseId
        ? doc(db, ...base, 'clientRetentionReleases', releaseId)
        : doc(collection(db, ...base, 'clientRetentionReleases')),
      invoiceRef: doc(db, ...base, 'clientInvoices', clientInvoiceId),
      ledgerRef:  doc(db, ...base, 'clientInvoiceLedgers', clientInvoiceId),
    }
  }, [companyId, projectId])

  const guard = useCallback(() => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
  }, [companyId, projectId, user])

  const createClientRetentionRelease = useCallback(async ({ clientInvoiceId, ...input }) => {
    guard()
    return runClientReleaseCreate({
      db, runTransaction, serverTimestamp, uid: user.uid, currency: projectCurrency,
      counterRef: doc(db, 'companies', companyId, 'counters', CLIENT_RETENTION_RELEASE_COUNTER_ID),
      ...refs(clientInvoiceId),
      stageCurrencyLock: (tx) => stageProjectCurrencyLock(tx, companyId, projectId),
      input,
    })
  }, [guard, refs, user, companyId, projectId, projectCurrency])

  const updateClientRetentionRelease = useCallback(async (release, input) => {
    guard()
    return runClientReleaseUpdate({
      db, runTransaction, serverTimestamp, uid: user.uid,
      ...refs(release.clientInvoiceId, release.id), input,
    })
  }, [guard, refs, user])

  const postClientRetentionRelease = useCallback(async (release) => {
    guard()
    return runClientReleasePost({ call: callClientFinance, isSignedIn, projectId, releaseId: release.id })
  }, [guard, projectId])

  // Callers may still pass a third argument (the page's own received /
  // receivable figures). It is IGNORED: whether receipts depend on a posted
  // release is decided by the server, from the receipts it reads in its
  // transaction.
  const voidClientRetentionRelease = useCallback(async (release, reason) => {
    guard()
    return runClientReleaseVoid({
      db, runTransaction, serverTimestamp, uid: user.uid,
      releaseRef: refs(release.clientInvoiceId, release.id).releaseRef,
      reason, call: callClientFinance, isSignedIn, projectId,
    })
  }, [guard, refs, user, projectId])

  return {
    clientRetentionReleases, clientRetentionReleasesLoading, clientRetentionReleasesError,
    createClientRetentionRelease, updateClientRetentionRelease,
    postClientRetentionRelease, voidClientRetentionRelease,
  }
}
