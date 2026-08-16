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

// ── Tender Bid Security Rules — emulator tests ───────────────────────────────
//
// Executes every case documented in docs/TESTING.md §15s (Tender portion)
// against the Firestore emulator. These verify the RULES, not the UI: each
// write below is a direct SDK call, exactly what a client bypassing the app
// would issue. The suite ALSO asserts the documented CLIENT-ONLY gap: rules
// cannot iterate lineItems, so malformed EMBEDDED LINE DATA is accepted at the
// rules layer — the read-time validity gate (lib/tenders.js → assessBid) is
// what keeps such a document out of every figure.
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set, so
// it can never reach a production Firebase project.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'

const USERS = {
  admin: { uid: 'u_admin', role: 'company_admin',   companyId: COMPANY_A },
  pm:    { uid: 'u_pm',    role: 'project_manager', companyId: COMPANY_A },
  qs:    { uid: 'u_qs',    role: 'qs',              companyId: COMPANY_A },
  sup:   { uid: 'u_sup',   role: 'super_admin',     companyId: COMPANY_A },
  sub:   { uid: 'u_sub',   role: 'subcontractor',   companyId: COMPANY_A },
  client:{ uid: 'u_client',role: 'client',          companyId: COMPANY_A },
  other: { uid: 'u_other', role: 'company_admin',   companyId: COMPANY_B },
}

// Seeded packages (created rules-disabled in beforeEach).
const PKG_ISSUED    = 'pkg_issued'     // TP-0001, issued — the normal target
const PKG_DRAFT     = 'pkg_draft'      // TP-0002, still draft
const PKG_AWARDED   = 'pkg_awarded'    // TP-0003, awarded — bids frozen
const PKG_CANCELLED = 'pkg_cancelled'  // TP-0004, cancelled — bids frozen
const PKG_CLOSED    = 'pkg_closed'     // TP-0005, issued, closingDate long past

let testEnv

const bidsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/tenderBids`
const packagesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/tenderPackages`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const bidRef = (db, id, companyId = COMPANY_A) => doc(db, bidsPath(companyId), id)

// A valid received-bid payload, exactly as hooks/useTenderBids.jsx writes it.
function bidPayload(user, overrides = {}) {
  return {
    tenderPackageId: PKG_ISSUED,
    tenderNumber:    'TP-0001',
    status:          'received',

    bidderContactId: 'supplier1',
    bidderName:      'Apex Steel Pty Ltd',

    bidDate:   '2026-08-10',
    bidderRef: 'Q-1001',

    lineItems: [
      { costCodeId: 'cc1', costCodeName: '01-100 — Steel', description: 'Supply & install', amount: 90000 },
      { costCodeId: 'cc2', costCodeName: '02-100 — Metalwork', description: '', amount: 12000.5 },
    ],

    exclusions: '',
    notes:      '',

    currency: 'AUD',
    revision: 1,

    voidedAt:   null,
    voidedBy:   null,
    voidReason: '',

    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

// Seeds a bid directly, bypassing rules — the arrange step for update tests.
async function seedBid(id, status = 'received', user = USERS.admin, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const base = bidPayload(user)
    const lifecycle =
      status === 'void'
        ? { status: 'void', voidedAt: Timestamp.now(), voidedBy: user.uid, voidReason: 'Withdrawn by bidder' }
        : { status: 'received' }
    await setDoc(doc(db, bidsPath(), id), {
      ...base,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...lifecycle,
      ...extra,
    })
  })
}

