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

// ── RFI Security Rules — emulator tests (ADR-33) ─────────────────────────────
//
// Executes docs/TESTING.md §15t-x against the Firestore emulator. These verify
// the RULES, not the UI: every write below is a direct SDK call, exactly what a
// client bypassing the app would issue.
//
// What makes this block distinctive:
//   · FORWARD-ONLY with NO REOPEN — the ADR-11 default, unlike `activities`.
//   · answered → cancelled is ILLEGAL. Cancel exists for draft/open only.
//   · THE REFERENCE IS EXISTENCE-VERIFIED: a drawing reference must name BOTH
//     a master AND a revision nested under it; a document reference must name
//     a real document.
//   · The counter is PER-PROJECT (projects/{p}/counters/rfis), the first
//     project-scoped counter in the app.
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (the documented
// client-only gaps — docs/SECURITY.md → Deferred Control 27): a duplicate
// rfiNumber, an arbitrary raisedByName, an assignedToContactId/costCodeId
// naming nothing, a stale referenceLabel, and an impossible calendar date of
// valid shape are all ACCEPTED.
//
// OPEN-STATE INVARIANT: an open RFI always carries an assignee AND a due date.
// Both may be changed while open but neither may be cleared (REGRESSION 1–8).
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const PROJECT_B = 'projectB'   // a second project in Company A — for the per-project counter

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  super:  { uid: 'u_super',  role: 'super_admin',     companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}

const MEMBERS     = [USERS.admin, USERS.pm, USERS.qs]
const NON_MEMBERS = [USERS.sub, USERS.client, USERS.super]

// Seeded reference targets.
const DRAWING_ID  = 'dwgA101'
const REVISION_ID = 'revC'
const OTHER_DRAWING_ID  = 'dwgS200'
const OTHER_REVISION_ID = 'revS1'
const DOCUMENT_ID = 'docSpec'

let testEnv

const rfisPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/rfis`
const counterPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/counters/rfis`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const rfiRef = (db, id, companyId = COMPANY_A, projectId = PROJECT_A) =>
  doc(db, rfisPath(companyId, projectId), id)
const ctrRef = (db, companyId = COMPANY_A, projectId = PROJECT_A) =>
  doc(db, counterPath(companyId, projectId))

const DRAWING_REF = {
  referenceType: 'drawing',
  referenceDrawingId: DRAWING_ID,
  referenceRevisionId: REVISION_ID,
  referenceDocumentId: null,
  referenceLabel: 'A-101 Ground Floor Plan',
  referenceRevisionCode: 'C',
}
const DOCUMENT_REF = {
  referenceType: 'document',
  referenceDrawingId: null,
  referenceRevisionId: null,
  referenceDocumentId: DOCUMENT_ID,
  referenceLabel: 'Structural Specification',
  referenceRevisionCode: '',
}

// A valid draft, exactly as hooks/useRfis.jsx writes it.
function payload(user, overrides = {}) {
  return {
    rfiNumber: 'RFI-0001',
    status: 'draft',

    title: 'Slab thickness at grid C',
    question: 'Drawing shows 200 but the spec says 225. Which governs?',
    raisedDate: '2026-10-10',
    // Client-authored snapshot of the creator's OWN profile name (ADR-27).
    raisedByName: 'Sam Site',

    referenceType: 'none',
    referenceDrawingId: null,
    referenceRevisionId: null,
    referenceDocumentId: null,
    referenceLabel: '',
    referenceRevisionCode: '',

    costCodeId: null,
    costCodeName: '',

    assignedToContactId: null,
    assignedToName: '',
    dueDate: null,

    raisedAt: null, raisedBy: null,
    answer: '', answerDate: null, answeredAt: null, answeredBy: null,
    closeOutNote: '', closedAt: null, closedBy: null,
    cancelReason: '', cancelledAt: null, cancelledBy: null,

    revision: 1,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

const ASSIGNED = { assignedToContactId: 'contact1', assignedToName: 'Arch Co', dueDate: '2026-10-20' }

// Seeds a document directly, bypassing rules — the arrange step for updates.
async function seed(id, overrides = {}, user = USERS.admin, projectId = PROJECT_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(doc(db, rfisPath(COMPANY_A, projectId), id), {
      ...payload(user),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...overrides,
    })
  })
}

const seedOpen = (id, overrides = {}) => seed(id, {
  status: 'open', ...ASSIGNED,
  raisedAt: Timestamp.now(), raisedBy: USERS.admin.uid,
  ...overrides,
})
const seedAnswered = (id, overrides = {}) => seedOpen(id, {
  status: 'answered',
  answer: '225 governs — see revised detail.', answerDate: '2026-10-14',
  answeredAt: Timestamp.now(), answeredBy: USERS.admin.uid,
  ...overrides,
})
const seedClosed = (id, overrides = {}) => seedAnswered(id, {
  status: 'closed', closeOutNote: 'Accepted',
  closedAt: Timestamp.now(), closedBy: USERS.admin.uid,
  ...overrides,
})
const seedCancelled = (id, overrides = {}) => seedOpen(id, {
  status: 'cancelled', cancelReason: 'Duplicate of RFI-0003',
  cancelledAt: Timestamp.now(), cancelledBy: USERS.admin.uid,
  ...overrides,
})

// The write shapes the app performs.
const stamp = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })
const edit = (user, extra = {}) => ({ ...stamp(user), ...extra })
const raiseWrite = (user, extra = {}) => ({
  status: 'open', raisedAt: serverTimestamp(), raisedBy: user.uid, ...stamp(user), ...extra,
})
const answerWrite = (user, extra = {}) => ({
  status: 'answered', answer: '225 governs.', answerDate: '2026-10-14',
  answeredAt: serverTimestamp(), answeredBy: user.uid, ...stamp(user), ...extra,
})
const closeWrite = (user, extra = {}) => ({
  status: 'closed', closeOutNote: '', closedAt: serverTimestamp(), closedBy: user.uid, ...stamp(user), ...extra,
})
const cancelWrite = (user, reason = 'Duplicate question', extra = {}) => ({
  status: 'cancelled', cancelReason: reason, cancelledAt: serverTimestamp(), cancelledBy: user.uid,
  ...stamp(user), ...extra,
})

