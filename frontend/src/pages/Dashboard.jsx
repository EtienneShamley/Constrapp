import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import Card from '../components/Card'
import Stat from '../components/Stat'
import Badge from '../components/Badge'
import ProgBar from '../components/ProgBar'
import PageHeader from '../components/PageHeader'
import { currency, percent } from '../lib/formatters'

const kpis = [
  { label: 'Active Projects',  value: '12',               sub: '3 completing this month' },
  { label: 'Portfolio Budget', value: currency(8_400_000), sub: 'across all active projects' },
  { label: 'Total Spent',      value: currency(5_130_000), sub: percent(61.1) + ' of budget', accent: true },
  { label: 'Forecast Profit',  value: currency(980_000),   sub: 'blended margin 11.7%' },
]

const cashflowData = [
  { month: 'Jan', income: 420, expense: 310 },
  { month: 'Feb', income: 510, expense: 390 },
  { month: 'Mar', income: 480, expense: 360 },
  { month: 'Apr', income: 620, expense: 410 },
  { month: 'May', income: 590, expense: 440 },
  { month: 'Jun', income: 710, expense: 490 },
]

const projects = [
  { name: 'Harbour Edge Apartments',  status: 'active',    progress: 74, budget: 3_200_000, spent: 2_368_000 },
  { name: 'Westfield Fitout — Level 3', status: 'active',  progress: 42, budget: 890_000,   spent: 373_800 },
  { name: 'North Shore Townhouses',   status: 'pending',   progress: 8,  budget: 1_450_000,  spent: 116_000 },
  { name: 'CBD Office Refurb',        status: 'active',    progress: 91, budget: 560_000,    spent: 509_600 },
]

const statusVariant = { active: 'active', pending: 'pending', completed: 'completed' }

export default function Dashboard() {
  return (
    <div>
      <PageHeader title="Dashboard" sub="Portfolio overview — FY2025–26" />

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {kpis.map((k) => (
          <Card key={k.label}>
            <Stat {...k} />
          </Card>
        ))}
      </div>

      {/* Cashflow chart */}
      <Card className="mb-6">
        <p className="text-sm font-medium text-brand-muted mb-4 uppercase tracking-wider">Cashflow — 6 Month View ($k)</p>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={cashflowData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="incomeGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#00C9A7" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#00C9A7" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="expenseGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#EF4444" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#EF4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="month" tick={{ fill: '#546E84', fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#546E84', fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: '#162C42', border: '1px solid #1E3248', borderRadius: 8, color: '#E8F0F7' }}
                labelStyle={{ color: '#546E84' }}
              />
              <Area type="monotone" dataKey="income"  stroke="#00C9A7" fill="url(#incomeGrad)"  strokeWidth={2} dot={false} name="Income" />
              <Area type="monotone" dataKey="expense" stroke="#EF4444" fill="url(#expenseGrad)" strokeWidth={2} dot={false} name="Expenses" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Active projects */}
      <Card>
        <p className="text-sm font-medium text-brand-muted mb-4 uppercase tracking-wider">Active Projects</p>
        <div className="divide-y divide-brand-border">
          {projects.map((p) => (
            <div key={p.name} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium text-brand-text">{p.name}</span>
                <Badge label={p.status} variant={statusVariant[p.status]} />
              </div>
              <ProgBar value={p.progress} />
              <div className="flex justify-between mt-1 text-xs text-brand-muted">
                <span>{currency(p.spent)} spent</span>
                <span>{p.progress}% complete</span>
                <span>{currency(p.budget)} budget</span>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
