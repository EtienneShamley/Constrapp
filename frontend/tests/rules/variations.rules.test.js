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

// ── Variations Security Rules — emulator tests (ADR-18 · ADR-34) ─────────────
//
// The first dedicated suite for the `variations` block. It does two things:
//
//   1. PINS THE EXISTING POSTURE — reads and writes for the three financial
//      roles only; subcontractor, client, super_admin, another company and
//      anonymous denied; delete blocked at every status. Lifecycle legality
//      and post-submit immutability are NOT rules-enforced on this collection
//      (docs/SECURITY.md → Deferred Controls 1 and 2) and this suite proves
//      that has NOT changed: a direct status forgery and a post-approval
//      amount rewrite are still ACCEPTED.
//
//   2. PROVES THE ORIGINATING-RFI LINK (ADR-34) — the ONE rules-enforced
//      content control on a variation:
//        · the originRfi* triple is all-null (or absent, legacy) or fully
//          populated and verified against a same-project RFI that exists and
//          is open/answered/closed, with matching number and title snapshots
//        · it may be added/changed/removed only while the stored status is
//          'draft'; from 'submitted' onward it is immutable
//        · an UNCHANGED triple is NEVER revalidated — the CRITICAL HISTORICAL
//          case: link an open RFI, cancel the RFI, and every unrelated
//          variation write must still pass
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const PROJECT_B = 'projectB'   // a second project in Company A

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

// Seeded RFIs. Titles are what the snapshots must match EXACTLY.
const RFIS = {
  open:      { id: 'rfiOpen',      rfiNumber: 'RFI-0001', title: 'Revised structural steel connection', status: 'open' },
  answered:  { id: 'rfiAnswered',  rfiNumber: 'RFI-0002', title: 'Slab thickness at grid C',            status: 'answered' },
  closed:    { id: 'rfiClosed',    rfiNumber: 'RFI-0003', title: 'Lintel bearing length',                status: 'closed' },
  draft:     { id: 'rfiDraft',     rfiNumber: 'RFI-0004', title: 'Unraised question',                    status: 'draft' },
  cancelled: { id: 'rfiCancelled', rfiNumber: 'RFI-0005', title: 'Duplicate question',                   status: 'cancelled' },
}
const RFI_IN_PROJECT_B  = { id: 'rfiProjB', rfiNumber: 'RFI-0001', title: 'Project B question', status: 'open' }
const RFI_IN_COMPANY_B  = { id: 'rfiCompB', rfiNumber: 'RFI-0001', title: 'Company B question', status: 'open' }

let testEnv

const varsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/variations`
const rfisPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/rfis`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const varRef = (db, id, companyId = COMPANY_A, projectId = PROJECT_A) =>
  doc(db, varsPath(companyId, projectId), id)

// The link triple for a seeded RFI, exactly as normaliseOriginRfi() builds it.
const link = (r) => ({ originRfiId: r.id, originRfiNumber: r.rfiNumber, originRfiTitle: r.title })
const UNLINKED = { originRfiId: null, originRfiNumber: null, originRfiTitle: null }

const LINE = {
  costCodeId: 'cc1', costCodeName: '03-100 Concrete', description: 'Extra steel',
  submittedAmount: 1000, submittedGst: 100, approvedAmount: null, approvedGst: null,
  poLineIndex: null, taxCode: 'gst',
}

// A valid draft supplier variation, exactly as hooks/useVariations.jsx writes it.
function payload(user, overrides = {}) {
  return {
    variationNumber: 'SV-0001',
    variationType: 'supplier',
    status: 'draft',
    title: 'Additional steel',
    description: '',
    reason: '',
    clientId: null, clientName: null, clientRef: null,
    supplierId: 'contactS1', supplierName: 'Steel Co', supplierRef: '',
    poId: null, poNumber: null,
    ...UNLINKED,
    lineItems: [LINE],
    submittedSubtotal: 1000, submittedGst: 100, submittedTotal: 1100,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null,
    forecastAmount: null,
    identifiedDate: '2026-10-10', submittedDate: '', responseDueDate: '', approvedDate: '', effectiveDate: '',
    currency: 'AUD',
    revision: 1,
    notes: '', assessmentNotes: '',
    submittedAt: null, submittedBy: null,
    approvedAt: null, approvedBy: null,
    rejectedAt: null, rejectedBy: null,
    withdrawnAt: null, withdrawnBy: null,
    attachments: [], externalRefs: {}, supersededByVariationId: null,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    ...overrides,
  }
}

