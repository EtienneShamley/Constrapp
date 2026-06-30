import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { collection, onSnapshot, addDoc, serverTimestamp, query, orderBy, Timestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'

const ProjectsContext = createContext(null)

export function ProjectsProvider({ children }) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const [projects, setProjects]             = useState([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  const companyId = company?.id ?? null

  useEffect(() => {
    if (!companyId) {
      setProjects([])
      setProjectsLoading(false)
      return
    }

    setProjectsLoading(true)
    const ref = collection(db, 'companies', companyId, 'projects')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setProjects(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })))
        setProjectsLoading(false)
      },
      () => {
        setProjects([])
        setProjectsLoading(false)
      }
    )
    return unsubscribe
  }, [companyId])

  const createProject = useCallback(async ({ name, status, budget, startDate, location, progress }) => {
    if (!companyId || !user) throw new Error('Not authenticated')
    const col = collection(db, 'companies', companyId, 'projects')
    await addDoc(col, {
      name:      name.trim(),
      status,
      budget:    Number(budget) || 0,
      startDate: startDate ? Timestamp.fromDate(new Date(startDate)) : null,
      location:  location.trim(),
      progress:  Math.min(100, Math.max(0, Number(progress) || 0)),
      createdAt: serverTimestamp(),
      createdBy: user.uid,
    })
  }, [companyId, user])

  return (
    <ProjectsContext.Provider value={{ projects, projectsLoading, createProject }}>
      {children}
    </ProjectsContext.Provider>
  )
}

export function useProjects() {
  return useContext(ProjectsContext)
}
