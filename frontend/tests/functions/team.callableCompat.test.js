import { beforeAll, beforeEach, afterEach, describe, it, expect } from 'vitest'
import {
  admin, resetEmulators, makeHandlers, seedCompany, seedUser, req, clock, clientSignOutAll, COMPANY_A,
} from './_harness.js'
import { fakeBucket, seedObjects, drawingObject, tokensLeft } from '../../functions/test/_fakeBucket.js'

// ── DC46-C — callable ↔ worker compatibility once periodic requests exist ────
//
// The membership callables and the scheduled worker share
// lib/fileLinkRevocation.js but are deployed as SEPARATE revisions. These
// tests pin what a membership request must do when the company's state has
// already been touched by periodic reconciliation (ADR-75):
//
//   1–5  the CURRENT (Stage 1) callable code — the behaviour production gets
//        once every function runs this source
//   6    DEPLOYMENT SKEW — the request documents written by the ADR-74 build
//        of the callables (the build deployed on 12 November 2026), served by
//        the Stage 1 worker. Characterisation only: it records WHY the
//        callables must be redeployed before a non-zero interval is set
//        (docs/DEPLOYMENT.md → DC46-C monitoring readiness).
//
// Same harness as team.reconciliation.test.js: the real Firestore emulator,
// the fake bucket, an injected clock. Nothing sleeps or races the wall clock.

const S = 1000
const H = 60 * 60 * 1000
const INTERVAL = 24 * H

let A, R, T, deps, now, bucket, log

const recorder = () => {
  const lines = []
  const push = (level) => (msg, fields) => lines.push({ level, msg, fields })
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
}

const stateOf = async () => (await R.stateRef(A.db, COMPANY_A).get()).data() ?? null
const markerOf = async () => (await R.markerRef(A.db, COMPANY_A).get()).data() ?? null
const audits = async (type) =>
  (await A.db.collection('companies').doc(COMPANY_A).collection('auditEvents').get()).docs.map(d => d.data()).filter(e => e.type === type)
const status = async (uid) => (await T.listTeam(req('u_admin'))).members.find(m => m.uid === uid).fileLinks?.status ?? null
const workerDeps = () => ({ db: A.db, bucket, now, log })
const noSleep = { sleep: async () => {} }
const runWorker = (opts = {}) => {
  const { sweepOptions = {}, ...rest } = opts
  return R.runRevocationWorker(workerDeps(), { owner: `worker:test:${now().getTime()}`, sweepOptions: { ...noSleep, ...sweepOptions }, ...rest })
}
const sweep = (opts = {}) => {
  const { sweepOptions = {}, ...rest } = opts
  return R.processCompany(workerDeps(), COMPANY_A, { owner: 'worker:test', sweepOptions: { ...noSleep, ...sweepOptions }, ...rest })
}
const periodicRequest = () => R.requestPeriodicSweep({ db: A.db, now }, COMPANY_A, INTERVAL)
const deactivate = (uid) => T.deactivateMember(req('u_admin', { uid }))
const queueSize = async () => (await A.db.collectionGroup(R.QUEUE_COLLECTION).get()).size

// Put a download token back on one object, as if a link had been minted again.
const remint = (n) => { bucket.store.get(drawingObject(COMPANY_A, n)).metadata.firebaseStorageDownloadTokens = `again-${n}` }

beforeAll(async () => {
  A = await admin()
  R = await import('../../functions/src/lib/fileLinkRevocation.js')
})

beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  now = clock('2026-11-16T10:00:00Z')
  log = recorder()
  ;({ handlers: T, deps } = await makeHandlers({ now }))
  await seedCompany(COMPANY_A, 'Acme Builders')
  await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
  await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A })
  await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A })
  await seedUser({ uid: 'u_est', email: 'est@acme.test', role: 'estimator', companyId: COMPANY_A })
  bucket = fakeBucket(seedObjects(COMPANY_A, 5))
})

afterEach(async () => { await clientSignOutAll() })

