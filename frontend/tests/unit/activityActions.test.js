import { describe, it, expect } from 'vitest'
import {
  runActivityCreate, runActivityUpdate, runActivityCancel, ActivityWriteError, ACTIVITY_WRITE_ERROR, ACTIVITY_WRITE_ERROR_MESSAGES,
} from '../../src/lib/activityActions'
import { ACTIVITY_STATUS, QUICK_ACTION_ERROR } from '../../src/lib/projectTimeline'

// ── Guarded activity writes (ADR-65) — fake Firestore, real action layer ─────
//
// The transaction body is exercised with a fake `runTransaction` that serves
// scripted reads and records writes, so these prove the ORDER (every read
// before the write), the compare-and-set (revision AND stamps), the
// server-current predecessor checks, the single revision increment and the
// outcome mapping — without an emulator. The emulator suite proves the same
// writes pass the rules.

const ts = (s) => ({ seconds: s, nanoseconds: 0, isEqual(o) { return o?.seconds === s && o?.nanoseconds === 0 } })

const stored = (overrides = {}) => ({
  id: 'a1',
  name: 'Ground floor slab',
  description: '',
  isMilestone: false,
  status: ACTIVITY_STATUS.NOT_STARTED,
  plannedStart: '2026-10-05',
  plannedFinish: '2026-10-09',
  actualStart: null,
  actualFinish: null,
  percentComplete: 0,
  responsibleContactId: null,
  responsibleName: '',
  costCodeId: null,
  costCodeName: '',
  sortOrder: 10,
  notes: '',
  cancelReason: '',
  cancelledAt: null,
  cancelledBy: null,
  revision: 2,
  createdAt: ts(1),
  createdBy: 'u_admin',
  updatedAt: ts(100),
  updatedBy: 'u_admin',
  ...overrides,
})

// The editor's input for an unchanged activity (dates/status as stored).
const input = (overrides = {}) => ({
  name: 'Ground floor slab', description: '', isMilestone: false, status: ACTIVITY_STATUS.NOT_STARTED,
  plannedStart: '2026-10-05', plannedFinish: '2026-10-09', actualStart: null, actualFinish: null,
  percentComplete: 0, responsibleContactId: null, responsibleName: '', costCodeId: null, costCodeName: '',
  sortOrder: 10, notes: '', predecessors: [], ...overrides,
})

