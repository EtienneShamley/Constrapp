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

// ── Tender Package Security Rules — emulator tests ───────────────────────────
//
// Executes every case documented in docs/TESTING.md §15s (Tender portion)
// against the Firestore emulator. These verify the RULES, not the UI: each
// write below is a direct SDK call, exactly what a client bypassing the app
// would issue.
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set, so
// it can never reach a production Firebase project.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'

// One user per role, all in Company A, plus one financial-role user in
// Company B for tenant-isolation checks, plus a super_admin — who must have
// NO special power over tenders.
const USERS = {
  admin: { uid: 'u_admin', role: 'company_admin',   companyId: COMPANY_A },
  pm:    { uid: 'u_pm',    role: 'project_manager', companyId: COMPANY_A },
  qs:    { uid: 'u_qs',    role: 'qs',              companyId: COMPANY_A },
  sup:   { uid: 'u_sup',   role: 'super_admin',     companyId: COMPANY_A },
  sub:   { uid: 'u_sub',   role: 'subcontractor',   companyId: COMPANY_A },
  client:{ uid: 'u_client',role: 'client',          companyId: COMPANY_A },
  other: { uid: 'u_other', role: 'company_admin',   companyId: COMPANY_B },
}

let testEnv

const packagesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/tenderPackages`
const bidsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/tenderBids`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const pkgRef = (db, id, companyId = COMPANY_A) => doc(db, packagesPath(companyId), id)

// A valid draft payload, exactly as hooks/useTenderPackages.jsx writes it.
function draftPayload(user, overrides = {}) {
  return {
    tenderNumber: 'TP-0001',
    status:       'draft',

    name:        'Structural Steel Package',
    description: 'All structural steel',
    scope:       'Supply and install structural steel per drawings.',
    costCodes: [
      { costCodeId: 'cc1', costCodeName: '01-100 — Steel' },
      { costCodeId: 'cc2', costCodeName: '02-100 — Metalwork' },
    ],
    closingDate: '2026-09-01',
    notes:       '',

    awardedBidId:      null,
    awardedBidderName: null,
    awardNotes:        '',
    cancelReason:      '',

    revision: 1,

    issuedAt:    null,
    issuedBy:    null,
    awardedAt:   null,
    awardedBy:   null,
    cancelledAt: null,
    cancelledBy: null,

    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

// Seeds a package directly, bypassing rules — the arrange step for update tests.
async function seedPackage(id, status, user = USERS.admin, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const base = draftPayload(user)
    const lifecycle =
      status === 'issued'    ? { status: 'issued', issuedAt: Timestamp.now(), issuedBy: user.uid } :
      status === 'awarded'   ? {
        status: 'awarded',
        issuedAt: Timestamp.now(), issuedBy: user.uid,
        awardedAt: Timestamp.now(), awardedBy: user.uid,
        awardedBidId: 'bid_won', awardedBidderName: 'Apex Steel Pty Ltd',
        awardNotes: 'Lowest conforming bid',
      } :
      status === 'cancelled' ? {
        status: 'cancelled',
        cancelledAt: Timestamp.now(), cancelledBy: user.uid,
        cancelReason: 'Scope changed',
      } :
      { status: 'draft' }
    await setDoc(doc(db, packagesPath(), id), {
      ...base,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...lifecycle,
      ...extra,
    })
  })
}

// Seeds a bid directly, bypassing rules — award targets for the award tests.
async function seedBid(id, tenderPackageId, user = USERS.admin, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(doc(db, bidsPath(), id), {
      tenderPackageId,
      tenderNumber: 'TP-0001',
      status: 'received',
      bidderContactId: 'supplier1',
      bidderName: 'Apex Steel Pty Ltd',
      bidDate: '2026-08-10',
      bidderRef: 'Q-1001',
      lineItems: [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel', description: '', amount: 1000 }],
      exclusions: '',
      notes: '',
      currency: 'AUD',
      revision: 1,
      voidedAt: null, voidedBy: null, voidReason: '',
      createdAt: Timestamp.now(), createdBy: user.uid,
      updatedAt: Timestamp.now(), updatedBy: user.uid,
      ...extra,
    })
  })
}

