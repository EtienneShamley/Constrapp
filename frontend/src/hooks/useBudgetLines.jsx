import { useEffect, useState, useCallback } from 'react'
import { collection, onSnapshot, addDoc, serverTimestamp, query, orderBy } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'

export function useBudgetLines(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const [budgetLines, setBudgetLines]             = useState([])
  const [budgetLinesLoading, setBudgetLinesLoading] = useState(true)

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
      },
      () => {
        setBudgetLines([])
        setBudgetLinesLoading(false)
      }
    )
    return unsubscribe
  }, [companyId, projectId])

  const createBudgetLine = useCallback(async ({ costCodeId, costCodeName, budgeted, notes }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const col = collection(db, 'companies', companyId, 'projects', projectId, 'budgetLines')
    await addDoc(col, {
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
  }, [companyId, projectId, user])

  return { budgetLines, budgetLinesLoading, createBudgetLine }
}
