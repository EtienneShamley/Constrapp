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
  collection, doc, getDoc, getDocs, query, where,
  setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore'

// ── General Project Document Security Rules — emulator tests ─────────────────
//
// The facts this suite exists to prove:
//   1. `internal` documents are invisible to subcontractor and client users,
//      while `project` documents are readable by EVERY provisioned member;
//   2. RULES ARE NOT FILTERS — an unfiltered collection query from a
//      non-internal role FAILS ENTIRELY once one internal document exists,
//      which is why the hook must add `where('visibility','==','project')`
//      and, since the ADR-75 addendum, `where('status','==','active')`: a
//      non-internal role reads ACTIVE project documents only (tests 61–73);
//   3. the file identity (path, name, size, type) is immutable after creation.
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
  // M2-A2: an external role reads a project only when ASSIGNED to it; the
  // unassigned and malformed-assignment denials are proven in
  // tests/rules/externalIsolation.rules.test.js.
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A, projectIds: [PROJECT_A] },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A, projectIds: [PROJECT_A] },
  sup:    { uid: 'u_sup',    role: 'super_admin',     companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}

let testEnv

const documentsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/documents`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const docRef = (db, id, companyId = COMPANY_A) => doc(db, documentsPath(companyId), id)
const docsCol = (db, companyId = COMPANY_A) => collection(db, documentsPath(companyId))

// Mirrors lib/files.js → documentStoragePath.
const storagePathFor = (documentId, ext = 'pdf', companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/documents/${documentId}/original.${ext}`

// A document exactly as hooks/useProjectDocuments.jsx creates it.
function documentPayload(user, documentId, overrides = {}) {
  return {
    name:         'Structural Specification',
    category:     'specification',
    visibility:   'project',
    versionLabel: 'Rev 2',
    documentDate: '2026-08-11',

    status:                 'active',
    supersededByDocumentId: null,

    notes: '',

    fileName:    'Structural Spec Rev 2.pdf',
    fileExt:     'pdf',
    fileSize:    102400,
    contentType: 'application/pdf',
    storagePath: storagePathFor(documentId),

    withdrawnAt:    null,
    withdrawnBy:    null,
    withdrawReason: '',

    revision: 1,

    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

async function seedDocument(id, overrides = {}, companyId = COMPANY_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(doc(db, documentsPath(companyId), id), {
      ...documentPayload(USERS.admin, id),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...overrides,
    })
  })
}

const stamps = (user, extra = {}) => ({
  updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})

const supersedeWrite = (user, byId, extra = {}) => ({
  status: 'superseded',
  supersededByDocumentId: byId,
  ...stamps(user),
  ...extra,
})
const withdrawWrite = (user, reason = 'Replaced by the signed copy', extra = {}) => ({
  status: 'withdrawn',
  withdrawnAt:    serverTimestamp(),
  withdrawnBy:    user.uid,
  withdrawReason: reason,
  ...stamps(user),
  ...extra,
})

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
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid, ...(u.projectIds ? { projectIds: u.projectIds } : {}) })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project' })
  })
})

// ── READS ────────────────────────────────────────────────────────────────────

describe('READS — visibility is the gate', () => {
  beforeEach(async () => {
    await seedDocument('projectDoc', { visibility: 'project' })
    await seedDocument('internalDoc', { visibility: 'internal', name: 'Head Contract' })
  })

  it('1. internal roles read both project and internal documents', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(docRef(ctx(user), 'projectDoc')))
      await assertSucceeds(getDoc(docRef(ctx(user), 'internalDoc')))
    }
  })

  it('2. subcontractor and client read a PROJECT document', async () => {
    for (const user of [USERS.sub, USERS.client]) {
      await assertSucceeds(getDoc(docRef(ctx(user), 'projectDoc')))
    }
  })

  it('3. subcontractor and client CANNOT read an INTERNAL document', async () => {
    for (const user of [USERS.sub, USERS.client]) {
      await assertFails(getDoc(docRef(ctx(user), 'internalDoc')))
    }
  })

  it('4. super_admin is neither internal nor an assignable external role — it reads NO document (M2-A2)', async () => {
    await assertFails(getDoc(docRef(ctx(USERS.sup), 'projectDoc')))
    await assertFails(getDoc(docRef(ctx(USERS.sup), 'internalDoc')))
  })

  it('5. another company reads neither', async () => {
    await assertFails(getDoc(docRef(ctx(USERS.other), 'projectDoc')))
    await assertFails(getDoc(docRef(ctx(USERS.other), 'internalDoc')))
  })

  it('6. an unauthenticated caller reads neither', async () => {
    const anon = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(docRef(anon, 'projectDoc')))
  })
})

