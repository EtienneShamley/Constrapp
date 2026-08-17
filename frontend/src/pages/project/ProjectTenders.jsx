import { useMemo, useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency } from '../../lib/formatters'
import { roundMoney } from '../../lib/purchaseOrders'
import { todayIso } from '../../lib/payments'
import { useProfile } from '../../hooks/useProfile'
import { useTenderPackages } from '../../hooks/useTenderPackages'
import { useTenderBids } from '../../hooks/useTenderBids'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { useCostCodes } from '../../hooks/useCostCodes'
import { useContacts } from '../../hooks/useContacts'
import { PO_SUPPLIER_TYPES } from '../../lib/contacts'
import { isFinancialRole } from '../../lib/margin'
import {
  TENDER_STATUS, TENDER_STATUS_LABELS, TENDER_BADGE_VARIANTS,
  BID_STATUS_LABELS, BID_BADGE_VARIANTS,
  CLOSING_DATE_NOTE,
  validateTenderPackageDraft, validateBidDraft,
  assessBid, bidsForPackage, receivedBidsForPackage, isBidWritable,
  buildTenderComparison, costCodeComparisonMatrix,
  awardBlockedReason, awardedBidValue,
} from '../../lib/tenders'

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

// `base` puts the package DETAIL modal on a LOWER layer than the action modals
// it launches (bid editor, award, cancel, void, issue…). Without it every
// overlay shares one z-index and the detail modal — rendered last — paints over
// the modal it just opened, which makes Award (reachable only from the detail
// view) look like a dead button.
function ModalShell({ title, onClose, children, wide, base = false }) {
  return (
    <div className={`fixed inset-0 ${base ? 'z-40' : 'z-50'} flex items-center justify-center p-4`}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative z-10 w-full ${wide ? 'max-w-[980px]' : 'max-w-[560px]'} max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function DetailRow({ label, value }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className="m-0 text-[13px] text-brand-text break-words whitespace-pre-wrap">{value || '—'}</p>
    </div>
  )
}

// ── Create / edit draft package ──────────────────────────────────────────────

function PackageEditorModal({ pkg, costCodes, onClose, onSave }) {
  const isEdit = !!pkg

  const [name, setName]               = useState(pkg?.name || '')
  const [description, setDescription] = useState(pkg?.description || '')
  const [scope, setScope]             = useState(pkg?.scope || '')
  const [closingDate, setClosingDate] = useState(pkg?.closingDate || '')
  const [notes, setNotes]             = useState(pkg?.notes || '')
  const [selectedIds, setSelectedIds] = useState(() => new Set((pkg?.costCodes ?? []).map(c => c.costCodeId)))
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)

  const activeCostCodes = costCodes.filter(cc => cc.isActive !== false)

  const toggle = (id) => setSelectedIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  // Frozen name snapshots come from the LIVE cost-code list at save time —
  // the costCodeName idiom. A previously-selected code that has since been
  // deactivated keeps its stored snapshot.
  const builtCostCodes = useMemo(() => {
    const stored = new Map((pkg?.costCodes ?? []).map(c => [c.costCodeId, c.costCodeName]))
    return [...selectedIds].map(id => {
      const cc = costCodes.find(c => c.id === id)
      return {
        costCodeId: id,
        costCodeName: cc ? `${cc.code} — ${cc.name}` : (stored.get(id) || ''),
      }
    })
  }, [selectedIds, costCodes, pkg])

  const validationError = validateTenderPackageDraft({ name, costCodes: builtCostCodes, closingDate })

  async function handleSubmit(e) {
    e.preventDefault()
    if (validationError) return
    setSaving(true)
    setError(null)
    try {
      await onSave({ name, description, scope, costCodes: builtCostCodes, closingDate, notes })
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell wide title={isEdit ? `Edit ${pkg.tenderNumber}` : 'New Tender Package'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Package Name <span className="text-brand-red">*</span></label>
            <input className={inputCls} placeholder="e.g. Structural Steel Package" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Closing Date</label>
            <input type="date" className={inputCls} value={closingDate} onChange={e => setClosingDate(e.target.value)} />
            <p className="m-0 mt-1 text-[11px] text-brand-amber">{CLOSING_DATE_NOTE}</p>
          </div>
        </div>

        <div>
          <label className={labelCls}>Description</label>
          <input className={inputCls} placeholder="Optional one-line summary" value={description} onChange={e => setDescription(e.target.value)} />
        </div>

        <div>
          <label className={labelCls}>Scope of Works</label>
          <textarea
            className={`${inputCls} min-h-[90px]`}
            placeholder="Free-text scope — what bidders are pricing. (A structured BOQ scope schedule is future work.)"
            value={scope}
            onChange={e => setScope(e.target.value)}
          />
        </div>

        <div>
          <label className={labelCls}>Cost Codes <span className="text-brand-red">*</span></label>
          {activeCostCodes.length === 0 ? (
            <p className="m-0 text-[12px] text-brand-muted">
              No active cost codes exist yet — add them on the Cost Codes tab first.
            </p>
          ) : (
            <div className="max-h-[220px] overflow-y-auto rounded-lg border border-brand-border p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
              {activeCostCodes.map(cc => (
                <label key={cc.id} className="flex items-center gap-2 text-[12.5px] text-brand-text cursor-pointer px-1.5 py-1.5 rounded hover:bg-brand-card">
                  <input type="checkbox" checked={selectedIds.has(cc.id)} onChange={() => toggle(cc.id)} />
                  <span>{cc.code} — {cc.name}</span>
                </label>
              ))}
            </div>
          )}
          <p className="m-0 mt-1 text-[11px] text-brand-muted">
            Bids are priced per cost code, so the package needs at least one. Names are snapshotted onto the
            package — later cost-code renames never rewrite it.
          </p>
        </div>

        <div>
          <label className={labelCls}>Notes</label>
          <input className={inputCls} placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        {validationError && name.trim() !== '' && selectedIds.size > 0 && (
          <p className="text-[12px] text-brand-red m-0">{validationError}</p>
        )}
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}

        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !!validationError}>
            {saving ? 'Saving…' : isEdit ? 'Save draft' : 'Create draft package'}
          </Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Issue ────────────────────────────────────────────────────────────────────

function IssueModal({ pkg, onClose, onConfirm }) {
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onConfirm(pkg)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to issue. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell title={`Issue ${pkg.tenderNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Issuing freezes this package&apos;s name, description, scope, and cost codes — the scope that was
          reviewed is the scope that goes to market. Bids can then be recorded against it. Only the closing date
          and notes stay editable while issued.
        </p>
        <div className="rounded-lg border border-brand-border p-3">
          <p className="m-0 text-[13px] font-semibold text-brand-text">{pkg.name}</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            {(pkg.costCodes ?? []).length} cost code{(pkg.costCodes ?? []).length === 1 ? '' : 's'}
            {pkg.closingDate ? ` · closes ${pkg.closingDate}` : ' · no closing date'}
          </p>
        </div>
        <p className="m-0 text-[11px] text-brand-amber">{CLOSING_DATE_NOTE}</p>
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving}>{saving ? 'Issuing…' : 'Issue package'}</Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Issued edit (closing date / notes carve-out) ─────────────────────────────

function IssuedEditModal({ pkg, onClose, onSave }) {
  const [closingDate, setClosingDate] = useState(pkg?.closingDate || '')
  const [notes, setNotes]             = useState(pkg?.notes || '')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave(pkg, { closingDate, notes })
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell title={`Update ${pkg.tenderNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          An issued package&apos;s commercial scope is frozen. Only the closing date and notes can be updated.
        </p>
        <div>
          <label className={labelCls}>Closing Date</label>
          <input type="date" className={inputCls} value={closingDate} onChange={e => setClosingDate(e.target.value)} />
          <p className="m-0 mt-1 text-[11px] text-brand-amber">{CLOSING_DATE_NOTE}</p>
        </div>
        <div>
          <label className={labelCls}>Notes</label>
          <input className={inputCls} placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Add / edit bid ───────────────────────────────────────────────────────────

const blankBidRow = () => ({ costCodeId: '', description: '', amount: '' })

function BidEditorModal({
  pkg, bid, bidderContacts, tenderBids, currencyCode, onClose, onSave,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const isEdit = !!bid

  const [bidderContactId, setBidderContactId] = useState(bid?.bidderContactId || '')
  const [bidDate, setBidDate]     = useState(bid?.bidDate || todayIso())
  const [bidderRef, setBidderRef] = useState(bid?.bidderRef || '')
  const [exclusions, setExclusions] = useState(bid?.exclusions || '')
  const [notes, setNotes]         = useState(bid?.notes || '')
  const [rows, setRows] = useState(() =>
    bid?.lineItems?.length
      ? bid.lineItems.map(li => ({
          costCodeId:  li.costCodeId || '',
          description: li.description || '',
          amount:      String(li.amount ?? ''),
        }))
      : [blankBidRow()],
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const bidder = bidderContacts.find(c => c.id === bidderContactId) ?? null

  const setRow = (idx, patch) => setRows(rs => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const addRow = () => setRows(rs => [...rs, blankBidRow()])
  const removeRow = (idx) => setRows(rs => (rs.length === 1 ? [blankBidRow()] : rs.filter((_, i) => i !== idx)))

  // One row per package cost code, keeping anything already entered.
  const addAllPackageCodes = () => setRows(rs => {
    const present = new Set(rs.map(r => r.costCodeId).filter(Boolean))
    const missing = (pkg.costCodes ?? [])
      .filter(cc => !present.has(cc.costCodeId))
      .map(cc => ({ costCodeId: cc.costCodeId, description: '', amount: '' }))
    const kept = rs.filter(r => r.costCodeId || r.description || r.amount !== '')
    return [...kept, ...missing]
  })

  // Rows the user actually filled in — completely blank rows are ignored.
  const builtLines = useMemo(() =>
    rows
      .filter(r => r.costCodeId || r.description.trim() || r.amount !== '')
      .map(r => ({
        costCodeId:  r.costCodeId,
        description: r.description,
        amount:      r.amount === '' ? NaN : Number(r.amount),
      })),
    [rows],
  )

  const enteredTotal = roundMoney(builtLines.reduce(
    (sum, li) => sum + (Number.isFinite(li.amount) ? li.amount : 0), 0,
  ))

  const validationError = validateBidDraft({
    tenderPackage: pkg,
    bidderContactId,
    bidderName: isEdit ? bid.bidderName : (bidder?.displayName || ''),
    bidDate,
    lineItems: builtLines,
    bids: tenderBids,
    excludeBidId: bid?.id ?? null,
  })

  async function handleSubmit(e) {
    e.preventDefault()
    if (validationError) return
    setSaving(true)
    setError(null)
    try {
      await onSave({
        tenderPackage: pkg,
        bidderContactId,
        bidderName: isEdit ? bid.bidderName : (bidder?.displayName || ''),
        bidDate,
        bidderRef,
        lineItems: builtLines,
        exclusions,
        notes,
        bids: tenderBids,
      })
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell wide title={isEdit ? `Correct bid — ${bid.bidderName}` : `Record Bid — ${pkg.tenderNumber}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Bidder <span className="text-brand-red">*</span></label>
            {isEdit ? (
              <>
                <input className={inputCls} value={bid.bidderName} disabled />
                <p className="m-0 mt-1 text-[11px] text-brand-muted">
                  Bidder identity is frozen — void this bid and record a new one if the bidder is wrong.
                </p>
              </>
            ) : (
              <>
                <select className={inputCls} value={bidderContactId} onChange={e => setBidderContactId(e.target.value)} required>
                  <option value="" disabled>Select the bidder…</option>
                  {bidderContacts.map(c => (
                    <option key={c.id} value={c.id}>{c.displayName}</option>
                  ))}
                </select>
                <p className="m-0 mt-1 text-[11px] text-brand-muted">
                  Supplier and subcontractor contacts only. The name is snapshotted onto this bid.
                </p>
              </>
            )}
          </div>
          <div>
            <label className={labelCls}>Bid Date <span className="text-brand-red">*</span></label>
            <input type="date" className={inputCls} value={bidDate} onChange={e => setBidDate(e.target.value)} />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">The date the bid was received.</p>
          </div>
          <div>
            <label className={labelCls}>Bidder&apos;s Reference</label>
            <input className={inputCls} placeholder="Their quote / tender ref" value={bidderRef} onChange={e => setBidderRef(e.target.value)} />
          </div>
        </div>

        {/* Lines */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label className={labelCls}>Priced Lines (ex-GST) <span className="text-brand-red">*</span></label>
            <div className="flex flex-wrap gap-2 mb-1.5">
              <Btn sm variant="ghost" type="button" onClick={addAllPackageCodes}>Add all package cost codes</Btn>
              <Btn sm variant="ghost" type="button" onClick={addRow}>+ Add line</Btn>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {rows.map((row, idx) => (
              <div key={idx} className="grid grid-cols-1 sm:grid-cols-[1.4fr_1.6fr_1fr_auto] gap-2 items-start rounded-lg border border-brand-border p-2.5">
                <select
                  className={inputCls}
                  value={row.costCodeId}
                  onChange={e => setRow(idx, { costCodeId: e.target.value })}
                >
                  <option value="">Cost code…</option>
                  {(pkg.costCodes ?? []).map(cc => (
                    <option key={cc.costCodeId} value={cc.costCodeId}>{cc.costCodeName}</option>
                  ))}
                </select>
                <input
                  className={inputCls}
                  placeholder="Description (optional)"
                  value={row.description}
                  onChange={e => setRow(idx, { description: e.target.value })}
                />
                <input
                  type="number" min="0" step="0.01"
                  className={inputCls}
                  placeholder="Amount ex-GST"
                  value={row.amount}
                  onChange={e => setRow(idx, { amount: e.target.value })}
                />
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  aria-label="Remove line"
                  className="text-brand-muted hover:text-brand-red text-lg leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
            Lines are priced per cost code within this package&apos;s scope, ex-GST ({currencyCode}). No GST is
            recorded on a bid — tax is a commitment-time concern. A zero amount is a legitimate price.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Exclusions</label>
            <textarea
              className={`${inputCls} min-h-[60px]`}
              placeholder="What this bid excludes — shown prominently in the comparison"
              value={exclusions}
              onChange={e => setExclusions(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls}>Notes</label>
            <textarea
              className={`${inputCls} min-h-[60px]`}
              placeholder="Optional"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="rounded-lg border border-brand-border p-3 flex items-baseline justify-between">
          <p className={`${labelCls} mb-0`}>Derived Bid Total (ex-GST)</p>
          <p className="m-0 text-lg font-bold text-brand-text">{money(enteredTotal)}</p>
        </div>
        <p className="m-0 text-[11px] text-brand-muted">
          No total is stored — it is derived from the lines every time the bid is read, so a stored header can
          never disagree with the lines.
        </p>

        {validationError && (bidderContactId || builtLines.length > 0) && (
          <p className="text-[12px] text-brand-red m-0">{validationError}</p>
        )}
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}

        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !!validationError}>
            {saving ? 'Saving…' : isEdit ? 'Save correction' : 'Record bid'}
          </Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Award ────────────────────────────────────────────────────────────────────

function AwardModal({ pkg, bids, budgetLines, currencyCode, onClose, onConfirm }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [awardedBidId, setAwardedBidId] = useState('')
  const [awardNotes, setAwardNotes]     = useState('')
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState(null)

  const comparison = useMemo(
    () => buildTenderComparison({ pkg, bids, budgetLines }),
    [pkg, bids, budgetLines],
  )
  const candidates = comparison.rows.filter(r => !r.isVoid)
  const packageBids = bidsForPackage(bids, pkg.id)
  const selected = packageBids.find(b => b.id === awardedBidId) ?? null
  const blocked = selected ? awardBlockedReason(pkg, selected) : null

  async function submit(e) {
    e.preventDefault()
    if (!selected || blocked) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(pkg, selected, awardNotes)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to award. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell title={`Award ${pkg.tenderNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Awarding records a commercial decision only — it creates <span className="font-semibold">no purchase
          order</span> and changes <span className="font-semibold">no budget, commitment, actual, forecast, or
          cash-flow figure</span>. Raising the PO remains a separate, deliberate step. Awarding is permanent in
          this version and freezes every bid on the package.
        </p>
        <div>
          <label className={labelCls}>Winning Bid <span className="text-brand-red">*</span></label>
          <select className={inputCls} value={awardedBidId} onChange={e => setAwardedBidId(e.target.value)} required>
            <option value="" disabled>Select the winning bid…</option>
            {candidates.map(r => (
              <option key={r.bidId} value={r.bidId} disabled={!r.valid}>
                {r.bidderName} — {r.valid ? `${money(r.total)} ex-GST` : 'invalid (malformed lines)'}
              </option>
            ))}
          </select>
          {candidates.length === 0 && (
            <p className="m-0 mt-1 text-[11px] text-brand-red">This package has no active bids to award.</p>
          )}
        </div>
        {selected && !blocked && (
          <div className="rounded-lg border border-brand-border p-3">
            <p className="m-0 text-[13px] font-semibold text-brand-text">{selected.bidderName}</p>
            <p className="m-0 mt-1 text-[12px] text-brand-muted">
              Derived bid total {money(assessBid(selected, pkg).total)} ex-GST · received {selected.bidDate}
              {String(selected.exclusions || '').trim() ? ' · has exclusions' : ''}
            </p>
          </div>
        )}
        <div>
          <label className={labelCls}>Award Notes</label>
          <textarea
            className={`${inputCls} min-h-[70px]`}
            placeholder="Why this bid won — the decision record"
            value={awardNotes}
            onChange={e => setAwardNotes(e.target.value)}
          />
        </div>
        {blocked && <p className="text-[12px] text-brand-red m-0">{blocked}</p>}
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !selected || !!blocked}>
            {saving ? 'Awarding…' : 'Award package'}
          </Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Cancel package / void bid ────────────────────────────────────────────────

function ReasonModal({ title, description, actionLabel, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!reason.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(reason)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <ModalShell title={title} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">{description}</p>
        <div>
          <label className={labelCls}>Reason <span className="text-brand-red">*</span></label>
          <input className={inputCls} placeholder="Why?" value={reason} onChange={e => setReason(e.target.value)} autoFocus />
        </div>
        {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
          <Btn type="submit" sm disabled={saving || !reason.trim()}>{saving ? 'Working…' : actionLabel}</Btn>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Tender Comparison (read-time table) ──────────────────────────────────────

function ComparisonSection({ pkg, bids, budgetLines, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const comparison = useMemo(
    () => buildTenderComparison({ pkg, bids, budgetLines }),
    [pkg, bids, budgetLines],
  )
  const matrix = useMemo(
    () => costCodeComparisonMatrix({ pkg, bids }),
    [pkg, bids],
  )

  if (comparison.rows.length === 0) {
    return <p className="m-0 text-[12.5px] text-brand-muted">No bids recorded yet.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="m-0 text-[13px] font-bold text-brand-text">Tender Comparison</p>
        <p className="m-0 text-[11px] text-brand-muted">
          {comparison.budget.hasBudget
            ? <>Approved Budget for this package&apos;s cost codes: <span className="font-semibold text-brand-text">{money(comparison.budget.amount)}</span> ex-GST</>
            : 'No Approved Budget lines exist for this package’s cost codes — budget variance unavailable.'}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-brand-card border-b border-brand-border">
              {['Bidder', 'Bid Date', 'Total ex-GST', 'vs Budget', 'vs Lowest', 'Exclusions', 'Status'].map(h => (
                <th key={h} className={thCls}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map(r => (
              <tr key={r.bidId} className={`border-b border-brand-border ${r.isVoid ? 'opacity-60' : ''}`}>
                <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                  {r.bidderName}
                  {r.isAwarded && <Badge label="Awarded" variant="active" sm />}
                  {r.isLowest && !r.isVoid && <span className="ml-1.5 text-[10.5px] font-bold text-brand-accent">LOWEST</span>}
                </td>
                <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{r.bidDate || '—'}</td>
                <td className="px-3.5 py-2.5 text-[13px] font-semibold whitespace-nowrap">
                  {r.valid
                    ? <span className="text-brand-text">{money(r.total)}</span>
                    : <span className="text-brand-red">Invalid</span>}
                </td>
                <td className="px-3.5 py-2.5 text-[13px] whitespace-nowrap">
                  {/* Variance to Budget = Approved Budget − Bid. Positive = under budget. */}
                  {r.valid && r.varianceToBudget !== null
                    ? <span className={r.varianceToBudget < 0 ? 'text-brand-red font-semibold' : 'text-brand-accent font-semibold'}>
                        {r.varianceToBudget < 0 ? `${money(r.varianceToBudget)} over` : `${money(r.varianceToBudget)} under`}
                      </span>
                    : <span className="text-brand-muted">—</span>}
                </td>
                <td className="px-3.5 py-2.5 text-[13px] text-brand-muted whitespace-nowrap">
                  {r.valid && r.varianceToLowest !== null
                    ? (r.isLowest ? '—' : `+${money(r.varianceToLowest)}`)
                    : '—'}
                </td>
                <td className="px-3.5 py-2.5 text-[12px] text-brand-muted max-w-[220px]">
                  {r.hasExclusions
                    ? <span className="text-brand-amber" title={r.exclusions}>⚠ {r.exclusions.length > 60 ? `${r.exclusions.slice(0, 60)}…` : r.exclusions}</span>
                    : '—'}
                  {r.hasNotes && <span className="ml-1" title={r.notes}>📝</span>}
                </td>
                <td className="px-3.5 py-2.5">
                  {r.valid
                    ? <Badge label={BID_STATUS_LABELS[r.status] ?? r.status} variant={BID_BADGE_VARIANTS[r.status]} sm />
                    : <Badge label="Malformed" variant="danger" sm />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {comparison.rows.some(r => !r.valid && !r.isVoid) && (
        <p className="m-0 text-[11px] text-brand-red">
          Malformed bids are excluded from the lowest-bid and budget comparisons and cannot be awarded — correct
          the bid&apos;s lines first. They are never treated as $0.
        </p>
      )}

      {matrix.columns.length > 0 && (
        <div>
          <p className="m-0 mb-1.5 text-[12px] font-bold text-brand-text">By cost code (valid bids)</p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  <th className={thCls}>Cost Code</th>
                  {matrix.columns.map(c => (
                    <th key={c.bidId} className={thCls}>{c.bidderName}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map(row => (
                  <tr key={row.costCodeId} className="border-b border-brand-border">
                    <td className="px-3.5 py-2.5 text-[12.5px] font-semibold text-brand-text whitespace-nowrap">{row.costCodeName}</td>
                    {matrix.columns.map(c => (
                      <td key={c.bidId} className="px-3.5 py-2.5 text-[12.5px] text-brand-muted whitespace-nowrap">
                        {row.amounts[c.bidId] === null ? <span className="text-brand-amber">not priced</span> : money(row.amounts[c.bidId])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="m-0 text-[11px] text-brand-muted">
        Tender Comparison compares derived totals only — it is not bid levelling: no normalisation, no scope-gap
        pricing. Variance to Budget = Approved Budget − Bid (positive = under budget). Void bids remain visible
        for audit and are excluded from every calculation.
      </p>
    </div>
  )
}

// ── Package detail ───────────────────────────────────────────────────────────

function PackageDetailModal({
  pkg, bids, bidsUnavailable, budgetLines, currencyCode,
  onClose, onAddBid, onEditBid, onVoidBid, onAward, onCancel, onEditIssued, onIssue, onEditDraft,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const packageBids = bidsForPackage(bids, pkg.id)
  const awarded = awardedBidValue(pkg, bids)
  const activeBids = receivedBidsForPackage(bids, pkg.id)

  return (
    <ModalShell base wide title={`${pkg.tenderNumber} — ${pkg.name}`} onClose={onClose}>
      <div className="px-5 py-4 flex flex-col gap-4">
        {/* A failed bid subscription must never read as "no bids". The register's
            banner sits behind this overlay, so the warning is repeated here. */}
        {bidsUnavailable && (
          <p className="m-0 text-[12px] text-brand-amber">
            ⚠ Bids couldn&apos;t be loaded, so the list, comparison, and awarded value below are
            <span className="font-semibold"> unavailable — not empty</span>. Nothing here should be relied on, and
            awarding is disabled until they load.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Badge label={TENDER_STATUS_LABELS[pkg.status] ?? pkg.status} variant={TENDER_BADGE_VARIANTS[pkg.status]} />
          {pkg.status === TENDER_STATUS.DRAFT && (
            <>
              <Btn sm variant="ghost" onClick={() => onEditDraft(pkg)}>Edit</Btn>
              <Btn sm variant="success" onClick={() => onIssue(pkg)}>Issue</Btn>
              <Btn sm variant="ghost" onClick={() => onCancel(pkg)}>Cancel package</Btn>
            </>
          )}
          {pkg.status === TENDER_STATUS.ISSUED && (
            <>
              <Btn sm onClick={() => onAddBid(pkg)}>+ Record bid</Btn>
              <Btn sm variant="success" onClick={() => onAward(pkg)} disabled={bidsUnavailable || activeBids.length === 0}>Award…</Btn>
              <Btn sm variant="ghost" onClick={() => onEditIssued(pkg)}>Closing date / notes</Btn>
              <Btn sm variant="ghost" onClick={() => onCancel(pkg)}>Cancel package</Btn>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
          <DetailRow label="Description" value={pkg.description} />
          <DetailRow label="Closing Date" value={pkg.closingDate ? `${pkg.closingDate} (informational)` : 'None'} />
          <DetailRow label="Cost Codes" value={(pkg.costCodes ?? []).map(c => c.costCodeName).join(', ')} />
        </div>
        {pkg.scope && <DetailRow label="Scope of Works" value={pkg.scope} />}
        {pkg.notes && <DetailRow label="Notes" value={pkg.notes} />}
        {pkg.status === TENDER_STATUS.CANCELLED && <DetailRow label="Cancel Reason" value={pkg.cancelReason} />}

        {pkg.status === TENDER_STATUS.AWARDED && (
          <div className="rounded-lg border border-brand-accent/25 bg-brand-accent/5 p-3.5">
            <p className="m-0 text-[13px] font-bold text-brand-text">
              Awarded to {pkg.awardedBidderName}
            </p>
            <p className="m-0 mt-1 text-[13px] text-brand-text">
              Awarded Bid Value:{' '}
              <span className="font-bold">
                {awarded.available ? `${money(awarded.total)} ex-GST` : 'unavailable — awarded bid missing or malformed'}
              </span>
            </p>
            <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
              A tender decision value only, derived from the frozen awarded bid&apos;s lines. It is not a
              commitment: no purchase order was created, it is never netted against POs, and it appears in no
              budget, forecast, margin, or cash-flow figure. Raise the PO separately when ready.
            </p>
            {pkg.awardNotes && <p className="m-0 mt-1.5 text-[12px] text-brand-text">Decision notes: {pkg.awardNotes}</p>}
          </div>
        )}

        {/* Bids */}
        <div>
          <p className="m-0 mb-1.5 text-[13px] font-bold text-brand-text">
            Bids ({packageBids.length})
          </p>
          {packageBids.length === 0 ? (
            <p className={`m-0 text-[12.5px] ${bidsUnavailable ? 'text-brand-amber' : 'text-brand-muted'}`}>
              {bidsUnavailable
                ? 'Unavailable — bids could not be read. This is not a statement that no bids exist.'
                : pkg.status === TENDER_STATUS.DRAFT
                  ? 'Issue the package before recording bids.'
                  : 'No bids recorded yet.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-brand-card border-b border-brand-border">
                    {['Bidder', 'Received', 'Ref', 'Total ex-GST', 'Status', ''].map((h, i) => (
                      <th key={i} className={thCls}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {packageBids.map(b => {
                    const assessment = assessBid(b, pkg)
                    return (
                      <tr key={b.id} className="border-b border-brand-border">
                        <td className="px-3.5 py-2.5 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                          {b.bidderName}
                          {pkg.awardedBidId === b.id && <Badge label="Awarded" variant="active" sm />}
                        </td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{b.bidDate || '—'}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{b.bidderRef || '—'}</td>
                        <td className="px-3.5 py-2.5 text-[13px] font-semibold whitespace-nowrap">
                          {assessment.valid
                            ? <span className="text-brand-text">{money(assessment.total)}</span>
                            : <span className="text-brand-red" title={assessment.problems.join('; ')}>Invalid</span>}
                        </td>
                        <td className="px-3.5 py-2.5">
                          <Badge label={BID_STATUS_LABELS[b.status] ?? b.status} variant={BID_BADGE_VARIANTS[b.status]} sm />
                        </td>
                        <td className="px-3.5 py-2.5">
                          {isBidWritable(b, pkg) && (
                            <div className="flex gap-1.5 justify-end">
                              <Btn sm variant="ghost" onClick={() => onEditBid(pkg, b)}>Correct</Btn>
                              <Btn sm variant="ghost" onClick={() => onVoidBid(pkg, b)}>Void</Btn>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {packageBids.length > 0 && (
          <ComparisonSection pkg={pkg} bids={bids} budgetLines={budgetLines} currencyCode={currencyCode} />
        )}
      </div>
    </ModalShell>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectTenders() {
  const navigate = useNavigate()
  const { projectId, currencyCode } = useOutletContext()

  const { profile, profileLoading } = useProfile()

  const canView = isFinancialRole(profile?.role)
  // Non-financial roles never trigger the commercially-sensitive reads (rules
  // would deny them anyway — this is the UX mirror; rules are the boundary).
  const mid = canView ? projectId : null

  const {
    tenderPackages, tenderPackagesLoading, tenderPackagesError,
    createTenderPackage, updateTenderPackage, issueTenderPackage,
    updateIssuedTenderPackage, awardTenderPackage, cancelTenderPackage,
  } = useTenderPackages(mid)
  const {
    tenderBids, tenderBidsLoading, tenderBidsError,
    createTenderBid, updateTenderBid, voidTenderBid,
  } = useTenderBids(mid)
  const { budgetLines } = useBudgetLines(mid)
  const { costCodes } = useCostCodes()
  const { contacts } = useContacts()

  const [editing, setEditing]           = useState(null) // pkg | 'new' | null
  const [issuing, setIssuing]           = useState(null)
  const [issuedEditing, setIssuedEditing] = useState(null)
  const [detailId, setDetailId]         = useState(null)
  const [addingBidTo, setAddingBidTo]   = useState(null) // pkg
  const [editingBid, setEditingBid]     = useState(null) // { pkg, bid }
  const [awarding, setAwarding]         = useState(null) // pkg
  const [cancelling, setCancelling]     = useState(null) // pkg
  const [voidingBid, setVoidingBid]     = useState(null) // { pkg, bid }
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch]             = useState('')

  const bidderContacts = useMemo(
    () => contacts.filter(c =>
      c.isActive !== false && PO_SUPPLIER_TYPES.some(t => (c.contactTypes ?? []).includes(t)),
    ),
    [contacts],
  )

  // The detail modal reads the LIVE package so an award/void refreshes in place.
  const detailPkg = detailId ? (tenderPackages.find(p => p.id === detailId) ?? null) : null

  const filtered = tenderPackages.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      const hay = [
        p.tenderNumber, p.name, p.description, p.scope, p.awardedBidderName,
        ...(p.costCodes ?? []).map(c => c.costCodeName),
        ...bidsForPackage(tenderBids, p.id).map(b => b.bidderName),
      ].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  // ── Gates ──────────────────────────────────────────────────────────────────
  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!canView) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Tenders are restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          Tender packages and bids expose competitor pricing, so they are visible to Company Admin, Project
          Manager, and QS roles only. Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }
  if (tenderPackagesLoading || tenderBidsLoading) {
    return <div className="text-[13px] text-brand-muted">Loading tenders…</div>
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          Tender packages put to market, the bids received, and the award decision — the step between estimate
          and commitment. Awards create no purchase order.
        </p>
        <div className="flex items-center gap-2">
          {bidderContacts.length === 0 && (
            <Btn variant="ghost" sm onClick={() => navigate('/contacts')}>Add supplier contacts</Btn>
          )}
          <Btn sm onClick={() => setEditing('new')}>+ New Tender Package</Btn>
        </div>
      </div>

      {(tenderPackagesError || tenderBidsError) && (
        <p className="text-[12px] text-brand-amber mb-3">
          Couldn&apos;t load tender data — check your connection and access. Figures shown may be incomplete.
        </p>
      )}

      {tenderPackages.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3.5">
          <input
            className={`${inputCls} max-w-[260px]`}
            placeholder="Search TP #, name, cost code, bidder…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className={`${inputCls} max-w-[170px]`} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {Object.values(TENDER_STATUS).map(s => (
              <option key={s} value={s}>{TENDER_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
      )}

      <Card padding={false}>
        {tenderPackages.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              No tender packages yet. Package up a scope of cost codes and put it to market.
            </p>
            <Btn onClick={() => setEditing('new')}>+ Create your first tender package</Btn>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">No packages match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['TP #', 'Name', 'Cost Codes', 'Closing', 'Bids', 'Awarded To', 'Status', ''].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => {
                  const activeBidCount = receivedBidsForPackage(tenderBids, p.id).length
                  const totalBidCount = bidsForPackage(tenderBids, p.id).length
                  return (
                    <tr key={p.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setDetailId(p.id)}
                          className="text-brand-accent hover:underline cursor-pointer"
                        >
                          {p.tenderNumber}
                        </button>
                      </td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-text">{p.name}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">
                        {(p.costCodes ?? []).length}
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{p.closingDate || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">
                        {activeBidCount}{totalBidCount !== activeBidCount ? ` (+${totalBidCount - activeBidCount} void)` : ''}
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-text whitespace-nowrap">{p.awardedBidderName || '—'}</td>
                      <td className="px-3.5 py-3">
                        <Badge label={TENDER_STATUS_LABELS[p.status] ?? p.status} variant={TENDER_BADGE_VARIANTS[p.status]} sm />
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex gap-1.5 justify-end">
                          {p.status === TENDER_STATUS.DRAFT && (
                            <>
                              <Btn sm variant="ghost" onClick={() => setEditing(p)}>Edit</Btn>
                              <Btn sm variant="success" onClick={() => setIssuing(p)}>Issue</Btn>
                            </>
                          )}
                          {p.status === TENDER_STATUS.ISSUED && (
                            <Btn sm variant="ghost" onClick={() => setAddingBidTo(p)} disabled={bidderContacts.length === 0}>+ Bid</Btn>
                          )}
                          <Btn sm variant="ghost" onClick={() => setDetailId(p.id)}>Open</Btn>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        A tender is a decision record, not a financial document: nothing here changes Budget, Committed, Actual,
        Invoiced, Forecast, Margin, or Cash Flow, and an award creates no purchase order. Closing dates are
        informational only — Constrapp does not block late bids. Bid totals are derived from lines on every read;
        no total is stored.
      </p>

      {editing && (
        <PackageEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          pkg={editing === 'new' ? null : editing}
          costCodes={costCodes}
          onClose={() => setEditing(null)}
          onSave={editing === 'new'
            ? createTenderPackage
            : (data) => updateTenderPackage(editing, data)}
        />
      )}

      {issuing && (
        <IssueModal pkg={issuing} onClose={() => setIssuing(null)} onConfirm={issueTenderPackage} />
      )}

      {issuedEditing && (
        <IssuedEditModal pkg={issuedEditing} onClose={() => setIssuedEditing(null)} onSave={updateIssuedTenderPackage} />
      )}

      {addingBidTo && (
        <BidEditorModal
          pkg={addingBidTo}
          bid={null}
          bidderContacts={bidderContacts}
          tenderBids={tenderBids}
          currencyCode={currencyCode}
          onClose={() => setAddingBidTo(null)}
          onSave={(data) => createTenderBid({ ...data, contacts })}
        />
      )}

      {editingBid && (
        <BidEditorModal
          pkg={editingBid.pkg}
          bid={editingBid.bid}
          bidderContacts={bidderContacts}
          tenderBids={tenderBids}
          currencyCode={currencyCode}
          onClose={() => setEditingBid(null)}
          onSave={(data) => updateTenderBid(editingBid.bid, data)}
        />
      )}

      {awarding && (
        <AwardModal
          pkg={awarding}
          bids={tenderBids}
          budgetLines={budgetLines}
          currencyCode={currencyCode}
          onClose={() => setAwarding(null)}
          onConfirm={awardTenderPackage}
        />
      )}

      {cancelling && (
        <ReasonModal
          title={`Cancel ${cancelling.tenderNumber}`}
          description="Cancelling is permanent — a cancelled package can never be reissued or awarded, its bids freeze immediately, and its number is retained, leaving an intentional gap in the sequence. Records are never deleted."
          actionLabel="Cancel package"
          onClose={() => setCancelling(null)}
          onConfirm={(reason) => cancelTenderPackage(cancelling, reason)}
        />
      )}

      {voidingBid && (
        <ReasonModal
          title={`Void bid — ${voidingBid.bid.bidderName}`}
          description="Voiding is permanent — a voided bid can never be edited or awarded. It stays visible for audit and is excluded from every comparison calculation. Records are never deleted."
          actionLabel="Void bid"
          onClose={() => setVoidingBid(null)}
          onConfirm={(reason) => voidTenderBid(voidingBid.bid, voidingBid.pkg, reason)}
        />
      )}

      {detailPkg && (
        <PackageDetailModal
          pkg={detailPkg}
          bids={tenderBids}
          bidsUnavailable={tenderBidsError}
          budgetLines={budgetLines}
          currencyCode={currencyCode}
          onClose={() => setDetailId(null)}
          onAddBid={(p) => setAddingBidTo(p)}
          onEditBid={(p, b) => setEditingBid({ pkg: p, bid: b })}
          onVoidBid={(p, b) => setVoidingBid({ pkg: p, bid: b })}
          onAward={(p) => setAwarding(p)}
          onCancel={(p) => setCancelling(p)}
          onEditIssued={(p) => setIssuedEditing(p)}
          onIssue={(p) => setIssuing(p)}
          onEditDraft={(p) => setEditing(p)}
        />
      )}
    </div>
  )
}
