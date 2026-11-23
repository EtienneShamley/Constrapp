import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, collectionGroup, query, where, Timestamp,
} from 'firebase/firestore'
import { ref as modularRef, getBytes } from 'firebase/storage'

// ── M2-A2 — EXTERNAL PROJECT ISOLATION (closes Deferred Control 20) ──────────
//
// The boundary, proven against the FINAL firestore.rules and storage.rules:
//
//   · INTERNAL roles (company_admin / project_manager / qs) read every project
//     of THEIR company, exactly as before.
//   · a client / subcontractor reads ONLY the projects listed in their own
//     users/{uid}.projectIds — the directory entry, drawings, revisions,
//     ACTIVE project-visible documents and the matching Storage objects.
//   · they NEVER read the project document (headline budget, currency), and
//     never list the directory.
//   · a missing, null, empty or malformed assignment grants nothing.
//   · every other role (super_admin, an unknown role, no role) reads nothing,
//     even with an assignment on its profile.
//   · an assignment never crosses a company boundary, even when two companies
//     use the SAME project id.
//   · nobody can write users/{uid} from a client, so nobody can assign
//     themselves a project.
//
// SAFETY: refuses to run outside the emulators.

const HERE = dirname(fileURLToPath(import.meta.url))
const FIRESTORE_RULES_PATH = resolve(HERE, '../../firestore.rules')
const STORAGE_RULES_PATH = resolve(HERE, '../../storage.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const P1 = 'p1'          // exists in BOTH companies on purpose (same id, different tenant)
const P2 = 'p2'          // Company A only
const PB = 'pB'          // Company B only
const HEADLINE_BUDGET = 5250000

const INTERNAL = {
  admin: { uid: 'u_admin', role: 'company_admin',   companyId: COMPANY_A },
  pm:    { uid: 'u_pm',    role: 'project_manager', companyId: COMPANY_A },
  qs:    { uid: 'u_qs',    role: 'qs',              companyId: COMPANY_A },
}
const ASSIGNED = {
  sub:    { uid: 'u_sub',    role: 'subcontractor', companyId: COMPANY_A, projectIds: [P1] },
  client: { uid: 'u_client', role: 'client',        companyId: COMPANY_A, projectIds: [P1] },
}
// Every assignment shape that must grant NOTHING. `undefined` = the key is absent.
const MALFORMED = {
  missing:  { uid: 'u_missing',  role: 'subcontractor', companyId: COMPANY_A },
  nulled:   { uid: 'u_nulled',   role: 'client',        companyId: COMPANY_A, projectIds: null },
  empty:    { uid: 'u_empty',    role: 'subcontractor', companyId: COMPANY_A, projectIds: [] },
  string:   { uid: 'u_string',   role: 'client',        companyId: COMPANY_A, projectIds: P1 },
  map:      { uid: 'u_map',      role: 'subcontractor', companyId: COMPANY_A, projectIds: { [P1]: true } },
  // (Firestore cannot store a nested array, so that shape cannot exist.)
  objects:  { uid: 'u_objects',  role: 'client',        companyId: COMPANY_A, projectIds: [{ projectId: P1 }] },
  number:   { uid: 'u_number',   role: 'subcontractor', companyId: COMPANY_A, projectIds: 1 },
  boolean:  { uid: 'u_boolean',  role: 'client',        companyId: COMPANY_A, projectIds: true },
  wildcard: { uid: 'u_wildcard', role: 'subcontractor', companyId: COMPANY_A, projectIds: ['*'] },
  prefix:   { uid: 'u_prefix',   role: 'client',        companyId: COMPANY_A, projectIds: ['p'] },
}
// Roles that are neither internal nor assignable — each CARRIES an assignment.
const OTHER_ROLES = {
  sadmin:  { uid: 'u_sadmin',  role: 'super_admin', companyId: COMPANY_A, projectIds: [P1] },
  unknown: { uid: 'u_unknown', role: 'auditor',     companyId: COMPANY_A, projectIds: [P1] },
  norole:  { uid: 'u_norole',                       companyId: COMPANY_A, projectIds: [P1] },
  cased:   { uid: 'u_cased',   role: 'Client',      companyId: COMPANY_A, projectIds: [P1] },
}
const CROSS = {
  // Company B's subcontractor, assigned to B's `p1` — the SAME id as A's p1.
  subB:       { uid: 'u_subB',   role: 'subcontractor', companyId: COMPANY_B, projectIds: [P1] },
  // Company A's subcontractor whose list names a Company B project id.
  subForeign: { uid: 'u_subFgn', role: 'subcontractor', companyId: COMPANY_A, projectIds: [PB] },
  adminB:     { uid: 'u_adminB', role: 'company_admin', companyId: COMPANY_B },
  // A deactivated external: companyId and role nulled, a STALE assignment left behind.
  gone:       { uid: 'u_gone',   role: null,            companyId: null,      projectIds: [P1] },
}
const ALL_USERS = { ...INTERNAL, ...ASSIGNED, ...MALFORMED, ...OTHER_ROLES, ...CROSS }

let testEnv
const fs = (user) => testEnv.authenticatedContext(user.uid).firestore()
const st = (user) => testEnv.authenticatedContext(user.uid).storage()

const projectDoc   = (db, c, p) => doc(db, 'companies', c, 'projects', p)
const directoryDoc = (db, c, p) => doc(db, 'companies', c, 'projectDirectory', p)
const drawingsCol  = (db, c, p) => collection(db, 'companies', c, 'projects', p, 'drawings')
const revisionsCol = (db, c, p) => collection(db, 'companies', c, 'projects', p, 'drawings', 'd1', 'revisions')
const documentsCol = (db, c, p) => collection(db, 'companies', c, 'projects', p, 'documents')
const visibleDocuments = (db, c, p) =>
  query(documentsCol(db, c, p), where('visibility', '==', 'project'), where('status', '==', 'active'))

const drawingObject  = (c, p) => `companies/${c}/projects/${p}/drawings/d1/r1/original.pdf`
const documentObject = (c, p, id) => `companies/${c}/projects/${p}/documents/${id}/original.pdf`
const bytesOf = (user, path) => getBytes(modularRef(st(user)._delegate, path))
const urlOf   = (user, path) => st(user).ref(path).getDownloadURL()

// Everything an ASSIGNED external role is meant to reach on one project.
const reads = (user, c, p) => {
  const db = fs(user)
  return [
    ['the directory entry',              () => getDoc(directoryDoc(db, c, p))],
    ['a drawing',                        () => getDoc(doc(drawingsCol(db, c, p), 'd1'))],
    ['the drawing register (list)',      () => getDocs(drawingsCol(db, c, p))],
    ['a revision',                       () => getDoc(doc(revisionsCol(db, c, p), 'r1'))],
    ['the revisions of a drawing (list)', () => getDocs(revisionsCol(db, c, p))],
    ['an active project document',       () => getDoc(doc(documentsCol(db, c, p), 'docProject'))],
    ['the project documents (filtered list)', () => getDocs(visibleDocuments(db, c, p))],
    ['a drawing file (bytes)',           () => bytesOf(user, drawingObject(c, p))],
    ['a drawing file (metadata / URL)',  () => urlOf(user, drawingObject(c, p))],
    ['a project document file (bytes)',  () => bytesOf(user, documentObject(c, p, 'docProject'))],
    ['a project document file (metadata / URL)', () => urlOf(user, documentObject(c, p, 'docProject'))],
  ]
}
const expectAll = async (user, c, p, assertion) => {
  for (const [label, run] of reads(user, c, p)) {
    try { await assertion(run()) } catch (e) { throw new Error(`${user.uid} · ${c}/${p} · ${label}: ${e.message}`, { cause: e }) }
  }
}

const profileOf = (u) => {
  const p = { name: u.uid, companyId: u.companyId }
  if ('role' in u) p.role = u.role
  if ('projectIds' in u) p.projectIds = u.projectIds
  return p
}

async function seedProject(c, p) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    const now = Timestamp.now()
    const display = { name: `${c} ${p}`, status: 'In Progress', location: 'Brisbane QLD', startDate: now, progress: 40 }
    await setDoc(projectDoc(db, c, p), {
      ...display, budget: HEADLINE_BUDGET, currency: 'AUD', currencyLocked: true, createdAt: now, createdBy: 'u_admin',
    })
    await setDoc(directoryDoc(db, c, p), display)
    await setDoc(doc(drawingsCol(db, c, p), 'd1'), { drawingNumber: 'A-100', title: 'Plan', status: 'active' })
    await setDoc(doc(revisionsCol(db, c, p), 'r1'), { revisionCode: 'A', revisionSequence: 1, status: 'current' })
    const document = (visibility, status) => ({ name: 'Doc', visibility, status, fileExt: 'pdf' })
    await setDoc(doc(documentsCol(db, c, p), 'docProject'), document('project', 'active'))
    await setDoc(doc(documentsCol(db, c, p), 'docInternal'), document('internal', 'active'))
    await setDoc(doc(documentsCol(db, c, p), 'docSuperseded'), document('project', 'superseded'))
    await setDoc(doc(documentsCol(db, c, p), 'docWithdrawn'), document('project', 'withdrawn'))
    const put = (path) => ctx.storage().ref(path).put(new Uint8Array(64), { contentType: 'application/pdf' })
    await put(drawingObject(c, p))
    for (const id of ['docProject', 'docInternal', 'docSuperseded', 'docWithdrawn']) await put(documentObject(c, p, id))
  })
}

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error('Emulator hosts are not both set — refusing to run outside the emulators. Run `npm run test:rules`.')
  }
  const [fsHost, fsPort] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  const [stHost, stPort] = process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(':')
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(FIRESTORE_RULES_PATH, 'utf8'), host: fsHost, port: Number(fsPort) },
    storage:   { rules: readFileSync(STORAGE_RULES_PATH, 'utf8'),   host: stHost, port: Number(stPort) },
  })
})

