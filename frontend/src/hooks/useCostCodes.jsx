import { useEffect, useState, useCallback } from 'react'
import { collection, onSnapshot, addDoc, serverTimestamp, query, orderBy } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'

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

  const createCostCode = useCallback(async ({ code, name, category, unit }) => {
    if (!companyId || !user) throw new Error('Not authenticated')
    const col = collection(db, 'companies', companyId, 'costCodes')
    await addDoc(col, {
      code:      code.trim(),
      name:      name.trim(),
      category:  category?.trim() || '',
      unit:      unit?.trim() || '',
      isActive:  true,
      createdAt: serverTimestamp(),
      createdBy: user.uid,
    })
  }, [companyId, user])

  return { costCodes, costCodesLoading, createCostCode }
}