describe('LIST QUERIES — rules are not filters', () => {
  beforeEach(async () => {
    await seedDocument('projectDoc', { visibility: 'project' })
    await seedDocument('internalDoc', { visibility: 'internal' })
  })

  it('7. an internal role may query the whole collection', async () => {
    await assertSucceeds(getDocs(docsCol(ctx(USERS.qs))))
  })

  it('8. an UNFILTERED query by a subcontractor FAILS ENTIRELY — one internal document poisons it', async () => {
    await assertFails(getDocs(docsCol(ctx(USERS.sub))))
    await assertFails(getDocs(docsCol(ctx(USERS.client))))
  })

  it('9. the same query WITH the visibility AND status filters succeeds — this is why the hook adds them (ADR-75 addendum)', async () => {
    const q = query(docsCol(ctx(USERS.sub)), where('visibility', '==', 'project'), where('status', '==', 'active'))
    const snap = await assertSucceeds(getDocs(q))
    expect(snap.docs.map(d => d.id)).toEqual(['projectDoc'])
  })

  it('10. a subcontractor cannot query for internal documents', async () => {
    const q = query(docsCol(ctx(USERS.sub)), where('visibility', '==', 'internal'))
    await assertFails(getDocs(q))
  })

  it('11. another company cannot query at all, filtered or not', async () => {
    await assertFails(getDocs(docsCol(ctx(USERS.other))))
    await assertFails(getDocs(query(docsCol(ctx(USERS.other)), where('visibility', '==', 'project'))))
  })
})

// ── CREATE ───────────────────────────────────────────────────────────────────

