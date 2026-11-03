import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  runBudgetAdjustmentPrepare, runBudgetAdjustmentApprove, runBudgetAdjustmentWithdraw, readAdjustedBudgetFromServer,
  BUDGET_ADJUSTMENT_ERROR, BUDGET_ADJUSTMENT_ERROR_MESSAGES, BudgetAdjustmentWriteError,
} from '../../src/lib/budgetAdjustmentActions'
import { runBudgetApprove, BUDGET_APPROVAL_ERROR } from '../../src/lib/budgetApprovalActions'
import { budgetSupersessionKey } from '../../src/lib/budgetApproval'

// ── Approved Budget ADJUSTMENT writes (ADR-71) — fake Firestore, real action layer ──
//
// A fake SDK serves scripted server reads (`getDocFromServer` by ref id,
// `getDocsFromServer` by query tag) and transaction reads, and records
// writes — proving the ORDER (fresh authoritative read, then one transaction
// that reads before it writes), the compare-and-set on the draft AND the
// pointer ledger, the refusals and the outcome mapping, without an emulator.
// tests/rules/budgetAdjustments.rules.test.js runs the same functions
// against the real rules.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const ts = (s) => ({ seconds: s, nanoseconds: 0, isEqual(o) { return o?.seconds === s && o?.nanoseconds === 0 } })