// ── 1. A periodic request is QUEUED, not yet started ─────────────────────────
describe('1. a deactivation while a periodic request is queued', () => {
  it('becomes URGENT on the state and the marker, keeps the place in the queue, and ONE sweep covers both — audited file_links.revoked', async () => {
    expect(await periodicRequest()).toEqual({ requested: true, seq: 1 })
    expect(await stateOf()).toMatchObject({ requestSeq: 1, requestPriority: 'periodic', requestReason: 'periodic' })
    expect(await markerOf()).toMatchObject({ priority: 'periodic', requestSeq: 1 })
    const queuedAt = (await markerOf()).queuedAt.toMillis()

    now.advance(40 * S)
    expect(await deactivate('u_pm')).toMatchObject({ changed: true, fileLinks: 'pending' })
    expect(await stateOf()).toMatchObject({ requestSeq: 2, completedSeq: 0, requestPriority: 'urgent', requestReason: 'member.deactivated', requestedBy: 'u_admin' })
    const marker = await markerOf()
    expect(marker).toMatchObject({ priority: 'urgent', requestSeq: 2 })
    expect(marker.queuedAt.toMillis()).toBe(queuedAt)
    expect(await queueSize()).toBe(1)
    expect(await status('u_pm')).toBe('pending')

    now.advance(20 * S)
    const startedAt = now().getTime()
    const results = await runWorker()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ action: 'complete', seq: 2, more: false, scanned: 5, removed: 5, failed: 0 })

    const st = await stateOf()
    expect(st).toMatchObject({ requestSeq: 2, completedSeq: 2, consecutiveIncomplete: 0 })
    expect(st.completedPassStartedAt.toMillis()).toBe(startedAt)
    expect(st.lastPass.priority).toBeUndefined()            // an urgent sweep, recorded as one
    expect(st.pass).toBeUndefined()
    expect(st.lease).toBeUndefined()
    expect(await markerOf()).toBe(null)
    expect(await status('u_pm')).toBe('revoked')
    expect(await audits('file_links.revocation_requested')).toHaveLength(1)   // the periodic request wrote none
    expect(await audits('file_links.revoked')).toHaveLength(1)
    expect(await audits('file_links.reconciled')).toHaveLength(0)
    expect(tokensLeft(bucket)).toBe(0)
  })

  it('the same holds with reconciliation switched on: the deactivation is served in the urgent phase and is not requested again as periodic', async () => {
    await periodicRequest()
    await deactivate('u_pm')
    const results = await runWorker({ reconcileIntervalMs: INTERVAL })
    expect(results.filter(r => r.companyId === COMPANY_A).map(r => [r.action, r.seq])).toEqual([['complete', 2]])
    expect(await stateOf()).toMatchObject({ requestSeq: 2, completedSeq: 2 })   // planning found it NOT due
    expect(await markerOf()).toBe(null)
    expect(await audits('file_links.revoked')).toHaveLength(1)
    expect(await audits('file_links.reconciled')).toHaveLength(0)
  })
})

// ── 2. A periodic sweep has COMPLETED earlier ────────────────────────────────
describe('2. a deactivation after a periodic sweep has completed', () => {
  beforeEach(async () => {
    await periodicRequest()
    expect((await runWorker())[0]).toMatchObject({ action: 'complete', seq: 1, removed: 5 })
    expect(await stateOf()).toMatchObject({ requestSeq: 1, completedSeq: 1, requestPriority: 'periodic' })
    expect((await stateOf()).lastPass.priority).toBe('periodic')
    expect(await audits('file_links.reconciled')).toHaveLength(1)
    now.advance(2 * H)
  })

  it('overrides the stale periodic priority: the sweep is urgent and is audited file_links.revoked even when it finds NO token', async () => {
    await deactivate('u_pm')
    expect(await stateOf()).toMatchObject({ requestSeq: 2, completedSeq: 1, requestPriority: 'urgent' })
    expect(await markerOf()).toMatchObject({ priority: 'urgent', requestSeq: 2 })
    expect((await markerOf()).queuedAt.toMillis()).toBe(now().getTime())   // a NEW wait, not the periodic one's

    const [r] = await runWorker()
    expect(r).toMatchObject({ action: 'complete', seq: 2, scanned: 5, removed: 0, failed: 0 })
    const revoked = await audits('file_links.revoked')
    expect(revoked).toHaveLength(1)
    expect(revoked[0]).toMatchObject({ source: 'worker', after: { seq: 2, scanned: 5, removed: 0, failed: 0 } })
    expect(await audits('file_links.reconciled')).toHaveLength(1)           // still only the earlier periodic one
    expect((await stateOf()).lastPass.priority).toBeUndefined()
    expect(await status('u_pm')).toBe('revoked')
    expect(await markerOf()).toBe(null)
  })

  it('a role reduction and an operator request behave the same way', async () => {
    await A.members.changeMemberRole(deps, { companyId: COMPANY_A, actor: { uid: 'u_admin' }, uid: 'u_pm', role: 'subcontractor', expectedRole: 'project_manager' })
    expect(await stateOf()).toMatchObject({ requestSeq: 2, requestPriority: 'urgent', requestReason: 'member.role_reduced' })
    expect((await runWorker())[0]).toMatchObject({ action: 'complete', seq: 2 })
    expect(await audits('file_links.revoked')).toHaveLength(1)

    await R.requestRevocation({ db: A.db, now }, { companyId: COMPANY_A })
    expect(await stateOf()).toMatchObject({ requestSeq: 3, requestPriority: 'urgent', requestReason: 'operator' })
    expect((await runWorker())[0]).toMatchObject({ action: 'complete', seq: 3 })
    expect(await audits('file_links.revoked')).toHaveLength(2)
    expect(await audits('file_links.reconciled')).toHaveLength(1)
    expect(await stateOf()).toMatchObject({ requestSeq: 3, completedSeq: 3 })
  })
})

