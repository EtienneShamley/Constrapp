import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction, serverTimestamp, Timestamp,
} from 'firebase/firestore'

// ── M2-A2 — PROJECT DIRECTORY INTEGRITY (FINAL ruleset) ──────────────────────
//
// companies/{c}/projectDirectory/{projectId} is the external-safe copy of FIVE
// display fields of a project. It is written by the client, and it is NOT
// client-controlled: the rules pin it to the project document in the SAME
// commit, in both directions.
//
//   · DIRECTORY SIDE  an entry may hold exactly name / status / location /
//     startDate / progress, each equal to the project AFTER the commit. Nothing
//     else can be stored — no budget, no currency, no access data.
//   · PROJECT SIDE    a project is created WITH its entry, and a change to any
//     of the five fields carries the entry. A write that touches none of them
//     (the currency pin, the currency lock) is unaffected.
//
// Together: no commit that passes the rules can leave the two different, so
// there is no window in which the entry is stale.
//
// ⚠️ Admin-SDK writes bypass rules. The only server writer of a project
// document (boqBudget/transfer.js) writes `currencyLocked` alone, which is not
// a directory field.
//
// SAFETY: refuses to run outside the emulator.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const P = 'projectA'

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A, projectIds: [P, 'newP'] },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A, projectIds: [P, 'newP'] },
  sadmin: { uid: 'u_sadmin', role: 'super_admin',     companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}

let testEnv
const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const projRef = (db, id = P, c = COMPANY_A) => doc(db, 'companies', c, 'projects', id)
const dirRef  = (db, id = P, c = COMPANY_A) => doc(db, 'companies', c, 'projectDirectory', id)

const START = Timestamp.fromDate(new Date('2026-03-01T00:00:00Z'))
const DISPLAY = { name: 'Riverside Tower', status: 'In Progress', location: 'Brisbane QLD', startDate: START, progress: 35 }
// What useProjects.createProject writes.
const projectPayload = (user, overrides = {}) => ({
  ...DISPLAY, budget: 4200000, currency: 'AUD', currencyLocked: true,
  createdAt: serverTimestamp(), createdBy: user.uid, ...overrides,
})

// The app's two paired writes.
const createPaired = (db, id, project, entry) => {
  const batch = writeBatch(db)
  batch.set(projRef(db, id), project)
  batch.set(dirRef(db, id), entry)
  return batch.commit()
}
const editPaired = (db, fields, entry, id = P) => {
  const batch = writeBatch(db)
  batch.update(projRef(db, id), fields)
  batch.set(dirRef(db, id), entry)
  return batch.commit()
}

async function seedProject({ id = P, entry = true, project = {}, c = COMPANY_A } = {}) {
  await testEnv.withSecurityRulesDisabled(async (admin) => {
    const db = admin.firestore()
    await setDoc(projRef(db, id, c), { ...DISPLAY, budget: 4200000, currency: 'AUD', currencyLocked: false, createdAt: Timestamp.now(), createdBy: 'u_admin', ...project })
    if (entry) await setDoc(dirRef(db, id, c), entry === true ? { ...DISPLAY } : entry)
  })
}
const raw = async (ref) => {
  let data = null
  await testEnv.withSecurityRulesDisabled(async (admin) => { data = (await getDoc(doc(admin.firestore(), ref.path))).data() ?? null })
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
afterAll(async () => { if (testEnv) await testEnv.cleanup() })

beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (admin) => {
    const db = admin.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { name: u.uid, role: u.role, companyId: u.companyId, ...(u.projectIds ? { projectIds: u.projectIds } : {}) })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', baseCurrency: 'AUD' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B', baseCurrency: 'AUD' })
  })
})

// ── CREATE ───────────────────────────────────────────────────────────────────

