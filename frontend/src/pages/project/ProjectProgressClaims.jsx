import { useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency } from '../../lib/formatters'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { roundMoney } from '../../lib/purchaseOrders'
import {
  CLAIM_STATUS, CLAIM_STATUS_LABELS, CLAIM_BADGE_VARIANTS,
  CLAIMABLE_PO_STATUSES, CLAIM_PENDING_STATUSES,
  approvedLineError, claimTotals, hasOpenClaim, previouslyApprovedByPoLine,
} from '../../lib/progressClaims'

const inputCls    = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const inputErrCls = 'w-full bg-brand-bg border border-brand-red rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-red focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

function TotalsFooter({ totals, heading, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)

  return (
    <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
      <p className="m-0">{heading} <span className="font-semibold ml-2">{money(totals.subtotal)}</span></p>
      <p className="m-0 text-brand-muted">Retention <span className="ml-2">−{money(totals.retention)}</span></p>
      <p className="m-0 text-brand-muted">GST 10% <span className="ml-2">{money(totals.gst)}</span></p>
      <p className="m-0 font-bold">Total payable <span className="ml-2">{money(totals.total)}</span></p>
    </div>
  )
}

function CreateProgressClaimModal({ claimablePOs, progressClaims, currencyCode, onClose, onSave }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const [poId, setPoId]                 = useState('')
  const [periodEnding, setPeriodEnding] = useState('')
  const [claimRef, setClaimRef]         = useState('')
  const [retention, setRetention]       = useState('')
  const [notes, setNotes]               = useState('')
  const [claimedToDate, setClaimedToDate] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const po      = claimablePOs.find(p => p.id === poId) ?? null
  const prevMap = po ? previouslyApprovedByPoLine(progressClaims, po.id) : {}

  const selectPo = (e) => {
    const nextPo = claimablePOs.find(p => p.id === e.target.value)
    setPoId(e.target.value)
    // Cumulative entry: each line starts at its approved-to-date position.
    setClaimedToDate((nextPo?.lineItems ?? []).map((_, idx) =>
      String(previouslyApprovedByPoLine(progressClaims, nextPo.id)[idx] || 0)
    ))
  }
  const setLineClaimed = (idx) => (e) => {
    const value = e.target.value
    setClaimedToDate(vals => vals.map((v, i) => (i === idx ? value : v)))
  }

  const builtLines = (po?.lineItems ?? []).map((li, idx) => {
    const prev    = prevMap[idx] || 0
    const toDate  = Number(claimedToDate[idx]) || 0
    return {
      poLineIndex:        idx,
      costCodeId:         li.costCodeId,
      costCodeName:       li.costCodeName,
      description:        li.description,
      poLineTotal:        li.lineTotal || 0,
      previouslyApproved: prev,
      claimedToDate:      toDate,
      claimedThisPeriod:  roundMoney(toDate - prev),
      approvedThisPeriod: null,
    }
  })
  const totals       = claimTotals(builtLines.map(l => l.claimedThisPeriod), retention)
  const hasBackwards = builtLines.some(l => l.claimedThisPeriod < 0)
  const hasClaim     = builtLines.some(l => l.claimedThisPeriod > 0)
  const valid        = po && hasClaim && !hasBackwards

  async function handleSubmit(e) {
    e.preventDefault()
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      await onSave({ po, periodEnding, claimRef, notes, retention, variationId: null, lineItems: builtLines })
      onClose()
    } catch {
      setError('Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[760px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">New Progress Claim</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>
                Purchase Order <span className="text-brand-red">*</span>
              </label>
              <select className={inputCls} value={poId} onChange={selectPo} required autoFocus>
                <option value="" disabled>Select a sent PO…</option>
                {claimablePOs.map(p => (
                  <option key={p.id} value={p.id}>{p.poNumber} — {p.supplierName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Period Ending</label>
              <input type="date" className={inputCls} value={periodEnding} onChange={e => setPeriodEnding(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Claim Ref</label>
              <input className={inputCls} placeholder="Supplier's reference" value={claimRef} onChange={e => setClaimRef(e.target.value)} />
            </div>
          </div>

          {po && (
            <div>
              <label className={labelCls}>
                Claimed to Date (ex-GST) <span className="text-brand-red">*</span>
              </label>
              <div className="flex flex-col gap-2">
                {builtLines.map((line, idx) => {
                  const overclaimed = line.claimedToDate > line.poLineTotal
                  return (
                    <div key={idx} className="grid grid-cols-2 sm:grid-cols-[2fr_2fr_1fr_1fr_1fr] gap-2 items-center">
                      <p className="m-0 text-[12px] text-brand-text truncate">{line.costCodeName || '—'}</p>
                      <p className="m-0 text-[12px] text-brand-muted truncate">{line.description || '—'}</p>
                      <p className="m-0 text-[12px] text-brand-muted whitespace-nowrap">of {money(line.poLineTotal)}</p>
                      <input
                        type="number" min="0" step="any"
                        className={inputCls}
                        value={claimedToDate[idx] ?? ''}
                        onChange={setLineClaimed(idx)}
                      />
                      <p className={`m-0 text-[12px] whitespace-nowrap ${line.claimedThisPeriod < 0 ? 'text-brand-red' : overclaimed ? 'text-brand-amber' : 'text-brand-muted'}`}>
                        {line.claimedThisPeriod < 0
                          ? 'Below approved'
                          : `+${money(line.claimedThisPeriod)}${overclaimed ? ' ⚠' : ''}`}
                      </p>
                    </div>
                  )
                })}
              </div>
              <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
                Amounts are cumulative — enter total claimed to date per line. Previously approved amounts are pre-filled and cannot be reduced. ⚠ marks a claim above the PO line value.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Retention (ex-GST)</label>
              <input
                type="number" min="0" step="any"
                className={inputCls}
                placeholder="0"
                value={retention}
                onChange={e => setRetention(e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls}>Notes</label>
              <input className={inputCls} placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
          </div>

          <TotalsFooter totals={totals} heading="Claimed this period" currencyCode={currencyCode} />

          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving || !valid}>{saving ? 'Saving…' : 'Create Draft Claim'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

function AssessProgressClaimModal({ claim, currencyCode, onClose, onTransition }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const [approvedAmounts, setApprovedAmounts] = useState(
    (claim.lineItems ?? []).map(li => String(li.claimedThisPeriod ?? 0))
  )
  const [assessmentNotes, setAssessmentNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const setAmount = (idx) => (e) => {
    const value = e.target.value
    setApprovedAmounts(vals => vals.map((v, i) => (i === idx ? value : v)))
  }
  const totals = claimTotals(approvedAmounts, claim.retention)

  const lineErrors = (claim.lineItems ?? []).map((li, idx) => approvedLineError(li, approvedAmounts[idx]))
  const hasInvalid = lineErrors.some(Boolean)

  async function handle(nextStatus) {
    if (nextStatus === CLAIM_STATUS.APPROVED && hasInvalid) return
    setSaving(true)
    setError(null)
    try {
      await onTransition(claim, nextStatus, {
        approvedAmounts: approvedAmounts.map(a => Number(a) || 0),
        assessmentNotes,
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
          <h2 className="text-[15px] font-bold text-brand-text m-0">
            Assess {claim.claimNumber} — {claim.supplierName}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3.5">
          <div>
            <label className={labelCls}>Certified Amounts (ex-GST)</label>
            <div className="flex flex-col gap-2">
              {(claim.lineItems ?? []).map((li, idx) => (
                <div key={idx}>
                  <div className="grid grid-cols-2 sm:grid-cols-[2fr_2fr_1fr_1fr] gap-2 items-center">
                    <p className="m-0 text-[12px] text-brand-text truncate">{li.costCodeName || '—'}</p>
                    <p className="m-0 text-[12px] text-brand-muted truncate">{li.description || '—'}</p>
                    <p className="m-0 text-[12px] text-brand-muted whitespace-nowrap">claimed {money(li.claimedThisPeriod || 0)}</p>
                    <input
                      type="number" min="0" step="any"
                      className={lineErrors[idx] ? inputErrCls : inputCls}
                      aria-invalid={!!lineErrors[idx]}
                      value={approvedAmounts[idx] ?? ''}
                      onChange={setAmount(idx)}
                    />
                  </div>
                  {lineErrors[idx] && (
                    <p className="m-0 mt-1 text-[11px] text-brand-red text-right">{lineErrors[idx]}</p>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className={labelCls}>Assessment Notes</label>
            <input
              className={inputCls}
              placeholder="Why certified differs from claimed (optional)"
              value={assessmentNotes}
              onChange={e => setAssessmentNotes(e.target.value)}
            />
          </div>

          <TotalsFooter totals={totals} heading="Certified this period" currencyCode={currencyCode} />

          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn
              variant="danger" sm type="button" disabled={saving}
              onClick={() => { if (window.confirm(`Reject ${claim.claimNumber}?`)) handle(CLAIM_STATUS.REJECTED) }}
            >
              Reject
            </Btn>
            <Btn sm type="button" disabled={saving || hasInvalid} onClick={() => handle(CLAIM_STATUS.APPROVED)}>
              {saving ? 'Saving…' : 'Approve'}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

function RowActions({ claim, onTransition, onAssess }) {
  // Failures surface via the page-level error banner — swallow the rethrow
  // that exists for the assess modal's benefit.
  const confirmThen = (label, nextStatus) => () => {
    if (window.confirm(`${label} ${claim.claimNumber}?`)) onTransition(claim, nextStatus).catch(() => {})
  }

  if (claim.status === CLAIM_STATUS.DRAFT) {
    return (
      <div className="flex gap-1.5 justify-end">
        <Btn sm variant="success" onClick={confirmThen('Submit', CLAIM_STATUS.SUBMITTED)}>Submit</Btn>
        <Btn sm variant="ghost" onClick={confirmThen('Withdraw', CLAIM_STATUS.REJECTED)}>Withdraw</Btn>
      </div>
    )
  }
  if (CLAIM_PENDING_STATUSES.includes(claim.status)) {
    return (
      <div className="flex gap-1.5 justify-end">
        <Btn sm variant="success" onClick={() => onAssess(claim)}>Assess</Btn>
      </div>
    )
  }
  return null
}

export default function ProjectProgressClaims() {
  const navigate = useNavigate()
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { progressClaims, progressClaimsLoading, createProgressClaim, transitionStatus } = useProgressClaims(projectId)
  const { purchaseOrders, purchaseOrdersLoading } = usePurchaseOrders(projectId)
  const [showCreate, setShowCreate]     = useState(false)
  const [assessing, setAssessing]       = useState(null)
  const [actionError, setActionError]   = useState(null)

  // A PO takes one open claim at a time — hide POs with a live claim.
  const claimablePOs = purchaseOrders.filter(po =>
    CLAIMABLE_PO_STATUSES.includes(po.status) && !hasOpenClaim(progressClaims, po.id)
  )
  const noSentPOs = !purchaseOrdersLoading &&
    !purchaseOrders.some(po => CLAIMABLE_PO_STATUSES.includes(po.status))
  const goToPOs = () => navigate(`/projects/${projectId}/purchase-orders`)

  async function handleTransition(claim, nextStatus, extras) {
    setActionError(null)
    try {
      await transitionStatus(claim, nextStatus, extras)
    } catch (err) {
      setActionError('Failed to update status. Check your connection and try again.')
      throw err
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          {noSentPOs
            ? 'Send a purchase order before raising progress claims.'
            : 'Supplier claims assessed against sent purchase orders.'}
        </p>
        <div className="flex items-center gap-2">
          {noSentPOs && (
            <Btn variant="ghost" sm onClick={goToPOs}>Go to Purchase Orders</Btn>
          )}
          <Btn sm onClick={() => setShowCreate(true)} disabled={purchaseOrdersLoading || claimablePOs.length === 0}>
            + New Progress Claim
          </Btn>
        </div>
      </div>

      {actionError && <p className="text-[12px] text-brand-red mb-3">{actionError}</p>}

      <Card padding={false}>
        {progressClaimsLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading progress claims…</div>
        ) : progressClaims.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {noSentPOs
                ? 'Send a purchase order before raising progress claims.'
                : 'No progress claims yet. Record your first supplier claim.'}
            </p>
            {noSentPOs ? (
              <Btn variant="ghost" onClick={goToPOs}>Go to Purchase Orders</Btn>
            ) : (
              <Btn onClick={() => setShowCreate(true)} disabled={claimablePOs.length === 0}>
                + Create your first progress claim
              </Btn>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['Claim #', 'PO', 'Supplier', 'Period', 'Claimed (inc. GST)', 'Approved (inc. GST)', 'Status', ''].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {progressClaims.map(claim => (
                  <tr key={claim.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">{claim.claimNumber}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text whitespace-nowrap">{claim.poNumber}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text">{claim.supplierName}</td>
                    <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{claim.periodEnding || '—'}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text whitespace-nowrap">{money(claim.claimedTotal || 0)}</td>
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text whitespace-nowrap">
                      {claim.approvedTotal == null ? '—' : money(claim.approvedTotal)}
                    </td>
                    <td className="px-3.5 py-3">
                      <Badge label={CLAIM_STATUS_LABELS[claim.status] ?? claim.status} variant={CLAIM_BADGE_VARIANTS[claim.status]} sm />
                    </td>
                    <td className="px-3.5 py-3">
                      <RowActions claim={claim} onTransition={handleTransition} onAssess={setAssessing} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showCreate && (
        <CreateProgressClaimModal
          currencyCode={currencyCode}
          claimablePOs={claimablePOs}
          progressClaims={progressClaims}
          onClose={() => setShowCreate(false)}
          onSave={createProgressClaim}
        />
      )}
      {assessing && (
        <AssessProgressClaimModal
          currencyCode={currencyCode}
          claim={assessing}
          onClose={() => setAssessing(null)}
          onTransition={handleTransition}
        />
      )}
    </div>
  )
}
