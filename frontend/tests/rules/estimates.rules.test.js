import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'

// ── Estimates — Security Rules emulator tests (ADR-97) ───────────────────────
//
// Three backend-written collections added by ADR-97 (Phase 2 step 7):
//   - companies/{c}/projects/{p}/estimates/{estimateId}             header
//   - companies/{c}/projects/{p}/estimates/{estimateId}/lines/{n}   line chunks
//   - companies/{c}/projects/{p}/estimateItemInputs/{boqItemId}     rate breakdowns
// readable by the financial roles of the company, written by NO client
// (estimateOperation only). `estimateState/current` matches no rule.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')
const PROJECT_ID = 'demo-constrap-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const P = 'projectA'

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  super:  { uid: 'u_super',  role: 'super_admin',     companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}
const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]
const NON_FINANCIAL = [USERS.sub, USERS.client, USERS.super, USERS.other]
const EVERYONE = Object.values(USERS)

let testEnv
const ctx = (u) => testEnv.authenticatedContext(u.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const label = (u) => `${u.role}${u.companyId === COMPANY_B ? ' of another company' : ''}`

const paths = (c = COMPANY_A) => ({
  header: `companies/${c}/projects/${P}/estimates/e1`,
  chunk: `companies/${c}/projects/${P}/estimates/e1/lines/00000`,
  input: `companies/${c}/projects/${P}/estimateItemInputs/item1`,
  state: `companies/${c}/projects/${P}/estimateState/current`,
})
const HEADER = { state: 'approved', revision: 2, revisionNumber: 1, number: 'EST-0001', totals: { costTotalCents: 100, sellCents: 120 }, createdBy: 'u_qs', approvedBy: 'u_pm' }
const CHUNK = { index: 0, count: 1, runId: 'r', lines: [{ itemId: 'item1', quantity: 1, rate: 1, amountCents: 100, costClass: 'direct' }] }
const INPUT = { components: { labour: 1, material: 0, plant: 0, subcontractor: 0 }, rate: 1 }

const readRaw = async (path) => {
  let data = null
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(doc(c.firestore(), path))
    data = s.exists() ? s.data() : null
  })
  return data
}

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
    for (const u of EVERYONE) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    for (const co of [COMPANY_A, COMPANY_B]) {
      const p = paths(co)
      await setDoc(doc(db, p.header), HEADER)
      await setDoc(doc(db, p.chunk), CHUNK)
      await setDoc(doc(db, p.input), INPUT)
      await setDoc(doc(db, p.state), { nextRevisionNumber: 2, approvedEstimateId: 'e1' })
    }
  })
})

describe('reads — the financial roles of the company only', () => {
  for (const u of FINANCIAL) {
    it(`${label(u)} reads the header, the line chunks and the rate breakdowns`, async () => {
      const db = ctx(u)
      const p = paths()
      await assertSucceeds(getDoc(doc(db, p.header)))
      await assertSucceeds(getDoc(doc(db, p.chunk)))
      await assertSucceeds(getDocs(collection(db, `companies/${COMPANY_A}/projects/${P}/estimates/e1/lines`)))
      await assertSucceeds(getDocs(collection(db, `companies/${COMPANY_A}/projects/${P}/estimates`)))
      await assertSucceeds(getDoc(doc(db, p.input)))
    })
  }
  for (const u of NON_FINANCIAL) {
    it(`${label(u)} reads none of them`, async () => {
      const db = ctx(u)
      const p = paths()
      await assertFails(getDoc(doc(db, p.header)))
      await assertFails(getDoc(doc(db, p.chunk)))
      await assertFails(getDocs(collection(db, `companies/${COMPANY_A}/projects/${P}/estimates`)))
      await assertFails(getDoc(doc(db, p.input)))
    })
  }
  it('a Company A administrator cannot read Company B’s estimates (tenant isolation)', async () => {
    const p = paths(COMPANY_B)
    await assertFails(getDoc(doc(ctx(USERS.admin), p.header)))
    await assertFails(getDoc(doc(ctx(USERS.admin), p.chunk)))
    await assertFails(getDoc(doc(ctx(USERS.admin), p.input)))
  })
  it('the server-only state document is readable by nobody, and unauthenticated callers read nothing', async () => {
    for (const u of EVERYONE) await assertFails(getDoc(doc(ctx(u), paths(u.companyId).state)))
    await assertFails(getDoc(doc(anon(), paths().header)))
  })
})

describe('writes — no client, any role, any document: the stored estimate is unchanged', () => {
  it('no role creates, updates or deletes a header, a chunk, a breakdown or the state', async () => {
    for (const u of EVERYONE) {
      const db = ctx(u)
      const p = paths(u.companyId)
      await assertFails(setDoc(doc(db, `companies/${u.companyId}/projects/${P}/estimates/new`), { ...HEADER, state: 'draft', createdBy: u.uid, createdAt: serverTimestamp() }))
      await assertFails(updateDoc(doc(db, p.header), { state: 'draft' }))
      await assertFails(updateDoc(doc(db, p.header), { 'totals.sellCents': 999 }))
      await assertFails(deleteDoc(doc(db, p.header)))
      await assertFails(setDoc(doc(db, p.chunk), { ...CHUNK, lines: [] }))
      await assertFails(setDoc(doc(db, `companies/${u.companyId}/projects/${P}/estimates/e1/lines/00001`), CHUNK))
      await assertFails(deleteDoc(doc(db, p.chunk)))
      await assertFails(setDoc(doc(db, p.input), { ...INPUT, components: { labour: 0, material: 1, plant: 0, subcontractor: 0 } }))
      await assertFails(setDoc(doc(db, `companies/${u.companyId}/projects/${P}/estimateItemInputs/item2`), INPUT))
      await assertFails(deleteDoc(doc(db, p.input)))
      await assertFails(setDoc(doc(db, p.state), { approvedEstimateId: 'forged' }))
    }
    await assertFails(setDoc(doc(anon(), paths().header), HEADER))
    expect(await readRaw(paths().header)).toEqual(HEADER)
    expect(await readRaw(paths().chunk)).toEqual(CHUNK)
    expect(await readRaw(paths().input)).toEqual(INPUT)
    expect(await readRaw(paths().state)).toEqual({ nextRevisionNumber: 2, approvedEstimateId: 'e1' })
  })
})
