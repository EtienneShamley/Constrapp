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
  doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, runTransaction,
} from 'firebase/firestore'
import { runAcknowledge, runWithdraw } from '../../src/lib/pulseAcknowledgementActions'
import { ACK_ERROR } from '../../src/lib/pulseAttention'
import { INDICATOR } from '../../src/lib/pulse'

// ── PULSE™ acknowledgement Security Rules — emulator tests (ADR-49) ──────────
//
// Executes docs/TESTING.md §25-x against the Firestore emulator. These verify
// the RULES, not the UI: every write below is a direct SDK call, exactly what
// a client bypassing the app would issue.
//
// What makes this block different:
//   · QS IS READ-ONLY (as on the programme).
//   · `revision` INCREMENTS — every update must carry exactly +1, so a blind
//     overwrite that does not know the current revision is rejected.
//   · the document id IS the indicator id, from a six-value allowlist.
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (the documented
// client-only gaps — docs/SECURITY.md → Deferred Control 31): that a PULSE
// finding existed, that evidenceKeys name real records (or are strings at
// all), that reviewBy is a real calendar day or not already past.
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set.

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
const INDICATORS = Object.values(INDICATOR)
const ID = INDICATOR.OVERDUE_ACTIVITIES

let testEnv

const ackPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/pulseAcknowledgements`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const ackRef = (db, id = ID, companyId = COMPANY_A) => doc(db, ackPath(companyId), id)

// A valid first acknowledgement, exactly as lib/pulseAcknowledgementActions.js writes it.
function payload(user, overrides = {}) {
  return {
    indicatorId: ID,
    status: 'active',
    evidenceKeys: ['a1', 'a2'],
    note: 'Chasing the subcontractor for a recovery programme',
    reviewBy: '2026-11-02',
    acknowledgedAt: serverTimestamp(),
    acknowledgedBy: user.uid,
    withdrawnAt: null,
    withdrawnBy: null,
    revision: 1,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

// Seeds a document directly, bypassing rules — the arrange step for updates.
async function seed(id = ID, overrides = {}, user = USERS.pm) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(doc(db, ackPath(), id), {
      ...payload(user),
      indicatorId: id,
      acknowledgedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...overrides,
    })
  })
}

// The write shapes the app performs.
const reack = (user, revision, extra = {}) => ({
  status: 'active',
  evidenceKeys: ['a1', 'a2', 'a3'],
  note: 'Updated plan',
  reviewBy: '2026-12-01',
  acknowledgedAt: serverTimestamp(),
  acknowledgedBy: user.uid,
  withdrawnAt: null,
  withdrawnBy: null,
  revision,
  updatedAt: serverTimestamp(),
  updatedBy: user.uid,
  ...extra,
})
const withdraw = (user, revision, extra = {}) => ({
  status: 'withdrawn',
  withdrawnAt: serverTimestamp(),
  withdrawnBy: user.uid,
  revision,
  updatedAt: serverTimestamp(),
  updatedBy: user.uid,
  ...extra,
})

// Client-supplied clock values that must NEVER satisfy `== request.time`
// (deliberately skewed — docs/TESTING.md §0).
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
  it('admin, project_manager and qs can READ an acknowledgement and list the collection', async () => {
    await seed()
    for (const user of READERS) {
      await assertSucceeds(getDoc(ackRef(ctx(user))))
      await assertSucceeds(getDocs(collection(ctx(user), ackPath())))
    }
  })

  it('subcontractor, client and super_admin CANNOT read', async () => {
    await seed()
    for (const user of NON_READERS) {
      await assertFails(getDoc(ackRef(ctx(user))))
      await assertFails(getDocs(collection(ctx(user), ackPath())))
    }
  })

  it('cross-tenant and unauthenticated reads are denied', async () => {
    await seed()
    await assertFails(getDoc(ackRef(ctx(USERS.other))))
    await assertFails(getDoc(ackRef(anon())))
  })

  it('admin and project_manager can CREATE a first acknowledgement for every one of the six indicators', async () => {
    for (const user of WRITERS) {
      await testEnv.clearFirestore()
      await testEnv.withSecurityRulesDisabled(async (c) => {
        const db = c.firestore()
        for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId })
      })
      for (const id of INDICATORS) {
        await assertSucceeds(setDoc(ackRef(ctx(user), id), payload(user, { indicatorId: id })))
      }
    }
  })

  it('QS IS READ-ONLY — it can read but cannot create, re-acknowledge or withdraw', async () => {
    await seed()
    await assertSucceeds(getDoc(ackRef(ctx(USERS.qs))))
    await assertFails(setDoc(ackRef(ctx(USERS.qs), INDICATOR.FORECAST_INCOMPLETE), payload(USERS.qs, { indicatorId: INDICATOR.FORECAST_INCOMPLETE })))
    await assertFails(updateDoc(ackRef(ctx(USERS.qs)), reack(USERS.qs, 2)))
    await assertFails(updateDoc(ackRef(ctx(USERS.qs)), withdraw(USERS.qs, 2)))
  })

  it('subcontractor, client, super_admin, cross-tenant and unauthenticated users cannot create or update', async () => {
    await seed()
    for (const user of [...NON_READERS, USERS.other]) {
      await assertFails(setDoc(ackRef(ctx(user), INDICATOR.FORECAST_INCOMPLETE), payload(user, { indicatorId: INDICATOR.FORECAST_INCOMPLETE })))
      await assertFails(updateDoc(ackRef(ctx(user)), reack(user, 2)))
      await assertFails(updateDoc(ackRef(ctx(user)), withdraw(user, 2)))
    }
    await assertFails(setDoc(ackRef(anon(), INDICATOR.FORECAST_INCOMPLETE), payload(USERS.pm, { indicatorId: INDICATOR.FORECAST_INCOMPLETE })))
  })

  it('a cross-tenant admin cannot write into Company A even with a valid shape', async () => {
    await assertFails(setDoc(ackRef(ctx(USERS.other)), payload(USERS.other)))
  })

  it('an authenticated user with NO membership document is denied', async () => {
    const db = testEnv.authenticatedContext('u_orphan').firestore()
    await seed()
    await assertFails(getDoc(ackRef(db)))
    await assertFails(setDoc(ackRef(db, INDICATOR.FORECAST_INCOMPLETE), payload({ uid: 'u_orphan' }, { indicatorId: INDICATOR.FORECAST_INCOMPLETE })))
  })

  it('NOBODY can delete — not even company_admin', async () => {
    await seed()
    for (const user of Object.values(USERS)) {
      await assertFails(deleteDoc(ackRef(ctx(user))))
    }
    await assertFails(deleteDoc(ackRef(anon())))
  })
})

// ── Create shape ─────────────────────────────────────────────────────────────

describe('create — identity and allowlist', () => {
  it('an unknown indicator id (as document id) is rejected, even when the field agrees', async () => {
    for (const id of ['healthScore', 'forecastoverbudget', 'FORECAST_OVER_BUDGET', 'x']) {
      await assertFails(setDoc(ackRef(ctx(USERS.pm), id), payload(USERS.pm, { indicatorId: id })))
    }
  })

  it('the stored indicatorId must equal the document id', async () => {
    await assertFails(setDoc(ackRef(ctx(USERS.pm), INDICATOR.FORECAST_INCOMPLETE), payload(USERS.pm, { indicatorId: ID })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { indicatorId: null })))
  })

  it('a missing field is rejected', async () => {
    for (const key of Object.keys(payload(USERS.pm))) {
      const p = payload(USERS.pm)
      delete p[key]
      await assertFails(setDoc(ackRef(ctx(USERS.pm)), p))
    }
  })

  it('an extra field is rejected — including a would-be resolved flag, a name snapshot or an amount', async () => {
    for (const extra of [{ resolved: true }, { acknowledgedByName: 'Pat' }, { amount: 100 }, { severity: 'high' }, { companyId: COMPANY_A }]) {
      await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, extra)))
    }
  })

  it('create must be active, revision 1, with null withdraw stamps', async () => {
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { status: 'withdrawn' })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { status: 'resolved' })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { revision: 0 })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { revision: 2 })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { revision: '1' })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { withdrawnAt: serverTimestamp() })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { withdrawnBy: USERS.pm.uid })))
  })
})

describe('create — actors and timestamps', () => {
  it('acknowledgedBy, createdBy and updatedBy must be the caller', async () => {
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { acknowledgedBy: USERS.admin.uid })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { createdBy: USERS.admin.uid })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { updatedBy: USERS.admin.uid })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { acknowledgedBy: null })))
  })

  it('acknowledgedAt, createdAt and updatedAt must be the server time — a client clock is rejected', async () => {
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { acknowledgedAt: clock() })))
      await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { createdAt: clock() })))
      await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { updatedAt: clock() })))
    }
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { acknowledgedAt: null })))
  })
})

describe('create — note, review date and evidence keys', () => {
  it('note: required non-whitespace string, at most 500 characters', async () => {
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { note: '' })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { note: '   \n\t ' })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { note: null })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { note: 42 })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { note: 'x'.repeat(501) })))
    await assertSucceeds(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { note: 'x'.repeat(500) })))
  })

  it('reviewBy: required YYYY-MM-DD string', async () => {
    for (const bad of ['', null, '2026-1-5', '05/11/2026', '2026-13-01', '2026-00-10', '2026-11-32', 20261102, '2026-11-02T00:00:00Z']) {
      await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { reviewBy: bad })))
    }
    await assertSucceeds(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { reviewBy: '2027-01-31' })))
  })

  it('evidenceKeys: a list of at most 200 — 200 accepted, 201 rejected, non-list rejected, empty accepted (keyless findings)', async () => {
    const keys = (n) => Array.from({ length: n }, (_, i) => `k${i}`)
    await assertSucceeds(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { evidenceKeys: keys(200) })))
    await testEnv.clearFirestore()
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const db = c.firestore()
      for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId })
    })
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { evidenceKeys: keys(201) })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { evidenceKeys: 'a1' })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { evidenceKeys: null })))
    await assertFails(setDoc(ackRef(ctx(USERS.pm)), payload(USERS.pm, { evidenceKeys: { a1: true } })))
    await assertSucceeds(setDoc(ackRef(ctx(USERS.pm), INDICATOR.NEGATIVE_GROSS_PROFIT), payload(USERS.pm, { indicatorId: INDICATOR.NEGATIVE_GROSS_PROFIT, evidenceKeys: [] })))
  })

  it('DOCUMENTED GAP — rules accept an impossible-but-well-formed review date, a past review date, and non-string evidence keys', async () => {
    await assertSucceeds(setDoc(ackRef(ctx(USERS.pm), INDICATOR.FORECAST_INCOMPLETE), payload(USERS.pm, { indicatorId: INDICATOR.FORECAST_INCOMPLETE, reviewBy: '2026-02-30' })))
    await assertSucceeds(setDoc(ackRef(ctx(USERS.pm), INDICATOR.FORECAST_OVER_BUDGET), payload(USERS.pm, { indicatorId: INDICATOR.FORECAST_OVER_BUDGET, reviewBy: '2000-01-01' })))
    await assertSucceeds(setDoc(ackRef(ctx(USERS.pm), INDICATOR.PAST_DUE_SUPPLIER_INVOICES), payload(USERS.pm, { indicatorId: INDICATOR.PAST_DUE_SUPPLIER_INVOICES, evidenceKeys: [1, null, { x: 1 }] })))
  })
})

// ── Update — re-acknowledge ──────────────────────────────────────────────────

describe('update — re-acknowledge (a)', () => {
  it('active → active with revision + 1 succeeds for admin and PM; the previous content is replaced', async () => {
    for (const user of WRITERS) {
      await seed(ID, { revision: 4 })
      await assertSucceeds(updateDoc(ackRef(ctx(user)), reack(user, 5)))
    }
  })

  it('withdrawn → active (re-acknowledge after a withdrawal) succeeds and clears the withdraw stamps', async () => {
    await seed(ID, { status: 'withdrawn', withdrawnAt: Timestamp.now(), withdrawnBy: USERS.admin.uid, revision: 2 })
    await assertSucceeds(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 3)))
  })

  it('REVISION CONFLICTS — the same revision, +2, −1, a string, or an omitted revision are all rejected', async () => {
    await seed(ID, { revision: 2 })
    for (const revision of [2, 4, 1, '3', 3.5]) {
      await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, revision)))
    }
    const noRevision = reack(USERS.pm, 3)
    delete noRevision.revision
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), noRevision))
  })

  it('createdAt, createdBy and indicatorId are immutable', async () => {
    await seed()
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { createdBy: USERS.admin.uid })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { createdAt: Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')) })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { indicatorId: INDICATOR.FORECAST_INCOMPLETE })))
  })

  it('a re-acknowledgement cannot forge the actor, the stamp, or leave withdraw stamps behind', async () => {
    await seed()
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { acknowledgedBy: USERS.admin.uid })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { updatedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { acknowledgedAt: clock() })))
      await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { updatedAt: clock() })))
    }
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { withdrawnAt: serverTimestamp(), withdrawnBy: USERS.pm.uid })))
  })

  it('a re-acknowledgement is held to the full content shape', async () => {
    await seed()
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { note: '  ' })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { note: 'x'.repeat(501) })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { reviewBy: 'next week' })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { evidenceKeys: Array.from({ length: 201 }, (_, i) => `k${i}`) })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { status: 'resolved' })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), reack(USERS.pm, 2, { resolvedAt: serverTimestamp() })))
  })
})

// ── Update — withdraw ────────────────────────────────────────────────────────

describe('update — withdraw (b)', () => {
  it('active → withdrawn succeeds for admin and PM, touching only the withdraw keys', async () => {
    for (const user of WRITERS) {
      await seed(ID, { revision: 1 })
      await assertSucceeds(updateDoc(ackRef(ctx(user)), withdraw(user, 2)))
    }
  })

  it('another manager can withdraw an acknowledgement they did not make', async () => {
    await seed(ID, {}, USERS.pm)
    await assertSucceeds(updateDoc(ackRef(ctx(USERS.admin)), withdraw(USERS.admin, 2)))
  })

  it('withdrawn → withdrawn is rejected', async () => {
    await seed(ID, { status: 'withdrawn', withdrawnAt: Timestamp.now(), withdrawnBy: USERS.pm.uid, revision: 2 })
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 3)))
  })

  it('a withdrawal cannot carry a content edit, forge its actor or stamp, or skip the revision', async () => {
    await seed(ID, { revision: 1 })
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 2, { note: 'changed' })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 2, { reviewBy: '2030-01-01' })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 2, { evidenceKeys: [] })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 2, { withdrawnBy: USERS.admin.uid })))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 2, { updatedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 2, { withdrawnAt: clock() })))
      await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 2, { updatedAt: clock() })))
    }
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 1)))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 3)))
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), withdraw(USERS.pm, 2, { withdrawnAt: null })))
  })

  it('a bare status flip with no stamps is rejected', async () => {
    await seed()
    await assertFails(updateDoc(ackRef(ctx(USERS.pm)), { status: 'withdrawn', revision: 2, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid }))
  })
})

// ── The app's own transaction, against the real rules ────────────────────────

describe("the app's guarded transaction (lib/pulseAcknowledgementActions.js) against the real rules", () => {
  const sdk = { runTransaction, serverTimestamp }
  // withSecurityRulesDisabled does not return the callback's value — capture it.
  const stored = async (id = ID) => {
    let data
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const snap = await getDoc(doc(c.firestore(), ackPath(), id))
      data = snap.exists() ? snap.data() : null
    })
    return data
  }
  // One Firestore instance per call — the ref must belong to the db the
  // transaction runs on.
  const args = (user, extra = {}) => {
    const db = ctx(user)
    return {
      db, ref: ackRef(db), indicatorId: ID, seen: null,
      evidenceKeys: ['a2', 'a1'], note: 'Recovery programme requested', reviewBy: '2026-11-02', uid: user.uid, ...sdk, ...extra,
    }
  }
  const withdrawArgs = (user, seen) => {
    const db = ctx(user)
    return { db, ref: ackRef(db), seen, uid: user.uid, ...sdk }
  }

  it('first acknowledgement by a PM succeeds and stores revision 1 with sorted keys', async () => {
    const out = await runAcknowledge(args(USERS.pm))
    expect(out).toEqual({ kind: null, revision: 1 })
    const saved = await stored()
    expect(saved.revision).toBe(1)
    expect(saved.evidenceKeys).toEqual(['a1', 'a2'])
    expect(saved.status).toBe('active')
    expect(saved.acknowledgedBy).toBe(USERS.pm.uid)
    expect(saved.withdrawnAt).toBeNull()
  })

  it('re-acknowledge with the revision the user saw succeeds (revision 2); with a stale revision it is REFUSED and nothing changes', async () => {
    await seed(ID, { revision: 1, note: 'original' })
    const out = await runAcknowledge(args(USERS.admin, { seen: { revision: 1 } }))
    expect(out.revision).toBe(2)
    const stale = await runAcknowledge(args(USERS.pm, { seen: { revision: 1 }, note: 'stale' })).catch(e => e)
    expect(stale.kind).toBe(ACK_ERROR.STALE)
    const saved = await stored()
    expect(saved.revision).toBe(2)
    expect(saved.note).not.toBe('stale')
  })

  it('a user who saw NO acknowledgement cannot overwrite one that appeared meanwhile', async () => {
    await seed(ID, { revision: 1, note: 'first manager' })
    const err = await runAcknowledge(args(USERS.admin)).catch(e => e)
    expect(err.kind).toBe(ACK_ERROR.STALE)
    expect((await stored()).note).toBe('first manager')
  })

  it('withdraw succeeds with the seen revision; a second withdraw is INVALID; a stale withdraw is STALE', async () => {
    await seed(ID, { revision: 1 })
    const out = await runWithdraw(withdrawArgs(USERS.pm, { revision: 1 }))
    expect(out.revision).toBe(2)
    const again = await runWithdraw(withdrawArgs(USERS.pm, { revision: 2 })).catch(e => e)
    expect(again.kind).toBe(ACK_ERROR.INVALID)
    const stale = await runWithdraw(withdrawArgs(USERS.pm, { revision: 1 })).catch(e => e)
    expect(stale.kind).toBe(ACK_ERROR.STALE)
  })

  it('qs, subcontractor and client are refused by the RULES as PERMISSION, and nothing is written', async () => {
    for (const user of [USERS.qs, USERS.sub, USERS.client]) {
      const err = await runAcknowledge(args(user)).catch(e => e)
      expect(err.kind, user.role).toBe(ACK_ERROR.PERMISSION)
    }
    expect(await stored()).toBeNull()
  })

  it('the transaction never writes a document for a disallowed indicator id', async () => {
    const db = ctx(USERS.pm)
    const err = await runAcknowledge(args(USERS.pm, { db, indicatorId: 'healthScore', ref: ackRef(db, 'healthScore') })).catch(e => e)
    expect(err.kind).toBe(ACK_ERROR.PERMISSION)
  })
})
