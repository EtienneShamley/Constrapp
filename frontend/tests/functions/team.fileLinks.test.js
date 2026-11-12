import { beforeAll, beforeEach, afterEach, describe, it, expect } from 'vitest'
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore'
import {
  admin, resetEmulators, makeHandlers, seedCompany, seedUser, req, expectTeamError, clock,
  clientSdk, clientSignIn, clientSignOutAll, COMPANY_A, COMPANY_B,
} from './_harness.js'
import { fakeBucket, seedObjects, drawingObject, tokensLeft } from '../../functions/test/_fakeBucket.js'

// ── ADR-74 (DC46-B) — durable revocation of legacy file links ────────────────
//
// The REAL Firestore emulator runs the transactions, the lease, the
// checkpoints and the audit trail. Cloud Storage is the fake from
// functions/test/_fakeBucket.js, because the Storage emulator cannot model
// what the worker relies on (its metadata PATCH ignores preconditions and does
// not clear tokens — ADR-74 evidence). What removing a token does to a real
// download URL was verified separately against real Firebase Storage on
// disposable data; nothing here proves it.

const TOKEN = 'firebaseStorageDownloadTokens'

let A, R, H, deps, now, bucket, log

const recorder = () => {
  const lines = []
  const push = (level) => (msg, fields) => lines.push({ level, msg, fields })
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
}

const stateOf = async (companyId = COMPANY_A) => (await R.stateRef(A.db, companyId).get()).data() ?? null
const markerExists = async (companyId = COMPANY_A) => (await R.markerRef(A.db, companyId).get()).exists
const memberDoc = async (uid, companyId = COMPANY_A) => (await A.db.collection('companies').doc(companyId).collection('members').doc(uid).get()).data()
const audits = async (type, companyId = COMPANY_A) =>
  (await A.db.collection('companies').doc(companyId).collection('auditEvents').get()).docs.map(d => d.data()).filter(e => e.type === type)
const rowOf = async (uid) => (await H.listTeam(req('u_admin'))).members.find(m => m.uid === uid)
const workerDeps = () => ({ db: A.db, bucket, now, log })
const sweepOptions = { sleep: async () => {} }
const runWorker = (owner = 'worker:test', extra = {}) => R.runRevocationWorker(workerDeps(), { owner, sweepOptions: { ...sweepOptions, ...extra } })
const sweep = (owner = 'worker:test', extra = {}) => R.processCompany(workerDeps(), COMPANY_A, { owner, sweepOptions: { ...sweepOptions, ...extra } })

beforeAll(async () => {
  A = await admin()
  R = await import('../../functions/src/lib/fileLinkRevocation.js')
})

beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  now = clock('2026-11-12T10:00:00Z')
  ;({ handlers: H, deps } = await makeHandlers({ now }))
  log = recorder()
  await seedCompany(COMPANY_A, 'Acme Builders')
  await seedCompany(COMPANY_B, 'Other Co')
  await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
  await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A })
  await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A })
  await seedUser({ uid: 'u_other', email: 'admin@other.test', role: 'company_admin', companyId: COMPANY_B })
  bucket = fakeBucket({
    ...seedObjects(COMPANY_A, 5, { extra: { keep: 'yes' } }),
    ...seedObjects(COMPANY_B, 3, { extra: { keep: 'yes' } }),
  })
})

afterEach(async () => { await clientSignOutAll() })

