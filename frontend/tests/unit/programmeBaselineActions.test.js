import { describe, it, expect } from 'vitest'
import {
  runBaselineCapture, runBaselineApprove, runBaselineWithdraw, checkBaselineDrift, readProgrammeFromServer,
  BaselineWriteError, BASELINE_ERROR, BASELINE_ERROR_MESSAGES,
} from '../../src/lib/programmeBaselineActions'
import { ACTIVITY_STATUS } from '../../src/lib/projectTimeline'

// ── Programme baseline writes (ADR-66) — fake Firestore, real action layer ───
//
// A fake `runTransaction` serves scripted reads and records writes, and a
// fake `getDocsFromServer` serves the "server" programme — so these prove
// the ORDER (server read, then the pair in one transaction; drift read
// before the approve transaction; every read before the write), the
// compare-and-set, the refusals and the outcome mapping, without an
// emulator. The emulator suite (tests/rules/programmeBaselines.rules.test.js)
// runs the same functions against the real rules.

const ts = (s) => ({ seconds: s, nanoseconds: 0, isEqual(o) { return o?.seconds === s && o?.nanoseconds === 0 } })

const activity = (overrides = {}) => ({
  id: 'a1', name: 'Ground floor slab', description: '', isMilestone: false, status: ACTIVITY_STATUS.NOT_STARTED,
  plannedStart: '2026-10-05', plannedFinish: '2026-10-09', actualStart: null, actualFinish: null,
  percentComplete: 0, responsibleContactId: null, responsibleName: '', costCodeId: null, costCodeName: '',
  sortOrder: 10, notes: '', predecessors: [], cancelReason: '', cancelledAt: null, cancelledBy: null,
  revision: 2, createdAt: ts(1), createdBy: 'u_admin', updatedAt: ts(100), updatedBy: 'u_admin',
  ...overrides,
})

const draftHeader = (overrides = {}) => ({
  id: 'b1', name: 'Original programme', reason: 'Award', status: 'draft', activityCount: 2,
  approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
  revision: 1, createdAt: ts(10), createdBy: 'u_pm', updatedAt: ts(10), updatedBy: 'u_pm',
  ...overrides,
})

const entryOf = (a) => ({
  activityId: a.id, name: a.name, isMilestone: a.isMilestone, plannedStart: a.plannedStart, plannedFinish: a.plannedFinish,
  status: a.status, percentComplete: a.percentComplete, revision: a.revision, sortOrder: a.sortOrder, costCodeId: a.costCodeId,
})
const snapshotOf = (acts) => ({ id: 'b1', activityCount: acts.length, capturedAt: ts(10), capturedBy: 'u_pm', activities: acts.map(entryOf) })

