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
  doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore'

// ── Drawing Security Rules — emulator tests ──────────────────────────────────
//
// Verifies the RULES, not the UI: every write below is a direct SDK call,
// exactly what a client bypassing the app would issue.
//
// The two facts this suite exists to prove are:
//   1. drawing READS are open to EVERY provisioned company member (including
//      subcontractor and client) while WRITES are company_admin/project_manager
//      only — the first collection in the app with that shape; and
//   2. a revision's file identity is genuinely IMMUTABLE, and its `storagePath`
//      must equal the exact path derived from the company/project/drawing/
//      revision IDs, so a revision can never point at someone else's bytes.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const DRAWING_A = 'drawingA'

// One user per role in Company A, plus a company_admin in Company B for tenant
// isolation. super_admin is included because it exists in the app's role labels
// and must be treated as an ordinary member here — it has no special power.
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

const drawingsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/drawings`
const revisionsPath = (drawingId = DRAWING_A, companyId = COMPANY_A, projectId = PROJECT_A) =>
  `${drawingsPath(companyId, projectId)}/${drawingId}/revisions`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const dwgRef = (db, id = DRAWING_A, companyId = COMPANY_A) => doc(db, drawingsPath(companyId), id)
const revRef = (db, id, drawingId = DRAWING_A, companyId = COMPANY_A) =>
  doc(db, revisionsPath(drawingId, companyId), id)

// The exact storage path rules recompute from the path segments. Mirrors
// lib/files.js → drawingStoragePath.
const storagePathFor = (revisionId, ext = 'pdf', drawingId = DRAWING_A, companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/drawings/${drawingId}/${revisionId}/original.${ext}`

// A drawing master exactly as hooks/useDrawings.jsx creates it — BORN EMPTY.
function masterPayload(user, overrides = {}) {
  return {
    drawingNumber: 'A-101',
    title:         'Ground Floor Plan',
    discipline:    'architectural',
    description:   '',

    status: 'active',

    currentRevisionId:         null,
    currentRevisionCode:       '',
    currentRevisionIssuedDate: null,
    revisionCount:             0,

    revisionSchemaVersion: 1,

    withdrawnAt:    null,
    withdrawnBy:    null,
    withdrawReason: '',

    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

// A revision exactly as hooks/useDrawingRevisions.jsx creates it.
function revisionPayload(user, revisionId, overrides = {}) {
  return {
    revisionCode:     'A',
    revisionSequence: 1,
    revisionDate:     '2026-08-11',

    status: 'current',
    notes:  '',

    fileName:    'A-101 Rev A.pdf',
    fileExt:     'pdf',
    fileSize:    204800,
    contentType: 'application/pdf',
    storagePath: storagePathFor(revisionId),

    pageCount: null,
    sheetSize: '',

    supersededAt:           null,
    supersededBy:           null,
    supersededByRevisionId: null,
    withdrawnAt:            null,
    withdrawnBy:            null,
    withdrawReason:         '',

    revision: 1,

    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

// Seeds directly, bypassing rules — the arrange step for update tests.
async function seedMaster(overrides = {}, id = DRAWING_A, companyId = COMPANY_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(doc(db, drawingsPath(companyId), id), {
      ...masterPayload(USERS.admin),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...overrides,
    })
  })
}

async function seedRevision(revisionId, overrides = {}, drawingId = DRAWING_A, companyId = COMPANY_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(doc(db, revisionsPath(drawingId, companyId), revisionId), {
      ...revisionPayload(USERS.admin, revisionId),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...overrides,
    })
  })
}

const stamps = (user, extra = {}) => ({
  updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})

// The four master write shapes the app performs.
const promoteWrite = (user, revisionId, count, extra = {}) => ({
  currentRevisionId:         revisionId,
  currentRevisionCode:       'A',
  currentRevisionIssuedDate: '2026-08-11',
  revisionCount:             count,
  ...stamps(user),
  ...extra,
})
const reinstateWrite = (user, revisionId, extra = {}) => ({
  currentRevisionId:         revisionId,
  currentRevisionCode:       'A',
  currentRevisionIssuedDate: '2026-08-01',
  ...stamps(user),
  ...extra,
})
const withdrawMasterWrite = (user, reason = 'Superseded by a new package', extra = {}) => ({
  status: 'withdrawn',
  currentRevisionId:         null,
  currentRevisionCode:       '',
  currentRevisionIssuedDate: null,
  withdrawnAt:    serverTimestamp(),
  withdrawnBy:    user.uid,
  withdrawReason: reason,
  ...stamps(user),
  ...extra,
})

