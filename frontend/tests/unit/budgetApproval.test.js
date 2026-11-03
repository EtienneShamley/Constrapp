import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BUDGET_APPROVAL_STATUS, BUDGET_APPROVAL_LIMITS, BUDGET_SNAPSHOT_MAX_BYTES, BUDGET_HEADER_KEYS, BUDGET_POINTER_KEYS,
  canBudgetApprovalTransition, canPrepareBudgetApproval, canApproveBudget, canWithdrawBudgetDraft,
  validateBudgetApprovalDraft, validateBudgetWithdrawReason,
  projectBudgetEntry, validateBudgetEntry, buildBudgetCapturePayload, estimateBudgetSnapshotBytes,
  snapshotAsBudgetLines, approvedTotalOf, approvedByCostCode, validateBudgetSnapshot, BUDGET_INTEGRITY_PROBLEM,
  resolveBudgetSource, budgetSourceState, budgetLinesFor, originalApprovedBudgetFor, BUDGET_SOURCE,
  budgetDrift, budgetDriftKey, approvedBudgetVersions, draftBudgetApprovals, budgetApprovalHistory, budgetVersionLabel,
  workingVsApproved, snapshotDelta,
} from '../../src/lib/budgetApproval'
import { buildForecastRows, composeForecastRow, forecastRollups } from '../../src/lib/forecast'
import { projectForecastTotals, computeMargin } from '../../src/lib/margin'
import { projectSnapshot, SNAPSHOT_SOURCES, FIGURE_STATE, FIGURE_DEPENDENCIES } from '../../src/lib/projectSnapshot'
import { budgetedTotal, boqVsBudgetRows } from '../../src/lib/boq'
import { approvedBudgetForPackage } from '../../src/lib/tenders'
import { payablesSummary } from '../../src/lib/supplierPayments'

// ── Approved Budget Versions — domain logic (ADR-70) ────────────────────────
//
// The capture projection and validation, the size estimate, the read-time
// integrity validation, the ONE source-of-truth adapter and its folded state,
// drift, versions and the pending difference — and the financial invariants:
// approving a budget moves Budgeted / Variance / Remaining and NOTHING on the
// cost, commitment, cash or payables side.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

const ts = (s) => ({ seconds: s, nanoseconds: 0, toMillis: () => s * 1000 })