describe('project CREATE — the project and its directory entry are one commit', () => {
  for (const key of ['admin', 'pm']) {
    it(`${key}: the app’s paired create is accepted and both documents land identical`, async () => {
      const db = ctx(USERS[key])
      await assertSucceeds(createPaired(db, 'newP', projectPayload(USERS[key]), { ...DISPLAY }))
      const project = await raw(projRef(db, 'newP'))
      const entry = await raw(dirRef(db, 'newP'))
      expect(Object.keys(entry).sort()).toEqual(['location', 'name', 'progress', 'startDate', 'status'])
      for (const k of Object.keys(entry)) {
        if (k === 'startDate') expect(entry[k].isEqual(project[k])).toBe(true)
        else expect(entry[k]).toBe(project[k])
      }
      expect(project.budget).toBe(4200000)
    })
  }

  it('a project with NO start date and a zero progress is created with an entry holding null and 0', async () => {
    const db = ctx(USERS.admin)
    const display = { ...DISPLAY, startDate: null, progress: 0, location: '' }
    await assertSucceeds(createPaired(db, 'newP', projectPayload(USERS.admin, display), display))
  })

  it('MISSING PAIRED WRITE — a project created WITHOUT its entry is rejected (setDoc, the pre-M2-A2 addDoc shape)', async () => {
    await assertFails(setDoc(projRef(ctx(USERS.admin), 'newP'), projectPayload(USERS.admin)))
    await assertFails(setDoc(projRef(ctx(USERS.pm), 'newP'), projectPayload(USERS.pm)))
    expect(await raw(projRef(ctx(USERS.admin), 'newP'))).toBeNull()
  })

  it('an entry created for a project that does not exist is rejected', async () => {
    await assertFails(setDoc(dirRef(ctx(USERS.admin), 'ghost'), { ...DISPLAY }))
  })

  it('a paired create whose entry names a DIFFERENT project id does not satisfy the pairing', async () => {
    const db = ctx(USERS.admin)
    const batch = writeBatch(db)
    batch.set(projRef(db, 'newP'), projectPayload(USERS.admin))
    batch.set(dirRef(db, 'otherId'), { ...DISPLAY })
    await assertFails(batch.commit())
  })

  for (const key of ['qs', 'sub', 'client', 'sadmin', 'other']) {
    it(`${key}: cannot create a project, paired or not`, async () => {
      const db = ctx(USERS[key])
      await assertFails(createPaired(db, 'newP', projectPayload(USERS[key]), { ...DISPLAY }))
      await assertFails(setDoc(dirRef(db, 'newP'), { ...DISPLAY }))
    })
  }

  it('the paired create works inside a transaction too', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(runTransaction(db, async (tx) => {
      tx.set(projRef(db, 'newP'), projectPayload(USERS.admin))
      tx.set(dirRef(db, 'newP'), { ...DISPLAY })
    }))
  })
})

// ── DIRECTORY INJECTION ──────────────────────────────────────────────────────

describe('DIRECTORY INJECTION — an entry holds the five approved fields and nothing else', () => {
  const INJECTED = {
    'the headline budget':        { budget: 4200000 },
    'a zero budget':              { budget: 0 },
    'the currency':               { currency: 'AUD' },
    'the currency lock':          { currencyLocked: true },
    'an assignment list':         { projectIds: ['projectA'] },
    'a role':                     { role: 'company_admin' },
    'a member list':              { members: ['u_sub'] },
    'provenance stamps':          { createdBy: 'u_admin' },
    'an arbitrary key':           { note: 'anything' },
    'a null-valued extra key':    { budget: null },
  }
  for (const [label, extra] of Object.entries(INJECTED)) {
    it(`an entry carrying ${label} is rejected — at create, at edit, and written alone`, async () => {
      const db = ctx(USERS.admin)
      await assertFails(createPaired(db, 'newP', projectPayload(USERS.admin), { ...DISPLAY, ...extra }))
      await seedProject()
      await assertFails(editPaired(db, { name: 'Renamed' }, { ...DISPLAY, name: 'Renamed', ...extra }))
      await assertFails(setDoc(dirRef(db), { ...DISPLAY, ...extra }))
      await assertFails(updateDoc(dirRef(db), extra))
    })
  }

  for (const k of ['name', 'status', 'location', 'startDate', 'progress']) {
    it(`an entry MISSING ${k} is rejected`, async () => {
      const db = ctx(USERS.admin)
      const entry = { ...DISPLAY }
      delete entry[k]
      await assertFails(createPaired(db, 'newP', projectPayload(USERS.admin), entry))
    })
  }

  it('an empty entry is rejected', async () => {
    await assertFails(createPaired(ctx(USERS.admin), 'newP', projectPayload(USERS.admin), {}))
  })

  it('an entry can never be deleted, by anyone', async () => {
    await seedProject()
    for (const user of Object.values(USERS)) await assertFails(deleteDoc(dirRef(ctx(user))))
  })
})