describe('CREATE — writer matrix and shape', () => {
  it('12. company_admin, project_manager AND qs create a document', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      const id = `doc_${user.uid}`
      await assertSucceeds(setDoc(docRef(ctx(user), id), documentPayload(user, id)))
    }
  })

  it('13. subcontractor, client and super_admin cannot create a document', async () => {
    for (const user of [USERS.sub, USERS.client, USERS.sup]) {
      const id = `doc_${user.uid}`
      await assertFails(setDoc(docRef(ctx(user), id), documentPayload(user, id)))
    }
  })

  it('14. another company cannot create a document here', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.other), 'd1'), documentPayload(USERS.other, 'd1')))
  })

  it('15. both visibilities are accepted at creation', async () => {
    await assertSucceeds(setDoc(docRef(ctx(USERS.qs), 'p1'), documentPayload(USERS.qs, 'p1', { visibility: 'project' })))
    await assertSucceeds(setDoc(docRef(ctx(USERS.qs), 'i1'), documentPayload(USERS.qs, 'i1', { visibility: 'internal' })))
  })

  it('16. an unknown visibility or category is rejected', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'), documentPayload(USERS.qs, 'd1', { visibility: 'public' })))
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd2'), documentPayload(USERS.qs, 'd2', { category: 'invoice' })))
  })

  it('17. a blank name is rejected', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'), documentPayload(USERS.qs, 'd1', { name: '   ' })))
  })

  it('18. a document may be created with NO date, but not with a malformed one', async () => {
    await assertSucceeds(setDoc(docRef(ctx(USERS.qs), 'd1'), documentPayload(USERS.qs, 'd1', { documentDate: null })))
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd2'), documentPayload(USERS.qs, 'd2', { documentDate: '11/08/2026' })))
  })

  it('19. a document must be born ACTIVE with no supersede or withdraw stamps', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'), documentPayload(USERS.qs, 'd1', { status: 'superseded' })))
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd2'), documentPayload(USERS.qs, 'd2', { supersededByDocumentId: 'other' })))
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd3'), documentPayload(USERS.qs, 'd3', { withdrawnBy: USERS.qs.uid })))
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd4'), documentPayload(USERS.qs, 'd4', { withdrawReason: 'gone' })))
  })

  it('20. the storage path must be EXACTLY the derived path for this document', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'),
      documentPayload(USERS.qs, 'd1', { storagePath: storagePathFor('d2') })))
    // Another tenant's bucket path.
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd3'),
      documentPayload(USERS.qs, 'd3', { storagePath: storagePathFor('d3', 'pdf', COMPANY_B) })))
    // A drawing path rather than a document path.
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd4'), documentPayload(USERS.qs, 'd4', {
      storagePath: `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings/x/y/original.pdf`,
    })))
  })

  it('21. the object filename must be original.{ext}', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'), documentPayload(USERS.qs, 'd1', {
      storagePath: `companies/${COMPANY_A}/projects/${PROJECT_A}/documents/d1/Spec.pdf`,
    })))
  })

  it('22. contentType and fileExt must agree, and PNG/JPEG are accepted', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'),
      documentPayload(USERS.qs, 'd1', { contentType: 'image/png' })))
    await assertSucceeds(setDoc(docRef(ctx(USERS.qs), 'p'), documentPayload(USERS.qs, 'p', {
      fileExt: 'png', contentType: 'image/png', storagePath: storagePathFor('p', 'png'),
    })))
    await assertSucceeds(setDoc(docRef(ctx(USERS.qs), 'j'), documentPayload(USERS.qs, 'j', {
      fileExt: 'jpg', contentType: 'image/jpeg', storagePath: storagePathFor('j', 'jpg'),
    })))
  })

  it('23. an unsupported content type is rejected', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'), documentPayload(USERS.qs, 'd1', {
      fileExt: 'docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      storagePath: storagePathFor('d1', 'docx'),
    })))
  })

  it('24. a zero-byte document is rejected', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'), documentPayload(USERS.qs, 'd1', { fileSize: 0 })))
  })

  it('25. the 25 MB ceiling is enforced — exactly 25 MB passes, one byte more fails', async () => {
    await assertSucceeds(setDoc(docRef(ctx(USERS.qs), 'ok'), documentPayload(USERS.qs, 'ok', { fileSize: 26214400 })))
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'big'), documentPayload(USERS.qs, 'big', { fileSize: 26214401 })))
  })

  it('26. a document ceiling is SMALLER than a drawing ceiling — 40 MB is rejected here', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'), documentPayload(USERS.qs, 'd1', { fileSize: 41943040 })))
  })

  it('27. createdBy must be the caller, createdAt and updatedAt must be server time', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'),
      documentPayload(USERS.qs, 'd1', { createdBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(docRef(ctx(USERS.qs), 'd2'),
        documentPayload(USERS.qs, 'd2', { createdAt: clock() })))
      await assertFails(setDoc(docRef(ctx(USERS.qs), 'd3'),
        documentPayload(USERS.qs, 'd3', { updatedAt: clock() })))
    }
  })

  it('28. revision must be 1', async () => {
    await assertFails(setDoc(docRef(ctx(USERS.qs), 'd1'), documentPayload(USERS.qs, 'd1', { revision: 2 })))
  })
})

// ── UPDATE ───────────────────────────────────────────────────────────────────

describe('UPDATE — metadata edit', () => {
  beforeEach(async () => { await seedDocument('doc1') })

  it('29. an internal role edits name, category, version, date and notes — visibility unchanged', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(updateDoc(docRef(ctx(user), 'doc1'), {
        name: 'Structural Specification (reissued)',
        category: 'contract',
        visibility: 'project',
        versionLabel: 'Rev 3',
        documentDate: '2026-09-01',
        notes: 'Superseded pending signature',
        ...stamps(user),
      }))
    }
  })

  it('30. subcontractor, client and super_admin cannot edit', async () => {
    for (const user of [USERS.sub, USERS.client, USERS.sup]) {
      await assertFails(updateDoc(docRef(ctx(user), 'doc1'), { name: 'Hacked', ...stamps(user) }))
    }
  })

  it('31. THE FILE IDENTITY IS IMMUTABLE — path, name, size, ext and type cannot be rewritten', async () => {
    for (const patch of [
      { storagePath: storagePathFor('other') },
      { fileName: 'other.pdf' },
      { fileSize: 1 },
      { fileExt: 'png' },
      { contentType: 'image/png' },
    ]) {
      await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { ...patch, ...stamps(USERS.qs) }))
    }
  })

  it('32. createdAt, createdBy and revision can never be rewritten', async () => {
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { createdBy: USERS.pm.uid, ...stamps(USERS.qs) }))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { createdAt: CLIENT_CLOCKS[0](), ...stamps(USERS.qs) }))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { revision: 2, ...stamps(USERS.qs) }))
  })

  it('33. every update must stamp the caller and server time', async () => {
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { name: 'X', updatedBy: USERS.pm.uid, updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { name: 'X', updatedBy: USERS.qs.uid, updatedAt: CLIENT_CLOCKS[2]() }))
  })

  it('34. a metadata edit cannot smuggle a status change', async () => {
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), {
      name: 'X', status: 'withdrawn', ...stamps(USERS.qs),
    }))
  })
})

