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
import { roundMoney } from '../lib/purchaseOrders'
import {
  CFL_STATUS, CFL_BASIS_GROSS, CFL_SOURCE_TYPE,
  currentMonthKey, isCostCodedSourceType, validateCashFlowLineDraft,
} from '../lib/cashFlow'

// ── Cash Flow timing lines (manual longer-term forecast inputs) ──────────────
//
// A cashFlowLine is an AUTHORED monthly timing input: an expected GROSS cash
// amount (`amount`) in a chosen month, optionally representing an ex-GST source
// value (`sourceAmountExGst`, completeness only). It is a planning record, not
// a transaction — there is NO counter, NO sequential number, NO posted status.
// Lifecycle: active → active (edit) or active → void (terminal), both
// rules-enforced; delete is blocked.
//
// This hook writes ONLY cashFlowLine documents (plus the project currency
// ratchet, inside the create transaction). It NEVER mutates client invoices,
// supplier invoices, receipts, payments, POs, claims, variations, forecast
// lines, budget lines, or the commercial baseline — every forecast figure is
// derived at read time in lib/cashFlow.js.
//
// ⚠️ THE NO-PAST-MONTH RULE IS CLIENT-ENFORCED. Firestore rules validate the
// YYYY-MM shape of monthKey but have no calendar to compare against, so a
// direct SDK call could create a past-month line. In the app, creating a line
// in a past month — or editing/retiming one into a past month — is blocked
// here; existing lines become stale naturally as the calendar advances and are
// then retimed forward or voided.
export function useCashFlowLines(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD.
  const projectCurrency = resolveProjectCurrency(project, company)

  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the same derived-loading pattern as useSupplierPayments/useClientReceipts.
  const [snap, setSnap] = useState({ key: null, lines: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'cashFlowLines')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        lines: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully rather than crashing the page.
      () => setSnap({ key, lines: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const cashFlowLines = settled ? snap.lines : []
  const cashFlowLinesLoading = targetKey !== null && !settled
  const cashFlowLinesError = settled ? snap.error : false

  // Normalises the authored fields into the stored shape. `manual` lines carry
  // sourceAmountExGst: null (no coverage); coverage types store a rounded
  // number. Non-cost-coded types store costCodeId: null + costCodeName ''.
  const buildFields = (input) => {
    const isManual = input.sourceType === CFL_SOURCE_TYPE.MANUAL
    const costCoded = isCostCodedSourceType(input.sourceType)
    return {
      monthKey:  input.monthKey,
      direction: input.direction,
      // Every Branch-2 line is a GROSS cash amount. Adding another basis
      // requires a rules change and its own security review.
      basis:     CFL_BASIS_GROSS,
      amount:    roundMoney(Number(input.amount)),
      sourceAmountExGst: isManual ? null : roundMoney(Number(input.sourceAmountExGst)),
      sourceType: input.sourceType,
      // Frozen human labels — never keys, never re-read from a source document.
      sourceRef:        (input.sourceRef || '').trim(),
      counterpartyName: (input.counterpartyName || '').trim(),
      // The cost-code spine link for cost-side sources (frozen name snapshot);
      // contract revenue and manual adjustments sit above the spine.
      costCodeId:   costCoded ? input.costCodeId : null,
      costCodeName: costCoded ? (input.costCodeName || '').trim() : '',
      description: (input.description || '').trim(),
      notes:       (input.notes || '').trim(),
    }
  }

  // Creates an ACTIVE timing line. There is no counter, so the transaction
  // exists purely to stage the project currency ratchet atomically (ADR-21): a
  // timing line is monetary data in the project currency, so the FIRST line
  // locks the currency, and a failed create writes neither line nor lock.
  // Already-locked projects stage a no-op, which keeps the narrow `qs` rule
  // (currencyLocked false→true only) satisfied for QS users.
  const createCashFlowLine = useCallback(async (input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateCashFlowLineDraft(input, currentMonthKey())
    if (validationError) throw new Error(validationError)

    const lineRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'cashFlowLines'))

    await runTransaction(db, async (tx) => {
      // Read phase first (Firestore requires all reads before any writes).
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(lineRef, {
        ...buildFields(input),
        status: CFL_STATUS.ACTIVE,

        // Audit snapshot of the project currency at write time — never read
        // for display (the project currency is the display authority).
        currency: projectCurrency,
        revision: 1,

        // Lifecycle audit stamps. Rules require these null at create.
        voidReason: '',
        voidedAt:   null,
        voidedBy:   null,

        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
      commitLock()
    })
    return lineRef.id
  }, [companyId, projectId, user, projectCurrency])

  // Active-only edits — including retiming a stale line FORWARD (the draft
  // validation rejects any past monthKey, so a stale line can only move to the
  // current month or later, or be voided). The currency, creation stamps,
  // basis, and revision are never written here — and rules reject an update
  // that changes any of them.
  const updateCashFlowLine = useCallback(async (lineDoc, input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (lineDoc.status !== CFL_STATUS.ACTIVE) throw new Error('Only active timing lines can be edited')

    const validationError = validateCashFlowLineDraft(input, currentMonthKey())
    if (validationError) throw new Error(validationError)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'cashFlowLines', lineDoc.id)
    await updateDoc(ref, {
      ...buildFields(input),
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  // Voiding is terminal and requires a non-whitespace reason — by this hook
  // AND by Firestore rules. Lines are never deleted (ADR-12): a voided line is
  // retained forecast history (and remains currency-lock evidence), it simply
  // contributes nothing to any month, coverage, or peak-funding figure.
  const voidCashFlowLine = useCallback(async (lineDoc, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (lineDoc.status !== CFL_STATUS.ACTIVE) throw new Error('Only active timing lines can be voided')
    const reason = (voidReason || '').trim()
    if (!reason) throw new Error('Enter a reason for voiding this timing line')

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'cashFlowLines', lineDoc.id)
    await updateDoc(ref, {
      status:     CFL_STATUS.VOID,
      voidedAt:   serverTimestamp(),
      voidedBy:   user.uid,
      voidReason: reason,
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
  }, [companyId, projectId, user])

  return {
    cashFlowLines,
    cashFlowLinesLoading,
    cashFlowLinesError,
    createCashFlowLine,
    updateCashFlowLine,
    voidCashFlowLine,
  }
}