// The three revision write shapes.
const supersedeWrite = (user, byRevisionId, extra = {}) => ({
  status: 'superseded',
  supersededAt:           serverTimestamp(),
  supersededBy:           user.uid,
  supersededByRevisionId: byRevisionId,
  ...stamps(user),
  ...extra,
})
const reinstateRevisionWrite = (user, extra = {}) => ({
  status: 'current',
  supersededAt:           null,
  supersededBy:           null,
  supersededByRevisionId: null,
  ...stamps(user),
  ...extra,
})
const withdrawRevisionWrite = (user, reason = 'Issued in error', extra = {}) => ({
  status: 'withdrawn',
  withdrawnAt:    serverTimestamp(),
  withdrawnBy:    user.uid,
  withdrawReason: reason,
  ...stamps(user),
  ...extra,
})

// Client-supplied clocks that must never satisfy `== request.time`. Deliberately
// skewed rather than `Timestamp.now()`, which can coincide with server time and
// turn the assertion into a coin flip (see clientReceipts.rules.test.js).
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

describe('READS — every provisioned company member', () => {
  beforeEach(async () => {
    await seedMaster()
    await seedRevision('rev1')
  })

  it('1. all six Company A roles read a drawing master', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client, USERS.sup]) {
      await assertSucceeds(getDoc(dwgRef(ctx(user))))
    }
  })

  it('2. all six Company A roles read a revision', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client, USERS.sup]) {
      await assertSucceeds(getDoc(revRef(ctx(user), 'rev1')))
    }
  })

  it('3. a subcontractor — who can read NO financial collection — reads drawings', async () => {
    await assertSucceeds(getDoc(dwgRef(ctx(USERS.sub))))
  })

  it('4. another company cannot read the master', async () => {
    await assertFails(getDoc(dwgRef(ctx(USERS.other))))
  })

  it('5. another company cannot read a revision', async () => {
    await assertFails(getDoc(revRef(ctx(USERS.other), 'rev1')))
  })

  it('6. an unauthenticated caller cannot read', async () => {
    const anon = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(dwgRef(anon)))
    await assertFails(getDoc(revRef(anon, 'rev1')))
  })

  it('7. a signed-in user with NO membership document cannot read', async () => {
    const stranger = testEnv.authenticatedContext('u_nobody').firestore()
    await assertFails(getDoc(dwgRef(stranger)))
  })
})

// ── MASTER CREATE ────────────────────────────────────────────────────────────

describe('MASTER CREATE — writer matrix and born-empty shape', () => {
  it('8. company_admin and project_manager create a drawing', async () => {
    for (const user of [USERS.admin, USERS.pm]) {
      await assertSucceeds(setDoc(dwgRef(ctx(user), `d_${user.uid}`), masterPayload(user)))
    }
  })

  it('9. QS CANNOT create a drawing in this branch', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.qs), 'd_qs'), masterPayload(USERS.qs)))
  })

  it('10. subcontractor, client and super_admin cannot create a drawing', async () => {
    for (const user of [USERS.sub, USERS.client, USERS.sup]) {
      await assertFails(setDoc(dwgRef(ctx(user), `d_${user.uid}`), masterPayload(user)))
    }
  })

  it('11. another company cannot create a drawing in this project', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.other), 'd_x'), masterPayload(USERS.other)))
  })

  it('12. a master cannot be born already pointing at a revision', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd1'),
      masterPayload(USERS.admin, { currentRevisionId: 'rev1' })))
  })

  it('13. a master cannot be born with a revision count', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd1'),
      masterPayload(USERS.admin, { revisionCount: 1 })))
  })

  it('14. a master cannot be born with a mirrored revision code or issue date', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd1'),
      masterPayload(USERS.admin, { currentRevisionCode: 'A' })))
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd2'),
      masterPayload(USERS.admin, { currentRevisionIssuedDate: '2026-08-11' })))
  })

  it('15. a master cannot be born withdrawn or with forged withdrawal stamps', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd1'),
      masterPayload(USERS.admin, { status: 'withdrawn' })))
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd2'),
      masterPayload(USERS.admin, { withdrawnBy: USERS.admin.uid })))
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd3'),
      masterPayload(USERS.admin, { withdrawReason: 'pre-withdrawn' })))
  })

  it('16. a blank or whitespace drawing number and title are rejected', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd1'), masterPayload(USERS.admin, { drawingNumber: '   ' })))
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd2'), masterPayload(USERS.admin, { title: '  ' })))
  })

  it('17. an unknown discipline is rejected', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd1'), masterPayload(USERS.admin, { discipline: 'plumbing' })))
  })

  it('18. createdBy must be the caller and createdAt must be server time', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd1'),
      masterPayload(USERS.admin, { createdBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd2'),
        masterPayload(USERS.admin, { createdAt: clock() })))
    }
  })

  it('19. updatedBy must be the caller', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd1'),
      masterPayload(USERS.admin, { updatedBy: USERS.pm.uid })))
  })

  it('20. the revision schema version must be 1', async () => {
    await assertFails(setDoc(dwgRef(ctx(USERS.admin), 'd1'),
      masterPayload(USERS.admin, { revisionSchemaVersion: 2 })))
  })
})