afterAll(async () => { if (testEnv) await testEnv.cleanup() })

beforeEach(async () => {
  await testEnv.clearStorage()
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    for (const u of Object.values(ALL_USERS)) await setDoc(doc(db, 'users', u.uid), profileOf(u))
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
  })
  await seedProject(COMPANY_A, P1)
  await seedProject(COMPANY_A, P2)
  await seedProject(COMPANY_B, P1)
  await seedProject(COMPANY_B, PB)
})

describe('an ASSIGNED client / subcontractor reads its assigned project', () => {
  for (const [key, user] of Object.entries(ASSIGNED)) {
    it(`${key}: every shared record and file of the assigned project is readable`, async () => {
      await expectAll(user, COMPANY_A, P1, assertSucceeds)
    })

    it(`${key}: the directory entry holds the five display fields and NOTHING else — no budget, no currency`, async () => {
      const snap = await assertSucceeds(getDoc(directoryDoc(fs(user), COMPANY_A, P1)))
      expect(Object.keys(snap.data()).sort()).toEqual(['location', 'name', 'progress', 'startDate', 'status'])
      expect(JSON.stringify(snap.data())).not.toContain(String(HEADLINE_BUDGET))
    })
  }
})

describe('the project DOCUMENT (headline budget, currency) is never readable by an external role', () => {
  for (const [key, user] of Object.entries({ ...ASSIGNED, ...MALFORMED, ...OTHER_ROLES })) {
    it(`${key}: get and list of projects are denied — assigned or not`, async () => {
      const db = fs(user)
      await assertFails(getDoc(projectDoc(db, COMPANY_A, P1)))
      await assertFails(getDoc(projectDoc(db, COMPANY_A, P2)))
      await assertFails(getDocs(collection(db, 'companies', COMPANY_A, 'projects')))
    })
  }

  it('an assigned role cannot reach the budget through a filtered or id-restricted project query either', async () => {
    const db = fs(ASSIGNED.sub)
    const projects = collection(db, 'companies', COMPANY_A, 'projects')
    await assertFails(getDocs(query(projects, where('__name__', '==', P1))))
    await assertFails(getDocs(query(projects, where('__name__', 'in', [P1]))))
    await assertFails(getDocs(query(projects, where('budget', '>', 0))))
    await assertFails(getDocs(collectionGroup(db, 'projects')))
  })

  it('no financial collection of the ASSIGNED project is readable (M2-A unchanged)', async () => {
    const db = fs(ASSIGNED.client)
    for (const name of ['budgetLines', 'purchaseOrders', 'progressClaims', 'variations', 'forecastLines', 'supplierInvoices', 'approvedBudget', 'activities', 'rfis']) {
      await assertFails(getDocs(collection(db, 'companies', COMPANY_A, 'projects', P1, name)))
    }
    await assertFails(getDoc(doc(db, 'companies', COMPANY_A, 'projects', P1, 'commercial', 'baseline')))
    await assertFails(getDocs(collection(db, 'companies', COMPANY_A, 'contacts')))
    await assertFails(getDocs(collection(db, 'companies', COMPANY_A, 'costCodes')))
  })
})