describe('UPDATE — supersession', () => {
  beforeEach(async () => { await seedDocument('doc1') })

  it('35. active -> superseded, linking forward to the replacement', async () => {
    await assertSucceeds(updateDoc(docRef(ctx(USERS.qs), 'doc1'), supersedeWrite(USERS.qs, 'doc2')))
  })

  it('36. a document cannot supersede itself', async () => {
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), supersedeWrite(USERS.qs, 'doc1')))
  })

  it('37. the forward link cannot be empty or null', async () => {
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), supersedeWrite(USERS.qs, '')))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), supersedeWrite(USERS.qs, null)))
  })

  it('38. supersession cannot also change the metadata or the file', async () => {
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'),
      supersedeWrite(USERS.qs, 'doc2', { name: 'Renamed' })))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'),
      supersedeWrite(USERS.qs, 'doc2', { storagePath: storagePathFor('doc2') })))
  })

  it('39. a superseded document cannot go back to active', async () => {
    await seedDocument('doc1', { status: 'superseded', supersededByDocumentId: 'doc2' })
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { status: 'active', ...stamps(USERS.qs) }))
  })

  it('40. a superseded document cannot be edited', async () => {
    await seedDocument('doc1', { status: 'superseded', supersededByDocumentId: 'doc2' })
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { name: 'Renamed', ...stamps(USERS.qs) }))
  })
})

describe('UPDATE — withdrawal', () => {
  beforeEach(async () => { await seedDocument('doc1') })

  it('41. active -> withdrawn with a reason', async () => {
    await assertSucceeds(updateDoc(docRef(ctx(USERS.qs), 'doc1'), withdrawWrite(USERS.qs)))
  })

  it('42. superseded -> withdrawn with a reason', async () => {
    await seedDocument('doc1', { status: 'superseded', supersededByDocumentId: 'doc2' })
    await assertSucceeds(updateDoc(docRef(ctx(USERS.qs), 'doc1'), withdrawWrite(USERS.qs)))
  })

  it('43. an empty or whitespace-only reason is rejected', async () => {
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), withdrawWrite(USERS.qs, '')))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), withdrawWrite(USERS.qs, '   ')))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), withdrawWrite(USERS.qs, '\n\t')))
  })

  it('44. the withdrawal stamps must be the caller and server time', async () => {
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'),
      withdrawWrite(USERS.qs, 'Recalled', { withdrawnBy: USERS.pm.uid })))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'),
      withdrawWrite(USERS.qs, 'Recalled', { withdrawnAt: CLIENT_CLOCKS[1]() })))
  })

  it('45. WITHDRAWN IS TERMINAL', async () => {
    await seedDocument('doc1', {
      status: 'withdrawn', withdrawReason: 'Recalled',
      withdrawnBy: USERS.admin.uid, withdrawnAt: Timestamp.now(),
    })
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { status: 'active', ...stamps(USERS.qs) }))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), supersedeWrite(USERS.qs, 'doc2')))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), withdrawWrite(USERS.qs)))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { name: 'Renamed', ...stamps(USERS.qs) }))
  })

  it('46. subcontractor and client cannot withdraw', async () => {
    for (const user of [USERS.sub, USERS.client]) {
      await assertFails(updateDoc(docRef(ctx(user), 'doc1'), withdrawWrite(user)))
    }
  })
})

// ── DELETE ───────────────────────────────────────────────────────────────────

