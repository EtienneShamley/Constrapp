import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react'
import { collection, doc, onSnapshot, updateDoc, writeBatch, serverTimestamp, query, orderBy, Timestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { useProfile } from './useProfile'
import { useProjectDirectory } from './useProjectDirectory'
import { currencyToPinOnLock, isKnownCurrencyCode, resolveCompanyCurrency } from '../lib/currency'
import {
  buildProjectFields, validateProjectEdit, projectDirectoryFields,
  readsProjectDocuments, readsAssignedProjects, assignedProjectIds,
} from '../lib/projects'

const ProjectsContext = createContext(null)

export function ProjectsProvider({ children }) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { profile } = useProfile()
  const companyId = company?.id ?? null

  // M2-A2 — WHICH read this caller may open (lib/projects.js). Internal roles
  // subscribe to the project documents below, exactly as before. A client or
  // subcontractor never reads a project document: their list comes from the
  // directory entries of their ASSIGNED projects (useProjectDirectory). Any
  // other role, and a role not yet known, opens nothing.
  // ⚠️ Query selection only — Firestore rules refuse the project documents to
  // a non-internal role and an unassigned directory entry to everyone external.
  const role = profile?.role ?? null
  const internalCompanyId = readsProjectDocuments(role) ? companyId : null
  const assignedIds = useMemo(() => assignedProjectIds(profile), [profile])
  const {
    directory, directoryLoading, directoryError, directoryErrorCode, directoryFromCache, retryDirectory,
  } = useProjectDirectory(readsAssignedProjects(role) ? companyId : null, assignedIds)

  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, so
  // projects/loading are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // The target is the COMPANY alone (for an internal role; null otherwise, so
  // nothing is subscribed). ⚠️ THIS IS A ROOT PROVIDER: `projects`
  // feeds useProject, which gates the ENTIRE project route tree through
  // ProjectDetailLayout ("Loading project…" / "Project not found."). The
  // `targetKey`/`key` expressions below must stay identical — if they ever
  // diverge, `settled` never becomes true and every project page loads forever.
  //
  // `error` is exposed as `projectsError` (Dashboard Analytics, ADR-42) — an
  // ADDITIVE field on the context value; every existing field is unchanged. A
  // failed read still yields an empty `projects` array (so every existing
  // consumer behaves exactly as before), but a consumer that renders "no
  // projects" must check `projectsError` first: "none" and "could not load
  // them" are opposite facts.
  //
  // L3 Stage 2 — three ADDITIVE fields, so the project route can tell a failed
  // or unconfirmed read from a missing project (lib/projects.js →
  // projectLoadState):
  //   · `readCode`   the Firestore code of a failed read ('permission-denied', …)
  //   · `fromCache`  the snapshot has not been confirmed by the server. With an
  //     unreachable backend the SDK delivers an EMPTY cached list, which is not
  //     "no projects". `includeMetadataChanges` is what delivers the follow-up
  //     snapshot when the server confirms a list whose documents did not change.
  //   · `attempt`    bumped by `retryProjects` to re-open a listener that ended
  //     with an error (an errored listener never recovers by itself). It lives
  //     in this tuple, not in a second useState, to keep the keyed-snapshot
  //     pattern; resetting `key` to null returns the route to "loading".
  const [snap, setSnap] = useState({ key: null, projects: [], error: false, readCode: null, fromCache: false, attempt: 0 })
  const attempt = snap.attempt

  useEffect(() => {
    if (!internalCompanyId) return undefined

    const key = internalCompanyId
    const ref = collection(db, 'companies', internalCompanyId, 'projects')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (querySnap) => setSnap({
        key,
        projects: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
        readCode: null,
        fromCache: querySnap.metadata.fromCache === true,
        attempt,
      }),
      // Read error (most often a rules rejection) — degrade gracefully rather
      // than crashing the app root.
      (err) => setSnap({ key, projects: [], error: true, readCode: err?.code ?? null, fromCache: false, attempt }),
    )
    return unsubscribe
  }, [internalCompanyId, attempt])

  // Re-open the projects listener after a failed read. Reads only.
  const retryInternalProjects = useCallback(() => {
    setSnap((s) => (s.error
      ? { key: null, projects: [], error: false, readCode: null, fromCache: false, attempt: s.attempt + 1 }
      : s))
  }, [])

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no data, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // hides a previous company's projects immediately.
  const targetKey = internalCompanyId || null
  const settled = targetKey !== null && snap.key === targetKey
  // Memoised so the write callbacks below (which validate against the live
  // list) keep stable dependencies across renders.
  const internalProjects = useMemo(
    () => (settled ? snap.projects : []),
    [settled, snap.projects],
  )
  const internalLoading = targetKey !== null && !settled
  // Exposed only once the CURRENT target has settled, never raw (ADR-41).
  const internalError = settled ? snap.error : false
  const internalErrorCode = internalError ? snap.readCode : null
  const internalFromCache = settled && snap.fromCache === true

  // ONE list for every consumer, whichever source fed it. An assigned role's
  // entries carry the five directory fields only — no `budget`, no `currency`.
  const assigned = readsAssignedProjects(role)
  const projects          = assigned ? directory          : internalProjects
  const projectsLoading   = assigned ? directoryLoading   : internalLoading
  const projectsError     = assigned ? directoryError     : internalError
  const projectsErrorCode = assigned ? directoryErrorCode : internalErrorCode
  const projectsFromCache = assigned ? directoryFromCache : internalFromCache
  const retryProjects     = assigned ? retryDirectory     : retryInternalProjects

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

    // M2-A2 — the project and its DIRECTORY ENTRY (the external-safe copy of the
    // five display fields) are written in ONE batch: rules refuse a project
    // created without a matching entry, and an entry that differs from the
    // project, so the two cannot drift.
    const fields = {
      name:      name.trim(),
      status,
      startDate: startDate ? Timestamp.fromDate(new Date(startDate)) : null,
      location:  location.trim(),
      progress:  Math.min(100, Math.max(0, Number(progress) || 0)),
    }
    const ref   = doc(collection(db, 'companies', companyId, 'projects'))
    const batch = writeBatch(db)
    batch.set(ref, {
      ...fields,
      budget:    headlineBudget,
      currency:  projectCurrency,
      // A non-zero headline budget IS monetary data, so the currency must be
      // right at creation — it locks immediately, exactly as a budget line or
      // purchase order would lock it.
      currencyLocked: headlineBudget > 0,
      createdAt: serverTimestamp(),
      createdBy: user.uid,
    })
    batch.set(doc(db, 'companies', companyId, 'projectDirectory', ref.id), projectDirectoryFields(fields))
    await batch.commit()
  }, [companyId, user, company])

  // Correct a project's METADATA after creation (ADR-39).
  //
  // Writes exactly `name`, `status`, `startDate`, `location` and `progress` —
  // the keys in PROJECT_EDITABLE_KEYS — and nothing else. It CANNOT write
  // `budget`, `currency`, `currencyLocked`, `createdAt` or `createdBy`: the
  // field list below is literal, not spread from the caller, so a caller
  // passing extra keys cannot smuggle them through. Firestore rules
  // independently freeze `budget`/`createdAt`/`createdBy` and enforce the
  // status enum, so this is the UX mirror of an enforced boundary.
  //
  // M2-A2 — ONE BATCH, TWO DOCUMENTS: the same five values go to the project
  // and to its directory entry (a `set`, so a project that pre-dates the
  // directory gains its entry on its first edit). Rules refuse either half
  // without the other.
  //
  // NO TRANSACTION AND NO CURRENCY RATCHET. Every other write path in the app
  // stages `stageProjectCurrencyLock` because it commits MONETARY data; this
  // one commits none. A name, a location, a start date, a progress percentage
  // and a status badge are financially inert — no budget, commitment, actual,
  // forecast, margin or cash-flow figure reads any of them — so there is
  // nothing here for the ratchet to protect, and no transaction is needed.
  //
  // `startDate` arrives as a 'YYYY-MM-DD' string (or '' / null to clear) and is
  // converted to a Timestamp here, because pages never import firebase/*.
  // Clearing writes NULL, restoring the exact state of a project created with
  // no start date.
  //
  // Concurrent editors are last-write-wins, as everywhere else in the app
  // (ADR-36) — there is no transaction and no version guard.
  const updateProject = useCallback(async (projectId, { name, status, startDate, location, progress }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const fields = buildProjectFields({ name, status, startDate, location, progress })
    const validationError = validateProjectEdit(fields)
    if (validationError) throw new Error(validationError)

    const stored = {
      name:      fields.name,
      status:    fields.status,
      startDate: fields.startDate ? Timestamp.fromDate(new Date(fields.startDate)) : null,
      location:  fields.location,
      progress:  fields.progress,
    }
    const batch = writeBatch(db)
    batch.update(doc(db, 'companies', companyId, 'projects', projectId), stored)
    batch.set(doc(db, 'companies', companyId, 'projectDirectory', projectId), projectDirectoryFields(stored))
    await batch.commit()
  }, [companyId, user])

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
  // The write carries NO audit stamps: Firestore rules grant `qs` a
  // narrowly-scoped ratchet permission that requires the update to affect
  // `currencyLocked` and nothing else (qs must not gain general project write
  // access). Adding stamps here would force that rule to be widened, so the
  // lock carries none — the ratchet is one-way and its scope is rules-enforced,
  // which is the control that matters.
  //
  // It DOES pin `currency` in the same write when the project has none, because
  // `currencyLocked` and `currency` are separate fields and locking without a
  // currency is exactly how a project ends up frozen with its amounts floating
  // on the company base currency. `currencyToPinOnLock` decides: it returns the
  // code the project is ALREADY displayed in, or null when the project is
  // already pinned (pinning again would relabel) or the company base currency
  // is not configured yet (the AUD display fallback is nobody's decision — that
  // project must stay repairable through Company Settings). Nothing is
  // converted or recalculated either way.
  //
  // The two-key write is attempted FIRST and falls back to the lone
  // `currencyLocked: true`, because the narrow `qs` rule rejects the two-key
  // diff. A `qs` opening the Overview must still engage the ratchet — pinning a
  // label is the repair, engaging the ratchet is the control, and the control
  // must never be lost to the repair.
  const lockProjectCurrency = useCallback(async (projectId) => {
    if (!companyId || !projectId || !user) return
    const project = projects.find(p => p.id === projectId)
    if (project?.currencyLocked === true) return
    const ref = doc(db, 'companies', companyId, 'projects', projectId)
    const pin = currencyToPinOnLock(project, company)
    try {
      if (pin) {
        try {
          await updateDoc(ref, { currencyLocked: true, currency: pin })
          return
        } catch {
          // Rejected — the caller is a `qs`, whose rule permits `currencyLocked`
          // alone. Fall through to the lock-only write below.
        }
      }
      await updateDoc(ref, { currencyLocked: true })
    } catch {
      // Non-fatal — see above.
    }
  }, [companyId, user, projects, company])

  return (
    <ProjectsContext.Provider
      value={{ projects, projectsLoading, projectsError, projectsErrorCode, projectsFromCache, retryProjects, createProject, updateProject, updateProjectCurrency, lockProjectCurrency }}
    >
      {children}
    </ProjectsContext.Provider>
  )
}

export function useProjects() {
  return useContext(ProjectsContext)
}
