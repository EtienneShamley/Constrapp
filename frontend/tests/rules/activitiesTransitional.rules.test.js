import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore'

// ── ADR-65 STAGE-1 TRANSITIONAL ruleset — the activities block, emulator proof ─
//
// `firestore.transitional.rules` is derived from `firestore.rules` by
// scripts/build-transitional-rules.mjs (three rule lines differ; pinned by
// tests/unit/rulesTransitional.test.js). It is the ruleset deployed FIRST,
// while the GANTT 1A1 bundle is still served. This file proves, against THAT
// file, exactly what the 1A2 rollout relies on:
//
//   1. the 1A1 bundle's edit and cancel (revision UNCHANGED at 1) are ACCEPTED;
//   2. the 1A2 bundle's edit and cancel (revision + 1) are ACCEPTED;
//   3. a revision that skips (+2) or goes backwards is REFUSED even in Stage 1;
//   4. the optional `predecessors` key and its first/last pins are ACTIVE
//      from Stage 1 on (the 1A1 bundle never writes the key, so it is simply
//      absent on its documents);
//   5. every other control is unchanged — roles, tenancy, shape, stamps, the
//      cancellation key restriction, create at revision 1.
//
// The FINAL ruleset's behaviour (an unchanged revision DENIED) is proven by
// tests/rules/activities.rules.test.js against firestore.rules.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.transitional.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const PROJECT_A = 'projectA'
const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: 'companyB' },
}

let testEnv
const path = `companies/${COMPANY_A}/projects/${PROJECT_A}/activities`
const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const ref = (db, id) => doc(db, path, id)

function payload(user, overrides = {}) {
  return {
    name: 'Ground floor slab', description: '', isMilestone: false, status: 'not_started',
    plannedStart: '2026-10-20', plannedFinish: '2026-10-24', actualStart: null, actualFinish: null,
    percentComplete: 0, responsibleContactId: null, responsibleName: '', costCodeId: null, costCodeName: '',
    sortOrder: 10, notes: '', cancelReason: '', cancelledAt: null, cancelledBy: null,
    revision: 1, createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}
async function seed(id, overrides = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), path, id), { ...payload(USERS.admin), createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...overrides })
  })
}
const raw = async (id) => {
  let data = null
  await testEnv.withSecurityRulesDisabled(async (c) => { data = (await getDoc(doc(c.firestore(), path, id))).data() ?? null })
  return data
}

// The two write shapes: the 1A1 bundle leaves `revision` alone; the 1A2
// bundle writes stored + 1.
const oldEdit = (user, extra = {}) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra })
const newEdit = (user, revision, extra = {}) => ({ revision, updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra })
const oldCancel = (user, extra = {}) => ({
  status: 'cancelled', cancelReason: 'Descoped', cancelledAt: serverTimestamp(), cancelledBy: user.uid,
  updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})
const newCancel = (user, revision, extra = {}) => ({ ...oldCancel(user), revision, ...extra })
const pred = (activityId, lagDays = 0) => ({ activityId, type: 'FS', lagDays })

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
afterAll(async () => { if (testEnv) await testEnv.cleanup() })
beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
  })
})

describe('Stage 1 accepts BOTH client payloads on edit and cancel', () => {
  it('the 1A1 bundle (revision unchanged) can still edit and cancel', async () => {
    await seed('o1'); await seed('o2')
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm), 'o1'), oldEdit(USERS.pm, { name: 'Old-client edit' })))
    expect((await raw('o1')).revision).toBe(1)
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm), 'o2'), oldCancel(USERS.pm)))
    expect((await raw('o2')).revision).toBe(1)
  })

  it('the 1A2 bundle (revision + 1) can edit and cancel, and the stored revision advances', async () => {
    await seed('n1'); await seed('n2')
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm), 'n1'), newEdit(USERS.pm, 2, { name: 'Guarded edit' })))
    expect((await raw('n1')).revision).toBe(2)
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm), 'n1'), newEdit(USERS.pm, 3, { name: 'Guarded again' })))
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm), 'n2'), newCancel(USERS.pm, 2)))
    expect((await raw('n2')).revision).toBe(2)
  })

  it('a skipped (+2) or backwards revision is refused even in Stage 1', async () => {
    await seed('s1', { revision: 2 })
    await assertFails(updateDoc(ref(ctx(USERS.pm), 's1'), newEdit(USERS.pm, 4)))
    await assertFails(updateDoc(ref(ctx(USERS.pm), 's1'), newEdit(USERS.pm, 1)))
    await assertFails(updateDoc(ref(ctx(USERS.pm), 's1'), newEdit(USERS.pm, '3')))
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm), 's1'), newEdit(USERS.pm, 2)))   // unchanged: the old shape
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm), 's1'), newEdit(USERS.pm, 3)))   // +1: the new shape
  })

  it('an old-client edit after a new-client edit still lands (the documented Stage-1 gap, DC41)', async () => {
    await seed('g1')
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm), 'g1'), newEdit(USERS.pm, 2, { name: 'New client' })))
    await assertSucceeds(updateDoc(ref(ctx(USERS.admin), 'g1'), oldEdit(USERS.admin, { name: 'Old client, no revision' })))
    const after = await raw('g1')
    expect(after.revision).toBe(2)
    expect(after.updatedBy).toBe(USERS.admin.uid) // the stamp moved — what the new client's version check detects
  })
})