// ── 3. A periodic sweep is OPEN ──────────────────────────────────────────────
describe('3. a deactivation while a periodic sweep is open', () => {
  const openPeriodicSweep = async () => {
    await periodicRequest()
    const real = bucket.getFiles.bind(bucket)
    bucket.getFiles = async (q) => { now.advance(10 * S); return real(q) }
    expect(await sweep({ deadlineMs: now().getTime() + 1, sweepOptions: { pageSize: 2 } })).toMatchObject({ action: 'yielded' })
    expect((await stateOf()).pass).toMatchObject({ seq: 1, priority: 'periodic', pages: 1, removed: 2 })
  }

  it('supersedes it: the periodic sweep is never completed, the urgent one starts from the first page after the deactivation and is audited file_links.revoked', async () => {
    await openPeriodicSweep()
    now.advance(30 * S)
    const deactivatedAt = now().getTime()
    await deactivate('u_pm')
    // A token minted on an object the abandoned sweep had ALREADY passed.
    remint(1)

    const results = await runWorker({ sweepOptions: { pageSize: 2 } })
    expect(results.map(r => [r.action, r.seq])).toEqual([['complete', 2]])
    expect(results[0]).toMatchObject({ pages: 3, scanned: 5, removed: 4 })   // 3 untouched + the re-minted one
    const st = await stateOf()
    expect(st).toMatchObject({ requestSeq: 2, completedSeq: 2 })
    expect(st.completedPassStartedAt.toMillis()).toBeGreaterThanOrEqual(deactivatedAt)
    expect(st.lastPass.priority).toBeUndefined()
    expect(await audits('file_links.revoked')).toHaveLength(1)
    expect(await audits('file_links.reconciled')).toHaveLength(0)
    expect(await status('u_pm')).toBe('revoked')
    expect(tokensLeft(bucket)).toBe(0)
    expect(await markerOf()).toBe(null)
  })

  it('two deactivations during it supersede it ONCE, and one urgent sweep covers both members', async () => {
    await openPeriodicSweep()
    await deactivate('u_pm')
    now.advance(5 * S)
    await deactivate('u_qs')
    expect(await stateOf()).toMatchObject({ requestSeq: 3, requestPriority: 'urgent' })

    const results = await runWorker({ sweepOptions: { pageSize: 2 } })
    expect(results.map(r => [r.action, r.seq])).toEqual([['complete', 3]])
    expect((await stateOf()).lastPass).toMatchObject({ seq: 3, complete: true })
    expect(await status('u_pm')).toBe('revoked')
    expect(await status('u_qs')).toBe('revoked')
    expect(await audits('file_links.revoked')).toHaveLength(1)
    expect(await audits('file_links.revocation_requested')).toHaveLength(2)
  })

  it('a deactivation that lands INSIDE the running periodic sweep is not covered by it: the member stays pending until a second, urgent sweep completes', async () => {
    await periodicRequest()
    let fired = false
    bucket.hooks.beforePatch = async () => {
      if (fired) return
      fired = true
      await deactivate('u_pm')
    }
    // The member's status at the moment the SECOND sweep lists its first page.
    let listings = 0
    let between = null
    const real = bucket.getFiles.bind(bucket)
    bucket.getFiles = async (q) => {
      listings += 1
      if (listings === 2) between = { status: await status('u_pm'), state: await stateOf(), revoked: await audits('file_links.revoked') }
      return real(q)
    }

    const results = await runWorker()
    expect(results.map(r => [r.action, r.seq, r.more])).toEqual([['complete', 1, true], ['complete', 2, false]])
    // The periodic sweep finished as periodic — and completed ONLY its own sequence.
    expect(between.state).toMatchObject({ requestSeq: 2, completedSeq: 1 })
    expect(between.state.pass).toMatchObject({ seq: 2, priority: 'urgent' })
    expect(between.status).toBe('pending')
    expect(between.revoked).toHaveLength(0)

    expect(await stateOf()).toMatchObject({ requestSeq: 2, completedSeq: 2 })
    expect(await status('u_pm')).toBe('revoked')
    expect(await audits('file_links.reconciled')).toHaveLength(1)
    expect(await audits('file_links.revoked')).toHaveLength(1)
    expect(await markerOf()).toBe(null)
    expect(tokensLeft(bucket)).toBe(0)
  })
})

