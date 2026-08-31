import { useEffect, useState, useCallback } from 'react'
import { collection, doc, onSnapshot, addDoc, updateDoc, serverTimestamp, query, orderBy } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { buildCostCodeFields, validateCostCode } from '../lib/costCodes'

export function useCostCodes() {
  const { user }    = useAuth()
  const { company } = useCompany()
  const [costCodes, setCostCodes]             = useState([])
  const [costCodesLoading, setCostCodesLoading] = useState(true)

  const companyId = company?.id ?? null

  useEffect(() => {
    if (!companyId) {
      setCostCodes([])
      setCostCodesLoading(false)
      return
    }

    setCostCodesLoading(true)
    const ref = collection(db, 'companies', companyId, 'costCodes')
    const q   = query(ref, orderBy('code', 'asc'))

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setCostCodes(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })))
        setCostCodesLoading(false)
      },
      () => {
        setCostCodes([])
        setCostCodesLoading(false)
      }
    )
    return unsubscribe
  }, [companyId])

  // Create normalises and validates through the SAME pure helpers the edit path
  // uses, so the two modes cannot drift. The only behaviour change from the
  // original inline create is the duplicate-code check (client-side only — see
  // updateCostCode below); trimming is identical.
  const createCostCode = useCallback(async (data) => {
    if (!companyId || !user) throw new Error('Not authenticated')

    const fields = buildCostCodeFields(data)
    const validationError = validateCostCode(fields, { costCodes })
    if (validationError) throw new Error(validationError)

    const col = collection(db, 'companies', companyId, 'costCodes')
    await addDoc(col, {
      ...fields,
      isActive:  true,
      createdAt: serverTimestamp(),
      createdBy: user.uid,
    })
  }, [companyId, user, costCodes])

  // Correct a cost code's CONTENT after creation (ADR-39).
  //
  // ⚠️ NO HISTORICAL DOCUMENT IS TOUCHED. Budget lines, PO lines, claim lines,
  // supplier-invoice lines, credit-note lines, variation lines, BOQ items,
  // forecast lines and cash-flow lines all froze a `costCodeName` display
  // string at write time; a rename does NOT rewrite any of them, because those
  // snapshots record what the code was called when the commitment was made.
  // Screens that should show the correction resolve it at READ TIME instead
  // (lib/costCodes.js → resolveCostCodeName), exactly as Forecast and BOQ
  // already did. There is no backfill and no migration.
  //
  // ⚠️ NO FINANCIAL FIGURE MOVES. Every derivation groups by `costCodeId`;
  // `code` and `name` are display only.
  //
  // `isActive` is NOT written here — it belongs to setCostCodeActive below, so
  // a content edit can never flip a code's availability as a side effect. The
  // duplicate-code check is CLIENT-SIDE ONLY (rules have no queries) and the
  // caller supplies the live list; see docs/SECURITY.md → Deferred Control 28.
  const updateCostCode = useCallback(async (costCode, data) => {
    if (!companyId || !user) throw new Error('Not authenticated')
    if (!costCode?.id) throw new Error('Unknown cost code')

    const fields = buildCostCodeFields(data)
    const validationError = validateCostCode(fields, {
      costCodes,
      excludeId: costCode.id,
    })
    if (validationError) throw new Error(validationError)

    await updateDoc(doc(db, 'companies', companyId, 'costCodes', costCode.id), {
      ...fields,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, user, costCodes])

  // Deactivate / reactivate — administrative and REVERSIBLE, not a financial
  // lifecycle (the useContacts archive/reactivate pattern). Deletes stay
  // blocked by rules; deactivation is the supported way to retire a code.
  //
  // Deactivating changes NOTHING that already exists: the code keeps its budget
  // lines, commitments, actuals and invoices, every total is unchanged, and
  // lib/forecast.js / lib/boq.js flag the row `isInactive` rather than dropping
  // it. It removes the code from NEW authoring only.
  const setCostCodeActive = useCallback(async (costCode, isActive) => {
    if (!companyId || !user) throw new Error('Not authenticated')
    if (!costCode?.id) throw new Error('Unknown cost code')
    await updateDoc(doc(db, 'companies', companyId, 'costCodes', costCode.id), {
      isActive,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, user])

  const deactivateCostCode = useCallback((costCode) => setCostCodeActive(costCode, false), [setCostCodeActive])
  const reactivateCostCode = useCallback((costCode) => setCostCodeActive(costCode, true),  [setCostCodeActive])

  return {
    costCodes,
    costCodesLoading,
    createCostCode,
    updateCostCode,
    deactivateCostCode,
    reactivateCostCode,
  }
}
