import { useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { currency } from '../../lib/formatters'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useCostCodes } from '../../hooks/useCostCodes'
import { useContacts } from '../../hooks/useContacts'
import {
  PO_STATUS, PO_STATUS_LABELS, PO_BADGE_VARIANTS,
  lineTotal, poTotals,
} from '../../lib/purchaseOrders'
import {
  ENTITY_TYPE, CONTACT_TYPE, CONTACT_TYPE_LABELS, PO_SUPPLIER_TYPES,
  duplicateWarnings, isAssignedToProject,
} from '../../lib/contacts'

const EMPTY_LINE = { costCodeId: '', description: '', qty: '', unit: '', unitPrice: '' }
const EMPTY_FORM = { supplierId: '', description: '', notes: '' }

const inputCls  = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls  = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'

// Inline minimal contact creation so raising a PO is never blocked by
// directory admin. Full details are added later on the Contacts page.
// The new contact is auto-assigned to the current project.
function QuickCreateSupplier({ contacts, projectId, onCreateContact, onCreated, onCancel }) {
  const [name, setName]     = useState('')
  const [types, setTypes]   = useState([CONTACT_TYPE.SUPPLIER])
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const toggleType = (type) => () => setTypes(ts =>
    ts.includes(type) ? ts.filter(t => t !== type) : [...ts, type]
  )
  const warnings = duplicateWarnings(contacts, { displayName: name })
  const valid    = name.trim() && types.length > 0

  async function handleCreate() {
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      const id = await onCreateContact({
        entityType:   ENTITY_TYPE.ORGANISATION,
        contactTypes: types,
        legalName:    name,
        projectAssignments: [{ projectId }],
      })
      onCreated(id)
    } catch (err) {
      setError(err?.message || 'Failed to create contact. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="border border-brand-border rounded-lg px-3 py-2.5 flex flex-col gap-2">
      <p className="m-0 text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px]">New supplier contact</p>
      <input
        className={inputCls}
        placeholder="Company / legal name"
        value={name}
        onChange={e => setName(e.target.value)}
        autoFocus
      />
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {PO_SUPPLIER_TYPES.map(type => (
          <label key={type} className="flex items-center gap-1.5 text-[13px] text-brand-text cursor-pointer min-h-[24px]">
            <input type="checkbox" checked={types.includes(type)} onChange={toggleType(type)} className="accent-[#00C9A7]" />
            {CONTACT_TYPE_LABELS[type]}
          </label>
        ))}
      </div>
      {warnings.map((w, i) => (
        <p key={i} className="m-0 text-[11px] text-brand-amber">{w.message}</p>
      ))}
      {error && <p className="m-0 text-[12px] text-brand-red">{error}</p>}
      <div className="flex gap-1.5">
        <Btn sm type="button" disabled={saving || !valid} onClick={handleCreate}>
          {saving ? 'Creating…' : 'Create & select'}
        </Btn>
        <Btn sm variant="ghost" type="button" onClick={onCancel} disabled={saving}>Cancel</Btn>
      </div>
    </div>
  )
}

function CreatePurchaseOrderModal({ costCodes, contacts, projectId, onCreateContact, onClose, onSave }) {
  const [form, setForm]   = useState(EMPTY_FORM)
  const [lines, setLines] = useState([{ ...EMPTY_LINE }])
  const [showQuickCreate, setShowQuickCreate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  // Active contacts that can be a PO supplier (supplier or subcontractor type).
  const supplierContacts = contacts.filter(c =>
    c.isActive !== false && (c.contactTypes ?? []).some(t => PO_SUPPLIER_TYPES.includes(t))
  )
  // Contacts assigned to this project are preferred but never exclusive; picking
  // an unassigned contact must not silently assign it — the PO records the link.
  const assignedSuppliers = supplierContacts.filter(c => isAssignedToProject(c, projectId))
  const otherSuppliers    = supplierContacts.filter(c => !isAssignedToProject(c, projectId))
  const selectedSupplier  = supplierContacts.find(c => c.id === form.supplierId) ?? null

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))
  const setLine = (idx, key) => (e) => {
    const value = e.target.value
    setLines(ls => ls.map((l, i) => (i === idx ? { ...l, [key]: value } : l)))
  }
  const addLine    = () => setLines(ls => [...ls, { ...EMPTY_LINE }])
  const removeLine = (idx) => setLines(ls => ls.filter((_, i) => i !== idx))

  const builtLines = lines.map(l => ({
    costCodeId:   l.costCodeId,
    costCodeName: (() => {
      const cc = costCodes.find(c => c.id === l.costCodeId)
      return cc ? `${cc.code} — ${cc.name}` : ''
    })(),
    description: l.description.trim(),
    qty:         Number(l.qty) || 0,
    unit:        l.unit.trim(),
    unitPrice:   Number(l.unitPrice) || 0,
    lineTotal:   lineTotal(l.qty, l.unitPrice),
  }))
  const totals = poTotals(builtLines)
  const linesValid = lines.length > 0 && lines.every(l => l.costCodeId)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!selectedSupplier || !linesValid) return
    setSaving(true)
    setError(null)
    try {
      // supplierName is a permanent write-time snapshot of the contact's
      // display name — contact renames never rewrite issued documents.
      await onSave({
        supplierName: selectedSupplier.displayName,
        supplierId:   selectedSupplier.id,
        description:  form.description,
        notes:        form.notes,
        lineItems:    builtLines,
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
      <div className="relative z-10 w-full max-w-[720px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">New Purchase Order</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>
                Supplier <span className="text-brand-red">*</span>
              </label>
              <div className="flex items-center gap-2">
                <select
                  className={inputCls}
                  value={form.supplierId}
                  onChange={set('supplierId')}
                  required
                  autoFocus
                >
                  <option value="" disabled>
                    {supplierContacts.length === 0 ? 'No supplier contacts yet…' : 'Select a supplier…'}
                  </option>
                  {assignedSuppliers.length === 0 ? (
                    supplierContacts.map(c => (
                      <option key={c.id} value={c.id}>{c.displayName}</option>
                    ))
                  ) : (
                    <>
                      <optgroup label="This project">
                        {assignedSuppliers.map(c => (
                          <option key={c.id} value={c.id}>{c.displayName}</option>
                        ))}
                      </optgroup>
                      {otherSuppliers.length > 0 && (
                        <optgroup label="Other company contacts">
                          {otherSuppliers.map(c => (
                            <option key={c.id} value={c.id}>{c.displayName}</option>
                          ))}
                        </optgroup>
                      )}
                    </>
                  )}
                </select>
                {!showQuickCreate && (
                  <Btn variant="ghost" type="button" sm className="whitespace-nowrap" onClick={() => setShowQuickCreate(true)}>
                    + New
                  </Btn>
                )}
              </div>
            </div>
            <div>
              <label className={labelCls}>Description</label>
              <input
                className={inputCls}
                placeholder="What this PO covers"
                value={form.description}
                onChange={set('description')}
              />
            </div>
          </div>

          {showQuickCreate && (
            <QuickCreateSupplier
              contacts={contacts}
              projectId={projectId}
              onCreateContact={onCreateContact}
              onCreated={(id) => {
                setForm(f => ({ ...f, supplierId: id }))
                setShowQuickCreate(false)
              }}
              onCancel={() => setShowQuickCreate(false)}
            />
          )}

          <div>
            <label className={labelCls}>
              Line Items <span className="text-brand-red">*</span>
            </label>
            <div className="flex flex-col gap-2">
              {lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-2 sm:grid-cols-[2fr_2fr_1fr_1fr_1fr_auto] gap-2 items-center">
                  <select
                    className={inputCls}
                    value={line.costCodeId}
                    onChange={setLine(idx, 'costCodeId')}
                    required
                  >
                    <option value="" disabled>Cost code…</option>
                    {costCodes.map(cc => (
                      <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                    ))}
                  </select>
                  <input
                    className={inputCls}
                    placeholder="Description"
                    value={line.description}
                    onChange={setLine(idx, 'description')}
                  />
                  <input
                    type="number" min="0" step="any"
                    className={inputCls}
                    placeholder="Qty"
                    value={line.qty}
                    onChange={setLine(idx, 'qty')}
                  />
                  <input
                    className={inputCls}
                    placeholder="Unit"
                    value={line.unit}
                    onChange={setLine(idx, 'unit')}
                  />
                  <input
                    type="number" min="0" step="any"
                    className={inputCls}
                    placeholder="Rate"
                    value={line.unitPrice}
                    onChange={setLine(idx, 'unitPrice')}
                  />
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    disabled={lines.length === 1}
                    aria-label="Remove line"
                    className="text-brand-muted hover:text-brand-red disabled:opacity-30 disabled:cursor-not-allowed text-lg leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2">
              <Btn variant="ghost" type="button" sm onClick={addLine}>+ Add line</Btn>
            </div>
          </div>

          <div>
            <label className={labelCls}>Notes</label>
            <input
              className={inputCls}
              placeholder="Optional"
              value={form.notes}
              onChange={set('notes')}
            />
          </div>

          <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
            <p className="m-0">Subtotal <span className="font-semibold ml-2">{currency(totals.subtotal)}</span></p>
            <p className="m-0 text-brand-muted">GST 10% <span className="ml-2">{currency(totals.gst)}</span></p>
            <p className="m-0 font-bold">Total <span className="ml-2">{currency(totals.total)}</span></p>
          </div>

          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving || !linesValid}>{saving ? 'Saving…' : 'Create Draft PO'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

function RowActions({ po, onTransition }) {
  const confirmThen = (label, nextStatus) => () => {
    if (window.confirm(`${label} ${po.poNumber}?`)) onTransition(po, nextStatus)
  }

  if (po.status === PO_STATUS.DRAFT) {
    return (
      <div className="flex gap-1.5 justify-end">
        <Btn sm variant="success" onClick={confirmThen('Send', PO_STATUS.SENT)}>Send</Btn>
        <Btn sm variant="ghost" onClick={confirmThen('Cancel', PO_STATUS.CANCELLED)}>Cancel</Btn>
      </div>
    )
  }
  if (po.status === PO_STATUS.SENT) {
    return (
      <div className="flex gap-1.5 justify-end">
        <Btn sm variant="ghost" onClick={confirmThen('Close', PO_STATUS.CLOSED)}>Close</Btn>
        <Btn sm variant="ghost" onClick={confirmThen('Cancel', PO_STATUS.CANCELLED)}>Cancel</Btn>
      </div>
    )
  }
  return null
}

export default function ProjectPurchaseOrders() {
  const navigate = useNavigate()
  const { projectId } = useOutletContext()
  const { purchaseOrders, purchaseOrdersLoading, createPurchaseOrder, transitionStatus } = usePurchaseOrders(projectId)
  const { costCodes, costCodesLoading } = useCostCodes()
  const { contacts, createContact } = useContacts()
  const [showModal, setShowModal] = useState(false)
  const [actionError, setActionError] = useState(null)

  const noCostCodes = !costCodesLoading && costCodes.length === 0
  const goToCostCodes = () => navigate(`/projects/${projectId}/cost-codes`)

  async function handleTransition(po, nextStatus) {
    setActionError(null)
    try {
      await transitionStatus(po, nextStatus)
    } catch {
      setActionError('Failed to update status. Check your connection and try again.')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          {noCostCodes
            ? 'Create a cost code before raising purchase orders.'
            : 'Supplier commitments for this project, linked to cost codes.'}
        </p>
        <div className="flex items-center gap-2">
          {noCostCodes && (
            <Btn variant="ghost" sm onClick={goToCostCodes}>Go to Cost Codes</Btn>
          )}
          <Btn sm onClick={() => setShowModal(true)} disabled={costCodesLoading || costCodes.length === 0}>
            + New Purchase Order
          </Btn>
        </div>
      </div>

      {actionError && <p className="text-[12px] text-brand-red mb-3">{actionError}</p>}

      <Card padding={false}>
        {purchaseOrdersLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading purchase orders…</div>
        ) : purchaseOrders.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {noCostCodes
                ? 'Create a cost code before raising purchase orders.'
                : 'No purchase orders yet. Raise your first supplier commitment.'}
            </p>
            {noCostCodes ? (
              <Btn variant="ghost" onClick={goToCostCodes}>Go to Cost Codes</Btn>
            ) : (
              <Btn onClick={() => setShowModal(true)}>+ Create your first purchase order</Btn>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['PO #', 'Supplier', 'Description', 'Cost Codes', 'Total (inc. GST)', 'Status', ''].map((h, i) => (
                    <th key={i} className="text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {purchaseOrders.map(po => (
                  <tr key={po.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{po.poNumber}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text">{po.supplierName}</td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted">{po.description || '—'}</td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted">
                      {[...new Set((po.lineItems ?? []).map(li => li.costCodeName).filter(Boolean))].join(', ') || '—'}
                    </td>
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{currency(po.total || 0)}</td>
                    <td className="px-3.5 py-3">
                      <Badge label={PO_STATUS_LABELS[po.status] ?? po.status} variant={PO_BADGE_VARIANTS[po.status]} sm />
                    </td>
                    <td className="px-3.5 py-3">
                      <RowActions po={po} onTransition={handleTransition} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showModal && (
        <CreatePurchaseOrderModal
          costCodes={costCodes}
          contacts={contacts}
          projectId={projectId}
          onCreateContact={createContact}
          onClose={() => setShowModal(false)}
          onSave={createPurchaseOrder}
        />
      )}
    </div>
  )
}