// ── MASTER UPDATE ────────────────────────────────────────────────────────────

describe('MASTER UPDATE — identity edit', () => {
  beforeEach(async () => { await seedMaster() })

  it('21. a writer edits number, title, discipline and description', async () => {
    await assertSucceeds(updateDoc(dwgRef(ctx(USERS.pm)), {
      drawingNumber: 'A-102', title: 'Level 1 Plan', discipline: 'structural',
      description: 'Re-issued', ...stamps(USERS.pm),
    }))
  })

  it('22. QS, subcontractor and client cannot edit identity', async () => {
    for (const user of [USERS.qs, USERS.sub, USERS.client]) {
      await assertFails(updateDoc(dwgRef(ctx(user)), { title: 'Hacked', ...stamps(user) }))
    }
  })

  it('23. an identity edit cannot smuggle a revision-count change', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), {
      title: 'Level 1 Plan', revisionCount: 5, ...stamps(USERS.admin),
    }))
  })

  it('24. an identity edit cannot smuggle a pointer change', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), {
      title: 'Level 1 Plan', currentRevisionId: 'rev9', ...stamps(USERS.admin),
    }))
  })

  it('25. createdAt/createdBy/revisionSchemaVersion can never be rewritten', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), { createdBy: USERS.pm.uid, ...stamps(USERS.admin) }))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), { createdAt: CLIENT_CLOCKS[0](), ...stamps(USERS.admin) }))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), { revisionSchemaVersion: 2, ...stamps(USERS.admin) }))
  })

  it('26. every update must stamp the caller and server time', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), { title: 'X', updatedBy: USERS.pm.uid, updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), { title: 'X', updatedBy: USERS.admin.uid, updatedAt: CLIENT_CLOCKS[2]() }))
  })
})

describe('MASTER UPDATE — promotion', () => {
  beforeEach(async () => { await seedMaster() })

  it('27. promoting the first revision moves the count 0 -> 1', async () => {
    await assertSucceeds(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, 'rev1', 1)))
  })

  it('28. the revision count must move by EXACTLY +1', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, 'rev1', 2)))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, 'rev1', 0)))
  })

  it('29. promotion from an existing revision moves 3 -> 4', async () => {
    await seedMaster({ currentRevisionId: 'rev3', currentRevisionCode: 'C', currentRevisionIssuedDate: '2026-01-01', revisionCount: 3 })
    await assertSucceeds(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, 'rev4', 4)))
  })

  it('30. promotion cannot leave the pointer null or empty', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, null, 1)))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, '', 1)))
  })

  it('31. promotion requires a non-empty revision code and a YYYY-MM-DD issue date', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, 'rev1', 1, { currentRevisionCode: '' })))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, 'rev1', 1, { currentRevisionIssuedDate: '11/08/2026' })))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, 'rev1', 1, { currentRevisionIssuedDate: null })))
  })

  it('32. promotion cannot also rewrite identity', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)),
      promoteWrite(USERS.admin, 'rev1', 1, { title: 'Sneaky' })))
  })

  it('33. QS and subcontractor cannot promote', async () => {
    for (const user of [USERS.qs, USERS.sub]) {
      await assertFails(updateDoc(dwgRef(ctx(user)), promoteWrite(user, 'rev1', 1)))
    }
  })
})