const codes = [
  { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
  { id: 'cc2', code: '03-200', name: 'Formwork', isActive: true },
  { id: 'cc9', code: '09-100', name: 'Retired', isActive: false },
]
const lines = [
  { id: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 1000 },
  { id: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 500.5 },
  { id: 'bl3', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 250 }, // a second line on cc1 — legitimate
]

const approvedFixture = ({ entries = null, total = null, version = 1, versionCount = 1, status = 'approved', activeId = 'ba1', originalId = 'ba1', currency = 'AUD' } = {}) => {
  const es = entries ?? [
    { lineId: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 1100 },
    { lineId: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 500.5 },
    { lineId: 'bl3', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 250 },
  ]
  const t = total ?? es.reduce((s, e) => s + e.budgeted, 0)
  return {
    pointer: { activeApprovalId: activeId, originalApprovalId: originalId, versionCount },
    header: { id: activeId, status, version, entryCount: es.length, total: t, currency, reason: 'Initial', approvedAt: ts(5), approvedBy: 'u_pm' },
    snapshot: { id: activeId, entryCount: es.length, total: t, currency, entries: es },
  }
}

// ── Lifecycle and roles ──────────────────────────────────────────────────────

describe('lifecycle, limits and roles', () => {
  it('draft → approved | withdrawn only; approved and withdrawn are terminal', () => {
    expect(canBudgetApprovalTransition('draft', 'approved')).toBe(true)
    expect(canBudgetApprovalTransition('draft', 'withdrawn')).toBe(true)
    for (const from of ['approved', 'withdrawn']) for (const to of ['draft', 'approved', 'withdrawn']) {
      expect(canBudgetApprovalTransition(from, to), `${from}→${to}`).toBe(false)
    }
    expect(BUDGET_APPROVAL_STATUS).toEqual({ DRAFT: 'draft', APPROVED: 'approved', WITHDRAWN: 'withdrawn' })
  })

  it('exact header and pointer key sets (what the rules pin)', () => {
    expect(BUDGET_HEADER_KEYS).toEqual([
      'reason', 'status', 'currency', 'entryCount', 'total', 'version',
      'approvedAt', 'approvedBy', 'withdrawnAt', 'withdrawnBy', 'withdrawReason',
      'revision', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
    ])
    expect(BUDGET_POINTER_KEYS).toEqual([
      'activeApprovalId', 'originalApprovalId', 'versionCount', 'approvedAt', 'approvedBy', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
    ])
    expect(BUDGET_APPROVAL_LIMITS).toMatchObject({ reason: 500, withdrawReason: 500, entries: 2000 })
    expect(BUDGET_SNAPSHOT_MAX_BYTES).toBe(900_000)
  })

  it('any financial role prepares; only company_admin / project_manager approve; a draft is withdrawn by an approver or its capturer', () => {
    for (const r of ['company_admin', 'project_manager', 'qs']) expect(canPrepareBudgetApproval(r), r).toBe(true)
    for (const r of ['subcontractor', 'client', 'super_admin', undefined]) expect(canPrepareBudgetApproval(r), String(r)).toBe(false)
    for (const r of ['company_admin', 'project_manager']) expect(canApproveBudget(r), r).toBe(true)
    for (const r of ['qs', 'subcontractor', 'client', 'super_admin', undefined]) expect(canApproveBudget(r), String(r)).toBe(false)
    const draft = { createdBy: 'u_qs' }
    expect(canWithdrawBudgetDraft('qs', draft, 'u_qs')).toBe(true)
    expect(canWithdrawBudgetDraft('qs', draft, 'u_other_qs')).toBe(false)
    expect(canWithdrawBudgetDraft('project_manager', draft, 'u_pm')).toBe(true)
    expect(canWithdrawBudgetDraft('subcontractor', draft, 'u_qs')).toBe(false)
  })

  it('reasons are required, trimmed and bounded', () => {
    expect(validateBudgetApprovalDraft({ reason: '' })).toMatch(/reason/)
    expect(validateBudgetApprovalDraft({ reason: '   ' })).toMatch(/reason/)
    expect(validateBudgetApprovalDraft({ reason: 'x'.repeat(501) })).toMatch(/500/)
    expect(validateBudgetApprovalDraft({ reason: ' Award ' })).toBeNull()
    expect(validateBudgetWithdrawReason('')).toMatch(/reason/)
    expect(validateBudgetWithdrawReason('x'.repeat(501))).toMatch(/500/)
    expect(validateBudgetWithdrawReason('typo')).toBeNull()
  })
})

// ── Capture ──────────────────────────────────────────────────────────────────

describe('capture projection and validation', () => {
  it('projects exactly the four entry keys from a budget line', () => {
    expect(projectBudgetEntry(lines[0])).toEqual({ lineId: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 1000 })
    expect(Object.keys(projectBudgetEntry({}))).toEqual(['lineId', 'costCodeId', 'costCodeName', 'budgeted'])
  })

  it('refuses a malformed entry by reason — missing id, missing / unknown cost code, non-numeric, negative, sub-cent', () => {
    const codeMap = new Map(codes.map(c => [c.id, c]))
    expect(validateBudgetEntry(projectBudgetEntry({ costCodeId: 'cc1', costCodeName: 'x', budgeted: 1 }), codeMap)).toMatch(/line identity/)
    expect(validateBudgetEntry(projectBudgetEntry({ id: 'a', costCodeName: 'x', budgeted: 1 }), codeMap)).toMatch(/no cost code/)
    expect(validateBudgetEntry(projectBudgetEntry({ id: 'a', costCodeId: 'nope', costCodeName: 'x', budgeted: 1 }), codeMap)).toMatch(/does not exist/)
    expect(validateBudgetEntry(projectBudgetEntry({ id: 'a', costCodeId: 'cc1', costCodeName: 'x', budgeted: '5' }), codeMap)).toMatch(/not a number/)
    expect(validateBudgetEntry(projectBudgetEntry({ id: 'a', costCodeId: 'cc1', costCodeName: 'x', budgeted: -1 }), codeMap)).toMatch(/negative/)
    expect(validateBudgetEntry({ lineId: 'a', costCodeId: 'cc1', costCodeName: 'x', budgeted: 1.005 }, codeMap)).toMatch(/two decimal/)
    expect(validateBudgetEntry(projectBudgetEntry({ id: 'a', costCodeId: 'cc1', costCodeName: 'x'.repeat(171), budgeted: 1 }), codeMap)).toMatch(/too long/)
    expect(validateBudgetEntry(projectBudgetEntry(lines[0]), codeMap)).toBeNull()
    // An INACTIVE code is permitted (the line legitimately keeps it).
    expect(validateBudgetEntry(projectBudgetEntry({ id: 'a', costCodeId: 'cc9', costCodeName: 'x', budgeted: 1 }), codeMap)).toBeNull()
  })

  it('a valid register captures every line in deterministic order, keeps multiple lines per cost code, sums the total and counts', () => {
    const p = buildBudgetCapturePayload(lines, codes, { capturedBy: 'u_qs', currency: 'AUD' })
    expect(p.ok).toBe(true)
    expect(p.entries.map(e => e.lineId)).toEqual(['bl1', 'bl3', 'bl2']) // name, then line id
    expect(p.total).toBe(1750.5)
    expect(p.counts).toEqual({ total: 3, captured: 3, invalid: 0, inactive: 0, costCodes: 2 })
    expect(p.currency).toBe('AUD')
    expect(p.bytes).toBeGreaterThan(0)
    expect(p.refusal).toBeNull()
    // The same register captured twice is byte-identical.
    expect(buildBudgetCapturePayload([...lines].reverse(), codes, { capturedBy: 'u_qs' }).entries).toEqual(p.entries)
  })

  it('refuses the whole capture on any invalid line, a duplicate id or a missing cost code — naming them, excluding nothing', () => {
    const bad = [...lines, { id: 'bl1', costCodeId: 'cc1', costCodeName: 'dup', budgeted: 1 }, { id: 'bl4', costCodeId: 'gone', costCodeName: 'x', budgeted: 1 }, { id: 'bl5', costCodeId: 'cc2', costCodeName: 'x', budgeted: -5 }]
    const p = buildBudgetCapturePayload(bad, codes)
    expect(p.ok).toBe(false)
    expect(p.errors.map(e => e.lineId).sort()).toEqual(['bl1', 'bl4', 'bl5'])
    expect(p.errors.find(e => e.lineId === 'bl1').reason).toMatch(/appears twice/)
    expect(p.errors.find(e => e.lineId === 'bl4').reason).toMatch(/does not exist/)
    expect(p.refusal).toMatch(/3 budget lines cannot be captured/)
    expect(p.counts.invalid).toBe(3)
  })

  it('counts lines on inactive cost codes without refusing them', () => {
    const p = buildBudgetCapturePayload([...lines, { id: 'bl9', costCodeId: 'cc9', costCodeName: 'r', budgeted: 10 }], codes)
    expect(p.ok).toBe(true)
    expect(p.counts.inactive).toBe(1)
  })

  it('refuses an empty register, more than 2,000 lines, and a snapshot above the byte ceiling — never truncating', () => {
    expect(buildBudgetCapturePayload([], codes).refusal).toMatch(/no budget lines/)
    const many = Array.from({ length: 2001 }, (_, i) => ({ id: `l${i}`, costCodeId: 'cc1', costCodeName: 'c', budgeted: 1 }))
    const over = buildBudgetCapturePayload(many, codes)
    expect(over.ok).toBe(false)
    expect(over.refusal).toMatch(/at most 2000/)
    expect(over.entries).toHaveLength(2001) // nothing dropped
    const fat = Array.from({ length: 2000 }, (_, i) => ({ id: `l${i}`, costCodeId: 'cc1', costCodeName: 'n'.repeat(170), budgeted: 1 }))
    const sized = buildBudgetCapturePayload(fat, codes)
    // 2,000 worst-case entries stay under the ceiling (about 500 KB) — the
    // documented worst case the rules admit fits a single document.
    expect(sized.bytes).toBeLessThan(BUDGET_SNAPSHOT_MAX_BYTES)
    expect(sized.ok).toBe(true)
    expect(estimateBudgetSnapshotBytes(fat).toString()).toMatch(/^\d+$/)
  })

  it('size: 20 / 200 / 2,000 typical entries are well under the 1 MiB document limit', () => {
    for (const n of [20, 200, 2000]) {
      const es = Array.from({ length: n }, (_, i) => ({ lineId: `abcdefghijklmnopqrst${i}`, costCodeId: 'abcdefghijklmnopqrst', costCodeName: '03-100 — Concrete Slab to Ground Floor', budgeted: 123456.78 }))
      expect(estimateBudgetSnapshotBytes(es)).toBeLessThan(BUDGET_SNAPSHOT_MAX_BYTES)
    }
  })
})

// ── Snapshot reading and integrity ───────────────────────────────────────────

describe('snapshot reading and integrity validation', () => {
  const f = approvedFixture()

  it("the snapshot's entries read as budget lines and fold by cost code; the total is the sum of entries", () => {
    expect(snapshotAsBudgetLines(f.snapshot)).toEqual([
      { id: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 1100, fromApprovedSnapshot: true },
      { id: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 500.5, fromApprovedSnapshot: true },
      { id: 'bl3', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 250, fromApprovedSnapshot: true },
    ])
    expect(approvedTotalOf(f.snapshot)).toBe(1850.5)
    expect(approvedByCostCode(f.snapshot)).toEqual({ cc1: 1350, cc2: 500.5 })
  })

  it('a consistent snapshot has no problems; every inconsistency is named', () => {
    expect(validateBudgetSnapshot(f.snapshot, f.header, { currencyCode: 'AUD' })).toEqual([])
    expect(validateBudgetSnapshot(null)).toEqual([BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_MISSING])
    expect(validateBudgetSnapshot({ entries: 'x', entryCount: 1 })).toEqual([BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_SHAPE])
    expect(validateBudgetSnapshot({ ...f.snapshot, entryCount: 2 }, f.header)).toContain(BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_COUNT)
    expect(validateBudgetSnapshot(f.snapshot, { ...f.header, entryCount: 9 })).toContain(BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_COUNT)
    expect(validateBudgetSnapshot({ ...f.snapshot, total: 1 }, f.header)).toContain(BUDGET_INTEGRITY_PROBLEM.TOTAL_MISMATCH)
    expect(validateBudgetSnapshot(f.snapshot, { ...f.header, total: 1 })).toContain(BUDGET_INTEGRITY_PROBLEM.TOTAL_MISMATCH)
    expect(validateBudgetSnapshot({ ...f.snapshot, entries: [...f.snapshot.entries, { lineId: 'bl1', costCodeId: 'cc1', costCodeName: 'd', budgeted: 1 }], entryCount: 4, total: 1851.5 }, null)).toContain(BUDGET_INTEGRITY_PROBLEM.ENTRY_DUPLICATE)
    expect(validateBudgetSnapshot({ ...f.snapshot, entries: [{ lineId: '', costCodeId: 'cc1', costCodeName: 'd', budgeted: 1 }], entryCount: 1, total: 1 }, null)).toContain(BUDGET_INTEGRITY_PROBLEM.ENTRY_MALFORMED)
    expect(validateBudgetSnapshot({ ...f.snapshot, currency: 'NZD' }, f.header)).toContain(BUDGET_INTEGRITY_PROBLEM.CURRENCY_MISMATCH)
    expect(validateBudgetSnapshot(f.snapshot, f.header, { currencyCode: 'USD' })).toContain(BUDGET_INTEGRITY_PROBLEM.CURRENCY_MISMATCH)
  })

  it('the cent boundary: a half-cent drift in the recorded total is a mismatch; sub-cent noise in entries is rounded away', () => {
    expect(validateBudgetSnapshot({ ...f.snapshot, total: 1850.51 }, null)).toContain(BUDGET_INTEGRITY_PROBLEM.TOTAL_MISMATCH)
    expect(validateBudgetSnapshot({ ...f.snapshot, total: 1850.504 }, null)).toEqual([])
  })
})

// ── The source-of-truth adapter ──────────────────────────────────────────────

describe('resolveBudgetSource — the ONE budget source', () => {
  const working = { budgetLines: lines, currencyCode: 'AUD' }

  it('no subscription object, or a settled empty pointer → WORKING: the editable lines, with their total', () => {
    for (const ab of [undefined, null, {}, [], { pointer: null }]) {
      const r = resolveBudgetSource({ approvedBudget: ab, ...working })
      expect(r.kind, String(ab)).toBe(BUDGET_SOURCE.WORKING)
      expect(r.lines).toBe(lines)
      expect(r.total).toBe(1750.5)
      expect(budgetSourceState(r)).toEqual({ loading: false, error: false })
      expect(budgetLinesFor(r)).toBe(lines)
      expect(originalApprovedBudgetFor(r)).toBeUndefined()
    }
  })

  it('WORKING folds the working register\'s read state in: loading → LOADING, failed → UNAVAILABLE (never an empty register)', () => {
    const l = resolveBudgetSource({ approvedBudget: null, budgetLines: [], budgetLinesLoading: true })
    expect(l.kind).toBe(BUDGET_SOURCE.LOADING)
    expect(budgetSourceState(l)).toEqual({ loading: true, error: false })
    expect(budgetLinesFor(l)).toEqual([])
    const e = resolveBudgetSource({ approvedBudget: null, budgetLines: [], budgetLinesError: true })
    expect(e.kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
    expect(budgetSourceState(e)).toEqual({ loading: false, error: true })
    expect(budgetLinesFor(e)).toEqual([])
  })

  it('a loading or failed pointer read is LOADING / UNAVAILABLE before anything else', () => {
    expect(resolveBudgetSource({ approvedBudget: { pointerLoading: true }, ...working }).kind).toBe(BUDGET_SOURCE.LOADING)
    expect(resolveBudgetSource({ approvedBudget: { pointerError: true }, ...working }).kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
  })

  it('a consistent approved version → APPROVED: the snapshot\'s lines, the summed total, the version and the approval stamps; the working lines are ignored', () => {
    const r = resolveBudgetSource({ approvedBudget: approvedFixture(), ...working })
    expect(r.kind).toBe(BUDGET_SOURCE.APPROVED)
    expect(r.version).toBe(1)
    expect(r.versionCount).toBe(1)
    expect(r.total).toBe(1850.5)
    expect(r.approvedBy).toBe('u_pm')
    expect(r.reason).toBe('Initial')
    expect(budgetLinesFor(r).map(l => l.budgeted)).toEqual([1100, 500.5, 250])
    expect(budgetSourceState(r)).toEqual({ loading: false, error: false })
    // The working register's state is irrelevant once a version is approved.
    expect(resolveBudgetSource({ approvedBudget: approvedFixture(), budgetLines: [], budgetLinesLoading: true, budgetLinesError: true, currencyCode: 'AUD' }).kind).toBe(BUDGET_SOURCE.APPROVED)
  })

  it('a pointer with a loading header or snapshot → LOADING; a failed one → UNAVAILABLE', () => {
    const f = approvedFixture()
    expect(resolveBudgetSource({ approvedBudget: { ...f, headerLoading: true }, ...working }).kind).toBe(BUDGET_SOURCE.LOADING)
    expect(resolveBudgetSource({ approvedBudget: { ...f, snapshotLoading: true }, ...working }).kind).toBe(BUDGET_SOURCE.LOADING)
    expect(resolveBudgetSource({ approvedBudget: { ...f, headerError: true }, ...working }).problems).toEqual([BUDGET_INTEGRITY_PROBLEM.HEADER_MISSING])
    expect(resolveBudgetSource({ approvedBudget: { ...f, snapshotError: true }, ...working }).problems).toEqual([BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_MISSING])
  })

  it('FAIL CLOSED: a pointer whose records are missing or inconsistent is UNAVAILABLE — never the working lines, never zero', () => {
    const cases = {
      [BUDGET_INTEGRITY_PROBLEM.POINTER_MALFORMED]:   { ...approvedFixture(), pointer: { activeApprovalId: '', versionCount: 1, originalApprovalId: 'x' } },
      [BUDGET_INTEGRITY_PROBLEM.HEADER_MISSING]:      { ...approvedFixture(), header: null },
      [BUDGET_INTEGRITY_PROBLEM.HEADER_NOT_APPROVED]: approvedFixture({ status: 'draft' }),
      [BUDGET_INTEGRITY_PROBLEM.HEADER_IDENTITY]:     { ...approvedFixture(), header: { ...approvedFixture().header, id: 'other' } },
      [BUDGET_INTEGRITY_PROBLEM.HEADER_VERSION]:      approvedFixture({ version: 2, versionCount: 1 }),
      [BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_MISSING]:    { ...approvedFixture(), snapshot: null },
      [BUDGET_INTEGRITY_PROBLEM.TOTAL_MISMATCH]:      { ...approvedFixture(), header: { ...approvedFixture().header, total: 1 } },
      [BUDGET_INTEGRITY_PROBLEM.CURRENCY_MISMATCH]:   approvedFixture({ currency: 'NZD' }),
    }
    for (const [problem, ab] of Object.entries(cases)) {
      const r = resolveBudgetSource({ approvedBudget: ab, ...working })
      expect(r.kind, problem).toBe(BUDGET_SOURCE.UNAVAILABLE)
      expect(r.problems, problem).toContain(problem)
      expect(budgetLinesFor(r), problem).toEqual([])
      expect(r.total, problem).toBeNull()
      expect(budgetSourceState(r), problem).toEqual({ loading: false, error: true })
    }
  })

  it('the ORIGINAL: version 1 is the active snapshot when they coincide; otherwise its own snapshot, loading / missing / malformed handled', () => {
    const v1 = resolveBudgetSource({ approvedBudget: { ...approvedFixture(), originalRequested: true }, ...working })
    expect(v1.originalTotal).toBe(1850.5)
    expect(originalApprovedBudgetFor(v1)).toBe(1850.5)
    const v2 = approvedFixture({ version: 2, versionCount: 2, activeId: 'ba2', originalId: 'ba1' })
    const orig = { id: 'ba1', entryCount: 1, total: 900, currency: 'AUD', entries: [{ lineId: 'bl1', costCodeId: 'cc1', costCodeName: 'c', budgeted: 900 }] }
    expect(resolveBudgetSource({ approvedBudget: { ...v2, originalRequested: true, originalSnapshot: orig }, ...working }).originalTotal).toBe(900)
    expect(resolveBudgetSource({ approvedBudget: { ...v2, originalRequested: true, originalLoading: true }, ...working }).kind).toBe(BUDGET_SOURCE.LOADING)
    const missing = resolveBudgetSource({ approvedBudget: { ...v2, originalRequested: true, originalSnapshot: null }, ...working })
    expect(missing.kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
    expect(missing.problems).toContain(BUDGET_INTEGRITY_PROBLEM.ORIGINAL_MISSING)
    const bad = resolveBudgetSource({ approvedBudget: { ...v2, originalRequested: true, originalSnapshot: { ...orig, total: 1 } }, ...working })
    expect(bad.problems).toContain(BUDGET_INTEGRITY_PROBLEM.ORIGINAL_SHAPE)
    // Not requested: no original is read and no original problem can arise.
    const noReq = resolveBudgetSource({ approvedBudget: { ...v2, originalSnapshot: null }, ...working })
    expect(noReq.kind).toBe(BUDGET_SOURCE.APPROVED)
    expect(noReq.originalTotal).toBeNull()
    expect(originalApprovedBudgetFor(noReq)).toBeUndefined()
  })
})

// ── Drift, versions, pending difference ──────────────────────────────────────

describe('drift, versions and the pending difference', () => {
  const f = approvedFixture()

  it('drift names edited, added and missing lines against the snapshot, with a stable acknowledgement key', () => {
    const live = [
      { id: 'bl1', costCodeId: 'cc1', costCodeName: 'c', budgeted: 1100 },   // unchanged
      { id: 'bl2', costCodeId: 'cc2', costCodeName: 'f', budgeted: 600 },    // edited
      { id: 'bl4', costCodeId: 'cc2', costCodeName: 'f', budgeted: 50 },     // added
    ]                                                                        // bl3 missing
    const d = budgetDrift(live, f.snapshot)
    expect(d.changed.map(x => [x.lineId, x.from, x.to])).toEqual([['bl2', 500.5, 600]])
    expect(d.added.map(x => x.lineId)).toEqual(['bl4'])
    expect(d.missing.map(x => x.lineId)).toEqual(['bl3'])
    expect(d.total).toBe(3)
    expect(d.any).toBe(true)
    expect(d.key).toBe(budgetDriftKey(d))
    expect(d.key).toBe('c:bl2@600|a:bl4@50|m:bl3')
    // A cost-code re-point counts as a change; no drift gives an empty key.
    expect(budgetDrift([{ id: 'bl1', costCodeId: 'cc2', budgeted: 1100 }, { id: 'bl2', costCodeId: 'cc2', budgeted: 500.5 }, { id: 'bl3', costCodeId: 'cc1', budgeted: 250 }], f.snapshot).changed.map(x => x.lineId)).toEqual(['bl1'])
    expect(budgetDrift(snapshotAsBudgetLines(f.snapshot), f.snapshot)).toMatchObject({ any: false, key: '' })
  })

  it('versions: approved headers in version order, drafts by capture, history approved-desc then drafts then withdrawn', () => {
    const headers = [
      { id: 'd1', status: 'draft', createdAt: ts(30) },
      { id: 'a2', status: 'approved', version: 2, approvedAt: ts(20), createdAt: ts(15) },
      { id: 'w1', status: 'withdrawn', createdAt: ts(5) },
      { id: 'a1', status: 'approved', version: 1, approvedAt: ts(10), createdAt: ts(1) },
      { id: 'bad', status: 'approved', version: null },
    ]
    expect(approvedBudgetVersions(headers).map(h => h.id)).toEqual(['a1', 'a2'])
    expect(draftBudgetApprovals(headers).map(h => h.id)).toEqual(['d1'])
    // A header stored as approved with no version is malformed; it stays in the
    // approved group (ranked last by version) rather than being hidden.
    expect(budgetApprovalHistory(headers).map(h => h.id)).toEqual(['a2', 'a1', 'bad', 'd1', 'w1'])
    expect(budgetVersionLabel(headers[3])).toBe('Version 1 · Original')
    expect(budgetVersionLabel(headers[1])).toBe('Version 2')
    expect(budgetVersionLabel(headers[0])).toBe('Draft')
    expect(budgetVersionLabel(headers[2])).toBe('Withdrawn draft')
  })

  it('workingVsApproved: per-line approved amounts, the difference, and whether anything is pending', () => {
    const approved = resolveBudgetSource({ approvedBudget: f, budgetLines: lines, currencyCode: 'AUD' })
    const p = workingVsApproved(lines, approved)
    expect(p.workingTotal).toBe(1750.5)
    expect(p.approvedTotal).toBe(1850.5)
    expect(p.difference).toBe(-100)
    expect(p.rows.find(r => r.lineId === 'bl1')).toEqual({ lineId: 'bl1', working: 1000, approved: 1100, difference: -100 })
    expect(p.changedCount).toBe(1)
    expect(p.addedCount).toBe(0)
    expect(p.pending).toBe(true)
    const same = workingVsApproved(snapshotAsBudgetLines(f.snapshot), approved)
    expect(same.pending).toBe(false)
    expect(same.difference).toBe(0)
    const added = workingVsApproved([...snapshotAsBudgetLines(f.snapshot), { id: 'new', costCodeId: 'cc2', budgeted: 1 }], approved)
    expect(added.addedCount).toBe(1)
    expect(added.pending).toBe(true)
    // Working mode: no approved figure, nothing pending.
    const w = workingVsApproved(lines, resolveBudgetSource({ approvedBudget: null, budgetLines: lines }))
    expect(w).toMatchObject({ approvedTotal: null, difference: null, pending: false })
  })

  it('snapshotDelta: the change by cost code between two versions', () => {
    const next = { entryCount: 2, total: 1300, currency: 'AUD', entries: [
      { lineId: 'bl1', costCodeId: 'cc1', costCodeName: 'c', budgeted: 1300 },
      { lineId: 'bl9', costCodeId: 'cc9', costCodeName: 'r', budgeted: 0 },
    ] }
    const d = snapshotDelta(next, f.snapshot)
    expect(d.previousTotal).toBe(1850.5)
    expect(d.nextTotal).toBe(1300)
    expect(d.difference).toBe(-550.5)
    expect([...d.rows].sort((a, b) => a.costCodeId.localeCompare(b.costCodeId)).map(r => [r.costCodeId, r.previous, r.next, r.difference])).toEqual([
      ['cc1', 1350, 1300, -50], ['cc2', 500.5, null, -500.5], ['cc9', null, 0, 0],
    ])
    expect(snapshotDelta(next, null)).toMatchObject({ previousTotal: null, difference: null, nextTotal: 1300 })
  })
})

// ── Financial invariants ─────────────────────────────────────────────────────

describe('financial invariants — approval moves the budget reference family and nothing else', () => {
  const costCodes = codes
  const purchaseOrders = [{ id: 'po1', status: 'sent', lineItems: [{ costCodeId: 'cc1', lineTotal: 800 }, { costCodeId: 'cc2', lineTotal: 400 }] }]
  const progressClaims = [{ id: 'cl1', status: 'approved', poId: 'po1', lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', approvedThisPeriod: 100 }] }]
  const supplierInvoices = [{
    id: 'inv1', invoiceNumber: 'SI-0001', status: 'posted', supplierId: 'sup1', supplierName: 'Ace', currency: 'AUD', poId: 'po1',
    lineItems: [{ poLineIndex: 1, costCodeId: 'cc2', costCodeName: 'f', description: 'x', amount: 300, taxCode: 'gst', gstAmount: 30 }],
    retention: 0, retentionGst: 0, retentionTotal: 0, subtotal: 300, gstTotal: 30, grossTotal: 330, net: 300, payableGst: 30, payableTotal: 330, dueDate: '2026-01-31',
  }]
  const forecastLines = [{ id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 150 }, { id: 'cc2', costCodeId: 'cc2', uncommittedCostToComplete: 20 }]
  const variations = [{ id: 'v1', variationType: 'client', status: 'approved', approvedSubtotal: 2000, lineItems: [] }]
  const baseline = { originalContractValue: 10000, originalApprovedBudget: 1500 }
  const supplierPayments = [{ id: 'p1', paymentNumber: 'SP-0001', status: 'posted', supplierId: 'sup1', supplierName: 'Ace', paymentDate: '2026-02-02', amount: 100, allocatedTotal: 100, unallocatedAmount: 0, allocations: [{ supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', allocatedAmount: 100 }] }]
  const cost = { costCodes, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes: [], variations, forecastLines }

  const before = { budgetLines: lines }
  const approved = resolveBudgetSource({ approvedBudget: approvedFixture({ entries: null }), budgetLines: lines, currencyCode: 'AUD' })
  const after = { budgetLines: budgetLinesFor(approved) }

  it('the fixture is live: the approved budget differs from the working one', () => {
    expect(projectForecastTotals({ ...cost, ...before }).budgeted).toBe(1750.5)
    expect(projectForecastTotals({ ...cost, ...after }).budgeted).toBe(1850.5)
  })

  it('Budgeted, Variance to Budget and Remaining Budget Reference move by exactly the approved delta', () => {
    const b = projectForecastTotals({ ...cost, ...before })
    const a = projectForecastTotals({ ...cost, ...after })
    expect(a.budgeted - b.budgeted).toBeCloseTo(100, 2)
    expect(a.varianceToBudget - b.varianceToBudget).toBeCloseTo(100, 2)
    const rowB = buildForecastRows({ ...cost, ...before }).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete)).find(r => r.costCodeId === 'cc1')
    const rowA = buildForecastRows({ ...cost, ...after }).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete)).find(r => r.costCodeId === 'cc1')
    expect(rowA.remainingBudgetRef - rowB.remainingBudgetRef).toBeCloseTo(100, 2)
    expect(rowA.budgeted).toBe(1350)
  })

  it('Actual, Remaining Committed, Uncommitted CTC, Cost to Complete and Forecast Final Cost are byte-identical', () => {
    const b = projectForecastTotals({ ...cost, ...before })
    const a = projectForecastTotals({ ...cost, ...after })
    for (const k of ['actual', 'remainingCommitted', 'uncommittedCostToComplete', 'costToComplete', 'forecastFinalCost', 'approvedSupplierVariations', 'appliedSupplierVariations', 'unappliedSupplierVariations', 'pendingSupplierVariationExposure', 'closedResidual', 'approvedClaimsAwaitingInvoice']) {
      expect(a[k], k).toBe(b[k])
    }
    const rb = forecastRollups(buildForecastRows({ ...cost, ...before }).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete)))
    const ra = forecastRollups(buildForecastRows({ ...cost, ...after }).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete)))
    expect(ra.forecastFinalCost).toBe(rb.forecastFinalCost)
    expect(ra.actual).toBe(rb.actual)
  })

  it('Forecast Gross Profit, Forecast Margin % and Current Contract Sum do not move; only the ORIGINAL planned figures take version 1', () => {
    const ffc = projectForecastTotals({ ...cost, ...before }).forecastFinalCost
    const legacy = computeMargin({ baseline, variations, forecastFinalCost: ffc, purchaseOrders })
    const withApproved = computeMargin({ baseline, variations, forecastFinalCost: ffc, purchaseOrders, originalApprovedBudget: originalApprovedBudgetFor({ ...approved, originalTotal: 1850.5 }) })
    for (const k of ['currentContractSum', 'forecastRevenue', 'forecastFinalCost', 'forecastGrossProfit', 'forecastMarginPct', 'approvedClientVariations', 'originalContractValue']) {
      expect(withApproved[k], k).toEqual(legacy[k])
    }
    expect(legacy.originalApprovedBudget).toBe(1500)
    expect(withApproved.originalApprovedBudget).toBe(1850.5)
    expect(withApproved.originalPlannedProfit).toBe(10000 - 1850.5)
    expect(withApproved.marginMovement).toBe(withApproved.forecastGrossProfit - withApproved.originalPlannedProfit)
    // The override with no established contract value plans nothing (fails closed).
    expect(computeMargin({ baseline: null, variations, forecastFinalCost: ffc, originalApprovedBudget: 1850.5 }).originalPlannedProfit).toBeNull()
    // No override → the legacy baseline scalar, exactly as before.
    expect(computeMargin({ baseline, variations, forecastFinalCost: ffc, purchaseOrders, originalApprovedBudget: undefined })).toEqual(legacy)
  })

  it('cash and payables read no budget: Cash In, Cash Out and Remaining Payable are untouched by an approval', () => {
    const src = read('lib/cashFlow.js')
    expect(src).not.toMatch(/budgetLines|approvedBudget|budgetApproval/)
    const pay = payablesSummary(supplierInvoices, supplierPayments, [], {})
    expect(pay.remaining).toBe(230)
    for (const lib of ['commitment.js', 'purchaseOrders.js', 'progressClaims.js', 'supplierInvoices.js', 'supplierPayments.js', 'retention.js', 'variations.js']) {
      expect(read(`lib/${lib}`), lib).not.toMatch(/budgetApproval|approvedBudget/)
    }
  })

  it('BOQ and tender comparisons consume the same budget-line shape, so the approved snapshot drives them unchanged', () => {
    expect(budgetedTotal(after.budgetLines)).toBe(1850.5)
    expect(boqVsBudgetRows({ costCodes, boqItems: [], budgetLines: after.budgetLines }).find(r => r.costCodeId === 'cc1').budgeted).toBe(1350)
    expect(approvedBudgetForPackage({ costCodes: [{ costCodeId: 'cc1' }] }, after.budgetLines)).toEqual({ amount: 1350, hasBudget: true })
    expect(approvedBudgetForPackage({ costCodes: [{ costCodeId: 'cc1' }] }, [])).toEqual({ amount: null, hasBudget: false })
  })
})

// ── Dashboard snapshot parity ────────────────────────────────────────────────

describe('projectSnapshot — the approved source, labelled, and fail-closed', () => {
  const states = (over = {}) => ({ ...Object.fromEntries(SNAPSHOT_SOURCES.map(s => [s, { loading: false, error: false }])), ...over })
  const base = {
    budgetLines: lines, purchaseOrders: [], progressClaims: [], supplierInvoices: [], supplierCreditNotes: [],
    variations: [], forecastLines: [], baseline: { originalContractValue: 10000, originalApprovedBudget: 1500 }, supplierPayments: [], retentionReleases: [],
  }

  it('without an approved version the budget is the working register, marked as such', () => {
    const s = projectSnapshot({ sources: base, sourceStates: states(), currencyCode: 'AUD' })
    expect(s.budgetSource).toMatchObject({ kind: BUDGET_SOURCE.WORKING, approved: false, version: null })
    expect(s.approvedBudget).toMatchObject({ state: FIGURE_STATE.READY, value: 1750.5 })
    expect(s.marginMovement.planned).toBe(true) // legacy OAB 1500
  })

  it('with an approved version the budget, the variance and the original planned figures come from the snapshots', () => {
    const ab = { ...approvedFixture(), originalRequested: true }
    const s = projectSnapshot({ sources: { ...base, approvedBudget: ab }, sourceStates: states(), currencyCode: 'AUD' })
    expect(s.budgetSource).toMatchObject({ kind: BUDGET_SOURCE.APPROVED, approved: true, version: 1, approvedBy: 'u_pm' })
    expect(s.approvedBudget.value).toBe(1850.5)
    expect(s.varianceToBudget.value).toBe(1850.5)
    expect(s.costComposition.approvedBudget).toBe(1850.5)
    expect(s.marginMovement.value).toBe(computeMargin({ baseline: base.baseline, variations: [], forecastFinalCost: 0, originalApprovedBudget: 1850.5 }).marginMovement)
  })

  it('the approvedBudget source state gates every budget figure; working lines alone no longer do', () => {
    for (const key of ['approvedBudget', 'varianceToBudget', 'costComposition', 'remainingBudget', 'forecastRows', 'contractBaseline', 'marginMovement']) {
      expect(FIGURE_DEPENDENCIES[key], key).toContain('approvedBudget')
      expect(FIGURE_DEPENDENCIES[key], key).not.toContain('budgetLines')
    }
    expect(FIGURE_DEPENDENCIES.workingBudget).toEqual(['budgetLines', 'approvedBudget'])
    const s = projectSnapshot({ sources: base, sourceStates: states({ approvedBudget: { loading: false, error: true } }), currencyCode: 'AUD' })
    expect(s.approvedBudget.state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(s.approvedBudget.failedSources).toEqual(['approvedBudget'])
    expect(s.varianceToBudget.state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(s.forecastFinalCost.state).toBe(FIGURE_STATE.READY) // FFC reads no budget
    expect(s.actual.state).toBe(FIGURE_STATE.READY)
  })
})
