import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Btn from '../components/Btn'
import Badge from '../components/Badge'
import ProgBar from '../components/ProgBar'
import { formatCurrency, formatDate } from '../lib/formatters'
import { useProjects } from '../hooks/useProjects'
import { useCompany } from '../hooks/useCompany'
import {
  CURRENCIES, resolveCompanyCurrency, resolveProjectCurrency,
  isCompanyCurrencyConfigured,
} from '../lib/currency'

const STATUS_OPTIONS = ['Planning', 'In Progress', 'Backlogged', 'On Hold', 'Completed']

const DOT_COLORS = {
  'In Progress': '#00C9A7',
  'Completed':   '#00C9A7',
  'Planning':    '#3B82F6',
  'Backlogged':  '#F59E0B',
  'On Hold':     '#F59E0B',
}

const EMPTY_FORM = { name: '', status: 'Planning', budget: '', startDate: '', location: '', progress: 0 }

function CreateModal({ companyCurrency, companyConfigured, onClose, onSave }) {
  // A new project INHERITS the company base currency and may be overridden here
  // — an AU-based builder delivering a PNG contract may legitimately report in
  // USD. The chosen currency is stored on the project, so a later change to the
  // company base currency can never relabel this project's amounts.
  const [form, setForm]    = useState({ ...EMPTY_FORM, currency: companyCurrency })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onSave(form)
      onClose()
    } catch {
      setError('Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[480px] bg-brand-surface border border-brand-border rounded-xl shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">New Project</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">

          {/* Name */}
          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">
              Project Name <span className="text-brand-red">*</span>
            </label>
            <input
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
              placeholder="e.g. Lakeside Apartments"
              value={form.name}
              onChange={set('name')}
              required
              autoFocus
            />
          </div>

          {/* Status */}
          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Status</label>
            <select
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none"
              value={form.status}
              onChange={set('status')}
            >
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Currency */}
          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Currency</label>
            <select
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]"
              value={form.currency}
              onChange={set('currency')}
            >
              {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
            </select>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              {companyConfigured
                ? `Inherited from your company (${companyCurrency}).`
                : `Your company currency isn’t set yet — defaulting to ${companyCurrency}.`}{' '}
              {Number(form.budget) > 0
                ? <span className="text-brand-amber">A headline budget is monetary data, so this currency locks as soon as the project is created. Amounts are never converted — choose it correctly now.</span>
                : 'Editable on the project until it has any monetary data. Amounts are never converted.'}
            </p>
          </div>

          {/* Budget + Start Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">
                Budget ({form.currency})
              </label>
              <input
                type="number"
                min="0"
                className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
                placeholder="0"
                value={form.budget}
                onChange={set('budget')}
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Start Date</label>
              <input
                type="date"
                className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none"
                value={form.startDate}
                onChange={set('startDate')}
              />
            </div>
          </div>

          {/* Location */}
          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Location</label>
            <input
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
              placeholder="e.g. Brisbane QLD"
              value={form.location}
              onChange={set('location')}
            />
          </div>

          {/* Progress */}
          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">
              Progress <span className="text-brand-muted font-normal normal-case tracking-normal">(0 – 100)</span>
            </label>
            <input
              type="number"
              min="0"
              max="100"
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none"
              value={form.progress}
              onChange={set('progress')}
            />
          </div>

          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving}>{saving ? 'Saving…' : 'Create Project'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Projects() {
  const navigate                             = useNavigate()
  const { company }                          = useCompany()
  const { projects, projectsLoading, createProject } = useProjects()
  const [showModal, setShowModal]            = useState(false)

  const companyName       = company?.name ?? null
  const count             = projects.length
  const companyCurrency   = resolveCompanyCurrency(company)
  const companyConfigured = isCompanyCurrencyConfigured(company)

  return (
    <div className="max-w-[1280px]">
      <PageHeader
        title="Projects"
        sub={`${count} project${count !== 1 ? 's' : ''}${companyName ? ` · ${companyName}` : ''}`}
      >
        <Btn onClick={() => setShowModal(true)}>+ Add New Project</Btn>
      </PageHeader>

      <Card padding={false}>
        {projectsLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading projects…</div>
        ) : count === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">No projects yet. Create your first one to get started.</p>
            <Btn onClick={() => setShowModal(true)}>+ Create your first project</Btn>
          </div>
        ) : (
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
                <tr key={p.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                  <td className="py-3 pl-4 pr-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ background: DOT_COLORS[p.status] ?? '#546E84' }} />
                  </td>
                  <td className="px-3.5 py-3">
                    <p className="text-[13px] font-semibold text-brand-text m-0 leading-tight">{p.name}</p>
                    {p.location && (
                      <p className="text-[11px] text-brand-muted mt-0.5 m-0 leading-tight">📍 {p.location}</p>
                    )}
                  </td>
                  <td className="px-3.5 py-3">
                    <Badge label={p.status} sm />
                  </td>
                  <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                    {p.budget ? formatCurrency(p.budget, resolveProjectCurrency(p, company)) : '—'}
                  </td>
                  <td className="px-3.5 py-3 text-[12px] text-brand-muted">{formatDate(p.startDate)}</td>
                  <td className="px-3.5 py-3 min-w-[110px]">
                    <div className="flex items-center gap-1.5">
                      <div className="flex-1"><ProgBar value={p.progress ?? 0} /></div>
                      <span className="text-[10px] text-brand-muted w-7 text-right">{p.progress ?? 0}%</span>
                    </div>
                  </td>
                  <td className="px-3.5 py-3">
                    <Btn variant="ghost" sm onClick={() => navigate(`/projects/${p.id}`)}>View ▾</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {showModal && (
        <CreateModal
          companyCurrency={companyCurrency}
          companyConfigured={companyConfigured}
          onClose={() => setShowModal(false)}
          onSave={createProject}
        />
      )}
    </div>
  )
}
