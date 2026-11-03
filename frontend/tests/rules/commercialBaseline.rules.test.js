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

// ── Commercial Baseline Security Rules — emulator tests (ADR-20; hardened by ADR-70) ──
//
// `…/projects/{projectId}/commercial/baseline` is the CONTRACT REVENUE
// baseline (Original Contract Value, the legacy Original Approved Budget
// scalar, contract dates, client snapshot, notes). Until ADR-70 its rules
// enforced tenancy and role only; these tests prove the hardened shape —
// exact keys, non-negative money, typed dates and client, caller + server
// stamps, immutable provenance — and that the legacy `originalApprovedBudget`
// scalar FREEZES once an approved budget version exists (the pointer
// `approvedBudget/current`), while the live bundle's own writes stay valid.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

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
const WRITERS = [USERS.admin, USERS.pm, USERS.qs]
const NON_WRITERS = [USERS.sub, USERS.client, USERS.super, USERS.other]

let testEnv

const baselinePath = (c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}/commercial/baseline`
const pointerPath = (c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}/approvedBudget/current`
const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const ref = (db, c = COMPANY_A, p = PROJECT_A) => doc(db, baselinePath(c, p))

// EXACTLY the document hooks/useProjectCommercial.jsx → saveBaseline writes.
const fields = (user, overrides = {}) => ({
  originalContractValue: 250000,
  originalApprovedBudget: 200000,
  contractStartDate: Timestamp.fromDate(new Date('2026-02-01')),
  contractCompletionDate: null,
  clientId: 'contact1',
  clientName: 'Acme Developments',
  notes: '',
  updatedAt: serverTimestamp(),
  updatedBy: user.uid,
  ...overrides,
})
const createDoc = (user, overrides = {}) => ({ ...fields(user), createdAt: serverTimestamp(), createdBy: user.uid, ...overrides })

async function seedBaseline(data = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(ref(c.firestore()), {
      ...fields(USERS.pm), updatedAt: Timestamp.now(), createdAt: Timestamp.now(), createdBy: USERS.pm.uid, ...data,
    })
  })
}
async function seedPointer() {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), pointerPath()), {
      activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1,
      approvedAt: Timestamp.now(), approvedBy: USERS.pm.uid, createdAt: Timestamp.now(), createdBy: USERS.pm.uid,
      updatedAt: Timestamp.now(), updatedBy: USERS.pm.uid,
    })
  })
}
const readBaseline = async () => {
  let data = null
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(ref(c.firestore()))
    data = s.exists() ? s.data() : null
  })
  return data
}

const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

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
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', baseCurrency: 'AUD' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B', baseCurrency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })
  })
})

describe('read matrix — financial roles only', () => {
  beforeEach(async () => { await seedBaseline() })
  for (const u of WRITERS) {
    it(`${u.role} reads the baseline`, async () => { await assertSucceeds(getDoc(ref(ctx(u)))) })
  }
  for (const u of NON_WRITERS) {
    it(`${u.role}${u === USERS.other ? ' of another company' : ''} cannot read it`, async () => { await assertFails(getDoc(ref(ctx(u)))) })
  }
  it('an unauthenticated caller cannot read it', async () => { await assertFails(getDoc(ref(anon()))) })
})

describe('create — the hook\'s document, by a financial role, stamped by the caller at server time', () => {
  for (const u of WRITERS) {
    it(`${u.role} creates the baseline exactly as the hook writes it`, async () => {
      await assertSucceeds(setDoc(ref(ctx(u)), createDoc(u)))
      expect(await readBaseline()).toMatchObject({ originalContractValue: 250000, originalApprovedBudget: 200000, createdBy: u.uid })
    })
  }
  for (const u of NON_WRITERS) {
    it(`${u.role}${u === USERS.other ? ' of another company' : ''} cannot create it`, async () => {
      await assertFails(setDoc(ref(ctx(u)), createDoc(u)))
    })
  }
  it('company A cannot create in company B', async () => {
    await assertFails(setDoc(ref(ctx(USERS.admin), COMPANY_B), createDoc(USERS.admin)))
  })
  it('only the single `baseline` id has a rule', async () => {
    await assertFails(setDoc(doc(ctx(USERS.admin), `companies/${COMPANY_A}/projects/${PROJECT_A}/commercial/other`), createDoc(USERS.admin)))
  })

  it('money: the contract value is a non-negative number; the legacy original budget is null or a non-negative number', async () => {
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { originalContractValue: -1 })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { originalContractValue: '250000' })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { originalContractValue: null })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { originalApprovedBudget: -5 })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { originalApprovedBudget: '200000' })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { originalApprovedBudget: {} })))
    await assertSucceeds(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { originalApprovedBudget: null, originalContractValue: 0 })))
  })

  it('dates are null or timestamps; the client is null or a bounded string pair; notes a bounded string', async () => {
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { contractStartDate: '2026-02-01' })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { contractCompletionDate: 1700000000 })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { clientId: 7 })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { clientName: 'n'.repeat(201) })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { notes: 'n'.repeat(2001) })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { notes: null })))
    await assertSucceeds(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { contractStartDate: null, clientId: null, clientName: null, notes: 'n'.repeat(2000) })))
  })

  it('exact keys: an arbitrary field is refused', async () => {
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { approved: true })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { currency: 'AUD' })))
  })

  it('stamps: the caller and the server clock on createdBy / createdAt and updatedBy / updatedAt', async () => {
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { createdBy: USERS.admin.uid })))
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { updatedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { createdAt: clock() })))
      await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { updatedAt: clock() })))
    }
    const { updatedAt, ...noStamp } = createDoc(USERS.pm)
    expect(updatedAt).toBeDefined()
    await assertFails(setDoc(ref(ctx(USERS.pm)), noStamp))
  })
})