// The write shapes the app performs, so tests exercise the real payloads.
const issueWrite = (user, extra = {}) => ({
  status: 'issued',
  issuedAt: serverTimestamp(), issuedBy: user.uid,
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const awardWrite = (user, bidId = 'bid_won', bidderName = 'Apex Steel Pty Ltd', extra = {}) => ({
  status: 'awarded',
  awardedBidId: bidId,
  awardedBidderName: bidderName,
  awardNotes: 'Lowest conforming bid',
  awardedAt: serverTimestamp(), awardedBy: user.uid,
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const cancelWrite = (user, reason = 'Scope changed', extra = {}) => ({
  status: 'cancelled',
  cancelledAt: serverTimestamp(), cancelledBy: user.uid, cancelReason: reason,
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const draftEdit = (user, extra = {}) => ({
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})

// Client-supplied clock values that must NEVER satisfy `== request.time` —
// deliberately skewed, never Timestamp.now() (see docs/TESTING.md §0 note).
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)), // clock ahead
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)), // clock behind
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')), // plainly forged
]

beforeAll(async () => {
  // Hard gate: never let this suite touch a real project.
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
  // Membership documents are what the rules `get()` to authorise every request.
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })
  })
})

// ── MUST ALLOW ───────────────────────────────────────────────────────────────

describe('MUST ALLOW', () => {
  it('1. financial roles create a draft (company_admin, project_manager, qs)', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(setDoc(pkgRef(ctx(user), `d_${user.uid}`), draftPayload(user)))
    }
  })

  it('1b. financial roles read the register', async () => {
    await seedPackage('p1', 'draft')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(pkgRef(ctx(user), 'p1')))
    }
  })

  it('1c. a draft may omit the closing date (empty string)', async () => {
    await assertSucceeds(setDoc(pkgRef(ctx(USERS.admin), 'noclose'), draftPayload(USERS.admin, {
      closingDate: '',
    })))
  })

  it('2. draft edit of commercial content (name, scope, costCodes, closingDate, notes)', async () => {
    await seedPackage('p1', 'draft')
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'p1'), draftEdit(USERS.qs, {
      name: 'Steel & Metalwork Package',
      description: 'widened scope',
      scope: 'Now including secondary steel.',
      costCodes: [{ costCodeId: 'cc3', costCodeName: '03-100 — Secondary Steel' }],
      closingDate: '2026-10-01',
      notes: 'retendered',
    })))
  })

  it('3. draft -> issued with correct issuedAt/issuedBy', async () => {
    await seedPackage('p1', 'draft')
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'p1'), issueWrite(USERS.pm)))
  })

  it('4. issued edit of the closingDate/notes carve-out only (including clearing the date)', async () => {
    await seedPackage('p1', 'issued')
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.admin), 'p1'), draftEdit(USERS.admin, {
      closingDate: '2026-11-15',
      notes: 'closing extended two weeks',
    })))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.admin), 'p1'), draftEdit(USERS.admin, {
      closingDate: '',
    })))
  })

  it('5. issued -> awarded with a received bid of THIS package — admin, pm, and QS alike', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      const id = `p_${user.uid}`
      await seedPackage(id, 'issued')
      await seedBid(`bid_${user.uid}`, id)
      await assertSucceeds(updateDoc(pkgRef(ctx(user), id), awardWrite(user, `bid_${user.uid}`)))
    }
  })

  it('6. draft -> cancelled and issued -> cancelled with a real reason', async () => {
    await seedPackage('p1', 'draft')
    await seedPackage('p2', 'issued')
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.admin), 'p1'), cancelWrite(USERS.admin)))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.admin), 'p2'), cancelWrite(USERS.admin)))
  })
})

