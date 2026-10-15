import { useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { resolveProjectCurrency } from '../lib/currency'
import { isFinancialRole } from '../lib/margin'
import { canReadProgramme } from '../lib/projectTimeline'
import { portfolioSummary } from '../lib/projects'
import { selectSnapshotProjectId } from '../lib/projectSnapshot'
import { useAuth, getDisplayName } from '../hooks/useAuth'
import { useProfile } from '../hooks/useProfile'
import { useCompany } from '../hooks/useCompany'
import { useProjects } from '../hooks/useProjects'
import PortfolioSummary from './dashboard/PortfolioSummary'
import ProjectSnapshot from './dashboard/ProjectSnapshot'
import ProgrammePanel from './dashboard/ProgrammePanel'
import ProjectRegister from './dashboard/ProjectRegister'

// ⚠️ NOTHING ON THIS PAGE IS FABRICATED.
//
// This Dashboard previously carried a "Project Financial Overview" bar chart
// (six months of Budget / Actual / Forecast), a "Task Progress" donut with a
// hardcoded 72% complete, and three invented KPIs (Pending POs 5, Budget
// Utilization 68%, Upcoming Tasks 29). Every one of those was a literal in
// this file, rendered as though it were the company's data — the exact thing
// the product must never do with financial information.
//
// Dashboard Analytics (ADR-42) brought real analytics back, and Dashboard v2
// (ADR-45) rebuilt the presentation around them, in three layers:
//
//   · PORTFOLIO — project counts and a status breakdown, read from the existing
//     projects subscription (lib/projects.js → portfolioSummary). Zero new
//     listeners and NO money: projects may be in different currencies and
//     Constrapp never converts. Counts are null — rendered "—" or
//     "Unavailable" — until the read settles, never a false 0.
//   · ONE SELECTED PROJECT — the Project Snapshot, for financial roles only.
//     The selection lives in the URL (`?project=<id>`). The snapshot's
//     subscriptions are opened by the ProjectSnapshot CHILD, which is not
//     rendered at all for other roles — so a subcontractor or client never
//     issues those reads. Every figure is an existing domain selector's output
//     (lib/projectSnapshot.js); this page performs no financial arithmetic.
//   · PROGRAMME — the selected project's activity counts (ADR-29 timeline),
//     opened by the ProgrammePanel CHILD behind its own `canReadProgramme`
//     gate. One subscription; non-financial; no completion percentage.

const today = new Date().toLocaleDateString('en-AU', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
})

export default function Dashboard() {
  const navigate                    = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const snapshotRef                 = useRef(null)
  const { user }                     = useAuth()
  const { profile }                  = useProfile()
  const { company }                  = useCompany()
  const { projects, projectsLoading, projectsError } = useProjects()

  const displayName   = profile?.name || getDisplayName(user)
  const companyName   = company?.name ?? null

  // Counts only, and only once the read has settled (null → "—"/Unavailable).
  const portfolio     = portfolioSummary({ projects, loading: projectsLoading, error: projectsError })

  // Financial roles only — the UX mirror of the Firestore rules, which are the
  // enforced boundary. While the profile is loading the role is unknown, so
  // nothing is mounted.
  const canViewSnapshot = isFinancialRole(profile?.role)
  // The programme read audience (company_admin / project_manager / qs), the UX
  // mirror of the `activities` rules block.
  const canViewProgramme = canReadProgramme(profile?.role)

  // The URL is the selection. An unknown or absent id falls back to the first
  // 'In Progress' project in the subscription's existing order, then to the
  // first project — the URL itself is only written when the user selects.
  const selectedId      = selectSnapshotProjectId(projects, searchParams.get('project'))
  const selectedProject = selectedId ? projects.find(p => p.id === selectedId) ?? null : null

  const selectProject = (projectId) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('project', projectId)
      return next
    }, { replace: true })
  }

  const showSnapshot = (projectId) => {
    selectProject(projectId)
    snapshotRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    snapshotRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="max-w-[1280px]">
      {/* Welcome */}
      <div className="mb-5">
        <h2 className="m-0 text-[22px] font-black text-brand-text sm:text-[24px]">Welcome, {displayName} 👋</h2>
        <p className="m-0 mt-1 text-[13px] text-brand-muted">{companyName ? `${companyName} · ` : ''}{today}</p>
      </div>

      <PortfolioSummary summary={portfolio} />

      {/* Project Snapshot — ONE selected project, financial roles only. The
          child mounts the financial subscriptions; it is keyed by project so a
          switch can never show the previous project's figures. */}
      {canViewSnapshot && selectedProject && (
        <section
          ref={snapshotRef}
          tabIndex={-1}
          aria-label="Selected project snapshot"
          className="mb-6 scroll-mt-4 focus:outline-none"
        >
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="m-0 text-[11px] font-bold uppercase tracking-[0.5px] text-brand-text-soft">
              Project financials · one project, its own currency
            </h2>
            <div className="flex min-w-0 items-center gap-2">
              <label htmlFor="snapshot-project" className="shrink-0 text-[12px] font-semibold text-brand-muted">Project</label>
              <select
                id="snapshot-project"
                className="min-h-[44px] w-full min-w-0 rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none sm:w-auto sm:max-w-[320px]"
                value={selectedProject.id}
                onChange={(e) => selectProject(e.target.value)}
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
          <ProjectSnapshot
            key={selectedProject.id}
            project={selectedProject}
            currencyCode={resolveProjectCurrency(selectedProject, company)}
            aside={canViewProgramme ? <ProgrammePanel key={selectedProject.id} projectId={selectedProject.id} /> : null}
          />
        </section>
      )}

      {/* Every project, not only the active ones, which is why the heading is
          "Projects". */}
      <ProjectRegister
        projects={projects}
        listState={portfolio.listState}
        company={company}
        canViewSnapshot={canViewSnapshot}
        selectedId={selectedId}
        onSnapshot={showSnapshot}
        onOpen={(projectId) => navigate(`/projects/${projectId}/overview`)}
        onViewAll={() => navigate('/projects')}
      />
    </div>
  )
}
