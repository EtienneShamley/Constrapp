import { useEffect, useState, useCallback } from 'react'
import { doc, onSnapshot, runTransaction, serverTimestamp, Timestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { stageProjectCurrencyLock } from './projectCurrencyLock'

// The Project Commercial Baseline — the ONLY authored inputs of the Project
// Margin foundation. It lives in a dedicated single-document subcollection
// keyed by a DETERMINISTIC id ('baseline'), NOT on the Project document: the
// Project doc is company-member readable (subcontractors/clients can read it),
// but contract value, client identity, and implied margin are commercially
// sensitive and must be financial-role-only reads. Firestore rules restrict the
// commercial collection to exactly this one document id.
//
// Stored inputs only: originalContractValue, originalApprovedBudget (number|null),
// contractStartDate/contractCompletionDate (Timestamp|null), clientId/clientName,
// notes, and audit stamps. Current Contract Sum, Forecast Revenue, Forecast
// Gross Profit, margin percentages, and Margin Movement are ALL derived at read
// time in lib/margin.js — never written here.
export const COMMERCIAL_BASELINE_DOC_ID = 'baseline'

function commercialBaselineRef(companyId, projectId) {
  return doc(
    db,
    'companies', companyId,
    'projects', projectId,
    'commercial', COMMERCIAL_BASELINE_DOC_ID,
  )
}

export function useProjectCommercial(projectId) {
  const { user } = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null

  // Live subscription state, tagged with the target (`key`) it belongs to. The
  // effect is subscription-only: state is written ONLY from the onSnapshot
  // callbacks (the sanctioned "subscribe to an external system" pattern), never
  // synchronously in the effect body — so the exposed baseline/loading/error are
  // derived at render time below instead of set via a synchronous effect update
  // (react-hooks/set-state-in-effect).
  const [snap, setSnap] = useState({ key: null, baseline: null, error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = commercialBaselineRef(companyId, projectId)
    const unsubscribe = onSnapshot(
      ref,
      (doc) => setSnap({ key, baseline: doc.exists() ? { id: doc.id, ...doc.data() } : null, error: false }),
      // Read error (e.g. missing doc or rules rejection) — degrade gracefully.
      () => setSnap({ key, baseline: null, error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no data, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // handles resetting stale state when switching projects.
  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const baseline = settled ? snap.baseline : null
  const baselineLoading = targetKey !== null && !settled
  // True when the live read failed — most often a rules rejection for a
  // non-financial role. The UI degrades gracefully (mirrors useProfile).
  const baselineError = settled ? snap.error : false

  // Idempotent upsert of the single baseline document. A transaction sets
  // createdAt/createdBy only on first creation and always refreshes
  // updatedAt/updatedBy, preserving provenance across edits. Dates arrive as
  // 'YYYY-MM-DD' strings (or '') and are converted to Timestamps here so pages
  // never import firebase/* (hooks-only Firestore access). It writes the
  // baseline document and — in the same transaction — the project's
  // `currencyLocked` ratchet flag (an established baseline is monetary data).
  // It never touches Budget Lines, POs, Claims, Supplier Invoices, Variations,
  // or Forecast Lines, and never any financial value on the project.
  const saveBaseline = useCallback(async ({
    originalContractValue,
    originalApprovedBudget,
    contractStartDate,
    contractCompletionDate,
    clientId,
    clientName,
    notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const ocv = Number(originalContractValue)
    if (!Number.isFinite(ocv) || ocv < 0) {
      throw new Error('Original Contract Value must be a number of 0 or more')
    }

    // number | null — null means the Original Approved Budget baseline has not
    // been established. Never silently populated.
    let oab = originalApprovedBudget
    if (oab === '' || oab === undefined || oab === null) {
      oab = null
    } else {
      oab = Number(oab)
      if (!Number.isFinite(oab) || oab < 0) {
        throw new Error('Original Approved Budget must be blank or a number of 0 or more')
      }
    }

    const startTs = contractStartDate ? Timestamp.fromDate(new Date(contractStartDate)) : null
    const completionTs = contractCompletionDate
      ? Timestamp.fromDate(new Date(contractCompletionDate))
      : null

    const fields = {
      originalContractValue: ocv,
      originalApprovedBudget: oab,
      contractStartDate: startTs,
      contractCompletionDate: completionTs,
      clientId: clientId || null,
      clientName: (clientName || '').trim() || null,
      notes: (notes ?? '').trim(),
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    }

    const ref = commercialBaselineRef(companyId, projectId)
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref)
      // An established baseline carries the Original Contract Value — monetary
      // data — so the currency ratchet is engaged IN THIS TRANSACTION and the
      // two succeed or fail together. Firestore requires all transaction reads
      // before any writes, hence the staged read here.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      if (snap.exists()) {
        // Preserve createdAt/createdBy; refresh inputs + audit.
        tx.update(ref, fields)
      } else {
        tx.set(ref, {
          ...fields,
          createdAt: serverTimestamp(),
          createdBy: user.uid,
        })
      }
      commitLock()
    })
  }, [companyId, projectId, user])

  return { baseline, baselineLoading, baselineError, saveBaseline }
}