// Seeds a variation directly, bypassing rules — the arrange step for updates.
async function seed(id, overrides = {}, user = USERS.admin) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), varsPath(), id), {
      ...payload(user),
      createdAt: Timestamp.now(),
      ...overrides,
    })
  })
}

// A LEGACY document: the originRfi* keys do not exist at all.
async function seedLegacy(id, overrides = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const data = { ...payload(USERS.admin), createdAt: Timestamp.now(), ...overrides }
    delete data.originRfiId
    delete data.originRfiNumber
    delete data.originRfiTitle
    await setDoc(doc(c.firestore(), varsPath(), id), data)
  })
}

async function seedRfi(r, companyId = COMPANY_A, projectId = PROJECT_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), rfisPath(companyId, projectId), r.id), {
      rfiNumber: r.rfiNumber, status: r.status, title: r.title,
      question: 'Which governs?', raisedDate: '2026-10-10', raisedByName: 'Sam Site',
      referenceType: 'none', referenceDrawingId: null, referenceRevisionId: null, referenceDocumentId: null,
      referenceLabel: '', referenceRevisionCode: '', costCodeId: null, costCodeName: '',
      assignedToContactId: 'contact1', assignedToName: 'Arch Co', dueDate: '2026-10-20',
      raisedAt: null, raisedBy: null, answer: '', answerDate: null, answeredAt: null, answeredBy: null,
      closeOutNote: '', closedAt: null, closedBy: null, cancelReason: '', cancelledAt: null, cancelledBy: null,
      revision: 1, createdAt: Timestamp.now(), createdBy: USERS.admin.uid,
      updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
    })
  })
}

// Flips a seeded RFI's status directly (the arrange step for the historical case).
async function setRfiStatus(r, status) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), rfisPath(), r.id), { status })
  })
}

// The write shapes the app performs (hooks/useVariations.jsx).
const submitWrite = (user) => ({
  status: 'submitted', submittedDate: '2026-10-11', submittedAt: serverTimestamp(), submittedBy: user.uid,
})
const approveWrite = (user) => ({
  status: 'approved',
  lineItems: [{ ...LINE, approvedAmount: 900, approvedGst: 90 }],
  approvedSubtotal: 900, approvedGst: 90, approvedTotal: 990,
  assessmentNotes: 'Negotiated', approvedDate: '2026-10-12', effectiveDate: '2026-10-12',
  approvedAt: serverTimestamp(), approvedBy: user.uid,
})
const rejectWrite   = (user) => ({ status: 'rejected',  rejectedAt: serverTimestamp(),  rejectedBy: user.uid })
const withdrawWrite = (user) => ({ status: 'withdrawn', withdrawnAt: serverTimestamp(), withdrawnBy: user.uid })
const draftEdit = () => ({ title: 'Additional steel (revised)', notes: 'Edited', responseDueDate: '2026-10-30' })

const SUBMITTED = { status: 'submitted', submittedDate: '2026-10-11', submittedAt: Timestamp.now(), submittedBy: USERS.admin.uid }
const APPROVED  = { ...SUBMITTED, status: 'approved', approvedSubtotal: 900, approvedGst: 90, approvedTotal: 990, approvedAt: Timestamp.now(), approvedBy: USERS.admin.uid }
const REJECTED  = { ...SUBMITTED, status: 'rejected',  rejectedAt: Timestamp.now(),  rejectedBy: USERS.admin.uid }
const WITHDRAWN = { status: 'withdrawn', withdrawnAt: Timestamp.now(), withdrawnBy: USERS.admin.uid }

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
  })
  for (const r of Object.values(RFIS)) await seedRfi(r)
  await seedRfi(RFI_IN_PROJECT_B, COMPANY_A, PROJECT_B)
  await seedRfi(RFI_IN_COMPANY_B, COMPANY_B, PROJECT_A)
})

// ── Role / tenant baseline ───────────────────────────────────────────────────

