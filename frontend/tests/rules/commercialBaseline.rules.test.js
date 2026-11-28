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
    // ADR-96 (G5): the hook re-sends the UNCHANGED original contract value;
    // a change to it is refused (see the ADR-96 block below).
    it(`${u.role} saves the baseline again with the hook's fields (provenance preserved)`, async () => {
      await assertSucceeds(updateDoc(ref(ctx(u)), fields(u, { originalContractValue: 250000, originalApprovedBudget: 210000, notes: 'revised' })))
      expect(await readBaseline()).toMatchObject({ originalContractValue: 250000, originalApprovedBudget: 210000, notes: 'revised', createdBy: USERS.pm.uid, updatedBy: u.uid })
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
    await assertSucceeds(updateDoc(ref(ctx(USERS.qs)), fields(USERS.qs, { originalContractValue: 100000, originalApprovedBudget: null })))
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
    // (ADR-96: the contract value is re-sent unchanged; another field moves.)
    await assertSucceeds(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalApprovedBudget: 200000, notes: 'dates confirmed' })))
    expect(await readBaseline()).toMatchObject({ originalApprovedBudget: 200000, originalContractValue: 250000, notes: 'dates confirmed' })
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

// ── ADR-96 (G5) — the original contract value is established once ───────────
//
// After create, the original contract value and its four correction-provenance
// keys change only through the trusted backend (contractValueOperation); the
// rules require them UNCHANGED on every client update, while every other
// baseline field stays editable. The create refuses the four keys outright.

const PROVENANCE = () => ({
  originalContractValueVersion: 2,
  originalContractValueRevisedAt: Timestamp.fromDate(new Date('2026-06-01T00:00:00Z')),
  originalContractValueRevisedBy: USERS.admin.uid,
  originalContractValueRevisionId: 'rev1',
})
const PROVENANCE_KEYS = Object.keys(PROVENANCE())

describe('ADR-96 — the create refuses the backend\'s correction-provenance keys', () => {
  for (const key of PROVENANCE_KEYS) {
    it(`a create carrying ${key} is refused (even null)`, async () => {
      await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { [key]: PROVENANCE()[key] })))
      await assertFails(setDoc(ref(ctx(USERS.pm)), createDoc(USERS.pm, { [key]: null })))
      expect(await readBaseline()).toBeNull()
    })
  }
  it('a create carrying all four is refused for every financial role', async () => {
    for (const u of WRITERS) await assertFails(setDoc(ref(ctx(u)), createDoc(u, PROVENANCE())))
    expect(await readBaseline()).toBeNull()
  })
})

describe('ADR-96 — after create, the original contract value and its provenance are frozen; other fields stay editable', () => {
  beforeEach(async () => { await seedBaseline() })

  for (const u of WRITERS) {
    it(`${u.role} edits notes, dates and client while re-sending the same contract value`, async () => {
      await assertSucceeds(updateDoc(ref(ctx(u)), fields(u, {
        originalContractValue: 250000, notes: `edited by ${u.role}`,
        contractStartDate: Timestamp.fromDate(new Date('2026-03-01')), contractCompletionDate: Timestamp.fromDate(new Date('2027-03-01')),
        clientId: 'contact2', clientName: 'Beta Holdings',
      })))
      expect(await readBaseline()).toMatchObject({ originalContractValue: 250000, notes: `edited by ${u.role}`, clientId: 'contact2', clientName: 'Beta Holdings', updatedBy: u.uid })
    })
    it(`${u.role} cannot change the original contract value (up, down or to zero); the stored baseline is unchanged`, async () => {
      const before = await readBaseline()
      for (const v of [260000, 249999.99, 0]) {
        await assertFails(updateDoc(ref(ctx(u)), fields(u, { originalContractValue: v })))
      }
      expect(await readBaseline()).toEqual(before)
    })
  }

  for (const key of PROVENANCE_KEYS) {
    it(`adding ${key} is refused (a client cannot forge a correction's provenance)`, async () => {
      const before = await readBaseline()
      await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { [key]: PROVENANCE()[key] })))
      expect(await readBaseline()).toEqual(before)
    })
  }
  it('a full overwrite with a new value and forged provenance is refused', async () => {
    await assertFails(setDoc(ref(ctx(USERS.admin)), {
      ...fields(USERS.admin, { originalContractValue: 300000 }), ...PROVENANCE(),
      createdAt: (await readBaseline()).createdAt, createdBy: USERS.pm.uid,
    }))
    expect(await readBaseline()).toMatchObject({ originalContractValue: 250000 })
  })
})

describe('ADR-96 — a baseline the backend has corrected (carrying the four keys) stays editable when they are re-sent unchanged', () => {
  beforeEach(async () => { await seedBaseline({ originalContractValue: 275000, ...PROVENANCE() }) })

  for (const u of WRITERS) {
    it(`${u.role} edits notes, re-sending the four keys and the corrected value unchanged`, async () => {
      await assertSucceeds(updateDoc(ref(ctx(u)), fields(u, { originalContractValue: 275000, notes: 'post-correction note', ...PROVENANCE() })))
      expect(await readBaseline()).toMatchObject({ originalContractValue: 275000, notes: 'post-correction note', ...PROVENANCE() })
    })
  }
  it('an update that leaves the four keys out of the merge keeps them and succeeds', async () => {
    await assertSucceeds(updateDoc(ref(ctx(USERS.qs)), fields(USERS.qs, { originalContractValue: 275000, notes: 'merge' })))
    expect(await readBaseline()).toMatchObject(PROVENANCE())
  })
  it('changing the corrected value back (or anywhere) is refused', async () => {
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalContractValue: 250000, ...PROVENANCE() })))
    await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalContractValue: 280000, ...PROVENANCE() })))
  })
  const CHANGED = {
    originalContractValueVersion: 3,
    originalContractValueRevisedAt: Timestamp.fromDate(new Date('2026-07-01T00:00:00Z')),
    originalContractValueRevisedBy: USERS.pm.uid,
    originalContractValueRevisionId: 'rev2',
  }
  for (const key of PROVENANCE_KEYS) {
    it(`changing ${key} is refused, and so is clearing it to null`, async () => {
      const before = await readBaseline()
      await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalContractValue: 275000, ...PROVENANCE(), [key]: CHANGED[key] })))
      await assertFails(updateDoc(ref(ctx(USERS.pm)), fields(USERS.pm, { originalContractValue: 275000, ...PROVENANCE(), [key]: null })))
      expect(await readBaseline()).toEqual(before)
    })
  }
  it('a full overwrite that drops the four keys is refused', async () => {
    const stored = await readBaseline()
    await assertFails(setDoc(ref(ctx(USERS.pm)), {
      ...fields(USERS.pm, { originalContractValue: 275000, notes: 'dropping provenance' }), createdAt: stored.createdAt, createdBy: stored.createdBy,
    }))
    expect(await readBaseline()).toMatchObject(PROVENANCE())
  })
})
