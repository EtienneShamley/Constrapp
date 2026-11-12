import { beforeAll, beforeEach, afterEach, describe, it, expect } from 'vitest'
import {
  admin, resetEmulators, makeHandlers, seedCompany, seedUser, req, clock, clientSignOutAll, COMPANY_A, COMPANY_B,
} from './_harness.js'
import { fakeBucket, seedObjects, drawingObject, tokensLeft } from '../../functions/test/_fakeBucket.js'

// ── ADR-75 (DC46-C, Stage 1) — periodic reconciliation, priority, recovery ───
//
// Same harness as team.fileLinks.test.js: the REAL Firestore emulator for
// every transaction, the fake bucket for Cloud Storage, and an INJECTED CLOCK.
// Nothing here sleeps or races the wall clock: where a test needs time to
// pass, the fake bucket's listing advances the clock by a fixed cost.
//
// What this does NOT prove: how long a real page takes, or anything about real
// Cloud Storage. Those are unmeasured (ADR-75, Stage 4).

const TOKEN = 'firebaseStorageDownloadTokens'
const H = 60 * 60 * 1000
const INTERVAL = 24 * H
const S = 1000

let A, R, now, bucket, log

const recorder = () => {
  const lines = []
  const push = (level) => (msg, fields) => lines.push({ level, msg, fields })
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
}

const stateOf = async (c) => (await R.stateRef(A.db, c).get()).data() ?? null
const markerOf = async (c) => (await R.markerRef(A.db, c).get()).data() ?? null
const cursorOf = async () => (await R.cursorRef(A.db).get()).data() ?? null
const audits = async (c, type) =>
  (await A.db.collection('companies').doc(c).collection('auditEvents').get()).docs.map(d => d.data()).filter(e => !type || e.type === type)
const deps = (db = A.db) => ({ db, bucket, now, log })
const noSleep = { sleep: async () => {} }
const plan = (opts = {}, db = A.db) => R.planReconciliation(deps(db), { intervalMs: INTERVAL, ...opts })
const runWorker = (opts = {}, db = A.db) => {
  const { sweepOptions = {}, ...rest } = opts
  return R.runRevocationWorker(deps(db), { owner: `worker:test:${now().getTime()}`, sweepOptions: { ...noSleep, ...sweepOptions }, ...rest })
}
const sweep = (c, opts = {}) => {
  const { sweepOptions = {}, owner = 'worker:test', ...rest } = opts
  return R.processCompany(deps(), c, { owner, sweepOptions: { ...noSleep, ...sweepOptions }, ...rest })
}
const ts = (ms) => A.Timestamp.fromMillis(ms)

// A company whose last successful sweep started `agoMs` ago.
const seedSwept = (c, agoMs, extra = {}) => R.stateRef(A.db, c).set({
  requestSeq: 1, completedSeq: 1, completedPassStartedAt: ts(now().getTime() - agoMs), completedAt: ts(now().getTime() - agoMs + 1000), ...extra,
})

const seedCompanies = async (ids) => {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = A.db.batch()
    for (const id of ids.slice(i, i + 400)) batch.set(A.db.collection('companies').doc(id), { name: id })
    await batch.commit()
  }
}

// Every listing costs `ms` of injected time — the stand-in for a slow page.
const listingCosts = (ms) => {
  const real = bucket.getFiles.bind(bucket)
  bucket.getFiles = async (q) => { now.advance(ms); return real(q) }
}

// The Admin Firestore with selected calls observed or broken.
const spyDb = ({ onCollection = () => {}, runTransaction = null, companies = null } = {}) => new Proxy(A.db, {
  get(target, prop) {
    if (prop === 'collection') {
      return (name) => {
        onCollection(name)
        const col = target.collection(name)
        return name === 'companies' && companies ? companies(col) : col
      }
    }
    if (prop === 'runTransaction' && runTransaction) return (fn, o) => runTransaction(() => target.runTransaction(fn, o))
    const v = target[prop]
    return typeof v === 'function' ? v.bind(target) : v
  },
})

beforeAll(async () => {
  A = await admin()
  R = await import('../../functions/src/lib/fileLinkRevocation.js')
})

beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  now = clock('2026-11-12T10:00:00Z')
  log = recorder()
  bucket = fakeBucket({})
})

afterEach(async () => { await clientSignOutAll() })

