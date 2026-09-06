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
import { PO_STATUS, canTransition, poTotals, formatPoNumber, lineTotal, validatePoDraft } from '../lib/purchaseOrders'

export function usePurchaseOrders(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, so
  // purchaseOrders/loading/error are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // `error` is true when the live read failed (connection loss or a rules
  // rejection). Consumers deriving financial figures MUST treat a failed read
  // as UNAVAILABLE — never as a genuine zero. It is exposed only once the
  // CURRENT target has settled, so a project switch never flashes a stale
  // unavailable banner under the new project.
  const [snap, setSnap] = useState({ key: null, purchaseOrders: [], error: false })

  const companyId = company?.id ?? null

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'purchaseOrders')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        purchaseOrders: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read must NOT look like an empty register — "none" and "we
      // could not load them" are opposite facts, and confusing them on a
      // financial register fabricates a zero.
      () => setSnap({ key, purchaseOrders: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no data, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // hides the previous project's rows immediately.
  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const purchaseOrders = settled ? snap.purchaseOrders : []
  const purchaseOrdersLoading = targetKey !== null && !settled
  const purchaseOrdersError = settled ? snap.error : false

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

  // Draft-only edits (ADR-36) — authored content freezes once a PO leaves
  // draft. Only description, notes and the line items may change: every
  // lineTotal is rebuilt here (a caller-supplied figure is never trusted) and
  // the header subtotal/gst/total are re-derived by the existing poTotals.
  // Supplier identity (supplierId/supplierName), poNumber, status, currency,
  // revision, lifecycle stamps, externalRefs and createdAt/createdBy are never
  // written — updateDoc is partial, so they pass through untouched. No currency
  // ratchet: the project locked when this PO was created. The draft guard is
  // client-side only (rules do not check status — Deferred Control 2).
  const updatePurchaseOrder = useCallback(async (po, { description, notes, lineItems }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (po.status !== PO_STATUS.DRAFT) throw new Error('Only draft purchase orders can be edited')
    const validationError = validatePoDraft({ lineItems })
    if (validationError) throw new Error(validationError)
    const lines = lineItems.map(li => ({ ...li, lineTotal: lineTotal(li.qty, li.unitPrice) }))
    const { subtotal, gst, total } = poTotals(lines)
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'purchaseOrders', po.id)
    await updateDoc(ref, {
      description: description?.trim() || '',
      notes:       notes?.trim() || '',
      lineItems:   lines,
      subtotal,
      gst,
      total,
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

  return { purchaseOrders, purchaseOrdersLoading, purchaseOrdersError, createPurchaseOrder, updatePurchaseOrder, transitionStatus }
}
