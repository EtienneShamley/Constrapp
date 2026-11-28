import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore'

// ── Approval policy + contract value revisions — Security Rules emulator tests (ADR-96) ──
//
// Two backend-written blocks added by ADR-96 (Phase 2 step 6):
//   - `companies/{c}/approvalPolicy/{policyId}` — the company's approval-
//     segregation policy: readable by any member of the company (the app
//     explains a refusal), written by NO client (operator tool / backend only).
//   - `companies/{c}/projects/{p}/contractValueRevisions/{revisionId}` — the
//     audited corrections of the original contract value: readable by the
//     financial roles, written by NO client (contractValueOperation only).
// The policy's effect on approve / send / award is proven in the
// budgetApprovals, budgetAdjustments, purchaseOrders and tenderPackages suites.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'demo-constrap-test'
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
const COMPANY_A_MEMBERS = [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client, USERS.super]
const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]
const NON_FINANCIAL = [USERS.sub, USERS.client, USERS.super, USERS.other]
const EVERYONE = Object.values(USERS)

let testEnv

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const policyRef = (db, c = COMPANY_A, id = 'current') => doc(db, `companies/${c}/approvalPolicy/${id}`)
const revisionRef = (db, id = 'rev1', c = COMPANY_A, p = PROJECT_A) => doc(db, `companies/${c}/projects/${p}/contractValueRevisions/${id}`)
const label = (u) => `${u.role}${u.companyId === COMPANY_B ? ' of another company' : ''}`

const POLICY = () => ({ segregationEnabled: true, updatedAt: Timestamp.now(), updatedBy: 'operator' })
const REVISION = () => ({
  version: 2, previousValue: 250000, newValue: 275000, reason: 'Head contract executed at a higher sum',
  createdAt: Timestamp.now(), createdBy: USERS.admin.uid,
})

const readRaw = async (path) => {
  let data = null
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(doc(c.firestore(), path))
    data = s.exists() ? s.data() : null
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
    for (const u of EVERYONE) {
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', baseCurrency: 'AUD' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B', baseCurrency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })
  })
})

// ── approvalPolicy ───────────────────────────────────────────────────────────

describe('approvalPolicy — readable by the company\'s members only', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(policyRef(c.firestore()), POLICY())
      await setDoc(policyRef(c.firestore(), COMPANY_B), POLICY())
    })
  })

  for (const u of COMPANY_A_MEMBERS) {
    it(`${label(u)} reads its company's policy`, async () => {
      await assertSucceeds(getDoc(policyRef(ctx(u))))
    })
  }
  it('a member of another company cannot read Company A\'s policy', async () => {
    await assertFails(getDoc(policyRef(ctx(USERS.other))))
  })
  it('a Company A member cannot read Company B\'s policy', async () => {
    await assertFails(getDoc(policyRef(ctx(USERS.admin), COMPANY_B)))
    await assertFails(getDoc(policyRef(ctx(USERS.sub), COMPANY_B)))
  })
  it('an unauthenticated caller cannot read it', async () => {
    await assertFails(getDoc(policyRef(anon())))
  })
})

describe('approvalPolicy — no client writes it, including company_admin', () => {
  it('no role can create the policy (current or any other id)', async () => {
    for (const u of EVERYONE) {
      await assertFails(setDoc(policyRef(ctx(u), u.companyId), { segregationEnabled: false, updatedAt: serverTimestamp(), updatedBy: u.uid }))
      await assertFails(setDoc(policyRef(ctx(u), u.companyId, 'other'), { segregationEnabled: true }))
    }
    await assertFails(setDoc(policyRef(anon()), { segregationEnabled: false }))
    expect(await readRaw(`companies/${COMPANY_A}/approvalPolicy/current`)).toBeNull()
    expect(await readRaw(`companies/${COMPANY_B}/approvalPolicy/current`)).toBeNull()
  })

  it('no role can update or delete an existing policy — the stored policy is unchanged', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => { await setDoc(policyRef(c.firestore()), POLICY()) })
    const before = await readRaw(`companies/${COMPANY_A}/approvalPolicy/current`)
    for (const u of EVERYONE) {
      await assertFails(updateDoc(policyRef(ctx(u)), { segregationEnabled: false }))
      await assertFails(setDoc(policyRef(ctx(u)), { segregationEnabled: false }))
      await assertFails(deleteDoc(policyRef(ctx(u))))
    }
    expect(await readRaw(`companies/${COMPANY_A}/approvalPolicy/current`)).toEqual(before)
  })
})

// ── contractValueRevisions ───────────────────────────────────────────────────

describe('contractValueRevisions — readable by the financial roles only', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(revisionRef(c.firestore()), REVISION())
      await setDoc(revisionRef(c.firestore(), 'rev1', COMPANY_B), REVISION())
    })
  })

  for (const u of FINANCIAL) {
    it(`${label(u)} reads a revision`, async () => {
      await assertSucceeds(getDoc(revisionRef(ctx(u))))
    })
  }
  for (const u of NON_FINANCIAL) {
    it(`${label(u)} cannot read a revision`, async () => {
      await assertFails(getDoc(revisionRef(ctx(u))))
    })
  }
  it('a Company A financial role cannot read Company B\'s revisions', async () => {
    await assertFails(getDoc(revisionRef(ctx(USERS.admin), 'rev1', COMPANY_B)))
  })
  it('an unauthenticated caller cannot read one', async () => {
    await assertFails(getDoc(revisionRef(anon())))
  })
})

describe('contractValueRevisions — no client writes them', () => {
  it('no role can create a revision', async () => {
    for (const u of EVERYONE) {
      await assertFails(setDoc(revisionRef(ctx(u), `r_${u.uid}`, u.companyId), { ...REVISION(), createdAt: serverTimestamp(), createdBy: u.uid }))
    }
    expect(await readRaw(`companies/${COMPANY_A}/projects/${PROJECT_A}/contractValueRevisions/r_u_admin`)).toBeNull()
  })

  it('no role can update or delete an existing revision — it is unchanged', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => { await setDoc(revisionRef(c.firestore()), REVISION()) })
    const path = `companies/${COMPANY_A}/projects/${PROJECT_A}/contractValueRevisions/rev1`
    const before = await readRaw(path)
    for (const u of EVERYONE) {
      await assertFails(updateDoc(revisionRef(ctx(u)), { newValue: 1 }))
      await assertFails(setDoc(revisionRef(ctx(u)), { ...REVISION(), newValue: 1 }))
      await assertFails(deleteDoc(revisionRef(ctx(u))))
    }
    expect(await readRaw(path)).toEqual(before)
  })
})
