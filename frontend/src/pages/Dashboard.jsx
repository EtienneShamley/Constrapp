import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts'
import Card from '../components/Card'
import Stat from '../components/Stat'
import Badge from '../components/Badge'
import Btn from '../components/Btn'
import { currency } from '../lib/formatters'

const chartData = [
  { mo: 'Jan', budget: 280, actual: 210, forecast: 310 },
  { mo: 'Feb', budget: 300, actual: 280, forecast: 320 },
  { mo: 'Mar', budget: 320, actual: 290, forecast: 330 },
  { mo: 'Apr', budget: 310, actual: 305, forecast: 340 },
  { mo: 'May', budget: 350, actual: 320, forecast: 345 },
  { mo: 'Jun', budget: 380, actual: 355, forecast: 370 },
]

const donutData = [
  { name: 'Completed',   value: 34, color: '#00C9A7' },
  { name: 'In Progress', value: 41, color: '#3B82F6'  },
  { name: 'Pending',     value: 25, color: '#EF4444'  },
]

const kpis = [
  { label: 'Active Projects',    value: '4',   icon: '🏗', sub: '4 total'                          },
  { label: 'Pending POs',        value: '5',   icon: '📋'                                          },
  { label: 'Budget Utilization', value: '68%', icon: '💰', sub: '$2.46M of $3.6M'                  },
  { label: 'Upcoming Tasks',     value: '29',  icon: '⚡', color: '#F59E0B', sub: 'across projects' },
]

const projects = [
  { name: 'Lakeside Apartments',      status: 'In Progress', budget: 3_903_006, start: '01/09/2023', location: 'Brisbane QLD'   },
  { name: 'Westfield Office Tower',   status: 'Backlogged',  budget: 9_700_000, start: '01/09/2023', location: 'Sydney NSW'     },
  { name: 'Greenview Retail Complex', status: 'In Progress', budget: 1_056_000, start: '01/03/2023', location: 'Melbourne VIC'  },
  { name: 'Sunset Villas',            status: 'In Progress', budget: 1_050_000, start: '01/07/2023', location: 'Gold Coast QLD' },
]

const today = new Date().toLocaleDateString('en-AU', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
})

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#162C42', border: '1px solid #1E3248', borderRadius: 8, padding: '8px 12px' }}>
      <p style={{ color: '#546E84', fontSize: 11, fontWeight: 700, margin: '0 0 4px' }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.fill, fontSize: 11, fontWeight: 600, margin: '2px 0' }}>
          {p.name}: {p.value}k
        </p>
      ))}
    </div>
  )
}

export default function Dashboard() {
  return (
    <div className="max-w-[1280px]">
      {/* Welcome */}
      <div className="mb-[22px]">
        <h2 className="text-[22px] font-black text-brand-text m-0">Welcome, Etienne S 👋</h2>
        <p className="text-[13px] text-brand-muted mt-1 m-0">Apex Builders · {today}</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mb-[22px]">
        {kpis.map((k) => (
          <Card key={k.label}>
            <Stat {...k} />
          </Card>
        ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-3.5 mb-3.5">
        {/* Financial bar chart */}
        <Card>
          <div className="flex items-center justify-between mb-3.5">
            <h3 className="text-[15px] font-bold text-brand-text m-0">Project Financial Overview</h3>
            <div className="flex gap-2.5">
              {[['Budget', '#3B82F6'], ['Actual', '#00C9A7'], ['Forecast', '#F59E0B']].map(([l, c]) => (
                <div key={l} className="flex items-center gap-1">
                  <div className="w-2.5 h-2.5 rounded-sm" style={{ background: c }} />
                  <span className="text-brand-muted text-[10px]">{l}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="h-[190px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <XAxis dataKey="mo" tick={{ fill: '#546E84', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#546E84', fontSize: 10 }} axisLine={false} tickLine={false} unit="k" />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="budget"   fill="#3B82F6" radius={[4, 4, 0, 0]} name="Budget"   barSize={16} />
                <Bar dataKey="actual"   fill="#00C9A7" radius={[4, 4, 0, 0]} name="Actual"   barSize={16} />
                <Bar dataKey="forecast" fill="#F59E0B" radius={[4, 4, 0, 0]} name="Forecast" barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Task progress donut */}
        <Card>
          <h3 className="text-[15px] font-bold text-brand-text m-0 mb-4">Task Progress</h3>
          <div className="relative w-[140px] h-[140px] mx-auto mb-3.5">
            <PieChart width={140} height={140}>
              <Pie
                data={donutData}
                cx={65}
                cy={65}
                innerRadius={44}
                outerRadius={62}
                dataKey="value"
                strokeWidth={0}
              >
                {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
            </PieChart>
            <div className="absolute inset-0 flex items-center justify-center flex-col pointer-events-none">
              <span className="text-[24px] font-black text-brand-text leading-none">72%</span>
              <span className="text-[10px] text-brand-muted mt-0.5">Complete</span>
            </div>
          </div>
          {donutData.map(d => (
            <div key={d.name} className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ background: d.color }} />
                <span className="text-[12px] text-brand-text-soft">{d.name}</span>
              </div>
              <span className="text-[12px] font-bold text-brand-text">{d.value}%</span>
            </div>
          ))}
        </Card>
      </div>

      {/* Active projects table */}
      <Card padding={false}>
        <div className="flex items-center justify-between px-5 py-4">
          <h3 className="text-[15px] font-bold text-brand-text m-0">Active Projects</h3>
          <Btn sm>+ Add New Project</Btn>
        </div>
        <table className="w-full border-collapse">
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
              <tr key={p.name} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                <td className="px-3 py-[11px] pl-5">
                  <div className="w-7 h-7 rounded-md bg-brand-accent/10 flex items-center justify-center text-xs">🏗</div>
                </td>
                <td className="px-3 py-[11px] pl-1.5">
                  <p className="text-[13px] font-semibold text-brand-text m-0 leading-tight">{p.name}</p>
                  <p className="text-[11px] text-brand-muted mt-0.5 m-0 leading-tight">{p.location}</p>
                </td>
                <td className="px-3 py-[11px]">
                  <Badge label={p.status} sm />
                </td>
                <td className="px-3 py-[11px] text-[13px] font-semibold text-brand-text-soft">
                  {currency(p.budget)}
                </td>
                <td className="px-3 py-[11px] text-[12px] text-brand-muted">{p.start}</td>
                <td className="px-3 py-[11px]">
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