describe('the directory can never be LISTED by an external role', () => {
  for (const [key, user] of Object.entries({ ...ASSIGNED, ...MALFORMED, ...OTHER_ROLES })) {
    it(`${key}: listing projectDirectory is denied, with or without an id filter`, async () => {
      const dir = collection(fs(user), 'companies', COMPANY_A, 'projectDirectory')
      await assertFails(getDocs(dir))
      await assertFails(getDocs(query(dir, where('__name__', 'in', [P1]))))
      await assertFails(getDocs(collectionGroup(fs(user), 'projectDirectory')))
    })
  }

  it('the internal roles list it', async () => {
    for (const user of Object.values(INTERNAL)) {
      const snap = await assertSucceeds(getDocs(collection(fs(user), 'companies', COMPANY_A, 'projectDirectory')))
      expect(snap.size).toBe(2)
    }
  })
})

describe('an UNASSIGNED project of the same company is denied', () => {
  for (const [key, user] of Object.entries(ASSIGNED)) {
    it(`${key}: assigned to p1 only — nothing of p2 is readable`, async () => {
      await expectAll(user, COMPANY_A, P2, assertFails)
    })
  }

  it('a directory entry that does not exist is not disclosed for an unassigned id', async () => {
    await assertFails(getDoc(directoryDoc(fs(ASSIGNED.sub), COMPANY_A, 'no-such-project')))
  })
})