describe('read and write matrix (existing posture, pinned)', () => {
  it.each(MEMBERS.map(u => [u.role, u]))('%s can read', async (_role, user) => {
    await seed('v1')
    await assertSucceeds(getDoc(varRef(ctx(user), 'v1')))
  })

  it.each(MEMBERS.map(u => [u.role, u]))('%s can create an unlinked draft', async (_role, user) => {
    await assertSucceeds(setDoc(varRef(ctx(user), 'v1'), payload(user)))
  })

  it.each(MEMBERS.map(u => [u.role, u]))('%s can edit a draft', async (_role, user) => {
    await seed('v1')
    await assertSucceeds(updateDoc(varRef(ctx(user), 'v1'), draftEdit()))
  })

  it.each(NON_MEMBERS.map(u => [u.role, u]))('%s cannot read', async (_role, user) => {
    await seed('v1')
    await assertFails(getDoc(varRef(ctx(user), 'v1')))
  })

  it.each(NON_MEMBERS.map(u => [u.role, u]))('%s cannot create', async (_role, user) => {
    await assertFails(setDoc(varRef(ctx(user), 'v1'), payload(user)))
  })

  it.each(NON_MEMBERS.map(u => [u.role, u]))('%s cannot update', async (_role, user) => {
    await seed('v1')
    await assertFails(updateDoc(varRef(ctx(user), 'v1'), draftEdit()))
  })

  it('unauthenticated cannot read, create or update', async () => {
    await seed('v1')
    await assertFails(getDoc(varRef(anon(), 'v1')))
    await assertFails(setDoc(varRef(anon(), 'v2'), payload(USERS.admin)))
    await assertFails(updateDoc(varRef(anon(), 'v1'), draftEdit()))
  })
})

describe('tenant isolation', () => {
  it('a company_admin of another company cannot read, create or update', async () => {
    await seed('v1')
    await assertFails(getDoc(varRef(ctx(USERS.other), 'v1')))
    await assertFails(setDoc(varRef(ctx(USERS.other), 'v2'), payload(USERS.other)))
    await assertFails(updateDoc(varRef(ctx(USERS.other), 'v1'), draftEdit()))
  })

  it('a member cannot write into another company\'s project path', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1', COMPANY_B, PROJECT_A), payload(USERS.admin)))
  })
})

describe('delete', () => {
  it.each(['draft', 'submitted', 'approved', 'rejected', 'withdrawn'])('blocked at %s for every role', async (status) => {
    await seed('v1', { status })
    for (const user of [...MEMBERS, ...NON_MEMBERS, USERS.other]) {
      await assertFails(deleteDoc(varRef(ctx(user), 'v1')))
    }
    await assertFails(deleteDoc(varRef(anon(), 'v1')))
  })
})

describe('what is deliberately NOT enforced (Deferred Controls 1 and 2 — unchanged by ADR-34)', () => {
  it('a direct status forgery (draft → approved) is still accepted', async () => {
    await seed('v1')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'v1'), { status: 'approved' }))
  })

  it('rewriting approved amounts on an approved variation is still accepted', async () => {
    await seed('v1', APPROVED)
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'v1'), { approvedSubtotal: 1, approvedTotal: 1.1, title: 'Rewritten' }))
  })
})

// ── Create ───────────────────────────────────────────────────────────────────