describe('MASTER UPDATE — reinstatement', () => {
  beforeEach(async () => {
    await seedMaster({
      currentRevisionId: 'rev2', currentRevisionCode: 'B',
      currentRevisionIssuedDate: '2026-02-01', revisionCount: 2,
    })
  })

  it('34. the pointer moves back to an earlier revision without touching the count', async () => {
    await assertSucceeds(updateDoc(dwgRef(ctx(USERS.admin)), reinstateWrite(USERS.admin, 'rev1')))
  })

  it('35. reinstatement must actually MOVE the pointer', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), reinstateWrite(USERS.admin, 'rev2')))
  })

  it('36. reinstatement requires a current revision to move away from', async () => {
    // An EMPTY master cannot have its pointer set without the matching count
    // increment — that would break the high-water-mark invariant that
    // revisionSequence is derived from.
    await seedMaster()
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), reinstateWrite(USERS.admin, 'rev1')))
  })

  it('37. reinstatement cannot null the pointer', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), reinstateWrite(USERS.admin, null)))
  })
})

describe('MASTER UPDATE — withdrawal', () => {
  beforeEach(async () => { await seedMaster() })

  it('38. a writer withdraws a drawing with a reason, clearing the pointer', async () => {
    await assertSucceeds(updateDoc(dwgRef(ctx(USERS.admin)), withdrawMasterWrite(USERS.admin)))
  })

  it('39. an empty or whitespace-only reason is rejected', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), withdrawMasterWrite(USERS.admin, '')))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), withdrawMasterWrite(USERS.admin, '   ')))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), withdrawMasterWrite(USERS.admin, '\n\t ')))
  })

  it('40. withdrawal must clear the pointer and the mirrored fields', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)),
      withdrawMasterWrite(USERS.admin, 'Recalled', { currentRevisionId: 'rev1' })))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)),
      withdrawMasterWrite(USERS.admin, 'Recalled', { currentRevisionCode: 'A' })))
  })

  it('41. the withdrawal stamps must be the caller and server time', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)),
      withdrawMasterWrite(USERS.admin, 'Recalled', { withdrawnBy: USERS.pm.uid })))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)),
      withdrawMasterWrite(USERS.admin, 'Recalled', { withdrawnAt: CLIENT_CLOCKS[0]() })))
  })

  it('42. withdrawal is TERMINAL — a withdrawn drawing accepts no further update', async () => {
    await seedMaster({ status: 'withdrawn', withdrawReason: 'Recalled', withdrawnBy: USERS.admin.uid, withdrawnAt: Timestamp.now() })
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), { title: 'Back again', ...stamps(USERS.admin) }))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), { status: 'active', ...stamps(USERS.admin) }))
    await assertFails(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, 'rev1', 1)))
  })

  it('43. QS cannot withdraw a drawing', async () => {
    await assertFails(updateDoc(dwgRef(ctx(USERS.qs)), withdrawMasterWrite(USERS.qs)))
  })
})

// ── REVISION CREATE ──────────────────────────────────────────────────────────

