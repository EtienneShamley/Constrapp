import { useNavigate } from 'react-router-dom'
import Card from '../components/Card'
import Stat from '../components/Stat'
import Badge from '../components/Badge'
import Btn from '../components/Btn'
import { formatCurrency, formatDate } from '../lib/formatters'
import { resolveProjectCurrency } from '../lib/currency'
import { useAuth, getDisplayName } from '../hooks/useAuth'
import { useProfile } from '../hooks/useProfile'
import { useCompany } from '../hooks/useCompany'
import { useProjects } from '../hooks/useProjects'

// ⚠️ NOTHING ON THIS PAGE IS FABRICATED.
//
// This Dashboard previously carried a "Project Financial Overview" bar chart
// (six months of Budget / Actual / Forecast), a "Task Progress" donut with a
// hardcoded 72% complete, and three invented KPIs (Pending POs 5, Budget
// Utilization 68%, Upcoming Tasks 29). Every one of those was a literal in
// this file, rendered as though it were the company's data — the exact thing
// the product must never do with financial information.
//
// They are gone rather than rederived: a portfolio-level financial rollup is
// real work with its own design, and duplicating Forecast / Commercial / Cash
// Flow logic to fill cards would put a second, drifting derivation next to the
// authoritative one. A sparse truthful Dashboard is the correct state until
// that foundation lands. Every value below reads from Firestore.

const today = new Date().toLocaleDateString('en-AU', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
})

export default function Dashboard() {
  const navigate                    = useNavigate()
  const { user }                     = useAuth()
  const { profile }                  = useProfile()
  const { company }                  = useCompany()
  const { projects, projectsLoading } = useProjects()

  const displayName   = profile?.name || getDisplayName(user)
  const companyName   = company?.name ?? null
  const activeCount   = projects.filter(p => p.status === 'In Progress').length
  const totalCount    = projects.length

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
      <div className="grid grid-cols-2 gap-3.5 mb-[22px] lg:max-w-[620px]">
        {kpis.map((k) => (
          <Card key={k.label}>
            <Stat {...k} />
          </Card>
        ))}
      </div>

      {/* Projects table — every project, not only the active ones, which is
          why the heading is "Projects". */}
      <Card padding={false}>
        <div className="flex items-center justify-between px-5 py-4">
          <h3 className="text-[15px] font-bold text-brand-text m-0">Projects</h3>
          <Btn sm onClick={() => navigate('/projects')}>View All ▾</Btn>
        </div>
        {projectsLoading ? (
          <div className="px-5 py-8 text-center text-[13px] text-brand-muted">Loading projects…</div>
        ) : projects.length === 0 ? (
          <div className="px-5 py-8 text-center text-[13px] text-brand-muted">No projects yet. Head to Projects to create one.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[820px]">
              <thead>
                <tr className="border-b border-brand-border">
                  {['', 'Project Name', 'Status', 'Budget', 'Start Date', 'Actions'].map(h => (
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
                {projects.map(p => (
                  <tr key={p.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
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
                    <td className="px-3 py-[11px] text-[13px] font-semibold text-brand-text-soft">
                      {p.budget ? formatCurrency(p.budget, resolveProjectCurrency(p, company)) : '—'}
                    </td>
                    <td className="px-3 py-[11px] text-[12px] text-brand-muted">{formatDate(p.startDate)}</td>
                    <td className="px-3 py-[11px]">
                      <Btn variant="ghost" sm onClick={() => navigate(`/projects/${p.id}/overview`)}>View ▾</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