describe('create — originating RFI', () => {
  it('unlinked (explicit null triple) allowed', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, UNLINKED)))
  })

  it('legacy client shape with the keys ABSENT is still allowed', async () => {
    const p = payload(USERS.admin)
    delete p.originRfiId
    delete p.originRfiNumber
    delete p.originRfiTitle
    await assertSucceeds(setDoc(varRef(ctx(USERS.admin), 'v1'), p))
  })

  it.each([['open', RFIS.open], ['answered', RFIS.answered], ['closed', RFIS.closed]])(
    'a same-project %s RFI with matching snapshots is allowed', async (_s, r) => {
      await assertSucceeds(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, link(r))))
    })

  it('works for a client variation too', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.pm), 'v1'), payload(USERS.pm, {
      variationNumber: 'CV-0001', variationType: 'client',
      clientId: 'contactC1', clientName: 'Owner Pty Ltd', clientRef: '',
      supplierId: null, supplierName: null, supplierRef: null,
      ...link(RFIS.answered),
    })))
  })

  it('every financial role can link', async () => {
    for (const user of MEMBERS) {
      await assertSucceeds(setDoc(varRef(ctx(user), `v_${user.uid}`), payload(user, link(RFIS.open))))
    }
  })

  it('a draft RFI is denied', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, link(RFIS.draft))))
  })

  it('a cancelled RFI is denied', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, link(RFIS.cancelled))))
  })

  it('a nonexistent RFI is denied', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, {
      originRfiId: 'nope', originRfiNumber: 'RFI-0099', originRfiTitle: 'Ghost',
    })))
  })

  it('an RFI from another project of the same company is denied', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, link(RFI_IN_PROJECT_B))))
  })

  it('an RFI from another company is denied (even with a matching number/title)', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, link(RFI_IN_COMPANY_B))))
  })

  it.each([
    ['id only',            { originRfiId: RFIS.open.id, originRfiNumber: null, originRfiTitle: null }],
    ['id + number only',   { originRfiId: RFIS.open.id, originRfiNumber: RFIS.open.rfiNumber, originRfiTitle: null }],
    ['number only',        { originRfiId: null, originRfiNumber: RFIS.open.rfiNumber, originRfiTitle: null }],
    ['title only',         { originRfiId: null, originRfiNumber: null, originRfiTitle: RFIS.open.title }],
    ['number + title, no id', { originRfiId: null, originRfiNumber: RFIS.open.rfiNumber, originRfiTitle: RFIS.open.title }],
    ['empty-string id',    { originRfiId: '', originRfiNumber: RFIS.open.rfiNumber, originRfiTitle: RFIS.open.title }],
    ['numeric id',         { originRfiId: 42, originRfiNumber: RFIS.open.rfiNumber, originRfiTitle: RFIS.open.title }],
  ])('a partial or malformed triple is denied — %s', async (_label, triple) => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, triple)))
  })

  it('a wrong number snapshot is denied', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, { ...link(RFIS.open), originRfiNumber: 'RFI-0002' })))
  })

  it('a wrong title snapshot is denied — including a trimmed or re-cased copy', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, { ...link(RFIS.open), originRfiTitle: 'Something else' })))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, { ...link(RFIS.open), originRfiTitle: RFIS.open.title + ' ' })))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, { ...link(RFIS.open), originRfiTitle: RFIS.open.title.toUpperCase() })))
  })

  it('a non-string snapshot is denied', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, { ...link(RFIS.open), originRfiTitle: 7 })))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, { ...link(RFIS.open), originRfiNumber: ['RFI-0001'] })))
  })

  it('the link never writes anything onto the RFI', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.admin), 'v1'), payload(USERS.admin, link(RFIS.open))))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const snap = await getDoc(doc(c.firestore(), rfisPath(), RFIS.open.id))
      const data = snap.data()
      expect(data.variationId).toBeUndefined()
      expect(data.variationIds).toBeUndefined()
      expect(data.linkedVariations).toBeUndefined()
      expect(Object.keys(data)).toHaveLength(34)
    })
  })
})

// ── Draft update ─────────────────────────────────────────────────────────────

describe('draft update — originating RFI', () => {
  it('add a valid link to an unlinked draft', async () => {
    await seed('v1')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'v1'), link(RFIS.open)))
  })

  it('add a valid link to a LEGACY draft (keys absent)', async () => {
    await seedLegacy('v1')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'v1'), link(RFIS.closed)))
  })

  it('change a link to another eligible RFI', async () => {
    await seed('v1', link(RFIS.open))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'v1'), link(RFIS.answered)))
  })

  it('remove a link (explicit null triple)', async () => {
    await seed('v1', link(RFIS.open))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), UNLINKED))
  })

  it('an unrelated draft edit with an unchanged link is allowed', async () => {
    await seed('v1', link(RFIS.open))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), draftEdit()))
  })

  it('an unrelated draft edit that re-sends the identical triple is allowed', async () => {
    await seed('v1', link(RFIS.open))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...draftEdit(), ...link(RFIS.open) }))
  })

  it('a legacy draft edit that explicitly writes the null triple is allowed (absent == null)', async () => {
    await seedLegacy('v1')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...draftEdit(), ...UNLINKED }))
  })

  it('changing to a draft RFI is denied', async () => {
    await seed('v1')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), link(RFIS.draft)))
  })

  it('changing to a cancelled RFI is denied', async () => {
    await seed('v1')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), link(RFIS.cancelled)))
  })

  it('changing to a nonexistent, other-project or other-company RFI is denied', async () => {
    await seed('v1')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { originRfiId: 'nope', originRfiNumber: 'RFI-0099', originRfiTitle: 'Ghost' }))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), link(RFI_IN_PROJECT_B)))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), link(RFI_IN_COMPANY_B)))
  })

  it('changing only the number or title snapshot (id unchanged) is denied — snapshots must match', async () => {
    await seed('v1', link(RFIS.open))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { originRfiNumber: 'RFI-0009' }))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { originRfiTitle: 'Rewritten' }))
  })

  it('changing the id but keeping the old snapshots is denied', async () => {
    await seed('v1', link(RFIS.open))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { originRfiId: RFIS.answered.id }))
  })

  it('a partial removal (clearing only the id) is denied', async () => {
    await seed('v1', link(RFIS.open))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { originRfiId: null }))
  })
})

