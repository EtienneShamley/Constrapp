import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Btn from '../components/Btn'
import Badge from '../components/Badge'
import ProgBar from '../components/ProgBar'
import { currency } from '../lib/formatters'

const projects = [
  { name: 'Lakeside Apartments',      status: 'In Progress', budget: 3_903_006, start: '01/09/2023', location: 'Brisbane QLD',   pct: 67 },
  { name: 'Westfield Office Tower',   status: 'Backlogged',  budget: 9_700_000, start: '01/09/2023', location: 'Sydney NSW',     pct: 27 },
  { name: 'Greenview Retail Complex', status: 'In Progress', budget: 1_056_000, start: '01/03/2023', location: 'Melbourne VIC',  pct: 78 },
  { name: 'Sunset Villas',            status: 'In Progress', budget: 1_050_000, start: '01/07/2023', location: 'Gold Coast QLD', pct: 28 },
  { name: 'North Shore Residential',  status: 'In Progress', budget: 4_200_000, start: '15/06/2023', location: 'Sydney NSW',     pct: 57 },
]

const dotColors = {
  'In Progress': '#00C9A7',
  'Backlogged':  '#F59E0B',
  'Planning':    '#3B82F6',
  'Completed':   '#00C9A7',
}

export default function Projects() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title="Projects" sub={`${projects.length} projects · Apex Builders`}>
        <Btn>+ Add New Project</Btn>
      </PageHeader>

      <Card padding={false}>
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-brand-card border-b border-brand-border">
              {['', 'Project Name', 'Status', 'Budget', 'Start Date', 'Progress', 'Actions'].map(h => (
                <th
                  key={h}
                  className="text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map(p => (
              <tr key={p.name} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                <td className="py-3 pl-4 pr-1.5">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ background: dotColors[p.status] ?? '#546E84' }}
                  />
                </td>
                <td className="px-3.5 py-3">
                  <p className="text-[13px] font-semibold text-brand-text m-0 leading-tight">{p.name}</p>
                  <p className="text-[11px] text-brand-muted mt-0.5 m-0 leading-tight">📍 {p.location}</p>
                </td>
                <td className="px-3.5 py-3">
                  <Badge label={p.status} sm />
                </td>
                <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text">
                  {currency(p.budget)}
                </td>
                <td className="px-3.5 py-3 text-[12px] text-brand-muted">{p.start}</td>
                <td className="px-3.5 py-3 min-w-[110px]">
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1">
                      <ProgBar value={p.pct} />
                    </div>
                    <span className="text-[10px] text-brand-muted w-7 text-right">{p.pct}%</span>
                  </div>
                </td>
                <td className="px-3.5 py-3">
                  <Btn variant="ghost" sm>View ▾</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