// ── MUST REJECT ──────────────────────────────────────────────────────────────

describe('MUST REJECT', () => {
  it('1. create directly as issued / awarded / cancelled', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(pkgRef(db, 'x1'), draftPayload(USERS.admin, {
      status: 'issued', issuedAt: serverTimestamp(), issuedBy: USERS.admin.uid,
    })))
    await assertFails(setDoc(pkgRef(db, 'x2'), draftPayload(USERS.admin, {
      status: 'awarded', awardedAt: serverTimestamp(), awardedBy: USERS.admin.uid,
    })))
    await assertFails(setDoc(pkgRef(db, 'x3'), draftPayload(USERS.admin, {
      status: 'cancelled', cancelledAt: serverTimestamp(), cancelledBy: USERS.admin.uid, cancelReason: 'nope',
    })))
  })

  it('2. create with forged lifecycle stamps or pre-filled award/cancel fields', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(pkgRef(db, 'x1'), draftPayload(USERS.admin, { issuedAt: Timestamp.now() })))
    await assertFails(setDoc(pkgRef(db, 'x2'), draftPayload(USERS.admin, { issuedBy: USERS.admin.uid })))
    await assertFails(setDoc(pkgRef(db, 'x3'), draftPayload(USERS.admin, { awardedAt: Timestamp.now() })))
    await assertFails(setDoc(pkgRef(db, 'x4'), draftPayload(USERS.admin, { cancelledBy: USERS.admin.uid })))
    await assertFails(setDoc(pkgRef(db, 'x5'), draftPayload(USERS.admin, { awardedBidId: 'bid1' })))
    await assertFails(setDoc(pkgRef(db, 'x6'), draftPayload(USERS.admin, { awardedBidderName: 'Apex' })))
    await assertFails(setDoc(pkgRef(db, 'x7'), draftPayload(USERS.admin, { awardNotes: 'pre-decided' })))
    await assertFails(setDoc(pkgRef(db, 'x8'), draftPayload(USERS.admin, { cancelReason: 'pre-cancelled' })))
  })

  it('2b. create impersonating another user, or with a bad revision / blank name', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(pkgRef(db, 'x1'), draftPayload(USERS.admin, { createdBy: USERS.pm.uid })))
    await assertFails(setDoc(pkgRef(db, 'x2'), draftPayload(USERS.admin, { revision: 2 })))
    await assertFails(setDoc(pkgRef(db, 'x3'), draftPayload(USERS.admin, { revision: '1' })))
    await assertFails(setDoc(pkgRef(db, 'x4'), draftPayload(USERS.admin, { name: '' })))
    await assertFails(setDoc(pkgRef(db, 'x5'), draftPayload(USERS.admin, { name: '   ' })))
    await assertFails(setDoc(pkgRef(db, 'x6'), draftPayload(USERS.admin, { tenderNumber: '' })))
  })

  it('2c. create without cost codes, with a non-list, or exceeding the maximum', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(pkgRef(db, 'x1'), draftPayload(USERS.admin, { costCodes: [] })))
    await assertFails(setDoc(pkgRef(db, 'x2'), draftPayload(USERS.admin, { costCodes: 'cc1' })))
    await assertFails(setDoc(pkgRef(db, 'x3'), draftPayload(USERS.admin, { costCodes: { cc1: true } })))
    await assertFails(setDoc(pkgRef(db, 'x4'), draftPayload(USERS.admin, {
      costCodes: Array.from({ length: 101 }, (_, i) => ({ costCodeId: `cc${i}`, costCodeName: `c${i}` })),
    })))
  })

  it('2d. create with a malformed closingDate', async () => {
    const db = ctx(USERS.admin)
    for (const [i, closingDate] of ['01/09/2026', '2026-9-1', 'soon', '20260901'].entries()) {
      await assertFails(setDoc(pkgRef(db, `x${i}`), draftPayload(USERS.admin, { closingDate })))
    }
    await assertFails(setDoc(pkgRef(db, 'xts'), draftPayload(USERS.admin, { closingDate: Timestamp.now() })))
  })

  it('3. draft edit changing tenderNumber / createdAt / createdBy / revision', async () => {
    await seedPackage('p1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { tenderNumber: 'TP-9999' })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { createdAt: Timestamp.now() })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { createdBy: USERS.pm.uid })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { revision: 2 })))
  })

  it('4. draft edit forging lifecycle stamps or award/cancel fields', async () => {
    await seedPackage('p1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { issuedAt: Timestamp.now() })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { awardedBy: USERS.admin.uid })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { awardedBidId: 'bid1' })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { awardedBidderName: 'Apex' })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { awardNotes: 'sneaky' })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { cancelReason: 'sneaky' })))
  })

  it('5. draft edit breaking the shape (blank name, zero cost codes, bad date)', async () => {
    await seedPackage('p1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { name: ' ' })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { costCodes: [] })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { closingDate: 'never' })))
  })

  it('6. ISSUED commercial content edits are frozen (name, description, scope, costCodes)', async () => {
    await seedPackage('p1', 'issued')
    const db = ctx(USERS.admin)
    for (const patch of [
      { name: 'Renamed after going to market' },
      { description: 'changed' },
      { scope: 'quietly widened scope' },
      { costCodes: [{ costCodeId: 'cc9', costCodeName: '09-999 — Extra' }] },
    ]) {
      await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, patch)))
    }
  })

  it('6b. the issued carve-out cannot smuggle content alongside closingDate/notes', async () => {
    await seedPackage('p1', 'issued')
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'p1'), draftEdit(USERS.admin, {
      closingDate: '2026-12-01',
      name: 'smuggled rename',
    })))
  })

  it('6c. the issued carve-out still validates the closingDate shape', async () => {
    await seedPackage('p1', 'issued')
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'p1'), draftEdit(USERS.admin, {
      closingDate: 'whenever',
    })))
  })

  it('7. award of a NONEXISTENT bid', async () => {
    await seedPackage('p1', 'issued')
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'p1'), awardWrite(USERS.admin, 'no_such_bid')))
  })

  it('8. award of ANOTHER PACKAGE\'s bid', async () => {
    await seedPackage('p1', 'issued')
    await seedPackage('p2', 'issued')
    await seedBid('bid_p2', 'p2') // belongs to p2
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'p1'), awardWrite(USERS.admin, 'bid_p2')))
  })

  it('9. award of a VOID bid', async () => {
    await seedPackage('p1', 'issued')
    await seedBid('bid_void', 'p1', USERS.admin, {
      status: 'void', voidedAt: Timestamp.now(), voidedBy: USERS.admin.uid, voidReason: 'withdrawn',
    })
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'p1'), awardWrite(USERS.admin, 'bid_void')))
  })

  it('10. award with a FORGED bidder-name snapshot', async () => {
    await seedPackage('p1', 'issued')
    await seedBid('bid1', 'p1') // bidderName: 'Apex Steel Pty Ltd'
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'p1'),
      awardWrite(USERS.admin, 'bid1', 'Somebody Else Entirely')))
  })

  it('11. award of a DRAFT or CANCELLED package', async () => {
    await seedPackage('p1', 'draft')
    await seedPackage('p2', 'cancelled')
    await seedBid('bid1', 'p1')
    await seedBid('bid2', 'p2')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(pkgRef(db, 'p1'), awardWrite(USERS.admin, 'bid1')))
    await assertFails(updateDoc(pkgRef(db, 'p2'), awardWrite(USERS.admin, 'bid2')))
  })

  it('12. a SECOND award (the package is already awarded)', async () => {
    await seedPackage('p1', 'awarded')
    await seedBid('bid_won', 'p1')
    await seedBid('bid_rival', 'p1', USERS.admin, { bidderName: 'Rival Steel' })
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'p1'),
      awardWrite(USERS.admin, 'bid_rival', 'Rival Steel')))
  })

  it('13. award smuggling extra changes, or with wrong actor stamps', async () => {
    await seedPackage('p1', 'issued')
    await seedBid('bid1', 'p1')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(pkgRef(db, 'p1'), awardWrite(USERS.admin, 'bid1', 'Apex Steel Pty Ltd', {
      scope: 'changed during award',
    })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), awardWrite(USERS.admin, 'bid1', 'Apex Steel Pty Ltd', {
      awardedBy: USERS.pm.uid,
    })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), awardWrite(USERS.admin, 'bid1', 'Apex Steel Pty Ltd', {
      updatedBy: USERS.pm.uid,
    })))
  })

  it('14. cancel with an empty or whitespace-only reason, or a wrong cancelledBy', async () => {
    await seedPackage('p1', 'issued')
    await seedPackage('p2', 'issued')
    await seedPackage('p3', 'issued')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(pkgRef(db, 'p1'), cancelWrite(USERS.admin, '')))
    await assertFails(updateDoc(pkgRef(db, 'p2'), cancelWrite(USERS.admin, '   ')))
    await assertFails(updateDoc(pkgRef(db, 'p3'), cancelWrite(USERS.admin, 'Scope changed', { cancelledBy: USERS.pm.uid })))
  })

  it('15. AWARDED is terminal — no edits, no cancel, no re-issue', async () => {
    await seedPackage('p1', 'awarded')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { notes: 'post-award edit' })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { awardNotes: 'rewriting history' })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), cancelWrite(USERS.admin)))
    await assertFails(updateDoc(pkgRef(db, 'p1'), issueWrite(USERS.admin)))
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { status: 'issued' })))
  })

  it('16. CANCELLED is terminal — no edits, no issue, no award, no re-cancel', async () => {
    await seedPackage('p1', 'cancelled')
    await seedBid('bid1', 'p1')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { notes: 'post-cancel edit' })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), issueWrite(USERS.admin)))
    await assertFails(updateDoc(pkgRef(db, 'p1'), awardWrite(USERS.admin, 'bid1')))
    await assertFails(updateDoc(pkgRef(db, 'p1'), cancelWrite(USERS.admin, 'again')))
  })

  it('17. any unknown / fabricated status', async () => {
    await seedPackage('p1', 'draft')
    const db = ctx(USERS.admin)
    for (const status of ['pending_approval', 'closed', 'recommended', 'open']) {
      await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(USERS.admin, { status })))
      await assertFails(setDoc(pkgRef(db, `new_${status}`), draftPayload(USERS.admin, { status })))
    }
  })

  it('18. delete of a package in ANY status', async () => {
    await seedPackage('p1', 'draft')
    await seedPackage('p2', 'issued')
    await seedPackage('p3', 'awarded')
    await seedPackage('p4', 'cancelled')
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      await assertFails(deleteDoc(pkgRef(ctx(USERS.admin), id)))
    }
  })

  it('19. subcontractor and client cannot read or write — competitor privacy', async () => {
    await seedPackage('p1', 'issued')
    for (const user of [USERS.sub, USERS.client]) {
      const db = ctx(user)
      await assertFails(getDoc(pkgRef(db, 'p1')))
      await assertFails(setDoc(pkgRef(db, 'new1'), draftPayload(user)))
      await assertFails(updateDoc(pkgRef(db, 'p1'), draftEdit(user, { notes: 'nope' })))
      await assertFails(deleteDoc(pkgRef(db, 'p1')))
    }
  })

  it('19b. super_admin has NO special power — reads and writes are denied', async () => {
    await seedPackage('p1', 'issued')
    const db = ctx(USERS.sup)
    await assertFails(getDoc(pkgRef(db, 'p1')))
    await assertFails(setDoc(pkgRef(db, 'new1'), draftPayload(USERS.sup)))
    await assertFails(updateDoc(pkgRef(db, 'p1'), cancelWrite(USERS.sup)))
  })

  it('19c. an unauthenticated client cannot read or write', async () => {
    await seedPackage('p1', 'draft')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(pkgRef(db, 'p1')))
    await assertFails(setDoc(pkgRef(db, 'new1'), draftPayload(USERS.admin)))
    await assertFails(updateDoc(pkgRef(db, 'p1'), issueWrite(USERS.admin)))
  })

  it('20. cross-company read or write is denied', async () => {
    await seedPackage('p1', 'draft')
    const dbOther = ctx(USERS.other)
    await assertFails(getDoc(pkgRef(dbOther, 'p1')))
    await assertFails(setDoc(pkgRef(dbOther, 'new1'), draftPayload(USERS.other)))
    await assertFails(updateDoc(pkgRef(dbOther, 'p1'), issueWrite(USERS.other)))
    await assertFails(deleteDoc(pkgRef(dbOther, 'p1')))
    await assertFails(setDoc(pkgRef(ctx(USERS.admin), 'new2', COMPANY_B), draftPayload(USERS.admin)))
  })
})

