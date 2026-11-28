import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, serverTimestamp,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { CLAIM_STATUS, CLAIMABLE_PO_STATUSES, canTransition, hasOpenClaim, validateClaimDraft } from '../lib/progressClaims'
import { runTransitionClaim } from '../lib/progressClaimActions'
import {
  SF_CALLABLE, SF_CALL_TIMEOUT_MS, runSupplierFinance, claimLineRequest, claimHeaderRequest,
} from '../lib/supplierFinanceActions'

// ADR-93: a claim is created, its draft edited, approved and rejected — and an
// approved claim linked to an existing invoice — only by the supplier-finance
// callables. Submit stays a content-free Rules transition.
const callSupplierFinance = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: SF_CALL_TIMEOUT_MS })(data)).data

export function useProgressClaims(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, so
  // progressClaims/loading/error are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // `error` is true when the live read failed (connection loss or a rules
  // rejection). Consumers deriving financial figures MUST treat a failed read
  // as UNAVAILABLE — never as a genuine zero. It is exposed only once the
  // CURRENT target has settled, so a project switch never flashes a stale
  // unavailable banner under the new project.
  const [snap, setSnap] = useState({ key: null, progressClaims: [], error: false })

  const companyId = company?.id ?? null

  // The claim's currency snapshot is the backend's (ADR-93): it reads the
  // project and company itself.

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'progressClaims')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        progressClaims: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read must NOT look like an empty register — "none" and "we
      // could not load them" are opposite facts, and confusing them on a
      // financial register fabricates a zero.
      () => setSnap({ key, progressClaims: [], error: true }),
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
  const progressClaims = useMemo(
    () => (settled ? snap.progressClaims : []),
    [settled, snap.progressClaims],
  )
  const progressClaimsLoading = targetKey !== null && !settled
  const progressClaimsError = settled ? snap.error : false

  // Creates a draft claim against one sent PO (ADR-93). The request carries
  // each line's SOURCE identity and the authored claimed-to-date; the backend
  // reads the PO, the variations and the PO's claim ledger, derives every
  // figure (calculation version 2) and enforces one open claim per PO —
  // authoritatively now (Deferred Control 36). The checks below are the UX
  // mirror and fail fast. `claimId` may be chosen by the caller and re-sent
  // on a retry, which makes the retry safe.
  const createProgressClaim = useCallback(async ({ po, periodEnding, claimRef, notes, retention, lineItems, claimId = null }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!CLAIMABLE_PO_STATUSES.includes(po.status)) throw new Error('Claims can only be raised against sent purchase orders')
    if (hasOpenClaim(progressClaims, po.id)) throw new Error('This purchase order already has an open claim')
    const draftError = validateClaimDraft({ lineItems, retention, poId: po.id })
    if (draftError) throw new Error(draftError)
    const id = claimId ?? doc(collection(db, 'companies', companyId, 'projects', projectId, 'progressClaims')).id
    return runSupplierFinance(callSupplierFinance, SF_CALLABLE.CLAIM, 'create', {
      projectId, claimId: id, poId: po.id, ...claimHeaderRequest({ periodEnding, claimRef, notes, retention }),
      lines: lineItems.map(claimLineRequest),
    })
  }, [companyId, projectId, user, progressClaims])

  // Draft-only edit (ADR-37 contract, ADR-93 authority): one claimed-to-date
  // per STORED line, the revision the editor was OPENED on. The backend
  // re-derives every line from the stored identities and the PO's claim
  // ledger, and stores the draft under the current calculation version.
  const updateProgressClaim = useCallback(async (claim, data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (claim.status !== CLAIM_STATUS.DRAFT) throw new Error('Only draft claims can be edited')
    return runSupplierFinance(callSupplierFinance, SF_CALLABLE.CLAIM, 'update', {
      projectId, claimId: claim.id, expectedRevision: Number.isSafeInteger(claim.revision) ? claim.revision : 0,
      ...claimHeaderRequest(data), claimedToDate: (data?.claimedToDate ?? []).map(v => Number(v) || 0),
    })
  }, [companyId, projectId, user])

  // Submit is the content-free Rules transition (ADR-58). Approve and reject
  // are backend operations: approval verifies the stored claim and certifies
  // under its own calculation version; both move the PO's claim ledger.
  const transitionStatus = useCallback(async (claim, nextStatus, { approvedAmounts, assessmentNotes } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(claim.status, nextStatus)) {
      throw new Error(`Cannot move a ${claim.status} claim to ${nextStatus}`)
    }
    const expectedRevision = Number.isSafeInteger(claim.revision) ? claim.revision : 0
    if (nextStatus === CLAIM_STATUS.APPROVED) {
      return runSupplierFinance(callSupplierFinance, SF_CALLABLE.CLAIM, 'approve', {
        projectId, claimId: claim.id, expectedRevision,
        approvedAmounts: (approvedAmounts ?? []).map(a => Math.round((Number(a) || 0) * 100) / 100),
        assessmentNotes: (assessmentNotes ?? '').trim(),
      })
    }
    if (nextStatus === CLAIM_STATUS.REJECTED) {
      return runSupplierFinance(callSupplierFinance, SF_CALLABLE.CLAIM, 'reject', {
        projectId, claimId: claim.id, expectedRevision, assessmentNotes: (assessmentNotes ?? '').trim(),
      })
    }
    const claimDocRef = doc(db, 'companies', companyId, 'projects', projectId, 'progressClaims', claim.id)
    await runTransitionClaim({
      db, claimRef: claimDocRef, seen: claim, nextStatus,
      uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user])

  // SHIELD 2A (ADR-68) — RECONCILE a claim that has no current link with an
  // EXISTING active claim-sourced invoice of its own, through the backend.
  const linkExistingInvoice = useCallback(async (claim, invoice) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    return runSupplierFinance(callSupplierFinance, SF_CALLABLE.INVOICE, 'link', {
      projectId, claimId: claim.id, invoiceId: invoice.id,
      expectedClaimRevision: Number.isSafeInteger(claim.revision) ? claim.revision : 0,
    })
  }, [companyId, projectId, user])

  return { progressClaims, progressClaimsLoading, progressClaimsError, createProgressClaim, updateProgressClaim, transitionStatus, linkExistingInvoice }
}