// Client-supplied clock values that must NEVER satisfy `== request.time`.
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
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_B), { name: 'Project B', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })

    // Reference targets in Project A: two drawings each with one revision, and
    // one general document. Only existence matters to the rules.
    const dwg = `companies/${COMPANY_A}/projects/${PROJECT_A}/drawings`
    await setDoc(doc(db, dwg, DRAWING_ID), { drawingNumber: 'A-101', title: 'Ground Floor Plan', status: 'active' })
    await setDoc(doc(db, `${dwg}/${DRAWING_ID}/revisions`, REVISION_ID), { revisionCode: 'C', revisionSequence: 3, status: 'current' })
    await setDoc(doc(db, dwg, OTHER_DRAWING_ID), { drawingNumber: 'S-200', title: 'Footing Plan', status: 'active' })
    await setDoc(doc(db, `${dwg}/${OTHER_DRAWING_ID}/revisions`, OTHER_REVISION_ID), { revisionCode: '1', revisionSequence: 1, status: 'current' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/documents`, DOCUMENT_ID), { name: 'Structural Specification', status: 'active', visibility: 'project' })
  })
})

// ── Read / write matrix ──────────────────────────────────────────────────────

describe('read and write matrix', () => {
  it('admin, project_manager and qs can READ an RFI', async () => {
    await seed('r1')
    for (const user of MEMBERS) await assertSucceeds(getDoc(rfiRef(ctx(user), 'r1')))
  })

  it('subcontractor, client and super_admin CANNOT read an RFI', async () => {
    await seed('r1')
    for (const user of NON_MEMBERS) await assertFails(getDoc(rfiRef(ctx(user), 'r1')))
  })

  it('admin, project_manager and qs can CREATE a draft', async () => {
    for (const user of MEMBERS) {
      await assertSucceeds(setDoc(rfiRef(ctx(user), `c-${user.uid}`), payload(user)))
    }
  })

  it('every member role can raise, answer, close and cancel', async () => {
    for (const user of MEMBERS) {
      await seed(`d-${user.uid}`, ASSIGNED)
      await assertSucceeds(updateDoc(rfiRef(ctx(user), `d-${user.uid}`), raiseWrite(user)))
      await seedOpen(`o-${user.uid}`)
      await assertSucceeds(updateDoc(rfiRef(ctx(user), `o-${user.uid}`), answerWrite(user)))
      await seedAnswered(`a-${user.uid}`)
      await assertSucceeds(updateDoc(rfiRef(ctx(user), `a-${user.uid}`), closeWrite(user)))
      await seedOpen(`x-${user.uid}`)
      await assertSucceeds(updateDoc(rfiRef(ctx(user), `x-${user.uid}`), cancelWrite(user)))
    }
  })

  it('subcontractor, client and super_admin cannot create or update on any branch', async () => {
    await seed('s1', ASSIGNED)
    await seedOpen('s2')
    await seedAnswered('s3')
    for (const user of NON_MEMBERS) {
      await assertFails(setDoc(rfiRef(ctx(user), `x-${user.uid}`), payload(user)))
      await assertFails(updateDoc(rfiRef(ctx(user), 's1'), edit(user, { title: 'Renamed' })))
      await assertFails(updateDoc(rfiRef(ctx(user), 's1'), raiseWrite(user)))
      await assertFails(updateDoc(rfiRef(ctx(user), 's2'), answerWrite(user)))
      await assertFails(updateDoc(rfiRef(ctx(user), 's2'), cancelWrite(user)))
      await assertFails(updateDoc(rfiRef(ctx(user), 's3'), closeWrite(user)))
    }
  })
})

// ── Tenant isolation ─────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('a company_admin of another company cannot read or write this register', async () => {
    await seed('t1')
    await assertFails(getDoc(rfiRef(ctx(USERS.other), 't1')))
    await assertFails(setDoc(rfiRef(ctx(USERS.other), 't2'), payload(USERS.other)))
    await assertFails(updateDoc(rfiRef(ctx(USERS.other), 't1'), edit(USERS.other, { title: 'Theirs' })))
  })

  it('a company member cannot read or write into another company path', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.admin), 't3', COMPANY_B), payload(USERS.admin)))
    await assertFails(getDoc(rfiRef(ctx(USERS.admin), 't3', COMPANY_B)))
  })

  it('unauthenticated access is denied entirely', async () => {
    await seed('t4')
    await assertFails(getDoc(rfiRef(anon(), 't4')))
    await assertFails(setDoc(rfiRef(anon(), 't5'), payload(USERS.admin)))
    await assertFails(deleteDoc(rfiRef(anon(), 't4')))
  })

  it('an authenticated user with NO membership document is denied', async () => {
    await seed('t6')
    const ghost = testEnv.authenticatedContext('u_ghost').firestore()
    await assertFails(getDoc(rfiRef(ghost, 't6')))
    await assertFails(setDoc(rfiRef(ghost, 't7'), payload({ uid: 'u_ghost' })))
  })
})

// ── Exact create shape ───────────────────────────────────────────────────────

describe('create shape', () => {
  it('rejects an unknown extra field', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'k1'), payload(USERS.pm, { costImpact: 1200 })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'k2'), payload(USERS.pm, { attachments: [] })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'k3'), payload(USERS.pm, { isAdmin: true })))
  })

  it('rejects a missing required field', async () => {
    for (const key of ['rfiNumber', 'status', 'title', 'question', 'raisedDate', 'raisedByName', 'referenceType', 'dueDate', 'answer', 'cancelReason', 'revision']) {
      const p = payload(USERS.pm)
      delete p[key]
      await assertFails(setDoc(rfiRef(ctx(USERS.pm), `m-${key}`), p))
    }
  })

  it('rejects wrong types', async () => {
    const bad = [
      { title: 42 }, { question: null }, { raisedByName: 7 }, { revision: '1' },
      { referenceType: 1 }, { dueDate: Timestamp.now() }, { raisedDate: Timestamp.now() },
    ]
    for (const [i, o] of bad.entries()) {
      await assertFails(setDoc(rfiRef(ctx(USERS.pm), `t-${i}`), payload(USERS.pm, o)))
    }
  })

  it('creates only as draft — open, answered, closed and cancelled are rejected', async () => {
    for (const status of ['open', 'answered', 'closed', 'cancelled', 'reopened', '']) {
      await assertFails(setDoc(rfiRef(ctx(USERS.pm), `st-${status || 'empty'}`), payload(USERS.pm, { status, ...ASSIGNED })))
    }
  })

  it('requires the RFI-#### number shape', async () => {
    for (const [i, n] of ['RFI-1', 'rfi-0001', 'PO-0001', '', 'RFI-000A'].entries()) {
      await assertFails(setDoc(rfiRef(ctx(USERS.pm), `num-${i}`), payload(USERS.pm, { rfiNumber: n })))
    }
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'num-ok'), payload(USERS.pm, { rfiNumber: 'RFI-10000' })))
  })

  it('rejects revision other than 1', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'v1'), payload(USERS.pm, { revision: 2 })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'v2'), payload(USERS.pm, { revision: 0 })))
  })

  it('requires createdBy == caller and server timestamps', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'cb1'), payload(USERS.pm, { createdBy: USERS.admin.uid })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'cb2'), payload(USERS.pm, { updatedBy: USERS.admin.uid })))
    for (const [i, clock] of CLIENT_CLOCKS.entries()) {
      await assertFails(setDoc(rfiRef(ctx(USERS.pm), `ck-${i}`), payload(USERS.pm, { createdAt: clock() })))
      await assertFails(setDoc(rfiRef(ctx(USERS.pm), `cu-${i}`), payload(USERS.pm, { updatedAt: clock() })))
    }
  })

  it('rejects every forged lifecycle stamp at create', async () => {
    const forged = [
      { raisedAt: serverTimestamp() }, { raisedBy: USERS.pm.uid },
      { answer: 'pre-answered' }, { answerDate: '2026-10-14' },
      { answeredAt: serverTimestamp() }, { answeredBy: USERS.pm.uid },
      { closeOutNote: 'done' }, { closedAt: serverTimestamp() }, { closedBy: USERS.pm.uid },
      { cancelReason: 'x' }, { cancelledAt: serverTimestamp() }, { cancelledBy: USERS.pm.uid },
    ]
    for (const [i, o] of forged.entries()) {
      await assertFails(setDoc(rfiRef(ctx(USERS.pm), `f-${i}`), payload(USERS.pm, o)))
    }
  })

  it('title and question: non-whitespace, bounded', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'q1'), payload(USERS.pm, { title: '' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'q2'), payload(USERS.pm, { title: '   ' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'q3'), payload(USERS.pm, { title: 'x'.repeat(201) })))
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'q4'), payload(USERS.pm, { title: 'x'.repeat(200) })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'q5'), payload(USERS.pm, { question: '\n\t' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'q6'), payload(USERS.pm, { question: 'x'.repeat(5001) })))
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'q7'), payload(USERS.pm, { question: 'x'.repeat(5000) })))
  })

  it('raisedByName: non-whitespace, bounded — but NOT verified against the profile', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'rb1'), payload(USERS.pm, { raisedByName: '' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'rb2'), payload(USERS.pm, { raisedByName: '  ' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'rb3'), payload(USERS.pm, { raisedByName: 'x'.repeat(121) })))
    // ⚠️ Documented client-only gap (Deferred Control 27): an arbitrary name is ACCEPTED.
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'rb4'), payload(USERS.pm, { raisedByName: 'Somebody Else' })))
  })

  it('raisedDate must be an ISO date; dueDate null or ISO >= raisedDate', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'rd1'), payload(USERS.pm, { raisedDate: '10/10/2026' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'rd2'), payload(USERS.pm, { raisedDate: '' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'rd3'), payload(USERS.pm, { dueDate: '2026-10-09' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'rd4'), payload(USERS.pm, { dueDate: 'soon' })))
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'rd5'), payload(USERS.pm, { dueDate: '2026-10-10' })))
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'rd6'), payload(USERS.pm, { dueDate: '2026-10-20' })))
  })

  it('⚠️ ACCEPTS an impossible calendar date of valid shape — rules have no calendar', async () => {
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'cal1'), payload(USERS.pm, { raisedDate: '2026-02-31' })))
  })

  it('assignee pair is both-or-neither; cost-code pair is both-or-neither', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'p1'), payload(USERS.pm, { assignedToContactId: 'c1', assignedToName: '' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'p2'), payload(USERS.pm, { assignedToContactId: null, assignedToName: 'Arch' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'p3'), payload(USERS.pm, { assignedToContactId: 'c1', assignedToName: '  ' })))
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'p4'), payload(USERS.pm, { assignedToContactId: 'c1', assignedToName: 'Arch' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'p5'), payload(USERS.pm, { costCodeId: 'cc1', costCodeName: '' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'p6'), payload(USERS.pm, { costCodeId: null, costCodeName: 'Concrete' })))
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'p7'), payload(USERS.pm, { costCodeId: 'cc1', costCodeName: '03-100 Concrete' })))
  })

  it('⚠️ ACCEPTS an assignee or cost code that names nothing — shape only', async () => {
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'gh1'), payload(USERS.pm, {
      assignedToContactId: 'no-such-contact', assignedToName: 'Ghost', costCodeId: 'no-such-code', costCodeName: 'Ghost',
    })))
  })

  it('⚠️ ACCEPTS a duplicate rfiNumber — rules cannot see siblings', async () => {
    await seed('dup1', { rfiNumber: 'RFI-0007' })
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'dup2'), payload(USERS.pm, { rfiNumber: 'RFI-0007' })))
  })
})

// ── References (existence-verified) ──────────────────────────────────────────

describe('reference', () => {
  it('none: all ids null and labels empty; stray ids/labels rejected', async () => {
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'n0'), payload(USERS.pm)))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'n1'), payload(USERS.pm, { referenceDrawingId: DRAWING_ID })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'n2'), payload(USERS.pm, { referenceRevisionId: REVISION_ID })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'n3'), payload(USERS.pm, { referenceDocumentId: DOCUMENT_ID })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'n4'), payload(USERS.pm, { referenceLabel: 'x' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'n5'), payload(USERS.pm, { referenceRevisionCode: 'A' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'n6'), payload(USERS.pm, { referenceType: 'photo' })))
  })

  it('drawing: valid master + nested revision is ACCEPTED', async () => {
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'dw0'), payload(USERS.pm, DRAWING_REF)))
  })

  it('drawing: master WITHOUT a revision is REJECTED', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw1'), payload(USERS.pm, { ...DRAWING_REF, referenceRevisionId: null })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw2'), payload(USERS.pm, { ...DRAWING_REF, referenceRevisionId: '' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw3'), payload(USERS.pm, { ...DRAWING_REF, referenceRevisionId: null, referenceRevisionCode: '' })))
  })

  it('drawing: nonexistent master is REJECTED', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw4'), payload(USERS.pm, { ...DRAWING_REF, referenceDrawingId: 'no-such-drawing' })))
  })

  it('drawing: nonexistent revision is REJECTED', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw5'), payload(USERS.pm, { ...DRAWING_REF, referenceRevisionId: 'no-such-rev' })))
  })

  it('drawing: a revision that exists under a DIFFERENT drawing is REJECTED', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw6'), payload(USERS.pm, { ...DRAWING_REF, referenceRevisionId: OTHER_REVISION_ID })))
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'dw7'), payload(USERS.pm, {
      ...DRAWING_REF, referenceDrawingId: OTHER_DRAWING_ID, referenceRevisionId: OTHER_REVISION_ID, referenceRevisionCode: '1',
    })))
  })

  it('drawing: a drawing in ANOTHER project of the same company is REJECTED', async () => {
    // Nothing is seeded in Project B, so the same ids do not resolve there.
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw8', COMPANY_A, PROJECT_B), payload(USERS.pm, DRAWING_REF)))
  })

  it('drawing: requires both frozen labels and rejects a stray document id', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw9'), payload(USERS.pm, { ...DRAWING_REF, referenceLabel: '' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw10'), payload(USERS.pm, { ...DRAWING_REF, referenceRevisionCode: ' ' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw11'), payload(USERS.pm, { ...DRAWING_REF, referenceLabel: 'x'.repeat(201) })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw12'), payload(USERS.pm, { ...DRAWING_REF, referenceRevisionCode: 'x'.repeat(41) })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'dw13'), payload(USERS.pm, { ...DRAWING_REF, referenceDocumentId: DOCUMENT_ID })))
  })

  it('⚠️ ACCEPTS a stale/incorrect frozen label — existence is checked, content is not', async () => {
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'dw14'), payload(USERS.pm, { ...DRAWING_REF, referenceLabel: 'Wrong Sheet', referenceRevisionCode: 'Z' })))
  })

  it('document: valid document is ACCEPTED; nonexistent is REJECTED', async () => {
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'doc0'), payload(USERS.pm, DOCUMENT_REF)))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'doc1'), payload(USERS.pm, { ...DOCUMENT_REF, referenceDocumentId: 'no-such-doc' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'doc2', COMPANY_A, PROJECT_B), payload(USERS.pm, DOCUMENT_REF)))
  })

  it('document: requires label; rejects drawing ids and a revision code', async () => {
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'doc3'), payload(USERS.pm, { ...DOCUMENT_REF, referenceLabel: '' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'doc4'), payload(USERS.pm, { ...DOCUMENT_REF, referenceDrawingId: DRAWING_ID })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'doc5'), payload(USERS.pm, { ...DOCUMENT_REF, referenceRevisionId: REVISION_ID })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'doc6'), payload(USERS.pm, { ...DOCUMENT_REF, referenceRevisionCode: 'A' })))
    await assertFails(setDoc(rfiRef(ctx(USERS.pm), 'doc7'), payload(USERS.pm, { ...DOCUMENT_REF, referenceDocumentId: '' })))
  })

  it('the reference is re-verified on a DRAFT EDIT', async () => {
    await seed('re1')
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 're1'), edit(USERS.pm, DRAWING_REF)))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 're1'), edit(USERS.pm, { ...DRAWING_REF, referenceRevisionId: 'no-such-rev' })))
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 're1'), edit(USERS.pm, DOCUMENT_REF)))
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 're1'), edit(USERS.pm, {
      referenceType: 'none', referenceDrawingId: null, referenceRevisionId: null, referenceDocumentId: null, referenceLabel: '', referenceRevisionCode: '',
    })))
  })
})

// ── Draft edit ───────────────────────────────────────────────────────────────

describe('draft edit', () => {
  it('may change the question block, cost code, assignee and due date', async () => {
    await seed('e1')
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.qs), 'e1'), edit(USERS.qs, {
      title: 'Revised title', question: 'Revised question', raisedDate: '2026-10-11',
      costCodeId: 'cc1', costCodeName: 'Concrete', ...ASSIGNED,
    })))
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.qs), 'e1'), edit(USERS.qs, {
      assignedToContactId: null, assignedToName: '', dueDate: null,
    })))
  })

  it('must keep the draft shape valid', async () => {
    await seed('e2')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e2'), edit(USERS.pm, { title: '' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e2'), edit(USERS.pm, { dueDate: '2026-10-01' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e2'), edit(USERS.pm, { assignedToContactId: 'c1' })))
  })

  it('cannot change the number, status, or core identity', async () => {
    await seed('e3')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e3'), edit(USERS.pm, { rfiNumber: 'RFI-0099' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e3'), edit(USERS.pm, { status: 'answered' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e3'), edit(USERS.pm, { createdBy: USERS.qs.uid })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e3'), edit(USERS.pm, { revision: 2 })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e3'), edit(USERS.pm, { createdAt: Timestamp.now() })))
  })

  it('cannot smuggle a raise or forge any stamp through an edit', async () => {
    await seed('e4', ASSIGNED)
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e4'), edit(USERS.pm, { title: 'x', status: 'open' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e4'), edit(USERS.pm, { title: 'x', status: 'open', raisedAt: serverTimestamp(), raisedBy: USERS.pm.uid })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e4'), edit(USERS.pm, { raisedAt: serverTimestamp() })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e4'), edit(USERS.pm, { answer: 'pre' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e4'), edit(USERS.pm, { cancelReason: 'x' })))
  })

  it('requires the update stamps', async () => {
    await seed('e5')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e5'), { title: 'No stamp' }))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e5'), { title: 'x', updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid }))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'e5'), { title: 'x', updatedAt: clock(), updatedBy: USERS.pm.uid }))
    }
  })
})

// ── Raise ────────────────────────────────────────────────────────────────────

describe('raise (draft → open)', () => {
  it('succeeds with assignee and due date, stamping the caller and server time', async () => {
    await seed('ra1', ASSIGNED)
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'ra1'), raiseWrite(USERS.pm)))
    const snap = await getDoc(rfiRef(ctx(USERS.pm), 'ra1'))
    expect(snap.data().status).toBe('open')
    expect(snap.data().raisedBy).toBe(USERS.pm.uid)
  })

  it('is BLOCKED without an assignee or without a due date', async () => {
    await seed('ra2', { dueDate: '2026-10-20' })
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'ra2'), raiseWrite(USERS.pm)))
    await seed('ra3', { assignedToContactId: 'c1', assignedToName: 'Arch' })
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'ra3'), raiseWrite(USERS.pm)))
    await seed('ra4')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'ra4'), raiseWrite(USERS.pm)))
  })

  it('cannot supply the assignee/due date in the SAME write as the raise', async () => {
    // The raise touches only status + raise stamps; the draft must already be ready.
    await seed('ra5')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'ra5'), raiseWrite(USERS.pm, ASSIGNED)))
  })

  it('cannot smuggle a question edit into the raise', async () => {
    await seed('ra6', ASSIGNED)
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'ra6'), raiseWrite(USERS.pm, { title: 'Changed on raise' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'ra6'), raiseWrite(USERS.pm, { costCodeId: 'cc', costCodeName: 'x' })))
  })

  it('requires raisedBy == caller and raisedAt == server time', async () => {
    await seed('ra7', ASSIGNED)
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'ra7'), raiseWrite(USERS.pm, { raisedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'ra7'), raiseWrite(USERS.pm, { raisedAt: clock() })))
    }
  })

  it('cannot raise from open, answered, closed or cancelled', async () => {
    await seedOpen('ra8'); await seedAnswered('ra9'); await seedClosed('ra10'); await seedCancelled('ra11')
    for (const id of ['ra8', 'ra9', 'ra10', 'ra11']) {
      await assertFails(updateDoc(rfiRef(ctx(USERS.pm), id), raiseWrite(USERS.pm)))
    }
  })
})

// ── Question freeze ──────────────────────────────────────────────────────────

describe('question block freeze after raise', () => {
  const FROZEN_EDITS = [
    { title: 'Changed' }, { question: 'Changed' }, { raisedDate: '2026-10-11' }, { raisedByName: 'Someone Else' },
    DRAWING_REF, DOCUMENT_REF, { referenceLabel: 'Renamed' },
    { costCodeId: 'cc1', costCodeName: 'Concrete' },
  ]

  it('every question-block field is immutable on open, answered, closed and cancelled', async () => {
    await seedOpen('fz1'); await seedAnswered('fz2'); await seedClosed('fz3'); await seedCancelled('fz4')
    for (const id of ['fz1', 'fz2', 'fz3', 'fz4']) {
      for (const change of FROZEN_EDITS) {
        await assertFails(updateDoc(rfiRef(ctx(USERS.admin), id), edit(USERS.admin, change)))
      }
    }
  })
})

// ── Open management edit ─────────────────────────────────────────────────────

describe('open management edit', () => {
  it('may change the assignee and due date while open', async () => {
    await seedOpen('om1')
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.qs), 'om1'), edit(USERS.qs, { assignedToContactId: 'c2', assignedToName: 'Eng Co' })))
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.qs), 'om1'), edit(USERS.qs, { dueDate: '2026-11-01' })))
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.qs), 'om1'), edit(USERS.qs, { assignedToContactId: 'c3', assignedToName: 'Third', dueDate: '2026-11-05' })))
  })

  it('management shape still applies while open', async () => {
    await seedOpen('om2')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'om2'), edit(USERS.pm, { assignedToContactId: 'c2', assignedToName: '' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'om2'), edit(USERS.pm, { dueDate: '2026-10-01' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'om2'), edit(USERS.pm, { dueDate: 'bad' })))
  })

  // ── Open-state invariant: assignee + due date may CHANGE but never CLEAR ──
  it('REGRESSION 1: open — reassign Contact A → Contact B is ALLOWED', async () => {
    await seedOpen('inv1', { assignedToContactId: 'contactA', assignedToName: 'Contact A' })
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'inv1'), edit(USERS.pm, { assignedToContactId: 'contactB', assignedToName: 'Contact B' })))
  })

  it('REGRESSION 2: open — change dueDate is ALLOWED', async () => {
    await seedOpen('inv2', { dueDate: '2026-10-20' })
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'inv2'), edit(USERS.pm, { dueDate: '2026-11-15' })))
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'inv2'), edit(USERS.pm, { dueDate: '2026-10-12' })))
  })

  it('REGRESSION 3: open — assignedToContactId → null is REJECTED', async () => {
    await seedOpen('inv3')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'inv3'), edit(USERS.pm, { assignedToContactId: null, assignedToName: '' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'inv3'), edit(USERS.pm, { assignedToContactId: null })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'inv3'), edit(USERS.pm, { assignedToContactId: '' , assignedToName: '' })))
  })

  it("REGRESSION 4: open — assignedToName → '' is REJECTED", async () => {
    await seedOpen('inv4')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'inv4'), edit(USERS.pm, { assignedToName: '' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'inv4'), edit(USERS.pm, { assignedToName: '   ' })))
  })

  it('REGRESSION 5: open — dueDate → null is REJECTED', async () => {
    await seedOpen('inv5')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'inv5'), edit(USERS.pm, { dueDate: null })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'inv5'), edit(USERS.pm, { assignedToContactId: 'c2', assignedToName: 'Eng', dueDate: null })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'inv5'), edit(USERS.pm, { assignedToContactId: null, assignedToName: '', dueDate: null })))
  })

  it('REGRESSION 6: open — a valid edit preserving both assignment fields + dueDate is ALLOWED', async () => {
    await seedOpen('inv6')
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'inv6'), edit(USERS.pm, { assignedToContactId: 'contactB', assignedToName: 'Contact B', dueDate: '2026-12-01' })))
    const snap = await getDoc(rfiRef(ctx(USERS.pm), 'inv6'))
    expect(snap.data().assignedToContactId).toBe('contactB')
    expect(snap.data().assignedToName).toBe('Contact B')
    expect(snap.data().dueDate).toBe('2026-12-01')
  })

  it('REGRESSION 7: draft — may still exist and be edited WITHOUT an assignee or due date', async () => {
    await assertSucceeds(setDoc(rfiRef(ctx(USERS.pm), 'inv7'), payload(USERS.pm)))
    await seed('inv7b', ASSIGNED)
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'inv7b'), edit(USERS.pm, { assignedToContactId: null, assignedToName: '', dueDate: null })))
  })

  it('REGRESSION 8: draft → open still requires BOTH assignee and due date', async () => {
    await seed('inv8a', { dueDate: '2026-10-20' })
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'inv8a'), raiseWrite(USERS.pm)))
    await seed('inv8b', { assignedToContactId: 'c1', assignedToName: 'Arch' })
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'inv8b'), raiseWrite(USERS.pm)))
    await seed('inv8c', ASSIGNED)
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'inv8c'), raiseWrite(USERS.pm)))
  })

  it('is NOT available once answered, closed or cancelled', async () => {
    await seedAnswered('om4'); await seedClosed('om5'); await seedCancelled('om6')
    for (const id of ['om4', 'om5', 'om6']) {
      await assertFails(updateDoc(rfiRef(ctx(USERS.admin), id), edit(USERS.admin, { dueDate: '2026-12-01' })))
      await assertFails(updateDoc(rfiRef(ctx(USERS.admin), id), edit(USERS.admin, { assignedToContactId: 'c9', assignedToName: 'New' })))
    }
  })

  it('cannot forge a stamp or change status through the management branch', async () => {
    await seedOpen('om7')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'om7'), edit(USERS.pm, { dueDate: '2026-11-01', answeredAt: serverTimestamp() })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'om7'), edit(USERS.pm, { dueDate: '2026-11-01', status: 'closed' })))
  })
})

// ── Answer ───────────────────────────────────────────────────────────────────

describe('answer (open → answered)', () => {
  it('succeeds with a real answer and a valid answer date', async () => {
    await seedOpen('an1')
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.qs), 'an1'), answerWrite(USERS.qs)))
    const snap = await getDoc(rfiRef(ctx(USERS.qs), 'an1'))
    expect(snap.data().status).toBe('answered')
    expect(snap.data().answeredBy).toBe(USERS.qs.uid)
  })

  it('rejects an empty or whitespace-only answer, and one over 5000', async () => {
    await seedOpen('an2')
    for (const bad of ['', ' ', '\t', '\n\n', 'x'.repeat(5001)]) {
      await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an2'), answerWrite(USERS.pm, { answer: bad })))
    }
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'an2'), answerWrite(USERS.pm, { answer: 'x'.repeat(5000) })))
  })

  it('answerDate must be ISO and >= raisedDate; equal is fine', async () => {
    await seedOpen('an3', { raisedDate: '2026-10-10' })
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an3'), answerWrite(USERS.pm, { answerDate: '2026-10-09' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an3'), answerWrite(USERS.pm, { answerDate: null })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an3'), answerWrite(USERS.pm, { answerDate: 'today' })))
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'an3'), answerWrite(USERS.pm, { answerDate: '2026-10-10' })))
  })

  it('cannot answer from draft, answered, closed or cancelled', async () => {
    await seed('an4', ASSIGNED); await seedAnswered('an5'); await seedClosed('an6'); await seedCancelled('an7')
    for (const id of ['an4', 'an5', 'an6', 'an7']) {
      await assertFails(updateDoc(rfiRef(ctx(USERS.pm), id), answerWrite(USERS.pm)))
    }
  })

  it('cannot re-answer (answer text is immutable once answered)', async () => {
    await seedAnswered('an8')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an8'), edit(USERS.pm, { answer: 'Changed my mind' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an8'), edit(USERS.pm, { answerDate: '2026-10-15' })))
  })

  it('no unrelated change rides along with the answer', async () => {
    await seedOpen('an9')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an9'), answerWrite(USERS.pm, { dueDate: '2026-12-01' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an9'), answerWrite(USERS.pm, { title: 'Changed' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an9'), answerWrite(USERS.pm, { closedAt: serverTimestamp() })))
  })

  it('requires answeredBy == caller and answeredAt == server time', async () => {
    await seedOpen('an10')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an10'), answerWrite(USERS.pm, { answeredBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'an10'), answerWrite(USERS.pm, { answeredAt: clock() })))
    }
  })
})

// ── Close ────────────────────────────────────────────────────────────────────

describe('close (answered → closed)', () => {
  it('succeeds with or without a close-out note', async () => {
    await seedAnswered('cl1'); await seedAnswered('cl2')
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'cl1'), closeWrite(USERS.pm)))
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'cl2'), closeWrite(USERS.pm, { closeOutNote: 'Answer insufficient — raised RFI-0009 instead' })))
  })

  it('bounds the close-out note at 1000', async () => {
    await seedAnswered('cl3')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'cl3'), closeWrite(USERS.pm, { closeOutNote: 'x'.repeat(1001) })))
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.pm), 'cl3'), closeWrite(USERS.pm, { closeOutNote: 'x'.repeat(1000) })))
  })

  it('cannot close from draft, open, closed or cancelled', async () => {
    await seed('cl4', ASSIGNED); await seedOpen('cl5'); await seedClosed('cl6'); await seedCancelled('cl7')
    for (const id of ['cl4', 'cl5', 'cl6', 'cl7']) {
      await assertFails(updateDoc(rfiRef(ctx(USERS.pm), id), closeWrite(USERS.pm)))
    }
  })

  it('no unrelated change rides along; stamps must be caller and server time', async () => {
    await seedAnswered('cl8')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'cl8'), closeWrite(USERS.pm, { answer: 'Rewritten' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'cl8'), closeWrite(USERS.pm, { dueDate: '2026-12-01' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'cl8'), closeWrite(USERS.pm, { closedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'cl8'), closeWrite(USERS.pm, { closedAt: clock() })))
    }
  })
})

// ── Cancel ───────────────────────────────────────────────────────────────────

describe('cancel (draft/open → cancelled)', () => {
  it('succeeds from draft and from open with a real reason', async () => {
    await seed('cn1'); await seedOpen('cn2')
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.qs), 'cn1'), cancelWrite(USERS.qs)))
    await assertSucceeds(updateDoc(rfiRef(ctx(USERS.qs), 'cn2'), cancelWrite(USERS.qs, '  Duplicate  ')))
  })

  it('is REJECTED from answered — close it with a note instead', async () => {
    await seedAnswered('cn3')
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'cn3'), cancelWrite(USERS.admin)))
  })

  it('is REJECTED from closed and cancelled', async () => {
    await seedClosed('cn4'); await seedCancelled('cn5')
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'cn4'), cancelWrite(USERS.admin)))
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'cn5'), cancelWrite(USERS.admin, 'Again')))
  })

  it('rejects an empty or whitespace-only reason from BOTH draft and open, and one over 500', async () => {
    await seed('cn6'); await seedOpen('cn7')
    for (const id of ['cn6', 'cn7']) {
      for (const bad of ['', ' ', '\t', '\n', 'x'.repeat(501)]) {
        await assertFails(updateDoc(rfiRef(ctx(USERS.pm), id), cancelWrite(USERS.pm, bad)))
      }
    }
  })

  it('no unrelated change rides along; stamps must be caller and server time', async () => {
    await seedOpen('cn8')
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'cn8'), cancelWrite(USERS.pm, 'dup', { title: 'Changed' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'cn8'), cancelWrite(USERS.pm, 'dup', { dueDate: '2026-12-01' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'cn8'), cancelWrite(USERS.pm, 'dup', { cancelledBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(rfiRef(ctx(USERS.pm), 'cn8'), cancelWrite(USERS.pm, 'dup', { cancelledAt: clock() })))
    }
  })
})

// ── Terminality ──────────────────────────────────────────────────────────────

describe('terminal states', () => {
  it('closed: every update is rejected — including an identical-data rewrite', async () => {
    await seedClosed('tm1')
    const snap = await getDoc(rfiRef(ctx(USERS.admin), 'tm1'))
    const data = snap.data()
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'tm1'), edit(USERS.admin, { closeOutNote: 'Amended' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'tm1'), edit(USERS.admin, { status: 'open' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'tm1'), edit(USERS.admin, { status: 'answered' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'tm1'), cancelWrite(USERS.admin)))
    await assertFails(setDoc(rfiRef(ctx(USERS.admin), 'tm1'), { ...data, updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid }))
  })

  it('cancelled: every update is rejected', async () => {
    await seedCancelled('tm2')
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'tm2'), edit(USERS.admin, { cancelReason: 'Amended' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'tm2'), edit(USERS.admin, { status: 'draft' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'tm2'), edit(USERS.admin, { status: 'open' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'tm2'), raiseWrite(USERS.admin)))
  })

  it('there is no reopen from answered', async () => {
    await seedAnswered('tm3')
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'tm3'), edit(USERS.admin, { status: 'open' })))
    await assertFails(updateDoc(rfiRef(ctx(USERS.admin), 'tm3'), edit(USERS.admin, {
      status: 'open', answer: '', answerDate: null, answeredAt: null, answeredBy: null,
    })))
  })
})

// ── Delete ───────────────────────────────────────────────────────────────────

describe('delete', () => {
  it('is denied for every identity at every status', async () => {
    await seed('dl-draft'); await seedOpen('dl-open'); await seedAnswered('dl-answered')
    await seedClosed('dl-closed'); await seedCancelled('dl-cancelled')
    for (const id of ['dl-draft', 'dl-open', 'dl-answered', 'dl-closed', 'dl-cancelled']) {
      for (const user of Object.values(USERS)) {
        await assertFails(deleteDoc(rfiRef(ctx(user), id)))
      }
      await assertFails(deleteDoc(rfiRef(anon(), id)))
    }
  })
})

// ── Per-project counter ──────────────────────────────────────────────────────

describe('project RFI counter', () => {
  it('member roles can read, create and update the counter in their own project', async () => {
    for (const user of MEMBERS) {
      await assertSucceeds(setDoc(ctrRef(ctx(user), COMPANY_A, PROJECT_A), { next: 2 }, { merge: true }))
      await assertSucceeds(getDoc(ctrRef(ctx(user), COMPANY_A, PROJECT_A)))
      await assertSucceeds(updateDoc(ctrRef(ctx(user), COMPANY_A, PROJECT_A), { next: 3 }))
    }
  })

  it('projects number independently — Project B has its own counter document', async () => {
    await assertSucceeds(setDoc(ctrRef(ctx(USERS.pm), COMPANY_A, PROJECT_A), { next: 5 }))
    await assertSucceeds(setDoc(ctrRef(ctx(USERS.pm), COMPANY_A, PROJECT_B), { next: 1 }))
    const a = await getDoc(ctrRef(ctx(USERS.pm), COMPANY_A, PROJECT_A))
    const b = await getDoc(ctrRef(ctx(USERS.pm), COMPANY_A, PROJECT_B))
    expect(a.data().next).toBe(5)
    expect(b.data().next).toBe(1)
  })

  it('subcontractor, client and super_admin cannot read or write the counter', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(ctrRef(c.firestore()), { next: 4 })
    })
    for (const user of NON_MEMBERS) {
      await assertFails(getDoc(ctrRef(ctx(user))))
      await assertFails(updateDoc(ctrRef(ctx(user)), { next: 5 }))
    }
  })

  it('cross-company, ghost and unauthenticated access is denied', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(ctrRef(c.firestore()), { next: 4 })
    })
    await assertFails(getDoc(ctrRef(ctx(USERS.other))))
    await assertFails(setDoc(ctrRef(ctx(USERS.other)), { next: 1 }))
    await assertFails(setDoc(ctrRef(ctx(USERS.admin), COMPANY_B, PROJECT_A), { next: 1 }))
    await assertFails(getDoc(ctrRef(testEnv.authenticatedContext('u_ghost').firestore())))
    await assertFails(getDoc(ctrRef(anon())))
    await assertFails(setDoc(ctrRef(anon()), { next: 1 }))
  })

  it('the counter can never be deleted', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(ctrRef(c.firestore()), { next: 4 })
    })
    for (const user of Object.values(USERS)) await assertFails(deleteDoc(ctrRef(ctx(user))))
  })

  it('⚠️ ACCEPTS an arbitrary counter value — +1 semantics are NOT enforced (Deferred Control 6)', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(ctrRef(c.firestore()), { next: 4 })
    })
    await assertSucceeds(updateDoc(ctrRef(ctx(USERS.pm)), { next: 1 }))
    await assertSucceeds(updateDoc(ctrRef(ctx(USERS.pm)), { next: 9999 }))
  })
})