describe('a missing, null, empty or malformed assignment FAILS CLOSED', () => {
  for (const [key, user] of Object.entries(MALFORMED)) {
    it(`projectIds ${key}: nothing of any project is readable`, async () => {
      await expectAll(user, COMPANY_A, P1, assertFails)
      await expectAll(user, COMPANY_A, P2, assertFails)
    })
  }
})

describe('only client and subcontractor are assignable — every other non-internal role is denied', () => {
  for (const [key, user] of Object.entries(OTHER_ROLES)) {
    it(`${key} (${user.role ?? 'no role'}): an assignment on the profile grants nothing`, async () => {
      await expectAll(user, COMPANY_A, P1, assertFails)
    })
  }
})

describe('an assignment never crosses a company boundary', () => {
  it('Company B’s subcontractor, assigned to B’s p1, reads NOTHING of Company A’s p1 (same project id)', async () => {
    await expectAll(CROSS.subB, COMPANY_B, P1, assertSucceeds)
    await expectAll(CROSS.subB, COMPANY_A, P1, assertFails)
    await expectAll(CROSS.subB, COMPANY_A, P2, assertFails)
  })

  it('Company A’s subcontractor reads NOTHING of Company B’s p1 (same project id as its own assignment)', async () => {
    await expectAll(ASSIGNED.sub, COMPANY_B, P1, assertFails)
  })

  it('a Company A profile naming a Company B project id reads neither company’s copy', async () => {
    await expectAll(CROSS.subForeign, COMPANY_B, PB, assertFails)
    await expectAll(CROSS.subForeign, COMPANY_A, P1, assertFails)
  })

  it('an internal role of another company reads nothing of Company A', async () => {
    await expectAll(CROSS.adminB, COMPANY_A, P1, assertFails)
    await assertFails(getDoc(projectDoc(fs(CROSS.adminB), COMPANY_A, P1)))
    await assertFails(getDocs(collection(fs(CROSS.adminB), 'companies', COMPANY_A, 'projectDirectory')))
  })

  it('a DEACTIVATED external with a stale assignment reads nothing', async () => {
    await expectAll(CROSS.gone, COMPANY_A, P1, assertFails)
  })

  it('an anonymous caller and a signed-in user with no profile read nothing', async () => {
    const anon = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(directoryDoc(anon, COMPANY_A, P1)))
    await assertFails(getDoc(doc(drawingsCol(anon, COMPANY_A, P1), 'd1')))
    await assertFails(testEnv.unauthenticatedContext().storage().ref(drawingObject(COMPANY_A, P1)).getDownloadURL())
    await expectAll({ uid: 'u_stranger' }, COMPANY_A, P1, assertFails)
  })
})

