import { useState } from 'react'
import Btn from '../../../components/Btn'
import Badge from '../../../components/Badge'
import ActivityDialog from '../timeline/ActivityDialog'
import { formatCurrency, formatDate } from '../../../lib/formatters'
import { BUDGET_SOURCE, adjustedByCostCode } from '../../../lib/budgetApproval'
import {
  BUDGET_ADJUSTMENT_STATUS, BUDGET_ADJUSTMENT_STATUS_LABELS, BUDGET_ADJUSTMENT_STATUS_BADGE, BUDGET_ADJUSTMENT_TYPE_LABELS,
  BUDGET_ADJUSTMENT_LIMITS, adjustmentPreview, isStaleBudgetAdjustment, budgetAdjustmentLabel,
  budgetAdjustmentMovementText, validateBudgetAdjustmentWithdrawReason,
} from '../../../lib/budgetAdjustment'
import { BUDGET_ADJUSTMENT_ERROR } from '../../../lib/budgetAdjustmentActions'
import { PreviewTable } from './BudgetAdjustmentPrepareModal'

// ── Review a budget ADJUSTMENT — approve or withdraw (ADR-71) ────────────────
//
// The approver sees the movement, who prepared it and why, the version it is
// bound to, and the RESULTING per-cost-code approved budget computed from the
// CURRENT ADJUSTED figures (the shared adapter). Approval re-reads the
// authoritative state from the server, refuses a cost code below zero, and
// refuses when the ledger moved meanwhile (another adjustment) or the version
// was replaced (a re-approval) — nothing is approved against figures the
// approver did not see.
//
// A STALE draft — its version replaced by a re-approval — can only be
// withdrawn: its movement was prepared against figures that no longer apply.
// An approved or withdrawn adjustment is shown read-only: history.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const whoText = (uid, currentUid) => (uid ? (uid === currentUid ? 'You' : 'Another user') : '—')

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3 py-1 border-b border-brand-border last:border-b-0">
      <dt className="m-0 sm:w-[140px] shrink-0 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted">{label}</dt>
      <dd className="m-0 text-[12.5px] text-brand-text break-words">{children}</dd>
    </div>
  )
}

