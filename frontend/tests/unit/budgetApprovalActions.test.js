import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  runBudgetCapture, runBudgetApprove, runBudgetWithdraw, checkBudgetDrift, readBudgetFromServer,
  BudgetApprovalWriteError, BUDGET_APPROVAL_ERROR, BUDGET_APPROVAL_ERROR_MESSAGES,
} from '../../src/lib/budgetApprovalActions'

// ── Approved Budget writes (ADR-70) — fake Firestore, real action layer ──────
//
// A fake `runTransaction` serves scripted reads and records writes, and a fake
// `getDocsFromServer` serves the "server" register — so these prove the ORDER
// (server read, then the pair in one transaction; drift read before the
// approve transaction; every read before any write), the compare-and-set on
// the header AND on the pointer, the refusals and the outcome mapping, without
// an emulator. The emulator suite (tests/rules/budgetApprovals.rules.test.js)
// runs the same functions against the real rules.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const ts = (s) => ({ seconds: s, nanoseconds: 0, isEqual(o) { return o?.seconds === s && o?.nanoseconds === 0 } })

const line = (id, costCodeId, budgeted, extra = {}) => ({ id, costCodeId, costCodeName: `${costCodeId} — name`, budgeted, notes: '', createdAt: ts(1), createdBy: 'u_qs', ...extra })
const codes = [{ id: 'cc1', code: '03-100', name: 'Concrete', isActive: true }, { id: 'cc2', code: '03-200', name: 'Formwork', isActive: true }]
const LINES = [line('bl1', 'cc1', 1000), line('bl2', 'cc2', 500)]

const draftHeader = (overrides = {}) => ({
  id: 'ba1', reason: 'Initial', status: 'draft', currency: 'AUD', entryCount: 2, total: 1500, version: null,
  approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
  revision: 1, createdAt: ts(10), createdBy: 'u_qs', updatedAt: ts(10), updatedBy: 'u_qs',
  ...overrides,
})
const entryOf = (l) => ({ lineId: l.id, costCodeId: l.costCodeId, costCodeName: l.costCodeName, budgeted: l.budgeted })
const snapshotOf = (ls, overrides = {}) => ({ id: 'ba1', entryCount: ls.length, total: ls.reduce((s, l) => s + l.budgeted, 0), currency: 'AUD', capturedAt: ts(10), capturedBy: 'u_qs', entries: ls.map(entryOf), ...overrides })

// A fake Firestore. `server` maps a query tag to the documents the "server"
// returns; `docs` is what transaction reads see (by ref id).
function fake({ server = {}, docs = {}, fail = null, serverFail = null } = {}) {
  const log = []
  const api = {
    log, writes: [], serverReads: 0,
    serverTimestamp: () => 'SERVER_TS',
    getDocsFromServer: async (q) => {
      api.serverReads += 1
      log.push(['server', q.tag])
      if (serverFail) { const e = new Error(serverFail); e.code = serverFail; throw e }
      const rows = server[q.tag] ?? []
      return { docs: rows.map(a => ({ id: a.id, data: () => { const rest = { ...a }; delete rest.id; return rest } })) }
    },
    runTransaction: async (_db, fn) => {
      log.push(['tx'])
      if (fail) { const e = new Error(fail); e.code = fail; throw e }
      const tx = {
        get: async (ref) => {
          log.push(['get', ref.id])
          const data = docs[ref.id] ?? null
          return { id: ref.id, exists: () => data !== null && data !== undefined, data: () => data }
        },
        update: (ref, data) => { log.push(['update', ref.id]); api.writes.push({ kind: 'update', id: ref.id, data }) },
        set: (ref, data) => { log.push(['set', ref.id]); api.writes.push({ kind: 'set', id: ref.id, data }) },
      }
      return fn(tx)
    },
  }
  return api
}
const ref = (id) => ({ id })
const LQ = { tag: 'lines' }
const CQ = { tag: 'codes' }
const base = { db: {}, budgetLinesQuery: LQ, costCodesQuery: CQ, uid: 'u_qs', currencyCode: 'AUD' }
const sdk = (fs) => ({ runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp, getDocsFromServer: fs.getDocsFromServer })

