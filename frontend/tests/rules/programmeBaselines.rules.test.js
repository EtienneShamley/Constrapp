import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing'
import {
  doc, collection, query, orderBy, getDoc, getDocsFromServer, setDoc, updateDoc, deleteDoc,
  serverTimestamp, Timestamp, runTransaction,
} from 'firebase/firestore'
import {
  runBaselineCapture, runBaselineApprove, runBaselineWithdraw, checkBaselineDrift, BASELINE_ERROR,
} from '../../src/lib/programmeBaselineActions'
import { SNAPSHOT_MAX_BYTES, estimateSnapshotBytes, FIRESTORE_DOCUMENT_MAX_BYTES } from '../../src/lib/ganttBaseline'

// ── Programme baseline Security Rules — emulator tests (ADR-66, GANTT 1B) ────
//
// Executes docs/TESTING.md §42 against the Firestore emulator. These verify
// the RULES of the two new blocks — `programmeBaselines` (the header) and
// `programmeBaselineSnapshots` (the ONE immutable payload) — with direct SDK
// writes, exactly what a client bypassing the app would issue, plus the app's
// own transactions (lib/programmeBaselineActions.js) run against the real
// emulator with the real `getDocsFromServer`.
//
// What these tests deliberately PROVE IS NOT ENFORCED (Deferred Control 42):
// a MIDDLE entry of any shape, a DUPLICATE activity id, an entry whose dates
// differ from its source activity, and programme drift between the capture
// query and the commit.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const PROJECT_B = 'projectB'

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  super:  { uid: 'u_super',  role: 'super_admin',     companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}

const WRITERS = [USERS.admin, USERS.pm]
const READERS = [USERS.admin, USERS.pm, USERS.qs]
const NON_READERS = [USERS.sub, USERS.client, USERS.super]
const NON_WRITERS = [USERS.qs, USERS.sub, USERS.client, USERS.super]

let testEnv

const activitiesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/activities`
const headersPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/programmeBaselines`
const snapshotsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/programmeBaselineSnapshots`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const headerRef = (db, id, companyId = COMPANY_A, projectId = PROJECT_A) => doc(db, headersPath(companyId, projectId), id)
const snapshotRef = (db, id, companyId = COMPANY_A, projectId = PROJECT_A) => doc(db, snapshotsPath(companyId, projectId), id)
const activitiesQuery = (db, companyId = COMPANY_A, projectId = PROJECT_A) =>
  query(collection(db, activitiesPath(companyId, projectId)), orderBy('createdAt', 'asc'))

// A valid activity, as hooks/useProjectActivities.jsx writes it (ADR-65 shape).
function activityDoc(user, overrides = {}) {
  return {
    name: 'Ground floor slab', description: '', isMilestone: false, status: 'not_started',
    plannedStart: '2026-10-20', plannedFinish: '2026-10-24', actualStart: null, actualFinish: null,
    percentComplete: 0, responsibleContactId: null, responsibleName: '', costCodeId: null, costCodeName: '',
    sortOrder: 10, notes: '', predecessors: [],
    cancelReason: '', cancelledAt: null, cancelledBy: null,
    revision: 1, createdAt: Timestamp.now(), createdBy: user.uid, updatedAt: Timestamp.now(), updatedBy: user.uid,
    ...overrides,
  }
}

// Seeds n activities a1..an (sortOrder 10, 20, …) directly, bypassing rules.
async function seedActivities(n, overrides = (/* i */) => ({}), companyId = COMPANY_A, projectId = PROJECT_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (let i = 1; i <= n; i += 1) {
      await setDoc(doc(db, activitiesPath(companyId, projectId), `a${i}`), activityDoc(USERS.admin, {
        name: `Activity ${i}`, sortOrder: i * 10,
        plannedStart: '2026-10-20', plannedFinish: '2026-10-24',
        createdAt: Timestamp.fromMillis(1_700_000_000_000 + i * 1000),
        ...overrides(i),
      }))
    }
  })
}

// One snapshot entry, exactly as lib/ganttBaseline.js → projectBaselineEntry writes it.
const entry = (activityId, overrides = {}) => ({
  activityId, name: `Activity ${activityId}`, isMilestone: false,
  plannedStart: '2026-10-20', plannedFinish: '2026-10-24',
  status: 'not_started', percentComplete: 0, revision: 1, sortOrder: 10, costCodeId: null,
  ...overrides,
})

// A valid header + snapshot pair, as lib/programmeBaselineActions.js writes them.
function headerPayload(user, count, overrides = {}) {
  return {
    name: 'Contract programme', reason: 'Agreed at award', status: 'draft', activityCount: count,
    approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    revision: 1,
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}
function snapshotPayload(user, entries, overrides = {}) {
  return {
    activityCount: entries.length, capturedAt: serverTimestamp(), capturedBy: user.uid, activities: entries,
    ...overrides,
  }
}

// The pair in ONE transaction (what the app does).
const capturePair = (db, user, id, { header = {}, snapshot = {}, entries = [entry('a1'), entry('a2')], companyId = COMPANY_A, projectId = PROJECT_A } = {}) =>
  runTransaction(db, async (tx) => {
    tx.set(headerRef(db, id, companyId, projectId), headerPayload(user, entries.length, header))
    tx.set(snapshotRef(db, id, companyId, projectId), snapshotPayload(user, entries, snapshot))
  })

// Seeds a header (and optionally its snapshot) directly — the arrange step for updates.
async function seedBaseline(id, { header = {}, entries = [entry('a1'), entry('a2')], withSnapshot = true, user = USERS.pm } = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(headerRef(db, id), {
      ...headerPayload(user, entries.length),
      createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
      ...header,
    })
    if (withSnapshot) {
      await setDoc(snapshotRef(db, id), { ...snapshotPayload(user, entries), capturedAt: Timestamp.now() })
    }
  })
}

const approveWrite = (user, extra = {}) => ({
  status: 'approved', approvedAt: serverTimestamp(), approvedBy: user.uid,
  revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})
const withdrawWrite = (user, reason = 'Captured before the client comments', extra = {}) => ({
  status: 'withdrawn', withdrawnAt: serverTimestamp(), withdrawnBy: user.uid, withdrawReason: reason,
  revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})

const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

const readHeader = async (id) => {
  let data = null
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(headerRef(c.firestore(), id))
    data = s.exists() ? { id: s.id, ...s.data() } : null
  })
  return data
}
const readSnapshot = async (id) => {
  let data = null
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(snapshotRef(c.firestore(), id))
    data = s.exists() ? { id: s.id, ...s.data() } : null
  })
  return data
}

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set — refusing to run Rules tests outside the emulator. Run `npm run test:rules`.')
  }
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host, port: Number(port) },
  })
})

afterAll(async () => {
  if (testEnv) await testEnv.cleanup()
})

beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_B), { name: 'Project B', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })
  })
  await seedActivities(3)
})

// ── Read / write matrix ──────────────────────────────────────────────────────

describe('read and write matrix', () => {
  it('admin, project_manager and qs can READ headers and snapshots', async () => {
    await seedBaseline('b1')
    for (const u of READERS) {
      await assertSucceeds(getDoc(headerRef(ctx(u), 'b1')))
      await assertSucceeds(getDoc(snapshotRef(ctx(u), 'b1')))
    }
  })

  it('subcontractor, client, super_admin, another company and anonymous cannot read either', async () => {
    await seedBaseline('b1')
    for (const u of NON_READERS) {
      await assertFails(getDoc(headerRef(ctx(u), 'b1')))
      await assertFails(getDoc(snapshotRef(ctx(u), 'b1')))
    }
    await assertFails(getDoc(headerRef(ctx(USERS.other), 'b1')))
    await assertFails(getDoc(snapshotRef(ctx(USERS.other), 'b1')))
    await assertFails(getDoc(headerRef(anon(), 'b1')))
    await assertFails(getDoc(snapshotRef(anon(), 'b1')))
  })

  it('admin and project_manager can CAPTURE the pair', async () => {
    for (const u of WRITERS) {
      await assertSucceeds(capturePair(ctx(u), u, `b_${u.uid}`))
      const h = await readHeader(`b_${u.uid}`)
      expect(h.status).toBe('draft')
      expect(h.activityCount).toBe(2)
      expect((await readSnapshot(`b_${u.uid}`)).activities).toHaveLength(2)
    }
  })

  it('qs, subcontractor, client, super_admin, another company and anonymous cannot capture', async () => {
    for (const u of NON_WRITERS) await assertFails(capturePair(ctx(u), u, `b_${u.uid}`))
    await assertFails(capturePair(ctx(USERS.other), USERS.other, 'b_other'))
    await assertFails(capturePair(anon(), USERS.admin, 'b_anon'))
  })

  it('admin and project_manager can APPROVE a draft; qs and the rest cannot', async () => {
    await seedBaseline('b1')
    await seedBaseline('b2')
    await assertSucceeds(updateDoc(headerRef(ctx(USERS.admin), 'b1'), approveWrite(USERS.admin)))
    await assertSucceeds(updateDoc(headerRef(ctx(USERS.pm), 'b2'), approveWrite(USERS.pm)))
    await seedBaseline('b3')
    for (const u of NON_WRITERS) await assertFails(updateDoc(headerRef(ctx(u), 'b3'), approveWrite(u)))
    await assertFails(updateDoc(headerRef(ctx(USERS.other), 'b3'), approveWrite(USERS.other)))
  })
})

// ── Tenant and project isolation ─────────────────────────────────────────────

describe('tenant and project isolation', () => {
  it('a company B admin cannot capture into company A, and an A admin cannot capture into B', async () => {
    await assertFails(capturePair(ctx(USERS.other), USERS.other, 'bx'))
    await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'bx', { companyId: COMPANY_B }))
  })

  it('an entry naming an activity that is not in THIS project is refused (first and last pinned)', async () => {
    await seedActivities(1, () => ({}), COMPANY_A, PROJECT_B) // a1 exists in project B too
    await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'b1', { entries: [entry('a1'), entry('a_elsewhere')] }))
    await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'b2', { entries: [entry('a_elsewhere'), entry('a2')] }))
    // Project B's programme holds only a1: a2 does not exist there.
    await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'b3', { entries: [entry('a1'), entry('a2')], projectId: PROJECT_B }))
    await assertSucceeds(capturePair(ctx(USERS.admin), USERS.admin, 'b4', { entries: [entry('a1')], projectId: PROJECT_B }))
  })
})

// ── The pair ─────────────────────────────────────────────────────────────────

describe('header and snapshot are created together or not at all', () => {
  it('a header alone is refused', async () => {
    await assertFails(setDoc(headerRef(ctx(USERS.admin), 'b1'), headerPayload(USERS.admin, 2)))
  })

  it('a snapshot alone is refused', async () => {
    await assertFails(setDoc(snapshotRef(ctx(USERS.admin), 'b1'), snapshotPayload(USERS.admin, [entry('a1'), entry('a2')])))
  })

  it('a snapshot against an existing (seeded) header is still refused — the header must be created in the same commit', async () => {
    await seedBaseline('b1', { withSnapshot: false })
    await assertFails(setDoc(snapshotRef(ctx(USERS.pm), 'b1'), snapshotPayload(USERS.pm, [entry('a1'), entry('a2')])))
  })

  it('the pair must agree on activityCount, in both directions', async () => {
    await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'b1', { header: { activityCount: 3 } }))
    await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'b2', { snapshot: { activityCount: 3 } }))
  })

  it('the snapshot must carry the same caller and the server time as the header', async () => {
    await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'b1', { snapshot: { capturedBy: USERS.pm.uid } }))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'b2', { snapshot: { capturedAt: clock() } }))
    }
  })

  it('the correct pair succeeds and stores exactly what was written', async () => {
    await assertSucceeds(capturePair(ctx(USERS.pm), USERS.pm, 'b1'))
    const h = await readHeader('b1')
    const s = await readSnapshot('b1')
    expect(h).toMatchObject({ name: 'Contract programme', reason: 'Agreed at award', status: 'draft', activityCount: 2, revision: 1, createdBy: USERS.pm.uid, approvedAt: null, withdrawnAt: null })
    expect(s.activities).toEqual([entry('a1'), entry('a2')])
    expect(s.capturedBy).toBe(USERS.pm.uid)
    expect(s.capturedAt.toMillis()).toBe(h.createdAt.toMillis())
  })
})

// ── Header shape at capture ──────────────────────────────────────────────────

describe('header exact shape and create pins', () => {
  const cases = [
    ['an extra key', { header: { approvedDrift: 0 } }],
    ['a missing key', { header: { withdrawReason: undefined } }],
    ['a blank name', { header: { name: '   ' } }],
    ['a name over 120', { header: { name: 'x'.repeat(121) } }],
    ['a blank reason', { header: { reason: '' } }],
    ['a reason over 500', { header: { reason: 'x'.repeat(501) } }],
    ['status approved at create', { header: { status: 'approved', approvedAt: serverTimestamp(), approvedBy: USERS.admin.uid } }],
    ['status withdrawn at create', { header: { status: 'withdrawn' } }],
    ['an unknown status', { header: { status: 'submitted' } }],
    ['activityCount 0 with no entries', { header: { activityCount: 0 }, entries: [] }],
    ['a non-integer activityCount', { header: { activityCount: 2.5 } }],
    ['approvedAt pre-filled', { header: { approvedAt: serverTimestamp() } }],
    ['approvedBy pre-filled', { header: { approvedBy: USERS.admin.uid } }],
    ['withdrawnBy pre-filled', { header: { withdrawnBy: USERS.admin.uid } }],
    ['a non-empty withdrawReason', { header: { withdrawReason: 'x' } }],
    ['revision 0', { header: { revision: 0 } }],
    ['revision 2', { header: { revision: 2 } }],
    ['createdBy another user', { header: { createdBy: USERS.pm.uid } }],
    ['updatedBy another user', { header: { updatedBy: USERS.pm.uid } }],
  ]
  for (const [label, opts] of cases) {
    it(`refuses ${label}`, async () => {
      const header = { ...opts.header }
      for (const k of Object.keys(header)) if (header[k] === undefined) delete header[k]
      const payloadFn = (user, count, overrides) => {
        const base = headerPayload(user, count, overrides)
        for (const [k, v] of Object.entries(opts.header)) if (v === undefined) delete base[k]
        return base
      }
      const db = ctx(USERS.admin)
      await assertFails(runTransaction(db, async (tx) => {
        const entries = opts.entries ?? [entry('a1'), entry('a2')]
        tx.set(headerRef(db, 'bx'), payloadFn(USERS.admin, entries.length, header))
        tx.set(snapshotRef(db, 'bx'), snapshotPayload(USERS.admin, entries))
      }))
      expect(await readHeader('bx')).toBeNull()
      expect(await readSnapshot('bx')).toBeNull()
    })
  }

  it('refuses client-supplied createdAt / updatedAt', async () => {
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'b1', { header: { createdAt: clock() } }))
      await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'b2', { header: { updatedAt: clock() } }))
    }
  })
})

// ── Snapshot shape at capture ────────────────────────────────────────────────

describe('snapshot exact shape, list pins and the first / last entries', () => {
  const bad = [
    ['an extra top-level key', { snapshot: { note: 'x' } }],
    ['a missing top-level key', { snapshotDelete: 'capturedBy' }],
    ['activities not a list', { snapshot: { activities: { a1: entry('a1') } } }],
    ['an empty list (with activityCount 0)', { entries: [], header: { activityCount: 0 } }],
    ['a list whose size differs from activityCount', { snapshot: { activityCount: 3 }, header: { activityCount: 3 } }],
    ['a non-integer activityCount', { snapshot: { activityCount: 2.0001 }, header: { activityCount: 2.0001 } }],
    ['a first entry with an extra key', { entries: [entry('a1', { notes: 'x' }), entry('a2')] }],
    ['a first entry with a missing key', { entries: [(() => { const e = entry('a1'); delete e.sortOrder; return e })(), entry('a2')] }],
    ['a last entry that is not a map', { entries: [entry('a1'), 'a2'] }],
    ['a first entry with an empty id', { entries: [entry('a1', { activityId: '' }), entry('a2')] }],
    ['a last entry naming no activity in this project', { entries: [entry('a1'), entry('a_nope')] }],
    ['a blank name', { entries: [entry('a1', { name: ' ' }), entry('a2')] }],
    ['a name over 120', { entries: [entry('a1', { name: 'x'.repeat(121) }), entry('a2')] }],
    ['a non-boolean isMilestone', { entries: [entry('a1', { isMilestone: 'yes' }), entry('a2')] }],
    ['an invalid planned start', { entries: [entry('a1', { plannedStart: '2026-13-01' }), entry('a2')] }],
    ['an invalid planned finish', { entries: [entry('a1'), entry('a2', { plannedFinish: '20261024' })] }],
    ['a finish before the start', { entries: [entry('a1', { plannedStart: '2026-10-24', plannedFinish: '2026-10-20' }), entry('a2')] }],
    ['a milestone with two dates', { entries: [entry('a1'), entry('a2', { isMilestone: true })] }],
    ['an unknown status', { entries: [entry('a1', { status: 'blocked' }), entry('a2')] }],
    ['progress 101', { entries: [entry('a1', { percentComplete: 101 }), entry('a2')] }],
    ['progress -1', { entries: [entry('a1'), entry('a2', { percentComplete: -1 })] }],
    ['a fractional progress', { entries: [entry('a1', { percentComplete: 50.5 }), entry('a2')] }],
    ['revision 0', { entries: [entry('a1', { revision: 0 }), entry('a2')] }],
    ['a fractional revision', { entries: [entry('a1'), entry('a2', { revision: 1.5 })] }],
    ['a string sortOrder', { entries: [entry('a1', { sortOrder: '10' }), entry('a2')] }],
    ['an empty-string costCodeId', { entries: [entry('a1', { costCodeId: '' }), entry('a2')] }],
    ['a numeric costCodeId', { entries: [entry('a1'), entry('a2', { costCodeId: 7 })] }],
  ]
  for (const [label, opts] of bad) {
    it(`refuses ${label}`, async () => {
      const db = ctx(USERS.admin)
      await assertFails(runTransaction(db, async (tx) => {
        const entries = opts.entries ?? [entry('a1'), entry('a2')]
        const header = { ...(opts.header ?? {}) }
        const snapshot = snapshotPayload(USERS.admin, entries, opts.snapshot ?? {})
        if (opts.snapshotDelete) delete snapshot[opts.snapshotDelete]
        tx.set(headerRef(db, 'bx'), headerPayload(USERS.admin, entries.length, header))
        tx.set(snapshotRef(db, 'bx'), snapshot)
      }))
      expect(await readHeader('bx')).toBeNull()
      expect(await readSnapshot('bx')).toBeNull()
    })
  }

  it('accepts every status in the vocabulary, a milestone on one day, and a cost-code key', async () => {
    await assertSucceeds(capturePair(ctx(USERS.admin), USERS.admin, 'b1', {
      entries: [
        entry('a1', { status: 'cancelled', percentComplete: 40, revision: 3, costCodeId: 'cc1' }),
        entry('a2', { isMilestone: true, plannedStart: '2026-10-24', plannedFinish: '2026-10-24', status: 'completed', percentComplete: 100 }),
      ],
    }))
  })

  it('a single-entry snapshot is pinned on that one entry at both ends', async () => {
    await assertSucceeds(capturePair(ctx(USERS.admin), USERS.admin, 'b1', { entries: [entry('a1')] }))
    await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'b2', { entries: [entry('a_nope')] }))
  })

  it('⚠️ DC42: a MIDDLE entry of any shape and a DUPLICATE id are ACCEPTED by rules (client-validated only)', async () => {
    await assertSucceeds(capturePair(ctx(USERS.admin), USERS.admin, 'b1', {
      entries: [entry('a1'), { garbage: true }, entry('a3')],
    }))
    await assertSucceeds(capturePair(ctx(USERS.admin), USERS.admin, 'b2', {
      entries: [entry('a1'), entry('a1'), entry('a1')],
    }))
    await assertSucceeds(capturePair(ctx(USERS.admin), USERS.admin, 'b3', {
      entries: [entry('a1'), entry('a_nope'), entry('a2')],
    }))
  })

  it('⚠️ DC42: an entry whose dates differ from its source activity is ACCEPTED — rules verify existence, not content', async () => {
    await assertSucceeds(capturePair(ctx(USERS.admin), USERS.admin, 'b1', {
      entries: [entry('a1', { plannedStart: '2020-01-01', plannedFinish: '2020-01-02', revision: 99 }), entry('a2')],
    }))
  })
})

// ── Size boundary ────────────────────────────────────────────────────────────

describe('size boundary — 2,000 entries, worst-case names', () => {
  // 2,000 is the rules ceiling AND the application ceiling; the app also
  // refuses above SNAPSHOT_MAX_BYTES (900,000) before writing, which this
  // worst case stays under while remaining a real write to the emulator.
  const worst = (n) => Array.from({ length: n }, (_, i) =>
    entry(`a${i + 1}`, { name: `Activity ${i + 1} `.padEnd(120, 'x'), costCodeId: 'cost-code-' + String(i).padStart(10, '0'), revision: 12345, sortOrder: (i + 1) * 10 }))

  it('a 2,000-entry worst-case snapshot is accepted and stays under the ceilings', async () => {
    await seedActivities(2000)
    const entries = worst(2000)
    const bytes = estimateSnapshotBytes(entries, { capturedBy: USERS.admin.uid })
    expect(bytes).toBeLessThan(SNAPSHOT_MAX_BYTES)
    expect(bytes).toBeLessThan(FIRESTORE_DOCUMENT_MAX_BYTES)
    await assertSucceeds(capturePair(ctx(USERS.admin), USERS.admin, 'big', { entries }))
    const s = await readSnapshot('big')
    expect(s.activities).toHaveLength(2000)
    expect(s.activityCount).toBe(2000)
  }, 120_000)

  it('2,001 entries are refused by the rules', async () => {
    await seedActivities(2001)
    await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'big', { entries: worst(2001) }))
    expect(await readHeader('big')).toBeNull()
  }, 120_000)
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('lifecycle: draft → approved | withdrawn, both terminal', () => {
  it('draft → approved with the caller stamp, server time and revision 2', async () => {
    await seedBaseline('b1')
    await assertSucceeds(updateDoc(headerRef(ctx(USERS.admin), 'b1'), approveWrite(USERS.admin)))
    const h = await readHeader('b1')
    expect(h.status).toBe('approved')
    expect(h.approvedBy).toBe(USERS.admin.uid)
    expect(h.revision).toBe(2)
  })

  it('self-approval is PERMITTED (the capturer approves their own draft)', async () => {
    await seedBaseline('b1', { user: USERS.pm })
    await assertSucceeds(updateDoc(headerRef(ctx(USERS.pm), 'b1'), approveWrite(USERS.pm)))
  })

  it('approval refuses: another actor, a client clock, revision unchanged / +2, a content change riding along', async () => {
    await seedBaseline('b1')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(headerRef(db, 'b1'), approveWrite(USERS.admin, { approvedBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(headerRef(db, 'b1'), approveWrite(USERS.admin, { approvedAt: clock() })))
      await assertFails(updateDoc(headerRef(db, 'b1'), approveWrite(USERS.admin, { updatedAt: clock() })))
    }
    await assertFails(updateDoc(headerRef(db, 'b1'), approveWrite(USERS.admin, { revision: 1 })))
    await assertFails(updateDoc(headerRef(db, 'b1'), approveWrite(USERS.admin, { revision: 3 })))
    await assertFails(updateDoc(headerRef(db, 'b1'), approveWrite(USERS.admin, { name: 'Renamed' })))
    await assertFails(updateDoc(headerRef(db, 'b1'), approveWrite(USERS.admin, { reason: 'Changed' })))
    await assertFails(updateDoc(headerRef(db, 'b1'), approveWrite(USERS.admin, { activityCount: 1 })))
    await assertFails(updateDoc(headerRef(db, 'b1'), approveWrite(USERS.admin, { withdrawReason: 'x' })))
    await assertFails(updateDoc(headerRef(db, 'b1'), approveWrite(USERS.admin, { createdBy: USERS.admin.uid })))
    expect((await readHeader('b1')).status).toBe('draft')
  })

  it('draft → withdrawn with a non-blank reason; a blank reason or a missing reason is refused', async () => {
    await seedBaseline('b1')
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'b1'), withdrawWrite(USERS.pm, '   ')))
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'b1'), withdrawWrite(USERS.pm, 'x'.repeat(501))))
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'b1'), withdrawWrite(USERS.pm, 'ok', { withdrawnBy: USERS.admin.uid })))
    await assertSucceeds(updateDoc(headerRef(ctx(USERS.pm), 'b1'), withdrawWrite(USERS.pm)))
    const h = await readHeader('b1')
    expect(h.status).toBe('withdrawn')
    expect(h.revision).toBe(2)
  })

  it('an APPROVED header admits NO update: not withdrawn, not back to draft, not a name edit, not a re-approval', async () => {
    await seedBaseline('b1', { header: { status: 'approved', approvedAt: Timestamp.now(), approvedBy: USERS.admin.uid, revision: 2 } })
    const db = ctx(USERS.admin)
    const next = { revision: 3, updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid }
    await assertFails(updateDoc(headerRef(db, 'b1'), { ...withdrawWrite(USERS.admin), revision: 3 }))
    await assertFails(updateDoc(headerRef(db, 'b1'), { status: 'draft', approvedAt: null, approvedBy: null, ...next }))
    await assertFails(updateDoc(headerRef(db, 'b1'), { name: 'Renamed', ...next }))
    await assertFails(updateDoc(headerRef(db, 'b1'), { ...approveWrite(USERS.admin), revision: 3 }))
    await assertFails(updateDoc(headerRef(db, 'b1'), next))
    expect((await readHeader('b1')).name).toBe('Contract programme')
  })

  it('a WITHDRAWN header admits no update either', async () => {
    await seedBaseline('b1', { header: { status: 'withdrawn', withdrawnAt: Timestamp.now(), withdrawnBy: USERS.pm.uid, withdrawReason: 'early', revision: 2 } })
    await assertFails(updateDoc(headerRef(ctx(USERS.admin), 'b1'), { ...approveWrite(USERS.admin), revision: 3 }))
    await assertFails(updateDoc(headerRef(ctx(USERS.admin), 'b1'), { status: 'draft', withdrawnAt: null, withdrawnBy: null, withdrawReason: '', revision: 3, updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid }))
  })

  it('a header can never be deleted, in any state, by anyone', async () => {
    await seedBaseline('b1')
    await seedBaseline('b2', { header: { status: 'approved', approvedAt: Timestamp.now(), approvedBy: USERS.admin.uid, revision: 2 } })
    for (const u of Object.values(USERS)) {
      await assertFails(deleteDoc(headerRef(ctx(u), 'b1')))
      await assertFails(deleteDoc(headerRef(ctx(u), 'b2')))
    }
  })
})

describe('the snapshot is immutable', () => {
  it('no update of any kind — not an entry, not a count, not a stamp, not an identical rewrite', async () => {
    await seedBaseline('b1')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(snapshotRef(db, 'b1'), { activityCount: 2 }))
    await assertFails(updateDoc(snapshotRef(db, 'b1'), { activities: [entry('a1'), entry('a2', { plannedFinish: '2026-10-30' })] }))
    await assertFails(updateDoc(snapshotRef(db, 'b1'), { capturedBy: USERS.pm.uid }))
    await assertFails(setDoc(snapshotRef(db, 'b1'), snapshotPayload(USERS.admin, [entry('a1'), entry('a2')])))
    expect((await readSnapshot('b1')).activities).toEqual([entry('a1'), entry('a2')])
  })

  it('no delete, by anyone', async () => {
    await seedBaseline('b1')
    for (const u of Object.values(USERS)) await assertFails(deleteDoc(snapshotRef(ctx(u), 'b1')))
  })
})

// ── The app's own transactions, against the emulator ─────────────────────────

describe('lib/programmeBaselineActions.js against the real emulator', () => {
  const sdk = (db) => ({ db, runTransaction, serverTimestamp, getDocsFromServer, activitiesQuery: activitiesQuery(db) })

  it('capture reads the programme from the server and writes the pair; cancelled history is captured with its status', async () => {
    await seedActivities(4, (i) => (i === 4 ? { status: 'cancelled', cancelReason: 'descoped', cancelledAt: Timestamp.now(), cancelledBy: USERS.admin.uid, revision: 2 } : {}))
    const db = ctx(USERS.pm)
    const id = 'cap1'
    const result = await runBaselineCapture({
      ...sdk(db), headerRef: headerRef(db, id), snapshotRef: snapshotRef(db, id),
      input: { name: 'Contract programme', reason: 'Agreed at award' }, uid: USERS.pm.uid,
    })
    expect(result.id).toBe(id)
    expect(result.counts).toMatchObject({ total: 4, captured: 4, live: 3, cancelledAtCapture: 1, invalid: 0 })
    const s = await readSnapshot(id)
    expect(s.activities.map(e => e.activityId)).toEqual(['a1', 'a2', 'a3', 'a4'])
    expect(s.activities[3].status).toBe('cancelled')
    expect(s.activities[3].revision).toBe(2)
    expect((await readHeader(id)).activityCount).toBe(4)
  })

  it('capture refuses — writing nothing — when a stored activity is malformed, naming it', async () => {
    await seedActivities(2, (i) => (i === 2 ? { plannedFinish: '2026-10-19' } : {})) // finish before start (SDK-forged)
    const db = ctx(USERS.admin)
    const err = await runBaselineCapture({
      ...sdk(db), headerRef: headerRef(db, 'x'), snapshotRef: snapshotRef(db, 'x'),
      input: { name: 'n', reason: 'r' }, uid: USERS.admin.uid,
    }).catch(e => e)
    expect(err.kind).toBe(BASELINE_ERROR.INVALID)
    expect(err.details.errors).toHaveLength(1)
    expect(err.details.errors[0].reason).toMatch(/Activity 2 has a planned finish before its planned start/)
    expect(await readHeader('x')).toBeNull()
  })

  it('a qs capture is refused by the RULES (the action layer does not authorise)', async () => {
    const db = ctx(USERS.qs)
    const err = await runBaselineCapture({
      ...sdk(db), headerRef: headerRef(db, 'q'), snapshotRef: snapshotRef(db, 'q'),
      input: { name: 'n', reason: 'r' }, uid: USERS.qs.uid,
    }).catch(e => e)
    expect(err.kind).toBe(BASELINE_ERROR.PERMISSION)
  })

  it('approve: no drift → approved at revision 2; the snapshot is untouched', async () => {
    const db = ctx(USERS.admin)
    await runBaselineCapture({ ...sdk(db), headerRef: headerRef(db, 'b1'), snapshotRef: snapshotRef(db, 'b1'), input: { name: 'n', reason: 'r' }, uid: USERS.admin.uid })
    const seen = await readHeader('b1')
    const snapshot = await readSnapshot('b1')
    const drift = await checkBaselineDrift({ ...sdk(db), snapshot })
    expect(drift.any).toBe(false)
    const rev = await runBaselineApprove({ ...sdk(db), headerRef: headerRef(db, 'b1'), snapshotRef: snapshotRef(db, 'b1'), seen, snapshot, acknowledgedDriftKey: '', uid: USERS.admin.uid })
    expect(rev).toBe(2)
    expect((await readHeader('b1')).status).toBe('approved')
    expect((await readSnapshot('b1')).activities).toEqual(snapshot.activities)
  })

  it('approve: drift the approver did not acknowledge is refused; acknowledging THAT drift approves; drift that changed again is refused', async () => {
    const db = ctx(USERS.admin)
    await runBaselineCapture({ ...sdk(db), headerRef: headerRef(db, 'b1'), snapshotRef: snapshotRef(db, 'b1'), input: { name: 'n', reason: 'r' }, uid: USERS.admin.uid })
    const seen = await readHeader('b1')
    const snapshot = await readSnapshot('b1')
    // The programme moves after the capture: a2 edited, a4 added.
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const d = c.firestore()
      await updateDoc(doc(d, activitiesPath(), 'a2'), { plannedFinish: '2026-10-30', revision: 2 })
      await setDoc(doc(d, activitiesPath(), 'a4'), activityDoc(USERS.admin, { name: 'Activity 4', sortOrder: 40 }))
    })
    const unacknowledged = await runBaselineApprove({ ...sdk(db), headerRef: headerRef(db, 'b1'), snapshotRef: snapshotRef(db, 'b1'), seen, snapshot, acknowledgedDriftKey: '', uid: USERS.admin.uid }).catch(e => e)
    expect(unacknowledged.kind).toBe(BASELINE_ERROR.DRIFT)
    expect(unacknowledged.details.drift.changed.map(x => x.activityId)).toEqual(['a2'])
    expect(unacknowledged.details.drift.added.map(x => x.activityId)).toEqual(['a4'])
    expect((await readHeader('b1')).status).toBe('draft')

    const drift = await checkBaselineDrift({ ...sdk(db), snapshot })
    // It moves AGAIN before the approver clicks: a3 cancelled.
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), activitiesPath(), 'a3'), { status: 'cancelled', cancelReason: 'x', cancelledAt: Timestamp.now(), cancelledBy: USERS.admin.uid, revision: 2 })
    })
    const changedAgain = await runBaselineApprove({ ...sdk(db), headerRef: headerRef(db, 'b1'), snapshotRef: snapshotRef(db, 'b1'), seen, snapshot, acknowledgedDriftKey: drift.key, uid: USERS.admin.uid }).catch(e => e)
    expect(changedAgain.kind).toBe(BASELINE_ERROR.DRIFT)
    expect(changedAgain.details.drift.cancelledAfter.map(x => x.activityId)).toEqual(['a3'])

    const latest = await checkBaselineDrift({ ...sdk(db), snapshot })
    const rev = await runBaselineApprove({ ...sdk(db), headerRef: headerRef(db, 'b1'), snapshotRef: snapshotRef(db, 'b1'), seen, snapshot, acknowledgedDriftKey: latest.key, uid: USERS.admin.uid })
    expect(rev).toBe(2)
    expect((await readHeader('b1')).status).toBe('approved')
  })

  it('two concurrent approvals of ONE draft: the first wins, the second is refused and nothing is re-approved', async () => {
    const db1 = ctx(USERS.admin)
    const db2 = ctx(USERS.pm)
    await runBaselineCapture({ ...sdk(db1), headerRef: headerRef(db1, 'b1'), snapshotRef: snapshotRef(db1, 'b1'), input: { name: 'n', reason: 'r' }, uid: USERS.admin.uid })
    const seen = await readHeader('b1')
    const snapshot = await readSnapshot('b1')
    const first = await runBaselineApprove({ ...sdk(db1), headerRef: headerRef(db1, 'b1'), snapshotRef: snapshotRef(db1, 'b1'), seen, snapshot, acknowledgedDriftKey: '', uid: USERS.admin.uid })
    expect(first).toBe(2)
    const second = await runBaselineApprove({ ...sdk(db2), headerRef: headerRef(db2, 'b1'), snapshotRef: snapshotRef(db2, 'b1'), seen, snapshot, acknowledgedDriftKey: '', uid: USERS.pm.uid }).catch(e => e)
    expect([BASELINE_ERROR.STALE, BASELINE_ERROR.INVALID]).toContain(second.kind)
    const h = await readHeader('b1')
    expect(h.approvedBy).toBe(USERS.admin.uid)
    expect(h.revision).toBe(2)
  })

  it('approve refuses a stale copy (the draft was withdrawn meanwhile) and a missing snapshot', async () => {
    const db = ctx(USERS.admin)
    await runBaselineCapture({ ...sdk(db), headerRef: headerRef(db, 'b1'), snapshotRef: snapshotRef(db, 'b1'), input: { name: 'n', reason: 'r' }, uid: USERS.admin.uid })
    const seen = await readHeader('b1')
    const snapshot = await readSnapshot('b1')
    await runBaselineWithdraw({ ...sdk(db), headerRef: headerRef(db, 'b1'), seen, reason: 'captured too early', uid: USERS.admin.uid })
    const stale = await runBaselineApprove({ ...sdk(db), headerRef: headerRef(db, 'b1'), snapshotRef: snapshotRef(db, 'b1'), seen, snapshot, acknowledgedDriftKey: '', uid: USERS.admin.uid }).catch(e => e)
    expect(stale.kind).toBe(BASELINE_ERROR.STALE)
    expect((await readHeader('b1')).status).toBe('withdrawn')

    // A header whose snapshot never landed (impossible through the rules;
    // the guard still refuses). The snapshot handed in matches the live
    // programme exactly, so the refusal is the missing document, not drift.
    await seedBaseline('b2', { withSnapshot: false, entries: [entry('a1'), entry('a2'), entry('a3')] })
    const seen2 = await readHeader('b2')
    const missing = await runBaselineApprove({ ...sdk(db), headerRef: headerRef(db, 'b2'), snapshotRef: snapshotRef(db, 'b2'), seen: seen2, snapshot: { activityCount: 3, activities: [entry('a1'), entry('a2'), entry('a3')] }, acknowledgedDriftKey: '', uid: USERS.admin.uid }).catch(e => e)
    expect(missing.kind).toBe(BASELINE_ERROR.INVALID)
    expect((await readHeader('b2')).status).toBe('draft')
  })

  it('withdraw requires a reason and refuses a non-draft', async () => {
    await seedBaseline('b1')
    const db = ctx(USERS.pm)
    const seen = await readHeader('b1')
    const blank = await runBaselineWithdraw({ ...sdk(db), headerRef: headerRef(db, 'b1'), seen, reason: ' ', uid: USERS.pm.uid }).catch(e => e)
    expect(blank.kind).toBe(BASELINE_ERROR.INVALID)
    expect(await runBaselineWithdraw({ ...sdk(db), headerRef: headerRef(db, 'b1'), seen, reason: 'not agreed', uid: USERS.pm.uid })).toBe(2)
    const again = await runBaselineWithdraw({ ...sdk(db), headerRef: headerRef(db, 'b1'), seen, reason: 'twice', uid: USERS.pm.uid }).catch(e => e)
    expect(again.kind).toBe(BASELINE_ERROR.STALE)
  })
})

// ── Regression: the activities block is untouched ────────────────────────────

describe('legacy programme operations are unaffected', () => {
  it('an ordinary 1A2 activity edit and cancel still pass with an approved baseline present', async () => {
    await seedBaseline('b1', { header: { status: 'approved', approvedAt: Timestamp.now(), approvedBy: USERS.admin.uid, revision: 2 } })
    const db = ctx(USERS.pm)
    await assertSucceeds(updateDoc(doc(db, activitiesPath(), 'a1'), { plannedFinish: '2026-10-30', revision: 2, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid }))
    await assertSucceeds(updateDoc(doc(db, activitiesPath(), 'a2'), { status: 'cancelled', cancelReason: 'descoped', cancelledAt: serverTimestamp(), cancelledBy: USERS.pm.uid, revision: 2, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid }))
    // The approved snapshot did not move.
    expect((await readSnapshot('b1')).activities[0].plannedFinish).toBe('2026-10-24')
  })

  it('a pre-1B client that never reads the new collections sees nothing different (reads of activities unchanged)', async () => {
    await seedBaseline('b1')
    for (const u of READERS) await assertSucceeds(getDoc(doc(ctx(u), activitiesPath(), 'a1')))
    for (const u of NON_READERS) await assertFails(getDoc(doc(ctx(u), activitiesPath(), 'a1')))
  })
})
