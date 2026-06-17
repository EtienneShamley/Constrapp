import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Btn from '../components/Btn'
import Badge from '../components/Badge'
import ProgBar from '../components/ProgBar'
import { currency } from '../lib/formatters'

const projects = [
  { name: 'Harbour Edge Apartments',    status: 'active',    progress: 74, budget: 3_200_000, manager: 'J. Brennan',  location: 'Sydney NSW' },
  { name: 'Westfield Fitout — Level 3', status: 'active',    progress: 42, budget: 890_000,   manager: 'S. Nguyen',   location: 'Parramatta NSW' },
  { name: 'North Shore Townhouses',     status: 'pending',   progress: 8,  budget: 1_450_000,  manager: 'E. Shamley',  location: 'Chatswood NSW' },
  { name: 'CBD Office Refurb',          status: 'active',    progress: 91, budget: 560_000,    manager: 'R. Patel',    location: 'Melbourne VIC' },
  { name: 'Bondi Retail Strip',         status: 'completed', progress: 100, budget: 720_000,   manager: 'J. Brennan',  location: 'Bondi NSW' },
]

const statusVariant = { active: 'active', pending: 'pending', completed: 'completed' }

export default function Projects() {
  return (
    <div>
      <PageHeader title="Projects" sub="All projects across your portfolio">
        <Btn variant="ghost" disabled className="opacity-40 cursor-not-allowed">+ New Project — Coming Soon</Btn>
      </PageHeader>

      <div className="grid gap-4">
        {projects.map((p) => (
          <Card key={p.name} className="hover:bg-brand-card transition-colors cursor-pointer">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-brand-text">{p.name}</span>
                  <Badge label={p.status} variant={statusVariant[p.status]} />
                </div>
                <p className="text-xs text-brand-muted">{p.location} · PM: {p.manager}</p>
                <div className="mt-2">
                  <ProgBar value={p.progress} />
                  <p className="text-xs text-brand-muted mt-1">{p.progress}% complete</p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-semibold text-brand-text">{currency(p.budget)}</p>
                <p className="text-xs text-brand-muted">budget</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