// ── A. Disabled interval ─────────────────────────────────────────────────────
describe('A. interval 0 — reconciliation is off', () => {
  it('never reads the cursor, never enumerates companies, never writes a periodic request — however often the worker runs', async () => {
    await seedCompanies(['c1', 'c2', 'c3'])
    await seedSwept('c1', 100 * INTERVAL)
    bucket = fakeBucket({ ...seedObjects('c1', 3), ...seedObjects('c2', 3) })
    const touched = []
    let enumerations = 0
    const db = spyDb({
      onCollection: (name) => touched.push(name),
      companies: (col) => new Proxy(col, { get(t, p) { if (p === 'orderBy') enumerations += 1; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v } }),
    })
    for (let i = 0; i < 5; i += 1) {
      expect(await runWorker({ reconcileIntervalMs: 0 }, db)).toEqual([])
      now.advance(2 * H)
    }
    expect(touched).not.toContain(R.CURSOR_COLLECTION)
    expect(enumerations).toBe(0)
    expect(await cursorOf()).toBe(null)
    expect((await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size).toBe(0)
    expect(bucket.calls.list).toHaveLength(0)
    expect(tokensLeft(bucket)).toBe(6)
    expect((await stateOf('c1')).requestSeq).toBe(1)
    expect(await stateOf('c2')).toBe(null)
  })

  it('urgent revocation still runs exactly as before', async () => {
    await seedCompanies(['c1'])
    bucket = fakeBucket(seedObjects('c1', 3))
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    const [r] = await runWorker({ reconcileIntervalMs: 0 })
    expect(r).toMatchObject({ companyId: 'c1', action: 'complete', seq: 1, scanned: 3, removed: 3, failed: 0 })
    expect(await cursorOf()).toBe(null)
    expect(await audits('c1', 'file_links.revoked')).toHaveLength(1)
    expect(await audits('c1', 'file_links.reconciled')).toHaveLength(0)
    expect(await markerOf('c1')).toBe(null)
  })
})

// ── Configuration ────────────────────────────────────────────────────────────
describe('the interval setting, as the scheduled function reads it', () => {
  const scheduled = (raw) => R.runScheduledWorker(deps(), { owner: `worker:test:${now().getTime()}`, reconcileIntervalRaw: raw, sweepOptions: noSleep })
  beforeEach(async () => {
    await seedCompanies(['c1', 'c2'])
    bucket = fakeBucket({ ...seedObjects('c1', 2), ...seedObjects('c2', 2) })
  })

  it('absent and "0": off, quietly and validly — no cursor, no periodic request', async () => {
    for (const raw of [undefined, '0']) {
      expect(await scheduled(raw)).toEqual([])
      expect(await cursorOf()).toBe(null)
      expect((await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size).toBe(0)
    }
    expect(log.lines.filter(l => l.level === 'error')).toHaveLength(0)
  })

  it('a valid nonzero value switches planning on', async () => {
    await scheduled('24')
    expect(await cursorOf()).toMatchObject({ passSeq: 1, intervalHours: 24, lastPass: { examined: 2, requested: 2 } })
  })

  it('an INVALID value is never silently off: the urgent work is done, reconciliation stays off, and the run FAILS naming the setting', async () => {
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    for (const raw of ['24h', '', '1.5', '999', 'on']) {
      await expect(scheduled(raw), raw).rejects.toThrow(/FILE_LINK_RECONCILE_INTERVAL_HOURS .* Periodic reconciliation is NOT running/)
    }
    await expect(scheduled('24h')).rejects.toBeInstanceOf(R.InvalidReconcileInterval)
    // The revocation that was queued was completed by the first failing run.
    expect(await stateOf('c1')).toMatchObject({ requestSeq: 1, completedSeq: 1 })
    expect(tokensLeft(bucket, 'companies/c1/')).toBe(0)
    expect(await audits('c1', 'file_links.revoked')).toHaveLength(1)
    // Nothing periodic happened.
    expect(await cursorOf()).toBe(null)
    expect(tokensLeft(bucket, 'companies/c2/')).toBe(2)
    expect(await stateOf('c2')).toBe(null)
    expect(log.lines.filter(l => l.level === 'error' && l.msg.includes('FILE_LINK_RECONCILE_INTERVAL_HOURS')).length).toBe(6)
  })
})

// ── B. Eligibility ───────────────────────────────────────────────────────────
describe('B. which companies are due', () => {
  it('requests a sweep for a company never swept and for one last swept an interval ago — not for one swept more recently — and writes no audit event', async () => {
    await seedCompanies(['due', 'fresh', 'never'])
    await seedSwept('due', INTERVAL)
    await seedSwept('fresh', INTERVAL - 1)
    const r = await plan()
    expect(r).toMatchObject({ action: 'finished', examined: 3, requested: 2, overdue: 0 })

    expect(await stateOf('due')).toMatchObject({ requestSeq: 2, completedSeq: 1, requestReason: 'periodic', requestPriority: 'periodic', requestedBy: 'worker' })
    expect(await stateOf('never')).toMatchObject({ requestSeq: 1, completedSeq: 0, requestPriority: 'periodic' })
    expect(await markerOf('due')).toMatchObject({ companyId: 'due', requestSeq: 2, priority: 'periodic' })
    expect((await stateOf('fresh')).requestSeq).toBe(1)
    expect(await markerOf('fresh')).toBe(null)
    for (const c of ['due', 'fresh', 'never']) expect(await audits(c)).toHaveLength(0)
  })

  it('a periodic sweep that finds nothing writes no audit event; its success moves the clock to ITS START, and the company is then not due', async () => {
    await seedCompanies(['c1'])
    await seedSwept('c1', INTERVAL + H)
    bucket = fakeBucket(seedObjects('c1', 4, { tokenEvery: 0 }))
    await plan()
    now.advance(60 * S)
    const startedAt = now().getTime()
    listingCosts(7 * S)
    const [r] = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(r).toMatchObject({ companyId: 'c1', action: 'complete', seq: 2, scanned: 4, removed: 0 })
    const st = await stateOf('c1')
    expect(st.completedSeq).toBe(2)
    expect(st.completedPassStartedAt.toMillis()).toBe(startedAt)
    expect(st.completedAt.toMillis()).toBe(startedAt + 7 * S)
    expect(st.lastPass).toMatchObject({ complete: true, priority: 'periodic', removed: 0 })
    expect(await audits('c1')).toHaveLength(0)
    expect(await markerOf('c1')).toBe(null)

    now.advance(INTERVAL - 8 * S)          // one second short of an interval since the START
    expect(R.reconciliationDue(await stateOf('c1'), now().getTime(), INTERVAL)).toBe(false)
    now.advance(1 * S)
    expect(R.reconciliationDue(await stateOf('c1'), now().getTime(), INTERVAL)).toBe(true)
  })

  it('a periodic sweep that REMOVES a token is audited as file_links.reconciled — never as file_links.revoked', async () => {
    await seedCompanies(['c1'])
    bucket = fakeBucket(seedObjects('c1', 4, { tokenEvery: 2 }))
    await plan()
    const [r] = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(r).toMatchObject({ action: 'complete', scanned: 4, removed: 2 })
    expect(tokensLeft(bucket)).toBe(0)
    const [event] = await audits('c1', 'file_links.reconciled')
    expect(event).toMatchObject({ source: 'worker', after: { seq: 1, scanned: 4, removed: 2, failed: 0 } })
    expect(await audits('c1', 'file_links.revoked')).toHaveLength(0)
    expect(await audits('c1', 'file_links.revocation_requested')).toHaveLength(0)
  })

  it('an INCOMPLETE sweep does not reset eligibility, and a company with outstanding or backing-off work is not given a second request', async () => {
    await seedCompanies(['c1'])
    const lastGood = now().getTime() - 30 * H
    await seedSwept('c1', 30 * H)
    bucket = fakeBucket(seedObjects('c1', 3))
    await plan()
    bucket.hooks.patchError = (name) => (name === drawingObject('c1', 2) ? 403 : null)
    now.advance(60 * S)
    const [r] = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(r).toMatchObject({ action: 'incomplete', removed: 2, failed: 1, consecutiveIncomplete: 1 })

    let st = await stateOf('c1')
    expect(st.completedPassStartedAt.toMillis()).toBe(lastGood)      // NOT moved
    expect(st.completedSeq).toBe(1)
    expect(st.lastPass).toMatchObject({ complete: false, failed: 1 })
    const backoff = st.nextAttemptAt.toMillis()
    expect(await audits('c1', 'file_links.revocation_incomplete')).toHaveLength(1)
    expect(await audits('c1', 'file_links.reconciled')).toHaveLength(0)

    // Still outstanding: planning passes over it and leaves the backoff alone.
    now.advance(H)
    const again = await plan()
    expect(again).toMatchObject({ action: 'finished', examined: 1, requested: 0 })
    st = await stateOf('c1')
    expect(st.requestSeq).toBe(2)
    expect(st.nextAttemptAt.toMillis()).toBe(backoff)

    // Fixed: the retry completes, and only now does the clock move.
    bucket.hooks.patchError = null
    const retryAt = now().getTime()
    const [ok] = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(ok).toMatchObject({ action: 'complete', removed: 1, failed: 0 })
    st = await stateOf('c1')
    expect(st.completedPassStartedAt.toMillis()).toBe(retryAt)
    expect(await audits('c1', 'file_links.reconciled')).toHaveLength(1)
  })

  it('a company still inside its retry backoff takes no turn and keeps its place in the queue', async () => {
    await seedCompanies(['c1'])
    bucket = fakeBucket(seedObjects('c1', 2))
    await plan()
    bucket.hooks.patchError = () => 403
    await runWorker({ reconcileIntervalMs: INTERVAL })
    const before = await markerOf('c1')
    const lists = bucket.calls.list.length
    now.advance(10 * S)
    const [r] = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(r).toEqual({ companyId: 'c1', action: 'backoff' })
    expect(bucket.calls.list).toHaveLength(lists)
    expect(await markerOf('c1')).toEqual(before)
  })
})

// ── C. The cursor ────────────────────────────────────────────────────────────
describe('C. the planning cursor', () => {
  const ids = (n, prefix = 'co') => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(4, '0')}`)

  it('250 companies: three invocations, never more than 100 each, every company examined exactly once', async () => {
    const all = ids(250)
    await seedCompanies(all)
    expect(await cursorOf()).toBe(null)                               // a MISSING cursor: a pass simply opens

    const r1 = await plan()
    expect(r1).toMatchObject({ action: 'advanced', passSeq: 1, batch: 100, examined: 100, requested: 100 })
    expect(await cursorOf()).toMatchObject({ passSeq: 1, cursor: 'co0100', examined: 100, requested: 100 })
    const r2 = await plan()
    expect(r2).toMatchObject({ action: 'advanced', batch: 100, examined: 200, requested: 200 })
    const r3 = await plan()
    expect(r3).toMatchObject({ action: 'finished', batch: 50, examined: 250, requested: 250 })

    const cur = await cursorOf()
    expect(cur).toMatchObject({ passSeq: 1, passStartedAt: null, cursor: null, lastPass: { seq: 1, examined: 250, requested: 250, overdue: 0 } })
    expect(cur.nextPassAt.toMillis()).toBe(cur.lastPass.startedAt.toMillis() + R.PLAN_EVERY_MS)

    const markers = (await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).docs
    expect(markers.map(d => d.ref.parent.parent.id).sort()).toEqual(all)
    for (const id of ['co0001', 'co0100', 'co0101', 'co0250']) expect((await stateOf(id)).requestSeq).toBe(1)
    expect(log.lines.filter(l => l.msg === 'file-links: reconciliation plan complete')).toHaveLength(1)

    // Nothing more until the next pass is due; then it starts again from the first company.
    expect(await plan()).toEqual({ action: 'idle', passSeq: 1 })
    now.advance(R.PLAN_EVERY_MS)
    expect(await plan()).toMatchObject({ action: 'advanced', passSeq: 2, examined: 100, requested: 0 })
  })

  it('the time budget stops a batch early but always examines at least one company, so a pass cannot stall', async () => {
    await seedCompanies(ids(4))
    const seen = []
    for (let i = 0; i < 4; i += 1) {
      const r = await plan({ deadlineMs: now().getTime() })           // already expired
      seen.push([r.action, r.batch, r.examined])
    }
    // One company per invocation; the last one is a short page, fully examined, which ends the pass.
    expect(seen).toEqual([['advanced', 1, 1], ['advanced', 1, 2], ['advanced', 1, 3], ['finished', 1, 4]])
    expect(await plan({ deadlineMs: now().getTime() })).toEqual({ action: 'idle', passSeq: 1 })
    expect((await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size).toBe(4)
  })

  it('a batch that fails part-way leaves the cursor where it was; the retry re-examines it and writes no second request', async () => {
    await seedCompanies(ids(5))
    let calls = 0
    const failing = spyDb({ runTransaction: (run) => { calls += 1; if (calls === 3) throw new Error('injected: firestore unavailable'); return run() } })
    await expect(plan({}, failing)).rejects.toThrow(/injected/)
    expect(await cursorOf()).toBe(null)                               // nothing recorded
    expect((await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size).toBe(2)

    const r = await plan()
    expect(r).toMatchObject({ action: 'finished', examined: 5, requested: 3 })
    for (const id of ids(5)) expect((await stateOf(id)).requestSeq, id).toBe(1)
    expect((await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size).toBe(5)
  })

  it('companies added and removed during a pass: none is skipped for good, and the walk is never thrown off', async () => {
    await seedCompanies(['c1', 'c2', 'c3', 'c4', 'c5'])
    expect(await plan({ batchSize: 2 })).toMatchObject({ action: 'advanced', examined: 2 })
    expect((await cursorOf()).cursor).toBe('c2')

    await seedCompanies(['c0', 'c2x'])                                // one behind the cursor, one ahead
    await A.db.collection('companies').doc('c3').delete()             // one removed ahead
    await A.db.collection('companies').doc('c2').delete()             // the cursor's own company removed

    expect(await plan({ batchSize: 2 })).toMatchObject({ action: 'advanced', examined: 4 })
    expect((await cursorOf()).cursor).toBe('c4')
    expect(await plan({ batchSize: 2 })).toMatchObject({ action: 'finished', examined: 5, requested: 5 })

    expect(await markerOf('c2x')).not.toBe(null)                      // ahead: same pass
    expect(await markerOf('c0')).toBe(null)                           // behind: not this pass…
    expect(await markerOf('c3')).toBe(null)                           // removed before it was reached

    now.advance(R.PLAN_EVERY_MS)
    expect(await plan({ batchSize: 100 })).toMatchObject({ action: 'finished', requested: 1 })
    expect(await markerOf('c0')).not.toBe(null)                       // …but the next one
  })

  it('a CORRUPTED cursor is logged and replaced by a fresh pass from the first company — every company is still examined', async () => {
    const all = ids(3)
    const shapes = [
      { passSeq: 'three' },
      { passSeq: 7, passStartedAt: 'yesterday', cursor: 'co0002' },
      { passSeq: 7, passStartedAt: ts(now().getTime()), cursor: 'a/b' },
      { passSeq: 7, passStartedAt: null, cursor: 'co0002' },
      { passSeq: 7, passStartedAt: ts(now().getTime()), cursor: 'co0002', examined: -4 },
    ]
    for (const [i, shape] of shapes.entries()) {
      await resetEmulators()
      log = recorder()
      await seedCompanies(all)
      await R.cursorRef(A.db).set(shape)
      const r = await plan()
      expect(r, `shape ${i}`).toMatchObject({ action: 'finished', restarted: true, examined: 3, requested: 3, passSeq: typeof shape.passSeq === 'number' ? 8 : 1 })
      expect(log.lines.some(l => l.level === 'error' && l.msg.includes('cursor unreadable'))).toBe(true)
      expect((await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).docs.map(d => d.ref.parent.parent.id).sort()).toEqual(all)
      expect(R.readCursor(await cursorOf())).not.toBe(null)
    }
  })

  it('a valid open pass resumes strictly after its cursor', async () => {
    await seedCompanies(ids(4))
    await R.cursorRef(A.db).set({ passSeq: 3, passStartedAt: ts(now().getTime() - 5 * S), cursor: 'co0002', examined: 2, requested: 0, overdue: 0, nextPassAt: ts(0) })
    expect(await plan()).toMatchObject({ action: 'finished', passSeq: 3, batch: 2, examined: 4, requested: 2 })
    expect(await markerOf('co0001')).toBe(null)
    expect(await markerOf('co0003')).not.toBe(null)
    expect((await cursorOf()).lastPass.startedAt.toMillis()).toBe(now().getTime() - 5 * S)
  })

  it('two planners at once: each company gets exactly one request and exactly one of them records the batch', async () => {
    await seedCompanies(ids(6))
    const results = await Promise.all([plan(), plan()])
    expect(results.map(r => r.action).sort()).toEqual(['conflict', 'finished'])
    for (const id of ids(6)) expect((await stateOf(id)).requestSeq, id).toBe(1)
    expect((await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size).toBe(6)
    expect(await cursorOf()).toMatchObject({ passSeq: 1, lastPass: { examined: 6 } })
  })

  it('a planner whose cursor was changed underneath it records nothing', async () => {
    await seedCompanies(ids(2))
    let moved = false
    const racing = spyDb({ runTransaction: async (run) => {
      // Just before the SAVE (the third transaction: two requests, then the save).
      const out = run
      if (!moved && (await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size === 2) {
        moved = true
        await R.cursorRef(A.db).set({ passSeq: 9, passStartedAt: null, cursor: null, nextPassAt: ts(now().getTime() + H) })
      }
      return out()
    } })
    expect(await plan({}, racing)).toMatchObject({ action: 'conflict' })
    expect(await cursorOf()).toMatchObject({ passSeq: 9 })
  })

  it('an invalid company id is counted and never swept', async () => {
    await seedCompanies(['good', 'bad id!'])
    expect(await plan()).toMatchObject({ action: 'finished', examined: 2, requested: 1, invalid: 1 })
    expect((await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size).toBe(1)
  })

  it('a planning failure never stops urgent revocation, and the worker returns normally', async () => {
    await seedCompanies(['c1', 'c2'])
    bucket = fakeBucket(seedObjects('c1', 2))
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    const broken = spyDb({ companies: (col) => new Proxy(col, { get(t, p) { if (p === 'orderBy') return () => { throw new Error('injected: enumeration failed') }; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v } }) })
    const results = await runWorker({ reconcileIntervalMs: INTERVAL }, broken)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ companyId: 'c1', action: 'complete', removed: 2 })
    expect(results.plan).toEqual({ action: 'error' })
    expect(log.lines.some(l => l.level === 'error' && l.msg.includes('planning failed'))).toBe(true)
    expect(await cursorOf()).toBe(null)
  })
})

// ── D. Priority and fairness ─────────────────────────────────────────────────
describe('D. urgent first, routine bounded, nobody starved', () => {
  it('an urgent company is swept before every queued periodic company', async () => {
    await seedCompanies(['a', 'b', 'z'])
    bucket = fakeBucket({ ...seedObjects('a', 1), ...seedObjects('b', 1), ...seedObjects('z', 1) })
    await seedSwept('z', H)                                           // not due: no periodic request for z
    await plan()
    now.advance(30 * S)
    await R.requestRevocation({ db: A.db, now }, { companyId: 'z' })   // newest request of all
    const results = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(results.map(r => r.companyId)).toEqual(['z', 'a', 'b'])
    expect(results.every(r => r.action === 'complete')).toBe(true)
    expect(await audits('z', 'file_links.revoked')).toHaveLength(1)
    expect(await audits('a', 'file_links.reconciled')).toHaveLength(1)
    expect(log.lines.find(l => l.msg === 'file-links: worker run').fields).toMatchObject({ urgent: 1, periodic: 2, actions: { complete: 3 } })
  })

  it('routine work is bounded: a run with only periodic work ends within 45 s plus one page, and the unserved company goes first next time', async () => {
    await seedCompanies(['p1', 'p2', 'p3'])
    bucket = fakeBucket({ ...seedObjects('p1', 10), ...seedObjects('p2', 10), ...seedObjects('p3', 10) })
    await plan()
    now.advance(60 * S)
    listingCosts(10 * S)
    const t0 = now().getTime()
    const first = await runWorker({ reconcileIntervalMs: INTERVAL, sweepOptions: { pageSize: 1 } })
    expect(now().getTime() - t0).toBeLessThanOrEqual(R.ROUTINE_BUDGET_MS + 10 * S)
    expect(first).toEqual([{ companyId: 'p1', action: 'yielded' }, { companyId: 'p2', action: 'yielded' }, { companyId: 'p3', action: 'deferred' }])
    expect(bucket.calls.list).toHaveLength(5)                          // p1: 3 pages in its 30 s slice; p2: 2 before the cap
    expect((await stateOf('p1')).pass).toMatchObject({ pages: 3, yields: 1, priority: 'periodic' })

    // Least recently served first: p3 has not had a turn, so it leads.
    now.advance(60 * S)
    const second = await runWorker({ reconcileIntervalMs: INTERVAL, sweepOptions: { pageSize: 1 } })
    expect(second[0].companyId).toBe('p3')
  })

  it('a large company yields at a page boundary to a waiting one, then resumes from its checkpoint — and yielding is never a failure', async () => {
    await seedCompanies(['big', 'small'])
    bucket = fakeBucket({ ...seedObjects('big', 10), ...seedObjects('small', 1) })
    await R.requestRevocation({ db: A.db, now }, { companyId: 'big' })
    now.advance(1 * S)
    await R.requestRevocation({ db: A.db, now }, { companyId: 'small' })
    listingCosts(20 * S)
    const results = await runWorker({ sweepOptions: { pageSize: 1 } })
    expect(results.map(r => [r.companyId, r.action])).toEqual([['big', 'yielded'], ['small', 'complete'], ['big', 'complete']])

    // big: three pages in its 60 s slice, then — after small — page four from the saved position.
    const bigLists = bucket.calls.list.filter(q => q.prefix === 'companies/big/').map(q => q.pageToken ?? null)
    expect(bigLists.slice(0, 5)).toEqual([null, drawingObject('big', 1), drawingObject('big', 2), drawingObject('big', 3), drawingObject('big', 4)])
    expect(bigLists).toHaveLength(10)                                  // no page listed twice
    expect(tokensLeft(bucket)).toBe(0)
    const st = await stateOf('big')
    expect(st).toMatchObject({ completedSeq: 1, consecutiveIncomplete: 0, lastPass: { complete: true, pages: 10, removed: 10 } })
    expect(await audits('big', 'file_links.revocation_incomplete')).toHaveLength(0)
  })

  it('ANY number of deliberate yields leaves a sweep healthy: no error count, no backoff, no incomplete report', async () => {
    await seedCompanies(['c1'])
    bucket = fakeBucket(seedObjects('c1', 3))
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    for (let i = 0; i < R.MAX_INTERRUPTIONS + 3; i += 1) {
      expect(await sweep('c1', { deadlineMs: now().getTime() })).toEqual({ companyId: 'c1', action: 'yielded' })
      now.advance(60 * S)
    }
    const st = await stateOf('c1')
    expect(st.pass).toMatchObject({ seq: 1, yields: R.MAX_INTERRUPTIONS + 3 })
    expect(st.pass.errors ?? 0).toBe(0)
    expect(st.consecutiveIncomplete ?? 0).toBe(0)
    expect(st.nextAttemptAt).toBeUndefined()
    expect(st.lastPass).toBeUndefined()
    expect(await audits('c1', 'file_links.revocation_incomplete')).toHaveLength(0)
    expect(await sweep('c1')).toMatchObject({ action: 'complete', removed: 3 })
  })

  it('a lone queued company is not sliced: it runs to the end of the phase as in ADR-74', async () => {
    await seedCompanies(['c1'])
    bucket = fakeBucket(seedObjects('c1', 8))
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    listingCosts(20 * S)
    const results = await runWorker({ sweepOptions: { pageSize: 1 } })   // 160 s of pages, well past a 60 s slice
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ action: 'complete', pages: 8 })
    expect((await stateOf('c1')).lastPass.pages).toBe(8)
  })

  it('urgent work that never runs out still leaves routine work its share: planning advances and a periodic company is swept in the same run', async () => {
    await seedCompanies(['big', 'p1'])
    bucket = fakeBucket({ ...seedObjects('big', 40), ...seedObjects('p1', 1) })
    await R.requestPeriodicSweep({ db: A.db, now }, 'p1', INTERVAL)
    await R.requestRevocation({ db: A.db, now }, { companyId: 'big' })
    listingCosts(20 * S)
    const t0 = now().getTime()
    const results = await runWorker({ reconcileIntervalMs: INTERVAL, sweepOptions: { pageSize: 1 } })
    expect(results.map(r => [r.companyId, r.action])).toEqual([['big', 'yielded'], ['p1', 'complete']])
    expect(now().getTime() - t0).toBeLessThanOrEqual(R.HARD_STOP_MS)
    // Urgent stopped at 195 s (ten 20 s pages), not 240 s, because routine work was waiting.
    expect((await stateOf('big')).pass.pages).toBe(10)
    expect(results.plan).toMatchObject({ action: 'finished', examined: 2 })
    expect(await cursorOf()).toMatchObject({ passSeq: 1, lastPass: { examined: 2 } })
    expect(tokensLeft(bucket, 'companies/p1/')).toBe(0)
  })

  it('no page is started after the hard stop: if urgent work overran, routine work is skipped for that run and says so', async () => {
    await seedCompanies(['big', 'p1'])
    bucket = fakeBucket({ ...seedObjects('big', 5), ...seedObjects('p1', 1) })
    await R.requestPeriodicSweep({ db: A.db, now }, 'p1', INTERVAL)
    await R.requestRevocation({ db: A.db, now }, { companyId: 'big' })
    listingCosts(130 * S)
    const results = await runWorker({ reconcileIntervalMs: INTERVAL, sweepOptions: { pageSize: 1 } })
    expect(results.map(r => [r.companyId, r.action])).toEqual([['big', 'yielded'], ['p1', 'deferred']])
    expect(bucket.calls.list.filter(q => q.prefix === 'companies/p1/')).toHaveLength(0)
    expect(await cursorOf()).toBe(null)
    expect(log.lines.some(l => l.level === 'warn' && l.msg.includes('routine work skipped'))).toBe(true)
    expect(await markerOf('p1')).not.toBe(null)                        // still queued for next time
  })

  it('with several long urgent sweeps nobody is served twice while another is still waiting', async () => {
    const all = ['u1', 'u2', 'u3', 'u4', 'u5']
    await seedCompanies(all)
    bucket = fakeBucket(Object.assign({}, ...all.map(c => seedObjects(c, 30))))
    for (const c of all) { await R.requestRevocation({ db: A.db, now }, { companyId: c }); now.advance(1 * S) }
    listingCosts(20 * S)
    const served = []
    for (let run = 0; run < 2; run += 1) {
      const results = await runWorker({ sweepOptions: { pageSize: 1 } })
      served.push(...results.filter(r => r.action === 'yielded').map(r => r.companyId))
      now.advance(20 * S)
    }
    // Four 60 s slices fit one 240 s run: u1–u4, then u5 leads the next run.
    expect(served.slice(0, 5)).toEqual(all)
    expect(new Set(served.slice(0, 5)).size).toBe(5)
  })
})

describe('D. fairness under killed runs, sustained arrivals and a changing queue', () => {
  it('a turn is stamped when it STARTS, so a company whose run is killed mid-page does not stay at the front of the queue', async () => {
    await seedCompanies(['hang', 'waiting'])
    bucket = fakeBucket({ ...seedObjects('hang', 3), ...seedObjects('waiting', 2) })
    await R.requestRevocation({ db: A.db, now }, { companyId: 'hang' })      // oldest: leads the queue
    now.advance(5 * S)
    await R.requestRevocation({ db: A.db, now }, { companyId: 'waiting' })   // queued behind it, never yet served
    now.advance(5 * S)

    // Run 1 is KILLED inside hang's first listing: the lease stays with the
    // dead run and none of the worker's own bookkeeping happens. `waiting` is
    // never reached.
    const turnStart = now().getTime()
    let stampedBeforeListing = null
    const real = bucket.getFiles.bind(bucket)
    bucket.getFiles = async (q) => {
      stampedBeforeListing = (await markerOf('hang')).servedAt?.toMillis() ?? null
      await R.stateRef(A.db, 'hang').update({ lease: { owner: 'worker:killed', expiresAt: ts(now().getTime() + R.LEASE_MS) } })
      return real(q)
    }
    expect(await sweep('hang', { owner: 'worker:run1', sweepOptions: { pageSize: 1 } })).toEqual({ companyId: 'hang', action: 'lease-lost' })
    bucket.getFiles = real
    expect(stampedBeforeListing).toBe(turnStart)                             // stamped BEFORE any Storage call
    expect((await stateOf('hang')).pass.errors ?? 0).toBe(0)                 // the dead run recorded nothing itself

    // Run 2: the company that has been waiting goes FIRST. Without the stamp
    // hang (older request) would lead again, every run, for as long as it hung.
    now.advance(60 * S)
    const second = await runWorker({ sweepOptions: { pageSize: 1 } })
    expect(second.map(r => [r.companyId, r.action])).toEqual([['waiting', 'complete'], ['hang', 'busy']])
    expect((await stateOf('hang')).completedSeq).toBe(0)                     // nothing falsely completed
    expect(await markerOf('hang')).not.toBe(null)                            // nothing discarded

    // Once the dead lease expires hang resumes from its checkpoint, the killed
    // run is counted as one failure, and the sweep finishes.
    now.advance(R.LEASE_MS)
    const third = await runWorker({ sweepOptions: { pageSize: 1 } })
    expect(third).toHaveLength(1)
    // (The killed run had already cleaned its first page before it died; the
    // page is listed again, harmlessly, and only the rest needs removing.)
    expect(third[0]).toMatchObject({ companyId: 'hang', action: 'complete', scanned: 3, removed: 2, failed: 0 })
    expect(tokensLeft(bucket)).toBe(0)
    expect((await stateOf('hang')).completedSeq).toBe(1)
  })

  it('sustained urgent arrivals do not starve a company that is already waiting, and the newcomers are served too', async () => {
    await seedCompanies(['old', 'n1', 'n2', 'n3'])
    bucket = fakeBucket({ ...seedObjects('old', 40), ...seedObjects('n1', 1), ...seedObjects('n2', 1), ...seedObjects('n3', 1) })
    await R.requestRevocation({ db: A.db, now }, { companyId: 'old' })
    listingCosts(20 * S)
    let lastPages = 0
    for (const newcomer of ['n1', 'n2', 'n3']) {
      now.advance(5 * S)
      await R.requestRevocation({ db: A.db, now }, { companyId: newcomer })
      now.advance(5 * S)
      const results = await runWorker({ sweepOptions: { pageSize: 1 } })
      // The waiting company goes first every time; the newcomer is served in the same run.
      expect(results[0]).toEqual({ companyId: 'old', action: 'yielded' })
      expect(results[1]).toMatchObject({ companyId: newcomer, action: 'complete' })
      const pages = (await stateOf('old')).pass.pages
      expect(pages).toBeGreaterThan(lastPages)                               // and it makes progress every run
      lastPages = pages
    }
    const oldLists = bucket.calls.list.filter(q => q.prefix === 'companies/old/').map(q => q.pageToken ?? null)
    expect(new Set(oldLists).size).toBe(oldLists.length)                     // no page listed twice
  })

  it('a slow page cannot cause a false completion or a lost request: the page is checkpointed and the company simply yields', async () => {
    await seedCompanies(['slow'])
    bucket = fakeBucket(seedObjects('slow', 3))
    await R.requestRevocation({ db: A.db, now }, { companyId: 'slow' })
    listingCosts(400 * S)                                                    // one page outlasts the whole run
    const results = await runWorker({ sweepOptions: { pageSize: 1 } })
    expect(results).toEqual([{ companyId: 'slow', action: 'yielded' }])
    const st = await stateOf('slow')
    expect(st).toMatchObject({ requestSeq: 1, completedSeq: 0 })
    expect(st.pass).toMatchObject({ pages: 1, removed: 1, pageToken: drawingObject('slow', 1) })
    expect(st.lastPass).toBeUndefined()
    expect(await markerOf('slow')).not.toBe(null)
    expect(await audits('slow', 'file_links.revoked')).toHaveLength(0)
  })

  it('the queue changing during a run: work finished elsewhere is passed over, work that arrives is picked up next run', async () => {
    await seedCompanies(['a', 'b', 'c'])
    bucket = fakeBucket({ ...seedObjects('a', 2), ...seedObjects('b', 2), ...seedObjects('c', 2) })
    await R.requestRevocation({ db: A.db, now }, { companyId: 'a' })
    now.advance(1 * S)
    await R.requestRevocation({ db: A.db, now }, { companyId: 'b' })
    let once = false
    bucket.hooks.beforePatch = async (name) => {
      if (once || !name.startsWith('companies/a/')) return
      once = true
      await R.processCompany(deps(), 'b', { owner: 'operator:1:1', sweepOptions: noSleep })   // b is finished by someone else
      await R.requestRevocation({ db: A.db, now }, { companyId: 'c' })                        // c arrives mid-run
    }
    const results = await runWorker()
    expect(results).toEqual([expect.objectContaining({ companyId: 'a', action: 'complete' }), { companyId: 'b', action: 'none' }])
    expect((await stateOf('b')).completedSeq).toBe(1)
    expect(await audits('b', 'file_links.revoked')).toHaveLength(1)          // once, not twice
    expect(await markerOf('c')).not.toBe(null)
    const next = await runWorker()
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ companyId: 'c', action: 'complete', removed: 2 })
  })

  it('planning pauses while the periodic queue is full, and continues from the same cursor once it has drained', async () => {
    const ids = Array.from({ length: R.PERIODIC_BACKLOG_MAX + 30 }, (_, i) => `q${String(i).padStart(4, '0')}`)
    await seedCompanies(ids)
    await plan(); await plan()                                               // 200 queued, cursor at q0199
    expect((await cursorOf()).cursor).toBe('q0199')
    expect((await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size).toBe(R.PERIODIC_BACKLOG_MAX)

    const results = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(results.plan).toBeUndefined()
    expect(log.lines.some(l => l.msg.includes('planning paused'))).toBe(true)
    expect((await cursorOf()).cursor).toBe('q0199')                          // not advanced, not reset
    expect(results.filter(r => r.action === 'complete')).toHaveLength(R.PERIODIC_BACKLOG_MAX)

    const after = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(after.plan).toMatchObject({ action: 'finished', examined: R.PERIODIC_BACKLOG_MAX + 30, requested: R.PERIODIC_BACKLOG_MAX + 30 })
    expect((await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size).toBe(30)
  })
})

describe('D. an urgent request pre-empts a periodic sweep of the same company', () => {
  let H1
  beforeEach(async () => {
    ;({ handlers: H1 } = await makeHandlers({ now }))
    await seedCompany(COMPANY_A, 'Acme Builders')
    await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
    await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A })
    await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A })
    bucket = fakeBucket(seedObjects(COMPANY_A, 5))
  })
  const row = async (uid) => (await H1.listTeam(req('u_admin'))).members.find(m => m.uid === uid).fileLinks

  it('the periodic sweep is replaced once, is never recorded as complete, and the member reads pending until the NEW sweep finishes', async () => {
    await R.requestPeriodicSweep({ db: A.db, now }, COMPANY_A, INTERVAL)
    const periodicStart = now().getTime()
    listingCosts(10 * S)
    // One page of the periodic sweep, then its turn ends.
    expect(await sweep(COMPANY_A, { deadlineMs: now().getTime() + 1, sweepOptions: { pageSize: 2 } })).toMatchObject({ action: 'yielded' })
    expect((await stateOf(COMPANY_A)).pass).toMatchObject({ seq: 1, priority: 'periodic', pages: 1, removed: 2 })

    now.advance(30 * S)
    await H1.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    expect(await stateOf(COMPANY_A)).toMatchObject({ requestSeq: 2, requestPriority: 'urgent', completedSeq: 0 })
    expect(await markerOf(COMPANY_A)).toMatchObject({ priority: 'urgent', requestSeq: 2 })
    expect((await row('u_pm')).status).toBe('pending')

    // Observe the state from INSIDE the replacement sweep, before it finishes.
    let inside = null
    bucket.hooks.beforePatch = async () => {
      if (inside) return
      inside = { state: await stateOf(COMPANY_A), status: (await row('u_pm')).status, revoked: await audits(COMPANY_A, 'file_links.revoked'), reconciled: await audits(COMPANY_A, 'file_links.reconciled') }
    }
    const restartAt = now().getTime()
    const results = await runWorker({ sweepOptions: { pageSize: 2 } })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ action: 'complete', seq: 2, more: false, pages: 3, scanned: 5, removed: 3 })

    expect(inside.state.pass).toMatchObject({ seq: 2, priority: 'urgent', restarts: 1 })
    expect(inside.state.pass.startedAt.toMillis()).toBe(restartAt)
    expect(inside.state.completedSeq).toBe(0)                          // the abandoned sweep completed NOTHING
    expect(inside.state.completedPassStartedAt).toBeUndefined()
    expect(inside.state.lastPass).toBeUndefined()
    expect(inside.status).toBe('pending')
    expect(inside.revoked).toHaveLength(0)
    expect(inside.reconciled).toHaveLength(0)

    const st = await stateOf(COMPANY_A)
    expect(st).toMatchObject({ requestSeq: 2, completedSeq: 2 })
    expect(st.completedPassStartedAt.toMillis()).toBe(restartAt)
    expect(st.completedPassStartedAt.toMillis()).not.toBe(periodicStart)
    expect((await row('u_pm')).status).toBe('revoked')
    expect(await audits(COMPANY_A, 'file_links.revoked')).toHaveLength(1)
    expect(await audits(COMPANY_A, 'file_links.reconciled')).toHaveLength(0)
    expect(tokensLeft(bucket)).toBe(0)
    expect(log.lines.some(l => l.msg.includes('periodic sweep replaced'))).toBe(true)
  })

  it('an URGENT sweep is never restarted by a later urgent request — it finishes, then one more sweep covers the newcomer', async () => {
    await H1.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    listingCosts(10 * S)
    expect(await sweep(COMPANY_A, { deadlineMs: now().getTime() + 1, sweepOptions: { pageSize: 2 } })).toMatchObject({ action: 'yielded' })
    await H1.deactivateMember(req('u_admin', { uid: 'u_qs' }))
    const results = await runWorker({ sweepOptions: { pageSize: 2 } })
    expect(results.map(r => [r.action, r.seq])).toEqual([['complete', 1], ['complete', 2]])
    expect(bucket.calls.list.map(q => q.pageToken ?? null).slice(0, 2)).toEqual([null, drawingObject(COMPANY_A, 2)])   // resumed, not restarted
    expect((await row('u_pm')).status).toBe('revoked')
    expect((await row('u_qs')).status).toBe('revoked')
  })

  it('a periodic request is never written over an outstanding urgent one, and a new urgent request keeps the company\'s place in the queue', async () => {
    await H1.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    const first = await markerOf(COMPANY_A)
    expect(await R.requestPeriodicSweep({ db: A.db, now }, COMPANY_A, INTERVAL)).toEqual({ requested: false, reason: 'not-due' })
    expect(await stateOf(COMPANY_A)).toMatchObject({ requestSeq: 1, requestPriority: 'urgent' })

    now.advance(90 * S)
    await H1.deactivateMember(req('u_admin', { uid: 'u_qs' }))
    const second = await markerOf(COMPANY_A)
    expect(second).toMatchObject({ requestSeq: 2, priority: 'urgent' })
    expect(second.queuedAt.toMillis()).toBe(first.queuedAt.toMillis())
    await expect(async () => R.requestRevocationInTx(null, A.db, COMPANY_A, { exists: false }, { now: now(), reason: 'periodic' })).rejects.toThrow(/planner only/)
  })
})

// ── E. Failure handling ──────────────────────────────────────────────────────
describe('E. failures, as distinct from yields', () => {
  beforeEach(async () => {
    await seedCompanies(['c1'])
    bucket = fakeBucket(seedObjects('c1', 5))
  })

  it('a failed listing interrupts the sweep, keeps the checkpoint, completes nothing — and the next run resumes', async () => {
    await R.requestPeriodicSweep({ db: A.db, now }, 'c1', INTERVAL)
    let fail = true
    bucket.hooks.listError = (pageToken) => (pageToken && fail ? 503 : null)
    const [r] = await runWorker({ reconcileIntervalMs: INTERVAL, sweepOptions: { pageSize: 2 } })
    expect(r).toMatchObject({ companyId: 'c1', action: 'error', errors: 1 })
    let st = await stateOf('c1')
    expect(st.pass).toMatchObject({ pages: 1, pageToken: drawingObject('c1', 2), errors: 1 })
    expect(st.completedSeq).toBe(0)
    expect(st.lease).toBeUndefined()
    expect(await markerOf('c1')).not.toBe(null)

    fail = false
    now.advance(60 * S)
    const before = bucket.calls.list.length
    const [ok] = await runWorker({ reconcileIntervalMs: INTERVAL, sweepOptions: { pageSize: 2 } })
    expect(ok).toMatchObject({ action: 'complete', pages: 3, removed: 5 })
    expect(bucket.calls.list[before].pageToken).toBe(drawingObject('c1', 2))
    st = await stateOf('c1')
    expect(st.completedSeq).toBe(1)
  })

  // Review correction: an HTTP 400 or 410 on a listing is NOT read as "the page
  // token expired". Nothing documents that, and a 400 can be any bad request.
  // The checkpoint is kept; a position that really is unusable is recovered by
  // the five-failure rule, whose retry starts from the first page.
  for (const status of [400, 410, 404, 403]) {
    it(`an ambiguous HTTP ${status} while resuming is an ordinary failure: the checkpoint is kept and nothing restarts`, async () => {
      await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
      const startedAt = now().getTime()
      let refuse = true
      bucket.hooks.listError = (pageToken) => (pageToken && refuse ? status : null)
      expect(await sweep('c1', { sweepOptions: { pageSize: 2 } })).toEqual({ companyId: 'c1', action: 'error', errors: 1 })
      let st = await stateOf('c1')
      expect(st.pass).toMatchObject({ seq: 1, pageToken: drawingObject('c1', 2), pages: 1, scanned: 2, removed: 2, errors: 1 })
      expect(st.pass.restarts).toBeUndefined()
      expect(st.pass.startedAt.toMillis()).toBe(startedAt)
      expect(st.completedSeq).toBe(0)
      expect(st.lastPass).toBeUndefined()

      // The fault clears: the SAME sweep carries on from where it stopped.
      refuse = false
      now.advance(60 * S)
      const before = bucket.calls.list.length
      expect(await sweep('c1', { sweepOptions: { pageSize: 2 } })).toMatchObject({ action: 'complete', pages: 3, scanned: 5, removed: 5 })
      expect(bucket.calls.list[before].pageToken).toBe(drawingObject('c1', 2))
      st = await stateOf('c1')
      expect(st.completedPassStartedAt.toMillis()).toBe(startedAt)
      expect(tokensLeft(bucket)).toBe(0)
    })
  }

  it('a listing position that is refused for good: no loop, no false success — five failures, backoff, then a fresh sweep from the FIRST page that skips nothing', async () => {
    await seedCompanies(['c1b'])
    for (const [name, o] of Object.entries(seedObjects('c1b', 3))) bucket.store.set(name, { generation: '1000', metageneration: '1', contentType: 'application/pdf', ...o })
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    // Refuse exactly ONE saved position, for ever — the shape of a stale token.
    const poisoned = drawingObject('c1', 2)
    bucket.hooks.listError = (pageToken) => (pageToken === poisoned ? 400 : null)
    const actions = []
    for (let i = 0; i < R.MAX_INTERRUPTIONS; i += 1) {
      if (i > 0) now.advance(60 * S)
      actions.push((await sweep('c1', { sweepOptions: { pageSize: 2 } })).action)
    }
    expect(actions).toEqual(['error', 'error', 'error', 'error', 'incomplete'])
    let st = await stateOf('c1')
    expect(st).toMatchObject({ requestSeq: 1, completedSeq: 0, consecutiveIncomplete: 1, lastPass: { complete: false, interrupted: true } })
    expect(st.pass).toBeUndefined()
    expect(await markerOf('c1')).not.toBe(null)
    expect(await audits('c1', 'file_links.revoked')).toHaveLength(0)
    // Bounded: one listing per failed run, not a tight loop.
    expect(bucket.calls.list.filter(q => q.pageToken === poisoned)).toHaveLength(R.MAX_INTERRUPTIONS)
    expect(await sweep('c1', { sweepOptions: { pageSize: 2 } })).toEqual({ companyId: 'c1', action: 'backoff' })

    // After the backoff the retry is a NEW sweep from the first page. With a
    // different page size the poisoned position is never asked for again.
    now.advance(R.MAX_BACKOFF_MS)
    const before = bucket.calls.list.length
    const restartAt = now().getTime()
    expect(await sweep('c1', { sweepOptions: { pageSize: 3 } })).toMatchObject({ action: 'complete', scanned: 5, removed: 3 })
    expect(bucket.calls.list[before].pageToken ?? null).toBe(null)
    st = await stateOf('c1')
    expect(st).toMatchObject({ completedSeq: 1, consecutiveIncomplete: 0 })
    expect(st.completedPassStartedAt.toMillis()).toBe(restartAt)
    expect(tokensLeft(bucket, 'companies/c1/')).toBe(0)
    // Never another company's prefix, at any point.
    expect(bucket.calls.list.every(q => q.prefix === 'companies/c1/')).toBe(true)
    expect(tokensLeft(bucket, 'companies/c1b/')).toBe(3)
  })

  it('a first-page listing refusal is an ordinary failure too', async () => {
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    bucket.hooks.listError = () => 400
    expect(await sweep('c1')).toEqual({ companyId: 'c1', action: 'error', errors: 1 })
    expect((await stateOf('c1')).pass).toMatchObject({ errors: 1, pages: 0 })
    expect((await stateOf('c1')).pass.restarts).toBeUndefined()
  })

  it('five consecutive failed runs close the sweep as INCOMPLETE with a backoff — the request stays outstanding and nobody is shown as revoked', async () => {
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    bucket.hooks.listError = () => 503
    for (let i = 1; i < R.MAX_INTERRUPTIONS; i += 1) {
      expect(await sweep('c1')).toMatchObject({ action: 'error' })
      expect((await stateOf('c1')).pass.errors).toBe(i)
      now.advance(60 * S)
    }
    const closed = await sweep('c1')
    expect(closed).toMatchObject({ action: 'incomplete', interrupted: true, consecutiveIncomplete: 1 })
    let st = await stateOf('c1')
    expect(st.pass).toBeUndefined()
    expect(st).toMatchObject({ requestSeq: 1, completedSeq: 0, consecutiveIncomplete: 1, lastPass: { complete: false, interrupted: true } })
    expect(st.completedPassStartedAt).toBeUndefined()
    expect(st.nextAttemptAt.toMillis()).toBeGreaterThan(now().getTime())
    expect(await markerOf('c1')).not.toBe(null)
    expect(await audits('c1', 'file_links.revocation_incomplete')).toHaveLength(1)
    expect(await audits('c1', 'file_links.revoked')).toHaveLength(0)
    expect(await sweep('c1')).toEqual({ companyId: 'c1', action: 'backoff' })

    bucket.hooks.listError = null
    now.advance(R.MAX_BACKOFF_MS)
    expect(await sweep('c1')).toMatchObject({ action: 'complete', removed: 5 })
    st = await stateOf('c1')
    expect(st).toMatchObject({ completedSeq: 1, consecutiveIncomplete: 0 })
  })

  it('after a sweep is closed for repeated failures the request is still owed: a NEW urgent request clears the backoff and one sweep covers both', async () => {
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    bucket.hooks.listError = () => 503
    for (let i = 0; i < R.MAX_INTERRUPTIONS; i += 1) { if (i > 0) now.advance(60 * S); await sweep('c1') }
    expect(await stateOf('c1')).toMatchObject({ requestSeq: 1, completedSeq: 0, consecutiveIncomplete: 1 })
    expect(await sweep('c1')).toEqual({ companyId: 'c1', action: 'backoff' })

    bucket.hooks.listError = null
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    const st = await stateOf('c1')
    expect(st.requestSeq).toBe(2)
    expect(st.nextAttemptAt).toBeUndefined()
    expect(await sweep('c1')).toMatchObject({ action: 'complete', seq: 2, more: false, removed: 5 })
    expect((await stateOf('c1')).completedSeq).toBe(2)
    expect(await markerOf('c1')).toBe(null)
  })

  it('a run that was KILLED (it never released its lease) counts as a failed run, and five in a row close the sweep — a company that always hangs is not retried for ever', async () => {
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    expect(await sweep('c1', { deadlineMs: now().getTime() })).toEqual({ companyId: 'c1', action: 'yielded' })   // opens the sweep
    const killedRun = async (n) => {
      await R.stateRef(A.db, 'c1').update({ lease: { owner: `worker:dead:${n}`, expiresAt: ts(now().getTime() + R.LEASE_MS) } })
      expect(await sweep('c1', { owner: `worker:next:${n}`, deadlineMs: now().getTime() }), 'still leased').toEqual({ companyId: 'c1', action: 'busy' })
      now.advance(R.LEASE_MS + 1)
    }
    for (let n = 1; n < R.MAX_INTERRUPTIONS; n += 1) {
      await killedRun(n)
      // The next owner finds the dead lease, counts it, and (here) immediately yields again.
      expect(await sweep('c1', { owner: `worker:next:${n}`, deadlineMs: now().getTime() })).toEqual({ companyId: 'c1', action: 'yielded' })
      expect((await stateOf('c1')).pass.errors).toBe(n)
    }
    await killedRun(R.MAX_INTERRUPTIONS)
    const lists = bucket.calls.list.length
    const closed = await sweep('c1', { owner: 'worker:last' })
    expect(closed).toMatchObject({ companyId: 'c1', action: 'incomplete', interrupted: true, consecutiveIncomplete: 1 })
    expect(bucket.calls.list).toHaveLength(lists)                       // closed before any listing
    const st = await stateOf('c1')
    expect(st.pass).toBeUndefined()
    expect(st).toMatchObject({ requestSeq: 1, completedSeq: 0 })
    expect(st.nextAttemptAt.toMillis()).toBeGreaterThan(now().getTime())
    expect(await markerOf('c1')).not.toBe(null)
    now.advance(R.MAX_BACKOFF_MS)
    expect(await sweep('c1')).toMatchObject({ action: 'complete', removed: 5 })
  })

  it('a page that goes through clears the failure count: failures must be CONSECUTIVE to close a sweep', async () => {
    await R.requestRevocation({ db: A.db, now }, { companyId: 'c1' })
    let failures = 0
    bucket.hooks.listError = (pageToken) => (pageToken && failures > 0 ? (failures -= 1, 503) : null)
    for (let round = 0; round < 3; round += 1) {
      failures = round === 0 ? 0 : R.MAX_INTERRUPTIONS - 1
      for (let i = 0; i < R.MAX_INTERRUPTIONS - 1 && failures > 0; i += 1) {
        expect((await sweep('c1', { sweepOptions: { pageSize: 1 }, deadlineMs: Infinity })).action).toBe('error')
      }
      // One page succeeds, then the turn ends.
      const real = bucket.getFiles.bind(bucket)
      let listed = 0
      bucket.getFiles = async (q) => { listed += 1; if (listed > 1) now.advance(10 * S); return real(q) }
      const r = await sweep('c1', { sweepOptions: { pageSize: 1 }, deadlineMs: now().getTime() + 1 })
      bucket.getFiles = real
      expect(['yielded', 'complete']).toContain(r.action)
      if (r.action === 'yielded') expect((await stateOf('c1')).pass.errors).toBe(0)
    }
    expect(await audits('c1', 'file_links.revocation_incomplete')).toHaveLength(0)
  })

  it('a conditional update that keeps failing is an incomplete sweep, never a completed one; repeated runs after success change nothing', async () => {
    await R.requestPeriodicSweep({ db: A.db, now }, 'c1', INTERVAL)
    const bad = drawingObject('c1', 4)
    bucket.hooks.patchError = (name) => (name === bad ? 412 : null)
    const [r] = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(r).toMatchObject({ action: 'incomplete', removed: 4, failed: 1 })
    expect(bucket.calls.patch.filter(c => c.name === bad).every(c => 'ifGenerationMatch' in c.options && 'ifMetagenerationMatch' in c.options)).toBe(true)
    expect((await stateOf('c1')).completedSeq).toBe(0)
    expect(await audits('c1', 'file_links.reconciled')).toHaveLength(0)

    bucket.hooks.patchError = null
    now.advance(R.MAX_BACKOFF_MS)
    expect((await runWorker({ reconcileIntervalMs: INTERVAL }))[0]).toMatchObject({ action: 'complete', removed: 1 })
    const patches = bucket.calls.patch.length
    const snapshot = JSON.stringify(await stateOf('c1'))
    for (let i = 0; i < 3; i += 1) { now.advance(60 * S); expect(await runWorker({ reconcileIntervalMs: 0 })).toEqual([]) }
    expect(bucket.calls.patch).toHaveLength(patches)
    expect(JSON.stringify(await stateOf('c1'))).toBe(snapshot)
  })
})

// ── Overdue ──────────────────────────────────────────────────────────────────
describe('overdue reconciliation', () => {
  it('a company two intervals behind is counted on every pass, logged at error level, audited ONCE per episode, and cleared by a successful sweep', async () => {
    await seedCompanies(['late', 'fine'])
    await seedSwept('late', 2 * INTERVAL + H, { requestSeq: 2, consecutiveIncomplete: 4, nextAttemptAt: ts(now().getTime() + 30 * 60 * S) })
    await R.markerRef(A.db, 'late').set({ companyId: 'late', requestSeq: 2, priority: 'periodic' })
    await seedSwept('fine', H)
    bucket = fakeBucket(seedObjects('late', 2))

    expect(await plan()).toMatchObject({ action: 'finished', examined: 2, requested: 0, overdue: 1 })
    expect(log.lines.filter(l => l.level === 'error' && l.msg.includes('reconciliation overdue'))).toHaveLength(1)
    expect((await stateOf('late')).overdueSince.toMillis()).toBe(now().getTime())
    expect(await cursorOf()).toMatchObject({ lastPass: { overdue: 1 } })
    const [event] = await audits('late', 'file_links.reconciliation_overdue')
    expect(event).toMatchObject({ source: 'worker', after: { intervalHours: 24, consecutiveIncomplete: 4 } })
    expect(await audits('fine', 'file_links.reconciliation_overdue')).toHaveLength(0)

    now.advance(R.PLAN_EVERY_MS)
    expect(await plan()).toMatchObject({ overdue: 1 })
    expect(await audits('late', 'file_links.reconciliation_overdue')).toHaveLength(1)   // still one

    const [r] = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(r).toMatchObject({ companyId: 'late', action: 'complete' })
    expect((await stateOf('late')).overdueSince).toBeUndefined()
    now.advance(R.PLAN_EVERY_MS)
    expect(await plan()).toMatchObject({ overdue: 0 })
  })
})

// ── F. Isolation and leakage ─────────────────────────────────────────────────
describe('F. tenant isolation and no leakage', () => {
  it('a periodic sweep lists and changes only its own company prefix, and no token value reaches Firestore, a log or a result', async () => {
    await seedCompany(COMPANY_A)
    await seedCompany(COMPANY_B)
    await seedCompany(`${COMPANY_A}-two`)
    await seedSwept(COMPANY_B, H)                                      // not due
    await seedSwept(`${COMPANY_A}-two`, H)                             // a prefix that starts with A's name
    bucket = fakeBucket({
      ...seedObjects(COMPANY_A, 4, { extra: { keep: 'yes' } }),
      ...seedObjects(COMPANY_B, 3),
      ...seedObjects(`${COMPANY_A}-two`, 2),
    })
    const planned = await plan()
    expect(planned).toMatchObject({ requested: 1 })
    bucket.hooks.patchError = (name, attempt) => (name === drawingObject(COMPANY_A, 2) && attempt === 1 ? 500 : null)
    const results = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ companyId: COMPANY_A, action: 'complete', removed: 4 })

    expect(bucket.calls.list.length).toBeGreaterThan(0)
    expect(bucket.calls.list.every(q => q.prefix === `companies/${COMPANY_A}/`)).toBe(true)
    expect(bucket.calls.patch.every(c => c.name.startsWith(`companies/${COMPANY_A}/`))).toBe(true)
    for (const c of bucket.calls.patch) expect(c.patch).toEqual({ metadata: { [TOKEN]: null } })
    expect(tokensLeft(bucket, `companies/${COMPANY_B}/`)).toBe(3)
    expect(tokensLeft(bucket, `companies/${COMPANY_A}-two/`)).toBe(2)
    for (const [name, o] of bucket.store) if (name.startsWith(`companies/${COMPANY_A}/`)) expect(o.metadata).toEqual({ keep: 'yes' })

    const dump = [await cursorOf()]
    for (const c of [COMPANY_A, COMPANY_B, `${COMPANY_A}-two`]) {
      for (const path of ['system', R.QUEUE_COLLECTION, 'auditEvents']) {
        for (const d of (await A.db.collection('companies').doc(c).collection(path).get()).docs) dump.push(d.data())
      }
    }
    const everything = JSON.stringify({ dump, log: log.lines, results, planned, plan: results.plan })
    expect(dump.length).toBeGreaterThan(3)
    expect(everything).not.toContain('SECRET-TOKEN')
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toMatch(/https?:\/\//)
  })

  it('the worker\'s log line is bounded however many companies are queued', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    await seedCompanies(many)
    await plan()
    await runWorker({ reconcileIntervalMs: INTERVAL })
    const line = log.lines.find(l => l.msg === 'file-links: worker run').fields
    expect(line.companies).toBe(40)
    expect(line.results).toHaveLength(R.LOG_RESULTS_MAX)
    expect(line.truncated).toBe(40 - R.LOG_RESULTS_MAX)
    expect(line.actions).toEqual({ complete: 40 })
  })
})
