import { useEffect, useState, useCallback, useMemo } from 'react'
import { collection, doc, onSnapshot, addDoc, updateDoc, serverTimestamp, query, orderBy } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { buildCostCodeFields, validateCostCode } from '../lib/costCodes'

export function useCostCodes() {
  const { user }    = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null

  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, and
  // costCodes/loading are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // The target is the COMPANY alone — cost codes are company-scoped, so
  // switching project neither re-subscribes nor reloads them.
  //
  // `error` is EXPOSED as `costCodesError` (ADR-55; closes ADR-41 Decision 3):
  // a rules rejection or connection loss must never present as an empty list,
  // because consumers turn an empty list into "create your first…" prompts and
  // disabled authoring. Like every financial hook it is derived only once the
  // CURRENT target has settled, so a company switch never flashes a stale flag.
  const [snap, setSnap] = useState({ key: null, costCodes: [], error: false })

  useEffect(() => {
    if (!companyId) return undefined

    const key = companyId
    const ref = collection(db, 'companies', companyId, 'costCodes')
    const q   = query(ref, orderBy('code', 'asc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        costCodes: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection) — degrade gracefully rather
      // than crashing every cost-code picker in the app.
      () => setSnap({ key, costCodes: [], error: true }),
    )
    return unsubscribe
  }, [companyId])

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no data, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // hides a previous company's cost codes immediately.
  const targetKey = companyId || null
  const settled = targetKey !== null && snap.key === targetKey
  // Memoised so the write callbacks below (which validate the duplicate-code
  // rule against the live list) keep stable dependencies across renders —
  // the same reason useSupplierCreditNotes / useRetentionReleases memoise.
  const costCodes = useMemo(
    () => (settled ? snap.costCodes : []),
    [settled, snap.costCodes],
  )
  const costCodesLoading = targetKey !== null && !settled
  const costCodesError = settled ? snap.error : false

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
    costCodesError,
    createCostCode,
    updateCostCode,
    deactivateCostCode,
    reactivateCostCode,
  }
}