// ── CRITICAL HISTORICAL CASE ─────────────────────────────────────────────────
//
// An RFI cancelled AFTER it was linked must not poison the variation. Only a
// CHANGE to the triple is validated; an unchanged triple is never re-checked.

describe('historical link survives a later RFI cancellation', () => {
  it('unrelated draft edit still allowed after the linked RFI is cancelled', async () => {
    await seed('v1', link(RFIS.open))
    await setRfiStatus(RFIS.open, 'cancelled')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), draftEdit()))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...draftEdit(), ...link(RFIS.open) }))
  })

  it('every lifecycle transition still allowed after the linked RFI is cancelled', async () => {
    await seed('v1', link(RFIS.open))
    await setRfiStatus(RFIS.open, 'cancelled')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), submitWrite(USERS.admin)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm),    'v1'), approveWrite(USERS.pm)))

    await seed('v2', link(RFIS.answered))
    await setRfiStatus(RFIS.answered, 'cancelled')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'v2'), withdrawWrite(USERS.qs)))

    await seed('v3', { ...link(RFIS.closed), ...SUBMITTED })
    await setRfiStatus(RFIS.closed, 'cancelled')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v3'), rejectWrite(USERS.admin)))
  })

  it('the stored link is untouched by those writes', async () => {
    await seed('v1', link(RFIS.open))
    await setRfiStatus(RFIS.open, 'cancelled')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), submitWrite(USERS.admin)))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const data = (await getDoc(doc(c.firestore(), varsPath(), 'v1'))).data()
      expect(data.originRfiId).toBe(RFIS.open.id)
      expect(data.originRfiNumber).toBe(RFIS.open.rfiNumber)
      expect(data.originRfiTitle).toBe(RFIS.open.title)
      expect(data.status).toBe('submitted')
    })
  })

  it('but CHANGING the link to that now-cancelled RFI is denied', async () => {
    await seed('v1', link(RFIS.answered))
    await setRfiStatus(RFIS.open, 'cancelled')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), link(RFIS.open)))
    // ...and re-linking the cancelled one after removing it is denied too.
    await seed('v2', link(RFIS.open))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v2'), UNLINKED))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v2'), link(RFIS.open)))
  })

  it('removing the historical link from a draft remains allowed', async () => {
    await seed('v1', link(RFIS.open))
    await setRfiStatus(RFIS.open, 'cancelled')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), UNLINKED))
  })
})

// ── Freeze after draft ───────────────────────────────────────────────────────