// ── INCORRECT PROJECTION ─────────────────────────────────────────────────────

describe('INCORRECT PROJECTION — every value must equal the project after the commit', () => {
  const WRONG = {
    name:      'Some Other Name',
    status:    'Completed',
    location:  'Sydney NSW',
    startDate: Timestamp.fromMillis(START.toMillis() + 1),
    progress:  36,
  }
  for (const [k, v] of Object.entries(WRONG)) {
    it(`${k}: a value that differs from the project is rejected at create, at edit and written alone`, async () => {
      const db = ctx(USERS.admin)
      await assertFails(createPaired(db, 'newP', projectPayload(USERS.admin), { ...DISPLAY, [k]: v }))
      await seedProject()
      // The project is edited to one value and the entry claims another.
      await assertFails(editPaired(db, { progress: 50 }, { ...DISPLAY, progress: 50, [k]: k === 'progress' ? 51 : v }))
      // An entry rewritten on its own to disagree with the unchanged project.
      await assertFails(setDoc(dirRef(db), { ...DISPLAY, [k]: v }))
      await assertFails(updateDoc(dirRef(db), { [k]: v }))
      expect(await raw(dirRef(db))).toEqual(DISPLAY)
    })
  }

  it('startDate: null against a dated project, and a date against an undated project, are rejected', async () => {
    const db = ctx(USERS.admin)
    await assertFails(createPaired(db, 'newP', projectPayload(USERS.admin), { ...DISPLAY, startDate: null }))
    await assertFails(createPaired(db, 'newP2', projectPayload(USERS.admin, { startDate: null }), { ...DISPLAY }))
  })

  it('WRONG TYPES are rejected even when project and entry agree', async () => {
    const db = ctx(USERS.admin)
    const cases = [
      { name: 42 }, { status: 7 }, { location: null }, { startDate: '2026-03-01' }, { progress: '35' }, { name: null },
    ]
    for (const bad of cases) {
      await assertFails(createPaired(db, 'newP', projectPayload(USERS.admin, bad), { ...DISPLAY, ...bad }))
    }
  })

  it('an entry cannot be made to mirror ANOTHER project of the same company', async () => {
    await seedProject()
    await seedProject({ id: 'p2', project: { name: 'Second Project' }, entry: { ...DISPLAY, name: 'Second Project' } })
    await assertFails(setDoc(dirRef(ctx(USERS.admin)), { ...DISPLAY, name: 'Second Project' }))
  })

  it('an entry cannot be written into another company', async () => {
    await seedProject({ c: COMPANY_B, entry: false })
    await assertFails(setDoc(dirRef(ctx(USERS.admin), P, COMPANY_B), { ...DISPLAY }))
  })
})

// ── EDIT ─────────────────────────────────────────────────────────────────────