describe('readBudgetFromServer', () => {
  it('returns the server documents with ids; maps unreachable to OFFLINE and denied to PERMISSION', async () => {
    const fs = fake({ server: { lines: [line('x', 'cc1', 5)], codes } })
    const r = await readBudgetFromServer({ budgetLinesQuery: LQ, costCodesQuery: CQ, getDocsFromServer: fs.getDocsFromServer })
    expect(r.budgetLines[0]).toMatchObject({ id: 'x', budgeted: 5 })
    expect(r.costCodes).toHaveLength(2)
    expect(fs.log).toEqual([['server', 'lines'], ['server', 'codes']])
    const off = fake({ serverFail: 'unavailable' })
    await expect(readBudgetFromServer({ budgetLinesQuery: LQ, getDocsFromServer: off.getDocsFromServer })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.OFFLINE })
    const denied = fake({ serverFail: 'permission-denied' })
    await expect(readBudgetFromServer({ budgetLinesQuery: LQ, getDocsFromServer: denied.getDocsFromServer })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.PERMISSION })
  })
})

describe('runBudgetCapture', () => {
  it('reads the SERVER lines and cost codes first, then writes the header and the snapshot in ONE transaction, exactly once each', async () => {
    const fs = fake({ server: { lines: LINES, codes } })
    const result = await runBudgetCapture({ ...base, headerRef: ref('ba1'), snapshotRef: ref('s1'), input: { reason: ' Award ' }, ...sdk(fs) })
    expect(fs.serverReads).toBe(2)
    expect(fs.log).toEqual([['server', 'lines'], ['server', 'codes'], ['tx'], ['set', 'ba1'], ['set', 's1']])
    expect(result).toMatchObject({ id: 'ba1', total: 1500, counts: { total: 2, captured: 2, invalid: 0, inactive: 0, costCodes: 2 } })
    const [header, snapshot] = fs.writes
    expect(header.data).toEqual({
      reason: 'Award', status: 'draft', currency: 'AUD', entryCount: 2, total: 1500, version: null,
      approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
      revision: 1, createdAt: 'SERVER_TS', createdBy: 'u_qs', updatedAt: 'SERVER_TS', updatedBy: 'u_qs',
    })
    expect(snapshot.data).toEqual({
      entryCount: 2, total: 1500, currency: 'AUD', capturedAt: 'SERVER_TS', capturedBy: 'u_qs',
      entries: [entryOf(LINES[0]), entryOf(LINES[1])],
    })
  })

  it('refuses before any write: no uid, an unresolved currency, a blank reason, an invalid or duplicate line, an unknown cost code, an empty register, an oversized register', async () => {
    const ok = () => fake({ server: { lines: LINES, codes } })
    await expect(runBudgetCapture({ ...base, uid: null, headerRef: ref('h'), snapshotRef: ref('s'), input: { reason: 'r' }, ...sdk(ok()) })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.PERMISSION })
    await expect(runBudgetCapture({ ...base, currencyCode: '', headerRef: ref('h'), snapshotRef: ref('s'), input: { reason: 'r' }, ...sdk(ok()) })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.INVALID })
    const blank = ok()
    await expect(runBudgetCapture({ ...base, headerRef: ref('h'), snapshotRef: ref('s'), input: { reason: '  ' }, ...sdk(blank) })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.INVALID })
    expect(blank.serverReads).toBe(0)

    const invalid = fake({ server: { lines: [...LINES, line('bl3', 'cc1', -5)], codes } })
    const err = await runBudgetCapture({ ...base, headerRef: ref('h'), snapshotRef: ref('s'), input: { reason: 'r' }, ...sdk(invalid) }).catch(e => e)
    expect(err).toBeInstanceOf(BudgetApprovalWriteError)
    expect(err.kind).toBe(BUDGET_APPROVAL_ERROR.INVALID)
    expect(err.details.errors.map(e => e.lineId)).toEqual(['bl3'])
    expect(invalid.writes).toEqual([])

    const dup = fake({ server: { lines: [...LINES, line('bl1', 'cc2', 7)], codes } })
    await expect(runBudgetCapture({ ...base, headerRef: ref('h'), snapshotRef: ref('s'), input: { reason: 'r' }, ...sdk(dup) })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.INVALID })
    const unknown = fake({ server: { lines: [line('bl1', 'ccX', 1)], codes } })
    await expect(runBudgetCapture({ ...base, headerRef: ref('h'), snapshotRef: ref('s'), input: { reason: 'r' }, ...sdk(unknown) })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.INVALID })
    const empty = fake({ server: { lines: [], codes } })
    await expect(runBudgetCapture({ ...base, headerRef: ref('h'), snapshotRef: ref('s'), input: { reason: 'r' }, ...sdk(empty) })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.INVALID })
    const many = fake({ server: { lines: Array.from({ length: 2001 }, (_, i) => line(`l${i}`, 'cc1', 1)), codes } })
    await expect(runBudgetCapture({ ...base, headerRef: ref('h'), snapshotRef: ref('s'), input: { reason: 'r' }, ...sdk(many) })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.OVERSIZED })
    for (const f of [invalid, dup, unknown, empty, many]) expect(f.writes).toEqual([])
  })

  it('maps a failed transaction to the error kind and writes nothing on an offline server read', async () => {
    const off = fake({ serverFail: 'unavailable' })
    await expect(runBudgetCapture({ ...base, headerRef: ref('h'), snapshotRef: ref('s'), input: { reason: 'r' }, ...sdk(off) })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.OFFLINE })
    expect(off.writes).toEqual([])
    const denied = fake({ server: { lines: LINES, codes }, fail: 'permission-denied' })
    await expect(runBudgetCapture({ ...base, headerRef: ref('h'), snapshotRef: ref('s'), input: { reason: 'r' }, ...sdk(denied) })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.PERMISSION })
  })
})