describe('freeze — originRfi* immutable once the variation has left draft', () => {
  const FROZEN = [
    ['submitted', SUBMITTED],
    ['approved',  APPROVED],
    ['rejected',  REJECTED],
    ['withdrawn', WITHDRAWN],
  ]

  it.each(FROZEN)('%s: cannot add a link', async (_s, state) => {
    await seed('v1', state)
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), link(RFIS.open)))
  })

  it.each(FROZEN)('%s: cannot add a link to a legacy document either', async (_s, state) => {
    await seedLegacy('v1', state)
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), link(RFIS.open)))
  })

  it.each(FROZEN)('%s: cannot remove a link', async (_s, state) => {
    await seed('v1', { ...link(RFIS.open), ...state })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), UNLINKED))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { originRfiId: null }))
  })

  it.each(FROZEN)('%s: cannot change the id', async (_s, state) => {
    await seed('v1', { ...link(RFIS.open), ...state })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), link(RFIS.answered)))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { originRfiId: RFIS.answered.id }))
  })

  it.each(FROZEN)('%s: cannot change the number snapshot', async (_s, state) => {
    await seed('v1', { ...link(RFIS.open), ...state })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { originRfiNumber: 'RFI-0002' }))
  })

  it.each(FROZEN)('%s: cannot change the title snapshot', async (_s, state) => {
    await seed('v1', { ...link(RFIS.open), ...state })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { originRfiTitle: 'Rewritten' }))
  })

  it.each(FROZEN)('%s: a change is denied even if the target RFI is perfectly valid and every role tries', async (_s, state) => {
    await seed('v1', { ...link(RFIS.open), ...state })
    for (const user of MEMBERS) {
      await assertFails(updateDoc(varRef(ctx(user), 'v1'), link(RFIS.closed)))
    }
  })

  it('transition-shaped writes with an unchanged link remain allowed (existing rules posture)', async () => {
    await seed('v1', { ...link(RFIS.open), ...SUBMITTED })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), approveWrite(USERS.admin)))

    await seed('v2', { ...link(RFIS.open), ...SUBMITTED })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'v2'), rejectWrite(USERS.pm)))

    await seed('v3', { ...link(RFIS.open), ...SUBMITTED })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'v3'), withdrawWrite(USERS.qs)))
  })

  it('transition-shaped writes on an unlinked or legacy non-draft document remain allowed', async () => {
    await seed('v1', SUBMITTED)
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), approveWrite(USERS.admin)))
    await seedLegacy('v2', SUBMITTED)
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v2'), approveWrite(USERS.admin)))
    // Re-sending the null triple on a legacy non-draft doc is not a change.
    await seedLegacy('v3', SUBMITTED)
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v3'), { ...rejectWrite(USERS.admin), ...UNLINKED }))
  })

  it('re-sending the identical populated triple on a frozen document is not a change', async () => {
    await seed('v1', { ...link(RFIS.open), ...APPROVED })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), { notes: 'Post-approval note', ...link(RFIS.open) }))
  })
})

// ── Smuggling ────────────────────────────────────────────────────────────────

describe('smuggling — origin changes bundled with a status transition', () => {
  it('draft → submitted with an unchanged link is allowed', async () => {
    await seed('v1', link(RFIS.open))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), submitWrite(USERS.admin)))
  })

  it('draft → submitted while SETTING a valid link is allowed (stored status is still draft)', async () => {
    await seed('v1')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...submitWrite(USERS.admin), ...link(RFIS.open) }))
  })

  it('draft → submitted while CHANGING to a valid link is allowed', async () => {
    await seed('v1', link(RFIS.open))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...submitWrite(USERS.admin), ...link(RFIS.closed) }))
  })

  it('draft → submitted while REMOVING the link is allowed', async () => {
    await seed('v1', link(RFIS.open))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...submitWrite(USERS.admin), ...UNLINKED }))
  })

  it('draft → submitted while setting an INVALID link is denied — the whole write fails', async () => {
    await seed('v1')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...submitWrite(USERS.admin), ...link(RFIS.draft) }))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...submitWrite(USERS.admin), ...link(RFIS.cancelled) }))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...submitWrite(USERS.admin), ...link(RFI_IN_PROJECT_B) }))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...submitWrite(USERS.admin), ...link(RFIS.open), originRfiTitle: 'Forged' }))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const data = (await getDoc(doc(c.firestore(), varsPath(), 'v1'))).data()
      expect(data.status).toBe('draft')
      expect(data.originRfiId).toBeNull()
    })
  })

  it('a non-draft source cannot smuggle an origin change alongside a transition', async () => {
    await seed('v1', SUBMITTED)
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...approveWrite(USERS.admin), ...link(RFIS.open) }))
    await seed('v2', { ...link(RFIS.open), ...SUBMITTED })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v2'), { ...approveWrite(USERS.admin), ...link(RFIS.closed) }))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v2'), { ...rejectWrite(USERS.admin), ...UNLINKED }))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v2'), { ...withdrawWrite(USERS.admin), originRfiTitle: 'Forged' }))
  })

  it('a non-draft source cannot smuggle a change by pretending to be draft in the same write', async () => {
    await seed('v1', { ...link(RFIS.open), ...APPROVED })
    // status is the STORED status — rewriting it in the request does not help.
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { status: 'draft', ...link(RFIS.closed) }))
  })
})
