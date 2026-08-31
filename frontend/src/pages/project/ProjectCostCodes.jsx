import { useState } from 'react'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { useCostCodes } from '../../hooks/useCostCodes'
import { useProfile } from '../../hooks/useProfile'
import { COST_CODE_DEACTIVATE_NOTICE } from '../../lib/costCodes'

const EMPTY_FORM = { code: '', name: '', category: '', unit: '' }

// Roles permitted to write cost codes — the UX mirror of the Firestore rules,
// which are the enforced boundary.
const canWriteCostCodes = (role) =>
  role === 'company_admin' || role === 'project_manager' || role === 'qs'

// One editor, two modes (the ADR-35/36 pattern): `costCode` null = CREATE,
// a live cost code = EDIT.
//
// Editing `code` and `name` is a DISPLAY correction only. Every financial
// derivation in the app groups by the document id, never by the code or the
// name, so a rename moves no Budgeted, Committed, Actual, Invoiced, Forecast,
// Margin or Cash Flow figure. Historical documents keep the `costCodeName`
// snapshot they froze at write time and are NEVER backfilled; screens resolve
// the current name at read time instead (ADR-39).
//
// `isActive` is deliberately NOT in this form — it belongs to the separate
// Deactivate/Reactivate action, so a content edit can never change a code's
// availability as a side effect.
function CostCodeEditorModal({ costCode = null, onClose, onSave }) {
  const isEdit = costCode !== null

  const [form, setForm]     = useState(() => (
    isEdit
      ? {
          code:     costCode.code ?? '',
          name:     costCode.name ?? '',
          category: costCode.category ?? '',
          unit:     costCode.unit ?? '',
        }
      : EMPTY_FORM
  ))
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
    } catch (err) {
      // A validation message from lib/costCodes.js (a duplicate code, a length
      // limit) is actionable and shown verbatim; anything else is transport.
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[480px] bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">{isEdit ? 'Edit Cost Code' : 'New Cost Code'}</h2>
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
            <Btn type="submit" sm disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Cost Code'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function ProjectCostCodes() {
  const {
    costCodes, costCodesLoading,
    createCostCode, updateCostCode, deactivateCostCode, reactivateCostCode,
  } = useCostCodes()
  const { profile } = useProfile()
  // null = closed · 'new' = create · a cost code = edit that record.
  const [editing, setEditing] = useState(null)
  // The cost code awaiting a Deactivate confirmation, or null.
  const [deactivating, setDeactivating] = useState(null)
  const [actionError, setActionError] = useState(null)

  const canWrite = canWriteCostCodes(profile?.role)

  // Re-resolved by id at render time so the editor always holds the live
  // document even if the subscription updated underneath it.
  const editingCostCode = editing && editing !== 'new'
    ? (costCodes.find(cc => cc.id === editing.id) ?? null)
    : null

  async function handleSave(form) {
    if (editing === 'new') {
      await createCostCode(form)
      return
    }
    await updateCostCode(editingCostCode, form)
  }

  async function handleSetActive(costCode, isActive) {
    setActionError(null)
    try {
      if (isActive) await reactivateCostCode(costCode)
      else await deactivateCostCode(costCode)
      setDeactivating(null)
    } catch (err) {
      setActionError(err?.message || 'Failed to save. Check your connection and try again.')
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          Company-wide cost code library — reused across every project's budget.
        </p>
        {canWrite && <Btn sm onClick={() => setEditing('new')}>+ Add Cost Code</Btn>}
      </div>

      {actionError && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-red m-0">Could not update the cost code</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">{actionError}</p>
        </Card>
      )}

      <Card padding={false}>
        {costCodesLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading cost codes…</div>
        ) : costCodes.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">No cost codes yet. Create your first one to start building budgets.</p>
            {canWrite && <Btn onClick={() => setEditing('new')}>+ Create your first cost code</Btn>}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-brand-card border-b border-brand-border">
                {['Code', 'Name', 'Category', 'Unit', 'Status', 'Actions'].map(h => (
                  <th key={h} className="text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {costCodes.map(cc => {
                // A legacy document written before the flag existed has no
                // `isActive` key and is ACTIVE — never treat absent as
                // deactivated, or working codes vanish from every picker.
                const active = cc.isActive !== false
                return (
                  <tr key={cc.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text">{cc.code}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text">{cc.name}</td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted">{cc.category || '—'}</td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted">{cc.unit || '—'}</td>
                    <td className="px-3.5 py-3">
                      <Badge label={active ? 'Active' : 'Inactive'} variant={active ? 'active' : 'soon'} sm />
                    </td>
                    <td className="px-3.5 py-3">
                      {canWrite && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Btn variant="ghost" sm onClick={() => setEditing(cc)}>Edit</Btn>
                          {active ? (
                            <Btn variant="ghost" sm onClick={() => { setActionError(null); setDeactivating(cc) }}>
                              Deactivate
                            </Btn>
                          ) : (
                            <Btn variant="ghost" sm onClick={() => handleSetActive(cc, true)}>Reactivate</Btn>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      {(editing === 'new' || editingCostCode) && (
        <CostCodeEditorModal
          key={editing === 'new' ? 'new' : editingCostCode.id}
          costCode={editing === 'new' ? null : editingCostCode}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}

      {/* Deactivation is confirmed, never blocked. It changes nothing that
          already exists — every existing record keeps the code and every
          financial total is unchanged; it only removes the code from NEW
          authoring. Reactivation is always available. */}
      {deactivating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDeactivating(null)} />
          <div className="relative z-10 w-full max-w-[480px] bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
              <h2 className="text-[15px] font-bold text-brand-text m-0">Deactivate cost code</h2>
              <button
                onClick={() => setDeactivating(null)}
                aria-label="Close"
                className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
              >
                ×
              </button>
            </div>
            <div className="px-5 py-4">
              <p className="m-0 text-[13px] font-semibold text-brand-text">
                {deactivating.code} — {deactivating.name}
              </p>
              <p className="m-0 mt-2 text-[12px] text-brand-muted">{COST_CODE_DEACTIVATE_NOTICE}</p>
              <div className="flex justify-end gap-2 pt-3 mt-3 border-t border-brand-border">
                <Btn variant="ghost" sm onClick={() => setDeactivating(null)}>Cancel</Btn>
                <Btn sm onClick={() => handleSetActive(deactivating, false)}>Deactivate</Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
