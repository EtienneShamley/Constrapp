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
  doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore'

// ── Project Timeline activity Security Rules — emulator tests (ADR-29) ───────
//
// Executes docs/TESTING.md §15p-x against the Firestore emulator. These verify
// the RULES, not the UI: every write below is a direct SDK call, exactly what a
// client bypassing the app would issue.
//
// Two things make this block different from every financial collection:
//   · QS IS READ-ONLY. It is the only place where qs reads but cannot write.
//   · THE LIFECYCLE IS NOT FORWARD-ONLY. Backwards correction is permitted by
//     design (a programme is a plan, not an audit record); only `cancelled` is
//     terminal.
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (the documented
// client-only gaps — docs/SECURITY.md → Deferred Control 20): an impossible
// calendar date of valid SHAPE is accepted, a responsibleContactId/costCodeId
// naming nothing is accepted, and duplicate sortOrder values are accepted.
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set, so
// it can never reach a production Firebase project. The npm script starts the
// emulator via `firebase emulators:exec`, which sets that variable.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'

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

let testEnv

const activitiesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/activities`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const actRef = (db, id, companyId = COMPANY_A) => doc(db, activitiesPath(companyId), id)

// A valid activity, exactly as hooks/useProjectActivities.jsx writes it.
function payload(user, overrides = {}) {
  return {
    name: 'Ground floor slab',
    description: '',
    isMilestone: false,
    status: 'not_started',

    // Date-only strings. The finish is INCLUSIVE.
    plannedStart:  '2026-10-20',
    plannedFinish: '2026-10-24',
    actualStart:   null,
    actualFinish:  null,

    // Manually authored, unverifiable progress — it feeds no financial figure.
    percentComplete: 0,

    // Contacts link + frozen name snapshot (never a user account — ADR-27).
    responsibleContactId: null,
    responsibleName: '',

    // The commercial spine link. Optional: not every programme activity maps
    // to a cost code.
    costCodeId: null,
    costCodeName: '',

    sortOrder: 10,
    notes: '',

    cancelReason: '',
    cancelledAt: null,
    cancelledBy: null,

    revision: 1,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

// Seeds a document directly, bypassing rules — the arrange step for updates.
async function seed(id, overrides = {}, user = USERS.admin) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(doc(db, activitiesPath(), id), {
      ...payload(user),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...overrides,
    })
  })
}

// The write shapes the app performs.
const edit = (user, extra = {}) => ({
  updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})
const cancelWrite = (user, reason = 'Descoped by client', extra = {}) => ({
  status: 'cancelled',
  cancelReason: reason,
  cancelledAt: serverTimestamp(),
  cancelledBy: user.uid,
  updatedAt: serverTimestamp(),
  updatedBy: user.uid,
  ...extra,
})

// A full replacement write (setDoc) for shape tests on update.
const replace = (user, overrides = {}) => ({
  ...payload(user),
  createdAt: Timestamp.now(),           // preserved value is patched in per test
  ...overrides,
})

// Client-supplied clock values that must NEVER satisfy `== request.time`.
//
// ⚠️ DELIBERATELY SKEWED, NOT `Timestamp.now()` — see the note in
// cashFlowLines.rules.test.js and docs/TESTING.md §0.
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is not set — refusing to run Rules tests outside the emulator. ' +
      'Run `npm run test:rules`.',
    )
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
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })
  })
})

// ── Read / write matrix ──────────────────────────────────────────────────────

describe('read and write matrix', () => {
  it('admin, project_manager and qs can READ the programme', async () => {
    await seed('r1')
    for (const user of READERS) {
      await assertSucceeds(getDoc(actRef(ctx(user), 'r1')))
    }
  })

  it('subcontractor, client and super_admin CANNOT read the programme', async () => {
    await seed('r1')
    for (const user of NON_READERS) {
      await assertFails(getDoc(actRef(ctx(user), 'r1')))
    }
  })

  it('admin and project_manager can CREATE an activity', async () => {
    for (const user of WRITERS) {
      await assertSucceeds(setDoc(actRef(ctx(user), `c-${user.uid}`), payload(user)))
    }
  })

  it('QS IS READ-ONLY — it can read but cannot create, edit or cancel', async () => {
    await seed('q1')
    await assertSucceeds(getDoc(actRef(ctx(USERS.qs), 'q1')))
    await assertFails(setDoc(actRef(ctx(USERS.qs), 'q2'), payload(USERS.qs)))
    await assertFails(updateDoc(actRef(ctx(USERS.qs), 'q1'), edit(USERS.qs, { percentComplete: 25, status: 'in_progress', actualStart: '2026-10-20' })))
    await assertFails(updateDoc(actRef(ctx(USERS.qs), 'q1'), cancelWrite(USERS.qs)))
  })

  it('subcontractor and client cannot create or edit', async () => {
    await seed('s1')
    for (const user of [USERS.sub, USERS.client, USERS.super]) {
      await assertFails(setDoc(actRef(ctx(user), `x-${user.uid}`), payload(user)))
      await assertFails(updateDoc(actRef(ctx(user), 's1'), edit(user, { name: 'Renamed' })))
    }
  })

  it('super_admin gets NO special power in this branch', async () => {
    await seed('sa1')
    await assertFails(getDoc(actRef(ctx(USERS.super), 'sa1')))
    await assertFails(setDoc(actRef(ctx(USERS.super), 'sa2'), payload(USERS.super)))
  })
})

// ── Cross-company and unauthenticated ────────────────────────────────────────

describe('tenant isolation', () => {
  it('a company_admin of another company cannot read or write this programme', async () => {
    await seed('t1')
    await assertFails(getDoc(actRef(ctx(USERS.other), 't1')))
    await assertFails(setDoc(actRef(ctx(USERS.other), 't2'), payload(USERS.other)))
    await assertFails(updateDoc(actRef(ctx(USERS.other), 't1'), edit(USERS.other, { name: 'Theirs' })))
  })

  it('a company member cannot write into another company path', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.admin), 't3', COMPANY_B), payload(USERS.admin)))
    await assertFails(getDoc(actRef(ctx(USERS.admin), 't3', COMPANY_B)))
  })

  it('unauthenticated access is denied entirely', async () => {
    await seed('t4')
    await assertFails(getDoc(actRef(anon(), 't4')))
    await assertFails(setDoc(actRef(anon(), 't5'), payload(USERS.admin)))
    await assertFails(deleteDoc(actRef(anon(), 't4')))
  })

  it('an authenticated user with NO membership document is denied', async () => {
    await seed('t6')
    const ghost = testEnv.authenticatedContext('u_ghost').firestore()
    await assertFails(getDoc(actRef(ghost, 't6')))
    await assertFails(setDoc(actRef(ghost, 't7'), payload({ uid: 'u_ghost' })))
  })
})

// ── Exact shape ──────────────────────────────────────────────────────────────

describe('exact shape', () => {
  it('rejects an unknown extra field', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'k1'), payload(USERS.pm, { predecessors: [] })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'k2'), payload(USERS.pm, { baselineStart: '2026-10-20' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'k3'), payload(USERS.pm, { isAdmin: true })))
  })

  it('rejects a missing required field', async () => {
    for (const key of ['name', 'status', 'plannedStart', 'plannedFinish', 'percentComplete', 'revision', 'sortOrder', 'isMilestone']) {
      const p = payload(USERS.pm)
      delete p[key]
      await assertFails(setDoc(actRef(ctx(USERS.pm), `m-${key}`), p))
    }
  })

  it('rejects wrong types', async () => {
    const bad = [
      { name: 42 },
      { description: null },
      { notes: 7 },
      { isMilestone: 'yes' },
      { sortOrder: '10' },
      { revision: '1' },
      { percentComplete: '50' },
    ]
    for (const [i, o] of bad.entries()) {
      await assertFails(setDoc(actRef(ctx(USERS.pm), `t-${i}`), payload(USERS.pm, o)))
    }
  })

  it('rejects an empty or whitespace-only name, and one over 120 characters', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'n1'), payload(USERS.pm, { name: '' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'n2'), payload(USERS.pm, { name: '   ' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'n3'), payload(USERS.pm, { name: 'x'.repeat(121) })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'n4'), payload(USERS.pm, { name: 'x'.repeat(120) })))
  })

  it('bounds description and notes at 500 characters', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'd1'), payload(USERS.pm, { description: 'x'.repeat(501) })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'd2'), payload(USERS.pm, { notes: 'x'.repeat(501) })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'd3'), payload(USERS.pm, { description: 'x'.repeat(500) })))
  })

  it('rejects revision other than 1', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'v1'), payload(USERS.pm, { revision: 2 })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'v2'), payload(USERS.pm, { revision: 0 })))
  })
})

// ── Status set ───────────────────────────────────────────────────────────────

describe('status set', () => {
  it('accepts the four non-terminal statuses at create', async () => {
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'st1'), payload(USERS.pm, { status: 'not_started' })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'st2'), payload(USERS.pm, { status: 'in_progress', actualStart: '2026-10-20', percentComplete: 30 })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'st3'), payload(USERS.pm, { status: 'on_hold', percentComplete: 40, actualStart: '2026-10-20' })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'st4'), payload(USERS.pm, { status: 'completed', percentComplete: 100, actualStart: '2026-10-20', actualFinish: '2026-10-24' })))
  })

  it('rejects an unknown status', async () => {
    for (const s of ['blocked', 'draft', 'active', 'archived', '', 'NOT_STARTED']) {
      await assertFails(setDoc(actRef(ctx(USERS.pm), `bs-${s || 'empty'}`), payload(USERS.pm, { status: s })))
    }
  })

  it('rejects creating an activity already cancelled — cancellation needs its own branch', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'st5'), payload(USERS.pm, { status: 'cancelled' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'st6'), payload(USERS.pm, {
      status: 'cancelled', cancelReason: 'Never wanted', cancelledAt: serverTimestamp(), cancelledBy: USERS.pm.uid,
    })))
  })
})

// ── Date invariants ──────────────────────────────────────────────────────────

describe('date invariants', () => {
  it('requires the ISO date-only shape on planned dates', async () => {
    for (const [i, bad] of ['2026-10-5', '26-10-05', '2026/10/05', '2026-10-05T00:00:00Z', '', 'today'].entries()) {
      await assertFails(setDoc(actRef(ctx(USERS.pm), `ds-${i}`), payload(USERS.pm, { plannedStart: bad })))
    }
  })

  it('rejects a Timestamp where a programme date belongs', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'ts1'), payload(USERS.pm, { plannedStart: Timestamp.now() })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'ts2'), payload(USERS.pm, { plannedFinish: Timestamp.now() })))
  })

  it('rejects a finish before the start, and accepts a same-day activity', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'do1'), payload(USERS.pm, {
      plannedStart: '2026-10-24', plannedFinish: '2026-10-20',
    })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'do2'), payload(USERS.pm, {
      plannedStart: '2026-10-20', plannedFinish: '2026-10-20',
    })))
  })

  it('accepts null actual dates and rejects malformed ones', async () => {
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'ad1'), payload(USERS.pm)))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'ad2'), payload(USERS.pm, {
      status: 'in_progress', actualStart: '20/10/2026',
    })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'ad3'), payload(USERS.pm, {
      status: 'in_progress', actualStart: '2026-10-20', actualFinish: 'soon',
    })))
  })

  it('rejects an actual finish before the actual start', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'ao1'), payload(USERS.pm, {
      status: 'completed', percentComplete: 100,
      actualStart: '2026-10-24', actualFinish: '2026-10-20',
    })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'ao2'), payload(USERS.pm, {
      status: 'completed', percentComplete: 100,
      actualStart: '2026-10-20', actualFinish: '2026-10-24',
    })))
  })

  it('⚠️ ACCEPTS an impossible calendar date of valid shape — rules have no calendar', async () => {
    // Documented client-only gap (Deferred Control 20). The app rejects these;
    // a direct SDK call does not.
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'cal1'), payload(USERS.pm, {
      plannedStart: '2026-02-30', plannedFinish: '2026-02-30',
    })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'cal2'), payload(USERS.pm, {
      plannedStart: '2026-04-31', plannedFinish: '2026-04-31',
    })))
  })
})

// ── Milestone invariants ─────────────────────────────────────────────────────

describe('milestone invariants', () => {
  it('requires a milestone to start and finish on the same day', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'ms1'), payload(USERS.pm, {
      isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-24',
    })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'ms2'), payload(USERS.pm, {
      isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20',
    })))
  })

  it('restricts milestone progress to 0 or 100', async () => {
    const base = { isMilestone: true, plannedStart: '2026-10-20', plannedFinish: '2026-10-20' }
    for (const [i, p] of [1, 50, 99].entries()) {
      await assertFails(setDoc(actRef(ctx(USERS.pm), `mp-${i}`), payload(USERS.pm, {
        ...base, percentComplete: p, status: 'on_hold', actualStart: '2026-10-20',
      })))
    }
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'mp-0'), payload(USERS.pm, { ...base, percentComplete: 0 })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'mp-100'), payload(USERS.pm, {
      ...base, percentComplete: 100, status: 'completed', actualFinish: '2026-10-20',
    })))
  })
})

// ── Percentage bounds ────────────────────────────────────────────────────────

describe('percentage bounds', () => {
  it('rejects out-of-range values', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'p1'), payload(USERS.pm, { percentComplete: -1, status: 'on_hold' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'p2'), payload(USERS.pm, { percentComplete: 101, status: 'on_hold' })))
  })

  it('rejects a NON-INTEGER percentage', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'p3'), payload(USERS.pm, { percentComplete: 12.5, status: 'on_hold', actualStart: '2026-10-20' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'p4'), payload(USERS.pm, { percentComplete: 0.5, status: 'on_hold', actualStart: '2026-10-20' })))
  })

  it('accepts the whole-number boundaries', async () => {
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'p5'), payload(USERS.pm, { percentComplete: 0 })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'p6'), payload(USERS.pm, {
      percentComplete: 100, status: 'completed', actualFinish: '2026-10-24',
    })))
  })
})

// ── Status invariants ────────────────────────────────────────────────────────

describe('status invariants', () => {
  it('not_started must be 0% with no actual dates', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'i1'), payload(USERS.pm, { percentComplete: 10 })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'i2'), payload(USERS.pm, { actualStart: '2026-10-20' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'i3'), payload(USERS.pm, { actualFinish: '2026-10-24' })))
  })

  it('in_progress needs an actual start date', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'i4'), payload(USERS.pm, { status: 'in_progress', percentComplete: 40 })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'i5'), payload(USERS.pm, {
      status: 'in_progress', percentComplete: 40, actualStart: '2026-10-20',
    })))
  })

  it('completed must be 100% with an actual finish date', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'i6'), payload(USERS.pm, {
      status: 'completed', percentComplete: 90, actualFinish: '2026-10-24',
    })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'i7'), payload(USERS.pm, {
      status: 'completed', percentComplete: 100,
    })))
  })

  it('on_hold keeps its progress and actual start', async () => {
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'i8'), payload(USERS.pm, {
      status: 'on_hold', percentComplete: 45, actualStart: '2026-10-20',
    })))
  })
})

// ── Pair consistency ─────────────────────────────────────────────────────────

describe('responsible and cost-code pair consistency', () => {
  it('accepts both-absent and both-present', async () => {
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'pr1'), payload(USERS.pm)))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'pr2'), payload(USERS.pm, {
      responsibleContactId: 'contact1', responsibleName: 'ABC Concrete Pty Ltd',
      costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab',
    })))
  })

  it('rejects a half-set responsible pair', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'pr3'), payload(USERS.pm, { responsibleContactId: 'contact1' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'pr4'), payload(USERS.pm, { responsibleName: 'Ghost' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'pr5'), payload(USERS.pm, {
      responsibleContactId: 'contact1', responsibleName: '   ',
    })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'pr6'), payload(USERS.pm, {
      responsibleContactId: '', responsibleName: 'ABC',
    })))
  })

  it('rejects a half-set cost-code pair', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'pr7'), payload(USERS.pm, { costCodeId: 'cc1' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'pr8'), payload(USERS.pm, { costCodeName: '03-100' })))
  })

  it('bounds the frozen name snapshots at 120 characters', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'pr9'), payload(USERS.pm, {
      responsibleContactId: 'c1', responsibleName: 'x'.repeat(121),
    })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'pr10'), payload(USERS.pm, {
      costCodeId: 'cc1', costCodeName: 'x'.repeat(121),
    })))
  })

  it('⚠️ ACCEPTS ids that name nothing — rules cannot verify a reference', async () => {
    // Documented client-only gap (Deferred Control 20).
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'pr11'), payload(USERS.pm, {
      responsibleContactId: 'does-not-exist', responsibleName: 'Imaginary Pty Ltd',
      costCodeId: 'also-fake', costCodeName: 'Not a cost code',
    })))
  })
})

// ── Forged audit fields ──────────────────────────────────────────────────────

describe('forged audit fields', () => {
  it('rejects a createdBy that is not the caller', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'f1'), payload(USERS.pm, { createdBy: USERS.admin.uid })))
  })

  it('rejects an updatedBy that is not the caller, at create and at edit', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'f2'), payload(USERS.pm, { updatedBy: USERS.admin.uid })))
    await seed('f3')
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'f3'), edit(USERS.admin, { name: 'Renamed' })))
  })

  it('rejects a client-supplied createdAt or updatedAt', async () => {
    for (const [i, clock] of CLIENT_CLOCKS.entries()) {
      await assertFails(setDoc(actRef(ctx(USERS.pm), `f4-${i}`), payload(USERS.pm, { createdAt: clock() })))
      await assertFails(setDoc(actRef(ctx(USERS.pm), `f5-${i}`), payload(USERS.pm, { updatedAt: clock() })))
    }
  })

  it('rejects a forged cancellation stamp at create', async () => {
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'f6'), payload(USERS.pm, { cancelReason: 'pre-cancelled' })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'f7'), payload(USERS.pm, { cancelledBy: USERS.pm.uid })))
    await assertFails(setDoc(actRef(ctx(USERS.pm), 'f8'), payload(USERS.pm, { cancelledAt: Timestamp.now() })))
  })

  it('rejects an edit that forges a cancellation stamp without cancelling', async () => {
    await seed('f9')
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'f9'), edit(USERS.pm, { cancelledBy: USERS.pm.uid })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'f10'), edit(USERS.pm, { cancelReason: 'sneaky' })))
  })
})

// ── Immutable core ───────────────────────────────────────────────────────────

describe('immutable core', () => {
  it('rejects rewriting createdAt, createdBy or revision on an edit', async () => {
    await seed('im1')
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'im1'), edit(USERS.pm, { createdBy: USERS.pm.uid })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'im1'), edit(USERS.pm, { createdAt: serverTimestamp() })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'im1'), edit(USERS.pm, { revision: 2 })))
  })

  it('rejects rewriting createdAt/createdBy/revision while cancelling', async () => {
    await seed('im2')
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'im2'), cancelWrite(USERS.pm, 'Descoped', { revision: 2 })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'im2'), cancelWrite(USERS.pm, 'Descoped', { createdBy: USERS.pm.uid })))
  })
})

// ── Ordinary edits, including backwards correction ───────────────────────────

describe('ordinary edits', () => {
  it('allows a writer to edit content while the activity is live', async () => {
    await seed('e1')
    await assertSucceeds(updateDoc(actRef(ctx(USERS.pm), 'e1'), edit(USERS.pm, {
      name: 'Ground floor slab — revised',
      plannedStart: '2026-10-21', plannedFinish: '2026-10-28',
      notes: 'Pushed by weather',
    })))
  })

  it('allows moving forward through the programme', async () => {
    await seed('e2')
    await assertSucceeds(updateDoc(actRef(ctx(USERS.pm), 'e2'), edit(USERS.pm, {
      status: 'in_progress', actualStart: '2026-10-20', percentComplete: 35,
    })))
  })

  it('ALLOWS BACKWARDS CORRECTION — completed back to in_progress', async () => {
    await seed('e3', {
      status: 'completed', percentComplete: 100,
      actualStart: '2026-10-20', actualFinish: '2026-10-24',
    })
    await assertSucceeds(updateDoc(actRef(ctx(USERS.pm), 'e3'), edit(USERS.pm, {
      status: 'in_progress', percentComplete: 80, actualFinish: null,
    })))
  })

  it('ALLOWS BACKWARDS CORRECTION — in_progress back to not_started', async () => {
    await seed('e4', { status: 'in_progress', percentComplete: 30, actualStart: '2026-10-20' })
    await assertSucceeds(updateDoc(actRef(ctx(USERS.pm), 'e4'), edit(USERS.pm, {
      status: 'not_started', percentComplete: 0, actualStart: null, actualFinish: null,
    })))
  })

  it('still enforces every invariant on an edit', async () => {
    await seed('e5')
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'e5'), edit(USERS.pm, { status: 'in_progress' })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'e5'), edit(USERS.pm, { percentComplete: 150 })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'e5'), edit(USERS.pm, { plannedFinish: '2026-10-01' })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'e5'), edit(USERS.pm, { name: '' })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'e5'), edit(USERS.pm, { status: 'blocked' })))
  })

  it('rejects adding an unknown field through an edit', async () => {
    await seed('e6')
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'e6'), edit(USERS.pm, { predecessors: ['e5'] })))
  })

  it('rejects an edit that omits the update stamps', async () => {
    await seed('e7')
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'e7'), { name: 'Silent rename' }))
  })

  it('⚠️ ACCEPTS a duplicate sortOrder — uniqueness is not enforceable', async () => {
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'so1'), payload(USERS.pm, { sortOrder: 10 })))
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'so2'), payload(USERS.pm, { sortOrder: 10 })))
  })

  it('⚠️ ACCEPTS a full document overwrite — this collection is last-write-wins', async () => {
    await seed('lww1')
    let existing = null
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const snap = await getDoc(doc(c.firestore(), activitiesPath(), 'lww1'))
      existing = snap.data()
    })
    await assertSucceeds(setDoc(actRef(ctx(USERS.pm), 'lww1'), replace(USERS.pm, {
      name: 'Clobbered by the second editor',
      createdAt: existing.createdAt,
      createdBy: existing.createdBy,
      updatedAt: serverTimestamp(),
      updatedBy: USERS.pm.uid,
    })))
  })
})

// ── Cancellation ─────────────────────────────────────────────────────────────

describe('cancellation', () => {
  it('allows a writer to cancel with a reason', async () => {
    await seed('x1')
    await assertSucceeds(updateDoc(actRef(ctx(USERS.pm), 'x1'), cancelWrite(USERS.pm, 'Descoped by client')))
  })

  it('allows cancelling from any live status', async () => {
    await seed('x2', { status: 'in_progress', percentComplete: 40, actualStart: '2026-10-20' })
    await seed('x3', { status: 'on_hold', percentComplete: 10, actualStart: '2026-10-20' })
    await seed('x4', { status: 'completed', percentComplete: 100, actualFinish: '2026-10-24' })
    for (const id of ['x2', 'x3', 'x4']) {
      await assertSucceeds(updateDoc(actRef(ctx(USERS.admin), id), cancelWrite(USERS.admin)))
    }
  })

  it('requires a NON-WHITESPACE reason', async () => {
    await seed('x5')
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x5'), cancelWrite(USERS.pm, '')))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x5'), cancelWrite(USERS.pm, '   ')))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x5'), cancelWrite(USERS.pm, '\n\t ')))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x5'), cancelWrite(USERS.pm, 'x'.repeat(501))))
  })

  it('requires genuine cancellation audit stamps', async () => {
    await seed('x6')
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x6'), cancelWrite(USERS.pm, 'Descoped', { cancelledBy: USERS.admin.uid })))
    for (const [i, clock] of CLIENT_CLOCKS.entries()) {
      await seed(`x7-${i}`)
      await assertFails(updateDoc(actRef(ctx(USERS.pm), `x7-${i}`), cancelWrite(USERS.pm, 'Descoped', { cancelledAt: clock() })))
    }
  })

  it('restricts cancellation to the cancellation keys — no content edit may ride along', async () => {
    await seed('x8')
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x8'), cancelWrite(USERS.pm, 'Descoped', { name: 'Renamed while cancelling' })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x8'), cancelWrite(USERS.pm, 'Descoped', { percentComplete: 100 })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x8'), cancelWrite(USERS.pm, 'Descoped', { plannedFinish: '2027-01-01' })))
  })

  it('makes cancellation TERMINAL — no edit, no reopen, no re-cancel', async () => {
    await seed('x9', {
      status: 'cancelled', cancelReason: 'Descoped', cancelledAt: Timestamp.now(), cancelledBy: USERS.pm.uid,
    })
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x9'), edit(USERS.pm, { name: 'Back from the dead' })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x9'), edit(USERS.pm, { status: 'in_progress', actualStart: '2026-10-20' })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x9'), edit(USERS.pm, { status: 'not_started' })))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x9'), cancelWrite(USERS.pm, 'Again')))
    await assertFails(updateDoc(actRef(ctx(USERS.pm), 'x9'), edit(USERS.pm, { cancelReason: 'Different reason' })))
  })

  it('a cancelled activity remains READABLE — it is retained programme history', async () => {
    await seed('x10', {
      status: 'cancelled', cancelReason: 'Descoped', cancelledAt: Timestamp.now(), cancelledBy: USERS.pm.uid,
    })
    for (const user of READERS) {
      await assertSucceeds(getDoc(actRef(ctx(user), 'x10')))
    }
  })
})

// ── Deletion ─────────────────────────────────────────────────────────────────

describe('deletion', () => {
  it('HARD DELETE IS BLOCKED for every role', async () => {
    await seed('del1')
    for (const user of Object.values(USERS)) {
      await assertFails(deleteDoc(actRef(ctx(user), 'del1')))
    }
  })

  it('a cancelled activity cannot be deleted either', async () => {
    await seed('del2', {
      status: 'cancelled', cancelReason: 'Descoped', cancelledAt: Timestamp.now(), cancelledBy: USERS.pm.uid,
    })
    await assertFails(deleteDoc(actRef(ctx(USERS.admin), 'del2')))
    await assertFails(deleteDoc(actRef(ctx(USERS.pm), 'del2')))
  })
})

// ── Non-regression: the programme touches no financial collection ────────────

describe('financial isolation', () => {
  it('the activities block grants no access to any financial collection', async () => {
    // A subcontractor denied the programme is still denied cash records, and a
    // qs that may READ the programme still cannot write one. Proves the new
    // block introduced no cross-collection permission.
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects/${PROJECT_A}/clientReceipts`, 'cr1'), {
        status: 'posted', amount: 100,
      })
    })
    await assertFails(getDoc(doc(ctx(USERS.sub), `companies/${COMPANY_A}/projects/${PROJECT_A}/clientReceipts`, 'cr1')))
    await assertSucceeds(getDoc(doc(ctx(USERS.qs), `companies/${COMPANY_A}/projects/${PROJECT_A}/clientReceipts`, 'cr1')))
  })

  it('a programme writer cannot write a budget line through this branch', async () => {
    expect(typeof USERS.pm.uid).toBe('string')
    await assertFails(setDoc(
      doc(ctx(USERS.pm), `companies/${COMPANY_B}/projects/${PROJECT_A}/budgetLines`, 'bl1'),
      { costCodeId: 'cc1', budgeted: 1000 },
    ))
  })
})