// ── ADR-75 Stage 2 — the visibility-reduction lock ───────────────────────────
//
// `project -> internal` removes access from external members, and nothing in
// the app observes it, so no token clean-up would be queued. Rules refuse it
// for every client; a correction is an operator task until a trusted
// server-side workflow exists (ADR-75 decision 13).
describe('UPDATE — visibility-reduction lock (ADR-75 Stage 2)', () => {
  const INTERNAL = () => [USERS.admin, USERS.pm, USERS.qs]

  it('52. project -> internal is REFUSED for every internal role', async () => {
    await seedDocument('doc1', { visibility: 'project' })
    for (const user of INTERNAL()) {
      await assertFails(updateDoc(docRef(ctx(user), 'doc1'), { visibility: 'internal', ...stamps(user) }))
    }
  })

  it('53. the reduction cannot ride along with another metadata edit', async () => {
    await seedDocument('doc1', { visibility: 'project' })
    await assertFails(updateDoc(docRef(ctx(USERS.admin), 'doc1'), {
      name: 'Renamed', notes: 'tidy-up', visibility: 'internal', ...stamps(USERS.admin),
    }))
  })

  it('54. internal -> project is still allowed for every internal role', async () => {
    for (const [i, user] of INTERNAL().entries()) {
      await seedDocument(`up${i}`, { visibility: 'internal' })
      await assertSucceeds(updateDoc(docRef(ctx(user), `up${i}`), { visibility: 'project', ...stamps(user) }))
      await assertSucceeds(getDoc(docRef(ctx(USERS.sub), `up${i}`)))
    }
  })

  it('55. an internal document stays editable and stays internal', async () => {
    await seedDocument('doc1', { visibility: 'internal' })
    for (const user of INTERNAL()) {
      await assertSucceeds(updateDoc(docRef(ctx(user), 'doc1'), {
        name: `Head Contract (${user.role})`, visibility: 'internal', notes: 'checked', ...stamps(user),
      }))
    }
    await assertFails(getDoc(docRef(ctx(USERS.sub), 'doc1')))
  })

  it('56. a project document keeps every other metadata edit', async () => {
    await seedDocument('doc1', { visibility: 'project' })
    await assertSucceeds(updateDoc(docRef(ctx(USERS.pm), 'doc1'), {
      name: 'Spec (final)', category: 'report', versionLabel: 'Rev 9', documentDate: null, notes: 'n', ...stamps(USERS.pm),
    }))
  })

  it('57. creation as internal, and a replacement uploaded as internal, are untouched', async () => {
    await seedDocument('old', { visibility: 'project' })
    await assertSucceeds(setDoc(docRef(ctx(USERS.qs), 'new'), documentPayload(USERS.qs, 'new', { visibility: 'internal' })))
    await assertSucceeds(updateDoc(docRef(ctx(USERS.qs), 'old'), supersedeWrite(USERS.qs, 'new')))
  })

  it('58. supersede and withdraw work on both visibilities and cannot carry a reduction', async () => {
    await seedDocument('p1', { visibility: 'project' })
    await seedDocument('p2', { visibility: 'project' })
    await seedDocument('i1', { visibility: 'internal' })
    await assertFails(updateDoc(docRef(ctx(USERS.pm), 'p1'), supersedeWrite(USERS.pm, 'p2', { visibility: 'internal' })))
    await assertFails(updateDoc(docRef(ctx(USERS.pm), 'p1'), withdrawWrite(USERS.pm, 'Wrong file', { visibility: 'internal' })))
    await assertSucceeds(updateDoc(docRef(ctx(USERS.pm), 'p1'), supersedeWrite(USERS.pm, 'p2')))
    await assertSucceeds(updateDoc(docRef(ctx(USERS.pm), 'p1'), withdrawWrite(USERS.pm)))
    await assertSucceeds(updateDoc(docRef(ctx(USERS.pm), 'i1'), withdrawWrite(USERS.pm)))
  })

  it('59. external roles and super_admin can change visibility in neither direction', async () => {
    await seedDocument('p1', { visibility: 'project' })
    await seedDocument('i1', { visibility: 'internal' })
    for (const user of [USERS.sub, USERS.client, USERS.sup]) {
      await assertFails(updateDoc(docRef(ctx(user), 'p1'), { visibility: 'internal', ...stamps(user) }))
      await assertFails(updateDoc(docRef(ctx(user), 'i1'), { visibility: 'project', ...stamps(user) }))
    }
  })

  it('60. another company\'s admin can change visibility in neither direction, in either tenant path', async () => {
    await seedDocument('p1', { visibility: 'project' })
    await seedDocument('i1', { visibility: 'internal' })
    await assertFails(updateDoc(docRef(ctx(USERS.other), 'p1'), { visibility: 'internal', ...stamps(USERS.other) }))
    await assertFails(updateDoc(docRef(ctx(USERS.other), 'i1'), { visibility: 'project', ...stamps(USERS.other) }))
    // The lock is the same rule in the other tenant.
    await seedDocument('b1', { visibility: 'project' }, COMPANY_B)
    await assertFails(updateDoc(docRef(ctx(USERS.other), 'b1', COMPANY_B), { visibility: 'internal', ...stamps(USERS.other) }))
    await assertFails(updateDoc(docRef(ctx(USERS.admin), 'b1', COMPANY_B), { name: 'x', ...stamps(USERS.admin) }))
  })
})

