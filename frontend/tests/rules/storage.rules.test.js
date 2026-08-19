import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest'
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing'
import { doc, setDoc, Timestamp } from 'firebase/firestore'

// ── Firebase Storage Security Rules — emulator tests ─────────────────────────
//
// Storage is the SECOND trust boundary in Constrapp, and these tests are what
// make claims about it honest. Every call below is a direct SDK call against the
// Storage emulator — exactly what a client bypassing the app would issue.
//
// What this suite proves:
//   · company/tenant isolation from the PATH alone
//   · the drawing writer set (company_admin, project_manager — NOT qs) and the
//     document writer set (company_admin, project_manager, qs)
//   · drawings are readable by EVERY provisioned company member, including
//     subcontractor and client
//   · a general document is readable by a non-internal role only once its
//     Firestore metadata EXISTS and says `visibility: 'project'` — so the
//     upload window (Storage first, Firestore second) fails CLOSED
//   · objects are CREATE-ONLY: no overwrite, no update, no delete, ever
//   · content-type, object-name and size rules, including zero-byte rejection
//   · everything outside the two approved path shapes is denied
//
// It runs against BOTH emulators, because the document read rule performs a
// `firestore.get()`. `npm run test:rules` starts firestore and storage together.
//
// SAFETY: refuses to run unless both emulator hosts are set.

const HERE = dirname(fileURLToPath(import.meta.url))
const STORAGE_RULES_PATH   = resolve(HERE, '../../storage.rules')
const FIRESTORE_RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const DRAWING_A = 'drawingA'
const REVISION_A = 'revisionA'

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

// ── Paths (mirror lib/files.js) ──────────────────────────────────────────────

const drawingPath = ({
  companyId = COMPANY_A, projectId = PROJECT_A, drawingId = DRAWING_A,
  revisionId = REVISION_A, name = 'original.pdf',
} = {}) => `companies/${companyId}/projects/${projectId}/drawings/${drawingId}/${revisionId}/${name}`

const documentPath = ({
  companyId = COMPANY_A, projectId = PROJECT_A, documentId = 'docA', name = 'original.pdf',
} = {}) => `companies/${companyId}/projects/${projectId}/documents/${documentId}/${name}`

// ── Bytes ────────────────────────────────────────────────────────────────────

const PDF = 'application/pdf'
const bytes = (n) => new Uint8Array(n)
const SMALL = bytes(1024)

const storageOf = (user) => testEnv.authenticatedContext(user.uid).storage()

const upload = (user, path, data = SMALL, contentType = PDF) =>
  storageOf(user).ref(path).put(data, { contentType })

const read = (user, path) => storageOf(user).ref(path).getDownloadURL()

// Seeds an object directly, bypassing rules — the arrange step for read tests.
async function seedObject(path, contentType = PDF) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await c.storage().ref(path).put(SMALL, { contentType })
  })
}

// Seeds the Firestore metadata a document object's read rule depends on.
async function seedDocumentMetadata(documentId, visibility = 'project', companyId = COMPANY_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(doc(db, `companies/${companyId}/projects/${PROJECT_A}/documents`, documentId), {
      name: 'Seeded', category: 'specification', visibility,
      versionLabel: '', documentDate: null, status: 'active',
      supersededByDocumentId: null, notes: '',
      fileName: 'seed.pdf', fileExt: 'pdf', fileSize: 1024, contentType: PDF,
      storagePath: documentPath({ companyId, documentId }),
      withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
      revision: 1,
      createdAt: Timestamp.now(), createdBy: USERS.admin.uid,
      updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
    })
  })
}

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST are not both set — refusing to run ' +
      'Storage Rules tests outside the emulators. Run `npm run test:rules`.',
    )
  }
  const [fsHost, fsPort] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  const [stHost, stPort] = process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(':')

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(FIRESTORE_RULES_PATH, 'utf8'), host: fsHost, port: Number(fsPort) },
    storage:   { rules: readFileSync(STORAGE_RULES_PATH, 'utf8'),   host: stHost, port: Number(stPort) },
  })
})

afterAll(async () => {
  if (testEnv) await testEnv.cleanup()
})

beforeEach(async () => {
  await testEnv.clearStorage()
  await testEnv.clearFirestore()
  // The membership documents these rules `firestore.get()` to authorise.
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    }
  })
})

// ── DRAWING OBJECTS — READ ───────────────────────────────────────────────────

