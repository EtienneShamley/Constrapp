import { useEffect, useState, useCallback, useMemo } from 'react'
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
  CLAIM_STATUS, CLAIMABLE_PO_STATUSES, canTransition, claimTotals,
  formatClaimNumber, hasOpenClaim, validateApprovedAmounts,
  buildClaimLine, claimedToDateCountError, validateClaimDraft,
} from '../lib/progressClaims'

export function useProgressClaims(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
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

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD for records predating the
  // Company Country & Currency foundation.
  const projectCurrency = resolveProjectCurrency(project, company)

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

  // Creates a draft claim against one sent PO. The company-wide counter is read
  // and incremented in the same transaction as the claim write, matching POs.
  const createProgressClaim = useCallback(async ({ po, periodEnding, claimRef, notes, retention, variationId, lineItems }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!CLAIMABLE_PO_STATUSES.includes(po.status)) throw new Error('Claims can only be raised against sent purchase orders')
    if (hasOpenClaim(progressClaims, po.id)) throw new Error('This purchase order already has an open claim')

    const counterRef  = doc(db, 'companies', companyId, 'counters', 'progressClaims')
    const claimDocRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'progressClaims'))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this claim and the project lock succeed or fail
      // together — the project can never hold amounts with a still-changeable
      // currency. Firestore requires all transaction reads before any writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      const totals = claimTotals(lineItems.map(li => li.claimedThisPeriod), retention)
      tx.set(claimDocRef, {
        claimNumber:  formatClaimNumber(next),
        status:       CLAIM_STATUS.DRAFT,
        poId:         po.id,
        poNumber:     po.poNumber,
        supplierName: po.supplierName,
        supplierId:   po.supplierId ?? null,
        claimRef:     claimRef?.trim() || '',
        periodEnding: periodEnding || '',
        variationId:  variationId ?? null,
        lineItems,
        retention:        totals.retention,
        claimedSubtotal:  totals.subtotal,
        claimedGst:       totals.gst,
        claimedTotal:     totals.total,
        approvedSubtotal: null,
        approvedGst:      null,
        approvedTotal:    null,
        notes:            notes?.trim() || '',
        assessmentNotes:  '',
        // Audit snapshot of the currency this document was raised in (the frozen
        // supplierName/costCodeName idiom). The PROJECT currency remains the
        // display authority — this field is never read for rendering, so a
        // project can never show mixed currencies. Historical documents keep
        // their stored 'AUD' and are never rewritten.
        currency:         projectCurrency,
        revision:         1,
        submittedAt:      null,
        approvedAt:       null,
        rejectedAt:       null,
        invoicedAt:       null,
        approvedBy:       null,
        externalRefs:     {},
        createdAt:        serverTimestamp(),
        createdBy:        user.uid,
      })
      commitLock()
    })
  }, [companyId, projectId, user, progressClaims, projectCurrency])

  // Draft-only edits (ADR-37) — claimed amounts freeze once a claim is submitted.
  //
  // The caller supplies NO line items. `claimedToDate` is the ordered set of
  // authored cumulative figures, one per STORED line, and the stored claim
  // document is the sole authority for line identity: every line is rebuilt over
  // `claim.lineItems`, so poLineIndex, costCodeId, costCodeName, description,
  // poLineTotal and previouslyApproved cannot be rewritten by any caller.
  // `previouslyApproved` is deliberately NOT re-derived — the one-open-claim rule
  // means no later approved claim can legitimately appear while this draft is
  // open, so re-deriving would be a no-op in every supported case and, in the
  // already-broken ones, would silently move a figure the user never authored.
  // `claimedThisPeriod` is always re-derived and `approvedThisPeriod` forced null.
  //
  // Immutable fields (claimNumber, status, poId/poNumber, supplierId/supplierName,
  // variationId, currency, revision, every approved* value, assessmentNotes, the
  // lifecycle stamps, approvedBy, externalRefs, createdAt/createdBy) are never
  // written — updateDoc is partial, so they pass through untouched. No currency
  // ratchet is staged (the project locked when the claim was created) and no audit
  // stamp is added (the model has none). The draft guard is client-side only
  // (rules do not check status — SECURITY.md Deferred Controls 1 and 2).
  const updateProgressClaim = useCallback(async (claim, { periodEnding, claimRef, notes, retention, claimedToDate }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (claim.status !== CLAIM_STATUS.DRAFT) throw new Error('Only draft claims can be edited')
    // Exact positional pairing — a mismatch would silently pair authored values
    // with the wrong lines, so nothing is written.
    const countError = claimedToDateCountError(claim.lineItems, claimedToDate)
    if (countError) throw new Error(countError)

    const lineItems = claim.lineItems.map((storedLine, idx) =>
      buildClaimLine(storedLine, { claimedToDate: claimedToDate[idx] })
    )
    const draftError = validateClaimDraft({ lineItems })
    if (draftError) throw new Error(draftError)

    const ref    = doc(db, 'companies', companyId, 'projects', projectId, 'progressClaims', claim.id)
    const totals = claimTotals(lineItems.map(li => li.claimedThisPeriod), retention)
    await updateDoc(ref, {
      claimRef:        claimRef?.trim() || '',
      periodEnding:    periodEnding || '',
      lineItems,
      retention:       totals.retention,
      claimedSubtotal: totals.subtotal,
      claimedGst:      totals.gst,
      claimedTotal:    totals.total,
      notes:           notes?.trim() || '',
    })
  }, [companyId, projectId, user])

  // Moving to approved requires per-line certified amounts (assessment). All
  // other transitions are stamps only. Approved amounts are frozen forever.
  const transitionStatus = useCallback(async (claim, nextStatus, { approvedAmounts, assessmentNotes } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(claim.status, nextStatus)) {
      throw new Error(`Cannot move a ${claim.status} claim to ${nextStatus}`)
    }
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'progressClaims', claim.id)

    if (nextStatus === CLAIM_STATUS.APPROVED) {
      const validationError = validateApprovedAmounts(claim.lineItems, approvedAmounts)
      if (validationError) throw new Error(validationError)
      const lineItems = claim.lineItems.map((li, idx) => ({
        ...li,
        approvedThisPeriod: Number(approvedAmounts[idx]) || 0,
      }))
      const totals = claimTotals(approvedAmounts, claim.retention)
      await updateDoc(ref, {
        status:           CLAIM_STATUS.APPROVED,
        lineItems,
        approvedSubtotal: totals.subtotal,
        approvedGst:      totals.gst,
        approvedTotal:    totals.total,
        assessmentNotes:  assessmentNotes?.trim() || '',
        approvedAt:       serverTimestamp(),
        approvedBy:       user.uid,
      })
      return
    }

    const stampField = {
      [CLAIM_STATUS.SUBMITTED]: 'submittedAt',
      [CLAIM_STATUS.REJECTED]:  'rejectedAt',
      [CLAIM_STATUS.INVOICED]:  'invoicedAt',
    }[nextStatus]
    await updateDoc(ref, {
      status: nextStatus,
      ...(stampField ? { [stampField]: serverTimestamp() } : {}),
      ...(nextStatus === CLAIM_STATUS.REJECTED && assessmentNotes?.trim()
        ? { assessmentNotes: assessmentNotes.trim() }
        : {}),
    })
  }, [companyId, projectId, user])

  return { progressClaims, progressClaimsLoading, progressClaimsError, createProgressClaim, updateProgressClaim, transitionStatus }
}