describe('DELETE — blocked for everyone', () => {
  beforeEach(async () => { await seedDocument('doc1') })

  it('47. no role can delete a document', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client, USERS.sup, USERS.other]) {
      await assertFails(deleteDoc(docRef(ctx(user), 'doc1')))
    }
  })
})

// ── DOCUMENTED GAPS ──────────────────────────────────────────────────────────

describe('DOCUMENTED GAPS — enforced by the client only', () => {
  it('48. supersededByDocumentId is NOT checked for existence', async () => {
    await seedDocument('doc1')
    await assertSucceeds(updateDoc(docRef(ctx(USERS.qs), 'doc1'), supersedeWrite(USERS.qs, 'neverExisted')))
  })

  it('49. document names are NOT unique — rules cannot query siblings', async () => {
    await seedDocument('doc1', { name: 'Head Contract' })
    await assertSucceeds(setDoc(docRef(ctx(USERS.qs), 'doc2'),
      documentPayload(USERS.qs, 'doc2', { name: 'Head Contract' })))
  })

  it('50. fileSize is metadata — rules never see the bytes in Storage', async () => {
    await assertSucceeds(setDoc(docRef(ctx(USERS.qs), 'doc1'),
      documentPayload(USERS.qs, 'doc1', { fileSize: 20971520 })))
  })

  it('51. CLOSED BY ADR-75 — a client can no longer flip a readable document to internal', async () => {
    // Before ADR-75 an internal role could make a `project` document `internal`
    // after a subcontractor had read it — an access reduction nothing observed,
    // so no download-link clean-up was ever queued for it. Rules now refuse it.
    await seedDocument('doc1', { visibility: 'project' })
    await assertSucceeds(getDoc(docRef(ctx(USERS.sub), 'doc1')))
    await assertFails(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { visibility: 'internal', ...stamps(USERS.qs) }))
    await assertSucceeds(getDoc(docRef(ctx(USERS.sub), 'doc1')))
  })
})

