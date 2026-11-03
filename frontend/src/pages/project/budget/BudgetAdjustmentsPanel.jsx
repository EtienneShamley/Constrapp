import { useState } from 'react'
import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import Card from '../../../components/Card'
import { formatCurrency, formatDate } from '../../../lib/formatters'
import { BUDGET_SOURCE } from '../../../lib/budgetApproval'
import {
  BUDGET_ADJUSTMENT_STATUS, BUDGET_ADJUSTMENT_STATUS_LABELS, BUDGET_ADJUSTMENT_STATUS_BADGE, BUDGET_ADJUSTMENT_TYPE_LABELS,
  budgetAdjustmentHistory, budgetAdjustmentLabel, budgetAdjustmentMovementText,
  isStaleBudgetAdjustment, isSupersededBudgetAdjustment,
} from '../../../lib/budgetAdjustment'

// ── Budget ADJUSTMENTS on the Budget tab (ADR-71) ────────────────────────────
//
// The movements of the ACTIVE approved version — drafts awaiting review and
// approved adjustments in sequence — with Prepare / Review actions, and the
// full history (superseded adjustments of replaced versions, stale and
// withdrawn drafts) behind a disclosure. PRESENTATION ONLY: every figure is a
// field of a record or a selector output; nothing is summed here and nothing
// is written. Adjustments need an approved version: on a working-budget
// project the panel says so and offers nothing.

const whoText = (uid, currentUid) => (uid ? (uid === currentUid ? 'You' : 'Another user') : '—')

function AdjustmentRow({ adj, activeId, currentUid, money, onOpen }) {
  const stale = isStaleBudgetAdjustment(adj, activeId)
  const superseded = isSupersededBudgetAdjustment(adj, activeId)
  const isDraft = adj.status === BUDGET_ADJUSTMENT_STATUS.DRAFT
  return (
    <li className="flex flex-col gap-1.5 rounded-lg bg-brand-bg/60 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="m-0 flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold text-brand-text">
          {budgetAdjustmentLabel(adj)}
          <Badge label={BUDGET_ADJUSTMENT_STATUS_LABELS[adj.status] ?? adj.status} variant={BUDGET_ADJUSTMENT_STATUS_BADGE[adj.status] ?? 'info'} sm />
          <span className="text-[10.5px] font-bold uppercase text-brand-muted">{BUDGET_ADJUSTMENT_TYPE_LABELS[adj.type] ?? adj.type}</span>
          {stale && <span className="text-[10.5px] font-bold uppercase text-brand-amber">Stale · withdraw only</span>}
          {superseded && <span className="text-[10.5px] font-bold uppercase text-brand-muted">Superseded</span>}
        </p>
        <p className="m-0 text-[12px] text-brand-text-soft break-words">{budgetAdjustmentMovementText(adj, money)}</p>
        <p className="m-0 text-[11px] text-brand-muted break-words">
          {adj.reason}{adj.reference ? ` · Ref ${adj.reference}` : ''}
          {` · prepared ${adj.createdAt ? formatDate(adj.createdAt) : '—'} by ${whoText(adj.createdBy, currentUid)}`}
          {adj.status === BUDGET_ADJUSTMENT_STATUS.APPROVED && ` · approved ${adj.approvedAt ? formatDate(adj.approvedAt) : '—'} by ${whoText(adj.approvedBy, currentUid)}`}
          {adj.status === BUDGET_ADJUSTMENT_STATUS.WITHDRAWN && ` · withdrawn ${adj.withdrawnAt ? formatDate(adj.withdrawnAt) : '—'}: ${adj.withdrawReason}`}
        </p>
      </div>
      <div className="shrink-0">
        <Btn sm variant="ghost" onClick={() => onOpen(adj)}>{isDraft ? (stale ? 'Withdraw…' : 'Review') : 'View'}</Btn>
      </div>
    </li>
  )
}

