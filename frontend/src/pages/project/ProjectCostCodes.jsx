import { useState } from 'react'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { useCostCodes } from '../../hooks/useCostCodes'

const EMPTY_FORM = { code: '', name: '', category: '', unit: '' }

function CreateCostCodeModal({ onClose, onSave }) {
  const [form, setForm]     = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.code.trim() || !form.name.trim()) return
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
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">New Cost Code</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">
                Code <span className="text-brand-red">*</span>
              </label>
              <input
                className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
                placeholder="e.g. 03-100"
                value={form.code}
                onChange={set('code')}
                required
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Unit</label>
              <input
                className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
                placeholder="e.g. m³"
                value={form.unit}
                onChange={set('unit')}
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">
              Name <span className="text-brand-red">*</span>
            </label>
            <input
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
              placeholder="e.g. Concrete Slab"
              value={form.name}
              onChange={set('name')}
              required
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Category</label>
            <input
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
              placeholder="e.g. Structure"
              value={form.category}
              onChange={set('category')}
            />
          </div>

          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving}>{saving ? 'Saving…' : 'Create Cost Code'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function ProjectCostCodes() {
  const { costCodes, costCodesLoading, createCostCode } = useCostCodes()
  const [showModal, setShowModal] = useState(false)

  return (
    <div>
      <div className="flex items-center justify-between mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          Company-wide cost code library — reused across every project's budget.
        </p>
        <Btn sm onClick={() => setShowModal(true)}>+ Add Cost Code</Btn>
      </div>

      <Card padding={false}>
        {costCodesLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading cost codes…</div>
        ) : costCodes.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">No cost codes yet. Create your first one to start building budgets.</p>
            <Btn onClick={() => setShowModal(true)}>+ Create your first cost code</Btn>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-brand-card border-b border-brand-border">
                {['Code', 'Name', 'Category', 'Unit', 'Status'].map(h => (
                  <th key={h} className="text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {costCodes.map(cc => (
                <tr key={cc.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                  <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text">{cc.code}</td>
                  <td className="px-3.5 py-3 text-[13px] text-brand-text">{cc.name}</td>
                  <td className="px-3.5 py-3 text-[12px] text-brand-muted">{cc.category || '—'}</td>
                  <td className="px-3.5 py-3 text-[12px] text-brand-muted">{cc.unit || '—'}</td>
                  <td className="px-3.5 py-3">
                    <Badge label={cc.isActive ? 'Active' : 'Inactive'} variant={cc.isActive ? 'active' : 'soon'} sm />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {showModal && (
        <CreateCostCodeModal
          onClose={() => setShowModal(false)}
          onSave={createCostCode}
        />
      )}
    </div>
  )
}
