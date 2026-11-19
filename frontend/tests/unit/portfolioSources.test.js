import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PORTFOLIO_LIST_SOURCES, PORTFOLIO_DOC_SOURCES, PORTFOLIO_ADJUSTMENTS_SOURCE,
  PORTFOLIO_PROJECT_CONCURRENCY, PORTFOLIO_READS_PER_PROJECT,
  loadApprovedBudget, loadProjectSources, failedProjectResult, createPortfolioLoader,
} from '../../src/lib/portfolioSources'
import { REPORT_SOURCES } from '../../src/lib/commercialReport'
import { resolveBudgetSource, BUDGET_SOURCE, BUDGET_INTEGRITY_PROBLEM } from '../../src/lib/budgetApproval'
import { readyProject, sourcesOf } from '../fixtures/finalAccountProject'
import { fakeReader, projectStore } from '../fixtures/portfolioReader'

// ── L2-C Portfolio Report — the one-shot read plan (ADR-78) ──────────────────
//
// The Portfolio page reads through lib/portfolioSources.js instead of the live
// hooks, so the risk it introduces is DRIFT: a path, an ordering or a
// conditional read that no longer matches what the project tabs read. This
// file pins the plan against the hooks' own SOURCE (plain Node runner, no
// jsdom — ADR-26), and proves the loader's behaviour through a fake reader:
// failures become Unavailable, nothing is truncated, at most three projects
// load at once, and an obsolete run reports nothing.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const squash = (src) => stripComments(src).replace(/\s+/g, ' ')

const SCOPE = { companyId: 'coA', projectId: 'p1' }
const storeOf = (p) => ({ p1: projectStore(p) })

// ── 1. Query parity with the live hooks ──────────────────────────────────────