describe('project EDIT — a display-field change carries its entry', () => {
  const EDITED = { name: 'Riverside Tower — Stage 2', status: 'On Hold', location: 'Ipswich QLD', startDate: Timestamp.fromDate(new Date('2026-05-01T00:00:00Z')), progress: 60 }

  for (const key of ['admin', 'pm']) {
    it(`${key}: the app’s paired edit is accepted and both documents hold the new values`, async () => {
      await seedProject()
      const db = ctx(USERS[key])
      await assertSucceeds(editPaired(db, EDITED, EDITED))
      expect(await raw(dirRef(db))).toEqual(EDITED)
      const project = await raw(projRef(db))
      expect(project.name).toBe(EDITED.name)
      expect(project.budget).toBe(4200000)
    })
  }

  it('MISSING PAIRED WRITE — each display field changed WITHOUT the entry is rejected', async () => {
    await seedProject()
    const db = ctx(USERS.admin)
    for (const [k, v] of Object.entries(EDITED)) {
      await assertFails(updateDoc(projRef(db), { [k]: v }))
    }
    await assertFails(updateDoc(projRef(db), EDITED))
    expect((await raw(projRef(db))).name).toBe(DISPLAY.name)
  })

  it('an entry changed WITHOUT the project is rejected', async () => {
    await seedProject()
    await assertFails(updateDoc(dirRef(ctx(USERS.admin)), { name: 'Drifted' }))
    await assertFails(setDoc(dirRef(ctx(USERS.pm)), EDITED))
  })

  it('a partial edit is accepted when the entry mirrors the RESULTING document, rejected when it mirrors only the change', async () => {
    await seedProject()
    const db = ctx(USERS.admin)
    await assertFails(editPaired(db, { progress: 80 }, { progress: 80 }))
    await assertSucceeds(editPaired(db, { progress: 80 }, { ...DISPLAY, progress: 80 }))
  })

  it('clearing the start date is mirrored as null', async () => {
    await seedProject()
    const db = ctx(USERS.admin)
    await assertSucceeds(editPaired(db, { startDate: null }, { ...DISPLAY, startDate: null }))
    expect((await raw(dirRef(db))).startDate).toBeNull()
  })

  it('a paired edit still obeys the project rules — an invalid status, an over-long name and a budget change are rejected', async () => {
    await seedProject()
    const db = ctx(USERS.admin)
    await assertFails(editPaired(db, { status: 'Abandoned' }, { ...DISPLAY, status: 'Abandoned' }))
    const long = 'x'.repeat(201)
    await assertFails(editPaired(db, { name: long }, { ...DISPLAY, name: long }))
    await assertFails(editPaired(db, { progress: 101 }, { ...DISPLAY, progress: 101 }))
    await assertFails(editPaired(db, { name: 'Ok', budget: 1 }, { ...DISPLAY, name: 'Ok' }))
  })

  for (const key of ['qs', 'sub', 'client', 'sadmin', 'other']) {
    it(`${key}: cannot edit a project or its entry`, async () => {
      await seedProject()
      const db = ctx(USERS[key])
      await assertFails(editPaired(db, EDITED, EDITED))
      await assertFails(setDoc(dirRef(db), { ...DISPLAY }))
    })
  }

  it('an identical re-save (no field changes) needs no entry and is accepted', async () => {
    await seedProject()
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { ...DISPLAY }))
  })
})

// ── PROJECTS THAT PRE-DATE THE DIRECTORY ─────────────────────────────────────

describe('a project that pre-dates the directory (no entry)', () => {
  it('its first edit creates the entry in the same commit', async () => {
    await seedProject({ entry: false })
    const db = ctx(USERS.pm)
    await assertSucceeds(editPaired(db, { name: 'Renamed' }, { ...DISPLAY, name: 'Renamed' }))
    expect(await raw(dirRef(db))).toEqual({ ...DISPLAY, name: 'Renamed' })
  })

  it('an unpaired display edit is rejected — it cannot stay entry-less through an edit', async () => {
    await seedProject({ entry: false })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { name: 'Renamed' }))
  })

  it('admin / pm may create the missing entry alone when it mirrors the project (repair); nobody else may', async () => {
    await seedProject({ entry: false })
    for (const key of ['qs', 'sub', 'client', 'sadmin', 'other']) await assertFails(setDoc(dirRef(ctx(USERS[key])), { ...DISPLAY }))
    await assertFails(setDoc(dirRef(ctx(USERS.admin)), { ...DISPLAY, name: 'Not the project name' }))
    await assertSucceeds(setDoc(dirRef(ctx(USERS.admin)), { ...DISPLAY }))
  })

  it('a project missing optional fields is mirrored with the rules’ defaults ("" / null / 0)', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(projRef(admin.firestore(), 'bare'), { name: 'Bare', budget: 0 })
    })
    const db = ctx(USERS.admin)
    await assertFails(setDoc(dirRef(db, 'bare'), { name: 'Bare', status: 'Planning', location: '', startDate: null, progress: 0 }))
    await assertSucceeds(setDoc(dirRef(db, 'bare'), { name: 'Bare', status: '', location: '', startDate: null, progress: 0 }))
  })

  it('an assigned external role reads nothing until the entry exists, then exactly the entry', async () => {
    await seedProject({ entry: false })
    const before = await assertSucceeds(getDoc(dirRef(ctx(USERS.sub))))
    expect(before.exists()).toBe(false)
    await assertFails(getDoc(projRef(ctx(USERS.sub))))
    await assertSucceeds(setDoc(dirRef(ctx(USERS.admin)), { ...DISPLAY }))
    const after = await assertSucceeds(getDoc(dirRef(ctx(USERS.sub))))
    expect(after.data()).toEqual(DISPLAY)
  })
})