const receivedEdit = (user, extra = {}) => ({
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const voidWrite = (user, reason = 'Withdrawn by bidder', extra = {}) => ({
  status: 'void',
  voidedAt: serverTimestamp(), voidedBy: user.uid, voidReason: reason,
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
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    // Membership documents are what the rules `get()` to authorise requests.
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })

    // Contacts the bid-create rule get()s: a supplier, a subcontractor, and a
    // CLIENT-ONLY contact (not an eligible bidder).
    await setDoc(doc(db, `companies/${COMPANY_A}/contacts`, 'supplier1'), {
      displayName: 'Apex Steel Pty Ltd', contactTypes: ['supplier'], isActive: true,
    })
    await setDoc(doc(db, `companies/${COMPANY_A}/contacts`, 'subbie1'), {
      displayName: 'Bolt Fixing Subbies', contactTypes: ['subcontractor'], isActive: true,
    })
    await setDoc(doc(db, `companies/${COMPANY_A}/contacts`, 'client1'), {
      displayName: 'Harbour Homes Pty Ltd', contactTypes: ['client'], isActive: true,
    })

    // Parent packages in every lifecycle state the rules distinguish.
    const basePkg = {
      name: 'Structural Steel Package',
      description: '', scope: 'Steelwork', notes: '',
      costCodes: [
        { costCodeId: 'cc1', costCodeName: '01-100 — Steel' },
        { costCodeId: 'cc2', costCodeName: '02-100 — Metalwork' },
      ],
      closingDate: '2026-09-01',
      awardedBidId: null, awardedBidderName: null, awardNotes: '', cancelReason: '',
      revision: 1,
      issuedAt: null, issuedBy: null, awardedAt: null, awardedBy: null,
      cancelledAt: null, cancelledBy: null,
      createdAt: Timestamp.now(), createdBy: USERS.admin.uid,
      updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
    }
    await setDoc(doc(db, packagesPath(), PKG_ISSUED), {
      ...basePkg, tenderNumber: 'TP-0001', status: 'issued',
      issuedAt: Timestamp.now(), issuedBy: USERS.admin.uid,
    })
    await setDoc(doc(db, packagesPath(), PKG_DRAFT), {
      ...basePkg, tenderNumber: 'TP-0002', status: 'draft',
    })
    await setDoc(doc(db, packagesPath(), PKG_AWARDED), {
      ...basePkg, tenderNumber: 'TP-0003', status: 'awarded',
      issuedAt: Timestamp.now(), issuedBy: USERS.admin.uid,
      awardedAt: Timestamp.now(), awardedBy: USERS.admin.uid,
      awardedBidId: 'bid_frozen', awardedBidderName: 'Apex Steel Pty Ltd',
    })
    await setDoc(doc(db, packagesPath(), PKG_CANCELLED), {
      ...basePkg, tenderNumber: 'TP-0004', status: 'cancelled',
      cancelledAt: Timestamp.now(), cancelledBy: USERS.admin.uid, cancelReason: 'Scope changed',
    })
    await setDoc(doc(db, packagesPath(), PKG_CLOSED), {
      ...basePkg, tenderNumber: 'TP-0005', status: 'issued',
      issuedAt: Timestamp.now(), issuedBy: USERS.admin.uid,
      closingDate: '2020-01-31', // long past
    })
  })
})

// ── MUST ALLOW ───────────────────────────────────────────────────────────────

describe('MUST ALLOW', () => {
  it('1. financial roles record a received bid on an issued package', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(setDoc(bidRef(ctx(user), `b_${user.uid}`), bidPayload(user)))
    }
  })

  it('1b. financial roles read the bids', async () => {
    await seedBid('b1')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(bidRef(ctx(user), 'b1')))
    }
  })

  it('1c. a subcontractor-type contact is an eligible bidder', async () => {
    await assertSucceeds(setDoc(bidRef(ctx(USERS.admin), 'b_subbie'), bidPayload(USERS.admin, {
      bidderContactId: 'subbie1', bidderName: 'Bolt Fixing Subbies',
    })))
  })

  it('1d. a bid AFTER the closing date is accepted — closing is informational only', async () => {
    await assertSucceeds(setDoc(bidRef(ctx(USERS.admin), 'b_late'), bidPayload(USERS.admin, {
      tenderPackageId: PKG_CLOSED, tenderNumber: 'TP-0005', bidDate: '2026-08-10',
    })))
  })

  it('2. received edit (transcription correction) while the package is issued', async () => {
    await seedBid('b1')
    await assertSucceeds(updateDoc(bidRef(ctx(USERS.qs), 'b1'), receivedEdit(USERS.qs, {
      bidDate: '2026-08-12',
      bidderRef: 'Q-1001-REV2',
      lineItems: [
        { costCodeId: 'cc1', costCodeName: '01-100 — Steel', description: 'Corrected', amount: 88000 },
      ],
      exclusions: 'Excludes cranage',
      notes: 'Corrected transcription error',
    })))
  })

  it('3. received -> void with a non-empty reason while the package is issued', async () => {
    await seedBid('b1')
    await assertSucceeds(updateDoc(bidRef(ctx(USERS.admin), 'b1'), voidWrite(USERS.admin)))
  })

  it('4. DOCUMENTED CLIENT-ONLY GAP: malformed EMBEDDED LINE DATA is accepted by rules', async () => {
    // Rules cannot iterate lineItems — element shape, finite amounts, ≥ 0, and
    // package-scope containment are client-enforced only (Deferred Control 26).
    // The read-time validity gate is what keeps these bids out of every figure.
    const db = ctx(USERS.admin)
    await assertSucceeds(setDoc(bidRef(db, 'gap1'), bidPayload(USERS.admin, {
      lineItems: [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel', description: '', amount: 'ninety grand' }],
    })))
    await assertSucceeds(setDoc(bidRef(db, 'gap2'), bidPayload(USERS.admin, {
      lineItems: [{ costCodeId: 'cc_outside_package', costCodeName: 'x', description: '', amount: -5 }],
    })))
    await assertSucceeds(setDoc(bidRef(db, 'gap3'), bidPayload(USERS.admin, {
      lineItems: ['not even an object'],
    })))
  })
})