describe('checkBudgetDrift', () => {
  it('reads the server and reports the drift; refuses an unusable snapshot before reading', async () => {
    const fs = fake({ server: { lines: [line('bl1', 'cc1', 1200), line('bl2', 'cc2', 500)] } })
    const d = await checkBudgetDrift({ budgetLinesQuery: LQ, getDocsFromServer: fs.getDocsFromServer, snapshot: snapshotOf(LINES) })
    expect(d.changed.map(x => x.lineId)).toEqual(['bl1'])
    expect(d.any).toBe(true)
    const bad = fake()
    await expect(checkBudgetDrift({ budgetLinesQuery: LQ, getDocsFromServer: bad.getDocsFromServer, snapshot: { entries: 'x' } })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.INVALID })
    expect(bad.serverReads).toBe(0)
  })
})

describe('runBudgetApprove', () => {
  const approveArgs = (fs, over = {}) => ({
    ...base, headerRef: ref('ba1'), snapshotRef: ref('s1'), pointerRef: ref('current'),
    seen: draftHeader(), snapshot: snapshotOf(LINES), acknowledgedDriftKey: '', seenVersionCount: 0,
    uid: 'u_pm', ...sdk(fs), ...over,
  })

  it('FIRST approval: drift read, then one transaction reading header, snapshot and pointer BEFORE writing; version 1; the pointer is created with original == active', async () => {
    const fs = fake({ server: { lines: LINES }, docs: { ba1: draftHeader(), s1: snapshotOf(LINES) } })
    const r = await runBudgetApprove(approveArgs(fs))
    expect(r).toEqual({ version: 1 })
    expect(fs.log).toEqual([['server', 'lines'], ['tx'], ['get', 'ba1'], ['get', 's1'], ['get', 'current'], ['update', 'ba1'], ['set', 'current']])
    const [header, pointer] = fs.writes
    expect(header.data).toEqual({ status: 'approved', version: 1, approvedAt: 'SERVER_TS', approvedBy: 'u_pm', revision: 2, updatedAt: 'SERVER_TS', updatedBy: 'u_pm' })
    expect(pointer).toMatchObject({ kind: 'set', id: 'current' })
    expect(pointer.data).toEqual({
      activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1, approvedAt: 'SERVER_TS', approvedBy: 'u_pm',
      createdAt: 'SERVER_TS', createdBy: 'u_pm', updatedAt: 'SERVER_TS', updatedBy: 'u_pm',
    })
  })

  it('LATER approval: the pointer is ADVANCED (+1, active id moves, original untouched) and the header takes the next version', async () => {
    const pointer = { activeApprovalId: 'ba0', originalApprovalId: 'ba0', versionCount: 1 }
    const fs = fake({ server: { lines: LINES }, docs: { ba1: draftHeader(), s1: snapshotOf(LINES), current: pointer } })
    const r = await runBudgetApprove(approveArgs(fs, { seenVersionCount: 1 }))
    expect(r).toEqual({ version: 2 })
    const [header, ptr] = fs.writes
    expect(header.data.version).toBe(2)
    expect(ptr).toMatchObject({ kind: 'update', id: 'current' })
    expect(ptr.data).toEqual({ activeApprovalId: 'ba1', versionCount: 2, approvedAt: 'SERVER_TS', approvedBy: 'u_pm', updatedAt: 'SERVER_TS', updatedBy: 'u_pm' })
    expect(ptr.data).not.toHaveProperty('originalApprovalId')
  })

  it('refuses drift the approver did not acknowledge (naming it), and approves once the SAME drift is acknowledged by key', async () => {
    const moved = [line('bl1', 'cc1', 1200), line('bl2', 'cc2', 500)]
    const fs = fake({ server: { lines: moved }, docs: { ba1: draftHeader(), s1: snapshotOf(LINES) } })
    const err = await runBudgetApprove(approveArgs(fs)).catch(e => e)
    expect(err.kind).toBe(BUDGET_APPROVAL_ERROR.DRIFT)
    expect(err.details.drift.changed[0].lineId).toBe('bl1')
    expect(fs.writes).toEqual([])
    const fs2 = fake({ server: { lines: moved }, docs: { ba1: draftHeader(), s1: snapshotOf(LINES) } })
    await expect(runBudgetApprove(approveArgs(fs2, { acknowledgedDriftKey: err.details.drift.key }))).resolves.toEqual({ version: 1 })
    // Acknowledging a DIFFERENT drift does not help.
    const fs3 = fake({ server: { lines: moved }, docs: { ba1: draftHeader(), s1: snapshotOf(LINES) } })
    await expect(runBudgetApprove(approveArgs(fs3, { acknowledgedDriftKey: 'c:bl1@999' }))).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.DRIFT })
  })

  it('SUPERSEDED: a pointer that moved since the reviewer opened the draft refuses the approval — never a silent next version', async () => {
    const fs = fake({ server: { lines: LINES }, docs: { ba1: draftHeader(), s1: snapshotOf(LINES), current: { activeApprovalId: 'ba0', originalApprovalId: 'ba0', versionCount: 1 } } })
    const err = await runBudgetApprove(approveArgs(fs, { seenVersionCount: 0 })).catch(e => e)
    expect(err.kind).toBe(BUDGET_APPROVAL_ERROR.SUPERSEDED)
    expect(err.message).toMatch(/Another budget version was approved/)
    expect(fs.writes).toEqual([])
    // The reverse: the reviewer saw version 1 but the pointer is gone / reset.
    const fs2 = fake({ server: { lines: LINES }, docs: { ba1: draftHeader(), s1: snapshotOf(LINES) } })
    await expect(runBudgetApprove(approveArgs(fs2, { seenVersionCount: 1 }))).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.SUPERSEDED })
  })

  it('a retry after a timed-out commit never creates a second version: the header is no longer a draft (INVALID) or the pointer advanced (SUPERSEDED)', async () => {
    const approvedAlready = draftHeader({ status: 'approved', version: 1, revision: 2, updatedAt: ts(20), updatedBy: 'u_pm' })
    const fs = fake({ server: { lines: LINES }, docs: { ba1: approvedAlready, s1: snapshotOf(LINES), current: { activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1 } } })
    // The reviewer's copy is the pre-commit draft → STALE by revision / stamps.
    const err = await runBudgetApprove(approveArgs(fs)).catch(e => e)
    expect([BUDGET_APPROVAL_ERROR.STALE, BUDGET_APPROVAL_ERROR.INVALID]).toContain(err.kind)
    expect(fs.writes).toEqual([])
  })

  it('refuses MISSING, STALE (revision OR stamps), a non-draft header, a missing or disagreeing snapshot, a malformed pointer, no uid, and a pending header', async () => {
    const docs = { ba1: draftHeader(), s1: snapshotOf(LINES) }
    const run = (over, d = docs) => runBudgetApprove(approveArgs(fake({ server: { lines: LINES }, docs: d }), over)).catch(e => e.kind)
    expect(await run({}, { s1: snapshotOf(LINES) })).toBe(BUDGET_APPROVAL_ERROR.MISSING)
    expect(await run({ seen: draftHeader({ revision: 5 }) })).toBe(BUDGET_APPROVAL_ERROR.STALE)
    expect(await run({ seen: draftHeader({ updatedBy: 'someone' }) })).toBe(BUDGET_APPROVAL_ERROR.STALE)
    expect(await run({}, { ba1: draftHeader({ status: 'withdrawn' }), s1: snapshotOf(LINES) })).toBe(BUDGET_APPROVAL_ERROR.INVALID)
    expect(await run({}, { ba1: draftHeader() })).toBe(BUDGET_APPROVAL_ERROR.INVALID)
    expect(await run({}, { ba1: draftHeader(), s1: snapshotOf(LINES, { total: 1 }) })).toBe(BUDGET_APPROVAL_ERROR.INVALID)
    expect(await run({}, { ba1: draftHeader(), s1: snapshotOf(LINES), current: { versionCount: 'x' } })).toBe(BUDGET_APPROVAL_ERROR.INVALID)
    expect(await run({ uid: null })).toBe(BUDGET_APPROVAL_ERROR.PERMISSION)
    expect(await run({ seen: draftHeader({ updatedAt: null }) })).toBe(BUDGET_APPROVAL_ERROR.PENDING)
  })

  it('maps transaction failures: aborted → STALE, permission-denied → PERMISSION, unavailable → OFFLINE', async () => {
    for (const [code, kind] of [['aborted', BUDGET_APPROVAL_ERROR.STALE], ['permission-denied', BUDGET_APPROVAL_ERROR.PERMISSION], ['unavailable', BUDGET_APPROVAL_ERROR.OFFLINE]]) {
      const fs = fake({ server: { lines: LINES }, fail: code })
      await expect(runBudgetApprove(approveArgs(fs))).rejects.toMatchObject({ kind })
    }
  })
})