describe('DRAWING FILES — read', () => {
  beforeEach(async () => { await seedObject(drawingPath()) })

  it('1. every provisioned Company A role reads a drawing file', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client, USERS.sup]) {
      await assertSucceeds(read(user, drawingPath()))
    }
  })

  it('2. a subcontractor — who reads no financial data — reads the drawing file', async () => {
    await assertSucceeds(read(USERS.sub, drawingPath()))
  })

  it('3. ANOTHER COMPANY cannot read it', async () => {
    await assertFails(read(USERS.other, drawingPath()))
  })

  it('4. an unauthenticated caller cannot read it', async () => {
    await assertFails(testEnv.unauthenticatedContext().storage().ref(drawingPath()).getDownloadURL())
  })

  it('5. a signed-in user with no membership document cannot read it', async () => {
    await assertFails(
      testEnv.authenticatedContext('u_nobody').storage().ref(drawingPath()).getDownloadURL(),
    )
  })

  it('6. a Company A member cannot read a COMPANY B drawing object', async () => {
    await seedObject(drawingPath({ companyId: COMPANY_B }))
    await assertFails(read(USERS.admin, drawingPath({ companyId: COMPANY_B })))
  })
})

// ── DRAWING OBJECTS — WRITE ──────────────────────────────────────────────────

describe('DRAWING FILES — write', () => {
  it('7. company_admin uploads a drawing', async () => {
    await assertSucceeds(upload(USERS.admin, drawingPath({ revisionId: 'r_admin' })))
  })

  it('8. project_manager uploads a drawing', async () => {
    await assertSucceeds(upload(USERS.pm, drawingPath({ revisionId: 'r_pm' })))
  })

  it('9. QS CANNOT upload a drawing in this branch', async () => {
    await assertFails(upload(USERS.qs, drawingPath({ revisionId: 'r_qs' })))
  })

  it('10. subcontractor cannot upload a drawing', async () => {
    await assertFails(upload(USERS.sub, drawingPath({ revisionId: 'r_sub' })))
  })

  it('11. client cannot upload a drawing', async () => {
    await assertFails(upload(USERS.client, drawingPath({ revisionId: 'r_client' })))
  })

  it('12. super_admin has no special power and cannot upload a drawing', async () => {
    await assertFails(upload(USERS.sup, drawingPath({ revisionId: 'r_sup' })))
  })

  it('13. an unauthenticated caller cannot upload', async () => {
    await assertFails(
      testEnv.unauthenticatedContext().storage().ref(drawingPath({ revisionId: 'r_anon' }))
        .put(SMALL, { contentType: PDF }),
    )
  })

  it('14. ANOTHER COMPANY cannot upload into Company A', async () => {
    await assertFails(upload(USERS.other, drawingPath({ revisionId: 'r_other' })))
  })

  it('15. PNG and JPEG uploads are accepted under their own object names', async () => {
    await assertSucceeds(
      storageOf(USERS.admin).ref(drawingPath({ revisionId: 'r_png', name: 'original.png' }))
        .put(SMALL, { contentType: 'image/png' }),
    )
    await assertSucceeds(
      storageOf(USERS.admin).ref(drawingPath({ revisionId: 'r_jpg', name: 'original.jpg' }))
        .put(SMALL, { contentType: 'image/jpeg' }),
    )
  })
})

// ── DRAWING OBJECTS — CREATE-ONLY ────────────────────────────────────────────

describe('DRAWING FILES — create-only semantics', () => {
  beforeEach(async () => { await seedObject(drawingPath()) })

  it('16. OVERWRITING an existing object is denied, even for the role that may create', async () => {
    await assertFails(upload(USERS.admin, drawingPath()))
    await assertFails(upload(USERS.pm, drawingPath()))
  })

  it('17. updating an object with different content is denied', async () => {
    await assertFails(
      storageOf(USERS.admin).ref(drawingPath()).put(bytes(2048), { contentType: PDF }),
    )
  })

  it('18. updating an object with different metadata is denied', async () => {
    await assertFails(storageOf(USERS.admin).ref(drawingPath()).updateMetadata({
      customMetadata: { tampered: 'true' },
    }))
  })

  it('19. DELETING a drawing object is denied for every role', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client]) {
      await assertFails(storageOf(user).ref(drawingPath()).delete())
    }
  })
})

// ── DRAWING OBJECTS — SHAPE ──────────────────────────────────────────────────

