import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BUDGET_ADJUSTMENT_TYPE, BUDGET_ADJUSTMENT_STATUS, BUDGET_ADJUSTMENT_KEYS, BUDGET_ADJUSTMENT_LIMITS,
  BUDGET_ADJUSTMENT_PREPARE_ROLES, BUDGET_ADJUSTMENT_APPROVE_ROLES,
  canBudgetAdjustmentTransition, canPrepareBudgetAdjustment, canApproveBudgetAdjustment, canWithdrawBudgetAdjustment,
  isAdjustmentAmount, adjustmentNet, adjustmentMovements, movementsByCostCode, applyMovements,
  validateBudgetAdjustmentRecord, parseAdjustmentAmount, validateBudgetAdjustmentDraft, normaliseBudgetAdjustmentDraft,
  validateBudgetAdjustmentWithdrawReason, adjustmentCostCodeName, adjustmentPreview,
  isStaleBudgetAdjustment, isSupersededBudgetAdjustment, approvedAdjustmentsFor, draftAdjustmentsFor,
  budgetAdjustmentHistory, budgetAdjustmentLabel, budgetAdjustmentMovementText, pendingAdjustmentSummary,
} from '../../src/lib/budgetAdjustment'
import {
  BUDGET_PREPARE_ROLES, BUDGET_APPROVE_ROLES, BUDGET_SOURCE, BUDGET_INTEGRITY_PROBLEM,
  resolveBudgetSource, budgetLinesFor, budgetSourceState, adjustedByCostCode, baseApprovedByLine, adjustmentNetByCostCode,
  versionDeltaAgainst, budgetSupersession, budgetSupersessionKey, workingVsApproved, approvedVersionCaption,
  originalApprovedBudgetFor,
} from '../../src/lib/budgetApproval'
import { buildForecastRows } from '../../src/lib/forecast'
import { projectForecastTotals, computeMargin } from '../../src/lib/margin'
import { boqVsBudgetRows, budgetedTotal } from '../../src/lib/boq'
import { approvedBudgetForPackage } from '../../src/lib/tenders'
import { projectSnapshot, SNAPSHOT_SOURCES, FIGURE_STATE } from '../../src/lib/projectSnapshot'
import { evaluatePulse, INDICATOR } from '../../src/lib/pulse'
import { evaluateShield, CHECK, SHIELD_STATE } from '../../src/lib/shield'

// ── Approved Budget ADJUSTMENTS — domain, adapter, parity (ADR-71, SHIELD 2B2) ──
//
// Pure tests: the movement model, the two-decimal mirror of the rules pin,
// the shared adapter (resolveBudgetSource) reconciling approved adjustments
// with the pointer ledger and failing closed, NO double counting across a
// re-approval, and parity across every consumer (Forecast, BOQ, Tenders,
// Dashboard snapshot, PULSE, SHIELD) — with Actual, commitment, FFC, payables
// and margin unchanged. The emulator suite proves the rules.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Version 1: cc1 600,000 (two lines), cc2 400,000 → 1,000,000.
const ENTRIES = [
  { lineId: 'l1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 500000 },
  { lineId: 'l2', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 100000 },
  { lineId: 'l3', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 400000 },
]
const snapshot = (id = 'ba1', entries = ENTRIES) => ({
  id, entryCount: entries.length, total: entries.reduce((s, e) => s + e.budgeted, 0), currency: 'AUD', entries,
})
const header = (id = 'ba1', version = 1, entries = ENTRIES) => ({
  id, status: 'approved', version, entryCount: entries.length, total: entries.reduce((s, e) => s + e.budgeted, 0), currency: 'AUD',
  approvedAt: { seconds: 100, nanoseconds: 0 }, approvedBy: 'u_pm', reason: `Version ${version}`,
})
const adj = (o = {}) => ({
  id: o.id ?? `adj${o.sequence ?? 'd'}`, type: 'increase', costCodeId: 'cc1', costCodeName: '03-100 — Concrete',
  fromCostCodeId: null, fromCostCodeName: '', amount: 50000, currency: 'AUD', reason: 'r', reference: '',
  baseApprovalId: 'ba1', baseVersion: 1, sequence: null, status: 'approved', revision: 2,
  createdAt: { seconds: 200, nanoseconds: 0 }, createdBy: 'u_qs', updatedAt: { seconds: 300, nanoseconds: 0 }, updatedBy: 'u_pm',
  ...o,
})
const transfer = (o = {}) => adj({ type: 'transfer', fromCostCodeId: 'cc2', fromCostCodeName: '03-200 — Formwork', costCodeId: 'cc1', amount: 100000, ...o })
const pointer = (o = {}) => ({ activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1, ...o })

// The composite hook's object for a version with `adjustments` and a ledger.
function approvedBudget(adjustments = [], ledger = null, over = {}) {
  const approvedList = (adjustments ?? []).filter(a => a.status === 'approved' && a.baseApprovalId === 'ba1')
  const latest = [...approvedList].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).at(-1)
  const led = {
    adjustmentCount: approvedList.length,
    adjustmentNet: approvedList.reduce((s, a) => s + (a.type === 'increase' ? a.amount : a.type === 'decrease' ? -a.amount : 0), 0),
    lastAdjustmentId: latest ? latest.id : null,
    ...(ledger ?? {}),
  }
  return {
    pointer: pointer(led), pointerLoading: false, pointerError: false,
    header: header(), headerLoading: false, headerError: false,
    snapshot: snapshot(), snapshotLoading: false, snapshotError: false,
    originalSnapshot: null, originalLoading: false, originalError: false, originalRequested: false,
    adjustments, adjustmentsLoading: false, adjustmentsError: false,
    ...over,
  }
}
const resolve = (ab) => resolveBudgetSource({ approvedBudget: ab, currencyCode: 'AUD' })