// ── CURRENCY AND LOCK WRITES ARE UNAFFECTED ──────────────────────────────────

describe('CURRENCY-LOCK REGRESSION — writes that touch no display field need no entry', () => {
  for (const entry of [true, false]) {
    const label = entry ? 'with an entry' : 'on a project that pre-dates the directory'

    it(`${label}: the QS currency-lock ratchet (currencyLocked alone) is accepted`, async () => {
      await seedProject({ entry })
      await assertSucceeds(updateDoc(projRef(ctx(USERS.qs)), { currencyLocked: true }))
      expect((await raw(projRef(ctx(USERS.qs)))).currencyLocked).toBe(true)
    })

    it(`${label}: admin / pm engage the lock, pin the lock + currency, and change an unlocked currency`, async () => {
      await seedProject({ entry })
      await assertSucceeds(updateDoc(projRef(ctx(USERS.pm)), { currency: 'NZD' }))
      await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currencyLocked: true, currency: 'NZD' }))
    })

    it(`${label}: the lock staged inside a financial transaction (stageProjectCurrencyLock) is accepted`, async () => {
      await seedProject({ entry })
      const db = ctx(USERS.qs)
      await assertSucceeds(runTransaction(db, async (tx) => {
        const snap = await tx.get(projRef(db))
        if (snap.data().currencyLocked !== true) tx.update(projRef(db), { currencyLocked: true })
      }))
    })
  }

  it('the Company Settings currency pin — one batch over many projects, none with an entry — is accepted', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `legacy${i}`)
    for (const id of ids) await seedProject({ id, entry: false, project: { currency: '', currencyLocked: true } })
    const db = ctx(USERS.admin)
    const batch = writeBatch(db)
    for (const id of ids) batch.update(projRef(db, id), { currency: 'AUD' })
    await assertSucceeds(batch.commit())
  })

  it('the lock rules themselves are unchanged — never unlock, qs changes nothing else', async () => {
    await seedProject({ project: { currencyLocked: true } })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currencyLocked: false }))
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currency: 'USD' }))
    await assertFails(updateDoc(projRef(ctx(USERS.qs)), { currency: 'USD' }))
  })

  it('a lock write that ALSO renames the project needs the entry', async () => {
    await seedProject()
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(projRef(db), { currencyLocked: true, name: 'Renamed' }))
    await assertSucceeds(editPaired(db, { currencyLocked: true, name: 'Renamed' }, { ...DISPLAY, name: 'Renamed' }))
  })
})

// ── getAfter() ACCESS LIMITS ─────────────────────────────────────────────────
//
// Firestore allows 10 exists() / get() / getAfter() calls per operation and 20
// per batched write or transaction. Counting EVERY call in the source (the
// worst case — repeated calls for one document may be cached, but that is not
// promised): the project half of a pair spends 8, the directory half 9, the
// pair 17. tests/unit/externalProjectIsolation.test.js pins those numbers.
//
// ⚠️ THE EMULATOR IS NOT PROOF OF THE LIMIT. Measured 23 November 2026: it
// enforces 10 per operation on DISTINCT documents only, and does not enforce
// the 20-per-commit limit at all (it accepted 25 pairs in one batch). So the
// cases below prove the app's shapes are ACCEPTED, and that the pairing adds
// no call to a write that changes no display field — nothing more. The one
// supported shape is ONE pair per commit; more than one pair in a commit
// exceeds 20 on the worst-case count and must not be written.

describe('getAfter() access limits', () => {
  it('one pair per commit — the app’s only shape — is accepted (create, then edit)', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(createPaired(db, 'newP', projectPayload(USERS.admin), { ...DISPLAY }))
    await assertSucceeds(editPaired(db, { progress: 90 }, { ...DISPLAY, progress: 90 }, 'newP'))
  })

  it('a 20-project currency batch on paired projects (the pre-M2-A2 Company Settings shape, unchanged) evaluates no pairing and is accepted', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `paired${i}`)
    for (const id of ids) await seedProject({ id })
    const db = ctx(USERS.admin)
    const batch = writeBatch(db)
    for (const id of ids) batch.update(projRef(db, id), { currencyLocked: true })
    await assertSucceeds(batch.commit())
  })
})
