import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import {
  doc, getDoc, getDocs, setDoc, updateDoc, collection, writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore'

// ── M2-A2 — the STAGE-1 TRANSITIONAL ruleset ─────────────────────────────────
//
// firestore.m2a2-transitional.rules is published FIRST, while the pre-M2-A2
// bundle is still being served. It differs from firestore.rules in the two
// directory-pairing lines only, so:
//
//   · the bundle in production keeps working — it creates and edits projects
//     WITHOUT a directory entry, and those writes are still accepted;
//   · the M2-A2 bundle's paired writes are accepted too;
//   · THE WHOLE READ BOUNDARY IS ALREADY FINAL — the project document is
//     internal-only, an external role needs an assignment, and a directory
//     entry can only ever mirror its project.
//
// What Stage 1 does NOT yet guarantee: that every project has an entry, or
// that an entry follows an edit made by the old bundle. A stale or missing
// entry discloses nothing that is not one of the five approved display
// fields; the backfill and the FINAL ruleset close it.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.m2a2-transitional.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const P = 'projectA'

const USERS = {
  admin:   { uid: 'u_admin',   role: 'company_admin',   companyId: COMPANY_A },
  pm:      { uid: 'u_pm',      role: 'project_manager', companyId: COMPANY_A },
  qs:      { uid: 'u_qs',      role: 'qs',              companyId: COMPANY_A },
  sub:     { uid: 'u_sub',     role: 'subcontractor',   companyId: COMPANY_A, projectIds: [P] },
  subNone: { uid: 'u_subNone', role: 'subcontractor',   companyId: COMPANY_A },
  sadmin:  { uid: 'u_sadmin',  role: 'super_admin',     companyId: COMPANY_A, projectIds: [P] },
}

let testEnv
const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const projRef = (db, id = P) => doc(db, 'companies', COMPANY_A, 'projects', id)
const dirRef  = (db, id = P) => doc(db, 'companies', COMPANY_A, 'projectDirectory', id)

const DISPLAY = { name: 'Riverside Tower', status: 'In Progress', location: 'Brisbane QLD', startDate: null, progress: 35 }
const projectPayload = (user, overrides = {}) => ({
  ...DISPLAY, budget: 4200000, currency: 'AUD', currencyLocked: true,
  createdAt: serverTimestamp(), createdBy: user.uid, ...overrides,
})

async function seedProject({ entry = true } = {}) {
  await testEnv.withSecurityRulesDisabled(async (admin) => {
    const db = admin.firestore()
    await setDoc(projRef(db), { ...DISPLAY, budget: 4200000, currency: 'AUD', currencyLocked: false, createdAt: Timestamp.now(), createdBy: 'u_admin' })
    if (entry) await setDoc(dirRef(db), { ...DISPLAY })
    await setDoc(doc(db, 'companies', COMPANY_A, 'projects', P, 'drawings', 'd1'), { title: 'Plan', status: 'active' })
  })
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
afterAll(async () => { if (testEnv) await testEnv.cleanup() })

beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (admin) => {
    const db = admin.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { name: u.uid, role: u.role, companyId: u.companyId, ...(u.projectIds ? { projectIds: u.projectIds } : {}) })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
  })
})

describe('STAGE 1 — the pre-M2-A2 bundle keeps working', () => {
  it('a project created WITHOUT a directory entry is still accepted (the old addDoc shape)', async () => {
    await assertSucceeds(setDoc(projRef(ctx(USERS.admin), 'oldBundle'), projectPayload(USERS.admin)))
  })

  it('a display-field edit WITHOUT the entry is still accepted (the old updateDoc shape)', async () => {
    await seedProject()
    await assertSucceeds(updateDoc(projRef(ctx(USERS.pm)), { name: 'Renamed by the old bundle', status: 'On Hold', startDate: null, location: 'Ipswich', progress: 50 }))
  })

  it('the existing project rules still apply to those writes', async () => {
    await seedProject()
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { status: 'Abandoned' }))
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { budget: 1 }))
    await assertFails(updateDoc(projRef(ctx(USERS.qs)), { name: 'QS rename' }))
    await assertFails(setDoc(projRef(ctx(USERS.qs), 'qsNew'), projectPayload(USERS.qs)))
  })
})

describe('STAGE 1 — the M2-A2 bundle’s paired writes are accepted', () => {
  it('paired create and paired edit', async () => {
    const db = ctx(USERS.admin)
    const create = writeBatch(db)
    create.set(projRef(db, 'newP'), projectPayload(USERS.admin))
    create.set(dirRef(db, 'newP'), { ...DISPLAY })
    await assertSucceeds(create.commit())
    const edit = writeBatch(db)
    edit.update(projRef(db, 'newP'), { progress: 70 })
    edit.set(dirRef(db, 'newP'), { ...DISPLAY, progress: 70 })
    await assertSucceeds(edit.commit())
  })
})

describe('STAGE 1 — the directory is ALREADY strict', () => {
  it('an entry must mirror its project and hold the five keys only', async () => {
    await seedProject({ entry: false })
    const db = ctx(USERS.admin)
    await assertFails(setDoc(dirRef(db), { ...DISPLAY, budget: 4200000 }))
    await assertFails(setDoc(dirRef(db), { ...DISPLAY, name: 'Not the project' }))
    await assertFails(setDoc(dirRef(db, 'ghost'), { ...DISPLAY }))
    await assertFails(setDoc(dirRef(ctx(USERS.qs)), { ...DISPLAY }))
    await assertFails(setDoc(dirRef(ctx(USERS.sub)), { ...DISPLAY }))
    await assertSucceeds(setDoc(dirRef(db), { ...DISPLAY }))
  })
})

describe('STAGE 1 — the read boundary is ALREADY final', () => {
  beforeEach(async () => { await seedProject() })

  it('the project document and the project list are denied to every non-internal role', async () => {
    for (const user of [USERS.sub, USERS.subNone, USERS.sadmin]) {
      await assertFails(getDoc(projRef(ctx(user))))
      await assertFails(getDocs(collection(ctx(user), 'companies', COMPANY_A, 'projects')))
    }
  })

  it('an assigned subcontractor reads the entry and the drawings; an unassigned one and super_admin read neither', async () => {
    const drawing = (user) => getDoc(doc(ctx(user), 'companies', COMPANY_A, 'projects', P, 'drawings', 'd1'))
    const entry = await assertSucceeds(getDoc(dirRef(ctx(USERS.sub))))
    expect(Object.keys(entry.data()).sort()).toEqual(['location', 'name', 'progress', 'startDate', 'status'])
    await assertSucceeds(drawing(USERS.sub))
    for (const user of [USERS.subNone, USERS.sadmin]) {
      await assertFails(getDoc(dirRef(ctx(user))))
      await assertFails(drawing(user))
    }
    await assertFails(getDocs(collection(ctx(USERS.sub), 'companies', COMPANY_A, 'projectDirectory')))
  })

  it('internal roles are unchanged', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(projRef(ctx(user))))
      await assertSucceeds(getDocs(collection(ctx(user), 'companies', COMPANY_A, 'projects')))
    }
  })
})