export default function BudgetAdjustmentsPanel({
  budget, adjustments, adjustmentsLoading, adjustmentsError, currencyCode, currentUid,
  canPrepare, canApprove, prepareDisabled, prepareDisabledReason, onPrepare, onOpen,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [showHistory, setShowHistory] = useState(false)
  const approved = budget.kind === BUDGET_SOURCE.APPROVED
  const activeId = budget.pointer?.activeApprovalId ?? null

  const all = budgetAdjustmentHistory(adjustments)
  const current = all.filter(a => a.baseApprovalId === activeId && a.status !== BUDGET_ADJUSTMENT_STATUS.WITHDRAWN)
  const staleDrafts = all.filter(a => isStaleBudgetAdjustment(a, activeId))
  const history = all.filter(a => !current.includes(a) && !staleDrafts.includes(a))
  const drafts = current.filter(a => a.status === BUDGET_ADJUSTMENT_STATUS.DRAFT)

  return (
    <Card className="mb-3.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="m-0 text-[13px] font-bold text-brand-text">Budget adjustments</p>
          <p className="m-0 mt-0.5 text-[12px] text-brand-text-soft">
            {approved
              ? `Approved increases, decreases and transfers on version ${budget.version}. A full re-approval supersedes them.`
              : budget.kind === BUDGET_SOURCE.WORKING
                ? 'Adjustments change an APPROVED budget. Approve a budget version first — there is nothing to adjust yet.'
                : 'Unavailable until the approved budget resolves.'}
          </p>
        </div>
        {canPrepare && approved && (
          <Btn sm variant={drafts.length > 0 ? 'ghost' : 'primary'} onClick={onPrepare} disabled={prepareDisabled} title={prepareDisabledReason || undefined}>
            Prepare adjustment
          </Btn>
        )}
      </div>

      {adjustmentsError ? (
        <p className="m-0 mt-3 text-[12px] text-brand-amber">The budget adjustments could not be read — unavailable, not empty.</p>
      ) : adjustmentsLoading ? (
        <p className="m-0 mt-3 text-[12px] text-brand-muted" role="status">Loading…</p>
      ) : (
        <>
          {drafts.length > 0 && (
            <p className="m-0 mt-3 text-[11.5px] text-brand-amber">
              {drafts.length === 1 ? 'A draft adjustment is' : `${drafts.length} draft adjustments are`} awaiting review
              {canApprove ? '.' : ' — approval is reserved for Company Admin and Project Manager roles.'} Drafts do not count in any figure.
            </p>
          )}
          {staleDrafts.length > 0 && (
            <p className="m-0 mt-2 text-[11.5px] text-brand-amber">
              {staleDrafts.length === 1 ? 'A draft was' : `${staleDrafts.length} drafts were`} prepared against a version that has since been
              replaced — withdraw-only.
            </p>
          )}
          {current.length + staleDrafts.length > 0 ? (
            <ul className="m-0 mt-3 list-none p-0 space-y-1.5">
              {[...staleDrafts, ...current].map(a => (
                <AdjustmentRow key={a.id} adj={a} activeId={activeId} currentUid={currentUid} money={money} onOpen={onOpen} />
              ))}
            </ul>
          ) : approved ? (
            <p className="m-0 mt-3 text-[12px] text-brand-muted">No adjustment has been made to version {budget.version}.</p>
          ) : null}

          {history.length > 0 && (
            <div className="mt-3 border-t border-brand-border pt-3">
              <button type="button" onClick={() => setShowHistory(s => !s)} aria-expanded={showHistory}
                className="inline-flex min-h-[44px] items-center gap-2 text-[12px] font-bold uppercase tracking-[0.4px] text-brand-muted hover:text-brand-text">
                <span className={`transition-transform ${showHistory ? 'rotate-90' : ''}`}>▸</span>
                Adjustment history · {history.length}
              </button>
              {showHistory && (
                <ul className="m-0 list-none p-0 space-y-1.5">
                  {history.map(a => <AdjustmentRow key={a.id} adj={a} activeId={activeId} currentUid={currentUid} money={money} onOpen={onOpen} />)}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