describe('REVISION CREATE — shape, file identity and exact storage path', () => {
  beforeEach(async () => { await seedMaster() })

  it('44. company_admin and project_manager create a revision', async () => {
    for (const user of [USERS.admin, USERS.pm]) {
      const id = `rev_${user.uid}`
      await assertSucceeds(setDoc(revRef(ctx(user), id), revisionPayload(user, id)))
    }
  })

  it('45. QS, subcontractor and client cannot create a revision', async () => {
    for (const user of [USERS.qs, USERS.sub, USERS.client]) {
      const id = `rev_${user.uid}`
      await assertFails(setDoc(revRef(ctx(user), id), revisionPayload(user, id)))
    }
  })

  it('46. another company cannot create a revision here', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.other), 'rev1'), revisionPayload(USERS.other, 'rev1')))
  })

  it('47. a revision must be born CURRENT', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { status: 'superseded' })))
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev2'),
      revisionPayload(USERS.admin, 'rev2', { status: 'withdrawn' })))
  })

  it('48. the storage path must be EXACTLY the derived path for this revision', async () => {
    // Another revision's folder.
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { storagePath: storagePathFor('rev2') })))
    // Another drawing's folder.
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { storagePath: storagePathFor('rev1', 'pdf', 'otherDrawing') })))
    // ANOTHER TENANT's bucket path.
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { storagePath: storagePathFor('rev1', 'pdf', DRAWING_A, COMPANY_B) })))
  })

  it('49. the object filename in the path must be original.{ext}', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'), revisionPayload(USERS.admin, 'rev1', {
      storagePath: `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings/${DRAWING_A}/rev1/A-101.pdf`,
    })))
  })

  it('50. contentType and fileExt must agree', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'), revisionPayload(USERS.admin, 'rev1', {
      contentType: 'image/png', // path and fileExt still say pdf
    })))
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev2'), revisionPayload(USERS.admin, 'rev2', {
      fileExt: 'png', contentType: 'application/pdf', storagePath: storagePathFor('rev2', 'png'),
    })))
  })

  it('51. PNG and JPEG revisions are accepted with matching paths', async () => {
    await assertSucceeds(setDoc(revRef(ctx(USERS.admin), 'revPng'), revisionPayload(USERS.admin, 'revPng', {
      fileExt: 'png', contentType: 'image/png', storagePath: storagePathFor('revPng', 'png'),
    })))
    await assertSucceeds(setDoc(revRef(ctx(USERS.admin), 'revJpg'), revisionPayload(USERS.admin, 'revJpg', {
      fileExt: 'jpg', contentType: 'image/jpeg', storagePath: storagePathFor('revJpg', 'jpg'),
    })))
  })

  it('52. an unsupported content type is rejected', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'), revisionPayload(USERS.admin, 'rev1', {
      fileExt: 'dwg', contentType: 'application/acad', storagePath: storagePathFor('rev1', 'dwg'),
    })))
  })

  it('53. a zero-byte revision is rejected', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { fileSize: 0 })))
  })

  it('54. a revision over the 50 MB ceiling is rejected, and exactly 50 MB is accepted', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { fileSize: 52428801 })))
    await assertSucceeds(setDoc(revRef(ctx(USERS.admin), 'rev2'),
      revisionPayload(USERS.admin, 'rev2', { fileSize: 52428800 })))
  })

  it('55. revisionSequence must be a positive integer', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { revisionSequence: 0 })))
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev2'),
      revisionPayload(USERS.admin, 'rev2', { revisionSequence: -1 })))
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev3'),
      revisionPayload(USERS.admin, 'rev3', { revisionSequence: '1' })))
  })

  it('56. a blank revision code and a malformed revision date are rejected', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { revisionCode: '   ' })))
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev2'),
      revisionPayload(USERS.admin, 'rev2', { revisionDate: '11/08/2026' })))
  })

  it('57. pageCount must be null and sheetSize must be empty — reserved, never fabricated', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { pageCount: 4 })))
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev2'),
      revisionPayload(USERS.admin, 'rev2', { sheetSize: 'A1' })))
  })

  it('58. lifecycle stamps cannot be forged at creation', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { supersededBy: USERS.admin.uid })))
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev2'),
      revisionPayload(USERS.admin, 'rev2', { withdrawReason: 'already gone' })))
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev3'),
      revisionPayload(USERS.admin, 'rev3', { supersededByRevisionId: 'rev9' })))
  })

  it('59. createdBy must be the caller and createdAt must be server time', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { createdBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev2'),
        revisionPayload(USERS.admin, 'rev2', { createdAt: clock() })))
    }
  })

  it('60. revision must be 1', async () => {
    await assertFails(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { revision: 2 })))
  })
})

// ── REVISION IMMUTABILITY & LIFECYCLE ────────────────────────────────────────

describe('REVISION UPDATE — file identity is immutable', () => {
  beforeEach(async () => {
    await seedMaster()
    await seedRevision('rev1')
  })

  it('61. the storage path can never be rewritten', async () => {
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'),
      { storagePath: storagePathFor('rev2'), ...stamps(USERS.admin) }))
  })

  it('62. the file name, size, extension and content type can never be rewritten', async () => {
    for (const patch of [
      { fileName: 'other.pdf' }, { fileSize: 1 }, { fileExt: 'png' }, { contentType: 'image/png' },
    ]) {
      await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), { ...patch, ...stamps(USERS.admin) }))
    }
  })

  it('63. the authored identity (code, sequence, date, notes) can never be rewritten', async () => {
    for (const patch of [
      { revisionCode: 'Z' }, { revisionSequence: 9 }, { revisionDate: '2026-12-25' }, { notes: 'changed' },
    ]) {
      await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), { ...patch, ...stamps(USERS.admin) }))
    }
  })

  it('64. the reserved takeoff fields cannot be populated by an update either', async () => {
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), { pageCount: 4, ...stamps(USERS.admin) }))
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), { sheetSize: 'A1', ...stamps(USERS.admin) }))
  })
})