const ENTRIES = [
  { lineId: 'l1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 600 },
  { lineId: 'l2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 400 },
]
const HEADER = { status: 'approved', version: 1, entryCount: 2, total: 1000, currency: 'AUD' }
const SNAP = { entryCount: 2, total: 1000, currency: 'AUD', entries: ENTRIES }
const CODES = [{ id: 'cc1', code: '03-100', name: 'Concrete' }, { id: 'cc2', code: '03-200', name: 'Formwork' }]
const POINTER = { activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1 }

const draft = (o = {}) => ({
  id: 'adj1', type: 'increase', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', fromCostCodeId: null, fromCostCodeName: '',
  amount: 50, currency: 'AUD', reason: 'Scope', reference: '', baseApprovalId: 'ba1', baseVersion: 1, sequence: null,
  status: 'draft', approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
  revision: 1, createdAt: ts(10), createdBy: 'u_qs', updatedAt: ts(10), updatedBy: 'u_qs', ...o,
})
const approved = (o = {}) => draft({ id: 'adjA', status: 'approved', sequence: 1, revision: 2, updatedAt: ts(20), updatedBy: 'u_pm', ...o })

// `server` — what getDoc(s)FromServer return (doc id → data, query tag → rows);
// `tx` — what transaction reads see (doc id → data). By default the
// transaction sees what the server returned.
function fake({ server = {}, tx = null, fail = null, serverFail = null } = {}) {
  const log = []
  const txDocs = tx ?? server
  const api = {
    log, writes: [],
    serverTimestamp: () => 'SERVER_TS',
    getDocFromServer: async (ref) => {
      log.push(['serverDoc', ref.key ?? ref.id])
      if (serverFail) { const e = new Error(serverFail); e.code = serverFail; throw e }
      const d = server[ref.key ?? ref.id] ?? null
      return { id: ref.id, exists: () => d !== null, data: () => d }
    },
    getDocsFromServer: async (q) => {
      log.push(['serverQuery', q.tag])
      if (serverFail) { const e = new Error(serverFail); e.code = serverFail; throw e }
      return { docs: (server[q.tag] ?? []).map(a => ({ id: a.id, data: () => { const r = { ...a }; delete r.id; return r } })) }
    },
    runTransaction: async (_db, fn) => {
      log.push(['tx'])
      if (fail) { const e = new Error(fail); e.code = fail; throw e }
      const t = {
        get: async (ref) => {
          log.push(['get', ref.id])
          const d = txDocs[ref.id] ?? null
          return { id: ref.id, exists: () => d !== null, data: () => d }
        },
        update: (ref, data) => { log.push(['update', ref.id]); api.writes.push({ kind: 'update', id: ref.id, data }) },
        set: (ref, data) => { log.push(['set', ref.id]); api.writes.push({ kind: 'set', id: ref.id, data }) },
      }
      return fn(t)
    },
  }
  return api
}
// `key` distinguishes documents that share an id across collections (an
// approval header and its snapshot share the approval id).
const ref = (id, key = id) => ({ id, key })
const CQ = { tag: 'codes' }
const sdk = (fs) => ({ runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp, getDocFromServer: fs.getDocFromServer, getDocsFromServer: fs.getDocsFromServer })

const prepareArgs = (fs, o = {}) => ({
  db: {}, adjustmentRef: ref('adj1'), pointerRef: ref('current'), costCodesQuery: CQ, ...sdk(fs),
  input: { type: 'increase', costCodeId: 'cc1', amount: '50', reason: 'Scope', reference: 'CV-1' },
  uid: 'u_qs', currencyCode: 'AUD', ...o,
})
const approveArgs = (fs, o = {}) => ({
  db: {}, adjustmentRef: ref('adj1'), pointerRef: ref('current'),
  approvalHeaderRef: (id) => ref(id, `h:${id}`), approvalSnapshotRef: (id) => ref(id, `s:${id}`),
  adjustmentsQuery: (id) => ({ tag: `adj:${id}` }), ...sdk(fs),
  seen: draft(), uid: 'u_pm', currencyCode: 'AUD', ...o,
})
// A consistent server state: v1 1000 with `approvedList` approved adjustments.
const serverState = (approvedList = [], pointerOver = {}, extra = {}) => {
  const net = approvedList.reduce((s, a) => s + (a.type === 'increase' ? a.amount : a.type === 'decrease' ? -a.amount : 0), 0)
  const pointer = { ...POINTER, ...(approvedList.length ? { adjustmentCount: approvedList.length, adjustmentNet: net, lastAdjustmentId: approvedList.at(-1).id } : {}), ...pointerOver }
  return {
    current: pointer, 'h:ba1': HEADER, 's:ba1': SNAP, 'adj:ba1': [...approvedList, draft()], adj1: draft(), codes: CODES, ...extra,
  }
}

describe('module boundary', () => {
  it('imports no Firebase SDK (injected), and writes only adjustments and the pointer ledger', () => {
    const src = read('lib/budgetAdjustmentActions.js')
    expect(src).not.toMatch(/from 'firebase/)
    const targets = [...src.matchAll(/tx\.(?:set|update)\((\w+)/g)].map(m => m[1])
    expect(targets.length).toBeGreaterThan(0)
    expect([...new Set(targets)].sort()).toEqual(['adjustmentRef', 'pointerRef'])
    expect(BUDGET_ADJUSTMENT_ERROR_MESSAGES[BUDGET_ADJUSTMENT_ERROR.PERMISSION]).toMatch(/reload/)
  })
})

describe('runBudgetAdjustmentPrepare', () => {
  it('reads the cost codes FROM THE SERVER first, then ONE transaction: own id, pointer, then the draft bound to the active version', async () => {
    const fs = fake({ server: serverState([], {}, { adj1: null }) })
    const r = await runBudgetAdjustmentPrepare(prepareArgs(fs))
    expect(r).toEqual({ id: 'adj1', existing: false })
    expect(fs.log).toEqual([['serverQuery', 'codes'], ['tx'], ['get', 'adj1'], ['get', 'current'], ['set', 'adj1']])
    expect(fs.writes[0].data).toEqual({
      type: 'increase', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', fromCostCodeId: null, fromCostCodeName: '',
      amount: 50, reason: 'Scope', reference: 'CV-1', currency: 'AUD', baseApprovalId: 'ba1', baseVersion: 1, sequence: null,
      status: 'draft', approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
      revision: 1, createdAt: 'SERVER_TS', createdBy: 'u_qs', updatedAt: 'SERVER_TS', updatedBy: 'u_qs',
    })
  })
  it('the SAME id already saved by this user (double-click / retry) writes nothing and reports existing', async () => {
    const fs = fake({ server: serverState() })
    expect(await runBudgetAdjustmentPrepare(prepareArgs(fs))).toEqual({ id: 'adj1', existing: true })
    expect(fs.writes).toEqual([])
  })
  it('an id held by ANOTHER user is refused', async () => {
    const fs = fake({ server: serverState([], {}, { adj1: draft({ createdBy: 'u_x' }) }) })
    await expect(runBudgetAdjustmentPrepare(prepareArgs(fs))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
  })
  it('NO approved version → NO_BASE; a preview against another version → STALE_BASE; nothing written', async () => {
    const none = fake({ server: { codes: CODES } })
    await expect(runBudgetAdjustmentPrepare(prepareArgs(none))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.NO_BASE })
    const moved = fake({ server: serverState([], {}, { adj1: null }) })
    await expect(runBudgetAdjustmentPrepare(prepareArgs(moved, { seenBase: 'ba0' }))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.STALE_BASE })
    expect(none.writes).toEqual([])
    expect(moved.writes).toEqual([])
  })
  it('refuses invalid input BEFORE any transaction (unknown code, a third decimal, same-code transfer, no reason)', async () => {
    for (const input of [
      { type: 'increase', costCodeId: 'nope', amount: '5', reason: 'r' },
      { type: 'increase', costCodeId: 'cc1', amount: '5.001', reason: 'r' },
      { type: 'transfer', costCodeId: 'cc1', fromCostCodeId: 'cc1', amount: '5', reason: 'r' },
      { type: 'increase', costCodeId: 'cc1', amount: '5', reason: '' },
    ]) {
      const fs = fake({ server: serverState() })
      await expect(runBudgetAdjustmentPrepare(prepareArgs(fs, { input }))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
      expect(fs.log.some(([k]) => k === 'tx')).toBe(false)
    }
  })
  it('unresolved currency, no user, offline and denied map to their kinds', async () => {
    await expect(runBudgetAdjustmentPrepare(prepareArgs(fake(), { currencyCode: null }))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
    await expect(runBudgetAdjustmentPrepare(prepareArgs(fake(), { uid: null }))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.PERMISSION })
    await expect(runBudgetAdjustmentPrepare(prepareArgs(fake({ serverFail: 'unavailable' })))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.OFFLINE })
    await expect(runBudgetAdjustmentPrepare(prepareArgs(fake({ server: serverState([], {}, { adj1: null }), fail: 'permission-denied' })))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.PERMISSION })
  })
})

describe('readAdjustedBudgetFromServer — the authoritative state through THE adapter', () => {
  it('reconciles the ledger with the records; an unreconciled store refuses with its problems', async () => {
    const ok = await readAdjustedBudgetFromServer({ ...approveArgs(fake({ server: serverState([approved()]) })) })
    expect(ok.resolved).toMatchObject({ kind: 'approved', total: 1050, adjustmentCount: 1, adjustmentNet: 50 })
    const broken = fake({ server: serverState([approved()], { adjustmentCount: 2, adjustmentNet: 100 }) })
    const err = await readAdjustedBudgetFromServer(approveArgs(broken)).catch(e => e)
    expect(err).toBeInstanceOf(BudgetAdjustmentWriteError)
    expect(err.kind).toBe(BUDGET_ADJUSTMENT_ERROR.INVALID)
    expect(err.details.problems).toContain('adjustment_count')
  })
})

describe('runBudgetAdjustmentApprove', () => {
  it('fresh server read FIRST, then one transaction: draft, pointer, then the paired writes (sequence = count + 1)', async () => {
    const fs = fake({ server: serverState([approved()]) })
    const r = await runBudgetAdjustmentApprove(approveArgs(fs))
    expect(r.sequence).toBe(2)
    expect(fs.log).toEqual([
      ['serverDoc', 'current'], ['serverDoc', 'h:ba1'], ['serverDoc', 's:ba1'], ['serverQuery', 'adj:ba1'],
      ['tx'], ['get', 'adj1'], ['get', 'current'], ['update', 'adj1'], ['update', 'current'],
    ])
    expect(fs.writes[0].data).toEqual({ status: 'approved', sequence: 2, approvedAt: 'SERVER_TS', approvedBy: 'u_pm', revision: 2, updatedAt: 'SERVER_TS', updatedBy: 'u_pm' })
    expect(fs.writes[1].data).toEqual({ adjustmentCount: 2, adjustmentNet: 100, lastAdjustmentId: 'adj1', updatedAt: 'SERVER_TS', updatedBy: 'u_pm' })
  })
  it('the ledger net moves by EXACTLY the derived movement: decrease −amount, transfer 0', async () => {
    const dec = fake({ server: serverState([], {}, { adj1: draft({ type: 'decrease', amount: 12.34 }) }) })
    await runBudgetAdjustmentApprove(approveArgs(dec, { seen: draft({ type: 'decrease', amount: 12.34 }) }))
    expect(dec.writes[1].data).toMatchObject({ adjustmentCount: 1, adjustmentNet: -12.34 })
    const t = draft({ type: 'transfer', fromCostCodeId: 'cc2', fromCostCodeName: 'F', amount: 100 })
    const tr = fake({ server: serverState([], {}, { adj1: t }) })
    await runBudgetAdjustmentApprove(approveArgs(tr, { seen: t }))
    expect(tr.writes[1].data).toMatchObject({ adjustmentCount: 1, adjustmentNet: 0 })
  })
  it('a resulting cost code BELOW ZERO is refused NEGATIVE before any transaction', async () => {
    const t = draft({ type: 'transfer', fromCostCodeId: 'cc2', fromCostCodeName: 'F', amount: 400.01 })
    const fs = fake({ server: serverState([], {}, { adj1: t }) })
    const err = await runBudgetAdjustmentApprove(approveArgs(fs, { seen: t })).catch(e => e)
    expect(err.kind).toBe(BUDGET_ADJUSTMENT_ERROR.NEGATIVE)
    expect(err.details.preview.negative).toEqual([expect.objectContaining({ costCodeId: 'cc2', after: -0.01 })])
    expect(fs.log.some(([k]) => k === 'tx')).toBe(false)
  })
  it('a draft whose version was REPLACED is refused STALE_BASE (server read, or inside the transaction)', async () => {
    const moved = fake({ server: serverState([], { activeApprovalId: 'ba2', versionCount: 2 }, { 'h:ba2': { ...HEADER, version: 2 }, 's:ba2': SNAP, 'adj:ba2': [] }) })
    await expect(runBudgetAdjustmentApprove(approveArgs(moved))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.STALE_BASE })
    const s = serverState()
    const racing = fake({ server: s, tx: { ...s, current: { ...POINTER, activeApprovalId: 'ba2', versionCount: 2 } } })
    await expect(runBudgetAdjustmentApprove(approveArgs(racing))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.STALE_BASE })
    expect(racing.writes).toEqual([])
  })
  it('a ledger that moved between the read and the transaction (another approval) is SUPERSEDED — never stacked blindly', async () => {
    const s = serverState()
    const fs = fake({ server: s, tx: { ...s, current: { ...POINTER, adjustmentCount: 1, adjustmentNet: 10 } } })
    await expect(runBudgetAdjustmentApprove(approveArgs(fs))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.SUPERSEDED })
    expect(fs.writes).toEqual([])
  })
  it('a rules refusal after a lost race is reported truthfully (SUPERSEDED) when the ledger moved', async () => {
    const s = serverState()
    const fs = fake({ server: s, fail: 'permission-denied' })
    // The post-failure pointer read sees the ledger advanced by the winner.
    // The authoritative reads see the ledger at 0; the post-failure pointer
    // read (the 4th document read) sees it advanced by the race's winner.
    let calls = 0
    fs.getDocFromServer = async (r) => {
      calls += 1
      const data = calls > 3 && r.key === 'current' ? { ...POINTER, adjustmentCount: 1, adjustmentNet: 5 } : s[r.key]
      return { id: r.id, exists: () => true, data: () => data }
    }
    await expect(runBudgetAdjustmentApprove(approveArgs(fs))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.SUPERSEDED })
  })
  it('a genuine permission refusal stays PERMISSION (the ledger did not move)', async () => {
    const fs = fake({ server: serverState(), fail: 'permission-denied' })
    await expect(runBudgetAdjustmentApprove(approveArgs(fs))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.PERMISSION })
  })
  it('a retry of a committed approval (the draft is no longer the one seen) never applies twice', async () => {
    const s = serverState([approved({ id: 'adj1' })], {}, { adj1: approved({ id: 'adj1' }) })
    const fs = fake({ server: s })
    await expect(runBudgetAdjustmentApprove(approveArgs(fs))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.STALE })
    expect(fs.writes).toEqual([])
  })
  it('refuses an already-approved copy, a still-saving draft and a malformed movement up front', async () => {
    await expect(runBudgetAdjustmentApprove(approveArgs(fake(), { seen: approved() }))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
    await expect(runBudgetAdjustmentApprove(approveArgs(fake(), { seen: draft({ updatedAt: null }) }))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.PENDING })
    await expect(runBudgetAdjustmentApprove(approveArgs(fake(), { seen: draft({ amount: 1.005 }) }))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
  })
  it('no pointer on the server → NO_BASE', async () => {
    await expect(runBudgetAdjustmentApprove(approveArgs(fake({ server: {} })))).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.NO_BASE })
  })
})

