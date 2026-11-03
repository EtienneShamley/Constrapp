import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from 'firebase/firestore'

// ── Team-management paths (ADR-72) — browsers are denied by default ────────
//
// The trusted backend keeps invitations, member history, audit events, the
// membership lock, rate-limit counters and the emulator dev outbox under
// `companies/{c}/…`. NONE of them has a `match` block in firestore.rules —
// and this suite proves that absence is a denial for every role, including
// company_admin, for get, list, create, update and delete. The Admin SDK
// (bypassing rules) is the only writer and reader.
//
// It also re-proves two rules facts the backend relies on:
//   · `users/{uid}` stays client-read-only (ADR-27) — no write path was added
//   · a profile with `companyId: null` (what deactivation leaves) reads nothing
//
// ZERO bytes of firestore.rules changed for ADR-72; this file is test-only.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')
const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  gone:   { uid: 'u_gone',   role: null,              companyId: null, status: 'deactivated', formerCompanyId: COMPANY_A },
}

const TEAM_PATHS = ['invitations', 'members', 'auditEvents', 'rateLimits', 'devOutbox']

let testEnv
const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is not set — run `npm run test:rules`.')
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host, port: Number(port) } })
})
afterAll(async () => { if (testEnv) await testEnv.cleanup() })

beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Acme' })
    for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, status: u.status ?? 'active', formerCompanyId: u.formerCompanyId ?? null, name: u.uid })
    for (const p of TEAM_PATHS) await setDoc(doc(db, 'companies', COMPANY_A, p, 'seed'), { seeded: true, tokenHash: 'deadbeef', email: 'x@y.z' })
    await setDoc(doc(db, 'companies', COMPANY_A, 'system', 'membership'), { version: 1 })
    await setDoc(doc(db, 'companies', COMPANY_A, 'projects', 'p1'), { name: 'P1', status: 'active' })
  })
})

describe('no browser can read or write the team-management paths', () => {
  for (const [name, user] of Object.entries(USERS)) {
    for (const p of [...TEAM_PATHS, 'system']) {
      it(`${name}: ${p} — get, list, create, update, delete all denied`, async () => {
        const db = ctx(user)
        const id = p === 'system' ? 'membership' : 'seed'
        await assertFails(getDoc(doc(db, 'companies', COMPANY_A, p, id)))
        await assertFails(getDocs(collection(db, 'companies', COMPANY_A, p)))
        await assertFails(setDoc(doc(db, 'companies', COMPANY_A, p, 'mine'), { email: 'me@x.y', role: 'company_admin', status: 'pending' }))
        await assertFails(updateDoc(doc(db, 'companies', COMPANY_A, p, id), { status: 'accepted' }))
        await assertFails(deleteDoc(doc(db, 'companies', COMPANY_A, p, id)))
      })
    }
  }
})

describe('users/{uid} is still client-read-only and deactivation really removes access', () => {
  it('an admin cannot grant, change or create a membership from the browser', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(doc(db, 'users', 'u_newbie'), { role: 'qs', companyId: COMPANY_A, status: 'active' }))
    await assertFails(updateDoc(doc(db, 'users', USERS.pm.uid), { role: 'company_admin' }))
    await assertFails(updateDoc(doc(db, 'users', USERS.pm.uid), { status: 'deactivated', companyId: null }))
    await assertFails(deleteDoc(doc(db, 'users', USERS.pm.uid)))
    await assertFails(getDoc(doc(db, 'users', USERS.pm.uid)))
  })

  it('a deactivated profile (companyId: null) reads its own document and nothing of the company', async () => {
    const db = ctx(USERS.gone)
    await assertSucceeds(getDoc(doc(db, 'users', USERS.gone.uid)))
    await assertFails(getDoc(doc(db, 'companies', COMPANY_A)))
    await assertFails(getDoc(doc(db, 'companies', COMPANY_A, 'projects', 'p1')))
    await assertFails(getDocs(collection(db, 'companies', COMPANY_A, 'projects')))
    await assertFails(updateDoc(doc(db, 'users', USERS.gone.uid), { companyId: COMPANY_A, role: 'company_admin', status: 'active' }))
  })

  it('an active member still reads the company and its projects (non-regression)', async () => {
    const db = ctx(USERS.qs)
    await assertSucceeds(getDoc(doc(db, 'companies', COMPANY_A)))
    await assertSucceeds(getDoc(doc(db, 'companies', COMPANY_A, 'projects', 'p1')))
  })
})
