import { NavLink, Outlet, useParams } from 'react-router-dom'
import Badge from '../components/Badge'
import { formatCurrency } from '../lib/formatters'
import { useProject } from '../hooks/useProject'
import { useCompany } from '../hooks/useCompany'
import { useProfile } from '../hooks/useProfile'
import { resolveProjectCurrency } from '../lib/currency'
import { projectTabsFor } from '../lib/projectTabs'
import { ModuleMark } from '../components/ModuleMark'
import Btn from '../components/Btn'
import { PROJECT_LOAD_STATE, readsProjectDocuments } from '../lib/projects'

export default function ProjectDetailLayout() {
  const { projectId } = useParams()
  const { project, projectLoading, projectState, retryProject } = useProject(projectId)
  const { company } = useCompany()
  const { profile } = useProfile()
  // M2-A2: a client or subcontractor is given the project's directory entry,
  // which has no budget or currency — the headline line below would only ever
  // read "—" beside a currency that is not theirs to see. UX only; the rules
  // are what keep the project document from them.
  const internal = readsProjectDocuments(profile?.role)

  // Resolved ONCE here and handed to every project tab through the outlet
  // context, so no page resolves a currency for itself and no page can drift.
  const currencyCode = resolveProjectCurrency(project, company)

  if (projectLoading) {
    return <div className="text-[13px] text-brand-muted">Loading project…</div>
  }

  // L3 Stage 2: "not found" is said ONLY when the server's list was read and
  // this project is not in it. A refused, failed or unconfirmed read is a
  // different fact and gets its own wording and recovery.
  if (projectState === PROJECT_LOAD_STATE.PERMISSION_DENIED) {
    return (
      <ProjectNotice
        state={projectState}
        title="You do not have access to this company's projects"
        body="The server refused to list the projects. Your access may have changed — ask a Company Admin, or sign out and in again. Access is enforced by Firestore Security Rules."
        onRetry={retryProject}
      />
    )
  }
  if (projectState === PROJECT_LOAD_STATE.UNAVAILABLE) {
    return (
      <ProjectNotice
        state={projectState}
        title="This project could not be loaded"
        body="The projects could not be read from the server. This is a loading failure, not a missing project. Check your connection and try again."
        onRetry={retryProject}
      />
    )
  }
  if (projectState === PROJECT_LOAD_STATE.OFFLINE) {
    return (
      <ProjectNotice
        state={projectState}
        title="Waiting for the server"
        body="The server has not answered yet, so this project cannot be confirmed. It will appear by itself when the connection returns."
      />
    )
  }
  if (!project) {
    return <div data-project-state={PROJECT_LOAD_STATE.NOT_FOUND} className="text-[13px] text-brand-muted">Project not found.</div>
  }

  return (
    <div className="max-w-[1280px]">
      <div data-print-hide className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-semibold text-brand-text">{project.name}</h1>
          <p className="text-sm text-brand-muted mt-0.5">
            {project.location ? `${project.location} · ` : ''}
            {/* The HEADLINE budget — the figure captured when the project was
                created. It is reporting metadata and feeds no derivation; the
                live Approved Budget is the sum of the project's budget lines on
                the Budget tab. Labelled so the two are never confused (ADR-39). */}
            {internal && (
              <>
                {project.budget
                  ? <>Headline Budget {formatCurrency(project.budget, currencyCode)}</>
                  : '—'}
                <span className="ml-2 text-[11px] font-semibold text-brand-muted">{currencyCode}</span>
              </>
            )}
          </p>
        </div>
        <Badge label={project.status} />
      </div>

      <nav data-print-hide className="flex flex-wrap gap-1 border-b border-brand-border mb-5">
        {projectTabsFor(profile?.role).map(({ to, label, mark }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-semibold rounded-t-lg border-b-2 -mb-px transition-colors
               ${isActive ? 'text-brand-accent border-brand-accent' : 'text-brand-muted border-transparent hover:text-brand-text'}`
            }
          >
            {mark && <ModuleMark module={mark} />}
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Keyed by project (ADR-44): useProject derives from the already-loaded
          projects list, so a project switch never passes through the loading
          branch above — without the key, the same tab instance would carry its
          local state (e.g. unsaved Forecast edits keyed by company-wide cost
          code ids) into another project. Navigating between tabs or records
          WITHIN a project never changes the key. */}
      <Outlet key={projectId} context={{ project, projectId, currencyCode }} />
    </div>
  )
}

function ProjectNotice({ state, title, body, onRetry }) {
  return (
    <div data-project-state={state} role="alert" className="max-w-[560px]">
      <p className="text-[13px] font-semibold text-brand-text m-0">{title}</p>
      <p className="text-[12.5px] text-brand-muted m-0 mt-1">{body}</p>
      {onRetry && <Btn sm variant="ghost" type="button" className="mt-3" onClick={onRetry}>Try again</Btn>}
    </div>
  )
}
