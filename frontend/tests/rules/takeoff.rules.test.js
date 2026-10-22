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
  doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, runTransaction,
} from 'firebase/firestore'
import {
  runEnsurePage, runSaveCalibration, runCreateMeasurement, runUpdateMeasurement, runVoidMeasurement, QuantError,
} from '../../src/lib/quantActions'
import { QUANT_ERROR } from '../../src/lib/quant'

// ── Constrapp Quant™ 1A Security Rules — emulator tests (ADR-51) ─────────────
//
// Verifies the RULES for the two takeoff collections, not the UI: every write
// below is a direct SDK call, exactly what a client bypassing the app would
// issue. The last section runs the REAL guarded transactions from
// lib/quantActions.js against the emulator, so the stale-revision refusals
// are proven end to end rather than only against an in-memory stand-in.
//
// What this block proves:
//   · reads AND writes: company_admin / project_manager / qs; everyone else
//     denied, cross-tenant denied, unauthenticated denied
//   · a page's id is recomputed from its stored (drawing, revision, page)
//   · the drawing and the revision must EXIST and the revision must not be
//     withdrawn — for pages and for measurements
//   · a measurement's page document and cost code must EXIST
//   · exact keys, kind vocabulary, bounded point lists, label/name bounds,
//     calibration shape or null by kind
//   · actor ids + server stamps, immutable identity and creation stamps,
//     `revision` exactly +1, active→void terminal with a reason, no delete
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (documented client-only
// gaps — docs/SECURITY.md → Deferred Control 32): point CONTENT, geometry on
// the page, page number within the PDF, pageDistance matching the points, the
// truth of the real distance, cost code ACTIVE, and blind +1 overwrites.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const DRAWING_A = 'drawingA'
const REV_CURRENT = 'revCurrent'
const REV_SUPERSEDED = 'revSuperseded'
const REV_WITHDRAWN = 'revWithdrawn'
const COST_CODE = 'cc03100'
const COST_CODE_INACTIVE = 'cc99'
const DRAWING_WITHDRAWN = 'drawingWithdrawn'   // a WITHDRAWN master with a (formerly) current revision
const REV_ON_WITHDRAWN_DRAWING = 'revOnWithdrawnDrawing'

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
const DENIED  = [USERS.sub, USERS.client, USERS.super]

let testEnv

const pagesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/takeoffPages`
const measurementsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/takeoffMeasurements`

const pageIdFor = (drawingId = DRAWING_A, revisionId = REV_CURRENT, page = 1) => `${drawingId}_${revisionId}_${page}`
const PAGE_ID = pageIdFor()

const ctx  = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const pageRef = (db, id = PAGE_ID, companyId = COMPANY_A) => doc(db, pagesPath(companyId), id)
const measRef = (db, id = 'm1', companyId = COMPANY_A) => doc(db, measurementsPath(companyId), id)

const CAL = { pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, pageDistance: 100, realDistance: 1, unit: 'm' }
const SNAP = { revision: 1, pageDistance: 100, realDistance: 1, unit: 'm' }

// A page exactly as lib/quantActions.js writes a FIRST CALIBRATION.
function pagePayload(user, overrides = {}) {
  return {
    drawingId: DRAWING_A, revisionId: REV_CURRENT, page: 1,
    source: 'pdf', pageWidth: 612, pageHeight: 792, pageRotation: 0,
    calibration: CAL, calibrationRevision: 1,
    calibratedAt: serverTimestamp(), calibratedBy: user.uid,
    revision: 1,
    createdAt: serverTimestamp(), createdBy: user.uid,
    updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}
// … and an UNCALIBRATED birth (runEnsurePage).
const uncalibratedPage = (user, overrides = {}) =>
  pagePayload(user, { calibration: null, calibrationRevision: 0, calibratedAt: null, calibratedBy: null, ...overrides })

// A measurement exactly as lib/quantActions.js writes it.
function measurementPayload(user, overrides = {}) {
  return {
    takeoffPageId: PAGE_ID, drawingId: DRAWING_A, revisionId: REV_CURRENT, page: 1,
    kind: 'length', points: [{ x: 0, y: 0 }, { x: 300, y: 400 }],
    label: 'Slab edge', costCodeId: COST_CODE, costCodeName: '03-100 — Concrete',
    calibration: SNAP,
    status: 'active', voidReason: '', voidedAt: null, voidedBy: null,
    revision: 1,
    createdAt: serverTimestamp(), createdBy: user.uid,
    updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}

const stamps = (user, revision, extra = {}) => ({ revision, updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra })
const recalibrate = (user, revision, calibrationRevision, extra = {}) => ({
  calibration: { ...CAL, realDistance: 2 }, calibrationRevision,
  calibratedAt: serverTimestamp(), calibratedBy: user.uid,
  ...stamps(user, revision), ...extra,
})
const voidWrite = (user, revision, reason = 'Measured the wrong room', extra = {}) => ({
  status: 'void', voidReason: reason, voidedAt: serverTimestamp(), voidedBy: user.uid,
  ...stamps(user, revision), ...extra,
})

const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

// Seeds bypass rules — the arrange step.
async function seed(fn) {
  await testEnv.withSecurityRulesDisabled(async (c) => fn(c.firestore()))
}
const seedPage = (overrides = {}, id = PAGE_ID, user = USERS.qs) => seed(async (db) => {
  await setDoc(doc(db, pagesPath(), id), {
    ...pagePayload(user), calibratedAt: Timestamp.now(), createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...overrides,
  })
})
const seedMeasurement = (overrides = {}, id = 'm1', user = USERS.qs) => seed(async (db) => {
  await setDoc(doc(db, measurementsPath(), id), {
    ...measurementPayload(user), createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...overrides,
  })
})

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
  await seed(async (db) => {
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project' })
    await setDoc(doc(db, `companies/${COMPANY_A}/costCodes`, COST_CODE), { code: '03-100', name: 'Concrete', unit: 'm3', isActive: true })
    await setDoc(doc(db, `companies/${COMPANY_A}/costCodes`, COST_CODE_INACTIVE), { code: '99', name: 'Retired', unit: '', isActive: false })
    // The drawing master and three revisions: current, superseded, withdrawn.
    await setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings`, DRAWING_A), {
      drawingNumber: 'A-101', title: 'Ground Floor Plan', discipline: 'architectural', description: '', status: 'active',
      currentRevisionId: REV_CURRENT, currentRevisionCode: 'B', currentRevisionIssuedDate: '2026-09-01', revisionCount: 3,
      revisionSchemaVersion: 1, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
      createdAt: Timestamp.now(), createdBy: USERS.pm.uid, updatedAt: Timestamp.now(), updatedBy: USERS.pm.uid,
    })
    const revBase = (id, seq, status, code) => ({
      revisionCode: code, revisionSequence: seq, revisionDate: '2026-09-01', status, notes: '',
      fileName: `${code}.pdf`, fileExt: 'pdf', fileSize: 1024, contentType: 'application/pdf',
      storagePath: `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings/${DRAWING_A}/${id}/original.pdf`,
      pageCount: null, sheetSize: '', supersededAt: null, supersededBy: null, supersededByRevisionId: null,
      withdrawnAt: null, withdrawnBy: null, withdrawReason: '', revision: 1,
      createdAt: Timestamp.now(), createdBy: USERS.pm.uid, updatedAt: Timestamp.now(), updatedBy: USERS.pm.uid,
    })
    const revs = `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings/${DRAWING_A}/revisions`
    await setDoc(doc(db, revs, REV_WITHDRAWN),  revBase(REV_WITHDRAWN, 1, 'withdrawn', 'P1'))
    await setDoc(doc(db, revs, REV_SUPERSEDED), revBase(REV_SUPERSEDED, 2, 'superseded', 'A'))
    await setDoc(doc(db, revs, REV_CURRENT),    revBase(REV_CURRENT, 3, 'current', 'B'))
    // A WITHDRAWN drawing master whose only revision is itself still 'current'
    // in status — the master's withdrawal alone must stop any takeoff write.
    await setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings`, DRAWING_WITHDRAWN), {
      drawingNumber: 'A-999', title: 'Recalled sheet', discipline: 'architectural', description: '', status: 'withdrawn',
      currentRevisionId: null, currentRevisionCode: '', currentRevisionIssuedDate: null, revisionCount: 1,
      revisionSchemaVersion: 1, withdrawnAt: Timestamp.now(), withdrawnBy: USERS.pm.uid, withdrawReason: 'Recalled',
      createdAt: Timestamp.now(), createdBy: USERS.pm.uid, updatedAt: Timestamp.now(), updatedBy: USERS.pm.uid,
    })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings/${DRAWING_WITHDRAWN}/revisions`, REV_ON_WITHDRAWN_DRAWING),
      revBase(REV_ON_WITHDRAWN_DRAWING, 1, 'current', 'A'))
  })
})

// ── Revision status: what each sheet state permits ───────────────────────────
//
// The exact contract (ADR-51, docs/SECURITY.md → Quant™ 1A):
//   · READ      — any sheet state (current, superseded, withdrawn revision,
//                 withdrawn drawing): the takeoff is history and stays inspectable
//   · CREATE    — current and superseded only; never a withdrawn revision or a
//                 withdrawn drawing
//   · RECALIBRATE / EDIT (geometry, label, cost code, snapshot) — current and
//                 superseded only
//   · VOID      — any sheet state (housekeeping with a reason)
//   · a measurement's sheet identity is immutable in every state

describe('REVISION STATUS — reads stay open, writes close when the sheet is withdrawn', () => {
  const onSuperseded = { revisionId: REV_SUPERSEDED, takeoffPageId: pageIdFor(DRAWING_A, REV_SUPERSEDED, 1) }
  const onWithdrawn  = { revisionId: REV_WITHDRAWN,  takeoffPageId: pageIdFor(DRAWING_A, REV_WITHDRAWN, 1) }
  const onWithdrawnDrawing = {
    drawingId: DRAWING_WITHDRAWN, revisionId: REV_ON_WITHDRAWN_DRAWING,
    takeoffPageId: pageIdFor(DRAWING_WITHDRAWN, REV_ON_WITHDRAWN_DRAWING, 1),
  }

  beforeEach(async () => {
    // History seeded directly (bypassing rules) on all three non-live sheets.
    await seedPage({ revisionId: REV_SUPERSEDED }, onSuperseded.takeoffPageId)
    await seedMeasurement(onSuperseded, 'mSuperseded')
    await seedPage({ revisionId: REV_WITHDRAWN }, onWithdrawn.takeoffPageId)
    await seedMeasurement(onWithdrawn, 'mWithdrawn')
    await seedPage({ drawingId: DRAWING_WITHDRAWN, revisionId: REV_ON_WITHDRAWN_DRAWING }, onWithdrawnDrawing.takeoffPageId)
    await seedMeasurement(onWithdrawnDrawing, 'mWithdrawnDrawing')
  })

  it('49. READ — pages and measurements on superseded and withdrawn revisions, and on a withdrawn drawing, are readable by all three roles', async () => {
    for (const user of WRITERS) {
      for (const id of [onSuperseded.takeoffPageId, onWithdrawn.takeoffPageId, onWithdrawnDrawing.takeoffPageId]) {
        await assertSucceeds(getDoc(pageRef(ctx(user), id)))
      }
      for (const id of ['mSuperseded', 'mWithdrawn', 'mWithdrawnDrawing']) {
        await assertSucceeds(getDoc(measRef(ctx(user), id)))
      }
      await assertSucceeds(getDocs(collection(ctx(user), measurementsPath())))
    }
  })

  it('50. READ — the denied roles still cannot read historical sheets (history is not public)', async () => {
    for (const user of [...DENIED, USERS.other]) {
      await assertFails(getDoc(pageRef(ctx(user), onWithdrawn.takeoffPageId)))
      await assertFails(getDoc(measRef(ctx(user), 'mWithdrawn')))
    }
  })

  it('51. CREATE — a page or measurement on a withdrawn DRAWING is refused even though its revision reads "current"', async () => {
    const id2 = pageIdFor(DRAWING_WITHDRAWN, REV_ON_WITHDRAWN_DRAWING, 2)
    await assertFails(setDoc(pageRef(ctx(USERS.qs), id2), pagePayload(USERS.qs, { drawingId: DRAWING_WITHDRAWN, revisionId: REV_ON_WITHDRAWN_DRAWING, page: 2 })))
    await assertFails(setDoc(measRef(ctx(USERS.qs), 'mNew'), measurementPayload(USERS.qs, onWithdrawnDrawing)))
  })

  it('52. RECALIBRATE — allowed on a superseded sheet, refused on a withdrawn revision and on a withdrawn drawing', async () => {
    await assertSucceeds(updateDoc(pageRef(ctx(USERS.qs), onSuperseded.takeoffPageId), recalibrate(USERS.qs, 2, 2)))
    await assertFails(updateDoc(pageRef(ctx(USERS.qs), onWithdrawn.takeoffPageId), recalibrate(USERS.qs, 2, 2)))
    await assertFails(updateDoc(pageRef(ctx(USERS.qs), onWithdrawnDrawing.takeoffPageId), recalibrate(USERS.qs, 2, 2)))
    for (const user of [USERS.admin, USERS.pm]) {
      await assertFails(updateDoc(pageRef(ctx(user), onWithdrawn.takeoffPageId), recalibrate(user, 2, 2)))
    }
  })

  it('53. EDIT — geometry, label, cost code or snapshot edits are allowed on a superseded sheet and refused once the revision or drawing is withdrawn', async () => {
    await assertSucceeds(updateDoc(measRef(ctx(USERS.qs), 'mSuperseded'), stamps(USERS.qs, 2, { label: 'Re-labelled on the superseded sheet' })))
    for (const id of ['mWithdrawn', 'mWithdrawnDrawing']) {
      await assertFails(updateDoc(measRef(ctx(USERS.qs), id), stamps(USERS.qs, 2, { label: 'Edited history' })))
      await assertFails(updateDoc(measRef(ctx(USERS.qs), id), stamps(USERS.qs, 2, { points: [{ x: 1, y: 1 }, { x: 9, y: 9 }] })))
      await assertFails(updateDoc(measRef(ctx(USERS.qs), id), stamps(USERS.qs, 2, { costCodeId: COST_CODE, costCodeName: 'Moved' })))
      await assertFails(updateDoc(measRef(ctx(USERS.qs), id), stamps(USERS.qs, 2, { calibration: { ...SNAP, revision: 2 } })))
    }
  })

  it('54. VOID — the one write permitted on a withdrawn revision or drawing, still reasoned and revision-guarded', async () => {
    for (const id of ['mWithdrawn', 'mWithdrawnDrawing', 'mSuperseded']) {
      await assertFails(updateDoc(measRef(ctx(USERS.qs), id), voidWrite(USERS.qs, 2, '')))
      await assertFails(updateDoc(measRef(ctx(USERS.qs), id), voidWrite(USERS.qs, 1)))
      await assertSucceeds(updateDoc(measRef(ctx(USERS.qs), id), voidWrite(USERS.qs, 2, 'Historical record closed')))
      // …and once voided, immutable — a void cannot smuggle an edit either.
      await assertFails(updateDoc(measRef(ctx(USERS.qs), id), stamps(USERS.qs, 3, { label: 'back' })))
    }
  })

  it('55. a measurement can never be re-pointed from a withdrawn (or any) sheet to a live one', async () => {
    const live = { takeoffPageId: PAGE_ID, revisionId: REV_CURRENT }
    await seedPage()
    for (const id of ['mWithdrawn', 'mSuperseded', 'mWithdrawnDrawing']) {
      await assertFails(updateDoc(measRef(ctx(USERS.qs), id), stamps(USERS.qs, 2, live)))
      await assertFails(updateDoc(measRef(ctx(USERS.qs), id), stamps(USERS.qs, 2, { ...live, drawingId: DRAWING_A })))
    }
    // Nor a page: identity is frozen.
    await assertFails(updateDoc(pageRef(ctx(USERS.qs), onWithdrawn.takeoffPageId), recalibrate(USERS.qs, 2, 2, { revisionId: REV_CURRENT })))
  })

  it('56. the guarded transactions respect the same contract end to end: edit on a withdrawn sheet is PERMISSION, void succeeds', async () => {
    const sdk = { db: ctx(USERS.qs), uid: USERS.qs.uid, runTransaction, serverTimestamp }
    const seen = (await getDoc(measRef(sdk.db, 'mWithdrawn'))).data()
    let caught = null
    try { await runUpdateMeasurement({ ...sdk, ref: measRef(sdk.db, 'mWithdrawn'), seen, changes: { label: 'nope' } }) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(QuantError)
    expect(caught.kind).toBe(QUANT_ERROR.PERMISSION)
    const out = await runVoidMeasurement({ ...sdk, ref: measRef(sdk.db, 'mWithdrawn'), seen, reason: 'closing history' })
    expect(out.revision).toBe(2)
    expect((await getDoc(measRef(sdk.db, 'mWithdrawn'))).data()).toMatchObject({ status: 'void', label: seen.label, revision: 2 })
  })
})

// ── Reads ────────────────────────────────────────────────────────────────────

describe('READS — the three takeoff roles only', () => {
  beforeEach(async () => { await seedPage(); await seedMeasurement() })

  it('1. company_admin, project_manager and qs read pages and measurements, singly and as a list', async () => {
    for (const user of WRITERS) {
      await assertSucceeds(getDoc(pageRef(ctx(user))))
      await assertSucceeds(getDoc(measRef(ctx(user))))
      await assertSucceeds(getDocs(collection(ctx(user), pagesPath())))
      await assertSucceeds(getDocs(collection(ctx(user), measurementsPath())))
    }
  })

  it('2. subcontractor, client and super_admin cannot read either collection', async () => {
    for (const user of DENIED) {
      await assertFails(getDoc(pageRef(ctx(user))))
      await assertFails(getDoc(measRef(ctx(user))))
      await assertFails(getDocs(collection(ctx(user), measurementsPath())))
    }
  })

  it('3. another company, an unauthenticated caller and a user with no membership document are denied', async () => {
    await assertFails(getDoc(pageRef(ctx(USERS.other))))
    await assertFails(getDoc(measRef(ctx(USERS.other))))
    await assertFails(getDoc(pageRef(anon())))
    await assertFails(getDoc(measRef(anon())))
    const stranger = testEnv.authenticatedContext('u_nobody').firestore()
    await assertFails(getDoc(pageRef(stranger)))
    await assertFails(getDoc(measRef(stranger)))
  })
})

// ── Page create ──────────────────────────────────────────────────────────────

describe('PAGE CREATE — identity, source, geometry and calibration shape', () => {
  it('4. the three roles create a first-calibration page and an uncalibrated page', async () => {
    for (const user of WRITERS) {
      const id = pageIdFor(DRAWING_A, REV_CURRENT, 1)
      await assertSucceeds(setDoc(pageRef(ctx(user), id), pagePayload(user)))
      await testEnv.clearFirestore()
      await seed(async (db) => { for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId }) })
      // Re-seed the drawing and revision the rule looks up.
      await seed(async (db) => {
        await setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings`, DRAWING_A), { status: 'active' })
        await setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings/${DRAWING_A}/revisions`, REV_CURRENT), { status: 'current' })
      })
      await assertSucceeds(setDoc(pageRef(ctx(user), id), uncalibratedPage(user)))
      await testEnv.clearFirestore()
      await seed(async (db) => {
        for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId })
        await setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings`, DRAWING_A), { status: 'active' })
        await setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings/${DRAWING_A}/revisions`, REV_CURRENT), { status: 'current' })
      })
    }
  })

  it('5. a page on a superseded revision may be created (historical measurement is legitimate)', async () => {
    const id = pageIdFor(DRAWING_A, REV_SUPERSEDED, 1)
    await assertSucceeds(setDoc(pageRef(ctx(USERS.qs), id), pagePayload(USERS.qs, { revisionId: REV_SUPERSEDED })))
  })

  it('6. denied roles, another company and an unauthenticated caller cannot create a page', async () => {
    for (const user of [...DENIED, USERS.other]) {
      await assertFails(setDoc(pageRef(ctx(user)), pagePayload(user)))
    }
    await assertFails(setDoc(pageRef(anon()), pagePayload(USERS.qs)))
  })

  it('7. the document id must equal {drawingId}_{revisionId}_{page}', async () => {
    await assertFails(setDoc(pageRef(ctx(USERS.qs), 'wrong_id_1'), pagePayload(USERS.qs)))
    await assertFails(setDoc(pageRef(ctx(USERS.qs), pageIdFor(DRAWING_A, REV_CURRENT, 2)), pagePayload(USERS.qs, { page: 1 })))
    await assertFails(setDoc(pageRef(ctx(USERS.qs), pageIdFor(DRAWING_A, REV_SUPERSEDED, 1)), pagePayload(USERS.qs, { revisionId: REV_CURRENT })))
  })

  it('8. the drawing and the revision must exist, and the revision must not be withdrawn', async () => {
    await assertFails(setDoc(pageRef(ctx(USERS.qs), pageIdFor('ghost', REV_CURRENT, 1)), pagePayload(USERS.qs, { drawingId: 'ghost' })))
    await assertFails(setDoc(pageRef(ctx(USERS.qs), pageIdFor(DRAWING_A, 'ghostRev', 1)), pagePayload(USERS.qs, { revisionId: 'ghostRev' })))
    await assertFails(setDoc(pageRef(ctx(USERS.qs), pageIdFor(DRAWING_A, REV_WITHDRAWN, 1)), pagePayload(USERS.qs, { revisionId: REV_WITHDRAWN })))
  })

  it('9. page number is a positive integer', async () => {
    await assertFails(setDoc(pageRef(ctx(USERS.qs), pageIdFor(DRAWING_A, REV_CURRENT, 0)), pagePayload(USERS.qs, { page: 0 })))
    await assertFails(setDoc(pageRef(ctx(USERS.qs), `${DRAWING_A}_${REV_CURRENT}_1.5`), pagePayload(USERS.qs, { page: 1.5 })))
    await assertFails(setDoc(pageRef(ctx(USERS.qs), `${DRAWING_A}_${REV_CURRENT}_1`), pagePayload(USERS.qs, { page: '1' })))
  })

  it('10. source and geometry vocabularies: pdf|image, positive dimensions, rotation in {0,90,180,270}', async () => {
    const qs = ctx(USERS.qs)
    await assertSucceeds(setDoc(pageRef(qs), pagePayload(USERS.qs, { source: 'image', pageRotation: 0 })))
    await testEnv.clearFirestore()
    await seed(async (db) => {
      for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId })
      await setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings`, DRAWING_A), { status: 'active' })
      await setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings/${DRAWING_A}/revisions`, REV_CURRENT), { status: 'current' })
    })
    await assertSucceeds(setDoc(pageRef(qs), pagePayload(USERS.qs, { pageRotation: 270, pageWidth: 500.5, pageHeight: 750 })))
    for (const bad of [
      { source: 'dwg' }, { pageWidth: 0 }, { pageHeight: -5 }, { pageWidth: '612' }, { pageRotation: 45 }, { pageRotation: '90' },
    ]) {
      await assertFails(setDoc(pageRef(qs, pageIdFor(DRAWING_A, REV_CURRENT, 2)), pagePayload(USERS.qs, { page: 2, ...bad })))
    }
  })

  it('11. calibration shape: two {x,y} points, positive distances, mm|m — or null with calibrationRevision 0', async () => {
    const qs = ctx(USERS.qs)
    const id2 = pageIdFor(DRAWING_A, REV_CURRENT, 2)
    for (const bad of [
      { calibration: { ...CAL, pageDistance: 0 } },
      { calibration: { ...CAL, realDistance: -1 } },
      { calibration: { ...CAL, unit: 'ft' } },
      { calibration: { ...CAL, pointA: { x: 'a', y: 0 } } },
      { calibration: { ...CAL, pointA: { x: 0, y: 0, z: 1 } } },
      { calibration: { pointA: CAL.pointA, pointB: CAL.pointB, realDistance: 1, unit: 'm' } }, // missing pageDistance
      { calibration: { ...CAL, extra: true } },
      { calibration: CAL, calibrationRevision: 0 },      // calibrated but revision 0
      { calibration: CAL, calibrationRevision: 2 },      // first calibration must be 1
      { calibration: null, calibrationRevision: 1 },     // null but revision 1
      { calibration: null, calibrationRevision: 0, calibratedBy: USERS.qs.uid }, // null but stamped
      { calibration: CAL, calibratedBy: USERS.admin.uid }, // stamped as someone else
      { calibration: '1:100' },
    ]) {
      await assertFails(setDoc(pageRef(qs, id2), pagePayload(USERS.qs, { page: 2, ...bad })))
    }
  })

  it('12. exact keys — an extra or a missing field is rejected', async () => {
    await assertFails(setDoc(pageRef(ctx(USERS.qs)), pagePayload(USERS.qs, { note: 'hi' })))
    const { pageRotation: _omit, ...missing } = pagePayload(USERS.qs) // eslint-disable-line no-unused-vars
    await assertFails(setDoc(pageRef(ctx(USERS.qs)), missing))
  })

  it('13. actor and server stamps: createdBy/updatedBy must be the caller, timestamps must be request.time, revision 1', async () => {
    await assertFails(setDoc(pageRef(ctx(USERS.qs)), pagePayload(USERS.qs, { createdBy: USERS.pm.uid })))
    await assertFails(setDoc(pageRef(ctx(USERS.qs)), pagePayload(USERS.qs, { updatedBy: USERS.pm.uid })))
    await assertFails(setDoc(pageRef(ctx(USERS.qs)), pagePayload(USERS.qs, { revision: 2 })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(pageRef(ctx(USERS.qs)), pagePayload(USERS.qs, { createdAt: clock() })))
      await assertFails(setDoc(pageRef(ctx(USERS.qs)), pagePayload(USERS.qs, { calibratedAt: clock() })))
    }
  })
})

// ── Page update ──────────────────────────────────────────────────────────────

describe('PAGE UPDATE — recalibration only, revision-guarded', () => {
  beforeEach(async () => { await seedPage() })

  it('14. a recalibration with revision +1 and calibrationRevision +1 succeeds for each role', async () => {
    for (const user of WRITERS) {
      await seedPage()
      await assertSucceeds(updateDoc(pageRef(ctx(user)), recalibrate(user, 2, 2)))
    }
  })

  it('15. a BLIND overwrite (same revision), a skipped revision, or a calibrationRevision that does not move by +1 is rejected', async () => {
    await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 1, 2)))
    await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 3, 2)))
    await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 1)))
    await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 3)))
  })

  it('16. an uncalibrated page gains its first calibration as revision 2 / calibrationRevision 1', async () => {
    await seedPage({ calibration: null, calibrationRevision: 0, calibratedAt: null, calibratedBy: null })
    await assertSucceeds(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 1)))
    await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 2)))
  })

  it('17. identity, geometry and creation stamps are immutable', async () => {
    for (const bad of [
      { drawingId: 'other' }, { revisionId: REV_SUPERSEDED }, { page: 2 }, { source: 'image' },
      { pageWidth: 613 }, { pageHeight: 1 }, { pageRotation: 90 }, { createdBy: USERS.admin.uid },
      { createdAt: Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')) },
    ]) {
      await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 2, bad)))
    }
  })

  it('18. a recalibration cannot clear the calibration, forge another actor, or ride a client clock', async () => {
    await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 2, { calibration: null })))
    await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 2, { calibratedBy: USERS.pm.uid })))
    await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 2, { updatedBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 2, { calibratedAt: clock() })))
      await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 2, { updatedAt: clock() })))
    }
    await assertFails(updateDoc(pageRef(ctx(USERS.qs)), recalibrate(USERS.qs, 2, 2, { note: 'x' })))
  })

  it('19. denied roles and another company cannot recalibrate; nobody can delete a page', async () => {
    for (const user of [...DENIED, USERS.other]) {
      await assertFails(updateDoc(pageRef(ctx(user)), recalibrate(user, 2, 2)))
    }
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.other]) {
      await assertFails(deleteDoc(pageRef(ctx(user))))
    }
  })
})

// ── Measurement create ───────────────────────────────────────────────────────

describe('MEASUREMENT CREATE — references, kinds, bounds, snapshot by kind', () => {
  beforeEach(async () => { await seedPage() })

  it('20. the three roles create a length, an area and a count', async () => {
    for (const user of WRITERS) {
      await assertSucceeds(setDoc(measRef(ctx(user), `len_${user.uid}`), measurementPayload(user)))
      await assertSucceeds(setDoc(measRef(ctx(user), `area_${user.uid}`), measurementPayload(user, {
        kind: 'area', points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 400 }, { x: 0, y: 400 }],
      })))
      await assertSucceeds(setDoc(measRef(ctx(user), `count_${user.uid}`), measurementPayload(user, {
        kind: 'count', points: [{ x: 5, y: 5 }], calibration: null,
      })))
    }
  })

  it('21. denied roles, another company and an unauthenticated caller cannot create', async () => {
    for (const user of [...DENIED, USERS.other]) {
      await assertFails(setDoc(measRef(ctx(user)), measurementPayload(user)))
    }
    await assertFails(setDoc(measRef(anon()), measurementPayload(USERS.qs)))
  })

  it('22. takeoffPageId must equal {drawingId}_{revisionId}_{page} and the page document must exist', async () => {
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { takeoffPageId: 'other' })))
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { page: 2 })))
    // Page 2 has no page document yet — refused until the app creates it (its own commit).
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { page: 2, takeoffPageId: pageIdFor(DRAWING_A, REV_CURRENT, 2) })))
  })

  it('23. the drawing and revision must exist and the revision must not be withdrawn — even with a matching page id', async () => {
    // Seed a page doc for the withdrawn revision directly (rules would refuse it) to isolate the measurement rule.
    await seedPage({ revisionId: REV_WITHDRAWN }, pageIdFor(DRAWING_A, REV_WITHDRAWN, 1))
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { revisionId: REV_WITHDRAWN, takeoffPageId: pageIdFor(DRAWING_A, REV_WITHDRAWN, 1) })))
    await seedPage({ drawingId: 'ghost' }, pageIdFor('ghost', REV_CURRENT, 1))
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { drawingId: 'ghost', takeoffPageId: pageIdFor('ghost', REV_CURRENT, 1) })))
    await seedPage({ revisionId: 'ghostRev' }, pageIdFor(DRAWING_A, 'ghostRev', 1))
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { revisionId: 'ghostRev', takeoffPageId: pageIdFor(DRAWING_A, 'ghostRev', 1) })))
  })

  it('24. a measurement on a SUPERSEDED revision is permitted (historical)', async () => {
    await seedPage({ revisionId: REV_SUPERSEDED }, pageIdFor(DRAWING_A, REV_SUPERSEDED, 1))
    await assertSucceeds(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { revisionId: REV_SUPERSEDED, takeoffPageId: pageIdFor(DRAWING_A, REV_SUPERSEDED, 1) })))
  })

  it('25. the cost code must exist in the company; a blank id or name is rejected', async () => {
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { costCodeId: 'ghostCode' })))
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { costCodeId: '' })))
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { costCodeName: '   ' })))
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { costCodeName: 'x'.repeat(201) })))
  })

  it('26. kind vocabulary and point bounds by kind (≥2 length, ≥3 area, ≥1 count, ≤500)', async () => {
    const qs = ctx(USERS.qs)
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { kind: 'volume' })))
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { kind: 'length', points: [{ x: 0, y: 0 }] })))
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { kind: 'area', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] })))
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { kind: 'count', points: [], calibration: null })))
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { points: 'not a list' })))
    const many = Array.from({ length: 501 }, (_, i) => ({ x: i, y: i }))
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { points: many })))
    await assertSucceeds(setDoc(measRef(qs, 'm500'), measurementPayload(USERS.qs, { points: many.slice(0, 500) })))
  })

  it('27. label bounds: non-blank, ≤120', async () => {
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { label: '' })))
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { label: '   ' })))
    await assertFails(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { label: 'x'.repeat(121) })))
    await assertSucceeds(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { label: 'x'.repeat(120) })))
  })

  it('28. calibration snapshot: required and well-formed for length/area, null for count', async () => {
    const qs = ctx(USERS.qs)
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { calibration: null })))                   // length without snapshot
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { kind: 'count', points: [{ x: 1, y: 1 }], calibration: SNAP }))) // count with snapshot
    for (const bad of [
      { ...SNAP, revision: 0 }, { ...SNAP, pageDistance: 0 }, { ...SNAP, realDistance: -1 }, { ...SNAP, unit: 'ft' },
      { revision: 1, pageDistance: 100, unit: 'm' }, { ...SNAP, pointA: { x: 0, y: 0 } }, '1:100',
    ]) {
      await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { calibration: bad })))
    }
  })

  it('29. born active with no void stamps, revision 1, caller stamps and server time', async () => {
    const qs = ctx(USERS.qs)
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { status: 'void' })))
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { voidReason: 'x' })))
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { voidedBy: USERS.qs.uid })))
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { revision: 2 })))
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { createdBy: USERS.pm.uid })))
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { updatedBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { createdAt: clock() })))
      await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { updatedAt: clock() })))
    }
  })

  // ADR-52 revision: `boqItemId` is now the ONE optional key (see the Quant 1B
  // section below for its own contract); a quantity, amount or currency is
  // still refused, as is a wrongly typed link.
  it('30. exact keys — no extra field (quantity, amount, currency…), no mistyped boqItemId, and no missing field', async () => {
    const qs = ctx(USERS.qs)
    for (const extra of [{ quantity: 5 }, { amount: 100 }, { currency: 'AUD' }, { boqItemId: 5 }, { boqItemId: '' }, { boqItemId: { id: 'b1' } }]) {
      await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, extra)))
    }
    const { label: _omit, ...missing } = measurementPayload(USERS.qs) // eslint-disable-line no-unused-vars
    await assertFails(setDoc(measRef(qs), missing))
  })
})

// ── Measurement update ───────────────────────────────────────────────────────

describe('MEASUREMENT UPDATE — active edit, void, immutability', () => {
  beforeEach(async () => { await seedPage(); await seedMeasurement() })

  it('31. an active edit of points, label, cost code and snapshot with revision +1 succeeds for each role', async () => {
    for (const user of WRITERS) {
      await seedMeasurement()
      await assertSucceeds(updateDoc(measRef(ctx(user)), stamps(user, 2, {
        points: [{ x: 0, y: 0 }, { x: 600, y: 800 }], label: 'Slab edge north',
        costCodeId: COST_CODE, costCodeName: '03-100 — Concrete slab',
        calibration: { ...SNAP, revision: 2, realDistance: 2 },
      })))
    }
  })

  it('32. a label-only or cost-code-only edit leaves the snapshot untouched and still needs revision +1', async () => {
    await assertSucceeds(updateDoc(measRef(ctx(USERS.qs)), stamps(USERS.qs, 2, { label: 'Renamed' })))
    await assertFails(updateDoc(measRef(ctx(USERS.qs)), stamps(USERS.qs, 2, { label: 'Again' })))   // stale
    await assertSucceeds(updateDoc(measRef(ctx(USERS.qs)), stamps(USERS.qs, 3, { label: 'Again' })))
  })

  it('33. a BLIND overwrite (same or skipped revision) is rejected', async () => {
    await assertFails(updateDoc(measRef(ctx(USERS.qs)), stamps(USERS.qs, 1, { label: 'x' })))
    await assertFails(updateDoc(measRef(ctx(USERS.qs)), stamps(USERS.qs, 3, { label: 'x' })))
    await assertFails(updateDoc(measRef(ctx(USERS.qs)), stamps(USERS.qs, '2', { label: 'x' })))
  })

  it('34. identity, kind and creation stamps are immutable; a measurement never moves to another sheet', async () => {
    for (const bad of [
      { takeoffPageId: pageIdFor(DRAWING_A, REV_SUPERSEDED, 1) }, { drawingId: 'other' }, { revisionId: REV_SUPERSEDED },
      { page: 2 }, { kind: 'area' }, { createdBy: USERS.admin.uid },
      { createdAt: Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')) },
    ]) {
      await assertFails(updateDoc(measRef(ctx(USERS.qs)), stamps(USERS.qs, 2, { label: 'x', ...bad })))
    }
  })

  it('35. an active edit must keep the content valid and may not forge void stamps or add keys', async () => {
    const qs = ctx(USERS.qs)
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { points: [{ x: 0, y: 0 }] })))
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { label: '' })))
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { costCodeId: 'ghostCode' })))
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { calibration: null })))
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { label: 'x', voidedBy: USERS.qs.uid })))
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { label: 'x', voidReason: 'sneaky' })))
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { label: 'x', quantity: 5 })))
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { label: 'x', updatedBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { label: 'x', updatedAt: clock() })))
    }
  })

  it('36. void: active → void with a non-whitespace reason, caller stamp and server time; nothing else rides along', async () => {
    for (const user of WRITERS) {
      await seedMeasurement()
      await assertSucceeds(updateDoc(measRef(ctx(user)), voidWrite(user, 2)))
    }
    await seedMeasurement()
    const qs = ctx(USERS.qs)
    await assertFails(updateDoc(measRef(qs), voidWrite(USERS.qs, 2, '')))
    await assertFails(updateDoc(measRef(qs), voidWrite(USERS.qs, 2, '   ')))
    await assertFails(updateDoc(measRef(qs), voidWrite(USERS.qs, 1)))                       // stale
    await assertFails(updateDoc(measRef(qs), voidWrite(USERS.qs, 2, 'r', { voidedBy: USERS.pm.uid })))
    await assertFails(updateDoc(measRef(qs), voidWrite(USERS.qs, 2, 'r', { label: 'edited on the way out' })))
    await assertFails(updateDoc(measRef(qs), voidWrite(USERS.qs, 2, 'r', { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(measRef(qs), voidWrite(USERS.qs, 2, 'r', { voidedAt: clock() })))
    }
  })

  it('37. a voided measurement is immutable: no edit, no un-void, no second void', async () => {
    await seedMeasurement({ status: 'void', voidReason: 'done', voidedAt: Timestamp.now(), voidedBy: USERS.qs.uid, revision: 2 })
    const qs = ctx(USERS.qs)
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 3, { label: 'back' })))
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 3, { status: 'active', voidReason: '', voidedAt: null, voidedBy: null })))
    await assertFails(updateDoc(measRef(qs), voidWrite(USERS.qs, 3, 'again')))
  })

  it('38. denied roles and another company cannot edit or void; nobody can delete', async () => {
    for (const user of [...DENIED, USERS.other]) {
      await assertFails(updateDoc(measRef(ctx(user)), stamps(user, 2, { label: 'x' })))
      await assertFails(updateDoc(measRef(ctx(user)), voidWrite(user, 2)))
    }
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.other]) {
      await assertFails(deleteDoc(measRef(ctx(user))))
    }
  })
})

// ── The real guarded transactions against the emulator ──────────────────────

describe('GUARDED TRANSACTIONS — lib/quantActions.js against the emulator', () => {
  const identity = { drawingId: DRAWING_A, revisionId: REV_CURRENT, page: 1 }
  const geometry = { source: 'pdf', pageWidth: 612, pageHeight: 792, pageRotation: 0 }
  const draftCal = { pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, realDistance: 1, unit: 'm' }
  const sdk = (user) => ({ db: ctx(user), uid: user.uid, runTransaction, serverTimestamp })

  const expectKind = async (promise, kind) => {
    let caught = null
    try { await promise } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(QuantError)
    expect(caught.kind).toBe(kind)
  }

  it('39. first calibration → recalibration from the seen copy → stale recalibration refused and nothing written', async () => {
    const qs = sdk(USERS.qs)
    const first = await runSaveCalibration({ ...qs, pageRef: pageRef(qs.db), identity, geometry, draft: draftCal, seenPage: null })
    expect(first).toEqual({ kind: null, revision: 1, calibrationRevision: 1 })

    const pm = sdk(USERS.pm)
    const second = await runSaveCalibration({ ...pm, pageRef: pageRef(pm.db), identity, geometry, draft: { ...draftCal, realDistance: 2 }, seenPage: { revision: 1 } })
    expect(second).toEqual({ kind: null, revision: 2, calibrationRevision: 2 })

    // The QS still holds revision 1 — refused as STALE by the transaction (before rules even see a write).
    await expectKind(runSaveCalibration({ ...qs, pageRef: pageRef(qs.db), identity, geometry, draft: { ...draftCal, realDistance: 3 }, seenPage: { revision: 1 } }), QUANT_ERROR.STALE)
    const stored = (await getDoc(pageRef(qs.db))).data()
    expect(stored.calibration.realDistance).toBe(2)
    expect(stored.calibrationRevision).toBe(2)
  })

  it('40. ensurePage then count on an uncalibrated page; a length is UNCALIBRATED; a page re-calibrated underneath makes the create STALE', async () => {
    const qs = sdk(USERS.qs)
    const ensured = await runEnsurePage({ ...qs, pageRef: pageRef(qs.db), identity, geometry })
    expect(ensured.created).toBe(true)
    const count = await runCreateMeasurement({
      ...qs, pageRef: pageRef(qs.db), measurementRef: measRef(qs.db, 'c1'), identity, seenPage: ensured.page,
      draft: { kind: 'count', points: [{ x: 1, y: 1 }], label: 'Doors', costCodeId: COST_CODE, costCodeName: '03-100 — Concrete' },
    })
    expect(count).toEqual({ kind: null, revision: 1, id: 'c1' })
    expect((await getDoc(measRef(qs.db, 'c1'))).data().calibration).toBeNull()

    await expectKind(runCreateMeasurement({
      ...qs, pageRef: pageRef(qs.db), measurementRef: measRef(qs.db, 'l1'), identity, seenPage: ensured.page,
      draft: { kind: 'length', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], label: 'L', costCodeId: COST_CODE, costCodeName: 'C' },
    }), QUANT_ERROR.UNCALIBRATED)

    // Calibrate (revision 2), then try to save a length from the stale revision-1 copy.
    await runSaveCalibration({ ...qs, pageRef: pageRef(qs.db), identity, geometry, draft: draftCal, seenPage: { revision: 1 } })
    await expectKind(runCreateMeasurement({
      ...qs, pageRef: pageRef(qs.db), measurementRef: measRef(qs.db, 'l1'), identity, seenPage: ensured.page,
      draft: { kind: 'length', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], label: 'L', costCodeId: COST_CODE, costCodeName: 'C' },
    }), QUANT_ERROR.STALE)
    expect((await getDoc(measRef(qs.db, 'l1'))).exists()).toBe(false)

    // With the fresh copy it saves, and the snapshot is calibration revision 1.
    const page = (await getDoc(pageRef(qs.db))).data()
    const len = await runCreateMeasurement({
      ...qs, pageRef: pageRef(qs.db), measurementRef: measRef(qs.db, 'l1'), identity, seenPage: page,
      draft: { kind: 'length', points: [{ x: 0, y: 0 }, { x: 300, y: 400 }], label: 'L', costCodeId: COST_CODE, costCodeName: 'C' },
    })
    expect(len.revision).toBe(1)
    expect((await getDoc(measRef(qs.db, 'l1'))).data().calibration).toEqual({ revision: 1, pageDistance: 100, realDistance: 1, unit: 'm' })
  })

  it('41. edit / void from a stale copy is refused end to end; the fresh copy succeeds with exactly +1', async () => {
    await seedPage()
    await seedMeasurement()
    const qs = sdk(USERS.qs)
    const pm = sdk(USERS.pm)
    const seen = (await getDoc(measRef(qs.db))).data()
    const r2 = await runUpdateMeasurement({ ...pm, ref: measRef(pm.db), seen, changes: { label: 'PM renamed' } })
    expect(r2.revision).toBe(2)
    await expectKind(runUpdateMeasurement({ ...qs, ref: measRef(qs.db), seen, changes: { label: 'QS renamed' } }), QUANT_ERROR.STALE)
    await expectKind(runVoidMeasurement({ ...qs, ref: measRef(qs.db), seen, reason: 'stale void' }), QUANT_ERROR.STALE)
    const fresh = (await getDoc(measRef(qs.db))).data()
    expect(fresh).toMatchObject({ label: 'PM renamed', revision: 2, status: 'active' })
    const r3 = await runVoidMeasurement({ ...qs, ref: measRef(qs.db), seen: fresh, reason: 'done' })
    expect(r3.revision).toBe(3)
    expect((await getDoc(measRef(qs.db))).data()).toMatchObject({ status: 'void', voidReason: 'done', voidedBy: USERS.qs.uid, revision: 3 })
  })

  it('42. a denied role running the real transaction gets a PERMISSION error and writes nothing', async () => {
    const sub = sdk(USERS.sub)
    await expectKind(runEnsurePage({ ...sub, pageRef: pageRef(sub.db), identity, geometry }), QUANT_ERROR.PERMISSION)
    await seedPage()
    let stored = null
    await testEnv.withSecurityRulesDisabled(async (c) => { stored = (await getDoc(doc(c.firestore(), pagesPath(), PAGE_ID))).data() })
    expect(stored.calibrationRevision).toBe(1)
    await expectKind(runSaveCalibration({ ...sub, pageRef: pageRef(sub.db), identity, geometry, draft: { ...draftCal, realDistance: 9 }, seenPage: { revision: 1 } }), QUANT_ERROR.PERMISSION)
    await testEnv.withSecurityRulesDisabled(async (c) => { stored = (await getDoc(doc(c.firestore(), pagesPath(), PAGE_ID))).data() })
    expect(stored.calibration.realDistance).toBe(1)
  })
})

// ── Quant 1B — the BOQ link (ADR-52) ─────────────────────────────────────────
//
// `boqItemId` is OPTIONAL (hasOnly, not hasAll): a Quant 1A document without
// the key stays valid for every write; a 1B document carries null or an id.
// When the link is set — at create, or whenever the link OR the cost code
// changes on an active edit — rules `get()` the target: same project path,
// exists, active, same cost code. Unit compatibility and the aggregate are
// client-only (Deferred Control 33) and are NOT checked here.

describe('QUANT 1B — the BOQ link (ADR-52)', () => {
  const BOQ_OK = 'boqOk'            // active, COST_CODE
  const BOQ_VOID = 'boqVoid'        // void, COST_CODE
  const BOQ_OTHER = 'boqOtherCode'  // active, a different cost code
  const BOQ_ELSEWHERE = 'boqElsewhere' // active, COST_CODE — but in ANOTHER project of company A
  const boqPath = (projectId = PROJECT_A) => `companies/${COMPANY_A}/projects/${projectId}/boqItems`
  const boqDoc = (overrides = {}) => ({
    itemNumber: '2.1', section: 'Substructure', description: 'Formwork to slab edge', unit: 'm', quantity: 10, rate: 85, amount: 850,
    costCodeId: COST_CODE, costCodeName: '03-100 — Concrete', notes: '', status: 'active', currency: 'AUD', revision: 1,
    attachments: [], externalRefs: {}, voidReason: '', voidedAt: null, voidedBy: null,
    createdAt: Timestamp.now(), createdBy: USERS.qs.uid, updatedAt: Timestamp.now(), updatedBy: USERS.qs.uid, ...overrides,
  })

  beforeEach(async () => {
    await seedPage()
    await seed(async (db) => {
      await setDoc(doc(db, boqPath(), BOQ_OK), boqDoc())
      await setDoc(doc(db, boqPath(), BOQ_VOID), boqDoc({ status: 'void', voidReason: 'Measured in error', voidedAt: Timestamp.now(), voidedBy: USERS.qs.uid }))
      await setDoc(doc(db, boqPath(), BOQ_OTHER), boqDoc({ costCodeId: COST_CODE_INACTIVE, costCodeName: '99 — Retired' }))
      await setDoc(doc(db, `companies/${COMPANY_A}/projects`, 'projectB'), { name: 'Project B' })
      await setDoc(doc(db, boqPath('projectB'), BOQ_ELSEWHERE), boqDoc())
    })
  })

  it('57. CREATE — the 1A shape (no key), boqItemId null, and a VALID link all pass, for each role', async () => {
    for (const user of WRITERS) {
      await assertSucceeds(setDoc(measRef(ctx(user), `legacy-${user.uid}`), measurementPayload(user)))
      await assertSucceeds(setDoc(measRef(ctx(user), `null-${user.uid}`), measurementPayload(user, { boqItemId: null })))
      await assertSucceeds(setDoc(measRef(ctx(user), `linked-${user.uid}`), measurementPayload(user, { boqItemId: BOQ_OK })))
    }
    const stored = (await getDoc(measRef(ctx(USERS.qs), `linked-${USERS.qs.uid}`))).data()
    expect(stored.boqItemId).toBe(BOQ_OK)
  })

  it('58. CREATE — a link to a MISSING, VOID, DIFFERENT-COST-CODE or OTHER-PROJECT item is refused; so is a blank or oversized id', async () => {
    const qs = ctx(USERS.qs)
    for (const bad of [BOQ_VOID, BOQ_OTHER, BOQ_ELSEWHERE, 'ghost', '', 'x'.repeat(129)]) {
      await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { boqItemId: bad })))
    }
    // The same id in ANOTHER COMPANY's identical project path is unreachable too.
    await seed(async (db) => { await setDoc(doc(db, `companies/${COMPANY_B}/projects/${PROJECT_A}/boqItems`, 'onlyInB'), boqDoc()) })
    await assertFails(setDoc(measRef(qs), measurementPayload(USERS.qs, { boqItemId: 'onlyInB' })))
  })

  it('59. UPDATE — link, re-link and unlink are active edits with revision +1; a legacy document gains the key', async () => {
    await seedMeasurement() // 1A shape: no boqItemId key at all
    const qs = ctx(USERS.qs)
    await assertSucceeds(updateDoc(measRef(qs), stamps(USERS.qs, 2, { boqItemId: BOQ_OK })))
    expect((await getDoc(measRef(qs))).data().boqItemId).toBe(BOQ_OK)
    // Re-link to another valid target is just another link.
    await seed(async (db) => { await setDoc(doc(db, boqPath(), 'boqOk2'), boqDoc({ itemNumber: '2.2' })) })
    await assertSucceeds(updateDoc(measRef(qs), stamps(USERS.qs, 3, { boqItemId: 'boqOk2' })))
    await assertSucceeds(updateDoc(measRef(qs), stamps(USERS.qs, 4, { boqItemId: null })))
    expect((await getDoc(measRef(qs))).data().boqItemId).toBeNull()
    // Without the +1 the link write is a blind overwrite and fails like any other.
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 4, { boqItemId: BOQ_OK })))
  })

  it('60. UPDATE — linking to a void, other-code, other-project or missing item is refused; a label edit still passes when the EXISTING link has since gone void', async () => {
    await seedMeasurement({ boqItemId: BOQ_OK })
    const qs = ctx(USERS.qs)
    for (const bad of [BOQ_VOID, BOQ_OTHER, BOQ_ELSEWHERE, 'ghost', '', 7]) {
      await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { boqItemId: bad })))
    }
    // The target is voided AFTER linking: the stored link is history, and an
    // edit that does not touch the link or the cost code is not punished.
    await seed(async (db) => { await updateDoc(doc(db, boqPath(), BOQ_OK), { status: 'void', voidReason: 'Superseded', voidedAt: Timestamp.now(), voidedBy: USERS.pm.uid }) })
    await assertSucceeds(updateDoc(measRef(qs), stamps(USERS.qs, 2, { label: 'renamed while the item is void' })))
    await assertSucceeds(updateDoc(measRef(qs), stamps(USERS.qs, 3, { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], calibration: SNAP })))
    // …but MOVING the link re-verifies the new target (a void one is refused), and clearing it passes.
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 4, { boqItemId: BOQ_VOID })))
    await assertSucceeds(updateDoc(measRef(qs), stamps(USERS.qs, 4, { boqItemId: null })))
  })

  it('61. UPDATE — a cost-code change on a LINKED measurement is refused unless the link is cleared or re-pointed in the SAME write', async () => {
    await seedMeasurement({ boqItemId: BOQ_OK })
    const qs = ctx(USERS.qs)
    const recode = { costCodeId: COST_CODE_INACTIVE, costCodeName: '99 — Retired' }
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, recode)))
    await assertFails(updateDoc(measRef(qs), stamps(USERS.qs, 2, { ...recode, boqItemId: BOQ_OK })))
    // Re-pointed to an item on the NEW code in the same write: passes.
    await assertSucceeds(updateDoc(measRef(qs), stamps(USERS.qs, 2, { ...recode, boqItemId: BOQ_OTHER })))
    await seedMeasurement({ boqItemId: BOQ_OK })
    await assertSucceeds(updateDoc(measRef(qs), stamps(USERS.qs, 2, { ...recode, boqItemId: null })))
    // An UNLINKED measurement re-codes freely, as in 1A.
    await seedMeasurement()
    await assertSucceeds(updateDoc(measRef(qs), stamps(USERS.qs, 2, recode)))
  })

  it('62. VOID keeps the link as history and may not change it; the denied roles still cannot link', async () => {
    await seedMeasurement({ boqItemId: BOQ_OK })
    const qs = ctx(USERS.qs)
    await assertFails(updateDoc(measRef(qs), voidWrite(USERS.qs, 2, 'done', { boqItemId: null })))
    await assertSucceeds(updateDoc(measRef(qs), voidWrite(USERS.qs, 2)))
    expect((await getDoc(measRef(qs))).data()).toMatchObject({ status: 'void', boqItemId: BOQ_OK })
    for (const user of DENIED) {
      await assertFails(setDoc(measRef(ctx(user), 'denied'), measurementPayload(user, { boqItemId: BOQ_OK })))
    }
    await assertFails(setDoc(measRef(ctx(USERS.other), 'other'), measurementPayload(USERS.other, { boqItemId: BOQ_OK })))
  })

  it('63. GUARDED TRANSACTIONS — create writes boqItemId null by default or the chosen link; re-coding through runUpdateMeasurement clears a link in the same commit', async () => {
    const identity = { drawingId: DRAWING_A, revisionId: REV_CURRENT, page: 1 }
    const qs = { db: ctx(USERS.qs), uid: USERS.qs.uid, runTransaction, serverTimestamp }
    const page = (await getDoc(pageRef(qs.db))).data()
    const base = { ...qs, pageRef: pageRef(qs.db), identity, seenPage: page }
    const draft = { kind: 'length', points: [{ x: 0, y: 0 }, { x: 300, y: 400 }], label: 'L', costCodeId: COST_CODE, costCodeName: 'C' }

    await runCreateMeasurement({ ...base, measurementRef: measRef(qs.db, 't1'), draft })
    expect((await getDoc(measRef(qs.db, 't1'))).data().boqItemId).toBeNull()
    await runCreateMeasurement({ ...base, measurementRef: measRef(qs.db, 't2'), draft: { ...draft, boqItemId: BOQ_OK } })
    expect((await getDoc(measRef(qs.db, 't2'))).data().boqItemId).toBe(BOQ_OK)

    // A link to a void item is refused by RULES → the transaction reports PERMISSION and writes nothing.
    let caught = null
    try { await runCreateMeasurement({ ...base, measurementRef: measRef(qs.db, 't3'), draft: { ...draft, boqItemId: BOQ_VOID } }) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(QuantError)
    expect(caught.kind).toBe(QUANT_ERROR.PERMISSION)
    expect((await getDoc(measRef(qs.db, 't3'))).exists()).toBe(false)

    // Re-code without a link decision: the link is cleared in the same write and reported.
    const seen = { id: 't2', ...(await getDoc(measRef(qs.db, 't2'))).data() }
    const out = await runUpdateMeasurement({ ...qs, ref: measRef(qs.db, 't2'), seen, changes: { costCodeId: COST_CODE_INACTIVE, costCodeName: '99 — Retired' } })
    expect(out).toEqual({ kind: null, revision: 2, linkCleared: true })
    expect((await getDoc(measRef(qs.db, 't2'))).data()).toMatchObject({ costCodeId: COST_CODE_INACTIVE, boqItemId: null, revision: 2 })

    // Explicit unlink / link through the same action.
    const seen2 = { id: 't2', ...(await getDoc(measRef(qs.db, 't2'))).data() }
    const out2 = await runUpdateMeasurement({ ...qs, ref: measRef(qs.db, 't2'), seen: seen2, changes: { boqItemId: BOQ_OTHER } })
    expect(out2).toEqual({ kind: null, revision: 3, linkCleared: false })
    expect((await getDoc(measRef(qs.db, 't2'))).data().boqItemId).toBe(BOQ_OTHER)
  })

  it('64. NOT ENFORCED (DC33) — unit compatibility: a LENGTH links to an item measured in m³, because rules cannot normalise units', async () => {
    await seed(async (db) => { await setDoc(doc(db, boqPath(), 'boqM3'), boqDoc({ unit: 'm3' })) })
    await assertSucceeds(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { boqItemId: 'boqM3' })))
  })
})

// ── Deliberately NOT enforced — proven, so nobody describes it as a control ──

describe('NOT ENFORCED (Deferred Control 32) — proven by passing writes', () => {
  beforeEach(async () => { await seedPage() })

  it('43. point CONTENT is not checked: junk elements inside a well-sized list pass', async () => {
    await assertSucceeds(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { points: ['a', 7] })))
    await assertSucceeds(setDoc(measRef(ctx(USERS.qs), 'm2'), measurementPayload(USERS.qs, { points: [{ x: 'NaN', y: null }, { x: -99999, y: 1e12 }] })))
  })

  it('44. pageDistance need not match the calibration points, and the real distance is taken on trust', async () => {
    await assertSucceeds(setDoc(pageRef(ctx(USERS.qs), pageIdFor(DRAWING_A, REV_CURRENT, 2)), pagePayload(USERS.qs, {
      page: 2, calibration: { ...CAL, pageDistance: 1 }, // points are 100 apart
    })))
    await assertSucceeds(setDoc(pageRef(ctx(USERS.qs), pageIdFor(DRAWING_A, REV_CURRENT, 3)), pagePayload(USERS.qs, {
      page: 3, calibration: { ...CAL, realDistance: 1e9 },
    })))
  })

  it('45. the page number is not checked against the PDF, and page geometry is taken on trust', async () => {
    await assertSucceeds(setDoc(pageRef(ctx(USERS.qs), pageIdFor(DRAWING_A, REV_CURRENT, 9999)), pagePayload(USERS.qs, { page: 9999, pageWidth: 1, pageHeight: 1 })))
  })

  it('46. an INACTIVE cost code is accepted (existence, not activity, is checked)', async () => {
    await assertSucceeds(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { costCodeId: COST_CODE_INACTIVE, costCodeName: '99 — Retired' })))
  })

  it('47. a measurement snapshot need not match the page calibration — the app derives the review flag', async () => {
    await assertSucceeds(setDoc(measRef(ctx(USERS.qs)), measurementPayload(USERS.qs, { calibration: { revision: 7, pageDistance: 1, realDistance: 999, unit: 'mm' } })))
  })

  it('48. a client that READS the revision and writes +1 itself passes — the +1 rule rejects only BLIND overwrites', async () => {
    await seedMeasurement()
    const current = (await getDoc(measRef(ctx(USERS.qs)))).data()
    await assertSucceeds(updateDoc(measRef(ctx(USERS.qs)), stamps(USERS.qs, current.revision + 1, { label: 'raced in' })))
  })
})
