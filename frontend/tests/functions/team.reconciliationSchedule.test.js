import { beforeAll, beforeEach, afterEach, describe, it, expect } from 'vitest'
import { admin, resetEmulators, clientSignOutAll } from './_harness.js'
import { fakeBucket, seedObjects, drawingObject, SECRET, tokensLeft } from '../../functions/test/_fakeBucket.js'

// ── ADR-75 (DC46-C) — activation readiness: the scheduler over whole days ────
//
// The architect selected a 2-hour initial interval (17 November 2026) and
// rejected 1 hour: planning runs once an hour, so an interval EQUAL to the
// planning period lets sub-second Scheduler jitter decide whether a company is
// swept after ~1 h or ~2 h, and a ~2 h gap exceeds the overdue bound (two
// intervals). This suite proves the 2-hour behaviour with the REAL code.
//
// What is real: `runScheduledWorker` — the scheduled function's own body, fed
// the RAW interval text exactly as the deployed function reads it — and with
// it planning, eligibility, the cursor, the queue, leases, checkpoints,
// slices, pre-emption, retry and overdue, every transaction on the Firestore
// EMULATOR. Nothing in this file decides who is due or when a pass runs.
//
// What is simulated, and only this:
//   · the Scheduler — one invocation per minute, each starting 0–5 s after the
//     minute (seeded jitter; production showed ~2.0–2.6 s). An invocation due
//     while the previous one is still running is REFUSED, as `concurrency: 1`
//     with `maxInstances: 1` does in production;
//   · elapsed time inside a run — every clock read advances 1–15 ms (seeded),
//     so planning, acquiring and finishing happen at distinct instants;
//   · Cloud Storage — the ADR-74 fake bucket; an optional fixed cost per page.
// A seeded PRNG makes every run of this file identical. It proves nothing
// about real page latency or real Scheduler behaviour (ADR-75, Stage 4).

const S = 1000
const MIN = 60 * S
const H = 60 * MIN
const TOKEN = 'firebaseStorageDownloadTokens'
const START = Date.parse('2026-11-20T00:00:00Z')

let A, R, bucket

// mulberry32 — small, seeded, deterministic.
const prng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// A clock that moves forward a little on every read.
function tickingClock(startMs, rnd) {
  let t = startMs
  const now = () => { t += 1 + Math.floor(rnd() * 15); return new Date(t) }
  now.peek = () => t
  now.set = (ms) => { t = ms }
  now.advance = (ms) => { t += ms }
  return now
}

const recorder = (now) => {
  const lines = []
  const push = (level) => (msg, fields) => lines.push({ level, msg, fields, at: now.peek() })
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
}

const ts = (ms) => A.Timestamp.fromMillis(ms)
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : null)
const stateOf = async (c) => (await R.stateRef(A.db, c).get()).data() ?? null
const audits = async (c, type) =>
  (await A.db.collection('companies').doc(c).collection('auditEvents').get()).docs.map(d => d.data()).filter(e => !type || e.type === type)

async function seedCompany(id, { sweptAgoMs = null } = {}) {
  await A.db.collection('companies').doc(id).set({ name: id })
  if (sweptAgoMs !== null) {
    await R.stateRef(A.db, id).set({
      requestSeq: 1, completedSeq: 1, requestPriority: 'urgent',
      completedPassStartedAt: ts(START - sweptAgoMs), completedAt: ts(START - sweptAgoMs + S),
    })
  }
}

const plantToken = (name, n) => { bucket.store.get(name).metadata[TOKEN] = SECRET(`planted-${n}`) }

// Drive the real scheduled function body once a minute for `hours`.
//   hooks.before(k, now)   — runs before invocation k (inject a request, a token…)
//   hooks.after(k, results, now)
async function simulate({ hours, intervalRaw = '2', seed = 1, pageCostMs = 0, sweepOptions = {}, hooks = {} }) {
  const rnd = prng(seed)
  const now = tickingClock(START, rnd)
  const log = recorder(now)
  if (pageCostMs > 0) {
    const real = bucket.getFiles.bind(bucket)
    bucket.getFiles = async (q) => { now.advance(pageCostMs); return real(q) }
  }
  const deps = { db: A.db, bucket, now, log }
  const sweeps = {}            // companyId → [{ startMs, priority, removed }]
  const runs = []
  let refused = 0
  for (let k = 0; k < hours * 60; k += 1) {
    const tickMs = START + k * MIN + Math.floor(rnd() * 5 * S)
    if (now.peek() > tickMs) { refused += 1; continue }   // previous run still busy
    now.set(tickMs)
    await hooks.before?.(k, now)
    const results = await R.runScheduledWorker(deps, {
      owner: `worker:sim:${tickMs}`, reconcileIntervalRaw: intervalRaw, sweepOptions: { sleep: async () => {}, ...sweepOptions },
    })
    runs.push({ k, tickMs, results })
    for (const r of results) {
      if (r.action !== 'complete') continue
      const st = await stateOf(r.companyId)
      ;(sweeps[r.companyId] ??= []).push({
        startMs: ms(st.completedPassStartedAt), priority: st.lastPass?.priority ?? 'urgent', removed: r.removed, k,
      })
    }
    await hooks.after?.(k, results, now)
  }
  const heartbeats = log.lines.filter(l => l.msg === 'file-links: reconciliation plan complete')
  return { now, log, sweeps, runs, refused, heartbeats }
}