describe('Stage 1 already enforces the predecessor pins and everything else', () => {
  it('create still requires revision 1 and accepts the optional predecessors key', async () => {
    await seed('src')
    await assertSucceeds(setDoc(ref(ctx(USERS.pm), 'c1'), payload(USERS.pm)))
    await assertSucceeds(setDoc(ref(ctx(USERS.pm), 'c2'), payload(USERS.pm, { predecessors: [pred('src', 3)] })))
    await assertFails(setDoc(ref(ctx(USERS.pm), 'c3'), payload(USERS.pm, { revision: 2 })))
  })

  it('first/last pins, self-reference, missing source, lag range and size are ACTIVE', async () => {
    await seed('src')
    await assertFails(setDoc(ref(ctx(USERS.pm), 'p1'), payload(USERS.pm, { predecessors: [pred('p1')] })))
    await assertFails(setDoc(ref(ctx(USERS.pm), 'p2'), payload(USERS.pm, { predecessors: [pred('ghost')] })))
    await assertFails(setDoc(ref(ctx(USERS.pm), 'p3'), payload(USERS.pm, { predecessors: [pred('src', -1)] })))
    await assertFails(setDoc(ref(ctx(USERS.pm), 'p4'), payload(USERS.pm, { predecessors: [pred('src', 366)] })))
    await assertFails(setDoc(ref(ctx(USERS.pm), 'p5'), payload(USERS.pm, { predecessors: [{ activityId: 'src', type: 'SS', lagDays: 0 }] })))
    await assertFails(setDoc(ref(ctx(USERS.pm), 'p6'), payload(USERS.pm, { predecessors: Array.from({ length: 21 }, () => pred('src')) })))
    await assertFails(setDoc(ref(ctx(USERS.pm), 'p7'), payload(USERS.pm, { predecessors: [pred('src'), pred('ghost')] })))
    // An old-client edit (no revision) may not smuggle a malformed list either.
    await seed('p8')
    await assertFails(updateDoc(ref(ctx(USERS.pm), 'p8'), oldEdit(USERS.pm, { predecessors: ['src'] })))
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm), 'p8'), oldEdit(USERS.pm, { predecessors: [pred('src')] })))
  })

  it('roles, tenancy, stamps and the cancellation key restriction are unchanged', async () => {
    await seed('r1'); await seed('src')
    await assertFails(updateDoc(ref(ctx(USERS.qs), 'r1'), oldEdit(USERS.qs, { name: 'QS' })))
    await assertFails(updateDoc(ref(ctx(USERS.qs), 'r1'), newEdit(USERS.qs, 2, { name: 'QS' })))
    await assertFails(updateDoc(ref(ctx(USERS.sub), 'r1'), newEdit(USERS.sub, 2, { name: 'Sub' })))
    await assertFails(updateDoc(ref(ctx(USERS.other), 'r1'), newEdit(USERS.other, 2, { name: 'Other' })))
    await assertFails(updateDoc(ref(ctx(USERS.pm), 'r1'), { name: 'No stamps', revision: 2 }))
    await assertFails(updateDoc(ref(ctx(USERS.pm), 'r1'), newEdit(USERS.pm, 2, { updatedBy: USERS.admin.uid })))
    await assertFails(updateDoc(ref(ctx(USERS.pm), 'r1'), newCancel(USERS.pm, 2, { name: 'Renamed while cancelling' })))
    await assertFails(updateDoc(ref(ctx(USERS.pm), 'r1'), newCancel(USERS.pm, 2, { predecessors: [pred('src')] })))
    await assertFails(updateDoc(ref(ctx(USERS.pm), 'r1'), newEdit(USERS.pm, 2, { createdBy: USERS.pm.uid })))
  })
})