// A fake Firestore: `docs` maps a ref key to the document data (or null).
function fake({ docs = {}, fail = null } = {}) {
  const log = []
  const api = {
    log,
    writes: [],
    attempts: 0,
    serverTimestamp: () => 'SERVER_TS',
    runTransaction: async (_db, fn) => {
      api.attempts += 1
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
const predecessorRef = (id) => ({ id })

describe('runActivityUpdate', () => {
  const base = { db: {}, ref: ref('a1'), predecessorRef, uid: 'u_pm' }

  it('writes the normalised fields + revision (stored + 1) + stamps, exactly once, after the read', async () => {
    const seen = stored()
    const fs = fake({ docs: { a1: stored() } })
    const rev = await runActivityUpdate({ ...base, seen, input: input({ name: 'Renamed', predecessors: [] }), runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp })
    expect(rev).toBe(3)
    expect(fs.writes).toHaveLength(1)
    expect(fs.writes[0].data).toMatchObject({ name: 'Renamed', revision: 3, updatedAt: 'SERVER_TS', updatedBy: 'u_pm', predecessors: [] })
    expect(fs.writes[0].data).not.toHaveProperty('createdAt')
    expect(fs.writes[0].data).not.toHaveProperty('cancelReason')
    expect(fs.log).toEqual([['get', 'a1'], ['update', 'a1']])
  })

  it('a legacy document (revision 1, no predecessors key) moves to 2 and gains predecessors: []', async () => {
    const legacy = stored({ revision: undefined })
    delete legacy.revision
    const fs = fake({ docs: { a1: legacy } })
    const rev = await runActivityUpdate({ ...base, seen: legacy, input: input(), runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp })
    expect(rev).toBe(2)
    expect(fs.writes[0].data.revision).toBe(2)
    expect(fs.writes[0].data.predecessors).toEqual([])
  })

  it('refuses STALE when the server revision differs, and when only the stamps differ (a legacy-session write)', async () => {
    const seen = stored({ revision: 2 })
    const byRevision = fake({ docs: { a1: stored({ revision: 3 }) } })
    await expect(runActivityUpdate({ ...base, seen, input: input(), runTransaction: byRevision.runTransaction, serverTimestamp: byRevision.serverTimestamp }))
      .rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.STALE })
    expect(byRevision.writes).toHaveLength(0)
    const byStamp = fake({ docs: { a1: stored({ revision: 2, updatedAt: ts(200), updatedBy: 'u_old_client' }) } })
    const err = await runActivityUpdate({ ...base, seen, input: input(), runTransaction: byStamp.runTransaction, serverTimestamp: byStamp.serverTimestamp }).catch(e => e)
    expect(err).toBeInstanceOf(ActivityWriteError)
    expect(err.kind).toBe(ACTIVITY_WRITE_ERROR.STALE)
    expect(err.message).toBe(ACTIVITY_WRITE_ERROR_MESSAGES[QUICK_ACTION_ERROR.STALE])
    expect(err.message).toMatch(/Nothing was saved/)
    expect(byStamp.writes).toHaveLength(0)
  })

  it('refuses a MISSING document, a cancelled server copy, and a locally-pending base, without writing', async () => {
    const gone = fake({ docs: { a1: null } })
    await expect(runActivityUpdate({ ...base, seen: stored(), input: input(), runTransaction: gone.runTransaction, serverTimestamp: gone.serverTimestamp }))
      .rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.MISSING })
    const cancelled = fake({ docs: { a1: stored({ status: ACTIVITY_STATUS.CANCELLED, cancelReason: 'x' }) } })
    await expect(runActivityUpdate({ ...base, seen: stored({ status: ACTIVITY_STATUS.CANCELLED }), input: input(), runTransaction: cancelled.runTransaction, serverTimestamp: cancelled.serverTimestamp }))
      .rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.INVALID })
    const pending = fake({ docs: { a1: stored() } })
    await expect(runActivityUpdate({ ...base, seen: stored({ updatedAt: null }), input: input(), runTransaction: pending.runTransaction, serverTimestamp: pending.serverTimestamp }))
      .rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.PENDING })
    expect(pending.attempts).toBe(0)
    expect(gone.writes.concat(cancelled.writes, pending.writes)).toHaveLength(0)
  })

  it('re-validates the merged document and refuses an invalid draft before any read', async () => {
    const fs = fake({ docs: { a1: stored() } })
    await expect(runActivityUpdate({ ...base, seen: stored(), input: input({ plannedFinish: '2026-10-01' }), runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp }))
      .rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.INVALID })
    expect(fs.attempts).toBe(0)
  })

  it('reads every NEW predecessor on the server BEFORE the write; a retained link is not re-read', async () => {
    const seen = stored({ predecessors: [{ activityId: 'old', type: 'FS', lagDays: 0 }] })
    const fs = fake({ docs: { a1: seen, p1: stored({ id: 'p1' }), p2: stored({ id: 'p2' }) } })
    await runActivityUpdate({ ...base, seen, input: input({ predecessors: [{ activityId: 'old', type: 'FS', lagDays: 0 }, { activityId: 'p1', type: 'FS', lagDays: 2 }, { activityId: 'p2', type: 'FS', lagDays: 0 }] }), runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp })
    expect(fs.log).toEqual([['get', 'a1'], ['get', 'p1'], ['get', 'p2'], ['update', 'a1']])
    expect(fs.writes[0].data.predecessors).toEqual([
      { activityId: 'old', type: 'FS', lagDays: 0 }, { activityId: 'p1', type: 'FS', lagDays: 2 }, { activityId: 'p2', type: 'FS', lagDays: 0 },
    ])
  })

  it('refuses a NEW predecessor that is missing, cancelled on the server, or the activity itself — nothing written', async () => {
    const missing = fake({ docs: { a1: stored(), ghost: null } })
    const e1 = await runActivityUpdate({ ...base, seen: stored(), input: input({ predecessors: [{ activityId: 'ghost', type: 'FS', lagDays: 0 }] }), runTransaction: missing.runTransaction, serverTimestamp: missing.serverTimestamp }).catch(e => e)
    expect(e1.kind).toBe(ACTIVITY_WRITE_ERROR.INVALID)
    expect(e1.message).toMatch(/not in this project/)
    const cancelled = fake({ docs: { a1: stored(), px: stored({ id: 'px', status: ACTIVITY_STATUS.CANCELLED }) } })
    const e2 = await runActivityUpdate({ ...base, seen: stored(), input: input({ predecessors: [{ activityId: 'px', type: 'FS', lagDays: 0 }] }), runTransaction: cancelled.runTransaction, serverTimestamp: cancelled.serverTimestamp }).catch(e => e)
    expect(e2.message).toMatch(/cancelled/)
    const self = fake({ docs: { a1: stored() } })
    const e3 = await runActivityUpdate({ ...base, seen: stored(), input: input({ predecessors: [{ activityId: 'a1', type: 'FS', lagDays: 0 }] }), runTransaction: self.runTransaction, serverTimestamp: self.serverTimestamp }).catch(e => e)
    expect(e3.message).toMatch(/itself/)
    expect(missing.writes.concat(cancelled.writes, self.writes)).toHaveLength(0)
  })

  it('a contention re-run that sees a newer copy is refused, never re-applied', async () => {
    const seen = stored()
    let call = 0
    const fs = {
      writes: [],
      serverTimestamp: () => 'SERVER_TS',
      runTransaction: async (_db, fn) => {
        const mk = (server) => ({
          get: async (r) => ({ id: r.id, exists: () => true, data: () => server }),
          update: (r, d) => fs.writes.push({ id: r.id, data: d }),
        })
        call += 1
        await fn(mk(stored()))                                  // discarded attempt (writes recorded but "lost")
        fs.writes.length = 0
        return fn(mk(stored({ revision: 3 })))                   // re-run against the newer copy
      },
    }
    await expect(runActivityUpdate({ ...base, seen, input: input(), runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp }))
      .rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.STALE })
    expect(call).toBe(1)
    expect(fs.writes).toHaveLength(0)
  })

  it('maps permission and offline failures, keeping the draft (nothing thrown but the kind)', async () => {
    for (const [code, kind] of [['permission-denied', ACTIVITY_WRITE_ERROR.PERMISSION], ['unavailable', ACTIVITY_WRITE_ERROR.OFFLINE], ['deadline-exceeded', ACTIVITY_WRITE_ERROR.OFFLINE], ['aborted', ACTIVITY_WRITE_ERROR.STALE]]) {
      const fs = fake({ fail: code })
      const err = await runActivityUpdate({ ...base, seen: stored(), input: input(), runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp }).catch(e => e)
      expect(err.kind, code).toBe(kind)
      expect(err.cause?.code).toBe(code)
    }
    const err = await runActivityUpdate({ ...base, uid: null, seen: stored(), input: input(), runTransaction: fake().runTransaction, serverTimestamp: () => 'x' }).catch(e => e)
    expect(err.kind).toBe(ACTIVITY_WRITE_ERROR.PERMISSION)
  })
})