describe('runBudgetWithdraw', () => {
  const args = (fs, over = {}) => ({ db: {}, headerRef: ref('ba1'), seen: draftHeader(), reason: ' typo ', uid: 'u_qs', ...sdk(fs), ...over })

  it('reads the header then writes the withdrawal stamps, reason and revision + 1', async () => {
    const fs = fake({ docs: { ba1: draftHeader() } })
    await expect(runBudgetWithdraw(args(fs))).resolves.toBe(2)
    expect(fs.log).toEqual([['tx'], ['get', 'ba1'], ['update', 'ba1']])
    expect(fs.writes[0].data).toEqual({ status: 'withdrawn', withdrawnAt: 'SERVER_TS', withdrawnBy: 'u_qs', withdrawReason: 'typo', revision: 2, updatedAt: 'SERVER_TS', updatedBy: 'u_qs' })
  })

  it('refuses a blank reason, a stale or approved header, and no uid — writing nothing', async () => {
    const fs = fake({ docs: { ba1: draftHeader() } })
    await expect(runBudgetWithdraw(args(fs, { reason: '  ' }))).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.INVALID })
    await expect(runBudgetWithdraw(args(fs, { seen: draftHeader({ revision: 9 }) }))).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.STALE })
    const approved = fake({ docs: { ba1: draftHeader({ status: 'approved', version: 1 }) } })
    await expect(runBudgetWithdraw(args(approved))).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.INVALID })
    await expect(runBudgetWithdraw(args(fs, { uid: null }))).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.PERMISSION })
    expect(fs.writes).toEqual([])
    expect(approved.writes).toEqual([])
  })
})