describe('the membership transaction queues the sweep', () => {
  it('deactivation revokes membership at once and records a request, a queue marker, a sequence and an audit event — tokens are untouched', async () => {
    const res = await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    expect(res).toMatchObject({ changed: true, fileLinks: 'pending' })

    // Membership is gone NOW, with no worker involved.
    expect((await A.db.collection('users').doc('u_pm').get()).data()).toMatchObject({ companyId: null, role: null, status: 'deactivated' })

    expect(await stateOf()).toMatchObject({ requestSeq: 1, completedSeq: 0, requestedBy: 'u_admin', requestReason: 'member.deactivated' })
    expect(await markerExists()).toBe(true)
    const m = await memberDoc('u_pm')
    expect(m.fileLinkRevocationSeq).toBe(1)
    expect(m.fileAccessReducedAt.toMillis()).toBe(now().getTime())
    const [event] = await audits('file_links.revocation_requested')
    expect(event).toMatchObject({ actorUid: 'u_admin', targetUid: 'u_pm', after: { seq: 1, reason: 'member.deactivated' }, source: 'callable' })

    // Nothing has touched Storage, and the status says so.
    expect(tokensLeft(bucket, `companies/${COMPANY_A}/`)).toBe(5)
    expect(bucket.calls.list).toHaveLength(0)
    expect((await rowOf('u_pm')).fileLinks).toMatchObject({ status: 'pending', lastCompletedAt: null })
  })

  it('a refused deactivation queues nothing', async () => {
    await expectTeamError(H.deactivateMember(req('u_admin', { uid: 'u_admin' })), A.CODE.SELF_TARGET)
    await expectTeamError(H.deactivateMember(req('u_admin', { uid: 'u_nobody' })), A.CODE.NOT_FOUND)
    await expectTeamError(H.deactivateMember(req('u_admin', { uid: 'u_other' })), A.CODE.NOT_FOUND)
    expect(await stateOf()).toBe(null)
    expect(await markerExists()).toBe(false)
    expect(await stateOf(COMPANY_B)).toBe(null)
  })

  it('a repeated deactivation is idempotent — no second request', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    const again = await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    expect(again).toMatchObject({ changed: false, fileLinks: null })
    expect((await stateOf()).requestSeq).toBe(1)
    expect(await audits('file_links.revocation_requested')).toHaveLength(1)
  })

  it('two concurrent deactivations get distinct, consecutive sequences and share one marker', async () => {
    await Promise.all([H.deactivateMember(req('u_admin', { uid: 'u_pm' })), H.deactivateMember(req('u_admin', { uid: 'u_qs' }))])
    const seqs = [(await memberDoc('u_pm')).fileLinkRevocationSeq, (await memberDoc('u_qs')).fileLinkRevocationSeq].sort()
    expect(seqs).toEqual([1, 2])
    expect((await stateOf()).requestSeq).toBe(2)
    expect((await A.db.collection('companies').doc(COMPANY_A).collection(R.QUEUE_COLLECTION).get()).size).toBe(1)
  })

  it('a role change inside the internal set reduces no file access and queues nothing', async () => {
    const res = await H.changeMemberRole(req('u_admin', { uid: 'u_pm', role: 'qs', expectedRole: 'project_manager' }))
    expect(res).toMatchObject({ changed: true, fileLinksRevocationQueued: false })
    expect(await stateOf()).toBe(null)
    expect(await markerExists()).toBe(false)
    expect((await rowOf('u_pm')).fileLinks).toBe(null)
  })

  it('a role change that leaves the internal set queues a sweep in the same transaction; the callable cannot request one today', async () => {
    // The callable only assigns internal roles (ADR-72), so this path is
    // exercised at the library boundary — it is wired for when that changes.
    await expectTeamError(H.changeMemberRole(req('u_admin', { uid: 'u_pm', role: 'subcontractor', expectedRole: 'project_manager' })), A.CODE.INVALID_ROLE)
    expect(await stateOf()).toBe(null)

    const res = await A.members.changeMemberRole(deps, { companyId: COMPANY_A, actor: { uid: 'u_admin' }, uid: 'u_pm', role: 'subcontractor', expectedRole: 'project_manager' })
    expect(res).toMatchObject({ changed: true, fileLinksRevocationQueued: true })
    expect((await A.db.collection('users').doc('u_pm').get()).data()).toMatchObject({ companyId: COMPANY_A, role: 'subcontractor' })
    expect(await stateOf()).toMatchObject({ requestSeq: 1, requestReason: 'member.role_reduced' })
    expect((await memberDoc('u_pm')).fileLinkRevocationSeq).toBe(1)
    expect(await markerExists()).toBe(true)
    const [event] = await audits('file_links.revocation_requested')
    expect(event.after).toEqual({ seq: 1, reason: 'member.role_reduced' })
  })
})

