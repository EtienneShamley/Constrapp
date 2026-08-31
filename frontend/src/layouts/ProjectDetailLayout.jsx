import { NavLink, Outlet, useParams } from 'react-router-dom'
import Badge from '../components/Badge'
import { formatCurrency } from '../lib/formatters'
import { useProject } from '../hooks/useProject'
import { useCompany } from '../hooks/useCompany'
import { resolveProjectCurrency } from '../lib/currency'
import { PROJECT_TABS } from '../lib/projectTabs'

export default function ProjectDetailLayout() {
  const { projectId } = useParams()
  const { project, projectLoading } = useProject(projectId)
  const { company } = useCompany()

  // Resolved ONCE here and handed to every project tab through the outlet
  // context, so no page resolves a currency for itself and no page can drift.
  const currencyCode = resolveProjectCurrency(project, company)

  if (projectLoading) {
    return <div className="text-[13px] text-brand-muted">Loading project…</div>
  }

  if (!project) {
    return <div className="text-[13px] text-brand-muted">Project not found.</div>
  }

  return (
    <div className="max-w-[1280px]">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-semibold text-brand-text">{project.name}</h1>
          <p className="text-sm text-brand-muted mt-0.5">
            {project.location ? `${project.location} · ` : ''}
            {/* The HEADLINE budget — the figure captured when the project was
                created. It is reporting metadata and feeds no derivation; the
                live Approved Budget is the sum of the project's budget lines on
                the Budget tab. Labelled so the two are never confused (ADR-39). */}
            {project.budget
              ? <>Headline Budget {formatCurrency(project.budget, currencyCode)}</>
              : '—'}
            <span className="ml-2 text-[11px] font-semibold text-brand-muted">{currencyCode}</span>
          </p>
        </div>
        <Badge label={project.status} />
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-brand-border mb-5">
        {PROJECT_TABS.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `px-3 py-2 text-[12.5px] font-semibold rounded-t-lg border-b-2 -mb-px transition-colors
               ${isActive ? 'text-brand-accent border-brand-accent' : 'text-brand-muted border-transparent hover:text-brand-text'}`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      <Outlet context={{ project, projectId, currencyCode }} />
    </div>
  )
}