describe('messages, errors and structure', () => {
  it('every error kind has a message that says nothing was changed / written', () => {
    for (const [kind, msg] of Object.entries(BUDGET_APPROVAL_ERROR_MESSAGES)) {
      expect(msg, kind).toMatch(/Nothing was (changed|written|approved|created|saved)|nothing was written|Wait a moment/i)
    }
    expect(new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.DRIFT).message).toBe(BUDGET_APPROVAL_ERROR_MESSAGES.drift)
  })

  it('the action layer imports no Firebase and no React; the hooks inject the SDK and touch only the three approval documents', () => {
    const actions = read('lib/budgetApprovalActions.js')
    expect(actions).not.toMatch(/from 'firebase|from 'react/)
    expect(actions).not.toMatch(/budgetLines'\)|forecastLines|supplierInvoices|purchaseOrders|progressClaims|cashFlowLines|commercial/)
    expect(actions).toContain('runTransaction, serverTimestamp')
    const hook = read('hooks/useBudgetApprovals.jsx')
    expect(hook).toContain("'budgetApprovals'")
    expect(hook).toContain("'budgetApprovalSnapshots'")
    expect(hook).toContain("'approvedBudget', 'current'")
    expect(hook).not.toMatch(/addDoc|deleteDoc|writeBatch|collectionGroup|stageProjectCurrencyLock/)
    expect(hook).toContain('getDocsFromServer')
    // No write path on the working register from the approval layer.
    expect(hook).not.toMatch(/tx\.(set|update)\(/)
    for (const h of ['useApprovedBudgetPointer', 'useBudgetApprovalHeader', 'useBudgetApprovalSnapshot', 'useApprovedBudget']) {
      const src = read(`hooks/${h}.jsx`)
      expect(src, h).not.toMatch(/setDoc|updateDoc|addDoc|runTransaction|deleteDoc/)
    }
  })

  it('the composite hook opens no listener of its own and requests the original only when asked', () => {
    const src = read('hooks/useApprovedBudget.jsx')
    expect(src).not.toContain('onSnapshot')
    expect(src).toContain('const originalReadId = original && originalId && originalId !== activeId ? originalId : null')
    expect(src).toContain('originalRequested: original')
  })
})
