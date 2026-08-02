import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { collection, doc, onSnapshot, addDoc, updateDoc, serverTimestamp, query, orderBy, Timestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { isKnownCurrencyCode, resolveCompanyCurrency } from '../lib/currency'

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

  const createProject = useCallback(async ({ name, status, budget, startDate, location, progress, currency }) => {
    if (!companyId || !user) throw new Error('Not authenticated')

    // A project always stores an EXPLICIT currency, inherited from the company
    // base currency and overridable at creation. Storing it (rather than
    // resolving through the company forever) is what stops a later company
    // currency change from relabelling this project's amounts.
    const projectCurrency = isKnownCurrencyCode(currency)
      ? currency
      : resolveCompanyCurrency(company)

    const headlineBudget = Number(budget) || 0

    const col = collection(db, 'companies', companyId, 'projects')
    await addDoc(col, {
      name:      name.trim(),
      status,
      budget:    headlineBudget,
      startDate: startDate ? Timestamp.fromDate(new Date(startDate)) : null,
      location:  location.trim(),
      progress:  Math.min(100, Math.max(0, Number(progress) || 0)),
      currency:  projectCurrency,
      // A non-zero headline budget IS monetary data, so the currency must be
      // right at creation — it locks immediately, exactly as a budget line or
      // purchase order would lock it.
      currencyLocked: headlineBudget > 0,
      createdAt: serverTimestamp(),
      createdBy: user.uid,
    })
  }, [companyId, user, company])

  // Change a project's currency BEFORE it holds any monetary data.
  //
  // The caller (ProjectOverview's currency card) owns the live financial
  // snapshots and evaluates `isProjectCurrencyLocked` before offering the
  // control — that record-based check is CLIENT-side and cannot be moved into
  // Firestore rules, which cannot enumerate random-ID subcollections. This hook
  // re-checks the ratchet flag, and Firestore rules reject the write outright
  // once `currencyLocked` is true. See docs/SECURITY.md → Deferred Controls.
  const updateProjectCurrency = useCallback(async (projectId, currency) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!isKnownCurrencyCode(currency)) {
      throw new Error('Select a currency from the list.')
    }
    const project = projects.find(p => p.id === projectId)
    if (project?.currencyLocked === true) {
      throw new Error(
        'Project currency is locked — this project already has financial records. ' +
        'Currency can only be changed before any headline budget, budget line, purchase order, ' +
        'progress claim, supplier invoice, variation, forecast input, or commercial baseline exists.',
      )
    }
    await updateDoc(doc(db, 'companies', companyId, 'projects', projectId), { currency })
  }, [companyId, user, projects])

  // REPAIR path only. Hooks that write monetary data do NOT call this — they
  // engage the ratchet inside their own transaction via
  // `projectCurrencyLock.stageProjectCurrencyLock`, so the record and the lock
  // commit atomically and a project can never hold amounts with a
  // still-changeable currency.
  //
  // This standalone write exists solely to heal projects whose monetary data
  // predates the Company Country & Currency foundation (or predates the atomic
  // lock): Project Overview calls it once when it sees live financial records
  // but no flag. It is best-effort because it repairs history rather than
  // accompanying a write — there is nothing for it to fail alongside.
  //
  // The write is deliberately a lone `currencyLocked: true` field: Firestore
  // rules grant `qs` a narrowly-scoped ratchet permission that requires the
  // update to affect that key and nothing else (qs must not gain general
  // project write access). Adding audit stamps here would force that rule to be
  // widened, so the lock carries none — the ratchet is one-way and its scope is
  // rules-enforced, which is the control that matters.
  const lockProjectCurrency = useCallback(async (projectId) => {
    if (!companyId || !projectId || !user) return
    const project = projects.find(p => p.id === projectId)
    if (project?.currencyLocked === true) return
    try {
      await updateDoc(doc(db, 'companies', companyId, 'projects', projectId), { currencyLocked: true })
    } catch {
      // Non-fatal — see above.
    }
  }, [companyId, user, projects])

  return (
    <ProjectsContext.Provider
      value={{ projects, projectsLoading, createProject, updateProjectCurrency, lockProjectCurrency }}
    >
      {children}
    </ProjectsContext.Provider>
  )
}

export function useProjects() {
  return useContext(ProjectsContext)
}
