import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import BudgetApprovalPanel from '../../src/pages/project/budget/BudgetApprovalPanel'
import BudgetAdjustmentsPanel from '../../src/pages/project/budget/BudgetAdjustmentsPanel'
import BudgetAdjustmentPrepareModal from '../../src/pages/project/budget/BudgetAdjustmentPrepareModal'
import BudgetAdjustmentReviewModal from '../../src/pages/project/budget/BudgetAdjustmentReviewModal'
import BudgetApprovalReviewModal from '../../src/pages/project/budget/BudgetApprovalReviewModal'
import { resolveBudgetSource, workingVsApproved, BUDGET_SOURCE } from '../../src/lib/budgetApproval'
import { pendingAdjustmentSummary } from '../../src/lib/budgetAdjustment'

// ── Budget tab adjustment surfaces — static render smoke (ADR-71) ───────────
//
// No DOM, no Firebase: each presentation component is rendered to static
// markup with react-dom/server against adapter outputs, so a broken prop
// contract, an undefined selector field or a crash in a branch (approved /
// working / unavailable / stale / superseded) fails here rather than in the
// browser. Figures are asserted as text; nothing is summed in the test.

const ENTRIES = [
  { lineId: 'l1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 600000 },
  { lineId: 'l2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 400000 },
]
const ts = (s) => ({ seconds: s, nanoseconds: 0, toDate: () => new Date(s * 1000), toMillis: () => s * 1000 })
const adj = (o = {}) => ({
  id: 'adj1', type: 'increase', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', fromCostCodeId: null, fromCostCodeName: '',
  amount: 50000, currency: 'AUD', reason: 'Client-instructed slab thickening', reference: 'CI-007',
  baseApprovalId: 'ba1', baseVersion: 1, sequence: 1, status: 'approved', revision: 2,
  createdAt: ts(1_700_000_000), createdBy: 'u_qs', updatedAt: ts(1_700_000_100), updatedBy: 'u_pm',
  approvedAt: ts(1_700_000_100), approvedBy: 'u_pm', withdrawnAt: null, withdrawnBy: null, withdrawReason: '', ...o,
})
const stale = adj({ id: 'old', status: 'draft', sequence: null, baseApprovalId: 'ba0', baseVersion: 0, revision: 1, approvedAt: null, approvedBy: null })
const draft = adj({ id: 'd1', status: 'draft', sequence: null, revision: 1, approvedAt: null, approvedBy: null, amount: 1500 })
const ADJUSTMENTS = [adj(), stale, draft]
const approvedBudget = (over = {}) => ({
  pointer: { activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1, adjustmentCount: 1, adjustmentNet: 50000, lastAdjustmentId: 'adj1' },
  header: { id: 'ba1', status: 'approved', version: 1, entryCount: 2, total: 1000000, currency: 'AUD', reason: 'Initial', approvedAt: ts(1_699_000_000), approvedBy: 'u_pm' },
  snapshot: { id: 'ba1', entryCount: 2, total: 1000000, currency: 'AUD', entries: ENTRIES },
  adjustments: [adj()], originalRequested: true, ...over,
})
const budgetLines = ENTRIES.map(e => ({ id: e.lineId, costCodeId: e.costCodeId, costCodeName: e.costCodeName, budgeted: e.budgeted }))
const costCodes = [
  { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
  { id: 'cc2', code: '03-200', name: 'Formwork', isActive: true },
  { id: 'cc9', code: '99-000', name: 'Contingency', isActive: true },
]
const render = (el) => renderToStaticMarkup(el)
const noop = () => {}
const resolved = resolveBudgetSource({ approvedBudget: approvedBudget(), budgetLines, currencyCode: 'AUD' })

describe('BudgetApprovalPanel — the six-figure summary', () => {
  const props = (budget) => ({
    budget, pending: workingVsApproved(budgetLines, budget), pendingAdjustments: pendingAdjustmentSummary(ADJUSTMENTS, 'ba1'),
    approvals: [{ id: 'ba1', status: 'approved', version: 1, reason: 'Initial', total: 1000000, approvedAt: ts(1), approvedBy: 'u_pm', createdAt: ts(1) }],
    approvalsLoading: false, approvalsError: false, currencyCode: 'AUD', currentUid: 'u_pm',
    canPrepare: true, canApprove: true, prepareDisabled: false, prepareDisabledReason: '', onPrepare: noop, onReview: noop,
  })
  it('approved: original, base, net, current adjusted, working and pending drafts all render as figures', () => {
    expect(resolved.kind).toBe(BUDGET_SOURCE.APPROVED)
    const html = render(h(BudgetApprovalPanel, props(resolved)))
    for (const label of ['Original Approved', 'Version 1 base', 'Net adjustments', 'Current Approved Budget', 'Working budget', 'Pending drafts']) expect(html).toContain(label)
    expect(html).toContain('$1,000,000')   // original and base
    expect(html).toContain('+$50,000')     // net
    expect(html).toContain('$1,050,000')   // current adjusted
    expect(html).toMatch(/−\$50,000 vs approved/) // working is below the adjusted figure
    expect(html).toContain('1 adjustment (+$1,500 if approved)')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('NaN')
  })
  it('working (no version) and unavailable render their labels, never $0 for a missing figure', () => {
    const working = resolveBudgetSource({ approvedBudget: null, budgetLines, currencyCode: 'AUD' })
    const w = render(h(BudgetApprovalPanel, props(working)))
    expect(w).toContain('Working budget (not approved)')
    expect(w).toContain('Not approved')
    const broken = resolveBudgetSource({ approvedBudget: approvedBudget({ adjustments: [] }), budgetLines, currencyCode: 'AUD' })
    expect(broken.kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
    const u = render(h(BudgetApprovalPanel, props(broken)))
    expect(u).toContain('Unavailable')
    expect(u).toContain('does not match the pointer')
    expect(u).not.toContain('$0')
  })
})

describe('BudgetAdjustmentsPanel', () => {
  const props = (budget, over = {}) => ({
    budget, adjustments: ADJUSTMENTS, adjustmentsLoading: false, adjustmentsError: false, currencyCode: 'AUD', currentUid: 'u_qs',
    canPrepare: true, canApprove: false, prepareDisabled: false, prepareDisabledReason: '', onPrepare: noop, onOpen: noop, ...over,
  })
  it('lists the active version\'s draft and approved adjustment, flags the stale draft withdraw-only, hides superseded ones behind history', () => {
    const html = render(h(BudgetAdjustmentsPanel, props(resolved)))
    expect(html).toContain('v1 · Adjustment 1')
    expect(html).toContain('v1 · Draft adjustment')
    expect(html).toContain('03-100 — Concrete · +$50,000')
    expect(html).toContain('Stale · withdraw only')
    expect(html).toContain('Withdraw…')
    expect(html).toContain('A draft adjustment is awaiting review')
    expect(html).toContain('reserved for Company Admin and Project Manager')
    expect(html).toContain('Prepare adjustment')
    expect(html).not.toContain('undefined')
  })
  it('a working-budget project offers nothing to adjust; a failed read is unavailable, not empty', () => {
    const working = resolveBudgetSource({ approvedBudget: null, budgetLines, currencyCode: 'AUD' })
    const w = render(h(BudgetAdjustmentsPanel, props(working, { adjustments: [] })))
    expect(w).toContain('nothing to adjust yet')
    expect(w).not.toContain('Prepare adjustment')
    const e = render(h(BudgetAdjustmentsPanel, props(resolved, { adjustmentsError: true })))
    expect(e).toContain('unavailable, not empty')
  })
})

describe('the adjustment dialogs', () => {
  it('prepare: type group, cost-code pickers, the resulting-balance prompt and the save button render', () => {
    const html = render(h(BudgetAdjustmentPrepareModal, { budget: resolved, costCodes, currencyCode: 'AUD', newId: () => 'new1', onPrepare: noop, onClose: noop }))
    for (const t of ['Increase', 'Decrease', 'Transfer', 'Cost code *', 'Amount (ex-GST) *', 'Resulting approved budget', 'Reason *', 'Reference', 'Save draft adjustment']) expect(html).toContain(t)
    expect(html).toContain('99-000 — Contingency')
    expect(html).not.toContain('undefined')
  })
  it('review of a draft shows the movement, the resulting figures and the approve button for an approver', () => {
    const html = render(h(BudgetAdjustmentReviewModal, { adjustment: draft, budget: resolved, currencyCode: 'AUD', currentUid: 'u_pm', canApprove: true, canWithdraw: true, onApprove: noop, onWithdraw: noop, onClose: noop }))
    expect(html).toContain('03-100 — Concrete · +$1,500')
    expect(html).toContain('Approved now')
    expect(html).toContain('$650,000')   // cc1 adjusted now
    expect(html).toContain('$651,500')   // after
    expect(html).toContain('$1,051,500') // project total after
    expect(html).toContain('Approve adjustment')
    expect(html).not.toContain('undefined')
  })
  it('review of a STALE draft is withdraw-only; an approved record is read-only history', () => {
    const s = render(h(BudgetAdjustmentReviewModal, { adjustment: stale, budget: resolved, currencyCode: 'AUD', currentUid: 'u_qs', canApprove: true, canWithdraw: true, onApprove: noop, onWithdraw: noop, onClose: noop }))
    expect(s).toContain('Stale — version replaced')
    expect(s).not.toContain('Approve adjustment')
    expect(s).toContain('Withdraw…')
    const a = render(h(BudgetAdjustmentReviewModal, { adjustment: adj(), budget: resolved, currencyCode: 'AUD', currentUid: 'u_pm', canApprove: true, canWithdraw: true, onApprove: noop, onWithdraw: noop, onClose: noop }))
    expect(a).toContain('Adjustment 1 of version 1')
    expect(a).not.toContain('Approve adjustment')
    expect(a).not.toContain('Withdraw…')
  })
  it('re-approval review with approved adjustments shows the supersession block and its acknowledgement', () => {
    const nextSnapshot = { id: 'ba2', entryCount: 2, total: 1000000, currency: 'AUD', entries: ENTRIES }
    const header = { id: 'ba2', status: 'draft', reason: 'Re-approval', entryCount: 2, total: 1000000, currency: 'AUD', createdAt: ts(1), createdBy: 'u_qs', updatedAt: ts(1), updatedBy: 'u_qs', revision: 1 }
    const html = render(h(BudgetApprovalReviewModal, {
      header, versionLabel: 'Draft', nextVersion: 2, snapshot: nextSnapshot, snapshotLoading: false, snapshotError: false,
      budget: resolved, adjustments: ADJUSTMENTS, currencyCode: 'AUD', currentUid: 'u_pm', canApprove: true, canWithdraw: true,
      onCheckDrift: () => new Promise(() => {}), onApprove: noop, onWithdraw: noop, onClose: noop,
    }))
    expect(html).toContain('This version supersedes approved adjustments')
    expect(html).toContain('Current adjusted approved')
    expect(html).toContain('$1,050,000')
    expect(html).toContain('Proposed version 2')
    expect(html).toContain('−$50,000')
    expect(html).toContain('Approved adjustments to be superseded · 1')
    expect(html).toContain('1 pending adjustment draft on version 1 will become')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('Current approved')  // the per-code column compares with the adjusted figure
    expect(html).not.toContain('undefined')
  })
})