describe('REVISION UPDATE — lifecycle', () => {
  beforeEach(async () => {
    await seedMaster()
    await seedRevision('rev1')
  })

  it('65. current -> superseded, naming the revision that replaced it', async () => {
    await assertSucceeds(updateDoc(revRef(ctx(USERS.admin), 'rev1'), supersedeWrite(USERS.admin, 'rev2')))
  })

  it('66. supersession cannot name the revision itself', async () => {
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), supersedeWrite(USERS.admin, 'rev1')))
  })

  it('67. supersession requires a non-empty successor and the caller/server stamps', async () => {
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), supersedeWrite(USERS.admin, '')))
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), supersedeWrite(USERS.admin, null)))
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'),
      supersedeWrite(USERS.admin, 'rev2', { supersededBy: USERS.pm.uid })))
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'),
      supersedeWrite(USERS.admin, 'rev2', { supersededAt: CLIENT_CLOCKS[1]() })))
  })

  it('68. superseded -> current reinstatement clears the supersession stamps', async () => {
    await seedRevision('rev1', {
      status: 'superseded', supersededAt: Timestamp.now(),
      supersededBy: USERS.admin.uid, supersededByRevisionId: 'rev2',
    })
    await assertSucceeds(updateDoc(revRef(ctx(USERS.admin), 'rev1'), reinstateRevisionWrite(USERS.admin)))
  })

  it('69. reinstatement cannot leave a stale supersession stamp behind', async () => {
    await seedRevision('rev1', {
      status: 'superseded', supersededAt: Timestamp.now(),
      supersededBy: USERS.admin.uid, supersededByRevisionId: 'rev2',
    })
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'),
      reinstateRevisionWrite(USERS.admin, { supersededByRevisionId: 'rev2' })))
  })

  it('70. current -> withdrawn with a reason', async () => {
    await assertSucceeds(updateDoc(revRef(ctx(USERS.admin), 'rev1'), withdrawRevisionWrite(USERS.admin)))
  })

  it('71. superseded -> withdrawn with a reason', async () => {
    await seedRevision('rev1', { status: 'superseded', supersededByRevisionId: 'rev2' })
    await assertSucceeds(updateDoc(revRef(ctx(USERS.admin), 'rev1'), withdrawRevisionWrite(USERS.admin)))
  })

  it('72. a whitespace-only withdrawal reason is rejected', async () => {
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), withdrawRevisionWrite(USERS.admin, '  ')))
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), withdrawRevisionWrite(USERS.admin, '')))
  })

  it('73. withdrawal stamps must be the caller and server time', async () => {
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'),
      withdrawRevisionWrite(USERS.admin, 'Error', { withdrawnBy: USERS.pm.uid })))
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'),
      withdrawRevisionWrite(USERS.admin, 'Error', { withdrawnAt: CLIENT_CLOCKS[0]() })))
  })

  it('74. WITHDRAWN IS TERMINAL — a withdrawn revision can never come back', async () => {
    await seedRevision('rev1', {
      status: 'withdrawn', withdrawReason: 'Issued in error',
      withdrawnBy: USERS.admin.uid, withdrawnAt: Timestamp.now(),
    })
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), reinstateRevisionWrite(USERS.admin)))
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), supersedeWrite(USERS.admin, 'rev2')))
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'), withdrawRevisionWrite(USERS.admin)))
  })

  it('75. QS, subcontractor and client cannot move a revision lifecycle', async () => {
    for (const user of [USERS.qs, USERS.sub, USERS.client]) {
      await assertFails(updateDoc(revRef(ctx(user), 'rev1'), withdrawRevisionWrite(user)))
      await assertFails(updateDoc(revRef(ctx(user), 'rev1'), supersedeWrite(user, 'rev2')))
    }
  })

  it('76. a status change cannot be smuggled alongside a file-identity change', async () => {
    await assertFails(updateDoc(revRef(ctx(USERS.admin), 'rev1'),
      withdrawRevisionWrite(USERS.admin, 'Error', { fileSize: 1 })))
  })
})

// ── DELETE ───────────────────────────────────────────────────────────────────

