import { createContext, useContext, useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useProfile } from './useProfile'

const CompanyContext = createContext(null)

export function CompanyProvider({ children }) {
  const { profile } = useProfile()
  const [company, setCompany]             = useState(null)
  const [companyLoading, setCompanyLoading] = useState(true)

  useEffect(() => {
    const companyId = profile?.companyId
    if (!companyId) {
      setCompany(null)
      setCompanyLoading(false)
      return
    }

    setCompanyLoading(true)
    const ref = doc(db, 'companies', companyId)
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        setCompany(snap.exists() ? { id: snap.id, ...snap.data() } : null)
        setCompanyLoading(false)
      },
      () => {
        // Firestore read error — degrade gracefully
        setCompany(null)
        setCompanyLoading(false)
      }
    )
    return unsubscribe
  }, [profile?.companyId])

  return (
    <CompanyContext.Provider value={{ company, companyLoading }}>
      {children}
    </CompanyContext.Provider>
  )
}

export function useCompany() {
  return useContext(CompanyContext)
}