describe('update — the hook\'s upsert, provenance immutable, shape re-validated', () => {
  beforeEach(async () => { await seedBaseline() })

  for (const u of WRITERS) {
    it(`${u.role} saves the baseline again with the hook's fields (provenance preserved)`, async () => {
      await assertSucceeds(updateDoc(ref(ctx(u)), fields(u, { originalContractValue: 260000, originalApprovedBudget: 210000, notes: 'revised' })))
      expect(await readBaseline()).toMatchObject({ originalContractValue: 260000, originalApprovedBudget: 210000, createdBy: USERS.pm.uid, updatedBy: u.uid })
    })
  }
  for (const u of NON_WRITERS) {
    it(`${u.role}${u === USERS.other ? ' of another company' : ''} cannot update it`, async () => {
      await assertFails(updateDoc(ref(ctx(u)), fields(u)))
    })
  }

  it('createdAt / createdBy are immutable', async () => {
    // The seed was created by the PM: re-sending the SAME createdBy is not a
    // change; naming anyone else is.
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { createdBy: USERS.admin.uid })))
    await assertFails(updateDoc(ref(ctx(USERS.admin)), fields(USERS.admin, { createdBy: USERS.admin.uid })))
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { createdAt: serverTimestamp() })))
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { createdAt: Timestamp.fromDate(new Date('2020-01-01')) })))
  })

  it('the same shape rules apply on update, and the stamps must be the caller\'s at server time', async () => {
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalContractValue: -1 })))
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalApprovedBudget: 'x' })))
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { contractStartDate: 'soon' })))
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { extra: 1 })))
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { updatedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { updatedAt: clock() })))
    await assertFails(updateDoc(ref(ctx(USERS.pm)), { notes: 'no stamps' }))
  })

  it('a LEGACY document (no client keys, no notes) stays writable through the hook\'s full write', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(ref(c.firestore()), {
        originalContractValue: 100000, originalApprovedBudget: null, contractStartDate: null, contractCompletionDate: null,
        createdAt: Timestamp.now(), createdBy: USERS.admin.uid, updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
      })
    })
    await assertSucceeds(updateDoc(ref(ctx(USERS.qs)), fields(USERS.qs, { originalApprovedBudget: null })))
  })

  it('delete is blocked for everyone', async () => {
    for (const u of [...WRITERS, ...NON_WRITERS]) await assertFails(deleteDoc(ref(ctx(u))))
    expect(await readBaseline()).not.toBeNull()
  })
})

describe('the legacy Original Approved Budget scalar freezes once a budget version is approved (ADR-70)', () => {
  it('with NO approved version the scalar is freely editable (the ADR-20 posture)', async () => {
    await seedBaseline({ originalApprovedBudget: 200000 })
    await assertSucceeds(updateDoc(ref(ctx(USERS.qs)), fields(USERS.qs, { originalApprovedBudget: 150000 })))
    await assertSucceeds(updateDoc(ref(ctx(USERS.qs)), fields(USERS.qs, { originalApprovedBudget: null })))
  })

  it('with an approved version the scalar may only stay what it was — null stays null, a legacy value stays that value', async () => {
    await seedBaseline({ originalApprovedBudget: 200000 })
    await seedPointer()
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalApprovedBudget: 150000 })))
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalApprovedBudget: null })))
    // The live bundle re-sends the unchanged value with every save: accepted.
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalApprovedBudget: 200000, originalContractValue: 300000 })))
    expect(await readBaseline()).toMatchObject({ originalApprovedBudget: 200000, originalContractValue: 300000 })
  })

  it('a baseline CREATED after a version is approved carries no legacy scalar (null); a value is refused', async () => {
    await seedPointer()
    await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { originalApprovedBudget: 1000 })))
    await assertSucceeds(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { originalApprovedBudget: null })))
  })

  it('⚠️ stated plainly: the rules freeze the VALUE while a version exists; they do not verify it against the approved snapshot (version 1 is the original — the app reads it from the snapshot, never from here)', async () => {
    await seedBaseline({ originalApprovedBudget: 123 })
    await seedPointer()
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalApprovedBudget: 123 })))
  })
})