describe('DRAWING FILES — object shape', () => {
  it('20. a ZERO-BYTE upload is denied', async () => {
    await assertFails(
      storageOf(USERS.admin).ref(drawingPath({ revisionId: 'r_zero' })).put(bytes(0), { contentType: PDF }),
    )
  })

  it('21. an unsupported content type is denied', async () => {
    await assertFails(
      storageOf(USERS.admin).ref(drawingPath({ revisionId: 'r_dwg', name: 'original.dwg' }))
        .put(SMALL, { contentType: 'application/acad' }),
    )
  })

  it('22. a content type with NO matching object name is denied', async () => {
    // original.pdf carrying image/png — the name would lie about the bytes.
    await assertFails(
      storageOf(USERS.admin).ref(drawingPath({ revisionId: 'r_mix' }))
        .put(SMALL, { contentType: 'image/png' }),
    )
  })

  it('23. an object named anything but original.{ext} is denied', async () => {
    for (const name of ['A-101.pdf', 'original', 'original.PDF', 'original.pdf.pdf', 'ORIGINAL.pdf']) {
      await assertFails(
        storageOf(USERS.admin).ref(drawingPath({ revisionId: 'r_name', name })).put(SMALL, { contentType: PDF }),
      )
    }
  })

  it('24. an upload OVER THE 50 MB CEILING is denied, and one at the ceiling succeeds', async () => {
    await assertFails(
      storageOf(USERS.admin).ref(drawingPath({ revisionId: 'r_big' }))
        .put(bytes(52428801), { contentType: PDF }),
    )
    await assertSucceeds(
      storageOf(USERS.admin).ref(drawingPath({ revisionId: 'r_max' }))
        .put(bytes(52428800), { contentType: PDF }),
    )
  }, 180_000)
})

// ── DOCUMENT OBJECTS — WRITE ─────────────────────────────────────────────────

describe('DOCUMENT FILES — write', () => {
  it('25. company_admin, project_manager AND qs upload a document', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(upload(user, documentPath({ documentId: `d_${user.uid}` })))
    }
  })

  it('26. subcontractor and client cannot upload a document', async () => {
    for (const user of [USERS.sub, USERS.client]) {
      await assertFails(upload(user, documentPath({ documentId: `d_${user.uid}` })))
    }
  })

  it('27. super_admin cannot upload a document', async () => {
    await assertFails(upload(USERS.sup, documentPath({ documentId: 'd_sup' })))
  })

  it('28. ANOTHER COMPANY cannot upload into Company A', async () => {
    await assertFails(upload(USERS.other, documentPath({ documentId: 'd_other' })))
  })

  it('29. an upload OVER THE 25 MB CEILING is denied, and one at the ceiling succeeds', async () => {
    await assertFails(
      storageOf(USERS.qs).ref(documentPath({ documentId: 'd_big' }))
        .put(bytes(26214401), { contentType: PDF }),
    )
    await assertSucceeds(
      storageOf(USERS.qs).ref(documentPath({ documentId: 'd_max' }))
        .put(bytes(26214400), { contentType: PDF }),
    )
  }, 180_000)

  it('30. a zero-byte document upload is denied', async () => {
    await assertFails(
      storageOf(USERS.qs).ref(documentPath({ documentId: 'd_zero' })).put(bytes(0), { contentType: PDF }),
    )
  })

  it('31. a wrong object name or unsupported type is denied', async () => {
    await assertFails(
      storageOf(USERS.qs).ref(documentPath({ documentId: 'd1', name: 'Spec.pdf' })).put(SMALL, { contentType: PDF }),
    )
    await assertFails(
      storageOf(USERS.qs).ref(documentPath({ documentId: 'd2', name: 'original.docx' }))
        .put(SMALL, { contentType: 'application/msword' }),
    )
  })

  it('32. overwrite, metadata update and delete are all denied', async () => {
    await seedObject(documentPath({ documentId: 'd1' }))
    await assertFails(upload(USERS.qs, documentPath({ documentId: 'd1' })))
    await assertFails(storageOf(USERS.qs).ref(documentPath({ documentId: 'd1' }))
      .updateMetadata({ customMetadata: { tampered: 'true' } }))
    await assertFails(storageOf(USERS.qs).ref(documentPath({ documentId: 'd1' })).delete())
    await assertFails(storageOf(USERS.admin).ref(documentPath({ documentId: 'd1' })).delete())
  })
})

// ── DOCUMENT OBJECTS — READ (visibility via Firestore) ───────────────────────