// ── 4. Concurrency ───────────────────────────────────────────────────────────
describe('4. concurrent requests', () => {
  it('two deactivations and the planner at once: distinct sequences, one marker, urgent wins, nothing lost and nothing completed early', async () => {
    const [, , planned] = await Promise.all([deactivate('u_pm'), deactivate('u_qs'), periodicRequest()])
    const st = await stateOf()
    const members = await A.db.collection('companies').doc(COMPANY_A).collection('members').get()
    const seqs = members.docs.map(d => d.data().fileLinkRevocationSeq).filter(Number.isInteger).sort()
    // The planner either went first (sequence 1) or found the company not due.
    const expected = planned.requested ? [2, 3] : [1, 2]
    expect(seqs).toEqual(expected)
    expect(st).toMatchObject({ requestSeq: expected[1], completedSeq: 0, requestPriority: 'urgent' })
    expect(await markerOf()).toMatchObject({ priority: 'urgent', requestSeq: expected[1] })
    expect(await queueSize()).toBe(1)
    expect(await status('u_pm')).toBe('pending')
    expect(await status('u_qs')).toBe('pending')

    const results = await runWorker()
    expect(results.map(r => [r.action, r.seq])).toEqual([['complete', expected[1]]])
    expect(await stateOf()).toMatchObject({ requestSeq: expected[1], completedSeq: expected[1] })
    expect(await status('u_pm')).toBe('revoked')
    expect(await status('u_qs')).toBe('revoked')
    expect(await audits('file_links.revocation_requested')).toHaveLength(2)
    expect(await audits('file_links.revoked')).toHaveLength(1)
    expect(await audits('file_links.reconciled')).toHaveLength(0)
    expect(await markerOf()).toBe(null)
    expect(tokensLeft(bucket)).toBe(0)
  })

  it('a deactivation racing the worker\'s own transactions on an open periodic sweep never loses the request', async () => {
    await periodicRequest()
    // The deactivation commits while the worker is between its acquire and its
    // first checkpoint — both transactions touch the same state document.
    const real = bucket.getFiles.bind(bucket)
    let raced = null
    bucket.getFiles = async (q) => {
      raced ??= deactivate('u_pm')
      return real(q)
    }
    const first = await runWorker()
    await raced
    const second = await runWorker()
    const completed = [...first, ...second].filter(r => r.action === 'complete').map(r => r.seq)
    expect(completed.at(-1)).toBe(2)
    expect(await stateOf()).toMatchObject({ requestSeq: 2, completedSeq: 2, requestPriority: 'urgent' })
    expect(await status('u_pm')).toBe('revoked')
    expect(await audits('file_links.revoked')).toHaveLength(1)
    expect(await markerOf()).toBe(null)
    expect(tokensLeft(bucket)).toBe(0)
  })

  it('three deactivations at once after a completed periodic sweep: consecutive sequences and a single urgent sweep', async () => {
    await periodicRequest()
    await runWorker()
    now.advance(H)
    await Promise.all([deactivate('u_pm'), deactivate('u_qs'), deactivate('u_est')])
    expect(await stateOf()).toMatchObject({ requestSeq: 4, completedSeq: 1, requestPriority: 'urgent' })
    expect(await queueSize()).toBe(1)
    const results = await runWorker()
    expect(results.map(r => [r.action, r.seq])).toEqual([['complete', 4]])
    for (const uid of ['u_pm', 'u_qs', 'u_est']) expect(await status(uid)).toBe('revoked')
    expect(await audits('file_links.revoked')).toHaveLength(1)
  })
})