// A fake Firestore. `server` is what getDocsFromServer returns (the
// programme), `docs` what transaction reads see.
function fake({ server = [], docs = {}, fail = null, serverFail = null } = {}) {
  const log = []
  const api = {
    log,
    writes: [],
    serverReads: 0,
    serverTimestamp: () => 'SERVER_TS',
    getDocsFromServer: async () => {
      api.serverReads += 1
      log.push(['server'])
      if (serverFail) { const e = new Error(serverFail); e.code = serverFail; throw e }
      return { docs: server.map(a => ({ id: a.id, data: () => { const rest = { ...a }; delete rest.id; return rest } })) }
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
const base = { db: {}, activitiesQuery: { q: true }, uid: 'u_pm' }
const sdk = (fs) => ({ runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp, getDocsFromServer: fs.getDocsFromServer })

describe('readProgrammeFromServer', () => {
  it('returns the server documents with ids; maps unreachable to OFFLINE and denied to PERMISSION', async () => {
    const fs = fake({ server: [activity({ id: 'x' })] })
    const rows = await readProgrammeFromServer({ activitiesQuery: {}, getDocsFromServer: fs.getDocsFromServer })
    expect(rows[0].id).toBe('x')
    expect(rows[0].name).toBe('Ground floor slab')
    const off = fake({ serverFail: 'unavailable' })
    await expect(readProgrammeFromServer({ activitiesQuery: {}, getDocsFromServer: off.getDocsFromServer })).rejects.toMatchObject({ kind: BASELINE_ERROR.OFFLINE })
    const denied = fake({ serverFail: 'permission-denied' })
    await expect(readProgrammeFromServer({ activitiesQuery: {}, getDocsFromServer: denied.getDocsFromServer })).rejects.toMatchObject({ kind: BASELINE_ERROR.PERMISSION })
  })
})

describe('runBaselineCapture', () => {
  const acts = [activity({ id: 'a1', sortOrder: 10 }), activity({ id: 'a2', name: 'Columns', sortOrder: 20, revision: 5 })]

  it('reads the SERVER first, then writes the header and the snapshot in ONE transaction, exactly once each', async () => {
    const fs = fake({ server: acts })
    const result = await runBaselineCapture({ ...base, headerRef: ref('b1'), snapshotRef: ref('s1'), input: { name: ' Original ', reason: ' Award ' }, ...sdk(fs) })
    expect(fs.serverReads).toBe(1)
    expect(fs.log).toEqual([['server'], ['tx'], ['set', 'b1'], ['set', 's1']])
    expect(result).toMatchObject({ id: 'b1', counts: { total: 2, captured: 2, live: 2, cancelledAtCapture: 0, milestones: 0, invalid: 0 } })
    expect(result.bytes).toBeGreaterThan(0)
    const [header, snapshot] = fs.writes
    expect(header.data).toEqual({
      name: 'Original', reason: 'Award', status: 'draft', activityCount: 2,
      approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
      revision: 1, createdAt: 'SERVER_TS', createdBy: 'u_pm', updatedAt: 'SERVER_TS', updatedBy: 'u_pm',
    })
    expect(snapshot.data).toEqual({ activityCount: 2, capturedAt: 'SERVER_TS', capturedBy: 'u_pm', activities: acts.map(entryOf) })
    expect(snapshot.data.activities[1].revision).toBe(5)
    // Never the listener: the caller passes no activities at all.
  })

  it('captures cancelled history with its status, in programme order', async () => {
    const fs = fake({ server: [activity({ id: 'c', sortOrder: 5, status: ACTIVITY_STATUS.CANCELLED }), ...acts] })
    const result = await runBaselineCapture({ ...base, headerRef: ref('b1'), snapshotRef: ref('s1'), input: { name: 'n', reason: 'r' }, ...sdk(fs) })
    expect(result.counts).toMatchObject({ captured: 3, live: 2, cancelledAtCapture: 1 })
    expect(fs.writes[1].data.activities.map(e => e.activityId)).toEqual(['c', 'a1', 'a2'])
  })

  it('refuses an invalid name or reason BEFORE reading the server; nothing is written', async () => {
    const fs = fake({ server: acts })
    await expect(runBaselineCapture({ ...base, headerRef: ref('b1'), snapshotRef: ref('s1'), input: { name: '', reason: 'r' }, ...sdk(fs) }))
      .rejects.toMatchObject({ kind: BASELINE_ERROR.INVALID })
    expect(fs.serverReads).toBe(0)
    expect(fs.writes).toHaveLength(0)
  })

  it('refuses — naming the records — when the server programme holds a malformed activity or a duplicate; nothing is written', async () => {
    const fs = fake({ server: [activity({ id: 'a1' }), activity({ id: 'a2', name: 'Bad', plannedFinish: '2026-10-01' })] })
    const err = await runBaselineCapture({ ...base, headerRef: ref('b1'), snapshotRef: ref('s1'), input: { name: 'n', reason: 'r' }, ...sdk(fs) }).catch(e => e)
    expect(err).toBeInstanceOf(BaselineWriteError)
    expect(err.kind).toBe(BASELINE_ERROR.INVALID)
    expect(err.message).toMatch(/1 activity cannot be captured/)
    expect(err.details.errors[0].reason).toBe('Bad has a planned finish before its planned start')
    expect(err.details.counts.invalid).toBe(1)
    expect(fs.writes).toHaveLength(0)
    expect(fs.log).toEqual([['server']])
  })

  it('refuses an oversized programme as OVERSIZED, never truncating', async () => {
    const huge = Array.from({ length: 2000 }, (_, i) => activity({ id: `a${i}`, sortOrder: i, costCodeId: 'c'.repeat(400) }))
    const fs = fake({ server: huge })
    const err = await runBaselineCapture({ ...base, headerRef: ref('b1'), snapshotRef: ref('s1'), input: { name: 'n', reason: 'r' }, ...sdk(fs) }).catch(e => e)
    expect(err.kind).toBe(BASELINE_ERROR.OVERSIZED)
    expect(err.message).toMatch(/nothing was truncated/)
    expect(fs.writes).toHaveLength(0)
  })

  it('an empty programme is refused; an offline server read is OFFLINE; no uid is PERMISSION', async () => {
    const empty = fake({ server: [] })
    await expect(runBaselineCapture({ ...base, headerRef: ref('b1'), snapshotRef: ref('s1'), input: { name: 'n', reason: 'r' }, ...sdk(empty) })).rejects.toMatchObject({ kind: BASELINE_ERROR.INVALID })
    const off = fake({ serverFail: 'unavailable' })
    const err = await runBaselineCapture({ ...base, headerRef: ref('b1'), snapshotRef: ref('s1'), input: { name: 'n', reason: 'r' }, ...sdk(off) }).catch(e => e)
    expect(err.kind).toBe(BASELINE_ERROR.OFFLINE)
    expect(err.message).toBe(BASELINE_ERROR_MESSAGES[BASELINE_ERROR.OFFLINE])
    expect(off.writes).toHaveLength(0)
    await expect(runBaselineCapture({ ...base, uid: null, headerRef: ref('b1'), snapshotRef: ref('s1'), input: { name: 'n', reason: 'r' }, ...sdk(fake({ server: acts })) })).rejects.toMatchObject({ kind: BASELINE_ERROR.PERMISSION })
  })

  it('a transaction failure maps to the error kind and nothing is reported as written', async () => {
    const fs = fake({ server: acts, fail: 'permission-denied' })
    await expect(runBaselineCapture({ ...base, headerRef: ref('b1'), snapshotRef: ref('s1'), input: { name: 'n', reason: 'r' }, ...sdk(fs) })).rejects.toMatchObject({ kind: BASELINE_ERROR.PERMISSION })
    const aborted = fake({ server: acts, fail: 'aborted' })
    await expect(runBaselineCapture({ ...base, headerRef: ref('b1'), snapshotRef: ref('s1'), input: { name: 'n', reason: 'r' }, ...sdk(aborted) })).rejects.toMatchObject({ kind: BASELINE_ERROR.STALE })
  })
})

describe('checkBaselineDrift', () => {
  it('reads the server and reports the drift; an unusable snapshot is refused before any read', async () => {
    const acts = [activity({ id: 'a1' }), activity({ id: 'a2' })]
    const fs = fake({ server: [activity({ id: 'a1', revision: 3 }), activity({ id: 'a2' }), activity({ id: 'a3' })] })
    const d = await checkBaselineDrift({ activitiesQuery: {}, getDocsFromServer: fs.getDocsFromServer, snapshot: snapshotOf(acts) })
    expect(d.changed.map(x => x.activityId)).toEqual(['a1'])
    expect(d.added.map(x => x.activityId)).toEqual(['a3'])
    expect(fs.serverReads).toBe(1)
    const bad = fake()
    await expect(checkBaselineDrift({ activitiesQuery: {}, getDocsFromServer: bad.getDocsFromServer, snapshot: { activities: 'x' } })).rejects.toMatchObject({ kind: BASELINE_ERROR.INVALID })
    expect(bad.serverReads).toBe(0)
  })
})

describe('runBaselineApprove', () => {
  const acts = [activity({ id: 'a1' }), activity({ id: 'a2' })]
  const snapshot = snapshotOf(acts)
  const args = (fs, extra = {}) => ({ ...base, headerRef: ref('b1'), snapshotRef: ref('s1'), seen: draftHeader(), snapshot, acknowledgedDriftKey: '', ...sdk(fs), ...extra })

  it('no drift: server read, then header + snapshot reads, then ONE stamps-only update with revision 2', async () => {
    const fs = fake({ server: acts, docs: { b1: draftHeader(), s1: snapshot } })
    const rev = await runBaselineApprove(args(fs))
    expect(rev).toBe(2)
    expect(fs.log).toEqual([['server'], ['tx'], ['get', 'b1'], ['get', 's1'], ['update', 'b1']])
    expect(fs.writes).toHaveLength(1)
    expect(fs.writes[0].data).toEqual({ status: 'approved', approvedAt: 'SERVER_TS', approvedBy: 'u_pm', revision: 2, updatedAt: 'SERVER_TS', updatedBy: 'u_pm' })
    expect(fs.writes[0].data).not.toHaveProperty('name')
  })

  it('drift not acknowledged → DRIFT with the drift attached; nothing is read in a transaction or written', async () => {
    const fs = fake({ server: [activity({ id: 'a1', revision: 9 }), activity({ id: 'a2' })], docs: { b1: draftHeader(), s1: snapshot } })
    const err = await runBaselineApprove(args(fs)).catch(e => e)
    expect(err.kind).toBe(BASELINE_ERROR.DRIFT)
    expect(err.details.drift.changed.map(x => x.activityId)).toEqual(['a1'])
    expect(fs.log).toEqual([['server']])
    expect(fs.writes).toHaveLength(0)
  })

  it('the acknowledged drift key must match the drift found NOW — a programme that moved again is refused', async () => {
    const moved = [activity({ id: 'a1', revision: 9 }), activity({ id: 'a2' })]
    const fs = fake({ server: moved, docs: { b1: draftHeader(), s1: snapshot } })
    const d = await checkBaselineDrift({ activitiesQuery: {}, getDocsFromServer: fs.getDocsFromServer, snapshot })
    expect(await runBaselineApprove(args(fs, { acknowledgedDriftKey: d.key }))).toBe(2)
    const again = fake({ server: [...moved, activity({ id: 'a3' })], docs: { b1: draftHeader(), s1: snapshot } })
    const err = await runBaselineApprove(args(again, { acknowledgedDriftKey: d.key })).catch(e => e)
    expect(err.kind).toBe(BASELINE_ERROR.DRIFT)
    expect(err.details.drift.added.map(x => x.activityId)).toEqual(['a3'])
    expect(again.writes).toHaveLength(0)
  })

  it('refuses MISSING, STALE (revision or stamps moved), a non-draft, and a missing or mismatched snapshot — nothing written', async () => {
    const missing = fake({ server: acts, docs: {} })
    await expect(runBaselineApprove(args(missing))).rejects.toMatchObject({ kind: BASELINE_ERROR.MISSING })
    const byRevision = fake({ server: acts, docs: { b1: draftHeader({ revision: 2 }), s1: snapshot } })
    await expect(runBaselineApprove(args(byRevision))).rejects.toMatchObject({ kind: BASELINE_ERROR.STALE })
    const byStamp = fake({ server: acts, docs: { b1: draftHeader({ updatedAt: ts(99), updatedBy: 'u_x' }), s1: snapshot } })
    await expect(runBaselineApprove(args(byStamp))).rejects.toMatchObject({ kind: BASELINE_ERROR.STALE })
    const approved = fake({ server: acts, docs: { b1: draftHeader({ status: 'approved' }), s1: snapshot } })
    const err = await runBaselineApprove(args(approved)).catch(e => e)
    expect(err.kind).toBe(BASELINE_ERROR.INVALID)
    expect(err.message).toMatch(/already approved/)
    const noSnapshot = fake({ server: acts, docs: { b1: draftHeader() } })
    await expect(runBaselineApprove(args(noSnapshot))).rejects.toMatchObject({ kind: BASELINE_ERROR.INVALID })
    const mismatch = fake({ server: acts, docs: { b1: draftHeader({ activityCount: 3 }), s1: snapshot } })
    await expect(runBaselineApprove(args(mismatch))).rejects.toMatchObject({ kind: BASELINE_ERROR.INVALID })
    for (const f of [missing, byRevision, byStamp, approved, noSnapshot, mismatch]) expect(f.writes).toHaveLength(0)
  })

  it('a pending (unstamped) copy and a missing uid are refused before any read', async () => {
    const fs = fake({ server: acts, docs: { b1: draftHeader(), s1: snapshot } })
    await expect(runBaselineApprove(args(fs, { seen: draftHeader({ updatedAt: null }) }))).rejects.toMatchObject({ kind: BASELINE_ERROR.PENDING })
    await expect(runBaselineApprove(args(fs, { uid: null }))).rejects.toMatchObject({ kind: BASELINE_ERROR.PERMISSION })
    expect(fs.serverReads).toBe(0)
  })

  it('never updates the snapshot', async () => {
    const fs = fake({ server: acts, docs: { b1: draftHeader(), s1: snapshot } })
    await runBaselineApprove(args(fs))
    expect(fs.writes.every(w => w.id === 'b1')).toBe(true)
  })
})

describe('runBaselineWithdraw', () => {
  const args = (fs, extra = {}) => ({ ...base, headerRef: ref('b1'), seen: draftHeader(), reason: ' Captured too early ', ...sdk(fs), ...extra })

  it('writes status, reason, stamps and revision 2 after the read', async () => {
    const fs = fake({ docs: { b1: draftHeader() } })
    expect(await runBaselineWithdraw(args(fs))).toBe(2)
    expect(fs.log).toEqual([['tx'], ['get', 'b1'], ['update', 'b1']])
    expect(fs.writes[0].data).toEqual({ status: 'withdrawn', withdrawnAt: 'SERVER_TS', withdrawnBy: 'u_pm', withdrawReason: 'Captured too early', revision: 2, updatedAt: 'SERVER_TS', updatedBy: 'u_pm' })
    expect(fs.serverReads).toBe(0)
  })

  it('refuses a blank reason, a stale copy and an approved baseline — approved history is never withdrawn', async () => {
    const fs = fake({ docs: { b1: draftHeader() } })
    await expect(runBaselineWithdraw(args(fs, { reason: '  ' }))).rejects.toMatchObject({ kind: BASELINE_ERROR.INVALID })
    const stale = fake({ docs: { b1: draftHeader({ revision: 2 }) } })
    await expect(runBaselineWithdraw(args(stale))).rejects.toMatchObject({ kind: BASELINE_ERROR.STALE })
    const approved = fake({ docs: { b1: draftHeader({ status: 'approved' }) } })
    await expect(runBaselineWithdraw(args(approved, { seen: draftHeader({ status: 'approved' }) }))).rejects.toMatchObject({ kind: BASELINE_ERROR.INVALID })
    for (const f of [fs, stale, approved]) expect(f.writes).toHaveLength(0)
  })
})

describe('error messages', () => {
  it('every kind has a message that states nothing was written or changed', () => {
    for (const kind of Object.values(BASELINE_ERROR)) {
      expect(BASELINE_ERROR_MESSAGES[kind]).toMatch(/Nothing was (written|changed|approved)|nothing was written|Wait a moment/i)
    }
    const e = new BaselineWriteError(BASELINE_ERROR.DRIFT)
    expect(e.name).toBe('BaselineWriteError')
    expect(e.message).toBe(BASELINE_ERROR_MESSAGES[BASELINE_ERROR.DRIFT])
  })
})
