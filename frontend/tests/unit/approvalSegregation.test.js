import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  SEGREGATION_EXPLANATION, APPROVAL_ACTION, APPROVAL_BLOCK, SEGREGATION_NOTE,
  segregationEnabled, approvalBlock, segregationNote, isPermissionRefusal, describeApprovalRefusal,
} from '../../src/lib/approvalSegregation'
import BudgetApprovalReviewModal from '../../src/pages/project/budget/BudgetApprovalReviewModal'
import BudgetAdjustmentReviewModal from '../../src/pages/project/budget/BudgetAdjustmentReviewModal'
import { resolveBudgetSource } from '../../src/lib/budgetApproval'

// ── Approval segregation — the UX mirror of the Rules (found in local browser
// acceptance, 28 Nov 2026) ───────────────────────────────────────────────────
//
// With companies/{c}/approvalPolicy/current.segregationEnabled === true the
// Rules refuse four client-written approvals by a preparer. These pins prove
// the helper blocks exactly those viewers, says nothing while the policy is
// not known, and that each of the four surfaces uses it.

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))
const read = (p) => readFileSync(SRC + p, 'utf8')

const ON = { segregationEnabled: true }
const OFF = { segregationEnabled: false }

const WORKFLOWS = [
  { action: APPROVAL_ACTION.BUDGET_VERSION,    requireStamp: false, noun: 'budget draft',      verb: 'approve' },
  { action: APPROVAL_ACTION.BUDGET_ADJUSTMENT, requireStamp: false, noun: 'budget adjustment', verb: 'approve' },
  { action: APPROVAL_ACTION.PO_SEND,           requireStamp: true,  noun: 'purchase order',    verb: 'send' },
  { action: APPROVAL_ACTION.TENDER_AWARD,      requireStamp: true,  noun: 'tender package',    verb: 'award' },
]

describe('segregationEnabled — strict boolean true, as the Rules read it', () => {
  it('only `true` enables it', () => {
    expect(segregationEnabled(ON)).toBe(true)
    for (const p of [OFF, null, undefined, {}, { segregationEnabled: 'true' }, { segregationEnabled: 1 }]) {
      expect(segregationEnabled(p)).toBe(false)
    }
  })
})

describe('approvalBlock — every branch, for the four workflows', () => {
  for (const w of WORKFLOWS) {
    const base = { policy: ON, action: w.action, requireStamp: w.requireStamp }
    describe(w.action, () => {
      it('the creator is blocked, with a plain-English reason', () => {
        const b = approvalBlock({ ...base, uid: 'u1', createdBy: 'u1', lastMaterialEditBy: 'u2' })
        expect(b.code).toBe(APPROVAL_BLOCK.CREATOR)
        expect(b.reason).toContain(`You prepared this ${w.noun}, so you cannot ${w.verb} it.`)
        expect(b.reason).toContain(SEGREGATION_EXPLANATION)
        expect(b.reason).toContain(`Another authorised member must ${w.verb} it.`)
      })
      it('the last material editor is blocked', () => {
        const b = approvalBlock({ ...base, uid: 'u2', createdBy: 'u1', lastMaterialEditBy: 'u2' })
        expect(b.code).toBe(APPROVAL_BLOCK.LAST_EDITOR)
        expect(b.reason).toContain(`You made the last change to this ${w.noun}'s content, so you cannot ${w.verb} it.`)
        expect(b.reason).toContain(SEGREGATION_EXPLANATION)
      })
      it('an independent viewer is not blocked', () => {
        expect(approvalBlock({ ...base, uid: 'u3', createdBy: 'u1', lastMaterialEditBy: 'u2' })).toBeNull()
      })
      it('a missing stamp blocks everyone when the stamp is required, and no one otherwise', () => {
        for (const missing of [undefined, null, 42]) {
          const b = approvalBlock({ ...base, requireStamp: true, uid: 'u3', createdBy: 'u1', lastMaterialEditBy: missing })
          expect(b.code).toBe(APPROVAL_BLOCK.UNRECORDED)
          expect(b.reason).toContain(`This ${w.noun}'s preparer was never recorded`)
          expect(b.reason).toContain(`An authorised member must save a change to its content first, then another member can ${w.verb} it.`)
          expect(approvalBlock({ ...base, requireStamp: false, uid: 'u3', createdBy: 'u1', lastMaterialEditBy: missing })).toBeNull()
        }
        // An empty string is still a string to the Rules (`is string`).
        expect(approvalBlock({ ...base, requireStamp: true, uid: 'u3', createdBy: 'u1', lastMaterialEditBy: '' })).toBeNull()
      })
      it('the creator of an unstamped document is told they prepared it', () => {
        expect(approvalBlock({ ...base, requireStamp: true, uid: 'u1', createdBy: 'u1' }).code).toBe(APPROVAL_BLOCK.CREATOR)
      })
      it('policy disabled, absent or the string "true" blocks no one', () => {
        for (const policy of [OFF, null, undefined, {}, { segregationEnabled: 'true' }]) {
          expect(approvalBlock({ ...base, policy, uid: 'u1', createdBy: 'u1', lastMaterialEditBy: 'u1' })).toBeNull()
          expect(approvalBlock({ ...base, policy, requireStamp: true, uid: 'u3', createdBy: 'u1' })).toBeNull()
        }
      })
      it('no signed-in uid is never matched to a missing preparer', () => {
        expect(approvalBlock({ ...base, uid: undefined, createdBy: undefined, lastMaterialEditBy: 'u2' })).toBeNull()
        expect(approvalBlock({ ...base, uid: '', createdBy: '', lastMaterialEditBy: 'u2' })).toBeNull()
      })
    })
  }
})

