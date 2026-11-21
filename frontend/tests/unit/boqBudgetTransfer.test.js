import { describe, it, expect } from 'vitest'
import {
  TRANSFER_ROW_STATE as S, TRANSFER_BLOCKER as B, TRANSFER_OPERATION as OP,
  BOQ_TRANSFER_ROLES, canTransferBoqToBudget, boqBudgetLineId, isBoqSourcedLine, boqSourceInfo,
  buildTransferProposal, sourceFingerprint, transferOperations, transferSummary, transferRequestKey,
  normaliseZeroChoices, applyOperationsToLines, resultKeyAfter, findAppliedRequest, isReviewKeyShape, centsToAmount,
} from '../../src/lib/boqBudgetTransfer'
import { boqByCostCode, boqLineAmount } from '../../src/lib/boq'
import { buildBudgetCapturePayload, resolveBudgetSource, BUDGET_SOURCE } from '../../src/lib/budgetApproval'

// ── BOQ → working budget transfer proposal (L4, ADR-81) ──────────────────────
//
// Pure tests of the ONE module the browser and the trusted callable share.

const CODES = [
  { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
  { id: 'cc2', code: '05-100', name: 'Steel', isActive: true },
  { id: 'cc3', code: '09-100', name: 'Finishes', isActive: true },
  { id: 'ccOff', code: '99-000', name: 'Retired', isActive: false },
]
let n = 0
const item = (costCodeId, quantity, rate, over = {}) => {
  n += 1
  return {
    id: over.id ?? `i${n}`, status: 'active', costCodeId, costCodeName: `name-${costCodeId}`, description: 'x', unit: 'm2',
    quantity, rate, amount: boqLineAmount(quantity, rate), currency: 'AUD', ...over,
  }
}
const manual = (id, costCodeId, budgeted) => ({ id, costCodeId, costCodeName: `name-${costCodeId}`, budgeted })
const sourced = (costCodeId, budgeted, latest = {}) => ({
  id: boqBudgetLineId(costCodeId), costCodeId, costCodeName: `name-${costCodeId}`, budgeted,
  boqSource: { first: { amount: budgeted, itemCount: 1 }, latest: { amount: budgeted, itemCount: 1, transferCount: 1, ...latest } },
})
const propose = (boqItems, budgetLines = [], over = {}) => buildTransferProposal({ boqItems, budgetLines, costCodes: CODES, currencyCode: 'AUD', ...over })
const row = (p, id) => p.rows.find(r => r.costCodeId === id)

describe('roles and line identity', () => {
  it('the transfer roles are the budget authoring roles', () => {
    expect(BOQ_TRANSFER_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    for (const r of BOQ_TRANSFER_ROLES) expect(canTransferBoqToBudget(r)).toBe(true)
    for (const r of ['subcontractor', 'client', 'super_admin', undefined]) expect(canTransferBoqToBudget(r)).toBe(false)
  })
  it('one deterministic line id per cost code; a line is BOQ-sourced only at that id WITH the provenance map', () => {
    expect(boqBudgetLineId('cc1')).toBe('boq-cc1')
    expect(isBoqSourcedLine(sourced('cc1', 5))).toBe(true)
    expect(isBoqSourcedLine(manual('abc', 'cc1', 5))).toBe(false)
    expect(isBoqSourcedLine({ id: 'boq-cc1', costCodeId: 'cc1', budgeted: 5 })).toBe(false)               // no provenance
    expect(isBoqSourcedLine({ id: 'boq-cc2', costCodeId: 'cc1', budgeted: 5, boqSource: {} })).toBe(false) // another code's id
  })
})

describe('grouping, amounts and cents', () => {
  it('folds ACTIVE items by cost code and agrees with lib/boq.js to the cent', () => {
    const items = [item('cc1', 10, 12.5), item('cc1', 3, 0.1), item('cc2', 7, 19.99), item('cc2', 1, 5, { status: 'void' })]
    const p = propose(items)
    const fold = boqByCostCode(items)
    expect(row(p, 'cc1').boqCents).toBe(Math.round(fold.cc1.amount * 100))
    expect(row(p, 'cc2').boqCents).toBe(Math.round(fold.cc2.amount * 100))
    expect(row(p, 'cc1').boqCents).toBe(12530)
    expect(row(p, 'cc2').itemCount).toBe(1)   // the void item is not counted
  })
  it('sums in whole cents — three items of 0.1 × 0.1 and classic float sums do not drift', () => {
    const items = [item('cc1', 1, 0.1), item('cc1', 1, 0.2), item('cc1', 1, 0.3), item('cc1', 3, 0.335)]
    expect(row(propose(items), 'cc1').boqCents).toBe(10 + 20 + 30 + Math.round(boqLineAmount(3, 0.335) * 100))
    const many = Array.from({ length: 200 }, () => item('cc2', 1, 0.07))
    expect(row(propose(many), 'cc2').boqCents).toBe(1400)
  })
  it('a ZERO rate is a price: the code is transferable at 0', () => {
    const p = propose([item('cc1', 5, 0)])
    expect(row(p, 'cc1')).toMatchObject({ state: S.CREATE, boqCents: 0, blockers: [] })
    expect(transferOperations(p).operations).toEqual([expect.objectContaining({ type: OP.CREATE, amount: 0, lineId: 'boq-cc1' })])
  })
  it('a NULL rate is unpriced: the whole code is blocked, even when other items are priced — never a partial sum', () => {
    const p = propose([item('cc1', 5, 10), item('cc1', 2, null)])
    expect(row(p, 'cc1')).toMatchObject({ state: S.BLOCKED, blockers: [B.UNPRICED], boqCents: null, unpricedCount: 1 })
    expect(transferOperations(p).operations).toEqual([])
  })
  it('void items are excluded; a code with ONLY void items and no sourced line is not a row', () => {
    const p = propose([item('cc1', 5, 10, { status: 'void' }), item('cc2', 1, 1)])
    expect(p.rows.map(r => r.costCodeId)).toEqual(['cc2'])
  })
  it('an item whose stored amount is not quantity × rate blocks the code', () => {
    const p = propose([item('cc1', 5, 10, { amount: 49.99 })])
    expect(row(p, 'cc1')).toMatchObject({ state: S.BLOCKED, blockers: [B.INVALID_SOURCE], boqCents: null })
    for (const bad of [{ quantity: -1 }, { quantity: '5' }, { amount: null }, { rate: -2, amount: 0 }]) {
      expect(row(propose([item('cc1', 5, 10, bad)]), 'cc1').blockers).toContain(B.INVALID_SOURCE)
    }
  })
})

describe('blockers', () => {
  it('a missing cost code and an inactive cost code are blocked', () => {
    const p = propose([item('ccGone', 1, 1), item('ccOff', 1, 1)])
    expect(row(p, 'ccGone')).toMatchObject({ state: S.BLOCKED, blockers: [B.COST_CODE_MISSING] })
    expect(row(p, 'ccOff')).toMatchObject({ state: S.BLOCKED, blockers: [B.COST_CODE_INACTIVE] })
  })
  it('a currency mismatch blocks the code; currencies are never mixed', () => {
    const p = propose([item('cc1', 1, 100), item('cc1', 1, 50, { currency: 'NZD' }), item('cc2', 1, 1)])
    expect(row(p, 'cc1').blockers).toEqual([B.CURRENCY_MISMATCH])
    expect(row(p, 'cc2').state).toBe(S.CREATE)
    expect(row(propose([item('cc1', 1, 1)], [], { currencyCode: null }), 'cc1').blockers).toEqual([B.CURRENCY_MISMATCH])
  })
  it('an existing MANUAL line on the code blocks the transfer — no second line is ever proposed', () => {
    const p = propose([item('cc1', 1, 100)], [manual('m1', 'cc1', 80)])
    expect(row(p, 'cc1')).toMatchObject({ state: S.BLOCKED, blockers: [B.MANUAL_LINE], workingCents: 8000, hasSourcedLine: false })
  })
  it('two manual lines on one code are blocked the same way; the working figure is their sum', () => {
    const p = propose([item('cc1', 1, 100)], [manual('m1', 'cc1', 80), manual('m2', 'cc1', 20.5)])
    expect(row(p, 'cc1')).toMatchObject({ blockers: [B.MANUAL_LINE], workingCents: 10050, manualLineCount: 2 })
  })
  it('a BOQ-sourced line that shares its code with a manual line cannot be refreshed', () => {
    const p = propose([item('cc1', 1, 100)], [sourced('cc1', 90), manual('m1', 'cc1', 10)])
    expect(row(p, 'cc1')).toMatchObject({ state: S.BLOCKED, blockers: [B.MULTIPLE_LINES], workingCents: 10000 })
  })
  it('a BOQ-sourced line with an unreadable amount is blocked', () => {
    const p = propose([item('cc1', 1, 100)], [sourced('cc1', 'ninety')])
    expect(row(p, 'cc1').blockers).toEqual([B.INVALID_LINE])
  })
  it('every reason is reported together, sorted', () => {
    const p = propose([item('ccOff', 1, null), item('ccOff', 1, 2, { currency: 'USD' })], [manual('m', 'ccOff', 1)])
    expect(row(p, 'ccOff').blockers).toEqual([B.COST_CODE_INACTIVE, B.CURRENCY_MISMATCH, B.MANUAL_LINE, B.UNPRICED].sort())
  })
  it('a manual line on a code the BOQ does not touch is not a row at all', () => {
    expect(propose([item('cc1', 1, 1)], [manual('m', 'cc3', 500)]).rows.map(r => r.costCodeId)).toEqual(['cc1'])
  })
})

describe('create, refresh, unchanged, fully voided', () => {
  it('create when no line holds the code', () => {
    expect(row(propose([item('cc1', 2, 50)]), 'cc1')).toMatchObject({ state: S.CREATE, boqCents: 10000, workingCents: null, lineId: 'boq-cc1' })
  })
  it('unchanged when the sourced line already equals the BOQ; refresh when it does not', () => {
    const items = [item('cc1', 2, 50)]
    expect(row(propose(items, [sourced('cc1', 100)]), 'cc1').state).toBe(S.UNCHANGED)
    const r = row(propose(items, [sourced('cc1', 80)]), 'cc1')
    expect(r).toMatchObject({ state: S.REFRESH, boqCents: 10000, sourcedCents: 8000, manuallyChanged: false })
  })
  it('a sourced line edited by hand is flagged; the latest-transfer amount is reported beside it', () => {
    const r = row(propose([item('cc1', 2, 50)], [{ ...sourced('cc1', 100), budgeted: 130 }]), 'cc1')
    expect(r).toMatchObject({ state: S.REFRESH, manuallyChanged: true, latestTransferCents: 10000, sourcedCents: 13000 })
    expect(boqSourceInfo({ ...sourced('cc1', 100), budgeted: 130 })).toMatchObject({ isBoqSourced: true, manuallyChanged: true })
    expect(boqSourceInfo(sourced('cc1', 100)).manuallyChanged).toBe(false)
    expect(boqSourceInfo(manual('m', 'cc1', 1))).toEqual({ isBoqSourced: false, first: null, latest: null, manuallyChanged: false })
  })
  it('all transferred items void: set-to-zero is OFFERED, never applied by default', () => {
    const p = propose([item('cc1', 2, 50, { status: 'void' })], [sourced('cc1', 100)])
    expect(row(p, 'cc1')).toMatchObject({ state: S.ZERO_AVAILABLE, itemCount: 0, boqCents: null, workingCents: 10000 })
    expect(transferOperations(p).operations).toEqual([])                                   // unticked: nothing
    expect(transferOperations(p, ['cc1']).operations).toEqual([expect.objectContaining({ type: OP.ZERO, amount: 0, fromCents: 10000 })])
  })
  it('a fully voided code already at zero is unchanged', () => {
    expect(row(propose([], [sourced('cc1', 0)]), 'cc1').state).toBe(S.UNCHANGED)
  })
  it('set-to-zero on a code that is not eligible invalidates the whole request', () => {
    const p = propose([item('cc1', 2, 50), item('cc2', 1, 1)], [sourced('cc1', 80)])
    expect(transferOperations(p, ['cc1'])).toMatchObject({ ok: false, invalidZero: ['cc1'], operations: [] })
    expect(transferOperations(p, ['nope']).ok).toBe(false)
    expect(transferSummary(p, ['cc1']).valid).toBe(false)
  })
})

describe('summary', () => {
  it('counts every state and totals the operations in whole cents', () => {
    const items = [item('cc1', 1, 100), item('cc2', 1, 60), item('cc3', 1, null), item('ccOff', 2, 10)]
    const lines = [sourced('cc2', 50)]
    const s = transferSummary(propose(items, lines))
    expect(s).toMatchObject({
      valid: true, rowCount: 4, createCount: 1, refreshCount: 1, zeroCount: 0, operationCount: 2, unchangedCount: 0, blockedCount: 2,
      beforeCents: 5000, afterCents: 16000, blockedBoqCents: 2000, blockedUnknownCount: 1,
    })
    expect(centsToAmount(s.afterCents)).toBe(160)
  })
  it('the resulting register sums to the BOQ priced total when nothing is blocked', () => {
    const items = [item('cc1', 3, 33.33), item('cc1', 1, 0.01), item('cc2', 7, 19.99), item('cc3', 2, 0)]
    const p = propose(items)
    const next = applyOperationsToLines([], transferOperations(p).operations)
    const total = next.reduce((s, l) => s + Math.round(l.budgeted * 100), 0)
    expect(total).toBe(items.reduce((s, i) => s + Math.round(i.amount * 100), 0))
    expect(next.map(l => l.id).sort()).toEqual(['boq-cc1', 'boq-cc2', 'boq-cc3'])
  })
})

describe('fingerprint and reviewKey', () => {
  const items = () => [item('cc1', 2, 50, { id: 'a' }), item('cc1', 1, 7, { id: 'b' }), item('cc2', 4, 2.5, { id: 'c' })]
  it('the key has a fixed shape and is deterministic', () => {
    const k = propose(items()).reviewKey
    expect(isReviewKeyShape(k)).toBe(true)
    expect(propose(items()).reviewKey).toBe(k)
    expect(isReviewKeyShape('v1:xyz')).toBe(false)
    expect(isReviewKeyShape(null)).toBe(false)
  })
  it('read order, timestamps, actors, names, descriptions and notes do NOT change the key', () => {
    const base = propose(items(), [sourced('cc2', 9)]).reviewKey
    const shuffled = [...items()].reverse().map(i => ({ ...i, description: 'renamed', notes: 'n', costCodeName: 'other', updatedAt: { seconds: 9 }, updatedBy: 'u9', itemNumber: '9.9', section: 'Z' }))
    const line = { ...sourced('cc2', 9, { at: { seconds: 5 }, by: 'someone' }), notes: 'changed', updatedAt: { seconds: 77 } }
    expect(buildTransferProposal({ boqItems: shuffled, budgetLines: [line], costCodes: [...CODES].reverse().map(c => ({ ...c, name: `${c.name}!` })), currencyCode: 'AUD' }).reviewKey).toBe(base)
  })
  it.each([
    ['a quantity', (i) => { i[0].quantity = 3; i[0].amount = 150 }],
    ['a rate', (i) => { i[1].rate = 8; i[1].amount = 8 }],
    ['a unit', (i) => { i[2].unit = 'm' }],
    ['a new item', (i) => { i.push(item('cc1', 1, 1, { id: 'z' })) }],
    ['a voided item', (i) => { i[1].status = 'void' }],
    ['an item becoming unpriced', (i) => { i[2].rate = null; i[2].amount = null }],
    ['an item moving cost code', (i) => { i[2].costCodeId = 'cc3' }],
  ])('%s changes the key', (_label, mutate) => {
    const base = propose(items()).reviewKey
    const changed = items(); mutate(changed)
    expect(propose(changed).reviewKey).not.toBe(base)
  })
  it('a working-line amount, a new manual line, a deactivated cost code and the currency each change the key', () => {
    const base = propose(items(), [sourced('cc2', 10)]).reviewKey
    expect(propose(items(), [sourced('cc2', 11)]).reviewKey).not.toBe(base)
    expect(propose(items(), [sourced('cc2', 10), manual('m', 'cc1', 1)]).reviewKey).not.toBe(base)
    expect(propose(items(), [sourced('cc2', 10)], { costCodes: CODES.map(c => (c.id === 'cc1' ? { ...c, isActive: false } : c)) }).reviewKey).not.toBe(base)
    expect(propose(items(), [sourced('cc2', 10)], { currencyCode: 'NZD' }).reviewKey).not.toBe(base)
  })
  it('the source fingerprint depends on the items only, by id order', () => {
    const [a, b] = items()
    expect(sourceFingerprint('cc1', [a, b])).toBe(sourceFingerprint('cc1', [b, a]))
    expect(sourceFingerprint('cc1', [a, b])).not.toBe(sourceFingerprint('cc1', [a]))
    expect(sourceFingerprint('cc1', [])).not.toBe(sourceFingerprint('cc2', []))
    expect(sourceFingerprint('cc1', [a])).toMatch(/^v1:[0-9a-f]{32}$/)
  })
  it('the request key binds the review to the set-to-zero choices, order-free', () => {
    expect(normaliseZeroChoices(['b', 'a', 'b', '', null])).toEqual(['a', 'b'])
    expect(transferRequestKey('v1:k', ['b', 'a'])).toBe(transferRequestKey('v1:k', ['a', 'b']))
    expect(transferRequestKey('v1:k', ['a'])).not.toBe(transferRequestKey('v1:k', []))
    expect(transferRequestKey('v1:k', [])).not.toBe(transferRequestKey('v1:j', []))
  })
})

describe('already-applied recognition', () => {
  const state = () => ({ boqItems: [item('cc1', 2, 50, { id: 'a' }), item('cc2', 1, 30, { id: 'b' })], costCodes: CODES, currencyCode: 'AUD' })
  // What the callable stores: the request key and the key of the state it produced.
  function apply(s, budgetLines, zero = []) {
    const before = buildTransferProposal({ ...s, budgetLines })
    const ops = transferOperations(before, zero).operations
    const requestKey = transferRequestKey(before.reviewKey, zero)
    const resultKey = resultKeyAfter({ ...s, budgetLines }, ops)
    const next = applyOperationsToLines(budgetLines, ops).map(l => (ops.some(o => o.lineId === l.id)
      ? { ...l, boqSource: { first: l.boqSource?.first ?? { amount: l.budgeted }, latest: { amount: l.budgeted, requestKey, resultKey, by: 'u1' } } }
      : l))
    return { before, next, requestKey, resultKey }
  }

  it('after a commit the same request no longer matches the current key, and is recognised as applied', () => {
    const s = state()
    const { before, next, requestKey, resultKey } = apply(s, [])
    const now = buildTransferProposal({ ...s, budgetLines: next })
    expect(now.reviewKey).not.toBe(before.reviewKey)
    expect(now.reviewKey).toBe(resultKey)
    expect(now.rows.every(r => r.state === S.UNCHANGED)).toBe(true)
    expect(findAppliedRequest(next, requestKey, now.reviewKey)).toEqual({ lineId: 'boq-cc1', by: 'u1' })
  })
  it('a BOQ change after the commit is NOT recognised as already applied', () => {
    const s = state()
    const { next, requestKey } = apply(s, [])
    const changed = { ...s, boqItems: [...s.boqItems, item('cc1', 1, 5, { id: 'new' })] }
    expect(findAppliedRequest(next, requestKey, buildTransferProposal({ ...changed, budgetLines: next }).reviewKey)).toBeNull()
  })
  it('a manual edit of a working line after the commit is NOT recognised as already applied', () => {
    const s = state()
    const { next, requestKey } = apply(s, [])
    const edited = next.map(l => (l.id === 'boq-cc2' ? { ...l, budgeted: 31 } : l))
    expect(findAppliedRequest(edited, requestKey, buildTransferProposal({ ...s, budgetLines: edited }).reviewKey)).toBeNull()
  })
  it('a different request (other review, or other set-to-zero choices) is never matched', () => {
    const s = state()
    const { next, resultKey, before } = apply(s, [])
    expect(findAppliedRequest(next, transferRequestKey('v1:' + '0'.repeat(32), []), resultKey)).toBeNull()
    expect(findAppliedRequest(next, transferRequestKey(before.reviewKey, ['cc9']), resultKey)).toBeNull()
  })
  it('a set-to-zero request is recognised the same way', () => {
    const s = { ...state(), boqItems: [item('cc2', 1, 30, { id: 'b' })] }
    const start = [sourced('cc1', 100), sourced('cc2', 30)]
    const { next, requestKey, resultKey } = apply(s, start, ['cc1'])
    expect(next.find(l => l.id === 'boq-cc1').budgeted).toBe(0)
    expect(findAppliedRequest(next, requestKey, resultKey)).not.toBeNull()
    expect(buildTransferProposal({ ...s, budgetLines: next }).reviewKey).toBe(resultKey)
  })
})

describe('the working register stays compatible with SHIELD', () => {
  it('transferred lines capture into an approval snapshot exactly like manual lines, and an approved version is not moved by a later working change', () => {
    const items = [item('cc1', 2, 50), item('cc2', 1, 30)]
    const lines = applyOperationsToLines([], transferOperations(propose(items)).operations)
    const capture = buildBudgetCapturePayload(lines, CODES, { currency: 'AUD' })
    expect(capture.ok).toBe(true)
    expect(capture.total).toBe(130)
    expect(capture.entries.map(e => e.lineId)).toEqual(['boq-cc1', 'boq-cc2'])
    expect(Object.keys(capture.entries[0])).toEqual(['lineId', 'costCodeId', 'costCodeName', 'budgeted'])   // no provenance leaks into the snapshot

    const approvedBudget = {
      pointer: { activeApprovalId: 'a1', originalApprovalId: 'a1', versionCount: 1 },
      header: { id: 'a1', status: 'approved', version: 1, entryCount: 2, total: 130, currency: 'AUD' },
      snapshot: { entryCount: 2, total: 130, currency: 'AUD', entries: capture.entries },
    }
    const refreshed = lines.map(l => (l.id === 'boq-cc1' ? { ...l, budgeted: 999 } : l))
    const resolved = resolveBudgetSource({ approvedBudget, budgetLines: refreshed, currencyCode: 'AUD' })
    expect(resolved.kind).toBe(BUDGET_SOURCE.APPROVED)
    expect(resolved.total).toBe(130)
  })
})