const gaps = (list) => list.slice(1).map((x, i) => x.startMs - list[i].startMs)
const errorLines = (log) => log.lines.filter(l => l.level === 'error')

beforeAll(async () => {
  A = await admin()
  R = await import('../../functions/src/lib/fileLinkRevocation.js')
})

beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  bucket = fakeBucket({})
})

afterEach(async () => { await clientSignOutAll() })

const LONG = 600_000

describe('2-hour interval — 30 hours of one-minute ticks with jitter', () => {
  it('first pass sweeps every due company at once; afterwards each company is swept every 2–3 hours, planning beats hourly, and nothing is ever overdue', async () => {
    // c1 swept 30 min before activation (not yet due); c2 never swept; c3 swept
    // 3 h before activation (due, not overdue) and holding two old tokens.
    await seedCompany('c1', { sweptAgoMs: 30 * MIN })
    await seedCompany('c2')
    await seedCompany('c3', { sweptAgoMs: 3 * H })
    bucket = fakeBucket({ ...seedObjects('c1', 3, { tokenEvery: 0 }), ...seedObjects('c2', 3, { tokenEvery: 0 }), ...seedObjects('c3', 3, { tokenEvery: 2 }) })
    expect(tokensLeft(bucket, 'companies/c3/')).toBe(1)
    let plantedAt = null
    const sim = await simulate({
      hours: 30, seed: 20261117,
      hooks: {
        // Hour 10: a token appears on c2 with no membership change (the
        // console/SDK case). It must be gone within interval + 1 h + minutes.
        before: async (k, now) => { if (k === 600) { plantToken(drawingObject('c2', 2), 1); plantedAt = now.peek() } },
      },
    })

    // Initial planning: the first invocation plans; c2 and c3 are swept on the
    // NEXT invocation (the run's periodic list was read before it planned).
    expect(sim.heartbeats[0].fields).toMatchObject({ passSeq: 1, examined: 3, requested: 2, overdue: 0 })
    expect(sim.sweeps.c2[0]).toMatchObject({ priority: 'periodic', k: 1 })
    expect(sim.sweeps.c3[0]).toMatchObject({ priority: 'periodic', k: 1, removed: 1 })
    // c1 waits for its own clock: first periodic sweep ≥ 2 h after its last one.
    expect(sim.sweeps.c1[0].startMs - (START - 30 * MIN)).toBeGreaterThanOrEqual(2 * H)

    // Subsequent eligibility: never sooner than the interval, never later than
    // interval + one planning period + the one-run queue delay + jitter.
    const all = []
    for (const c of ['c1', 'c2', 'c3']) {
      const list = sim.sweeps[c]
      expect(list.every(s => s.priority === 'periodic')).toBe(true)
      expect(list.length).toBeGreaterThanOrEqual(9)
      for (const g of gaps(list)) {
        expect(g).toBeGreaterThanOrEqual(2 * H)
        expect(g).toBeLessThanOrEqual(3 * H + 3 * MIN)
        all.push(g)
      }
    }
    // Both sides of the hourly planning boundary occurred: some companies were
    // due just before a pass (≈2 h), some just after (≈3 h). The jitter was real.
    expect(all.some(g => g < 2 * H + 5 * MIN)).toBe(true)
    expect(all.some(g => g > 2 * H + 55 * MIN)).toBe(true)
    // …and every gap stays far below the overdue bound (4 h).
    expect(Math.max(...all)).toBeLessThan(4 * H - 50 * MIN)

    // Planning boundaries: one pass an hour, never closer than an hour apart,
    // never more than one invocation late — far inside policy C's 3 hours.
    expect(sim.heartbeats.length).toBeGreaterThanOrEqual(29)
    const beat = sim.heartbeats.slice(1).map((b, i) => b.at - sim.heartbeats[i].at)
    expect(Math.min(...beat)).toBeGreaterThanOrEqual(H)
    expect(Math.max(...beat)).toBeLessThanOrEqual(H + 2 * MIN)
    expect(sim.heartbeats.map(b => b.fields.passSeq)).toEqual(sim.heartbeats.map((_, i) => i + 1))

    // No false overdue — not in the cursor, not in a log, not in the audit trail.
    expect(sim.heartbeats.every(b => b.fields.overdue === 0)).toBe(true)
    expect(errorLines(sim.log)).toEqual([])
    for (const c of ['c1', 'c2', 'c3']) {
      expect(await audits(c, 'file_links.reconciliation_overdue')).toEqual([])
      expect((await stateOf(c)).overdueSince).toBeUndefined()
    }

    // Empty-token sweeps write no audit; a sweep that removed a token writes
    // exactly one `file_links.reconciled`. No urgent audit was invented.
    expect((await audits('c1')).map(e => e.type)).toEqual([])
    expect((await audits('c3', 'file_links.reconciled'))).toHaveLength(1)
    expect((await audits('c2', 'file_links.reconciled'))).toHaveLength(1)
    expect(await audits('c3', 'file_links.revoked')).toEqual([])
    const removedC2 = sim.sweeps.c2.filter(s => s.removed > 0)
    expect(removedC2).toHaveLength(1)
    expect(removedC2[0].startMs - plantedAt).toBeLessThanOrEqual(3 * H + 3 * MIN)
    expect(tokensLeft(bucket)).toBe(0)
    expect(sim.refused).toBe(0)
  }, LONG)

  it('a different jitter seed gives the same guarantees (no seed-specific pass)', async () => {
    for (const c of ['a', 'b']) await seedCompany(c)
    bucket = fakeBucket({ ...seedObjects('a', 2, { tokenEvery: 0 }), ...seedObjects('b', 2, { tokenEvery: 0 }) })
    const sim = await simulate({ hours: 24, seed: 7 })
    for (const c of ['a', 'b']) {
      for (const g of gaps(sim.sweeps[c])) { expect(g).toBeGreaterThanOrEqual(2 * H); expect(g).toBeLessThanOrEqual(3 * H + 3 * MIN) }
      expect(sim.sweeps[c].every(s => s.removed === 0)).toBe(true)
      expect(await audits(c)).toEqual([])
    }
    expect(errorLines(sim.log)).toEqual([])
    expect(sim.heartbeats.length).toBeGreaterThanOrEqual(23)
  }, LONG)
})