// ── The movement model ───────────────────────────────────────────────────────

describe('movement model — types, derived net, per-cost-code movements', () => {
  it('increase +amount, decrease −amount, transfer EXACTLY 0 on the project total', () => {
    expect(adjustmentNet(adj())).toBe(50000)
    expect(adjustmentNet(adj({ type: 'decrease' }))).toBe(-50000)
    expect(adjustmentNet(transfer())).toBe(0)
    expect(adjustmentNet(adj({ type: 'contingency' }))).toBeNull()
    expect(adjustmentNet(adj({ amount: -5 }))).toBeNull()
  })
  it('a transfer is −source and +destination; increase / decrease touch one code', () => {
    expect(adjustmentMovements(transfer())).toEqual([
      { costCodeId: 'cc2', costCodeName: '03-200 — Formwork', amount: -100000 },
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', amount: 100000 },
    ])
    expect(adjustmentMovements(adj({ type: 'decrease', amount: 7.5 }))).toEqual([{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', amount: -7.5 }])
    expect(adjustmentMovements(adj({ amount: 'x' }))).toEqual([])
  })
  it('movements fold by cost code in whole cents; a transfer nets the project to zero', () => {
    const moves = movementsByCostCode([transfer(), adj({ amount: 0.1 }), adj({ amount: 0.2 })])
    expect(moves).toEqual({ cc2: -100000, cc1: 100000.3 })
    expect(Object.values(movementsByCostCode([transfer()])).reduce((s, v) => s + v, 0)).toBe(0)
    expect(applyMovements({ cc1: 600000, cc2: 400000 }, [transfer()])).toEqual({ cc1: 700000, cc2: 300000 })
  })
  it('no signed net is ever stored: the record keys are exactly the rules key list', () => {
    expect(BUDGET_ADJUSTMENT_KEYS).not.toContain('net')
    expect(BUDGET_ADJUSTMENT_KEYS).toHaveLength(23)
    const rules = read('../firestore.rules')
    for (const k of BUDGET_ADJUSTMENT_KEYS) expect(rules).toContain(`'${k}'`)
  })
  it('lifecycle: draft → approved | withdrawn only; both terminal', () => {
    expect(canBudgetAdjustmentTransition('draft', 'approved')).toBe(true)
    expect(canBudgetAdjustmentTransition('draft', 'withdrawn')).toBe(true)
    for (const from of ['approved', 'withdrawn']) for (const to of ['draft', 'approved', 'withdrawn']) expect(canBudgetAdjustmentTransition(from, to)).toBe(false)
  })
  it('roles mirror ADR-70 exactly (any financial role prepares; admin / PM approve; preparer or approver withdraws)', () => {
    expect(BUDGET_ADJUSTMENT_PREPARE_ROLES).toEqual(BUDGET_PREPARE_ROLES)
    expect(BUDGET_ADJUSTMENT_APPROVE_ROLES).toEqual(BUDGET_APPROVE_ROLES)
    expect(canPrepareBudgetAdjustment('qs')).toBe(true)
    expect(canApproveBudgetAdjustment('qs')).toBe(false)
    expect(canApproveBudgetAdjustment('project_manager')).toBe(true)
    expect(canPrepareBudgetAdjustment('subcontractor')).toBe(false)
    expect(canWithdrawBudgetAdjustment('qs', { createdBy: 'u1' }, 'u1')).toBe(true)
    expect(canWithdrawBudgetAdjustment('qs', { createdBy: 'u2' }, 'u1')).toBe(false)
    expect(canWithdrawBudgetAdjustment('company_admin', { createdBy: 'u2' }, 'u1')).toBe(true)
  })
})

// ── Precision: the client mirror of the rules pin ────────────────────────────

describe('two-decimal amounts — the exact client mirror of `cents(a) / 100.0 == a`', () => {
  it('EVERY whole-cent value from 0.01 to 10,000.00 is accepted (exhaustive sweep)', () => {
    for (let c = 1; c <= 1_000_000; c += 1) {
      if (!isAdjustmentAmount(c / 100)) throw new Error(`rejected ${c / 100}`)
    }
  })
  it('large whole-cent values up to the ceiling are accepted; the ceiling itself is not', () => {
    for (const v of [1234567.89, 99999999.99, 999999999.99, 9999999999.99, 99999999999.99, 999999999999.99]) expect(isAdjustmentAmount(v), String(v)).toBe(true)
    expect(isAdjustmentAmount(BUDGET_ADJUSTMENT_LIMITS.amountCeiling)).toBe(false)
  })
  it('sub-cent, zero, negative and non-numbers are refused (never rounded)', () => {
    for (const v of [0, -0.01, -50, 0.001, 0.005, 1.005, 2.675, 0.1 + 0.2, NaN, Infinity, '5', null]) expect(isAdjustmentAmount(v), String(v)).toBe(false)
  })
  it('form parsing refuses a third decimal instead of repairing it', () => {
    expect(parseAdjustmentAmount('25,000.50')).toBe(25000.5)
    expect(parseAdjustmentAmount('1.005')).toBeNaN()
    expect(parseAdjustmentAmount('-5')).toBeNaN()
    expect(parseAdjustmentAmount(12.5)).toBe(12.5)
  })
})

// ── Draft validation and normalisation ───────────────────────────────────────

describe('draft input — validated, normalised, nothing repaired', () => {
  const codes = new Map([
    ['cc1', { id: 'cc1', code: '03-100', name: 'Concrete' }],
    ['cc2', { id: 'cc2', code: '03-200', name: 'Formwork' }],
    ['cc9', { id: 'cc9', code: '99-000', name: 'Contingency', isActive: false }],
  ])
  const ok = { type: 'increase', costCodeId: 'cc1', amount: '50', reason: 'Scope', reference: 'CV-1' }
  it('a valid increase / decrease / transfer passes', () => {
    expect(validateBudgetAdjustmentDraft(ok, codes)).toBeNull()
    expect(validateBudgetAdjustmentDraft({ ...ok, type: 'decrease' }, codes)).toBeNull()
    expect(validateBudgetAdjustmentDraft({ ...ok, type: 'transfer', fromCostCodeId: 'cc9' }, codes)).toBeNull()
  })
  it('refuses each malformed input by name', () => {
    expect(validateBudgetAdjustmentDraft({ ...ok, type: 'x' }, codes)).toMatch(/type/)
    expect(validateBudgetAdjustmentDraft({ ...ok, amount: '0' }, codes)).toMatch(/positive/)
    expect(validateBudgetAdjustmentDraft({ ...ok, amount: '1.001' }, codes)).toMatch(/two decimal/)
    expect(validateBudgetAdjustmentDraft({ ...ok, costCodeId: '' }, codes)).toMatch(/cost code/)
    expect(validateBudgetAdjustmentDraft({ ...ok, costCodeId: 'nope' }, codes)).toMatch(/does not exist/)
    expect(validateBudgetAdjustmentDraft({ ...ok, type: 'transfer' }, codes)).toMatch(/transfer from/)
    expect(validateBudgetAdjustmentDraft({ ...ok, type: 'transfer', fromCostCodeId: 'cc1' }, codes)).toMatch(/two different/)
    expect(validateBudgetAdjustmentDraft({ ...ok, reason: '  ' }, codes)).toMatch(/reason/)
    expect(validateBudgetAdjustmentDraft({ ...ok, reason: 'x'.repeat(501) }, codes)).toMatch(/500/)
    expect(validateBudgetAdjustmentDraft({ ...ok, reference: 'x'.repeat(201) }, codes)).toMatch(/200/)
    expect(validateBudgetAdjustmentWithdrawReason(' ')).toMatch(/reason/)
  })
  it('normalises to the stored movement with frozen "code — name" names; no source on an increase', () => {
    expect(normaliseBudgetAdjustmentDraft({ ...ok, fromCostCodeId: 'cc2' }, codes)).toEqual({
      type: 'increase', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', fromCostCodeId: null, fromCostCodeName: '',
      amount: 50, reason: 'Scope', reference: 'CV-1',
    })
    expect(normaliseBudgetAdjustmentDraft({ ...ok, type: 'transfer', fromCostCodeId: 'cc9' }, codes)).toMatchObject({
      fromCostCodeId: 'cc9', fromCostCodeName: '99-000 — Contingency',
    })
    expect(adjustmentCostCodeName({ code: 'X', name: 'y'.repeat(300) }).length).toBe(170)
  })
  it('record validation rejects what the adapter must never count', () => {
    expect(validateBudgetAdjustmentRecord(adj())).toBeNull()
    expect(validateBudgetAdjustmentRecord(transfer())).toBeNull()
    expect(validateBudgetAdjustmentRecord(transfer({ fromCostCodeId: 'cc1' }))).toMatch(/same cost code/)
    expect(validateBudgetAdjustmentRecord(adj({ fromCostCodeId: 'cc2' }))).toMatch(/not a transfer/)
    expect(validateBudgetAdjustmentRecord(adj({ amount: 1.005 }))).toMatch(/whole-cent/)
    expect(validateBudgetAdjustmentRecord(adj({ currency: 'aud' }))).toMatch(/currency/)
    expect(validateBudgetAdjustmentRecord(adj({ baseApprovalId: '' }))).toMatch(/approved version/)
  })
})

// ── Resulting balances ───────────────────────────────────────────────────────

describe('resulting-balance preview — below zero refused, exactly zero allowed', () => {
  const perCode = { cc1: 600000, cc2: 400000 }
  it('a transfer shows both sides and the unchanged total', () => {
    const p = adjustmentPreview(perCode, transfer())
    expect(p.ok).toBe(true)
    expect(p.net).toBe(0)
    expect(p.rows).toEqual([
      { costCodeId: 'cc2', costCodeName: '03-200 — Formwork', before: 400000, change: -100000, after: 300000, negative: false },
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', before: 600000, change: 100000, after: 700000, negative: false },
    ])
  })
  it('one cent too far is refused; exactly to zero is fine; a code with no budget cannot give any', () => {
    expect(adjustmentPreview(perCode, transfer({ amount: 400000.01 })).ok).toBe(false)
    expect(adjustmentPreview(perCode, adj({ type: 'decrease', costCodeId: 'cc2', amount: 400000 })).ok).toBe(true)
    expect(adjustmentPreview(perCode, transfer({ fromCostCodeId: 'cc7', fromCostCodeName: 'New' })).negative[0].costCodeId).toBe('cc7')
  })
  it('a new cost code may RECEIVE budget through an increase', () => {
    expect(adjustmentPreview(perCode, adj({ costCodeId: 'cc3', costCodeName: 'New' })).rows[0]).toMatchObject({ before: 0, after: 50000 })
  })
})

// ── Lists, staleness, labels ─────────────────────────────────────────────────

describe('staleness, history, labels', () => {
  const list = [
    adj({ id: 'a1', sequence: 1 }), adj({ id: 'a2', sequence: 2 }),
    adj({ id: 'd1', status: 'draft', revision: 1 }), adj({ id: 'w1', status: 'withdrawn' }),
    adj({ id: 'old1', baseApprovalId: 'ba0', baseVersion: 0, sequence: 1 }),
    adj({ id: 'oldd', baseApprovalId: 'ba0', baseVersion: 0, status: 'draft' }),
  ]
  it('a draft on a replaced version is STALE; an approved one is SUPERSEDED', () => {
    expect(isStaleBudgetAdjustment(list[5], 'ba1')).toBe(true)
    expect(isStaleBudgetAdjustment(list[2], 'ba1')).toBe(false)
    expect(isSupersededBudgetAdjustment(list[4], 'ba1')).toBe(true)
    expect(isSupersededBudgetAdjustment(list[0], 'ba1')).toBe(false)
  })
  it('selects only the active version\'s approved / draft records', () => {
    expect(approvedAdjustmentsFor(list, 'ba1').map(a => a.id)).toEqual(['a1', 'a2'])
    expect(draftAdjustmentsFor(list, 'ba1').map(a => a.id)).toEqual(['d1'])
    expect(pendingAdjustmentSummary(list, 'ba1')).toEqual({ count: 1, net: 50000 })
  })
  it('history: newest version first, then drafts, approved by sequence desc, withdrawn', () => {
    expect(budgetAdjustmentHistory(list).map(a => a.id)).toEqual(['d1', 'a2', 'a1', 'w1', 'oldd', 'old1'])
  })
  it('labels and movement text', () => {
    expect(budgetAdjustmentLabel(list[1])).toBe('v1 · Adjustment 2')
    expect(budgetAdjustmentLabel(list[2])).toBe('v1 · Draft adjustment')
    expect(budgetAdjustmentMovementText(transfer(), String)).toBe('03-200 — Formwork → 03-100 — Concrete · 100000')
    expect(budgetAdjustmentMovementText(adj({ type: 'decrease', amount: 5 }), String)).toBe('03-100 — Concrete · −5')
    expect(approvedVersionCaption({ version: 2, adjustmentCount: 0 })).toBe('2')
    expect(approvedVersionCaption({ version: 2, adjustmentCount: 3 })).toBe('2 + 3 adjustments')
  })
})

// ── The shared adapter ───────────────────────────────────────────────────────

describe('resolveBudgetSource — CURRENT ADJUSTED APPROVED = active snapshot + same-version approved adjustments', () => {
  it('a 2B1 pointer (no ledger) resolves exactly as before — no listener, no adjustment rows', () => {
    const r = resolve(approvedBudget([], null, { pointer: pointer(), adjustments: null }))
    expect(r).toMatchObject({ kind: BUDGET_SOURCE.APPROVED, total: 1000000, baseTotal: 1000000, adjustmentCount: 0, adjustmentNet: 0 })
    expect(budgetLinesFor(r)).toHaveLength(3)
    expect(adjustedByCostCode(r)).toEqual({ cc1: 600000, cc2: 400000 })
  })
  it('1,000,000 + approved +50,000 = 1,050,000; base and net reported separately', () => {
    const r = resolve(approvedBudget([adj({ sequence: 1 })]))
    expect(r).toMatchObject({ kind: BUDGET_SOURCE.APPROVED, baseTotal: 1000000, adjustmentNet: 50000, total: 1050000, adjustmentCount: 1 })
    expect(adjustedByCostCode(r)).toEqual({ cc1: 650000, cc2: 400000 })
    expect(adjustmentNetByCostCode(r)).toEqual({ cc1: 50000 })
    expect(baseApprovedByLine(r)).toEqual({ l1: 500000, l2: 100000, l3: 400000 })
  })
  it('a transfer never inflates the total; a new cost code arrives through an increase; rows fold by code', () => {
    const list = [transfer({ sequence: 1 }), adj({ sequence: 2, costCodeId: 'cc3', costCodeName: '05-000 — Steel', amount: 2500.5 }), adj({ sequence: 3, type: 'decrease', costCodeId: 'cc1', amount: 0.5 })]
    const r = resolve(approvedBudget(list))
    expect(r.total).toBe(1002500)
    expect(adjustedByCostCode(r)).toEqual({ cc1: 699999.5, cc2: 300000, cc3: 2500.5 })
    const rows = budgetLinesFor(r).filter(l => l.fromApprovedAdjustment)
    expect(rows).toEqual([
      { id: 'adjustment:cc1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 99999.5, fromApprovedAdjustment: true },
      { id: 'adjustment:cc2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: -100000, fromApprovedAdjustment: true },
      { id: 'adjustment:cc3', costCodeId: 'cc3', costCodeName: '05-000 — Steel', budgeted: 2500.5, fromApprovedAdjustment: true },
    ])
    // The rows never collide with a budget-line id, and each cost code's TOTAL stays ≥ 0.
    expect(new Set(budgetLinesFor(r).map(l => l.id)).size).toBe(budgetLinesFor(r).length)
  })
  it('drafts and withdrawn records never count', () => {
    const r = resolve(approvedBudget([adj({ sequence: 1 }), adj({ id: 'd', status: 'draft' }), adj({ id: 'w', status: 'withdrawn' })]))
    expect(r.total).toBe(1050000)
  })

  const unavailable = (r, problem) => {
    expect(r.kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
    expect(r.problems).toContain(problem)
    expect(r.total).toBeNull()
    expect(budgetLinesFor(r)).toEqual([])
    expect(adjustedByCostCode(r)).toEqual({})
    expect(budgetSourceState(r)).toEqual({ loading: false, error: true })
  }
  it('a MISSING approved record (ledger says 2, one found) fails closed', () => {
    unavailable(resolve(approvedBudget([adj({ sequence: 1 })], { adjustmentCount: 2, adjustmentNet: 100000 })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_COUNT)
  })
  it('an EXTRA approved record (ledger 0) fails closed', () => {
    unavailable(resolve(approvedBudget([adj({ sequence: 1 })], { adjustmentCount: 0, adjustmentNet: 0 })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_COUNT)
  })
  it('a sequence GAP or DUPLICATE fails closed', () => {
    unavailable(resolve(approvedBudget([adj({ sequence: 1 }), adj({ id: 'x', sequence: 3 })])), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_SEQUENCE)
    unavailable(resolve(approvedBudget([adj({ sequence: 1 }), adj({ id: 'x', sequence: 1 })])), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_SEQUENCE)
  })
  it('a NET that does not match the pointer fails closed', () => {
    unavailable(resolve(approvedBudget([adj({ sequence: 1 })], { adjustmentCount: 1, adjustmentNet: 50000.01 })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_NET)
  })
  it('an approved record of ANOTHER version supplied for this one fails closed', () => {
    unavailable(resolve(approvedBudget([adj({ sequence: 1 }), adj({ id: 'f', baseApprovalId: 'ba0', sequence: 1 })], { adjustmentCount: 1, adjustmentNet: 50000 })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_FOREIGN_BASE)
  })
  it('a MALFORMED amount / type, or a foreign CURRENCY, fails closed', () => {
    unavailable(resolve(approvedBudget([adj({ sequence: 1, amount: 1.005 })], { adjustmentCount: 1, adjustmentNet: 1.005 })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_MALFORMED)
    unavailable(resolve(approvedBudget([adj({ sequence: 1, type: 'bonus' })], { adjustmentCount: 1, adjustmentNet: 0 })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_MALFORMED)
    unavailable(resolve(approvedBudget([adj({ sequence: 1, currency: 'NZD' })])), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_CURRENCY)
  })
  it('a cost code driven BELOW ZERO (a forged direct-SDK sequence, DC45) fails closed', () => {
    unavailable(resolve(approvedBudget([adj({ sequence: 1, type: 'decrease', costCodeId: 'cc2', amount: 400000.01 })])), BUDGET_INTEGRITY_PROBLEM.ADJUSTED_NEGATIVE)
  })
  it('a STALE last-adjustment reference (after a reset, or not the latest) fails closed', () => {
    unavailable(resolve(approvedBudget([], { adjustmentCount: 0, adjustmentNet: 0, lastAdjustmentId: 'adj1' })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_POINTER)
    unavailable(resolve(approvedBudget([adj({ sequence: 1 }), adj({ id: 'adjX', sequence: 2 })], { lastAdjustmentId: 'adj1' })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_POINTER)
    unavailable(resolve(approvedBudget([adj({ sequence: 1 })], { lastAdjustmentId: null })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_POINTER)
    // Absent (a legacy pointer, empty ledger) and the latest record are both fine.
    expect(resolve(approvedBudget([], { lastAdjustmentId: undefined })).kind).toBe(BUDGET_SOURCE.APPROVED)
    expect(resolve(approvedBudget([adj({ sequence: 1 }), adj({ id: 'adjX', sequence: 2 })])).problems).toEqual([])
  })
  it('a malformed LEDGER is a malformed pointer', () => {
    unavailable(resolve(approvedBudget([], { adjustmentCount: -1, adjustmentNet: 0 })), BUDGET_INTEGRITY_PROBLEM.POINTER_MALFORMED)
    unavailable(resolve(approvedBudget([], { adjustmentCount: 1.5, adjustmentNet: 0 })), BUDGET_INTEGRITY_PROBLEM.POINTER_MALFORMED)
    unavailable(resolve(approvedBudget([], { adjustmentCount: 0, adjustmentNet: 'x' })), BUDGET_INTEGRITY_PROBLEM.POINTER_MALFORMED)
  })
  it('adjustments LOADING is loading; a FAILED or absent read is UNAVAILABLE — never the base alone, never zero', () => {
    const led = { adjustmentCount: 1, adjustmentNet: 50000 }
    expect(resolve(approvedBudget(null, led, { adjustmentsLoading: true })).kind).toBe(BUDGET_SOURCE.LOADING)
    unavailable(resolve(approvedBudget([], led, { adjustmentsError: true })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENTS_UNAVAILABLE)
    unavailable(resolve(approvedBudget(null, led, { adjustments: null })), BUDGET_INTEGRITY_PROBLEM.ADJUSTMENTS_UNAVAILABLE)
  })
  it('the Original Approved Budget stays version 1 — adjustments never touch it', () => {
    const r = resolve({ ...approvedBudget([adj({ sequence: 1 })]), originalRequested: true })
    expect(r.originalTotal).toBe(1000000)
    expect(originalApprovedBudgetFor(r)).toBe(1000000)
  })
})

// ── Re-approval: no double counting, explicit supersession ───────────────────

describe('version rollover — the ledger resets; superseded adjustments never count again', () => {
  // The working register brought in line with the adjusted figure: l1 +50,000.
  const v2Entries = [{ lineId: 'l1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 550000 }, ENTRIES[1], ENTRIES[2]]
  const v2 = (entries) => ({
    pointer: pointer({ activeApprovalId: 'ba2', versionCount: 2, adjustmentCount: 0, adjustmentNet: 0 }), pointerLoading: false, pointerError: false,
    header: header('ba2', 2, entries), snapshot: snapshot('ba2', entries),
    // The v1 adjustment is still in the store; the query would not return it,
    // and even if a caller passed it, it is not this version's.
    adjustments: [], adjustmentsLoading: false, adjustmentsError: false,
  })
  it('v1 1,000,000 + 50,000; v2 capturing 1,050,000 resolves to 1,050,000 — NOT 1,100,000', () => {
    expect(resolve(approvedBudget([adj({ sequence: 1 })])).total).toBe(1050000)
    const r = resolve(v2(v2Entries))
    expect(r).toMatchObject({ kind: BUDGET_SOURCE.APPROVED, total: 1050000, baseTotal: 1050000, adjustmentNet: 0, version: 2 })
  })
  it('v2 capturing the unchanged 1,000,000 resolves to 1,000,000 — the reduction the reviewer acknowledged', () => {
    expect(resolve(v2(ENTRIES)).total).toBe(1000000)
  })
  it('the review compares the capture with the CURRENT ADJUSTED budget, per cost code', () => {
    const current = resolve(approvedBudget([adj({ sequence: 1 })]))
    const same = versionDeltaAgainst(snapshot('ba2', v2Entries), current)
    expect(same.difference).toBe(0)
    expect(same.rows).toEqual([])
    const lower = versionDeltaAgainst(snapshot('ba2', ENTRIES), current)
    expect(lower).toMatchObject({ previousTotal: 1050000, nextTotal: 1000000, difference: -50000 })
    expect(lower.rows).toEqual([{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', previous: 650000, next: 600000, difference: -50000 }])
  })
  it('the supersession summary and its key bind the version, the ledger, the base and the proposal', () => {
    const current = resolve(approvedBudget([adj({ sequence: 1 })]))
    const s = budgetSupersession(snapshot('ba2', ENTRIES), current, [adj({ id: 'd', status: 'draft' }), adj({ sequence: 1 })])
    expect(s).toMatchObject({ required: true, currentTotal: 1050000, baseTotal: 1000000, adjustmentNet: 50000, proposedTotal: 1000000, difference: -50000, staleDraftCount: 1 })
    expect(s.superseded.map(a => a.id)).toEqual(['adj1'])
    expect(s.key).toBe(budgetSupersessionKey({ versionCount: 1, adjustmentCount: 1, adjustmentNet: 50000, baseTotal: 1000000, proposedTotal: 1000000 }))
    // Any change to the figures changes the key.
    for (const over of [{ versionCount: 2 }, { adjustmentCount: 2 }, { adjustmentNet: 50000.01 }, { baseTotal: 1 }, { proposedTotal: 1050000 }]) {
      expect(budgetSupersessionKey({ versionCount: 1, adjustmentCount: 1, adjustmentNet: 50000, baseTotal: 1000000, proposedTotal: 1000000, ...over })).not.toBe(s.key)
    }
    // No approved adjustments → no acknowledgement required.
    expect(budgetSupersession(snapshot('ba2', ENTRIES), resolve(approvedBudget([])), []).required).toBe(false)
  })
  it('the working-vs-approved comparison uses the adjusted total', () => {
    const r = resolve(approvedBudget([adj({ sequence: 1 })]))
    const w = workingVsApproved(ENTRIES.map(e => ({ id: e.lineId, costCodeId: e.costCodeId, budgeted: e.budgeted })), r)
    expect(w).toMatchObject({ workingTotal: 1000000, approvedTotal: 1050000, adjustmentNet: 50000, difference: -50000, pending: true })
  })
})

// ── Parity: every consumer, through the one adapter ──────────────────────────

describe('parity — Forecast, BOQ, Tenders, Dashboard, PULSE and SHIELD read the same adjusted figure', () => {
  const list = [transfer({ sequence: 1 }), adj({ sequence: 2 })]
  const ab = approvedBudget(list)
  const r = resolve(ab)
  const costCodes = [{ id: 'cc1', code: '03-100', name: 'Concrete' }, { id: 'cc2', code: '03-200', name: 'Formwork' }]
  const purchaseOrders = [{
    id: 'po1', status: 'sent', poNumber: 'PO-0001',
    lineItems: [{ costCodeId: 'cc1', costCodeName: 'Concrete', description: 'Pour', qty: 1, unitPrice: 200000, lineTotal: 200000 }],
    subtotal: 200000, gst: 20000, total: 220000,
  }]
  const cost = { costCodes, purchaseOrders, progressClaims: [], supplierInvoices: [], supplierCreditNotes: [], variations: [], forecastLines: [] }

  it('forecast rows carry the adjusted per-code budget; a fully-transferred code keeps a (zero-or-more) budget row', () => {
    const rows = buildForecastRows({ ...cost, budgetLines: budgetLinesFor(r) })
    expect(rows.find(x => x.costCodeId === 'cc1').budgeted).toBe(750000)
    expect(rows.find(x => x.costCodeId === 'cc2').budgeted).toBe(300000)
  })
  it('ONLY the budget measures move: Actual, Remaining Committed, FFC, Cost to Complete are identical', () => {
    const base = projectForecastTotals({ ...cost, budgetLines: budgetLinesFor(resolve(approvedBudget([]))) })
    const adjusted = projectForecastTotals({ ...cost, budgetLines: budgetLinesFor(r) })
    expect(adjusted.budgeted).toBe(1050000)
    expect(base.budgeted).toBe(1000000)
    for (const k of ['actual', 'remainingCommitted', 'forecastFinalCost', 'uncommittedCostToComplete']) expect(adjusted[k], k).toBe(base[k])
    expect(adjusted.varianceToBudget - base.varianceToBudget).toBe(50000)
  })
  it('Forecast Gross Profit, Margin and Original Planned Profit do not move', () => {
    const baseline = { originalContractValue: 1500000, originalApprovedBudget: 900000 }
    const ffc = projectForecastTotals({ ...cost, budgetLines: budgetLinesFor(r) }).forecastFinalCost
    const a = computeMargin({ baseline, variations: [], forecastFinalCost: ffc, purchaseOrders, originalApprovedBudget: 1000000 })
    const b = computeMargin({ baseline, variations: [], forecastFinalCost: ffc, purchaseOrders, originalApprovedBudget: originalApprovedBudgetFor(resolve({ ...ab, originalRequested: true })) })
    expect(b).toEqual(a)
  })
  it('BOQ and tender comparisons use the adjusted per-code figure', () => {
    expect(budgetedTotal(budgetLinesFor(r))).toBe(1050000)
    expect(boqVsBudgetRows({ costCodes, boqItems: [], budgetLines: budgetLinesFor(r) }).find(x => x.costCodeId === 'cc1').budgeted).toBe(750000)
    expect(approvedBudgetForPackage({ costCodes: [{ costCodeId: 'cc2' }] }, budgetLinesFor(r))).toEqual({ amount: 300000, hasBudget: true })
  })
  it('cash flow, payables, commitment and the source documents never read an adjustment', () => {
    for (const lib of ['cashFlow.js', 'commitment.js', 'purchaseOrders.js', 'progressClaims.js', 'supplierInvoices.js', 'supplierPayments.js', 'retention.js', 'variations.js', 'margin.js']) {
      expect(read(`lib/${lib}`), lib).not.toMatch(/budgetAdjust|adjustmentNet|adjustmentCount/)
    }
  })

  const states = (over = {}) => ({ ...Object.fromEntries(SNAPSHOT_SOURCES.map(s => [s, { loading: false, error: false }])), ...over })
  const sources = {
    budgetLines: [], purchaseOrders, progressClaims: [], supplierInvoices: [], supplierCreditNotes: [],
    variations: [], forecastLines: [], baseline: { originalContractValue: 1500000 }, supplierPayments: [], retentionReleases: [],
  }
  it('Dashboard snapshot: Approved Budget and Variance include the adjustments; FFC and Actual do not move', () => {
    const plain = projectSnapshot({ sources: { ...sources, approvedBudget: approvedBudget([]) }, sourceStates: states(), currencyCode: 'AUD' })
    const s = projectSnapshot({ sources: { ...sources, approvedBudget: ab }, sourceStates: states(), currencyCode: 'AUD' })
    expect(s.approvedBudget.value).toBe(1050000)
    expect(s.budgetSource).toMatchObject({ approved: true, version: 1, adjustmentCount: 2 })
    expect(s.varianceToBudget.value - plain.varianceToBudget.value).toBe(50000)
    expect(s.forecastFinalCost.value).toBe(plain.forecastFinalCost.value)
    expect(s.actual.value).toBe(plain.actual.value)
    expect(s.remainingCommitted.value).toBe(plain.remainingCommitted.value)
  })
  it('Dashboard snapshot: an unreconciled ledger makes the budget figures Unavailable, never a partial figure', () => {
    const broken = approvedBudget(list, { adjustmentCount: 3, adjustmentNet: 50000 })
    const s = projectSnapshot({ sources: { ...sources, approvedBudget: broken }, sourceStates: states({ approvedBudget: { loading: false, error: true } }), currencyCode: 'AUD' })
    expect(s.approvedBudget.state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(s.approvedBudget.value).toBeNull()
  })
  it('PULSE: the over-budget indicator compares against the adjusted figure and names the adjustments', () => {
    const p = evaluatePulse({ sources: { ...sources, approvedBudget: ab }, sourceStates: states(), currencyCode: 'AUD' })
    const ind = p.indicators.find(i => i.id === INDICATOR.FORECAST_OVER_BUDGET)
    expect(ind.values.approvedBudget).toBe(1050000)
    expect(ind.values.budgetSource).toBe('Approved Budget · version 1 + 2 adjustments')
  })
  it('SHIELD check 6: consistent adjustments are NO ISSUE; a mismatch is a FINDING with evidence; a failed read is UNAVAILABLE', () => {
    const sh = (approved) => evaluateShield({ sources: { approvedBudget: approved }, sourceStates: states(), currencyCode: 'AUD' })
      .checks.find(c => c.id === CHECK.APPROVED_BUDGET_INTEGRITY)
    const ok = sh(ab)
    expect(ok.state).toBe(SHIELD_STATE.NO_ISSUE)
    expect(ok.values).toMatchObject({ approvedTotal: 1050000, baseTotal: 1000000, adjustmentCount: 2, adjustmentNet: 50000 })
    expect(ok.headline).toMatch(/2 approved adjustments are consistent/)
    expect(ok.caveats.join(' ')).toMatch(/Deferred Control 45/)
    const bad = sh(approvedBudget(list, { adjustmentCount: 3, adjustmentNet: 50000 }))
    expect(bad.state).toBe(SHIELD_STATE.FINDING)
    expect(bad.evidence.map(e => e.id)).toContain(BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_COUNT)
    expect(bad.evidence.find(e => e.id === BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_COUNT).detail).toMatch(/Pointer records 3 adjustment.*last adj2/)
    const stale = sh(approvedBudget([], { adjustmentCount: 0, adjustmentNet: 0, lastAdjustmentId: 'adj1' }))
    expect(stale.state).toBe(SHIELD_STATE.FINDING)
    expect(stale.evidence.map(e => e.id)).toEqual([BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_POINTER])
    const neg = sh(approvedBudget([adj({ sequence: 1, type: 'decrease', costCodeId: 'cc2', amount: 500000 })]))
    expect(neg.evidence.map(e => e.id)).toContain(BUDGET_INTEGRITY_PROBLEM.ADJUSTED_NEGATIVE)
    const failed = sh(approvedBudget([], { adjustmentCount: 1, adjustmentNet: 50000 }, { adjustmentsError: true }))
    expect(failed.state).toBe(SHIELD_STATE.UNAVAILABLE)
  })
})

// ── Structure: one adapter, no page arithmetic ───────────────────────────────

describe('structure — the adapter is the only place adjustments become figures', () => {
  it('the Budget page uses the shared selectors, never its own snapshot or adjustment fold', () => {
    const page = read('pages/project/ProjectBudget.jsx')
    expect(page).toMatch(/adjustedByCostCode\(budget\)/)
    expect(page).toMatch(/baseApprovedByLine\(budget\)/)
    expect(page).not.toMatch(/approvedByCostCode\(/)
    expect(page).not.toMatch(/snapshot\?\.entries/)
    expect(page).not.toMatch(/movementsByCostCode|applyMovements/)
  })
  it('the re-approval review compares against the adjusted figure, not the bare snapshot', () => {
    const modal = read('pages/project/budget/BudgetApprovalReviewModal.jsx')
    expect(modal).toMatch(/versionDeltaAgainst\(snapshot, budget\)/)
    expect(modal).toMatch(/budgetSupersession\(/)
    expect(modal).not.toMatch(/snapshotDelta\(/)
  })
  it('no page or selector other than the adapter folds adjustment movements', () => {
    for (const f of ['lib/forecast.js', 'lib/boq.js', 'lib/tenders.js', 'lib/pulse.js', 'lib/projectSnapshot.js', 'lib/shield.js',
      'pages/project/ProjectForecast.jsx', 'pages/project/ProjectCommercial.jsx', 'pages/project/ProjectOverview.jsx', 'pages/dashboard/ProjectSnapshot.jsx']) {
      expect(read(f), f).not.toMatch(/movementsByCostCode|applyMovements|adjustmentMovements/)
    }
  })
  it('the composite hook opens the adjustments listener ONLY when the ledger records any', () => {
    const hook = read('hooks/useApprovedBudget.jsx')
    expect(hook).toMatch(/useActiveVersionAdjustments\(projectId, activeId, ledgerCount > 0\)/)
  })
  it('the record statuses are the rules\' lifecycle', () => {
    expect(Object.values(BUDGET_ADJUSTMENT_STATUS)).toEqual(['draft', 'approved', 'withdrawn'])
    expect(Object.values(BUDGET_ADJUSTMENT_TYPE)).toEqual(['increase', 'decrease', 'transfer'])
  })
})