describe('the worker', () => {
  it('does nothing when nothing is queued', async () => {
    expect(await runWorker()).toEqual([])
    expect(bucket.calls.list).toHaveLength(0)
  })

  it('sweeps the company, removes only tokens, completes, audits, clears the marker — and never touches another company', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    now.advance(30_000)
    const [r] = await runWorker()
    expect(r).toMatchObject({ companyId: COMPANY_A, action: 'complete', seq: 1, scanned: 5, removed: 5, failed: 0, more: false })

    expect(tokensLeft(bucket, `companies/${COMPANY_A}/`)).toBe(0)
    expect(tokensLeft(bucket, `companies/${COMPANY_B}/`)).toBe(3)
    for (const [name, o] of bucket.store) if (name.startsWith(`companies/${COMPANY_A}/`)) expect(o.metadata).toEqual({ keep: 'yes' })
    expect(bucket.calls.list.every(q => q.prefix === `companies/${COMPANY_A}/`)).toBe(true)
    for (const c of bucket.calls.patch) {
      expect(c.patch).toEqual({ metadata: { [TOKEN]: null } })
      expect(c.options).toEqual({ ifGenerationMatch: '1000', ifMetagenerationMatch: '1' })
    }

    const st = await stateOf()
    expect(st).toMatchObject({ requestSeq: 1, completedSeq: 1, consecutiveIncomplete: 0, lastPass: { seq: 1, scanned: 5, removed: 5, failed: 0, complete: true } })
    expect(st.pass).toBeUndefined()
    expect(st.lease).toBeUndefined()
    expect(st.completedAt.toMillis()).toBe(now().getTime())
    expect(await markerExists()).toBe(false)
    const [event] = await audits('file_links.revoked')
    expect(event).toMatchObject({ source: 'worker', after: { seq: 1, scanned: 5, removed: 5, failed: 0 } })
    expect((await rowOf('u_pm')).fileLinks).toMatchObject({ status: 'revoked', lastCompletedAt: now().toISOString() })
    expect(await stateOf(COMPANY_B)).toBe(null)
  })

  it('checkpoints after every page', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    const r = await sweep('worker:test', { pageSize: 2 })
    expect(r).toMatchObject({ action: 'complete', pages: 3, scanned: 5, removed: 5 })
    expect(bucket.calls.list.map(q => q.pageToken ?? null)).toEqual([null, drawingObject(COMPANY_A, 2), drawingObject(COMPANY_A, 4)])
  })

  it('an interrupted sweep is NOT complete, keeps its checkpoint, and the next run resumes from it', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    let fail = true
    bucket.hooks.listError = (pageToken) => (pageToken && fail ? 503 : null)
    const first = await sweep('worker:one', { pageSize: 2 })
    expect(first.action).toBe('error')

    let st = await stateOf()
    expect(st.completedSeq).toBe(0)
    expect(st.pass).toMatchObject({ seq: 1, pages: 1, scanned: 2, removed: 2, failed: 0, pageToken: drawingObject(COMPANY_A, 2) })
    expect(st.lease).toBeUndefined()
    expect(await markerExists()).toBe(true)
    expect((await rowOf('u_pm')).fileLinks.status).toBe('pending')
    expect(await audits('file_links.revoked')).toHaveLength(0)

    fail = false
    const listsBefore = bucket.calls.list.length
    const [second] = await runWorker('worker:two', { pageSize: 2 })
    expect(second).toMatchObject({ action: 'complete', seq: 1, pages: 3, scanned: 5, removed: 5, failed: 0 })
    // Resumed from the checkpoint — the first page was not listed again.
    expect(bucket.calls.list[listsBefore].pageToken).toBe(drawingObject(COMPANY_A, 2))
    st = await stateOf()
    expect(st.completedSeq).toBe(1)
    // The sweep is still the one that started before the interruption.
    expect(st.completedPassStartedAt.toMillis()).toBe(Date.parse('2026-11-12T10:00:00Z'))
    expect((await rowOf('u_pm')).fileLinks.status).toBe('revoked')
  })

  it('a worker that crashed without releasing blocks others only until its lease expires', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    // Simulate a crash: a lease and an open sweep left behind by another worker.
    await R.stateRef(A.db, COMPANY_A).update({
      pass: { seq: 1, startedAt: A.Timestamp.fromDate(now()), pageToken: null, pages: 0, scanned: 0, removed: 0, failed: 0 },
      lease: { owner: 'worker:dead', expiresAt: A.Timestamp.fromMillis(now().getTime() + R.LEASE_MS) },
    })
    expect((await sweep('worker:live')).action).toBe('busy')
    expect(bucket.calls.list).toHaveLength(0)
    expect(tokensLeft(bucket, `companies/${COMPANY_A}/`)).toBe(5)

    now.advance(R.LEASE_MS + 1)
    expect((await sweep('worker:live')).action).toBe('complete')
    expect(tokensLeft(bucket, `companies/${COMPANY_A}/`)).toBe(0)
  })

  it('a worker whose lease was taken over stops and writes nothing more', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    let stolen = false
    bucket.hooks.beforePatch = async () => {
      if (stolen) return
      stolen = true
      await R.stateRef(A.db, COMPANY_A).update({ lease: { owner: 'worker:other', expiresAt: A.Timestamp.fromMillis(now().getTime() + R.LEASE_MS) } })
    }
    const r = await sweep('worker:slow', { pageSize: 2 })
    expect(r.action).toBe('lease-lost')
    const st = await stateOf()
    expect(st.lease.owner).toBe('worker:other')
    expect(st.pass).toMatchObject({ pages: 0, scanned: 0 })
    expect(st.completedSeq).toBe(0)
  })

  it('NEVER completes while an object failed: status is delayed, the request stays queued, retries back off, and a later clean sweep completes', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    const bad = drawingObject(COMPANY_A, 3)
    bucket.hooks.patchError = (name) => (name === bad ? 403 : null)

    const r1 = await sweep()
    expect(r1).toMatchObject({ action: 'incomplete', scanned: 5, removed: 4, failed: 1, consecutiveIncomplete: 1 })
    let st = await stateOf()
    expect(st).toMatchObject({ completedSeq: 0, consecutiveIncomplete: 1, lastPass: { complete: false, failed: 1 } })
    expect(st.pass).toBeUndefined()
    expect(await markerExists()).toBe(true)
    expect(tokensLeft(bucket, `companies/${COMPANY_A}/`)).toBe(1)
    expect((await rowOf('u_pm')).fileLinks).toMatchObject({ status: 'delayed', outstanding: 1 })
    expect(await audits('file_links.revoked')).toHaveLength(0)
    expect(await audits('file_links.revocation_incomplete')).toHaveLength(1)
    expect(log.lines.some(l => l.level === 'warn' && l.msg.includes('sweep incomplete'))).toBe(true)

    // An immediate re-run backs off rather than hammering the same object.
    expect((await sweep()).action).toBe('backoff')

    // Retries keep failing: escalates to an error-level log at the threshold,
    // and the audit trail is not flooded.
    now.advance(61_000); expect((await sweep()).consecutiveIncomplete).toBe(2)
    now.advance(121_000); expect((await sweep()).consecutiveIncomplete).toBe(3)
    expect(log.lines.some(l => l.level === 'error' && l.msg.includes('sweep incomplete'))).toBe(true)
    expect(await audits('file_links.revocation_incomplete')).toHaveLength(2)
    expect((await rowOf('u_pm')).fileLinks.status).toBe('delayed')

    // Fixed: the next sweep is clean and only then is the member revoked.
    bucket.hooks.patchError = null
    now.advance(R.MAX_BACKOFF_MS)
    const ok = await sweep()
    expect(ok).toMatchObject({ action: 'complete', removed: 1, failed: 0 })
    st = await stateOf()
    expect(st).toMatchObject({ completedSeq: 1, consecutiveIncomplete: 0 })
    expect(st.nextAttemptAt).toBeUndefined()
    expect(await markerExists()).toBe(false)
    expect((await rowOf('u_pm')).fileLinks.status).toBe('revoked')
  })

  // Stage 0 regression (12 November 2026): the deployed worker misread the
  // real client's listing shape, removed nothing and reported COMPLETE. With
  // the fail-closed shape check, a misread listing is an interrupted sweep:
  // nothing is completed, nobody is shown as revoked, and the request waits.
  it('NEVER reports revoked from a listing it cannot read: objects without version counters interrupt the sweep', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    const realGetFiles = bucket.getFiles.bind(bucket)
    // What the real client returns under a field mask, minus the counters —
    // the shape the defective code silently read as "no token".
    bucket.getFiles = async (q) => {
      const [files, next] = await realGetFiles(q)
      return [files.map(({ name, metadata }) => ({ name, ...(metadata ? { metadata } : {}) })), next]
    }
    for (let i = 0; i < 3; i += 1) {
      expect((await sweep()).action).toBe('error')
      now.advance(R.LEASE_MS + 1)
    }
    const st = await stateOf()
    expect(st.completedSeq).toBe(0)
    expect(st.lastPass).toBeUndefined()
    expect(await markerExists()).toBe(true)
    expect(await audits('file_links.revoked')).toHaveLength(0)
    expect(tokensLeft(bucket, `companies/${COMPANY_A}/`)).toBe(5)
    expect((await rowOf('u_pm')).fileLinks.status).not.toBe('revoked')
    expect(log.lines.some(l => l.level === 'error' && l.msg.includes('sweep interrupted'))).toBe(true)
    // Read correctly again: the same request completes and only then revokes.
    bucket.getFiles = realGetFiles
    expect((await sweep()).action).toBe('complete')
    expect((await rowOf('u_pm')).fileLinks.status).toBe('revoked')
    expect(tokensLeft(bucket, `companies/${COMPANY_A}/`)).toBe(0)
  })

  it('a new deactivation is not held back by an earlier sweep\'s retry backoff', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    bucket.hooks.patchError = () => 403
    await sweep()
    expect((await sweep()).action).toBe('backoff')
    bucket.hooks.patchError = null
    await H.deactivateMember(req('u_admin', { uid: 'u_qs' }))
    expect((await sweep()).action).toBe('complete')
    expect((await rowOf('u_pm')).fileLinks.status).toBe('revoked')
    expect((await rowOf('u_qs')).fileLinks.status).toBe('revoked')
  })

  it('a deactivation DURING a sweep is not covered by it: that member stays pending until a sweep that started after them completes', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    let fired = false
    bucket.hooks.beforePatch = async () => {
      if (fired) return
      fired = true
      await H.deactivateMember(req('u_admin', { uid: 'u_qs' }))
    }
    const first = await sweep()
    expect(first).toMatchObject({ action: 'complete', seq: 1, more: true })
    expect(await stateOf()).toMatchObject({ requestSeq: 2, completedSeq: 1 })
    expect(await markerExists()).toBe(true)
    expect((await rowOf('u_pm')).fileLinks.status).toBe('revoked')
    expect((await rowOf('u_qs')).fileLinks.status).toBe('pending')

    // u_qs could have minted a link on an already-swept object before losing
    // access. The next sweep is what removes it.
    bucket.store.get(drawingObject(COMPANY_A, 1)).metadata[TOKEN] = 'SECRET-TOKEN-reminted-do-not-leak'
    const second = await sweep()
    expect(second).toMatchObject({ action: 'complete', seq: 2, removed: 1, more: false })
    expect(tokensLeft(bucket, `companies/${COMPANY_A}/`)).toBe(0)
    expect(await markerExists()).toBe(false)
    expect((await rowOf('u_qs')).fileLinks.status).toBe('revoked')
    expect(await audits('file_links.revoked')).toHaveLength(2)
  })

  it('one worker run follows a mid-sweep request with a second sweep', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    let fired = false
    bucket.hooks.beforePatch = async () => { if (!fired) { fired = true; await H.deactivateMember(req('u_admin', { uid: 'u_qs' })) } }
    const results = await runWorker()
    expect(results.map(r => [r.action, r.seq])).toEqual([['complete', 1], ['complete', 2]])
    expect((await stateOf()).completedSeq).toBe(2)
  })

  it('processes every queued company independently; a failure in one does not block another', async () => {
    await seedUser({ uid: 'u_other_pm', email: 'pm@other.test', role: 'project_manager', companyId: COMPANY_B })
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    await H.deactivateMember(req('u_other', { uid: 'u_other_pm' }))
    bucket.hooks.patchError = (name) => (name.startsWith(`companies/${COMPANY_A}/`) ? 403 : null)
    const results = await runWorker()
    expect(Object.fromEntries(results.map(r => [r.companyId, r.action]))).toEqual({ [COMPANY_A]: 'incomplete', [COMPANY_B]: 'complete' })
    expect(tokensLeft(bucket, `companies/${COMPANY_B}/`)).toBe(0)
    expect((await stateOf(COMPANY_B)).completedSeq).toBe(1)
    expect((await stateOf(COMPANY_A)).completedSeq).toBe(0)
  })

  it('ignores queue-named documents that are not companies/{c}/fileLinkRevocationQueue/pending, and clears a marker with no request behind it', async () => {
    await A.db.doc(`companies/${COMPANY_A}/projects/p1/${R.QUEUE_COLLECTION}/pending`).set({ stray: true })
    await A.db.doc(`companies/${COMPANY_A}/${R.QUEUE_COLLECTION}/other`).set({ stray: true })
    await R.markerRef(A.db, COMPANY_B).set({ companyId: COMPANY_B })
    const results = await runWorker()
    expect(results).toEqual([{ companyId: COMPANY_B, action: 'none' }])
    expect(await markerExists(COMPANY_B)).toBe(false)
    expect(bucket.calls.list).toHaveLength(0)
    expect(bucket.calls.patch).toHaveLength(0)
  })

  it('respects its time budget and leaves the rest for the next run', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    const r = await R.processCompany(workerDeps(), COMPANY_A, { owner: 'worker:test', deadlineMs: now().getTime(), sweepOptions })
    expect(r.action).toBe('yielded')
    const st = await stateOf()
    expect(st.pass).toMatchObject({ seq: 1, pages: 0 })
    expect(st.lease).toBeUndefined()
    expect((await sweep()).action).toBe('complete')
  })
})