// ── MUST REJECT ──────────────────────────────────────────────────────────────

describe('MUST REJECT', () => {
  it('1. create directly as void, or with forged void stamps', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(bidRef(db, 'x1'), bidPayload(USERS.admin, {
      status: 'void', voidedAt: serverTimestamp(), voidedBy: USERS.admin.uid, voidReason: 'nope',
    })))
    await assertFails(setDoc(bidRef(db, 'x2'), bidPayload(USERS.admin, { voidedAt: Timestamp.now() })))
    await assertFails(setDoc(bidRef(db, 'x3'), bidPayload(USERS.admin, { voidedBy: USERS.admin.uid })))
    await assertFails(setDoc(bidRef(db, 'x4'), bidPayload(USERS.admin, { voidReason: 'pre-voided' })))
  })

  it('2. create against a DRAFT, AWARDED, or CANCELLED package — issued only', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(bidRef(db, 'x1'), bidPayload(USERS.admin, {
      tenderPackageId: PKG_DRAFT, tenderNumber: 'TP-0002',
    })))
    await assertFails(setDoc(bidRef(db, 'x2'), bidPayload(USERS.admin, {
      tenderPackageId: PKG_AWARDED, tenderNumber: 'TP-0003',
    })))
    await assertFails(setDoc(bidRef(db, 'x3'), bidPayload(USERS.admin, {
      tenderPackageId: PKG_CANCELLED, tenderNumber: 'TP-0004',
    })))
  })

  it('2b. create against a NONEXISTENT package', async () => {
    await assertFails(setDoc(bidRef(ctx(USERS.admin), 'x1'), bidPayload(USERS.admin, {
      tenderPackageId: 'no_such_package', tenderNumber: 'TP-9999',
    })))
  })

  it('2c. create with a FORGED tenderNumber snapshot', async () => {
    await assertFails(setDoc(bidRef(ctx(USERS.admin), 'x1'), bidPayload(USERS.admin, {
      tenderNumber: 'TP-7777', // package is TP-0001
    })))
  })

  it('3. create with a NONEXISTENT bidder contact', async () => {
    await assertFails(setDoc(bidRef(ctx(USERS.admin), 'x1'), bidPayload(USERS.admin, {
      bidderContactId: 'ghost_contact', bidderName: 'Ghost Trades',
    })))
  })

  it('3b. create with a contact that is NOT supplier/subcontractor (wrong type)', async () => {
    await assertFails(setDoc(bidRef(ctx(USERS.admin), 'x1'), bidPayload(USERS.admin, {
      bidderContactId: 'client1', bidderName: 'Harbour Homes Pty Ltd',
    })))
  })

  it('3c. create with a FORGED bidder-name snapshot', async () => {
    await assertFails(setDoc(bidRef(ctx(USERS.admin), 'x1'), bidPayload(USERS.admin, {
      bidderContactId: 'supplier1', bidderName: 'Not Their Real Name',
    })))
  })

  it('4. create with empty, non-list, or oversized lineItems', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(bidRef(db, 'x1'), bidPayload(USERS.admin, { lineItems: [] })))
    await assertFails(setDoc(bidRef(db, 'x2'), bidPayload(USERS.admin, { lineItems: 'one line' })))
    await assertFails(setDoc(bidRef(db, 'x3'), bidPayload(USERS.admin, { lineItems: { cc1: 100 } })))
    await assertFails(setDoc(bidRef(db, 'x4'), bidPayload(USERS.admin, {
      lineItems: Array.from({ length: 101 }, () => ({ costCodeId: 'cc1', costCodeName: 'x', description: '', amount: 1 })),
    })))
  })

  it('5. create with a malformed bidDate / currency / revision, or impersonating', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(bidRef(db, 'x1'), bidPayload(USERS.admin, { bidDate: '10/08/2026' })))
    await assertFails(setDoc(bidRef(db, 'x2'), bidPayload(USERS.admin, { bidDate: '' })))
    await assertFails(setDoc(bidRef(db, 'x3'), bidPayload(USERS.admin, { currency: 'AU' })))
    await assertFails(setDoc(bidRef(db, 'x4'), bidPayload(USERS.admin, { currency: 'aud' })))
    await assertFails(setDoc(bidRef(db, 'x5'), bidPayload(USERS.admin, { revision: 2 })))
    await assertFails(setDoc(bidRef(db, 'x6'), bidPayload(USERS.admin, { createdBy: USERS.pm.uid })))
  })

  it('6. edit changing the immutable core: package linkage, snapshots, bidder, currency, creation', async () => {
    await seedBid('b1')
    const db = ctx(USERS.admin)
    for (const patch of [
      { tenderPackageId: PKG_CLOSED },
      { tenderNumber: 'TP-0005' },
      { bidderContactId: 'subbie1' },
      { bidderName: 'Someone Else' },
      { currency: 'NZD' },
      { createdAt: Timestamp.now() },
      { createdBy: USERS.pm.uid },
      { revision: 2 },
    ]) {
      await assertFails(updateDoc(bidRef(db, 'b1'), receivedEdit(USERS.admin, patch)))
    }
  })

  it('7. edit forging void stamps', async () => {
    await seedBid('b1')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(bidRef(db, 'b1'), receivedEdit(USERS.admin, { voidedAt: Timestamp.now() })))
    await assertFails(updateDoc(bidRef(db, 'b1'), receivedEdit(USERS.admin, { voidedBy: USERS.admin.uid })))
    await assertFails(updateDoc(bidRef(db, 'b1'), receivedEdit(USERS.admin, { voidReason: 'sneaky' })))
  })

  it('8. edit or void of a bid whose package is AWARDED — bids freeze', async () => {
    await seedBid('b_frozen', 'received', USERS.admin, {
      tenderPackageId: PKG_AWARDED, tenderNumber: 'TP-0003',
    })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(bidRef(db, 'b_frozen'), receivedEdit(USERS.admin, {
      lineItems: [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel', description: 'rewrite after award', amount: 1 }],
    })))
    await assertFails(updateDoc(bidRef(db, 'b_frozen'), receivedEdit(USERS.admin, { notes: 'post-award note' })))
    await assertFails(updateDoc(bidRef(db, 'b_frozen'), voidWrite(USERS.admin)))
  })

  it('8b. edit or void of a bid whose package is CANCELLED — bids freeze', async () => {
    await seedBid('b_frozen', 'received', USERS.admin, {
      tenderPackageId: PKG_CANCELLED, tenderNumber: 'TP-0004',
    })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(bidRef(db, 'b_frozen'), receivedEdit(USERS.admin, { notes: 'post-cancel note' })))
    await assertFails(updateDoc(bidRef(db, 'b_frozen'), voidWrite(USERS.admin)))
  })

  it('9. void with an empty or whitespace-only reason, or a wrong voidedBy', async () => {
    await seedBid('b1')
    await seedBid('b2')
    await seedBid('b3')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(bidRef(db, 'b1'), voidWrite(USERS.admin, '')))
    await assertFails(updateDoc(bidRef(db, 'b2'), voidWrite(USERS.admin, '   ')))
    await assertFails(updateDoc(bidRef(db, 'b3'), voidWrite(USERS.admin, 'Withdrawn', { voidedBy: USERS.pm.uid })))
  })

  it('9b. void smuggling content changes alongside the void fields', async () => {
    await seedBid('b1')
    await assertFails(updateDoc(bidRef(ctx(USERS.admin), 'b1'), voidWrite(USERS.admin, 'Withdrawn', {
      lineItems: [{ costCodeId: 'cc1', costCodeName: 'x', description: '', amount: 1 }],
    })))
  })

  it('10. VOID is terminal — no un-void, no edits, no re-void', async () => {
    await seedBid('b1', 'void')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(bidRef(db, 'b1'), receivedEdit(USERS.admin, { status: 'received' })))
    await assertFails(updateDoc(bidRef(db, 'b1'), receivedEdit(USERS.admin, { notes: 'edit a void' })))
    await assertFails(updateDoc(bidRef(db, 'b1'), voidWrite(USERS.admin, 'again')))
  })

  it('11. any unknown / fabricated status', async () => {
    await seedBid('b1')
    const db = ctx(USERS.admin)
    for (const status of ['draft', 'submitted', 'accepted', 'awarded', 'rejected']) {
      await assertFails(updateDoc(bidRef(db, 'b1'), receivedEdit(USERS.admin, { status })))
      await assertFails(setDoc(bidRef(db, `new_${status}`), bidPayload(USERS.admin, { status })))
    }
  })

  it('12. delete of a received (and a void) bid', async () => {
    await seedBid('b1')
    await seedBid('b2', 'void')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertFails(deleteDoc(bidRef(ctx(user), 'b1')))
    }
    await assertFails(deleteDoc(bidRef(ctx(USERS.admin), 'b2')))
  })

  it('13. subcontractor and client cannot read or write — a bid IS competitor pricing', async () => {
    await seedBid('b1')
    for (const user of [USERS.sub, USERS.client]) {
      const db = ctx(user)
      await assertFails(getDoc(bidRef(db, 'b1')))
      await assertFails(setDoc(bidRef(db, 'new1'), bidPayload(user)))
      await assertFails(updateDoc(bidRef(db, 'b1'), receivedEdit(user, { notes: 'nope' })))
      await assertFails(updateDoc(bidRef(db, 'b1'), voidWrite(user)))
      await assertFails(deleteDoc(bidRef(db, 'b1')))
    }
  })

  it('13b. super_admin has NO special power — reads and writes are denied', async () => {
    await seedBid('b1')
    const db = ctx(USERS.sup)
    await assertFails(getDoc(bidRef(db, 'b1')))
    await assertFails(setDoc(bidRef(db, 'new1'), bidPayload(USERS.sup)))
    await assertFails(updateDoc(bidRef(db, 'b1'), voidWrite(USERS.sup)))
  })

  it('13c. an unauthenticated client cannot read or write', async () => {
    await seedBid('b1')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(bidRef(db, 'b1')))
    await assertFails(setDoc(bidRef(db, 'new1'), bidPayload(USERS.admin)))
    await assertFails(updateDoc(bidRef(db, 'b1'), voidWrite(USERS.admin)))
  })

  it('14. cross-company read or write is denied', async () => {
    await seedBid('b1')
    const dbOther = ctx(USERS.other)
    await assertFails(getDoc(bidRef(dbOther, 'b1')))
    await assertFails(setDoc(bidRef(dbOther, 'new1'), bidPayload(USERS.other)))
    await assertFails(updateDoc(bidRef(dbOther, 'b1'), voidWrite(USERS.other)))
    await assertFails(deleteDoc(bidRef(dbOther, 'b1')))
    // Company A's admin reaching into Company B (no package/contact exist there
    // either — but the membership check already denies it).
    await assertFails(setDoc(bidRef(ctx(USERS.admin), 'new2', COMPANY_B), bidPayload(USERS.admin)))
  })
})