describe('internal roles are unchanged — every project of their own company', () => {
  for (const [key, user] of Object.entries(INTERNAL)) {
    it(`${key}: reads both projects, the project documents and the internal documents`, async () => {
      for (const p of [P1, P2]) {
        await expectAll(user, COMPANY_A, p, assertSucceeds)
        const snap = await assertSucceeds(getDoc(projectDoc(fs(user), COMPANY_A, p)))
        expect(snap.data().budget).toBe(HEADLINE_BUDGET)
        await assertSucceeds(getDoc(doc(documentsCol(fs(user), COMPANY_A, p), 'docInternal')))
        await assertSucceeds(getDocs(documentsCol(fs(user), COMPANY_A, p)))
        await assertSucceeds(bytesOf(user, documentObject(COMPANY_A, p, 'docInternal')))
      }
      expect((await assertSucceeds(getDocs(collection(fs(user), 'companies', COMPANY_A, 'projects')))).size).toBe(2)
    })
  }
})

describe('an assigned external role still sees ACTIVE project-visible documents only', () => {
  for (const [key, user] of Object.entries(ASSIGNED)) {
    it(`${key}: internal, superseded and withdrawn documents — records and files — are denied on the assigned project`, async () => {
      const db = fs(user)
      for (const id of ['docInternal', 'docSuperseded', 'docWithdrawn']) {
        await assertFails(getDoc(doc(documentsCol(db, COMPANY_A, P1), id)))
        await assertFails(bytesOf(user, documentObject(COMPANY_A, P1, id)))
        await assertFails(urlOf(user, documentObject(COMPANY_A, P1, id)))
      }
      await assertFails(getDocs(documentsCol(db, COMPANY_A, P1)))
      const visible = await assertSucceeds(getDocs(visibleDocuments(db, COMPANY_A, P1)))
      expect(visible.docs.map(d => d.id)).toEqual(['docProject'])
    })

    it(`${key}: a file whose metadata document does not exist yet is denied (upload window)`, async () => {
      const path = documentObject(COMPANY_A, P1, 'inflight')
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.storage().ref(path).put(new Uint8Array(8), { contentType: 'application/pdf' })
      })
      await assertFails(bytesOf(user, path))
    })
  }

  it('a collection-group query over drawings or documents is denied to an external role', async () => {
    const db = fs(ASSIGNED.sub)
    await assertFails(getDocs(collectionGroup(db, 'drawings')))
    await assertFails(getDocs(collectionGroup(db, 'revisions')))
    await assertFails(getDocs(query(collectionGroup(db, 'documents'), where('visibility', '==', 'project'), where('status', '==', 'active'))))
  })
})