describe('2-hour interval — urgent work keeps its priority across a day', () => {
  it('a deactivation-style request pre-empts an open periodic sweep, is served first, audited as urgent, and resets the clock; planning keeps beating', async () => {
    // `big` needs several invocations per sweep: 60 objects, 5 per page, 8 s a
    // page = 96 s of listing, against the 45 s routine share.
    await seedCompany('big')
    await seedCompany('small')
    bucket = fakeBucket({ ...seedObjects('big', 60, { tokenEvery: 0 }), ...seedObjects('small', 2, { tokenEvery: 0 }) })
    let injected = null
    let preemptRun = null
    const sim = await simulate({
      hours: 26, seed: 99, pageCostMs: 8 * S, sweepOptions: { pageSize: 5 },
      hooks: {
        after: async (k, results) => {
          // The first time `big`'s PERIODIC sweep yields mid-way after hour 6,
          // an urgent request for `big` arrives (what deactivateMember writes).
          if (injected === null && k > 360 && results.some(r => r.companyId === 'big' && r.action === 'yielded')) {
            const st = await stateOf('big')
            expect(st.pass).toMatchObject({ priority: 'periodic' })
            injected = { k, seq: await R.requestRevocation({ db: A.db, now: () => new Date(START + (k + 1) * MIN - 1) }, { companyId: 'big' }), periodicSeq: st.pass.seq }
          } else if (injected && preemptRun === null && k > injected.k) {
            preemptRun = { k, results }
          }
        },
      },
    })
    expect(injected).not.toBe(null)
    // The very next invocation served the urgent request FIRST and finished it.
    expect(preemptRun.k).toBe(injected.k + 1)
    expect(preemptRun.results[0]).toMatchObject({ companyId: 'big', action: 'complete', seq: injected.seq })
    expect(sim.log.lines.some(l => l.msg.includes('periodic sweep replaced by an urgent one'))).toBe(true)
    const revoked = await audits('big', 'file_links.revoked')
    expect(revoked).toHaveLength(1)
    expect(revoked[0].after.seq).toBe(injected.seq)
    // The abandoned periodic sweep was never recorded as complete.
    expect(sim.sweeps.big.some(s => s.priority === 'periodic' && s.k === injected.k)).toBe(false)
    // The urgent sweep reset the clock: the next periodic sweep of `big` is ≥ 2 h later.
    const urgentIdx = sim.sweeps.big.findIndex(s => s.priority === 'urgent')
    expect(urgentIdx).toBeGreaterThanOrEqual(0)
    const nextPeriodic = sim.sweeps.big[urgentIdx + 1]
    expect(nextPeriodic.priority).toBe('periodic')
    expect(nextPeriodic.startMs - sim.sweeps.big[urgentIdx].startMs).toBeGreaterThanOrEqual(2 * H)

    // Long sweeps did not starve planning or `small`, and raised no false overdue.
    for (const g of gaps(sim.sweeps.small)) expect(g).toBeLessThanOrEqual(3 * H + 5 * MIN)
    const beat = sim.heartbeats.slice(1).map((b, i) => b.at - sim.heartbeats[i].at)
    expect(Math.max(...beat)).toBeLessThanOrEqual(H + 3 * MIN)
    expect(errorLines(sim.log)).toEqual([])
    expect(await audits('big', 'file_links.reconciliation_overdue')).toEqual([])
    // The long urgent run overran the next minute; that tick was refused, as
    // concurrency 1 refuses it in production, and nothing was lost.
    expect(sim.refused).toBeGreaterThanOrEqual(1)
  }, LONG)
})