// ── 5. Reconciliation OFF — DC46-B behaviour preserved ───────────────────────
describe('5. with the interval at 0 the membership path is the ADR-74 one', () => {
  it('request, sweep, audit and status are as in DC46-B; no cursor, no periodic field, no reconciliation event', async () => {
    const touched = []
    const db = new Proxy(A.db, {
      get(target, prop) {
        if (prop === 'collection') return (name) => { touched.push(name); return target.collection(name) }
        const v = target[prop]
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    expect(await deactivate('u_pm')).toMatchObject({ changed: true, fileLinks: 'pending' })
    expect(await stateOf()).toMatchObject({ requestSeq: 1, completedSeq: 0, requestedBy: 'u_admin', requestReason: 'member.deactivated', requestPriority: 'urgent' })
    expect(await status('u_pm')).toBe('pending')

    const results = await R.runScheduledWorker({ db, bucket, now, log }, { owner: 'worker:test:1', reconcileIntervalRaw: '0', sweepOptions: noSleep })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ companyId: COMPANY_A, action: 'complete', seq: 1, scanned: 5, removed: 5, failed: 0 })
    expect(results.plan).toBeUndefined()
    expect(touched).not.toContain(R.CURSOR_COLLECTION)
    expect((await R.cursorRef(A.db).get()).exists).toBe(false)

    const st = await stateOf()
    expect(st).toMatchObject({ requestSeq: 1, completedSeq: 1 })
    expect(st.lastPass).toMatchObject({ seq: 1, complete: true, scanned: 5, removed: 5, failed: 0 })
    expect(st.lastPass.priority).toBeUndefined()
    expect(st.overdueSince).toBeUndefined()
    expect(await status('u_pm')).toBe('revoked')
    expect(await audits('file_links.revocation_requested')).toHaveLength(1)
    expect(await audits('file_links.revoked')).toHaveLength(1)
    expect(await audits('file_links.reconciled')).toHaveLength(0)
    expect(await audits('file_links.reconciliation_overdue')).toHaveLength(0)
    expect(await markerOf()).toBe(null)

    // Idle afterwards: nothing queued, nothing written, nothing logged as work.
    const before = log.lines.length
    for (let i = 0; i < 3; i += 1) {
      now.advance(60 * S)
      expect(await R.runScheduledWorker({ db, bucket, now, log }, { owner: `worker:test:idle${i}`, reconcileIntervalRaw: '0', sweepOptions: noSleep })).toEqual([])
    }
    expect(log.lines.length).toBe(before)
    expect((await stateOf()).requestSeq).toBe(1)
  })
})

// ── 6. DEPLOYMENT SKEW — the ADR-74 callable build beside the Stage 1 worker ─
//
// Characterisation, NOT desired behaviour. `legacyRequest` writes exactly the
// documents `requestRevocationInTx` wrote at commit ef41748 — the build the
// eight production callables were deployed from on 12 November 2026:
//   · the state is MERGED without `requestPriority` or `queuedAt`
//   · the marker is REPLACED, without `priority` or `queuedAt`
// With the interval at 0 that pairing is exact (first test; accepted in
// production on 16 November 2026). Once ANY periodic request has been written
// it is not: the state keeps `requestPriority: 'periodic'`, so the worker opens
// the deactivation's sweep as a periodic one. Tokens are still removed and no
// request is lost — but the sweep is not audited as `file_links.revoked`, and
// an open periodic sweep is not superseded.
//
// That is why the callables must run this source BEFORE a non-zero interval
// is set. If the worker is ever changed to tolerate the old documents, rewrite
// these tests rather than delete them.
describe('6. DEPLOYMENT SKEW — a request written by the ADR-74 callable build', () => {
  const legacyRequest = () => A.db.runTransaction(async (tx) => {
    const snap = await tx.get(R.stateRef(A.db, COMPANY_A))
    const prev = snap.exists ? snap.data() : {}
    const seq = (prev.requestSeq ?? 0) + 1
    const ts = A.Timestamp.fromDate(now())
    tx.set(R.stateRef(A.db, COMPANY_A), {
      requestSeq: seq, requestedAt: ts, requestedBy: 'u_admin', requestReason: 'member.deactivated',
      completedSeq: prev.completedSeq ?? 0, nextAttemptAt: A.FieldValue.delete(),
    }, { merge: true })
    tx.set(R.markerRef(A.db, COMPANY_A), { companyId: COMPANY_A, requestSeq: seq, requestedAt: ts })
    return seq
  })

  it('interval 0 (no periodic state has ever existed): served as urgent and audited file_links.revoked — the pairing production runs today', async () => {
    expect(await legacyRequest()).toBe(1)
    expect((await stateOf()).requestPriority).toBeUndefined()
    const [r] = await runWorker({ reconcileIntervalMs: 0 })
    expect(r).toMatchObject({ action: 'complete', seq: 1, removed: 5 })
    expect(await audits('file_links.revoked')).toHaveLength(1)
    expect(await audits('file_links.reconciled')).toHaveLength(0)
    expect((await stateOf()).lastPass.priority).toBeUndefined()
  })

  it('after a completed periodic sweep: the request is served and completed, but as a PERIODIC sweep — no file_links.revoked, and no audit event at all when no token is found', async () => {
    await periodicRequest()
    await runWorker()
    now.advance(2 * H)

    expect(await legacyRequest()).toBe(2)
    expect((await stateOf()).requestPriority).toBe('periodic')              // stale: the old build never writes it
    expect((await markerOf()).priority).toBeUndefined()                     // so the QUEUE still treats it as urgent
    const [r] = await runWorker()
    expect(r).toMatchObject({ action: 'complete', seq: 2, scanned: 5, removed: 0 })
    // Not lost, not left pending:
    expect(await stateOf()).toMatchObject({ requestSeq: 2, completedSeq: 2 })
    expect(await markerOf()).toBe(null)
    // …but the evidence is missing.
    expect((await stateOf()).lastPass.priority).toBe('periodic')
    expect(await audits('file_links.revoked')).toHaveLength(0)
    expect(await audits('file_links.reconciled')).toHaveLength(1)           // only the earlier, genuine periodic sweep

    // With a token to remove it IS audited — under the wrong type.
    now.advance(H)
    remint(3)
    await legacyRequest()
    expect((await runWorker())[0]).toMatchObject({ action: 'complete', seq: 3, removed: 1 })
    expect(await audits('file_links.revoked')).toHaveLength(0)
    expect(await audits('file_links.reconciled')).toHaveLength(2)
    expect(tokensLeft(bucket)).toBe(0)
  })

  it('during an open periodic sweep: not superseded — the periodic sweep finishes first, then a second sweep covers the request', async () => {
    await periodicRequest()
    const real = bucket.getFiles.bind(bucket)
    bucket.getFiles = async (q) => { now.advance(10 * S); return real(q) }
    await sweep({ deadlineMs: now().getTime() + 1, sweepOptions: { pageSize: 2 } })
    const requestedAt = now().getTime()
    await legacyRequest()

    const results = await runWorker({ sweepOptions: { pageSize: 2 } })
    expect(results.map(r => [r.action, r.seq])).toEqual([['complete', 1], ['complete', 2]])
    expect(log.lines.some(l => l.msg.includes('periodic sweep replaced'))).toBe(false)
    const st = await stateOf()
    expect(st).toMatchObject({ requestSeq: 2, completedSeq: 2 })
    expect(st.completedPassStartedAt.toMillis()).toBeGreaterThanOrEqual(requestedAt)   // the covering sweep started after the request
    expect(await audits('file_links.revoked')).toHaveLength(0)
    expect(tokensLeft(bucket)).toBe(0)
  })
})
