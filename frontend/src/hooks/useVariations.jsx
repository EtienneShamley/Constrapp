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
  VARIATION_TYPE, VARIATION_STATUS, VARIATION_COUNTER_ID,
  canTransition, variationTotals, validateApprovedAmounts, buildApprovedLineItems,
  formatClientVariationNumber, formatSupplierVariationNumber,
} from '../lib/variations'

const pad2 = (n) => String(n).padStart(2, '0')
function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function useVariations(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  const [variations, setVariations]               = useState([])
  const [variationsLoading, setVariationsLoading] = useState(true)

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD for records predating the
  // Company Country & Currency foundation.
  const projectCurrency = resolveProjectCurrency(project, company)

  useEffect(() => {
    if (!companyId || !projectId) {
      setVariations([])
      setVariationsLoading(false)
      return
    }

    setVariationsLoading(true)
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'variations')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setVariations(snap.docs.map(d => ({ id: d.id, ...d.data() })))
        setVariationsLoading(false)
      },
      () => {
        setVariations([])
        setVariationsLoading(false)
      }
    )
    return unsubscribe
  }, [companyId, projectId])

  // Creates a draft variation. The type's company-wide counter
  // (variationsClient / variationsSupplier) is read and incremented in the same
  // transaction as the write, matching POs/claims/invoices. The caller supplies
  // the counterparty/PO snapshots and built line items (ex-GST submittedAmount +
  // taxCode + submittedGst per line); submitted totals are derived here. Fields
  // that do not apply to the type are stored as null.
  const createVariation = useCallback(async ({
    variationType,
    title, description, reason,
    clientId, clientName, clientRef,
    supplierId, supplierName, supplierRef,
    poId, poNumber,
    identifiedDate, submittedDate, responseDueDate, effectiveDate,
    lineItems, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const isClient = variationType === VARIATION_TYPE.CLIENT

    const counterRef = doc(db, 'companies', companyId, 'counters', VARIATION_COUNTER_ID[variationType])
    const varRef     = doc(collection(db, 'companies', companyId, 'projects', projectId, 'variations'))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this variation and the project lock succeed or fail
      // together — the project can never hold amounts with a still-changeable
      // currency. Firestore requires all transaction reads before any writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      const submitted = variationTotals(lineItems, 'submitted')
      tx.set(varRef, {
        variationNumber: isClient ? formatClientVariationNumber(next) : formatSupplierVariationNumber(next),
        variationType,
        status: VARIATION_STATUS.DRAFT,

        title:       title?.trim()       || '',
        description: description?.trim() || '',
        reason:      reason || '',

        // Counterparty — only the block for this type is populated; the other is null.
        clientId:   isClient ? (clientId ?? null) : null,
        clientName: isClient ? ((clientName || '').trim()) : null,
        clientRef:  isClient ? (clientRef?.trim() || '') : null,

        supplierId:   isClient ? null : (supplierId ?? null),
        supplierName: isClient ? null : ((supplierName || '').trim()),
        supplierRef:  isClient ? null : (supplierRef?.trim() || ''),

        poId:     isClient ? null : (poId ?? null),
        poNumber: isClient ? null : (poNumber ?? null),

        lineItems,

        // Money — ex-GST canonical; header totals derive from lines.
        submittedSubtotal: submitted.subtotal,
        submittedGst:      submitted.gst,
        submittedTotal:    submitted.total,
        approvedSubtotal:  null,
        approvedGst:       null,
        approvedTotal:     null,
        forecastAmount:    null, // reserved — likely settlement value for future forecast

        // Dates (human 'YYYY-MM-DD' strings).
        identifiedDate:  identifiedDate  || '',
        submittedDate:   submittedDate   || '',
        responseDueDate: responseDueDate || '',
        approvedDate:    '',
        effectiveDate:   effectiveDate   || '',

        // Audit snapshot of the currency this document was raised in (the frozen
        // supplierName/costCodeName idiom). The PROJECT currency remains the
        // display authority — this field is never read for rendering, so a
        // project can never show mixed currencies. Historical documents keep
        // their stored 'AUD' and are never rewritten.
        currency: projectCurrency,
        revision: 1,
        notes:           notes?.trim() || '',
        assessmentNotes: '',

        // Audit stamps.
        submittedAt: null, submittedBy: null,
        approvedAt:  null, approvedBy:  null,
        rejectedAt:  null, rejectedBy:  null,
        withdrawnAt: null, withdrawnBy: null,

        // Reserved for future modules (Storage uploads, accounting, revisions).
        attachments:            [],
        externalRefs:           {},
        supersededByVariationId: null,

        createdAt: serverTimestamp(),
        createdBy: user.uid,
      })
      commitLock()
    })
    return varRef.id
  }, [companyId, projectId, user, projectCurrency])

  // Draft-only edits — content freezes once a variation is submitted. The caller
  // supplies rebuilt line items; submitted totals are re-derived here.
  const updateVariation = useCallback(async (variation, {
    title, description, reason,
    clientRef, supplierRef,
    identifiedDate, submittedDate, responseDueDate, effectiveDate,
    lineItems, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (variation.status !== VARIATION_STATUS.DRAFT) throw new Error('Only draft variations can be edited')
    const isClient = variation.variationType === VARIATION_TYPE.CLIENT
    const ref       = doc(db, 'companies', companyId, 'projects', projectId, 'variations', variation.id)
    const submitted = variationTotals(lineItems, 'submitted')
    await updateDoc(ref, {
      title:       title?.trim()       || '',
      description: description?.trim() || '',
      reason:      reason || '',
      clientRef:   isClient ? (clientRef?.trim() || '')  : null,
      supplierRef: isClient ? null : (supplierRef?.trim() || ''),
      identifiedDate:  identifiedDate  || '',
      submittedDate:   submittedDate   || '',
      responseDueDate: responseDueDate || '',
      effectiveDate:   effectiveDate   || '',
      lineItems,
      submittedSubtotal: submitted.subtotal,
      submittedGst:      submitted.gst,
      submittedTotal:    submitted.total,
      notes: notes?.trim() || '',
    })
  }, [companyId, projectId, user])

  // Lifecycle transitions. Moving to approved requires per-line approvedAmount
  // values (unbounded — above/below/zero/negative allowed) and assessment notes
  // when any differ from submitted; approved amounts and totals freeze forever.
  // Legality is client-checked (server enforcement is deferred, matching the
  // rest of the app).
  const transitionStatus = useCallback(async (variation, nextStatus, { approvedAmounts, assessmentNotes } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(variation.status, nextStatus)) {
      throw new Error(`Cannot move a ${variation.status} variation to ${nextStatus}`)
    }
    const ref   = doc(db, 'companies', companyId, 'projects', projectId, 'variations', variation.id)
    const today = todayIso()

    if (nextStatus === VARIATION_STATUS.APPROVED) {
      const validationError = validateApprovedAmounts(variation.lineItems, approvedAmounts, assessmentNotes)
      if (validationError) throw new Error(validationError)
      const lineItems = buildApprovedLineItems(variation.lineItems, approvedAmounts)
      const approved  = variationTotals(lineItems, 'approved')
      await updateDoc(ref, {
        status:           VARIATION_STATUS.APPROVED,
        lineItems,
        approvedSubtotal: approved.subtotal,
        approvedGst:      approved.gst,
        approvedTotal:    approved.total,
        assessmentNotes:  assessmentNotes?.trim() || '',
        approvedDate:     variation.approvedDate || today,
        effectiveDate:    variation.effectiveDate || variation.approvedDate || today,
        approvedAt:       serverTimestamp(),
        approvedBy:       user.uid,
      })
      return
    }

    if (nextStatus === VARIATION_STATUS.SUBMITTED) {
      await updateDoc(ref, {
        status:      VARIATION_STATUS.SUBMITTED,
        submittedDate: variation.submittedDate || today,
        submittedAt: serverTimestamp(),
        submittedBy: user.uid,
      })
      return
    }

    if (nextStatus === VARIATION_STATUS.REJECTED) {
      await updateDoc(ref, {
        status:      VARIATION_STATUS.REJECTED,
        rejectedAt:  serverTimestamp(),
        rejectedBy:  user.uid,
        ...(assessmentNotes?.trim() ? { assessmentNotes: assessmentNotes.trim() } : {}),
      })
      return
    }

    if (nextStatus === VARIATION_STATUS.WITHDRAWN) {
      await updateDoc(ref, {
        status:      VARIATION_STATUS.WITHDRAWN,
        withdrawnAt: serverTimestamp(),
        withdrawnBy: user.uid,
      })
      return
    }

    throw new Error(`Unsupported transition to ${nextStatus}`)
  }, [companyId, projectId, user])

  return { variations, variationsLoading, createVariation, updateVariation, transitionStatus }
}