// ── serverTimestamp() must satisfy the request.time checks ───────────────────

describe('serverTimestamp satisfies request.time', () => {
  it('create: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(setDoc(pkgRef(db, 'ok'), draftPayload(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await assertFails(setDoc(pkgRef(db, `badc${i}`), draftPayload(USERS.admin, { createdAt: stamp() })))
      await assertFails(setDoc(pkgRef(db, `badu${i}`), draftPayload(USERS.admin, { updatedAt: stamp() })))
    }
  })

  it('issue / award / cancel: a client clock value is rejected on each stamp', async () => {
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await seedPackage(`pi${i}`, 'draft')
      await assertFails(updateDoc(pkgRef(ctx(USERS.admin), `pi${i}`), issueWrite(USERS.admin, { issuedAt: stamp() })))

      await seedPackage(`pa${i}`, 'issued')
      await seedBid(`bida${i}`, `pa${i}`)
      await assertFails(updateDoc(pkgRef(ctx(USERS.admin), `pa${i}`),
        awardWrite(USERS.admin, `bida${i}`, 'Apex Steel Pty Ltd', { awardedAt: stamp() })))

      await seedPackage(`pc${i}`, 'issued')
      await assertFails(updateDoc(pkgRef(ctx(USERS.admin), `pc${i}`), cancelWrite(USERS.admin, 'r', { cancelledAt: stamp() })))
    }
  })

  it('the full app write sequence succeeds end to end: create -> edit -> issue -> award', async () => {
    const db = ctx(USERS.qs)
    const ref = pkgRef(db, 'flow')
    await assertSucceeds(setDoc(ref, draftPayload(USERS.qs)))
    await assertSucceeds(updateDoc(ref, draftEdit(USERS.qs, { name: 'Steel — Rev A' })))
    await assertSucceeds(updateDoc(ref, issueWrite(USERS.qs)))
    await seedBid('bid_flow', 'flow')
    await assertSucceeds(updateDoc(ref, awardWrite(USERS.qs, 'bid_flow')))

    // withSecurityRulesDisabled resolves to undefined — capture via closure.
    let after
    await testEnv.withSecurityRulesDisabled(async (c) => {
      after = (await getDoc(doc(c.firestore(), packagesPath(), 'flow'))).data()
    })
    expect(after.status).toBe('awarded')
    expect(after.awardedBy).toBe(USERS.qs.uid)
    expect(after.awardedBidId).toBe('bid_flow')
    expect(after.awardedBidderName).toBe('Apex Steel Pty Ltd')
    expect(after.tenderNumber).toBe('TP-0001')

    // Awarded is terminal.
    await assertFails(updateDoc(ref, draftEdit(USERS.qs, { notes: 'too late' })))
    await assertFails(updateDoc(ref, cancelWrite(USERS.qs)))
  })
})
