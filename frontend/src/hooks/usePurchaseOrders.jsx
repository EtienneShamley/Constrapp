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
import { PO_STATUS, canTransition, poTotals, formatPoNumber } from '../lib/purchaseOrders'

export function usePurchaseOrders(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  const [purchaseOrders, setPurchaseOrders]               = useState([])
  const [purchaseOrdersLoading, setPurchaseOrdersLoading] = useState(true)

  const companyId = company?.id ?? null

  useEffect(() => {
    if (!companyId || !projectId) {
      setPurchaseOrders([])
      setPurchaseOrdersLoading(false)
      return
    }

    setPurchaseOrdersLoading(true)
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'purchaseOrders')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setPurchaseOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })))
        setPurchaseOrdersLoading(false)
      },
      () => {
        setPurchaseOrders([])
        setPurchaseOrdersLoading(false)
      }
    )
    return unsubscribe
  }, [companyId, projectId])

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD for records predating the
  // Company Country & Currency foundation.
  const projectCurrency = resolveProjectCurrency(project, company)

  // Creates a draft PO. The company-wide counter is read and incremented in the
  // same transaction as the PO write so concurrent users never share a number.
  const createPurchaseOrder = useCallback(async ({ supplierName, supplierId, description, notes, lineItems }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const counterRef = doc(db, 'companies', companyId, 'counters', 'purchaseOrders')
    const poRef      = doc(collection(db, 'companies', companyId, 'projects', projectId, 'purchaseOrders'))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this po and the project lock succeed or fail
      // together — the project can never hold amounts with a still-changeable
      // currency. Firestore requires all transaction reads before any writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      const { subtotal, gst, total } = poTotals(lineItems)
      tx.set(poRef, {
        poNumber:    formatPoNumber(next),
        status:      PO_STATUS.DRAFT,
        supplierName: supplierName.trim(),
        supplierId:  supplierId || null,
        description: description?.trim() || '',
        lineItems,
        subtotal,
        gst,
        total,
        // Audit snapshot of the currency this PO was raised in (the frozen
        // supplierName/costCodeName idiom). The PROJECT currency remains the
        // display authority — this field is never read for rendering, so a
        // project can never show mixed currencies. Historical documents keep
        // their stored 'AUD' and are never rewritten.
        currency:    projectCurrency,
        revision:    1,
        notes:       notes?.trim() || '',
        sentAt:      null,
        closedAt:    null,
        cancelledAt: null,
        externalRefs: {},
        createdAt:   serverTimestamp(),
        createdBy:   user.uid,
      })
      commitLock()
    })
  }, [companyId, projectId, user, projectCurrency])

  // Draft-only edits — amounts and lines are frozen once a PO leaves draft.
  const updatePurchaseOrder = useCallback(async (po, { supplierName, supplierId, description, notes, lineItems }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (po.status !== PO_STATUS.DRAFT) throw new Error('Only draft purchase orders can be edited')
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'purchaseOrders', po.id)
    const { subtotal, gst, total } = poTotals(lineItems)
    await updateDoc(ref, {
      supplierName: supplierName.trim(),
      supplierId:  supplierId || null,
      description: description?.trim() || '',
      lineItems,
      subtotal,
      gst,
      total,
      notes:       notes?.trim() || '',
    })
  }, [companyId, projectId, user])

  const transitionStatus = useCallback(async (po, nextStatus) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(po.status, nextStatus)) {
      throw new Error(`Cannot move a ${po.status} purchase order to ${nextStatus}`)
    }
    const stampField = {
      [PO_STATUS.SENT]:      'sentAt',
      [PO_STATUS.CLOSED]:    'closedAt',
      [PO_STATUS.CANCELLED]: 'cancelledAt',
    }[nextStatus]
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'purchaseOrders', po.id)
    await updateDoc(ref, {
      status: nextStatus,
      ...(stampField ? { [stampField]: serverTimestamp() } : {}),
    })
  }, [companyId, projectId, user])

  return { purchaseOrders, purchaseOrdersLoading, createPurchaseOrder, updatePurchaseOrder, transitionStatus }
}