describe('DOCUMENT FILES — read is gated on Firestore visibility', () => {
  it('33. a PROJECT document is readable by every member once its metadata exists', async () => {
    await seedObject(documentPath({ documentId: 'pub' }))
    await seedDocumentMetadata('pub', 'project')
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client, USERS.sup]) {
      await assertSucceeds(read(user, documentPath({ documentId: 'pub' })))
    }
  })

  it('34. an INTERNAL document is readable by internal roles', async () => {
    await seedObject(documentPath({ documentId: 'sec' }))
    await seedDocumentMetadata('sec', 'internal')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(read(user, documentPath({ documentId: 'sec' })))
    }
  })

  it('35. an INTERNAL document is DENIED to subcontractor, client and super_admin', async () => {
    await seedObject(documentPath({ documentId: 'sec' }))
    await seedDocumentMetadata('sec', 'internal')
    for (const user of [USERS.sub, USERS.client, USERS.sup]) {
      await assertFails(read(user, documentPath({ documentId: 'sec' })))
    }
  })

  it('36. THE PRE-METADATA WINDOW FAILS CLOSED — no metadata means no read for non-internal roles', async () => {
    // Storage first, Firestore second: between the two writes the object exists
    // with no visibility to check. It must be unreadable, not readable.
    await seedObject(documentPath({ documentId: 'inflight' }))
    for (const user of [USERS.sub, USERS.client, USERS.sup]) {
      await assertFails(read(user, documentPath({ documentId: 'inflight' })))
    }
  })

  it('37. an internal role CAN read during that window — they are the uploader', async () => {
    await seedObject(documentPath({ documentId: 'inflight' }))
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(read(user, documentPath({ documentId: 'inflight' })))
    }
  })

  it('38. flipping visibility to internal removes access at the next read', async () => {
    await seedObject(documentPath({ documentId: 'flip' }))
    await seedDocumentMetadata('flip', 'project')
    await assertSucceeds(read(USERS.sub, documentPath({ documentId: 'flip' })))
    await seedDocumentMetadata('flip', 'internal')
    await assertFails(read(USERS.sub, documentPath({ documentId: 'flip' })))
  })

  it('39. ANOTHER COMPANY cannot read a project document even with metadata present', async () => {
    await seedObject(documentPath({ documentId: 'pub' }))
    await seedDocumentMetadata('pub', 'project')
    await assertFails(read(USERS.other, documentPath({ documentId: 'pub' })))
  })

  it('40. an unauthenticated caller cannot read a project document', async () => {
    await seedObject(documentPath({ documentId: 'pub' }))
    await seedDocumentMetadata('pub', 'project')
    await assertFails(
      testEnv.unauthenticatedContext().storage().ref(documentPath({ documentId: 'pub' })).getDownloadURL(),
    )
  })

  it('41. metadata in ANOTHER COMPANY does not unlock this company path', async () => {
    // The rule resolves the metadata document from the OBJECT's own path
    // segments, so a permissive document elsewhere cannot be borrowed.
    await seedObject(documentPath({ documentId: 'lonely' }))
    await seedDocumentMetadata('lonely', 'project', COMPANY_B)
    await assertFails(read(USERS.sub, documentPath({ documentId: 'lonely' })))
  })
})

// ── EVERYTHING ELSE ──────────────────────────────────────────────────────────

describe('CATCH-ALL — every other bucket path is denied', () => {
  it('42. an arbitrary root path is denied to read and write', async () => {
    await seedObject('random/file.pdf')
    await assertFails(read(USERS.admin, 'random/file.pdf'))
    await assertFails(upload(USERS.admin, 'random/other.pdf'))
  })

  it('43. a path that is company-shaped but not an approved collection is denied', async () => {
    const photos = `companies/${COMPANY_A}/projects/${PROJECT_A}/photos/p1/original.pdf`
    await seedObject(photos)
    await assertFails(read(USERS.admin, photos))
    await assertFails(upload(USERS.admin, `companies/${COMPANY_A}/projects/${PROJECT_A}/photos/p2/original.pdf`))
  })

  it('44. a drawing object nested one folder TOO DEEP is denied', async () => {
    const deep = `${drawingPath({ revisionId: 'r1', name: 'sub' })}/original.pdf`
    await assertFails(upload(USERS.admin, deep))
  })

  it('45. a drawing object one folder TOO SHALLOW (no revision folder) is denied', async () => {
    const shallow = `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings/${DRAWING_A}/original.pdf`
    await assertFails(upload(USERS.admin, shallow))
  })

  it('46. the company root is not writable', async () => {
    await assertFails(upload(USERS.admin, `companies/${COMPANY_A}/original.pdf`))
  })
})