describe('2-hour interval — the existing retry and incomplete rules over a day', () => {
  it('failed token removals close sweeps as incomplete with backoff, never move the clock, then recover — without a false overdue', async () => {
    await seedCompany('c1', { sweptAgoMs: 10 * MIN })
    await seedCompany('c2', { sweptAgoMs: 10 * MIN })
    bucket = fakeBucket({ ...seedObjects('c1', 3, { tokenEvery: 0 }), ...seedObjects('c2', 3, { tokenEvery: 0 }) })
    const target = drawingObject('c1', 1)
    let failing = false
    let listFailures = 0
    bucket.hooks.patchError = (name) => (failing && name === target ? 503 : null)
    bucket.hooks.listError = () => (listFailures > 0 ? (listFailures -= 1, 503) : null)
    const clockAtSuccess = []
    let firstIncompleteK = null
    const sim = await simulate({
      hours: 26, seed: 4242,
      hooks: {
        before: async (k) => {
          // Hour 6: a token appears on c1 and removing it fails — until 20
          // minutes after the first sweep that hits the failure.
          if (k === 360) { plantToken(target, 1); failing = true }
          if (firstIncompleteK !== null && k === firstIncompleteK + 20) failing = false
          // Hour 12: two listings fail in a row (transient Storage errors).
          if (k === 720) listFailures = 2
        },
        after: async (k, results) => {
          if (results.some(r => r.companyId === 'c1' && r.action === 'incomplete')) {
            firstIncompleteK ??= k
            clockAtSuccess.push(ms((await stateOf('c1')).completedPassStartedAt))
          }
        },
      },
    })
    expect(firstIncompleteK).not.toBe(null)
    // Incomplete sweeps happened and were audited at the existing thresholds.
    const incomplete = sim.runs.flatMap(r => r.results).filter(r => r.companyId === 'c1' && r.action === 'incomplete')
    expect(incomplete.length).toBeGreaterThanOrEqual(1)
    expect((await audits('c1', 'file_links.revocation_incomplete')).length).toBeGreaterThanOrEqual(1)
    // An incomplete sweep never moves the eligibility clock.
    expect(new Set(clockAtSuccess).size).toBe(1)
    // Recovery: the token is gone, the counter is reset, the backlog cleared.
    expect(tokensLeft(bucket)).toBe(0)
    const st = await stateOf('c1')
    expect(st.consecutiveIncomplete).toBe(0)
    expect(st.nextAttemptAt).toBeUndefined()
    // The transient listing failures were resumed, not escalated.
    const errored = sim.runs.flatMap(r => r.results).filter(r => r.action === 'error')
    expect(errored.length).toBeGreaterThanOrEqual(1)
    // Despite both episodes, nobody went two intervals without a success.
    for (const c of ['c1', 'c2']) {
      for (const g of gaps(sim.sweeps[c])) expect(g).toBeLessThan(4 * H)
      expect(await audits(c, 'file_links.reconciliation_overdue')).toEqual([])
    }
    expect(sim.heartbeats.every(b => b.fields.overdue === 0)).toBe(true)
    expect(sim.log.lines.filter(l => l.msg.includes('reconciliation overdue'))).toEqual([])
  }, LONG)

  it('a REAL overdue is still detected at 2 hours: removals failing for 6 hours raise ONE overdue episode, cleared by the next success', async () => {
    await seedCompany('c1', { sweptAgoMs: 10 * MIN })
    bucket = fakeBucket(seedObjects('c1', 2, { tokenEvery: 0 }))
    const target = drawingObject('c1', 1)
    let failing = false
    bucket.hooks.patchError = (name) => (failing && name === target ? 503 : null)
    const sim = await simulate({
      hours: 24, seed: 5,
      hooks: { before: async (k) => { if (k === 120) { plantToken(target, 1); failing = true } if (k === 480) failing = false } },
    })
    const overdue = await audits('c1', 'file_links.reconciliation_overdue')
    expect(overdue).toHaveLength(1)
    expect(overdue[0].after.intervalHours).toBe(2)
    expect(sim.log.lines.some(l => l.level === 'error' && l.msg.includes('reconciliation overdue'))).toBe(true)
    expect((await stateOf('c1')).overdueSince).toBeUndefined()
    expect(tokensLeft(bucket)).toBe(0)
  }, LONG)
})