describe('assignments are server-managed — no client can change one', () => {
  const attempts = (db, uid) => [
    () => updateDoc(doc(db, 'users', uid), { projectIds: [P1, P2] }),
    () => setDoc(doc(db, 'users', uid), { projectIds: [P1, P2] }, { merge: true }),
    () => setDoc(doc(db, 'users', uid), { name: uid, companyId: COMPANY_A, role: 'subcontractor', projectIds: [P1, P2] }),
    () => updateDoc(doc(db, 'users', uid), { role: 'company_admin' }),
    () => deleteDoc(doc(db, 'users', uid)),
  ]

  it('an external role cannot widen, replace or create its own assignment, or promote itself', async () => {
    for (const user of [ASSIGNED.sub, ASSIGNED.client, MALFORMED.missing, MALFORMED.empty]) {
      for (const attempt of attempts(fs(user), user.uid)) await assertFails(attempt())
    }
    // …and p2 is still denied afterwards.
    await expectAll(ASSIGNED.sub, COMPANY_A, P2, assertFails)
  })

  it('no internal role can write another user’s assignment from a client either', async () => {
    for (const user of Object.values(INTERNAL)) {
      for (const attempt of attempts(fs(user), ASSIGNED.sub.uid)) await assertFails(attempt())
      await assertFails(getDoc(doc(fs(user), 'users', ASSIGNED.sub.uid)))
    }
  })

  it('a user reads their own profile (the app reads projectIds from it) and nobody else’s', async () => {
    const snap = await assertSucceeds(getDoc(doc(fs(ASSIGNED.sub), 'users', ASSIGNED.sub.uid)))
    expect(snap.data().projectIds).toEqual([P1])
    await assertFails(getDoc(doc(fs(ASSIGNED.sub), 'users', ASSIGNED.client.uid)))
  })

  it('an external role has no write path to any project record or file of its assigned project', async () => {
    const db = fs(ASSIGNED.sub)
    await assertFails(setDoc(directoryDoc(db, COMPANY_A, P1), { name: 'x', status: 'Planning', location: '', startDate: null, progress: 0 }))
    await assertFails(updateDoc(directoryDoc(db, COMPANY_A, P1), { name: 'Hacked' }))
    await assertFails(deleteDoc(directoryDoc(db, COMPANY_A, P1)))
    await assertFails(updateDoc(projectDoc(db, COMPANY_A, P1), { name: 'Hacked' }))
    await assertFails(updateDoc(doc(drawingsCol(db, COMPANY_A, P1), 'd1'), { title: 'Hacked' }))
    await assertFails(updateDoc(doc(documentsCol(db, COMPANY_A, P1), 'docProject'), { visibility: 'internal' }))
    await assertFails(st(ASSIGNED.sub).ref(`companies/${COMPANY_A}/projects/${P1}/drawings/d1/r9/original.pdf`).put(new Uint8Array(8), { contentType: 'application/pdf' }))
    await assertFails(st(ASSIGNED.sub).ref(drawingObject(COMPANY_A, P1)).delete())
  })

  it('removing the assignment (server-side) denies the project at the next read', async () => {
    await expectAll(ASSIGNED.client, COMPANY_A, P1, assertSucceeds)
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'users', ASSIGNED.client.uid), { projectIds: [] })
    })
    await expectAll(ASSIGNED.client, COMPANY_A, P1, assertFails)
  })

  it('adding an assignment (server-side) opens that project and no other', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'users', MALFORMED.empty.uid), { projectIds: [P2] })
    })
    await expectAll(MALFORMED.empty, COMPANY_A, P2, assertSucceeds)
    await expectAll(MALFORMED.empty, COMPANY_A, P1, assertFails)
  })
})