// ── EXTERNAL ACCESS FOLLOWS STATUS (ADR-75 addendum, DC46) ───────────────────
//
// A non-internal role reads a document only while it is `visibility: 'project'`
// AND `status: 'active'`. Superseded and withdrawn documents are invalidated:
// internal roles keep them as history, everyone else loses them at once.
describe('READS — a non-internal role reads ACTIVE project documents only', () => {
  // M2-A2: the ASSIGNED external roles. super_admin reads nothing (test 61 below).
  const EXTERNAL = () => [USERS.sub, USERS.client]
  const INTERNAL = () => [USERS.admin, USERS.pm, USERS.qs]

  beforeEach(async () => {
    await seedDocument('active', { visibility: 'project' })
    await seedDocument('superseded', { visibility: 'project', status: 'superseded', supersededByDocumentId: 'active' })
    await seedDocument('withdrawn', {
      visibility: 'project', status: 'withdrawn', withdrawReason: 'Issued in error',
      withdrawnBy: USERS.admin.uid, withdrawnAt: Timestamp.now(),
    })
  })

  it('61. an ASSIGNED subcontractor and client read an ACTIVE project document; super_admin does not', async () => {
    for (const user of EXTERNAL()) await assertSucceeds(getDoc(docRef(ctx(user), 'active')))
    await assertFails(getDoc(docRef(ctx(USERS.sup), 'active')))
  })

  it('62. they are DENIED a SUPERSEDED project document', async () => {
    for (const user of EXTERNAL()) await assertFails(getDoc(docRef(ctx(user), 'superseded')))
  })

  it('63. they are DENIED a WITHDRAWN project document', async () => {
    for (const user of EXTERNAL()) await assertFails(getDoc(docRef(ctx(user), 'withdrawn')))
  })

  it('64. INTERNAL HISTORY IS PRESERVED — internal roles read superseded and withdrawn documents, project or internal', async () => {
    await seedDocument('internalWithdrawn', {
      visibility: 'internal', status: 'withdrawn', withdrawReason: 'Recalled',
      withdrawnBy: USERS.admin.uid, withdrawnAt: Timestamp.now(),
    })
    for (const user of INTERNAL()) {
      for (const id of ['active', 'superseded', 'withdrawn', 'internalWithdrawn']) {
        await assertSucceeds(getDoc(docRef(ctx(user), id)))
      }
      const snap = await assertSucceeds(getDocs(docsCol(ctx(user))))
      expect(snap.size).toBe(4)
    }
  })

  it('65. THE HOOK’S EXTERNAL QUERY — visibility AND status filters — succeeds and returns only the active document', async () => {
    for (const user of EXTERNAL()) {
      const q = query(docsCol(ctx(user)), where('visibility', '==', 'project'), where('status', '==', 'active'))
      const snap = await assertSucceeds(getDocs(q))
      expect(snap.docs.map(d => d.id)).toEqual(['active'])
    }
  })

  it('66. THE PREVIOUS BUNDLE’S QUERY — visibility filter alone — now FAILS ENTIRELY (fail-closed between the two releases)', async () => {
    for (const user of EXTERNAL()) {
      await assertFails(getDocs(query(docsCol(ctx(user)), where('visibility', '==', 'project'))))
    }
  })

  it('67. a status filter alone is not enough — visibility must be constrained too', async () => {
    await seedDocument('internalActive', { visibility: 'internal' })
    await assertFails(getDocs(query(docsCol(ctx(USERS.sub)), where('status', '==', 'active'))))
  })

  it('68. a non-internal role cannot query FOR superseded or withdrawn documents', async () => {
    for (const status of ['superseded', 'withdrawn']) {
      const q = query(docsCol(ctx(USERS.sub)), where('visibility', '==', 'project'), where('status', '==', status))
      await assertFails(getDocs(q))
    }
  })

  it('69. CROSS-TENANT — another company is denied every status, by get and by the filtered query', async () => {
    for (const id of ['active', 'superseded', 'withdrawn']) {
      await assertFails(getDoc(docRef(ctx(USERS.other), id)))
    }
    await assertFails(getDocs(query(docsCol(ctx(USERS.other)), where('visibility', '==', 'project'), where('status', '==', 'active'))))
  })

  it('70. an unauthenticated caller is denied every status', async () => {
    const anon = testEnv.unauthenticatedContext().firestore()
    for (const id of ['active', 'superseded', 'withdrawn']) await assertFails(getDoc(docRef(anon, id)))
  })

  it('71. LIFECYCLE — a real WITHDRAW by an internal role removes external access at the next read; the writer still reads it', async () => {
    await assertSucceeds(getDoc(docRef(ctx(USERS.sub), 'active')))
    await assertSucceeds(updateDoc(docRef(ctx(USERS.qs), 'active'), withdrawWrite(USERS.qs)))
    await assertFails(getDoc(docRef(ctx(USERS.sub), 'active')))
    await assertFails(getDoc(docRef(ctx(USERS.client), 'active')))
    await assertSucceeds(getDoc(docRef(ctx(USERS.qs), 'active')))
  })

  it('72. LIFECYCLE — a real REPLACEMENT: the old record is denied to external roles, the new active one is readable', async () => {
    await assertSucceeds(setDoc(docRef(ctx(USERS.pm), 'replacement'), documentPayload(USERS.pm, 'replacement')))
    await assertSucceeds(updateDoc(docRef(ctx(USERS.pm), 'active'), supersedeWrite(USERS.pm, 'replacement')))
    await assertFails(getDoc(docRef(ctx(USERS.sub), 'active')))
    await assertSucceeds(getDoc(docRef(ctx(USERS.sub), 'replacement')))
    await assertSucceeds(getDoc(docRef(ctx(USERS.pm), 'active')))
    // superseded → withdrawn is still available to the register's writers
    await assertSucceeds(updateDoc(docRef(ctx(USERS.admin), 'active'), withdrawWrite(USERS.admin)))
  })

  it('73. the Stage 2 lock is unchanged — an active project document still cannot be made internal, and stays readable', async () => {
    await assertFails(updateDoc(docRef(ctx(USERS.admin), 'active'), { visibility: 'internal', ...stamps(USERS.admin) }))
    await assertSucceeds(getDoc(docRef(ctx(USERS.sub), 'active')))
  })
})
