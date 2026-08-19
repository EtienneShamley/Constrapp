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
//      which is why the hook must add `where('visibility','==','project')`;
//   3. the file identity (path, name, size, type) is immutable after creation.
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
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
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

  it('4. super_admin is an ordinary member here — project yes, internal no', async () => {
    await assertSucceeds(getDoc(docRef(ctx(USERS.sup), 'projectDoc')))
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

  it('9. the same query WITH the visibility filter succeeds — this is why the hook adds it', async () => {
    const q = query(docsCol(ctx(USERS.sub)), where('visibility', '==', 'project'))
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

  it('29. an internal role edits name, category, visibility, version, date and notes', async () => {
    await assertSucceeds(updateDoc(docRef(ctx(USERS.qs), 'doc1'), {
      name: 'Structural Specification (reissued)',
      category: 'contract',
      visibility: 'internal',
      versionLabel: 'Rev 3',
      documentDate: '2026-09-01',
      notes: 'Superseded pending signature',
      ...stamps(USERS.qs),
    }))
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

  it('51. visibility can be flipped to internal AFTER the file was already readable', async () => {
    // A project document a subcontractor has already read can be made internal
    // later. That removes FUTURE access; it cannot un-read what was read, and it
    // cannot revoke a download URL already generated.
    await seedDocument('doc1', { visibility: 'project' })
    await assertSucceeds(getDoc(docRef(ctx(USERS.sub), 'doc1')))
    await assertSucceeds(updateDoc(docRef(ctx(USERS.qs), 'doc1'), { visibility: 'internal', ...stamps(USERS.qs) }))
    await assertFails(getDoc(docRef(ctx(USERS.sub), 'doc1')))
  })
})