describe('runBudgetAdjustmentWithdraw', () => {
  it('draft → withdrawn with a reason, revision + 1; a non-draft or stale copy is refused', async () => {
    const fs = fake({ server: serverState() })
    expect(await runBudgetAdjustmentWithdraw({ db: {}, adjustmentRef: ref('adj1'), seen: draft(), reason: ' No longer needed ', uid: 'u_qs', ...sdk(fs) })).toBe(2)
    expect(fs.writes[0].data).toEqual({ status: 'withdrawn', withdrawnAt: 'SERVER_TS', withdrawnBy: 'u_qs', withdrawReason: 'No longer needed', revision: 2, updatedAt: 'SERVER_TS', updatedBy: 'u_qs' })
    const done = fake({ server: { adj1: approved({ id: 'adj1', updatedAt: ts(10), updatedBy: 'u_qs', revision: 1 }) } })
    await expect(runBudgetAdjustmentWithdraw({ db: {}, adjustmentRef: ref('adj1'), seen: draft(), reason: 'x', uid: 'u_qs', ...sdk(done) })).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
    await expect(runBudgetAdjustmentWithdraw({ db: {}, adjustmentRef: ref('adj1'), seen: draft(), reason: ' ', uid: 'u_qs', ...sdk(fs) })).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
  })
})