describe('operator requests and members deactivated before this feature', () => {
  it('an operator request refuses an unknown company and sweeps a real one', async () => {
    await expect(R.requestRevocation({ db: A.db, now }, { companyId: 'no-such-company' })).rejects.toThrow(/does not exist/)
    await expect(R.requestRevocation({ db: A.db, now }, { companyId: 'bad/id' })).rejects.toThrow(/invalid company id/)
    expect(await R.requestRevocation({ db: A.db, now }, { companyId: COMPANY_A })).toBe(1)
    expect(await stateOf()).toMatchObject({ requestSeq: 1, requestReason: 'operator', requestedBy: 'operator' })
    const r = await R.processCompany(workerDeps(), COMPANY_A, { owner: 'operator:1:1', sweepOptions })
    expect(r.action).toBe('complete')
    expect((await audits('file_links.revoked'))[0].source).toBe('operator')
  })

  it('a legacy deactivated member shows "not requested" until a sweep that started clearly after their deactivation completes', async () => {
    // As ADR-72 left it: deactivated, no sequence.
    await A.db.collection('users').doc('u_pm').update({ companyId: null, role: null, status: 'deactivated', formerCompanyId: COMPANY_A })
    await A.db.collection('companies').doc(COMPANY_A).collection('members').doc('u_pm').set({
      email: 'pm@acme.test', name: 'u_pm', role: 'project_manager', status: 'deactivated', deactivatedAt: A.Timestamp.fromDate(now()),
    })
    expect((await rowOf('u_pm')).fileLinks.status).toBe('not_requested')

    now.advance(R.LEGACY_MARGIN_MS + 1000)
    await R.requestRevocation({ db: A.db, now }, { companyId: COMPANY_A })
    expect((await rowOf('u_pm')).fileLinks.status).toBe('pending')
    await sweep('operator:1:1')
    expect((await rowOf('u_pm')).fileLinks.status).toBe('revoked')
  })
})