describe('segregationNote — unknown says nothing; off keeps the surface wording; on blocks or reassures', () => {
  const ctx = { uid: 'u1', createdBy: 'u1', lastMaterialEditBy: 'u1', action: APPROVAL_ACTION.BUDGET_VERSION }
  it('not known (loading / unreadable): no block, no claim', () => {
    expect(segregationNote({ ...ctx, policy: ON, policyKnown: false })).toEqual({ kind: SEGREGATION_NOTE.UNKNOWN, text: null, block: null })
    expect(segregationNote({ ...ctx, policy: null, policyKnown: false }).kind).toBe(SEGREGATION_NOTE.UNKNOWN)
  })
  it('known off (document missing or disabled)', () => {
    expect(segregationNote({ ...ctx, policy: null, policyKnown: true }).kind).toBe(SEGREGATION_NOTE.OFF)
    expect(segregationNote({ ...ctx, policy: { segregationEnabled: 'true' }, policyKnown: true }).kind).toBe(SEGREGATION_NOTE.OFF)
  })
  it('on and a preparer: blocked with the reason', () => {
    const n = segregationNote({ ...ctx, policy: ON, policyKnown: true })
    expect(n.kind).toBe(SEGREGATION_NOTE.BLOCKED)
    expect(n.text).toBe(n.block.reason)
  })
  it('on and independent: says so', () => {
    const n = segregationNote({ ...ctx, uid: 'u9', policy: ON, policyKnown: true, action: APPROVAL_ACTION.PO_SEND, requireStamp: true })
    expect(n.kind).toBe(SEGREGATION_NOTE.INDEPENDENT)
    expect(n.text).toBe(`You did not prepare this purchase order, so you can send it. ${SEGREGATION_EXPLANATION}`)
  })
})

describe('describeApprovalRefusal — a permission refusal under segregation is explained, certainly', () => {
  const ctx = { policy: ON, uid: 'u1', createdBy: 'u1', lastMaterialEditBy: 'u2', requireStamp: true, action: APPROVAL_ACTION.TENDER_AWARD }
  const refusals = [
    { code: 'permission-denied', name: 'FirebaseError' },
    { code: 'firestore/permission-denied' },
    { kind: 'permission', cause: { code: 'permission-denied' } },
    { kind: 'permission' },
  ]
  it('recognises the refusal shapes', () => {
    for (const e of refusals) expect(isPermissionRefusal(e)).toBe(true)
    for (const e of [null, {}, { code: 'unavailable' }, { kind: 'offline' }, new Error('x')]) expect(isPermissionRefusal(e)).toBe(false)
  })
  it('policy on and the viewer blocked: the specific explanation, certain', () => {
    for (const e of refusals) {
      const r = describeApprovalRefusal(e, ctx)
      expect(r).toMatchObject({ certain: true, kind: 'segregation', code: APPROVAL_BLOCK.CREATOR })
      expect(r.message).toContain('You prepared this tender package, so you cannot award it.')
      expect(r.message).not.toContain('You do not have permission')
    }
    expect(describeApprovalRefusal(refusals[0], { ...ctx, uid: 'u3', lastMaterialEditBy: undefined }).code).toBe(APPROVAL_BLOCK.UNRECORDED)
  })
  it('anything else keeps the caller\'s own message (null)', () => {
    expect(describeApprovalRefusal(refusals[0], { ...ctx, policy: OFF })).toBeNull()
    expect(describeApprovalRefusal(refusals[0], { ...ctx, policy: null })).toBeNull()
    expect(describeApprovalRefusal(refusals[0], { ...ctx, uid: 'u3' })).toBeNull()
    expect(describeApprovalRefusal({ code: 'unavailable' }, ctx)).toBeNull()
    expect(describeApprovalRefusal(refusals[0])).toBeNull()
  })
})

