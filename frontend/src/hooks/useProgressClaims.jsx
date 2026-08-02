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
import {
  CLAIM_STATUS, CLAIMABLE_PO_STATUSES, canTransition, claimTotals,
  formatClaimNumber, hasOpenClaim, validateApprovedAmounts,
} from '../lib/progressClaims'

export function useProgressClaims(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  const [progressClaims, setProgressClaims]               = useState([])
  const [progressClaimsLoading, setProgressClaimsLoading] = useState(true)

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD for records predating the
  // Company Country & Currency foundation.
  const projectCurrency = resolveProjectCurrency(project, company)

  useEffect(() => {
    if (!companyId || !projectId) {
      setProgressClaims([])
      setProgressClaimsLoading(false)
      return
    }

    setProgressClaimsLoading(true)
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'progressClaims')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setProgressClaims(snap.docs.map(d => ({ id: d.id, ...d.data() })))
        setProgressClaimsLoading(false)
      },
      () => {
        setProgressClaims([])
        setProgressClaimsLoading(false)
      }
    )
    return unsubscribe
  }, [companyId, projectId])

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

  // Draft-only edits — claimed amounts freeze once a claim is submitted.
  const updateProgressClaim = useCallback(async (claim, { periodEnding, claimRef, notes, retention, lineItems }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (claim.status !== CLAIM_STATUS.DRAFT) throw new Error('Only draft claims can be edited')
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

  return { progressClaims, progressClaimsLoading, createProgressClaim, updateProgressClaim, transitionStatus }
}