describe('every register is read exactly as its live hook reads it', () => {
  for (const spec of PORTFOLIO_LIST_SOURCES) {
    it(`${spec.source}: ${spec.hook} reads '${spec.collection}' ${spec.orderBy ? `ordered by ${spec.orderBy.join(' ')}` : 'unordered'}`, () => {
      const code = squash(read(`hooks/${spec.hook}`))
      // The subscription's collection reference, under the company's project.
      expect(code).toContain(
        `const ref = collection(db, 'companies', companyId, 'projects', projectId, '${spec.collection}')`,
      )
      if (spec.orderBy) {
        // createdAt ordering also EXCLUDES documents without createdAt — the
        // loader must apply the same constraint or it would count more records.
        expect(code).toContain(`query(ref, orderBy('${spec.orderBy[0]}', '${spec.orderBy[1]}'))`)
        expect(spec.orderBy).toEqual(['createdAt', 'desc'])
      } else {
        // The subscription is on the bare collection reference.
        expect(code).toMatch(/onSnapshot\( ref,/)
        expect(code).not.toContain('orderBy(')
      }
      // The hook maps every document the way the loader's reader does.
      expect(code).toContain('querySnap.docs.map(d => ({ id: d.id, ...d.data() }))')
    })
  }

  it('the single documents use the hooks\' paths', () => {
    const at = (segments) => `doc(db, 'companies', companyId, 'projects', projectId, ${segments})`
    expect(PORTFOLIO_DOC_SOURCES.budgetPointer.path()).toEqual(['approvedBudget', 'current'])
    expect(squash(read('hooks/useApprovedBudgetPointer.jsx'))).toContain(at(`'approvedBudget', 'current'`))
    expect(PORTFOLIO_DOC_SOURCES.budgetHeader.path('ba9')).toEqual(['budgetApprovals', 'ba9'])
    expect(squash(read('hooks/useBudgetApprovalHeader.jsx'))).toContain(at(`'budgetApprovals', approvalId`))
    expect(PORTFOLIO_DOC_SOURCES.budgetSnapshot.path('ba9')).toEqual(['budgetApprovalSnapshots', 'ba9'])
    expect(squash(read('hooks/useBudgetApprovalSnapshot.jsx'))).toContain(at(`'budgetApprovalSnapshots', approvalId`))

    // The commercial baseline: one document with the deterministic id.
    const commercial = squash(read('hooks/useProjectCommercial.jsx'))
    expect(commercial).toContain(`export const COMMERCIAL_BASELINE_DOC_ID = 'baseline'`)
    expect(commercial).toContain(`'commercial', COMMERCIAL_BASELINE_DOC_ID`)
    expect(PORTFOLIO_DOC_SOURCES.baseline.path()).toEqual(['commercial', 'baseline'])
  })

  it('the active version\'s adjustments use the hook\'s equality filter', () => {
    const code = squash(read('hooks/useBudgetAdjustments.jsx'))
    expect(code).toContain(`collection(db, 'companies', companyId, 'projects', projectId, 'budgetAdjustments')`)
    expect(code).toContain(`query(adjustmentsCollection(companyId, projectId), where('baseApprovalId', '==', activeApprovalId))`)
    expect(PORTFOLIO_ADJUSTMENTS_SOURCE.collection).toBe('budgetAdjustments')
    expect(PORTFOLIO_ADJUSTMENTS_SOURCE.where('ba1')).toEqual(['baseApprovalId', '==', 'ba1'])
  })

  it('the conditional approved-budget reads mirror useApprovedBudget', () => {
    const hook = squash(read('hooks/useApprovedBudget.jsx'))
    const plan = squash(read('lib/portfolioSources.js'))
    for (const expr of [
      `typeof pointer?.activeApprovalId === 'string' && pointer.activeApprovalId ? pointer.activeApprovalId : null`,
      `typeof pointer?.originalApprovalId === 'string' && pointer.originalApprovalId ? pointer.originalApprovalId : null`,
      `Number.isInteger(pointer?.adjustmentCount) ? pointer.adjustmentCount : 0`,
    ]) {
      expect(hook).toContain(expr)
      expect(plan).toContain(expr)
    }
    // The Reports tab asks for the original — so does the loader.
    expect(squash(read('pages/project/ProjectReports.jsx'))).toContain('useApprovedBudget(projectId, { original: true })')
    expect(plan).toContain('originalRequested: true')
  })

  it('the loader reads every source of the L2-A report — no more, no fewer', () => {
    const loaded = [...PORTFOLIO_LIST_SOURCES.map(s => s.source), 'baseline', 'approvedBudget'].sort()
    expect(loaded).toEqual([...REPORT_SOURCES].sort())
    expect(new Set(PORTFOLIO_LIST_SOURCES.map(s => s.collection)).size).toBe(PORTFOLIO_LIST_SOURCES.length)
  })

  it('no programme, acknowledgement or cost-code record is in the plan', () => {
    const plan = stripComments(read('lib/portfolioSources.js'))
    for (const name of ['activities', 'programmeBaselines', 'pulseAcknowledgements', 'costCodes', 'cashFlowLines', 'finalAccounts']) {
      expect(plan).not.toContain(`'${name}'`)
    }
  })
})

// ── 2. The Firestore reader: one-shot, server-only, read-only ────────────────

describe('usePortfolioReport opens no listener and writes nothing', () => {
  const raw = read('hooks/usePortfolioReport.jsx')
  const code = stripComments(raw)

  it('has no persistent listener — not even the word in a comment', () => {
    expect(raw).not.toContain('onSnapshot')
  })

  it('reads from the SERVER only, so an offline cache can never arrive as an empty register', () => {
    expect(code).toContain('getDocsFromServer(')
    expect(code).toContain('getDocFromServer(')
    expect(code).not.toMatch(/\bgetDocs\(/)
    expect(code).not.toMatch(/\bgetDoc\(/)
    expect(code).not.toContain('FromCache')
  })

  it('issues no collection-group query, no limit and no pagination', () => {
    for (const banned of ['collectionGroup', 'limit(', 'limitToLast', 'startAfter', 'startAt(', 'getCountFromServer', 'getAggregateFromServer']) {
      expect(code).not.toContain(banned)
    }
  })

  it('performs no write and calls no Function', () => {
    for (const banned of ['setDoc', 'addDoc', 'updateDoc', 'deleteDoc', 'runTransaction', 'writeBatch', 'httpsCallable', 'firebase/functions']) {
      expect(code).not.toContain(banned)
    }
  })

  it('every path is under the caller\'s own company and one project', () => {
    expect(code).toContain(`['companies', companyId, 'projects', projectId]`)
    expect(code).toContain('const companyId = company?.id ?? null')
  })

  it('maps documents exactly as the hooks do, and takes its plan from lib/portfolioSources.js', () => {
    expect(code).toContain('({ id: d.id, ...d.data() })')
    expect(code).toContain(`import { createPortfolioLoader, loadProjectSources } from '../lib/portfolioSources'`)
  })

  it('does not poll', () => {
    expect(code).not.toContain('setInterval')
    expect(code).not.toContain('setTimeout')
  })

  it('the plan module itself never imports the SDK', () => {
    expect(read('lib/portfolioSources.js')).not.toMatch(/from 'firebase/)
  })
})

// ── 3. The approved budget, rebuilt from one-shot reads ──────────────────────

const ENTRIES_V2 = [
  { lineId: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 4500 },
  { lineId: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 3000 },
]
const withVersion2 = () => {
  const p = readyProject()
  p.pointer = { activeApprovalId: 'ba2', originalApprovalId: 'ba1', versionCount: 2 }
  p.budgetApprovals.push({ id: 'ba2', status: 'approved', version: 2, entryCount: 2, total: 7500, currency: 'AUD', reason: 'Re-approved' })
  p.budgetApprovalSnapshots.push({ id: 'ba2', entryCount: 2, total: 7500, currency: 'AUD', entries: ENTRIES_V2 })
  return p
}
const adjustment = (o = {}) => ({
  id: 'adj1', type: 'increase', costCodeId: 'cc1', costCodeName: '03-100 — Concrete',
  fromCostCodeId: null, fromCostCodeName: '', amount: 500, currency: 'AUD', reason: 'r', reference: '',
  baseApprovalId: 'ba1', baseVersion: 1, sequence: 1, status: 'approved', revision: 2,
  createdAt: { seconds: 200, nanoseconds: 0 }, createdBy: 'u_qs', updatedAt: { seconds: 300, nanoseconds: 0 }, updatedBy: 'u_pm',
  ...o,
})
const withAdjustment = () => {
  const p = readyProject()
  p.pointer = { ...p.pointer, adjustmentCount: 1, adjustmentNet: 500, lastAdjustmentId: 'adj1' }
  // A record of ANOTHER version in the same collection: the equality filter
  // must keep it out, exactly as the hook's query does.
  p.budgetAdjustments = [adjustment(), adjustment({ id: 'old', baseApprovalId: 'ba0', baseVersion: 0 })]
  return p
}

const resolve = (approvedBudget, p) => resolveBudgetSource({
  approvedBudget, budgetLines: p.budgetLines, budgetLinesLoading: false, budgetLinesError: false, currencyCode: 'AUD',
})
const keysOf = (reader) => reader.calls.map(c => (c.kind === 'get' ? c.key : `list:${c.collection}`))

describe('loadApprovedBudget — pointer, header, snapshot, original, adjustments', () => {
  it('no approved budget: reads the pointer ONLY and falls back to the working register', async () => {
    const p = readyProject()
    p.pointer = null
    const reader = fakeReader(storeOf(p))
    const { approvedBudget, reads } = await loadApprovedBudget(reader, SCOPE)
    expect(keysOf(reader)).toEqual(['approvedBudget/current'])
    expect(reads).toBe(1)
    expect(approvedBudget).toMatchObject({
      pointer: null, pointerError: false, header: null, snapshot: null, originalSnapshot: null,
      adjustments: null, originalRequested: true,
    })
    const r = resolve(approvedBudget, p)
    expect(r.kind).toBe(BUDGET_SOURCE.WORKING)
    expect(r.total).toBe(7000)
  })

  it('version 1: pointer + header + snapshot; the original IS the active one, so it is not read twice', async () => {
    const p = readyProject()
    const reader = fakeReader(storeOf(p))
    const { approvedBudget, reads } = await loadApprovedBudget(reader, SCOPE)
    expect(keysOf(reader).sort()).toEqual(['approvedBudget/current', 'budgetApprovalSnapshots/ba1', 'budgetApprovals/ba1'])
    expect(reads).toBe(3)
    expect(approvedBudget.adjustments).toBeNull()
    const r = resolve(approvedBudget, p)
    expect(r).toMatchObject({ kind: BUDGET_SOURCE.APPROVED, version: 1, total: 7000, originalTotal: 7000 })
  })

  it('version 2: the ORIGINAL snapshot is a separate read', async () => {
    const p = withVersion2()
    const reader = fakeReader(storeOf(p))
    const { approvedBudget, reads } = await loadApprovedBudget(reader, SCOPE)
    expect(keysOf(reader).sort()).toEqual([
      'approvedBudget/current', 'budgetApprovalSnapshots/ba1', 'budgetApprovalSnapshots/ba2', 'budgetApprovals/ba2',
    ])
    expect(reads).toBe(4)
    expect(resolve(approvedBudget, p)).toMatchObject({ kind: BUDGET_SOURCE.APPROVED, version: 2, total: 7500, originalTotal: 7000 })
  })

  it('adjustments present: read with the equality filter, and folded into the approved total', async () => {
    const p = withAdjustment()
    const reader = fakeReader(storeOf(p))
    const { approvedBudget, reads } = await loadApprovedBudget(reader, SCOPE)
    const adjCall = reader.calls.find(c => c.collection === 'budgetAdjustments')
    expect(adjCall).toMatchObject({ kind: 'list', where: ['baseApprovalId', '==', 'ba1'], orderBy: null })
    expect(reads).toBe(4)
    expect(approvedBudget.adjustments.map(a => a.id)).toEqual(['adj1'])
    expect(resolve(approvedBudget, p)).toMatchObject({
      kind: BUDGET_SOURCE.APPROVED, baseTotal: 7000, adjustmentCount: 1, adjustmentNet: 500, total: 7500,
    })
  })

  it('adjustments absent (ledger 0): the collection is NOT read and the value is null, as the idle hook exposes', async () => {
    const reader = fakeReader(storeOf(readyProject()))
    const { approvedBudget } = await loadApprovedBudget(reader, SCOPE)
    expect(reader.calls.some(c => c.collection === 'budgetAdjustments')).toBe(false)
    expect(approvedBudget).toMatchObject({ adjustments: null, adjustmentsLoading: false, adjustmentsError: false })
  })

  it('a ledger that claims adjustments the read does not return fails CLOSED', async () => {
    const p = withAdjustment()
    p.budgetAdjustments = []
    const { approvedBudget } = await loadApprovedBudget(fakeReader(storeOf(p)), SCOPE)
    const r = resolve(approvedBudget, p)
    expect(r.kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
    expect(r.problems).toContain(BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_COUNT)
  })

  it('a failed adjustments read is Unavailable, never an unadjusted approved budget', async () => {
    const p = withAdjustment()
    const reader = fakeReader(storeOf(p), { fail: c => c.collection === 'budgetAdjustments' })
    const { approvedBudget } = await loadApprovedBudget(reader, SCOPE)
    expect(approvedBudget).toMatchObject({ adjustments: [], adjustmentsError: true })
    expect(resolve(approvedBudget, p).kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
  })

  it('a failed pointer read is Unavailable — it is NOT read as "no approved budget"', async () => {
    const p = readyProject()
    const reader = fakeReader(storeOf(p), { fail: c => c.key === 'approvedBudget/current' })
    const { approvedBudget, reads } = await loadApprovedBudget(reader, SCOPE)
    expect(approvedBudget.pointerError).toBe(true)
    expect(reads).toBe(1)
    expect(resolve(approvedBudget, p).kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
  })

  it('a missing header, a failed header read and a failed snapshot read are each Unavailable', async () => {
    const missing = readyProject()
    missing.budgetApprovals = []
    const a = await loadApprovedBudget(fakeReader(storeOf(missing)), SCOPE)
    expect(resolve(a.approvedBudget, missing)).toMatchObject({ kind: BUDGET_SOURCE.UNAVAILABLE })
    expect(resolve(a.approvedBudget, missing).problems).toContain(BUDGET_INTEGRITY_PROBLEM.HEADER_MISSING)

    const p = readyProject()
    const b = await loadApprovedBudget(fakeReader(storeOf(p), { fail: c => c.key === 'budgetApprovals/ba1' }), SCOPE)
    expect(b.approvedBudget.headerError).toBe(true)
    expect(resolve(b.approvedBudget, p).kind).toBe(BUDGET_SOURCE.UNAVAILABLE)

    const c = await loadApprovedBudget(fakeReader(storeOf(p), { fail: x => x.key === 'budgetApprovalSnapshots/ba1' }), SCOPE)
    expect(c.approvedBudget.snapshotError).toBe(true)
    expect(resolve(c.approvedBudget, p).kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
  })

  it('a missing ORIGINAL snapshot is Unavailable, exactly as on the Reports tab', async () => {
    const p = withVersion2()
    p.budgetApprovalSnapshots = p.budgetApprovalSnapshots.filter(s => s.id !== 'ba1')
    const { approvedBudget } = await loadApprovedBudget(fakeReader(storeOf(p)), SCOPE)
    const r = resolve(approvedBudget, p)
    expect(r.kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
    expect(r.problems).toContain(BUDGET_INTEGRITY_PROBLEM.ORIGINAL_MISSING)
  })

  it('resolves to exactly what the live composite object resolves to', async () => {
    for (const p of [readyProject(), withVersion2(), withAdjustment()]) {
      const { approvedBudget } = await loadApprovedBudget(fakeReader(storeOf(p)), SCOPE)
      const activeId = p.pointer.activeApprovalId
      const originalId = p.pointer.originalApprovalId
      // The object hooks/useApprovedBudget.jsx builds with { original: true }.
      const live = {
        ...sourcesOf(p).approvedBudget,
        originalRequested: true,
        originalSnapshot: originalId !== activeId ? p.budgetApprovalSnapshots.find(s => s.id === originalId) : null,
        adjustments: (p.pointer.adjustmentCount ?? 0) > 0
          ? p.budgetAdjustments.filter(a => a.baseApprovalId === activeId)
          : null,
      }
      expect(approvedBudget).toEqual(live)
      expect(resolve(approvedBudget, p)).toEqual(resolve(live, p))
    }
  })
})

// ── 4. One project ───────────────────────────────────────────────────────────

describe('loadProjectSources — every register, whole, with failures kept', () => {
  it('reads the eleven registers, the baseline and the approved budget', async () => {
    const p = readyProject()
    const reader = fakeReader(storeOf(p))
    const { sources, readStates, reads } = await loadProjectSources(reader, SCOPE)
    for (const spec of PORTFOLIO_LIST_SOURCES) {
      expect(sources[spec.source]).toEqual(p[spec.source])
      expect(readStates[spec.source]).toEqual({ loading: false, error: false })
    }
    expect(sources.baseline).toEqual(p.baseline)
    expect(readStates.baseline).toEqual({ loading: false, error: false })
    expect(sources.approvedBudget.pointer).toEqual(p.pointer)
    // The budget state is derived by the model, never asserted by the loader.
    expect(readStates.approvedBudget).toBeUndefined()
    expect(reads).toBe(reader.calls.length)
  })

  it('every read is scoped to the given company and project, and asks for the hook\'s ordering', async () => {
    const reader = fakeReader(storeOf(readyProject()))
    await loadProjectSources(reader, SCOPE)
    for (const call of reader.calls) {
      expect(call.companyId).toBe('coA')
      expect(call.projectId).toBe('p1')
    }
    for (const spec of PORTFOLIO_LIST_SOURCES) {
      const call = reader.calls.find(c => c.kind === 'list' && c.collection === spec.collection)
      expect(call.orderBy).toEqual(spec.orderBy)
      expect(call.where).toBeNull()
      // Nothing that could truncate a register is ever passed.
      expect(Object.keys(call).sort()).toEqual(['collection', 'companyId', 'kind', 'orderBy', 'projectId', 'where'])
    }
  })

  it('the documented read count is the real one: 13 with no approved budget, 17 at most', async () => {
    const none = readyProject()
    none.pointer = null
    const a = fakeReader(storeOf(none))
    expect((await loadProjectSources(a, SCOPE)).reads).toBe(13)
    expect(a.calls.length).toBe(PORTFOLIO_READS_PER_PROJECT.min)

    const full = withVersion2()
    full.pointer = { ...full.pointer, adjustmentCount: 1, adjustmentNet: 500, lastAdjustmentId: 'adj1' }
    full.budgetAdjustments = [adjustment({ baseApprovalId: 'ba2', baseVersion: 2 })]
    const b = fakeReader(storeOf(full))
    expect((await loadProjectSources(b, SCOPE)).reads).toBe(17)
    expect(b.calls.length).toBe(PORTFOLIO_READS_PER_PROJECT.max)

    // The common case — one approved version, no adjustments.
    const c = fakeReader(storeOf(readyProject()))
    expect((await loadProjectSources(c, SCOPE)).reads).toBe(15)
  })

  it('a large register is returned whole', async () => {
    const p = readyProject()
    p.purchaseOrders = Array.from({ length: 1500 }, (_, i) => ({ id: `po${i}`, status: 'draft', lineItems: [] }))
    const { sources } = await loadProjectSources(fakeReader(storeOf(p)), SCOPE)
    expect(sources.purchaseOrders).toHaveLength(1500)
  })

  it('a failed register is an empty list WITH error: true — and never rejects the project', async () => {
    const p = readyProject()
    const reader = fakeReader(storeOf(p), { fail: c => c.collection === 'supplierInvoices' || c.key === 'commercial/baseline' })
    const { sources, readStates } = await loadProjectSources(reader, SCOPE)
    expect(sources.supplierInvoices).toEqual([])
    expect(readStates.supplierInvoices).toEqual({ loading: false, error: true })
    expect(sources.baseline).toBeNull()
    expect(readStates.baseline).toEqual({ loading: false, error: true })
    // Everything else still loaded.
    expect(sources.purchaseOrders).toEqual(p.purchaseOrders)
    expect(readStates.purchaseOrders.error).toBe(false)
  })

  it('a reader that returns a non-array for a register is a failure, not an empty register', async () => {
    const reader = fakeReader(storeOf(readyProject()))
    const original = reader.list.bind(reader)
    reader.list = (args) => (args.collection === 'variations' ? Promise.resolve(undefined) : original(args))
    const { sources, readStates } = await loadProjectSources(reader, SCOPE)
    expect(sources.variations).toEqual([])
    expect(readStates.variations.error).toBe(true)
  })

  it('every read failing still resolves: every source failed, none loading', async () => {
    const { readStates, sources } = await loadProjectSources(fakeReader(storeOf(readyProject()), { fail: () => true }), SCOPE)
    for (const spec of PORTFOLIO_LIST_SOURCES) expect(readStates[spec.source]).toEqual({ loading: false, error: true })
    expect(readStates.baseline.error).toBe(true)
    expect(sources.approvedBudget.pointerError).toBe(true)
  })

  it('failedProjectResult marks every source failed', () => {
    const f = failedProjectResult()
    for (const spec of PORTFOLIO_LIST_SOURCES) {
      expect(f.sources[spec.source]).toEqual([])
      expect(f.readStates[spec.source]).toEqual({ loading: false, error: true })
    }
    expect(f.readStates.baseline.error).toBe(true)
    expect(f.sources.approvedBudget.pointerError).toBe(true)
  })
})

// ── 5. Bounded concurrency and obsolete runs ─────────────────────────────────

// A loadProject whose promises the test settles by hand.
function manualLoads() {
  const pending = new Map()
  const started = []
  let peak = 0
  const loadProject = (id) => new Promise((resolveLoad, rejectLoad) => {
    started.push(id)
    pending.set(id, { resolveLoad, rejectLoad })
    peak = Math.max(peak, pending.size)
  })
  const finish = (id, value = { id }) => { pending.get(id).resolveLoad(value); pending.delete(id) }
  const fail = (id) => { pending.get(id).rejectLoad(new Error('boom')); pending.delete(id) }
  return { loadProject, started, pending, finish, fail, peak: () => peak }
}
const tick = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }
const ids = (n) => Array.from({ length: n }, (_, i) => `p${i + 1}`)

describe('createPortfolioLoader — at most three projects at a time', () => {
  it('the bound is three', () => {
    expect(PORTFOLIO_PROJECT_CONCURRENCY).toBe(3)
  })

  it('never runs more than three loads at once, and starts them in order', async () => {
    const m = manualLoads()
    const results = []
    const loader = createPortfolioLoader({ loadProject: m.loadProject, onResult: (id) => results.push(id) })
    loader.enqueue(ids(10))
    await tick()
    expect(m.started).toEqual(['p1', 'p2', 'p3'])
    expect(loader.activeCount).toBe(3)
    expect(loader.queuedCount).toBe(7)

    m.finish('p2')
    await tick()
    expect(m.started).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(m.pending.size).toBe(3)

    while (m.pending.size > 0) {
      m.finish([...m.pending.keys()][0])
      await tick()
      expect(m.pending.size).toBeLessThanOrEqual(3)
    }
    expect(m.peak()).toBe(3)
    expect(m.started).toEqual(ids(10))
    expect([...results].sort()).toEqual(ids(10).sort())
  })

  it('a project is never read twice in one run', async () => {
    const m = manualLoads()
    const loader = createPortfolioLoader({ loadProject: m.loadProject, onResult: () => {} })
    loader.enqueue(['p1', 'p2'])
    loader.enqueue(['p2', 'p1', 'p3'])
    await tick()
    m.finish('p1'); m.finish('p2'); m.finish('p3')
    await tick()
    loader.enqueue(['p1', 'p3'])
    await tick()
    expect(m.started).toEqual(['p1', 'p2', 'p3'])
  })

  it('retain drops queued projects that left the scope — and they can be enqueued again', async () => {
    const m = manualLoads()
    const loader = createPortfolioLoader({ loadProject: m.loadProject, onResult: () => {} })
    loader.enqueue(ids(6))
    await tick()
    loader.retain(['p1', 'p2', 'p3', 'p4'])       // p5, p6 (completed projects, say) leave the scope
    expect(loader.queuedCount).toBe(1)
    m.finish('p1'); m.finish('p2'); m.finish('p3')
    await tick()
    m.finish('p4')
    await tick()
    expect(m.started).toEqual(['p1', 'p2', 'p3', 'p4'])
    loader.enqueue(ids(6))
    await tick()
    expect(m.started).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
  })

  it('cancel: queued projects never start and in-flight results are DISCARDED', async () => {
    const m = manualLoads()
    const results = []
    const loader = createPortfolioLoader({ loadProject: m.loadProject, onResult: (id) => results.push(id) })
    loader.enqueue(ids(8))
    await tick()
    m.finish('p1')
    await tick()
    expect(results).toEqual(['p1'])

    loader.cancel()                                 // navigation away, or Refresh
    for (const id of [...m.pending.keys()]) m.finish(id)
    await tick()
    expect(results).toEqual(['p1'])
    expect(m.started).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(loader.cancelled).toBe(true)
    loader.enqueue(['p9'])
    await tick()
    expect(m.started).not.toContain('p9')
  })

  it('a loader cancelled before its first tick issues NO read (StrictMode mount / unmount / mount)', async () => {
    const m = manualLoads()
    const loader = createPortfolioLoader({ loadProject: m.loadProject, onResult: () => {} })
    loader.enqueue(ids(5))
    loader.cancel()
    await tick()
    expect(m.started).toEqual([])
  })

  it('Refresh race: the old run reports nothing after the new run starts', async () => {
    const reported = []
    const oldRun = manualLoads()
    const a = createPortfolioLoader({ loadProject: oldRun.loadProject, onResult: (id, r) => reported.push(['old', id, r.run]) })
    a.enqueue(['p1', 'p2'])
    await tick()

    a.cancel()
    const newRun = manualLoads()
    const b = createPortfolioLoader({ loadProject: newRun.loadProject, onResult: (id, r) => reported.push(['new', id, r.run]) })
    b.enqueue(['p1', 'p2'])
    await tick()

    // The stale reads land AFTER the fresh ones started — and are ignored.
    oldRun.finish('p1', { run: 'stale' })
    newRun.finish('p1', { run: 'fresh' })
    oldRun.finish('p2', { run: 'stale' })
    newRun.finish('p2', { run: 'fresh' })
    await tick()
    expect(reported).toEqual([['new', 'p1', 'fresh'], ['new', 'p2', 'fresh']])
  })

  it('a load that throws is reported as a FAILED project, and the queue keeps moving', async () => {
    const m = manualLoads()
    const results = {}
    const loader = createPortfolioLoader({ loadProject: m.loadProject, onResult: (id, r) => { results[id] = r }, limit: 1 })
    loader.enqueue(['p1', 'p2'])
    await tick()
    m.fail('p1')
    await tick()
    expect(results.p1).toEqual(failedProjectResult())
    expect(m.started).toEqual(['p1', 'p2'])
  })

  it('ignores ids that are not non-empty strings', async () => {
    const m = manualLoads()
    const loader = createPortfolioLoader({ loadProject: m.loadProject, onResult: () => {} })
    loader.enqueue([null, '', 7, undefined, 'p1'])
    await tick()
    expect(m.started).toEqual(['p1'])
  })
})
