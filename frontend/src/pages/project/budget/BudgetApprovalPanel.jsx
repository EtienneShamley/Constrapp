import { useState } from 'react'
import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import Card from '../../../components/Card'
import { formatCurrency, formatDate } from '../../../lib/formatters'
import {
  BUDGET_SOURCE, BUDGET_APPROVAL_STATUS, BUDGET_APPROVAL_STATUS_LABELS, BUDGET_APPROVAL_STATUS_BADGE,
  BUDGET_INTEGRITY_PROBLEM_TEXT, budgetApprovalHistory, draftBudgetApprovals, approvedBudgetVersions,
  budgetVersionLabel,
} from '../../../lib/budgetApproval'

// ── The approved-budget panel on the Budget tab (ADR-70) ─────────────────────
//
// Everything about budget approval that is not a budget line: the Approved
// Budget card (the active version, who approved it and when, the original
// total), the Working Budget card (the editable register's total and its
// pending difference from the approved figure), the drafts awaiting review,
// the Prepare / Review actions, and the version history.
//
// PRESENTATION ONLY over lib/budgetApproval.js. Every figure is a selector
// output; the panel performs no arithmetic and never writes. "You / Another
// user" because users/{uid} is client-read-only (ADR-27).

const whoText = (uid, currentUid) => (uid ? (uid === currentUid ? 'You' : 'Another user') : '—')

function Figure({ label, value, hint, tone = 'text-brand-text' }) {
  return (
    <div className="min-w-0">
      <p className="m-0 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted">{label}</p>
      <p className={`m-0 mt-0.5 text-lg font-bold tabular-nums ${tone}`}>{value}</p>
      {hint && <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{hint}</p>}
    </div>
  )
}