describe('the operator run (scripts/revoke-file-links.mjs)', () => {
  const output = () => {
    const lines = []
    return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`) }
  }
  let O
  beforeAll(async () => { O = await import('../../functions/src/lib/fileLinkOperator.js') })
  const run = (out, opts) => O.runOperator({ db: A.db, bucket, now, out, sleep: async () => { now.advance(R.LEASE_MS + 1) } }, { owner: 'operator:1:1', sweepOptions, ...opts })

  it('the default is a read-only inventory: counts only, nothing requested, nothing changed', async () => {
    const out = output()
    const summary = await run(out, { companyIds: [COMPANY_A, COMPANY_B] })
    expect(summary).toEqual([
      { companyId: COMPANY_A, scanned: 5, withToken: 5, pages: 1, executed: false, complete: null },
      { companyId: COMPANY_B, scanned: 3, withToken: 3, pages: 1, executed: false, complete: null },
    ])
    expect(bucket.calls.patch).toHaveLength(0)
    expect(tokensLeft(bucket)).toBe(8)
    expect(await stateOf()).toBe(null)
    expect(await markerExists()).toBe(false)
    expect(await audits('file_links.revocation_requested')).toHaveLength(0)
    expect(out.lines.join('\n')).toContain(`${COMPANY_A}: 5 object(s), 5 with a download token`)
    expect(out.lines.join('\n')).not.toContain('SECRET-TOKEN')
  })

  it('execute sweeps ONLY the companies in scope, through the worker\'s own path, and audits as operator', async () => {
    const out = output()
    const summary = await run(out, { companyIds: [COMPANY_A], execute: true })
    expect(summary).toEqual([{ companyId: COMPANY_A, scanned: 5, withToken: 5, pages: 1, executed: true, complete: true, removed: 5, failed: 0 }])
    expect(tokensLeft(bucket, `companies/${COMPANY_A}/`)).toBe(0)
    expect(tokensLeft(bucket, `companies/${COMPANY_B}/`)).toBe(3)
    expect(await stateOf()).toMatchObject({ requestSeq: 1, completedSeq: 1, requestReason: 'operator' })
    expect(await stateOf(COMPANY_B)).toBe(null)
    expect((await audits('file_links.revoked'))[0]).toMatchObject({ source: 'operator', after: { removed: 5, failed: 0 } })
    expect(out.lines.join('\n')).not.toContain('SECRET-TOKEN')
  })

  it('reports a company that did not complete — it never claims success while an object failed', async () => {
    bucket.hooks.patchError = (name) => (name === drawingObject(COMPANY_A, 1) ? 403 : null)
    const out = output()
    const [s] = await run(out, { companyIds: [COMPANY_A], execute: true })
    expect(s).toMatchObject({ executed: true, complete: false, failed: 1 })
    expect(out.lines.some(l => l.startsWith('WARN') && l.includes('NOT complete'))).toBe(true)
    expect(out.lines.some(l => l.includes('→ complete'))).toBe(false)
    expect((await stateOf()).completedSeq).toBe(0)
    expect(await markerExists()).toBe(true)
  })

  it('waits for a lease held by the scheduled worker, then finishes', async () => {
    await R.requestRevocation({ db: A.db, now }, { companyId: COMPANY_A })
    await R.stateRef(A.db, COMPANY_A).update({ lease: { owner: 'worker:busy', expiresAt: A.Timestamp.fromMillis(now().getTime() + R.LEASE_MS) } })
    const out = output()
    const [s] = await run(out, { companyIds: [COMPANY_A], execute: true })
    expect(out.lines.some(l => l.includes('busy; waiting'))).toBe(true)
    expect(s).toMatchObject({ complete: true })
    expect((await stateOf()).completedSeq).toBe(2)
  })
})

describe('nothing leaks, and the browser cannot see or forge the state', () => {
  it('no token value reaches Firestore, the audit trail, the logs, a result or listTeam', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    bucket.hooks.patchError = (name) => (name === drawingObject(COMPANY_A, 2) ? 500 : null)
    const r1 = await sweep()
    bucket.hooks.patchError = null
    now.advance(R.MAX_BACKOFF_MS)
    const r2 = await runWorker()
    const team = await H.listTeam(req('u_admin'))

    const dump = []
    for (const path of ['system', R.QUEUE_COLLECTION, 'auditEvents', 'members']) {
      for (const d of (await A.db.collection('companies').doc(COMPANY_A).collection(path).get()).docs) dump.push(d.data())
    }
    const everything = JSON.stringify({ dump, log: log.lines, r1, r2, team })
    expect(dump.length).toBeGreaterThan(4)
    expect(everything).not.toContain('SECRET-TOKEN')
    expect(everything).not.toContain(TOKEN)
  })

  it('Firestore Rules deny every browser read and write of the state, the queue and the audit trail — even to a company admin', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    await clientSignIn('admin@acme.test')
    const { db } = clientSdk()
    const denied = async (p) => { try { await p } catch (e) { return e?.code === 'permission-denied' } return false }
    const state = doc(db, 'companies', COMPANY_A, 'system', 'fileLinkRevocation')
    const marker = doc(db, 'companies', COMPANY_A, R.QUEUE_COLLECTION, 'pending')
    expect(await denied(getDoc(state))).toBe(true)
    expect(await denied(getDoc(marker))).toBe(true)
    expect(await denied(getDocs(collection(db, 'companies', COMPANY_A, R.QUEUE_COLLECTION)))).toBe(true)
    expect(await denied(getDocs(collection(db, 'companies', COMPANY_A, 'auditEvents')))).toBe(true)
    // An admin cannot mark their own company "revoked", or cancel a request.
    expect(await denied(setDoc(state, { completedSeq: 99 }, { merge: true }))).toBe(true)
    expect(await denied(setDoc(marker, { companyId: COMPANY_A }))).toBe(true)
    expect(await denied(setDoc(doc(db, 'companies', COMPANY_A, 'members', 'u_pm'), { fileLinkRevocationSeq: 0 }, { merge: true }))).toBe(true)
    expect((await stateOf()).completedSeq).toBe(0)
  })
})