// ── Re-approval: the supersession guard and the ledger reset (2B1 action) ────

describe('runBudgetApprove — supersession acknowledged against the SERVER pointer; ledger reset', () => {
  const draftHeader = { id: 'ba2', reason: 'Re', status: 'draft', currency: 'AUD', entryCount: 2, total: 1000, version: null, revision: 1, createdAt: ts(10), createdBy: 'u_qs', updatedAt: ts(10), updatedBy: 'u_qs' }
  const lines = [{ id: 'l1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 600 }, { id: 'l2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 400 }]
  const snap = { id: 'ba2', ...SNAP }
  const ledgerPointer = { ...POINTER, adjustmentCount: 1, adjustmentNet: 50 }
  const fsFor = (pointer) => {
    const docs = { ba2: draftHeader, s2: snap, current: pointer }
    const fs = fake({ server: { lines }, tx: docs })
    return fs
  }
  const args = (fs, o = {}) => ({
    db: {}, headerRef: ref('ba2'), snapshotRef: ref('s2'), pointerRef: ref('current'), budgetLinesQuery: { tag: 'lines' },
    getDocsFromServer: fs.getDocsFromServer, runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp,
    seen: draftHeader, snapshot: snap, acknowledgedDriftKey: '', seenVersionCount: 1, uid: 'u_pm', ...o,
  })
  const key = budgetSupersessionKey({ versionCount: 1, adjustmentCount: 1, adjustmentNet: 50, baseTotal: 1000, proposedTotal: 1000 })

  it('with approved adjustments and NO acknowledgement → SUPERSESSION, nothing written', async () => {
    const fs = fsFor(ledgerPointer)
    await expect(runBudgetApprove(args(fs, { seenAdjustmentCount: 1, seenAdjustmentNet: 50, seenBaseTotal: 1000 }))).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.SUPERSESSION })
    expect(fs.writes).toEqual([])
  })
  it('an acknowledgement of OTHER figures → SUPERSESSION', async () => {
    const fs = fsFor(ledgerPointer)
    const other = budgetSupersessionKey({ versionCount: 1, adjustmentCount: 1, adjustmentNet: 50, baseTotal: 1000, proposedTotal: 1050 })
    await expect(runBudgetApprove(args(fs, { seenAdjustmentCount: 1, seenAdjustmentNet: 50, seenBaseTotal: 1000, acknowledgedSupersessionKey: other }))).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.SUPERSESSION })
  })
  it('a ledger that moved since the review (count or net) → SUPERSEDED', async () => {
    await expect(runBudgetApprove(args(fsFor(ledgerPointer), { seenAdjustmentCount: 0, seenAdjustmentNet: 0 }))).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.SUPERSEDED })
    await expect(runBudgetApprove(args(fsFor(ledgerPointer), { seenAdjustmentCount: 1, seenAdjustmentNet: 40, seenBaseTotal: 1000, acknowledgedSupersessionKey: key }))).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.SUPERSEDED })
  })
  it('the matching acknowledgement approves, and the pointer RESETS the ledger to zero', async () => {
    const fs = fsFor(ledgerPointer)
    await expect(runBudgetApprove(args(fs, { seenAdjustmentCount: 1, seenAdjustmentNet: 50, seenBaseTotal: 1000, acknowledgedSupersessionKey: key }))).resolves.toEqual({ version: 2 })
    expect(fs.writes.find(w => w.id === 'current').data).toMatchObject({ activeApprovalId: 'ba2', versionCount: 2, adjustmentCount: 0, adjustmentNet: 0, lastAdjustmentId: null })
  })
  it('a LEGACY pointer (no ledger) needs no acknowledgement — 2B1 behaviour unchanged', async () => {
    const fs = fsFor(POINTER)
    await expect(runBudgetApprove(args(fs))).resolves.toEqual({ version: 2 })
  })
})