export default function BudgetApprovalPanel({
  budget, pending, approvals, approvalsLoading, approvalsError, currencyCode, currentUid,
  canPrepare, canApprove, prepareDisabled, prepareDisabledReason, onPrepare, onReview,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [showHistory, setShowHistory] = useState(false)

  const approved = budget.kind === BUDGET_SOURCE.APPROVED
  const loading = budget.kind === BUDGET_SOURCE.LOADING
  const unavailable = budget.kind === BUDGET_SOURCE.UNAVAILABLE
  const drafts = draftBudgetApprovals(approvals)
  const versions = approvedBudgetVersions(approvals)
  const history = budgetApprovalHistory(approvals)

  const approvedValue = loading ? '—' : unavailable ? 'Unavailable' : approved ? money(budget.total) : 'Not approved'
  const approvedTone = unavailable ? 'text-brand-amber' : approved ? 'text-brand-text' : 'text-brand-amber'
  const workingValue = loading ? '—' : unavailable && !approved ? 'Unavailable' : money(pending.workingTotal)

  return (
    <Card className="mb-3.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="m-0 text-[13px] font-bold text-brand-text">Approved Budget</p>
          {unavailable ? (
            <p className="m-0 mt-0.5 text-[12px] text-brand-amber">
              The approved budget could not be resolved — it is <strong>unavailable, not absent</strong>. Every budget figure on
              this project reads Unavailable until the records agree.
              {budget.problems?.length > 0 && (
                <span className="block mt-1">{budget.problems.map(p => BUDGET_INTEGRITY_PROBLEM_TEXT[p] ?? p).join(' ')}</span>
              )}
            </p>
          ) : loading ? (
            <p className="m-0 mt-0.5 text-[12px] text-brand-muted" role="status">Loading the approved budget…</p>
          ) : approved ? (
            <p className="m-0 mt-0.5 text-[12px] text-brand-text-soft">
              <span className="font-semibold text-brand-text">Version {budget.version}</span>
              {budget.version === 1 && <span className="ml-1.5 text-[10.5px] font-bold uppercase text-brand-accent">Original</span>}
              <span className="block text-[11.5px] text-brand-muted">
                Approved {budget.approvedAt ? formatDate(budget.approvedAt) : '—'} by {whoText(budget.approvedBy, currentUid)}
                {budget.reason ? ` · ${budget.reason}` : ''}
              </span>
            </p>
          ) : (
            <p className="m-0 mt-0.5 text-[12px] text-brand-amber">
              <strong>Working budget (not approved).</strong> No budget version has been approved for this project. Every
              budget figure shown is the editable working register, labelled as such — nothing here is an Approved Budget
              until a version is prepared and approved.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {drafts.length > 0 && (
            <Btn sm onClick={() => onReview(drafts[0])}>
              Review draft{drafts.length > 1 ? ` (${drafts.length})` : ''}
            </Btn>
          )}
          {canPrepare && (
            <Btn sm variant={drafts.length > 0 ? 'ghost' : 'primary'} onClick={onPrepare} disabled={prepareDisabled} title={prepareDisabledReason || undefined}>
              {approved ? 'Prepare new version' : 'Prepare approval'}
            </Btn>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        <Figure label="Approved Budget" value={approvedValue} tone={approvedTone}
          hint={approved ? `Version ${budget.version} · ex-GST · derived from the immutable snapshot` : 'No approved version'} />
        <Figure label="Original Approved Budget" value={loading ? '—' : approved ? (typeof budget.originalTotal === 'number' ? money(budget.originalTotal) : '—') : 'Not approved'}
          tone={approved ? 'text-brand-text' : 'text-brand-muted'} hint={approved ? 'Version 1 · never changes' : undefined} />
        <Figure label="Working budget" value={workingValue}
          hint={approved ? 'The editable register (Σ budget lines)' : 'Σ budget lines · not approved'} />
        <Figure
          label="Pending difference"
          value={!approved || loading ? '—' : pending.difference === 0 && !pending.pending ? 'None' : `${pending.difference > 0 ? '+' : pending.difference < 0 ? '−' : ''}${money(Math.abs(pending.difference))}`}
          tone={approved && pending.pending ? 'text-brand-amber' : 'text-brand-text'}
          hint={approved
            ? (pending.pending
              ? `${pending.changedCount} line${pending.changedCount === 1 ? '' : 's'} changed, ${pending.addedCount} added since version ${budget.version} — not approved`
              : 'Working register matches the approved version')
            : undefined}
        />
      </div>

      {drafts.length > 0 && (
        <p className="m-0 mt-3 text-[11.5px] text-brand-amber">
          {drafts.length === 1 ? 'A draft budget approval is' : `${drafts.length} draft budget approvals are`} awaiting review
          {canApprove ? '.' : ' — approval is reserved for Company Admin and Project Manager roles.'}
        </p>
      )}
      {prepareDisabled && prepareDisabledReason && canPrepare && (
        <p className="m-0 mt-2 text-[11px] text-brand-muted">{prepareDisabledReason}</p>
      )}

      <div className="mt-3 border-t border-brand-border pt-3">
        <button
          type="button"
          onClick={() => setShowHistory(s => !s)}
          className="inline-flex min-h-[44px] items-center gap-2 text-[12px] font-bold uppercase tracking-[0.4px] text-brand-muted hover:text-brand-text"
          aria-expanded={showHistory}
        >
          <span className={`transition-transform ${showHistory ? 'rotate-90' : ''}`}>▸</span>
          Approval history · {approvalsError ? 'unavailable' : approvalsLoading ? '…' : `${versions.length} approved`}
        </button>
        {showHistory && (
          approvalsError ? (
            <p className="m-0 text-[12px] text-brand-amber">The approval history could not be read — unavailable, not empty.</p>
          ) : approvalsLoading ? (
            <p className="m-0 text-[12px] text-brand-muted" role="status">Loading…</p>
          ) : history.length === 0 ? (
            <p className="m-0 text-[12px] text-brand-muted">No budget approval has been prepared for this project.</p>
          ) : (
            <ul className="m-0 list-none p-0 space-y-1.5">
              {history.map(h => (
                <li key={h.id} className="flex flex-col gap-1 rounded-lg bg-brand-bg/60 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="m-0 text-[12.5px] font-semibold text-brand-text">
                      {budgetVersionLabel(h)}
                      <Badge label={BUDGET_APPROVAL_STATUS_LABELS[h.status] ?? h.status} variant={BUDGET_APPROVAL_STATUS_BADGE[h.status] ?? 'info'} sm />
                      {approved && h.id === budget.pointer?.activeApprovalId && <span className="ml-1.5 text-[10.5px] font-bold uppercase text-brand-accent">Current</span>}
                    </p>
                    <p className="m-0 text-[11px] text-brand-muted">
                      {h.reason}
                      {h.status === BUDGET_APPROVAL_STATUS.APPROVED && ` · approved ${h.approvedAt ? formatDate(h.approvedAt) : '—'} by ${whoText(h.approvedBy, currentUid)}`}
                      {h.status === BUDGET_APPROVAL_STATUS.DRAFT && ` · captured ${h.createdAt ? formatDate(h.createdAt) : '—'} by ${whoText(h.createdBy, currentUid)}`}
                      {h.status === BUDGET_APPROVAL_STATUS.WITHDRAWN && ` · withdrawn ${h.withdrawnAt ? formatDate(h.withdrawnAt) : '—'}: ${h.withdrawReason}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[12.5px] font-bold tabular-nums text-brand-text">{typeof h.total === 'number' ? money(h.total) : '—'}</span>
                    {h.status === BUDGET_APPROVAL_STATUS.DRAFT && <Btn sm variant="ghost" onClick={() => onReview(h)}>Review</Btn>}
                  </div>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </Card>
  )
}