describe('2-hour interval — the first pass at activation', () => {
  it('a company last swept more than two intervals before activation is reported overdue ONCE by the first pass; the sweep a minute later clears it and it never recurs', async () => {
    await seedCompany('stale', { sweptAgoMs: 5 * H })      // production today: last sweep 16 Nov 23:13 UTC
    await seedCompany('fresh', { sweptAgoMs: 1 * H })
    bucket = fakeBucket({ ...seedObjects('stale', 2, { tokenEvery: 0 }), ...seedObjects('fresh', 2, { tokenEvery: 0 }) })
    const sim = await simulate({ hours: 24, seed: 11 })
    // Exactly one expected signal, from the first planning pass only.
    expect(sim.heartbeats[0].fields).toMatchObject({ passSeq: 1, overdue: 1, requested: 1 })
    expect(sim.heartbeats.slice(1).every(b => b.fields.overdue === 0)).toBe(true)
    const errs = errorLines(sim.log)
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatchObject({ msg: 'file-links: reconciliation overdue; tokens in these companies are older than the bound', fields: { passSeq: 1, companies: 1 } })
    expect(errs[0].at - START).toBeLessThan(10 * S)
    expect(await audits('stale', 'file_links.reconciliation_overdue')).toHaveLength(1)
    expect(await audits('fresh', 'file_links.reconciliation_overdue')).toEqual([])
    // Cleared by the first periodic sweep, on the next invocation.
    expect(sim.sweeps.stale[0]).toMatchObject({ priority: 'periodic', k: 1 })
    expect((await stateOf('stale')).overdueSince).toBeUndefined()
  }, LONG)
})

describe('why 1 hour was rejected — characterisation of the REAL code at interval 1', () => {
  it('with interval == planning period, sweeps land ~1 h or ~2 h apart on jitter alone, and a ~2 h gap is a FALSE overdue', async () => {
    for (const c of ['a', 'b', 'c']) await seedCompany(c)
    bucket = fakeBucket({ ...seedObjects('a', 1, { tokenEvery: 0 }), ...seedObjects('b', 1, { tokenEvery: 0 }), ...seedObjects('c', 1, { tokenEvery: 0 }) })
    const sim = await simulate({ hours: 24, intervalRaw: '1', seed: 20261117 })
    const all = ['a', 'b', 'c'].flatMap(c => gaps(sim.sweeps[c]))
    expect(all.some(g => g < 1 * H + 5 * MIN)).toBe(true)
    expect(all.some(g => g > 2 * H - 5 * MIN)).toBe(true)
    // Nothing failed, yet the overdue detector fired.
    const overdue = (await Promise.all(['a', 'b', 'c'].map(c => audits(c, 'file_links.reconciliation_overdue')))).flat()
    expect(overdue.length).toBeGreaterThanOrEqual(1)
    expect(errorLines(sim.log).some(l => l.msg.includes('reconciliation overdue'))).toBe(true)
  }, LONG)
})