describe('DELETE — blocked for everyone', () => {
  beforeEach(async () => {
    await seedMaster()
    await seedRevision('rev1')
  })

  it('77. no role can delete a drawing master', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client, USERS.sup]) {
      await assertFails(deleteDoc(dwgRef(ctx(user))))
    }
  })

  it('78. no role can delete a revision — issued revisions are permanent', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client]) {
      await assertFails(deleteDoc(revRef(ctx(user), 'rev1')))
    }
  })
})

// ── DOCUMENTED GAPS ──────────────────────────────────────────────────────────
//
// These tests assert what the rules CANNOT do. They exist so the limitation is
// visible and version-controlled rather than assumed away — if a future change
// closes one of these, the test fails loudly and the claim can be updated.

describe('DOCUMENTED GAPS — enforced by the client only', () => {
  beforeEach(async () => { await seedMaster() })

  it('79. drawingNumber uniqueness is NOT enforced — rules cannot query siblings', async () => {
    await assertSucceeds(setDoc(dwgRef(ctx(USERS.admin), 'dupe'),
      masterPayload(USERS.admin, { drawingNumber: 'A-101' })))
  })

  it('80. a SECOND current revision can be forged — rules cannot see sibling documents', async () => {
    await seedRevision('rev1')
    await assertSucceeds(setDoc(revRef(ctx(USERS.admin), 'rev2'),
      revisionPayload(USERS.admin, 'rev2', { revisionSequence: 2, revisionCode: 'B' })))
    // Both now claim status 'current'. The promotion TRANSACTION is what keeps
    // this from happening through the app; rules cannot.
    const a = await getDoc(revRef(ctx(USERS.admin), 'rev1'))
    const b = await getDoc(revRef(ctx(USERS.admin), 'rev2'))
    expect(a.data().status).toBe('current')
    expect(b.data().status).toBe('current')
  })

  it('81. duplicate revision codes within one drawing are NOT enforced', async () => {
    await seedRevision('rev1')
    await assertSucceeds(setDoc(revRef(ctx(USERS.admin), 'rev2'),
      revisionPayload(USERS.admin, 'rev2', { revisionSequence: 2, revisionCode: 'A' })))
  })

  it('82. currentRevisionId is NOT checked for existence — it is created in the same transaction', async () => {
    await assertSucceeds(updateDoc(dwgRef(ctx(USERS.admin)), promoteWrite(USERS.admin, 'neverExisted', 1)))
  })

  it('83. the mirrored revision code is NOT checked against the revision document', async () => {
    await seedRevision('rev1', { revisionCode: 'A' })
    await assertSucceeds(updateDoc(dwgRef(ctx(USERS.admin)),
      promoteWrite(USERS.admin, 'rev1', 1, { currentRevisionCode: 'ZZZ' })))
  })

  it('84. fileSize is metadata — rules cannot know what bytes are actually in Storage', async () => {
    // A 1-byte object described as 40 MB is accepted: rules see the number the
    // client wrote, never the object.
    await assertSucceeds(setDoc(revRef(ctx(USERS.admin), 'rev1'),
      revisionPayload(USERS.admin, 'rev1', { fileSize: 41943040 })))
  })

  it('86. a reinstatement that ALSO increments the count is accepted as a promotion', async () => {
    // Promotion and reinstatement differ only in whether the target revision is
    // newly created — which rules cannot see. A writer can therefore point the
    // master back at an OLD revision while bumping the count, and the rules read
    // it as an ordinary promotion. The transaction in
    // hooks/useDrawingRevisions.jsx is what keeps the two apart in the app.
    await seedMaster({
      currentRevisionId: 'rev2', currentRevisionCode: 'B',
      currentRevisionIssuedDate: '2026-02-01', revisionCount: 2,
    })
    await assertSucceeds(updateDoc(dwgRef(ctx(USERS.admin)),
      reinstateWrite(USERS.admin, 'rev1', { revisionCount: 3 })))
  })

  it('85. membership is COMPANY-WIDE — a member reads drawings on every project', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const db = c.firestore()
      await setDoc(doc(db, `companies/${COMPANY_A}/projects`, 'otherProject'), { name: 'Other' })
      await setDoc(doc(db, `companies/${COMPANY_A}/projects/otherProject/drawings`, 'd9'), {
        ...masterPayload(USERS.admin), createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
      })
    })
    // The subcontractor was never assigned to this project — and still reads it.
    await assertSucceeds(getDoc(doc(ctx(USERS.sub), 'companies', COMPANY_A, 'projects', 'otherProject', 'drawings', 'd9')))
  })
})