// ── The two budget dialogs render the three states ──────────────────────────

const ts = (s) => ({ seconds: s, nanoseconds: 0, toDate: () => new Date(s * 1000), toMillis: () => s * 1000 })
const ENTRIES = [{ lineId: 'l1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 600000 }]
const budget = resolveBudgetSource({
  approvedBudget: {
    pointer: { activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1, adjustmentCount: 0, adjustmentNet: 0, lastAdjustmentId: null },
    header: { id: 'ba1', status: 'approved', version: 1, entryCount: 1, total: 600000, currency: 'AUD', reason: 'Initial', approvedAt: ts(1), approvedBy: 'u_pm' },
    snapshot: { id: 'ba1', entryCount: 1, total: 600000, currency: 'AUD', entries: ENTRIES },
    adjustments: [], originalRequested: true,
  },
  budgetLines: ENTRIES.map(e => ({ id: e.lineId, costCodeId: e.costCodeId, costCodeName: e.costCodeName, budgeted: e.budgeted })),
  currencyCode: 'AUD',
})
const noop = () => {}
const header = { id: 'ba2', status: 'draft', reason: 'Re-approval', entryCount: 1, total: 600000, currency: 'AUD', createdAt: ts(2), createdBy: 'u_pm', updatedAt: ts(2), updatedBy: 'u_pm', revision: 1 }
const versionModal = (policy, known, uid = 'u_pm') => renderToStaticMarkup(h(BudgetApprovalReviewModal, {
  header, versionLabel: 'Draft', nextVersion: 2, snapshot: { id: 'ba2', entryCount: 1, total: 600000, currency: 'AUD', entries: ENTRIES },
  snapshotLoading: false, snapshotError: false, budget, adjustments: [], currencyCode: 'AUD', currentUid: uid, canApprove: true, canWithdraw: true,
  onCheckDrift: () => new Promise(() => {}), onApprove: noop, onWithdraw: noop, onClose: noop,
  approvalPolicy: policy, approvalPolicyKnown: known,
}))
const draftAdj = {
  id: 'd1', type: 'increase', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', fromCostCodeId: null, fromCostCodeName: '',
  amount: 1500, currency: 'AUD', reason: 'Slab', reference: '', baseApprovalId: 'ba1', baseVersion: 1, sequence: null, status: 'draft', revision: 1,
  createdAt: ts(3), createdBy: 'u_pm', updatedAt: ts(3), updatedBy: 'u_pm', approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
}
const adjustmentModal = (policy, known, uid = 'u_pm') => renderToStaticMarkup(h(BudgetAdjustmentReviewModal, {
  adjustment: draftAdj, budget, currencyCode: 'AUD', currentUid: uid, canApprove: true, canWithdraw: true,
  onApprove: noop, onWithdraw: noop, onClose: noop, approvalPolicy: policy, approvalPolicyKnown: known,
}))
// The `disabled` ATTRIBUTE (the class list carries `disabled:` variants).
const approveButton = (html, label) => {
  const tag = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? ''
  expect(tag).not.toBe('')
  return / disabled=""/.test(tag) ? 'disabled' : 'enabled'
}

describe('budget version review dialog', () => {
  it('segregation known off: today\'s self-approval wording', () => {
    expect(versionModal(OFF, true)).toContain('You captured this draft. Approving it yourself is permitted')
  })
  it('policy not known: neither the self-approval claim nor a block', () => {
    const html = versionModal(ON, false)
    expect(html).not.toContain('Approving it yourself is permitted')
    expect(html).not.toContain(SEGREGATION_EXPLANATION)
  })
  it('segregation on, the capturer: the reason, and Approve disabled', () => {
    const html = versionModal(ON, true)
    expect(html).not.toContain('Approving it yourself is permitted')
    expect(html).toContain('You prepared this budget draft, so you cannot approve it.')
    expect(approveButton(html, 'Approve as version 2')).toBe('disabled')
  })
  it('segregation on, an independent approver: says so', () => {
    expect(versionModal(ON, true, 'u_other')).toContain('You did not prepare this budget draft, so you can approve it.')
  })
})

describe('budget adjustment review dialog', () => {
  it('segregation known off: today\'s self-approval wording, Approve enabled', () => {
    const html = adjustmentModal(OFF, true)
    expect(html).toContain('You prepared this adjustment. Approving it yourself is permitted')
    expect(approveButton(html, 'Approve adjustment')).toBe('enabled')
  })
  it('policy not known: no claim, no block', () => {
    const html = adjustmentModal(ON, false)
    expect(html).not.toContain('Approving it yourself is permitted')
    expect(approveButton(html, 'Approve adjustment')).toBe('enabled')
  })
  it('segregation on, the preparer: the reason, and Approve disabled', () => {
    const html = adjustmentModal(ON, true)
    expect(html).toContain('You prepared this budget adjustment, so you cannot approve it.')
    expect(approveButton(html, 'Approve adjustment')).toBe('disabled')
  })
  it('segregation on, an independent approver: says so, Approve enabled', () => {
    const html = adjustmentModal(ON, true, 'u_other')
    expect(html).toContain('You did not prepare this budget adjustment, so you can approve it.')
    expect(approveButton(html, 'Approve adjustment')).toBe('enabled')
  })
})

// ── Source pins: each of the four surfaces uses the helper ──────────────────

describe('the four surfaces use the shared helper and the policy hook', () => {
  it('the hook subscribes to the one policy document', () => {
    const hook = read('hooks/useApprovalPolicy.jsx')
    expect(hook).toContain("doc(db, 'companies', companyId, 'approvalPolicy', APPROVAL_POLICY_DOC_ID)")
    expect(hook).toContain("APPROVAL_POLICY_DOC_ID = 'current'")
    expect(hook).toContain('const approvalPolicyKnown = settled && !approvalPolicyError')
  })
  it('budget version approval', () => {
    const modal = read('pages/project/budget/BudgetApprovalReviewModal.jsx')
    expect(modal).toContain('action: APPROVAL_ACTION.BUDGET_VERSION')
    expect(modal).toContain('segregationNote({ ...segregationContext, policyKnown: approvalPolicyKnown })')
    expect(modal).toContain('canApprove && !segregationBlocked &&')
    expect(modal).toContain('describeApprovalRefusal(err, segregationContext)')
    expect(modal).toContain('selfApproval && canApprove && segregation.kind === SEGREGATION_NOTE.OFF')
    const page = read('pages/project/ProjectBudget.jsx')
    expect(page).toContain('useApprovalPolicy()')
    expect(page.match(/approvalPolicyKnown=\{approvalPolicyKnown\}/g)).toHaveLength(2)
  })
  it('budget adjustment approval', () => {
    const modal = read('pages/project/budget/BudgetAdjustmentReviewModal.jsx')
    expect(modal).toContain('action: APPROVAL_ACTION.BUDGET_ADJUSTMENT')
    expect(modal).toContain('canApprove && !segregationBlocked &&')
    expect(modal).toContain('describeApprovalRefusal(err, segregationContext)')
    expect(modal).toContain('segregation.kind === SEGREGATION_NOTE.OFF')
  })
  it('purchase-order send', () => {
    const page = read('pages/project/ProjectPurchaseOrders.jsx')
    expect(page).toContain('useApprovalPolicy()')
    expect(page).toContain('requireStamp: true, action: APPROVAL_ACTION.PO_SEND')
    expect(page).toContain('lastMaterialEditBy: po?.lastMaterialEditBy')
    expect(page).toContain("disabled={sendBlocked}>Send</Btn>")
    expect(page).toContain('describeApprovalRefusal(err, sendContext(po))')
  })
  it('tender award', () => {
    const page = read('pages/project/ProjectTenders.jsx')
    expect(page).toContain('useApprovalPolicy()')
    expect(page).toContain('requireStamp: true, action: APPROVAL_ACTION.TENDER_AWARD')
    expect(page).toContain('lastMaterialEditBy: pkg?.lastMaterialEditBy')
    expect(page).toContain('disabled={saving || !selected || !!blocked || segregationBlocked}')
    expect(page).toContain("awardNote?.kind === SEGREGATION_NOTE.BLOCKED}>Award…</Btn>")
    expect(page).toContain('describeApprovalRefusal(err, segregationContext ?? {})')
  })
  it('the helper is pure: no React, no Firebase', () => {
    expect(read('lib/approvalSegregation.js')).not.toMatch(/from 'react|from 'firebase/)
  })
})
