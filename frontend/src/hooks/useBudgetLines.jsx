import { useEffect, useState, useCallback } from 'react'
import { collection, doc, onSnapshot, runTransaction, serverTimestamp, query, orderBy } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { stageProjectCurrencyLock } from './projectCurrencyLock'

export function useBudgetLines(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const [budgetLines, setBudgetLines]             = useState([])
  const [budgetLinesLoading, setBudgetLinesLoading] = useState(true)
  // True when the live read failed (connection loss or a rules rejection).
  // Consumers deriving financial figures must treat a failed read as
  // UNAVAILABLE — never as a genuine zero. Set only from the async snapshot
  // callbacks; existing consumers may ignore it.
  const [budgetLinesError, setBudgetLinesError]   = useState(false)

  const companyId = company?.id ?? null

  useEffect(() => {
    if (!companyId || !projectId) {
      setBudgetLines([])
      setBudgetLinesLoading(false)
      return
    }

    setBudgetLinesLoading(true)
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'budgetLines')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setBudgetLines(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })))
        setBudgetLinesLoading(false)
        setBudgetLinesError(false)
      },
      () => {
        setBudgetLines([])
        setBudgetLinesLoading(false)
        setBudgetLinesError(true)
      }
    )
    return unsubscribe
  }, [companyId, projectId])

  const createBudgetLine = useCallback(async ({ costCodeId, costCodeName, budgeted, notes }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const lineRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'budgetLines'))

    // A budget line is monetary data, so the project currency ratchet is engaged
    // in the SAME transaction as the line — the two succeed or fail together and
    // the project can never end up holding amounts with a still-changeable
    // currency. (A transaction rather than addDoc/writeBatch because the lock
    // write depends on reading the project's current lock state.)
    await runTransaction(db, async (tx) => {
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(lineRef, {
        costCodeId,
        costCodeName,
        budgeted:  Number(budgeted) || 0,
        committed: 0,
        actual:    0,
        invoiced:  0,
        notes:     notes?.trim() || '',
        createdAt: serverTimestamp(),
        createdBy: user.uid,
      })
      commitLock()
    })
  }, [companyId, projectId, user])

  return { budgetLines, budgetLinesLoading, budgetLinesError, createBudgetLine }
}
