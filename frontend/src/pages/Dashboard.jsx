import { useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Card from '../components/Card'
import Stat from '../components/Stat'
import Badge from '../components/Badge'
import Btn from '../components/Btn'
import ProgBar from '../components/ProgBar'
import { formatCurrency, formatDate } from '../lib/formatters'
import { resolveProjectCurrency } from '../lib/currency'
import { isFinancialRole } from '../lib/margin'
import { projectsListState, projectStatusCounts, PROJECTS_LIST_STATE } from '../lib/projects'
import { selectSnapshotProjectId } from '../lib/projectSnapshot'
import { useAuth, getDisplayName } from '../hooks/useAuth'
import { useProfile } from '../hooks/useProfile'
import { useCompany } from '../hooks/useCompany'
import { useProjects } from '../hooks/useProjects'
import ProjectSnapshot from './dashboard/ProjectSnapshot'

// ⚠️ NOTHING ON THIS PAGE IS FABRICATED.
//
// This Dashboard previously carried a "Project Financial Overview" bar chart
// (six months of Budget / Actual / Forecast), a "Task Progress" donut with a
// hardcoded 72% complete, and three invented KPIs (Pending POs 5, Budget
// Utilization 68%, Upcoming Tasks 29). Every one of those was a literal in
// this file, rendered as though it were the company's data — the exact thing
// the product must never do with financial information.
//
// Dashboard Analytics (ADR-42) brought real analytics back in two layers:
//
//   · PORTFOLIO — project counts and a status breakdown, read from the existing
//     projects subscription. Zero new listeners and NO money: projects may be in
//     different currencies and Constrapp never converts, so there is no
//     portfolio monetary total anywhere on this page.
//   · ONE SELECTED PROJECT — the Project Snapshot, for financial roles only.
//     The selection lives in the URL (`?project=<id>`). The snapshot's
//     subscriptions are opened by the ProjectSnapshot CHILD, which is not
//     rendered at all for other roles — so a subcontractor or client never
//     issues those reads. Every figure is an existing domain selector's output
//     (lib/projectSnapshot.js); this page performs no financial arithmetic.

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
  const activeCount   = projects.filter(p => p.status === 'In Progress').length
  const totalCount    = projects.length

  const listState     = projectsListState({ loading: projectsLoading, error: projectsError, count: totalCount })
  const statusCounts  = projectStatusCounts(projects)

  // Financial roles only — the UX mirror of the Firestore rules, which are the
  // enforced boundary. While the profile is loading the role is unknown, so
  // nothing is mounted.
  const canViewSnapshot = isFinancialRole(profile?.role)

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

  // Both derived from the live projects subscription. `Active` is the count of
  // projects whose status is 'In Progress' — a descriptive status, not a
  // lifecycle (ADR-39).
  const kpis = [
    { label: 'Active Projects', value: String(activeCount), icon: '🏗', sub: `${totalCount} total` },
    { label: 'Total Projects',  value: String(totalCount),  icon: '📁' },
  ]

  return (
    <div className="max-w-[1280px]">
      {/* Welcome */}
      <div className="mb-[22px]">
        <h2 className="text-[22px] font-black text-brand-text m-0">Welcome, {displayName} 👋</h2>
        <p className="text-[13px] text-brand-muted mt-1 m-0">{companyName ? `${companyName} · ` : ''}{today}</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3.5 mb-3.5 lg:max-w-[620px]">
        {kpis.map((k) => (
          <Card key={k.label}>
            <Stat {...k} />
          </Card>
        ))}
      </div>

      {/* Portfolio status strip — counts only, from the projects subscription.
          Not shown while the list is loading or unavailable: zero counts there
          would be a false fact. */}
      {(listState === PROJECTS_LIST_STATE.READY || listState === PROJECTS_LIST_STATE.EMPTY) && (
        <Card className="mb-[22px]">
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] m-0 mb-2.5">Projects by status</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {statusCounts.byStatus.map(({ status, count }) => (
              <div key={status} className="flex items-center justify-between gap-2 min-w-0">
                <Badge label={status} sm />
                <span className="text-[15px] font-bold text-brand-text tabular-nums">{count}</span>
              </div>
            ))}
            {statusCounts.other > 0 && (
              <div className="flex items-center justify-between gap-2 min-w-0">
                <Badge label="Other status" variant="soon" sm />
                <span className="text-[15px] font-bold text-brand-text tabular-nums">{statusCounts.other}</span>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Project Snapshot — ONE selected project, financial roles only. The
          child mounts the financial subscriptions; it is keyed by project so a
          switch can never show the previous project's figures. */}
      {canViewSnapshot && selectedProject && (
        <div ref={snapshotRef} tabIndex={-1} className="mb-[22px] scroll-mt-4 focus:outline-none">
          <div className="flex flex-wrap items-center gap-2 mb-2.5">
            <label htmlFor="snapshot-project" className="text-[12px] font-semibold text-brand-muted">Project</label>
            <select
              id="snapshot-project"
              className="bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px] max-w-full"
              value={selectedProject.id}
              onChange={(e) => selectProject(e.target.value)}
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <ProjectSnapshot
            key={selectedProject.id}
            project={selectedProject}
            currencyCode={resolveProjectCurrency(selectedProject, company)}
          />
        </div>
      )}

      {/* Projects table — every project, not only the active ones, which is
          why the heading is "Projects". */}
      <Card padding={false}>
        <div className="flex items-center justify-between px-5 py-4">
          <h3 className="text-[15px] font-bold text-brand-text m-0">Projects</h3>
          <Btn sm onClick={() => navigate('/projects')}>View All ▾</Btn>
        </div>
        {listState === PROJECTS_LIST_STATE.LOADING ? (
          <div className="px-5 py-8 text-center text-[13px] text-brand-muted">Loading projects…</div>
        ) : listState === PROJECTS_LIST_STATE.UNAVAILABLE ? (
          <div className="px-5 py-8 text-center">
            <p className="m-0 text-[13px] font-semibold text-brand-amber">Projects unavailable</p>
            <p className="m-0 mt-1 text-[12px] text-brand-muted">
              Your projects could not be loaded. This is not an empty list — check your connection and access, then reload.
            </p>
          </div>
        ) : listState === PROJECTS_LIST_STATE.EMPTY ? (
          <div className="px-5 py-8 text-center text-[13px] text-brand-muted">No projects yet. Head to Projects to create one.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[1040px]">
              <thead>
                <tr className="border-b border-brand-border">
                  {['', 'Project Name', 'Status', 'Headline Budget', 'Progress', 'Currency', 'Start Date', 'Actions'].map(h => (
                    <th
                      key={h}
                      className="text-left px-3 py-[7px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {projects.map(p => {
                  const currencyCode = resolveProjectCurrency(p, company)
                  const isSelected = canViewSnapshot && p.id === selectedId
                  return (
                    <tr
                      key={p.id}
                      className={`border-b border-brand-border hover:bg-brand-card transition-colors ${isSelected ? 'bg-brand-card' : ''}`}
                    >
                      <td className="px-3 py-[11px] pl-5">
                        <div className="w-7 h-7 rounded-md bg-brand-accent/10 flex items-center justify-center text-xs">🏗</div>
                      </td>
                      <td className="px-3 py-[11px] pl-1.5">
                        <p className="text-[13px] font-semibold text-brand-text m-0 leading-tight">{p.name}</p>
                        {p.location && (
                          <p className="text-[11px] text-brand-muted mt-0.5 m-0 leading-tight">{p.location}</p>
                        )}
                      </td>
                      <td className="px-3 py-[11px]">
                        <Badge label={p.status} sm />
                      </td>
                      {/* The HEADLINE budget — set at creation, reporting
                          metadata only; it is not the Approved Budget (ADR-39). */}
                      <td className="px-3 py-[11px] text-[13px] font-semibold text-brand-text-soft">
                        {p.budget ? formatCurrency(p.budget, currencyCode) : '—'}
                      </td>
                      {/* Manually REPORTED progress — not earned value and not
                          financial completion. */}
                      <td className="px-3 py-[11px] min-w-[120px]">
                        <div className="flex items-center gap-2">
                          <div className="flex-1"><ProgBar value={p.progress ?? 0} /></div>
                          <span className="text-[11px] text-brand-muted w-8 text-right">{p.progress ?? 0}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-[11px] text-[12px] font-semibold text-brand-muted">{currencyCode}</td>
                      <td className="px-3 py-[11px] text-[12px] text-brand-muted">{formatDate(p.startDate)}</td>
                      <td className="px-3 py-[11px]">
                        <div className="flex items-center gap-1.5">
                          {canViewSnapshot && (
                            <Btn variant="ghost" sm onClick={() => showSnapshot(p.id)}>
                              {isSelected ? 'In snapshot' : 'Snapshot'}
                            </Btn>
                          )}
                          <Btn variant="ghost" sm onClick={() => navigate(`/projects/${p.id}/overview`)}>View ▾</Btn>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