// ── serverTimestamp() must satisfy the request.time checks ───────────────────

describe('serverTimestamp satisfies request.time', () => {
  it('create: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(setDoc(bidRef(db, 'ok'), bidPayload(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await assertFails(setDoc(bidRef(db, `badc${i}`), bidPayload(USERS.admin, { createdAt: stamp() })))
      await assertFails(setDoc(bidRef(db, `badu${i}`), bidPayload(USERS.admin, { updatedAt: stamp() })))
    }
  })

  it('void: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    await seedBid('b_ok')
    const db = ctx(USERS.admin)
    await assertSucceeds(updateDoc(bidRef(db, 'b_ok'), voidWrite(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await seedBid(`bv${i}`)
      await seedBid(`bw${i}`)
      await assertFails(updateDoc(bidRef(db, `bv${i}`), voidWrite(USERS.admin, 'r', { voidedAt: stamp() })))
      await assertFails(updateDoc(bidRef(db, `bw${i}`), voidWrite(USERS.admin, 'r', { updatedAt: stamp() })))
    }
  })

  it('the full app write sequence succeeds end to end: record -> correct -> void', async () => {
    const db = ctx(USERS.qs)
    const ref = bidRef(db, 'flow')
    await assertSucceeds(setDoc(ref, bidPayload(USERS.qs)))
    await assertSucceeds(updateDoc(ref, receivedEdit(USERS.qs, {
      lineItems: [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel', description: 'Rev B', amount: 87500.25 }],
      bidderRef: 'Q-1001-B',
    })))

    // withSecurityRulesDisabled resolves to undefined — capture via closure.
    let after
    await testEnv.withSecurityRulesDisabled(async (c) => {
      after = (await getDoc(doc(c.firestore(), bidsPath(), 'flow'))).data()
    })
    expect(after.status).toBe('received')
    expect(after.tenderNumber).toBe('TP-0001')
    expect(after.bidderName).toBe('Apex Steel Pty Ltd')
    expect(after.lineItems[0].amount).toBe(87500.25)

    await assertSucceeds(updateDoc(ref, voidWrite(USERS.qs, 'Bidder withdrew')))
    // Void is terminal.
    await assertFails(updateDoc(ref, receivedEdit(USERS.qs, { notes: 'too late' })))
  })
})