describe('runActivityCreate', () => {
  it('sets revision 1, empty cancellation stamps, stamps and the predecessors key, after checking new sources', async () => {
    const fs = fake({ docs: { p1: stored({ id: 'p1' }) } })
    const id = await runActivityCreate({ db: {}, ref: ref('new1'), predecessorRef, uid: 'u_pm', input: input({ predecessors: [{ activityId: 'p1', type: 'FS', lagDays: 1 }] }), runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp })
    expect(id).toBe('new1')
    expect(fs.log).toEqual([['get', 'p1'], ['set', 'new1']])
    expect(fs.writes[0].data).toMatchObject({ revision: 1, cancelReason: '', cancelledAt: null, cancelledBy: null, createdBy: 'u_pm', createdAt: 'SERVER_TS', updatedBy: 'u_pm', predecessors: [{ activityId: 'p1', type: 'FS', lagDays: 1 }] })
  })

  it('refuses an invalid draft before any read, and a missing source without writing', async () => {
    const fs = fake()
    await expect(runActivityCreate({ db: {}, ref: ref('n'), predecessorRef, uid: 'u_pm', input: input({ name: '' }), runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp }))
      .rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.INVALID })
    expect(fs.attempts).toBe(0)
    const missing = fake({ docs: { ghost: null } })
    await expect(runActivityCreate({ db: {}, ref: ref('n'), predecessorRef, uid: 'u_pm', input: input({ predecessors: [{ activityId: 'ghost', type: 'FS', lagDays: 0 }] }), runTransaction: missing.runTransaction, serverTimestamp: missing.serverTimestamp }))
      .rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.INVALID })
    expect(missing.writes).toHaveLength(0)
  })
})

describe('runActivityCancel', () => {
  const base = { db: {}, ref: ref('a1'), uid: 'u_pm' }

  it('writes the cancellation keys + revision + stamps only, after the read', async () => {
    const fs = fake({ docs: { a1: stored() } })
    const rev = await runActivityCancel({ ...base, seen: stored(), reason: '  Descoped ', runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp })
    expect(rev).toBe(3)
    expect(fs.writes[0].data).toEqual({
      status: 'cancelled', cancelReason: 'Descoped', cancelledAt: 'SERVER_TS', cancelledBy: 'u_pm', revision: 3, updatedAt: 'SERVER_TS', updatedBy: 'u_pm',
    })
    expect(fs.log).toEqual([['get', 'a1'], ['update', 'a1']])
  })

  it('refuses stale, missing, already-cancelled and an empty reason', async () => {
    const stale = fake({ docs: { a1: stored({ revision: 5 }) } })
    await expect(runActivityCancel({ ...base, seen: stored(), reason: 'x', runTransaction: stale.runTransaction, serverTimestamp: stale.serverTimestamp })).rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.STALE })
    const gone = fake({ docs: { a1: null } })
    await expect(runActivityCancel({ ...base, seen: stored(), reason: 'x', runTransaction: gone.runTransaction, serverTimestamp: gone.serverTimestamp })).rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.MISSING })
    const done = fake({ docs: { a1: stored({ status: ACTIVITY_STATUS.CANCELLED }) } })
    await expect(runActivityCancel({ ...base, seen: stored({ status: ACTIVITY_STATUS.CANCELLED }), reason: 'x', runTransaction: done.runTransaction, serverTimestamp: done.serverTimestamp })).rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.INVALID })
    const empty = fake({ docs: { a1: stored() } })
    await expect(runActivityCancel({ ...base, seen: stored(), reason: '   ', runTransaction: empty.runTransaction, serverTimestamp: empty.serverTimestamp })).rejects.toMatchObject({ kind: ACTIVITY_WRITE_ERROR.INVALID })
    expect(empty.attempts).toBe(0)
    expect(stale.writes.concat(gone.writes, done.writes, empty.writes)).toHaveLength(0)
  })
})
