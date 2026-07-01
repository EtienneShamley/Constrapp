import { useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import ProgBar from '../../components/ProgBar'
import { currency } from '../../lib/formatters'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { useCostCodes } from '../../hooks/useCostCodes'

const EMPTY_FORM = { costCodeId: '', budgeted: '', notes: '' }

function CreateBudgetLineModal({ costCodes, onClose, onSave }) {
  const [form, setForm]     = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.costCodeId) return
    setSaving(true)
    setError(null)
    try {
      const costCode = costCodes.find(cc => cc.id === form.costCodeId)
      await onSave({
        costCodeId:   form.costCodeId,
        costCodeName: costCode ? `${costCode.code} — ${costCode.name}` : '',
        budgeted:     form.budgeted,
        notes:        form.notes,
      })
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
          <h2 className="text-[15px] font-bold text-brand-text m-0">New Budget Line</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">
              Cost Code <span className="text-brand-red">*</span>
            </label>
            <select
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none"
              value={form.costCodeId}
              onChange={set('costCodeId')}
              required
              autoFocus
            >
              <option value="" disabled>Select a cost code…</option>
              {costCodes.map(cc => (
                <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Budgeted (AUD)</label>
            <input
              type="number"
              min="0"
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
              placeholder="0"
              value={form.budgeted}
              onChange={set('budgeted')}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Notes</label>
            <input
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
              placeholder="Optional"
              value={form.notes}
              onChange={set('notes')}
            />
          </div>

          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving}>{saving ? 'Saving…' : 'Add Line'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function ProjectBudget() {
  const navigate = useNavigate()
  const { projectId } = useOutletContext()
  const { budgetLines, budgetLinesLoading, createBudgetLine } = useBudgetLines(projectId)
  const { costCodes, costCodesLoading } = useCostCodes()
  const [showModal, setShowModal] = useState(false)

  const noCostCodes = !costCodesLoading && costCodes.length === 0
  const goToCostCodes = () => navigate(`/projects/${projectId}/cost-codes`)

  const totals = budgetLines.reduce((acc, l) => ({
    budgeted:  acc.budgeted  + (l.budgeted  || 0),
    committed: acc.committed + (l.committed || 0),
    actual:    acc.actual    + (l.actual    || 0),
    invoiced:  acc.invoiced  + (l.invoiced  || 0),
  }), { budgeted: 0, committed: 0, actual: 0, invoiced: 0 })

  const remaining     = totals.budgeted - totals.actual
  const usagePercent  = totals.budgeted > 0 ? Math.min(100, (totals.actual / totals.budgeted) * 100) : 0

  return (
    <div>
      <Card className="mb-3.5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5 mb-3">
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Budgeted</p>
            <p className="text-lg font-bold text-brand-text">{currency(totals.budgeted)}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Committed</p>
            <p className="text-lg font-bold text-brand-text">{currency(totals.committed)}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Actual</p>
            <p className="text-lg font-bold text-brand-text">{currency(totals.actual)}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Remaining</p>
            <p className="text-lg font-bold text-brand-text">{currency(remaining)}</p>
          </div>
        </div>
        <ProgBar value={usagePercent} colour={usagePercent >= 100 ? 'brand-red' : 'brand-accent'} />
      </Card>

      <div className="flex items-center justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          {noCostCodes ? 'Create a cost code before adding budget lines.' : 'Cost code breakdown for this project.'}
        </p>
        <div className="flex items-center gap-2">
          {noCostCodes && (
            <Btn variant="ghost" sm onClick={goToCostCodes}>Go to Cost Codes</Btn>
          )}
          <Btn sm onClick={() => setShowModal(true)} disabled={costCodesLoading || costCodes.length === 0}>
            + Add Budget Line
          </Btn>
        </div>
      </div>

      <Card padding={false}>
        {budgetLinesLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading budget…</div>
        ) : budgetLines.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {noCostCodes
                ? 'Create a cost code before adding budget lines.'
                : 'No budget lines yet. Add your first cost code allocation.'}
            </p>
            {noCostCodes ? (
              <Btn variant="ghost" onClick={goToCostCodes}>Go to Cost Codes</Btn>
            ) : (
              <Btn onClick={() => setShowModal(true)}>+ Add your first budget line</Btn>
            )}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-brand-card border-b border-brand-border">
                {['Cost Code', 'Budgeted', 'Committed', 'Actual', 'Invoiced', 'Remaining'].map(h => (
                  <th key={h} className="text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {budgetLines.map(line => (
                <tr key={line.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                  <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text">{line.costCodeName || '—'}</td>
                  <td className="px-3.5 py-3 text-[13px] text-brand-text">{currency(line.budgeted || 0)}</td>
                  <td className="px-3.5 py-3 text-[13px] text-brand-text">{currency(line.committed || 0)}</td>
                  <td className="px-3.5 py-3 text-[13px] text-brand-text">{currency(line.actual || 0)}</td>
                  <td className="px-3.5 py-3 text-[13px] text-brand-text">{currency(line.invoiced || 0)}</td>
                  <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text">
                    {currency((line.budgeted || 0) - (line.actual || 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {showModal && (
        <CreateBudgetLineModal
          costCodes={costCodes}
          onClose={() => setShowModal(false)}
          onSave={createBudgetLine}
        />
      )}
    </div>
  )
}