export default function BudgetAdjustmentReviewModal({
  adjustment, budget, currencyCode, currentUid, canApprove, canWithdraw, onApprove, onWithdraw, onClose,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawReason, setWithdrawReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [refused, setRefused] = useState(null)   // a NEGATIVE refusal's server preview

  const isDraft = adjustment?.status === BUDGET_ADJUSTMENT_STATUS.DRAFT
  const activeId = budget?.pointer?.activeApprovalId ?? null
  const stale = isStaleBudgetAdjustment(adjustment, activeId)
  const approvedSource = budget?.kind === BUDGET_SOURCE.APPROVED
  const preview = isDraft && !stale && approvedSource ? adjustmentPreview(adjustedByCostCode(budget), adjustment) : null
  const selfApproval = Boolean(adjustment?.createdBy) && adjustment.createdBy === currentUid
  const approvable = canApprove && isDraft && !stale && approvedSource && preview?.ok && !saving

  async function handleApprove() {
    if (!approvable) return
    setSaving(true); setError(null); setRefused(null)
    try {
      const result = await onApprove(adjustment)
      onClose({ approved: true, sequence: result?.sequence })
    } catch (err) {
      if (err?.kind === BUDGET_ADJUSTMENT_ERROR.NEGATIVE && err?.details?.preview) setRefused(err.details.preview)
      setError(err?.message || 'The adjustment could not be approved. Nothing was changed.')
      setSaving(false)
    }
  }

  async function handleWithdraw(e) {
    e.preventDefault()
    const reasonError = validateBudgetAdjustmentWithdrawReason(withdrawReason)
    if (reasonError) { setError(reasonError); return }
    setSaving(true); setError(null)
    try {
      await onWithdraw(adjustment, withdrawReason)
      onClose({ withdrawn: true })
    } catch (err) {
      setError(err?.message || 'The draft could not be withdrawn. Nothing was changed.')
      setSaving(false)
    }
  }

  return (
    <ActivityDialog title={isDraft ? 'Review budget adjustment' : 'Budget adjustment'} titleId="budget-adjustment-review-title" onClose={() => onClose(null)} busy={saving} panelClassName="max-w-[620px]">
      <div className="p-5">
        <p className="m-0 flex flex-wrap items-center gap-2 text-[15px] font-bold text-brand-text">
          {budgetAdjustmentLabel(adjustment)}
          <Badge label={BUDGET_ADJUSTMENT_STATUS_LABELS[adjustment?.status] ?? adjustment?.status} variant={BUDGET_ADJUSTMENT_STATUS_BADGE[adjustment?.status] ?? 'info'} sm />
          {stale && <span className="text-[10.5px] font-bold uppercase text-brand-amber">Stale — version replaced</span>}
        </p>
        <dl className="m-0 mt-3">
          <Row label="Type">{BUDGET_ADJUSTMENT_TYPE_LABELS[adjustment?.type] ?? adjustment?.type}</Row>
          <Row label="Movement">{budgetAdjustmentMovementText(adjustment, money)}</Row>
          <Row label="Base version">Version {adjustment?.baseVersion ?? '—'}{adjustment?.baseApprovalId === activeId ? ' (current)' : ''}</Row>
          {adjustment?.status === BUDGET_ADJUSTMENT_STATUS.APPROVED && <Row label="Sequence">Adjustment {adjustment.sequence} of version {adjustment.baseVersion}</Row>}
          <Row label="Reason">{adjustment?.reason}</Row>
          <Row label="Reference">{adjustment?.reference || '—'}</Row>
          <Row label="Prepared">{adjustment?.createdAt ? formatDate(adjustment.createdAt) : 'saving…'} by {whoText(adjustment?.createdBy, currentUid)}</Row>
          {adjustment?.approvedBy && <Row label="Approved">{adjustment.approvedAt ? formatDate(adjustment.approvedAt) : '—'} by {whoText(adjustment.approvedBy, currentUid)}</Row>}
          {adjustment?.withdrawnBy && <Row label="Withdrawn">{adjustment.withdrawnAt ? formatDate(adjustment.withdrawnAt) : '—'} by {whoText(adjustment.withdrawnBy, currentUid)} — {adjustment.withdrawReason}</Row>}
        </dl>

        {isDraft && stale && (
          <p className="m-0 mt-3 text-[12px] text-brand-amber">
            This draft was prepared against version {adjustment.baseVersion}, which a re-approval has since replaced. It can no
            longer be approved — withdraw it, and prepare a new adjustment against the current version if it is still needed.
          </p>
        )}
        {isDraft && !stale && !approvedSource && (
          <p className="m-0 mt-3 text-[12px] text-brand-amber">The approved budget is not available, so the resulting figures cannot be shown. Approval is disabled.</p>
        )}
        {preview && (
          <div className="mt-3 rounded-lg border border-brand-border p-3">
            <p className="m-0 text-[12.5px] font-bold text-brand-text">Resulting approved budget</p>
            <PreviewTable preview={refused ?? preview} money={money} />
            <p className="m-0 mt-2 text-[11.5px] text-brand-text-soft">
              Project Approved Budget: {money(budget.total)} → <strong className="text-brand-text">{money(budget.total + (preview.net ?? 0))}</strong>
            </p>
            {!preview.ok && <p className="m-0 mt-1 text-[12px] text-brand-red" role="alert">A cost code would fall below zero. This adjustment cannot be approved as it stands.</p>}
          </div>
        )}
        {isDraft && selfApproval && canApprove && !stale && (
          <p className="m-0 mt-3 text-[11.5px] text-brand-amber">You prepared this adjustment. Approving it yourself is permitted and will show it was prepared and approved by the same person.</p>
        )}
        {isDraft && !canApprove && (
          <p className="m-0 mt-3 text-[11.5px] text-brand-amber">Approval is reserved for Company Admin and Project Manager roles (enforced by Firestore Security Rules).</p>
        )}
        {isDraft && (
          <p className="m-0 mt-3 text-[11px] text-brand-muted">
            Approval changes the Approved Budget and the budget-variance figures only. It moves no actual cost, commitment,
            forecast final cost, payable, cash or margin figure, and writes nothing to the working budget lines. An approved
            adjustment is never edited or deleted — a correction is a separate, approved compensating adjustment.
          </p>
        )}

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red" role="alert">{error}</p>}

        {withdrawing && (
          <form onSubmit={handleWithdraw} className="mt-4 border border-brand-amber/40 rounded-lg p-3">
            <label className={labelCls} htmlFor="adj-withdraw-reason">Reason for withdrawing this draft *</label>
            <input id="adj-withdraw-reason" className={inputCls} autoFocus maxLength={BUDGET_ADJUSTMENT_LIMITS.withdrawReason}
              placeholder="e.g. Superseded by the re-approved version" value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} />
            <div className="flex justify-end gap-2 mt-3">
              <Btn sm variant="ghost" type="button" onClick={() => setWithdrawing(false)} disabled={saving}>Keep draft</Btn>
              <Btn sm variant="danger" type="submit" disabled={saving}>{saving ? 'Withdrawing…' : 'Withdraw draft'}</Btn>
            </div>
          </form>
        )}

        <div className="flex flex-wrap justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={() => onClose(null)} disabled={saving}>Close</Btn>
          {isDraft && !withdrawing && canWithdraw && (
            <Btn variant="ghost" type="button" onClick={() => { setWithdrawing(true); setError(null) }} disabled={saving}>Withdraw…</Btn>
          )}
          {isDraft && canApprove && !stale && (
            <Btn type="button" onClick={handleApprove} disabled={!approvable}>{saving && !withdrawing ? 'Approving…' : 'Approve adjustment'}</Btn>
          )}
        </div>
      </div>
    </ActivityDialog>
  )
}
