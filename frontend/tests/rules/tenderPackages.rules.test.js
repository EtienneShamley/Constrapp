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
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, serverTimestamp, Timestamp,
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

const PROJECT_ID = 'demo-constrap-test'
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
    // D4 material-edit provenance (ADR-96, D3 #46) — required at create.
    lastMaterialEditBy: user.uid,
    lastMaterialEditAt: serverTimestamp(),
    ...overrides,
  }
}

// Seeds a package directly, bypassing rules — the arrange step for update tests.
// `legacy: true` drops the D4 provenance stamps (a package written before D3 #46).
async function seedPackage(id, status, user = USERS.admin, extra = {}, { legacy = false } = {}) {
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
    const data = {
      ...base,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      lastMaterialEditAt: Timestamp.now(),
      ...lifecycle,
      ...extra,
    }
    if (legacy) { delete data.lastMaterialEditBy; delete data.lastMaterialEditAt }
    await setDoc(doc(db, packagesPath(), id), data)
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
// A COSMETIC edit shape (no D4 stamp) — what the hook writes when only notes /
// closingDate change, and the issued-state carve-out.
const draftEdit = (user, extra = {}) => ({
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
// D4: a MATERIAL draft edit (name / description / scope / costCodes changed)
// carries the caller as `lastMaterialEditBy` at server time (lib/purchaseOrders.js
// → materialEditStamp with TENDER_MATERIAL_KEYS).
const materialStamp = (user) => ({ lastMaterialEditBy: user.uid, lastMaterialEditAt: serverTimestamp() })
const materialEdit = (user, extra = {}) => ({ ...draftEdit(user), ...materialStamp(user), ...extra })

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
    // D4: a material edit — it now carries the editor's provenance stamp.
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'p1'), materialEdit(USERS.qs, {
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
    // D4: name / costCodes are material — sent WITH the stamp so the refusal is the shape's.
    await assertFails(updateDoc(pkgRef(db, 'p1'), materialEdit(USERS.admin, { name: ' ' })))
    await assertFails(updateDoc(pkgRef(db, 'p1'), materialEdit(USERS.admin, { costCodes: [] })))
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
    await assertSucceeds(updateDoc(ref, materialEdit(USERS.qs, { name: 'Steel — Rev A' })))   // D4: material → stamped
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

// ── ADR-96 / D4 — approval segregation on AWARD ─────────────────────────────
//
// D4: with the company's segregation policy enabled the awarder may be neither
// the package's creator nor its LAST MATERIAL draft editor (`lastMaterialEditBy`,
// D3 #46). Material: name, description, scope, costCodes. Cosmetic: notes,
// closingDate. A package without recorded provenance fails CLOSED in strict mode.

describe('ADR-96 / D4 — approval segregation: a package\'s preparer cannot award it when the policy is enabled', () => {
  // A fourth financial member so creator, material editor, cosmetic editor and
  // an independent awarder can all differ.
  const PM2 = { uid: 'u_pm2', role: 'project_manager', companyId: COMPANY_A }
  const seedPolicy = (segregationEnabled, companyId = COMPANY_A) => testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), `companies/${companyId}/approvalPolicy/current`), { segregationEnabled, updatedAt: Timestamp.now() })
  })
  const readPkg = async (id) => {
    let data = null
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const s = await getDoc(doc(c.firestore(), packagesPath(), id))
      data = s.exists() ? s.data() : null
    })
    return data
  }

  // Created (and issued) by the QS, last MATERIALLY edited (and last updated) by
  // the PM; the admin and PM2 are independent. D4 changed this fixture: before
  // D3 #46 the Rules compared `updatedBy`, so `updatedBy: pm` alone made the PM
  // a preparer; now only `lastMaterialEditBy` does, so the seed states it.
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'users', PM2.uid), { role: PM2.role, companyId: PM2.companyId, name: PM2.uid })
    })
    await seedPackage('p1', 'issued', USERS.qs, { updatedBy: USERS.pm.uid, lastMaterialEditBy: USERS.pm.uid })
    await seedBid('bid1', 'p1')
  })

  // ── policy disabled / absent / other company — unchanged ──────────────────

  it('policy ABSENT: the creator awards their own package exactly as before', async () => {
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'p1'), awardWrite(USERS.qs, 'bid1')))
    expect(await readPkg('p1')).toMatchObject({ status: 'awarded', awardedBy: USERS.qs.uid, awardedBidId: 'bid1' })
  })
  it('policy ABSENT: the last (material) editor awards as before', async () => {
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'p1'), awardWrite(USERS.pm, 'bid1')))
  })
  it('policy present with segregationEnabled: false — the creator awards', async () => {
    await seedPolicy(false)
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'p1'), awardWrite(USERS.qs, 'bid1')))
  })
  it('policy ABSENT: a legacy package with NO provenance stamp is awarded by its creator as before', async () => {
    await seedPackage('lg0', 'issued', USERS.qs, {}, { legacy: true })
    await seedBid('bid_lg0', 'lg0')
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'lg0'), awardWrite(USERS.qs, 'bid_lg0')))
  })
  it('another company\'s ENABLED policy does not affect Company A', async () => {
    await seedPolicy(true, COMPANY_B)
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'p1'), awardWrite(USERS.qs, 'bid1')))
  })

  // ── strict mode — who may award ────────────────────────────────────────────

  it('policy ENABLED: the creator and the last material editor are refused; the package is unchanged', async () => {
    await seedPolicy(true)
    const before = await readPkg('p1')
    await assertFails(updateDoc(pkgRef(ctx(USERS.qs), 'p1'), awardWrite(USERS.qs, 'bid1')))
    await assertFails(updateDoc(pkgRef(ctx(USERS.pm), 'p1'), awardWrite(USERS.pm, 'bid1')))
    expect(await readPkg('p1')).toEqual(before)
    expect(before).toMatchObject({ status: 'issued', awardedBy: null, awardedBidId: null })
  })
  it('policy ENABLED: an independent financial member awards', async () => {
    await seedPolicy(true)
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.admin), 'p1'), awardWrite(USERS.admin, 'bid1')))
    expect(await readPkg('p1')).toMatchObject({ status: 'awarded', awardedBy: USERS.admin.uid })
  })
  it('policy ENABLED: the company administrator has NO bypass — an admin creator and an admin material editor are refused', async () => {
    await seedPolicy(true)
    await seedPackage('adm1', 'issued', USERS.admin)
    await seedPackage('adm2', 'issued', USERS.qs, { lastMaterialEditBy: USERS.admin.uid })
    await seedBid('bid_adm1', 'adm1')
    await seedBid('bid_adm2', 'adm2')
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'adm1'), awardWrite(USERS.admin, 'bid_adm1')))
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'adm2'), awardWrite(USERS.admin, 'bid_adm2')))
  })

  it('ARCHITECT CASE — A materially edits, B makes a cosmetic edit, A tries to award → REFUSED; B (not the creator) may award', async () => {
    await seedPolicy(true)
    // Creator: admin (through the rules).
    await assertSucceeds(setDoc(pkgRef(ctx(USERS.admin), 'ac1'), draftPayload(USERS.admin)))
    // A = QS: a material edit (scope) — the stamp moves to A.
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'ac1'), materialEdit(USERS.qs, { scope: 'Steel incl. secondary members' })))
    expect(await readPkg('ac1')).toMatchObject({ lastMaterialEditBy: USERS.qs.uid })
    // B = PM: a cosmetic edit (notes + closing date) — B is the LAST editor, A stays the material editor.
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'ac1'), draftEdit(USERS.pm, { notes: 'tidied', closingDate: '2026-09-15' })))
    expect(await readPkg('ac1')).toMatchObject({ lastMaterialEditBy: USERS.qs.uid, updatedBy: USERS.pm.uid })
    // Issuing is not an approval; anyone may issue.
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'ac1'), issueWrite(USERS.pm)))
    await seedBid('bid_ac1', 'ac1')
    const issued = await readPkg('ac1')
    // A (hidden behind B's cosmetic edit) is refused; so is the creator.
    await assertFails(updateDoc(pkgRef(ctx(USERS.qs), 'ac1'), awardWrite(USERS.qs, 'bid_ac1')))
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'ac1'), awardWrite(USERS.admin, 'bid_ac1')))
    expect(await readPkg('ac1')).toEqual(issued)
    // B made only a cosmetic edit and is not the creator — B may award.
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'ac1'), awardWrite(USERS.pm, 'bid_ac1')))
    expect(await readPkg('ac1')).toMatchObject({ status: 'awarded', awardedBy: USERS.pm.uid, lastMaterialEditBy: USERS.qs.uid })
  })

  it('the creator stays excluded after someone else\'s material edit (both preparers are checked)', async () => {
    await seedPolicy(true)
    await seedPackage('cr1', 'draft', USERS.qs)
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'cr1'), materialEdit(USERS.pm, { name: 'Renamed' })))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'cr1'), issueWrite(USERS.pm)))
    await seedBid('bid_cr1', 'cr1')
    await assertFails(updateDoc(pkgRef(ctx(USERS.qs), 'cr1'), awardWrite(USERS.qs, 'bid_cr1')))
    await assertFails(updateDoc(pkgRef(ctx(USERS.pm), 'cr1'), awardWrite(USERS.pm, 'bid_cr1')))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.admin), 'cr1'), awardWrite(USERS.admin, 'bid_cr1')))
  })

  it('each of name / description / scope / costCodes is material; a MIXED material + cosmetic edit stamps the editor at server time', async () => {
    for (const [i, patch] of [
      { name: 'New name' },
      { description: 'New description' },
      { scope: 'New scope' },
      { costCodes: [{ costCodeId: 'cc3', costCodeName: '03-100 — Secondary Steel' }] },
    ].entries()) {
      await seedPackage(`mk${i}`, 'draft', USERS.qs)
      await assertFails(updateDoc(pkgRef(ctx(USERS.pm), `mk${i}`), draftEdit(USERS.pm, patch)))         // without the stamp
      await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), `mk${i}`), materialEdit(USERS.pm, patch)))
      expect((await readPkg(`mk${i}`)).lastMaterialEditBy).toBe(USERS.pm.uid)
    }
    await seedPackage('mx1', 'draft', USERS.qs)
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'mx1'), materialEdit(USERS.pm, { scope: 'Wider', notes: 'and a note', closingDate: '2026-10-01' })))
    const pkg = await readPkg('mx1')
    expect(pkg).toMatchObject({ lastMaterialEditBy: USERS.pm.uid, notes: 'and a note', closingDate: '2026-10-01' })
    expect(pkg.lastMaterialEditAt.isEqual(pkg.updatedAt)).toBe(true)
  })

  it('policy toggled between edit and award: the policy at AWARD time decides', async () => {
    await seedPackage('tg1', 'draft', USERS.admin)
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'tg1'), materialEdit(USERS.qs, { scope: 'Edited while disabled' })))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'tg1'), issueWrite(USERS.qs)))
    await seedBid('bid_tg1', 'tg1')
    await seedPolicy(true)
    await assertFails(updateDoc(pkgRef(ctx(USERS.qs), 'tg1'), awardWrite(USERS.qs, 'bid_tg1')))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'tg1'), awardWrite(USERS.pm, 'bid_tg1')))
    // Edited while enabled, awarded after disabling → the material editor awards.
    await seedPackage('tg2', 'draft', USERS.admin)
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'tg2'), materialEdit(USERS.qs, { scope: 'Edited while enabled' })))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'tg2'), issueWrite(USERS.qs)))
    await seedBid('bid_tg2', 'tg2')
    await seedPolicy(false)
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'tg2'), awardWrite(USERS.qs, 'bid_tg2')))
  })

  // ── stamp manipulation ─────────────────────────────────────────────────────

  it('create: the stamp must be the caller at server time — another uid, null, a client clock or an omitted stamp is refused', async () => {
    const db = ctx(USERS.qs)
    await assertFails(setDoc(pkgRef(db, 'sm1'), draftPayload(USERS.qs, { lastMaterialEditBy: USERS.admin.uid })))
    await assertFails(setDoc(pkgRef(db, 'sm2'), draftPayload(USERS.qs, { lastMaterialEditBy: null })))
    await assertFails(setDoc(pkgRef(db, 'sm3'), draftPayload(USERS.qs, { lastMaterialEditAt: null })))
    for (const [i, clock] of CLIENT_CLOCKS.entries()) {
      await assertFails(setDoc(pkgRef(db, `sm4-${i}`), draftPayload(USERS.qs, { lastMaterialEditAt: clock() })))
    }
    for (const key of ['lastMaterialEditBy', 'lastMaterialEditAt']) {
      const p = draftPayload(USERS.qs)
      delete p[key]
      await assertFails(setDoc(pkgRef(db, `sm5-${key}`), p))
    }
    await assertSucceeds(setDoc(pkgRef(db, 'sm6'), draftPayload(USERS.qs)))
  })

  it('material draft edit: a stamp naming someone else, a client clock, a deleted, an omitted or a STALE (stored) stamp is refused', async () => {
    await seedPackage('me1', 'draft', USERS.qs)
    const stored = await readPkg('me1')
    const db = ctx(USERS.pm)
    const patch = { scope: 'Materially changed' }
    await assertFails(updateDoc(pkgRef(db, 'me1'), materialEdit(USERS.pm, { ...patch, lastMaterialEditBy: USERS.admin.uid })))
    await assertFails(updateDoc(pkgRef(db, 'me1'), materialEdit(USERS.pm, { ...patch, lastMaterialEditBy: USERS.qs.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(pkgRef(db, 'me1'), materialEdit(USERS.pm, { ...patch, lastMaterialEditAt: clock() })))
    }
    await assertFails(updateDoc(pkgRef(db, 'me1'), materialEdit(USERS.pm, { ...patch, lastMaterialEditBy: deleteField(), lastMaterialEditAt: deleteField() })))
    await assertFails(updateDoc(pkgRef(db, 'me1'), draftEdit(USERS.pm, patch)))     // omitted
    await assertFails(updateDoc(pkgRef(db, 'me1'), draftEdit(USERS.pm, { ...patch, lastMaterialEditBy: stored.lastMaterialEditBy, lastMaterialEditAt: stored.lastMaterialEditAt })))
    await assertFails(updateDoc(pkgRef(db, 'me1'), materialEdit(USERS.pm, { ...patch, lastMaterialEditAt: stored.lastMaterialEditAt })))
    expect(await readPkg('me1')).toEqual(stored)
  })

  it('cosmetic draft edit (notes / closingDate): moving the stamp to anyone, refreshing its time or deleting it is refused', async () => {
    await seedPackage('ce1', 'draft', USERS.qs)
    const stored = await readPkg('ce1')
    const db = ctx(USERS.pm)
    for (const patch of [{ notes: 'cosmetic' }, { closingDate: '2026-12-24' }, {}]) {
      await assertFails(updateDoc(pkgRef(db, 'ce1'), materialEdit(USERS.pm, patch)))
      await assertFails(updateDoc(pkgRef(db, 'ce1'), draftEdit(USERS.pm, { ...patch, lastMaterialEditBy: USERS.admin.uid })))
      await assertFails(updateDoc(pkgRef(db, 'ce1'), draftEdit(USERS.pm, { ...patch, lastMaterialEditAt: serverTimestamp() })))
      await assertFails(updateDoc(pkgRef(db, 'ce1'), draftEdit(USERS.pm, { ...patch, lastMaterialEditBy: deleteField() })))
    }
    // Re-writing a material key with its stored value is not a material change either.
    await assertFails(updateDoc(pkgRef(db, 'ce1'), materialEdit(USERS.pm, { name: stored.name, costCodes: stored.costCodes })))
    expect(await readPkg('ce1')).toEqual(stored)
    await assertSucceeds(updateDoc(pkgRef(db, 'ce1'), draftEdit(USERS.pm, { notes: 'cosmetic', closingDate: '2026-12-24' })))
    expect(await readPkg('ce1')).toMatchObject({ lastMaterialEditBy: USERS.qs.uid, updatedBy: USERS.pm.uid })
  })

  it('issue, the ISSUED edit carve-out, award and cancel cannot write or move the stamp', async () => {
    await seedPolicy(true)
    await seedPackage('tr1', 'draft', USERS.qs)
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'tr1'), issueWrite(USERS.admin, materialStamp(USERS.admin))))
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'tr1'), cancelWrite(USERS.admin, 'Scope changed', materialStamp(USERS.admin))))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.admin), 'tr1'), issueWrite(USERS.admin)))
    // Issued: the closingDate / notes carve-out admits no stamp key.
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'tr1'), draftEdit(USERS.admin, { notes: 'extended', ...materialStamp(USERS.admin) })))
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'tr1'), draftEdit(USERS.admin, { closingDate: '2026-11-30', lastMaterialEditBy: USERS.pm.uid })))
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'tr1'), draftEdit(USERS.admin, { notes: 'x', lastMaterialEditBy: deleteField() })))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.admin), 'tr1'), draftEdit(USERS.admin, { notes: 'extended', closingDate: '2026-11-30' })))
    await seedBid('bid_tr1', 'tr1')
    // Award cannot launder the provenance — neither the creator renaming it, nor an independent awarder.
    await assertFails(updateDoc(pkgRef(ctx(USERS.qs), 'tr1'), awardWrite(USERS.qs, 'bid_tr1', 'Apex Steel Pty Ltd', { lastMaterialEditBy: USERS.pm.uid })))
    await assertFails(updateDoc(pkgRef(ctx(USERS.pm), 'tr1'), awardWrite(USERS.pm, 'bid_tr1', 'Apex Steel Pty Ltd', materialStamp(USERS.pm))))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'tr1'), awardWrite(USERS.pm, 'bid_tr1')))
    expect(await readPkg('tr1')).toMatchObject({ status: 'awarded', awardedBy: USERS.pm.uid, lastMaterialEditBy: USERS.qs.uid })
    // Issued → cancelled with a stamp change is refused too.
    await seedPackage('tr2', 'issued', USERS.qs)
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), 'tr2'), cancelWrite(USERS.admin, 'Scope changed', { lastMaterialEditAt: serverTimestamp() })))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.admin), 'tr2'), cancelWrite(USERS.admin)))
    expect((await readPkg('tr2')).lastMaterialEditBy).toBe(USERS.qs.uid)
  })

  // ── legacy packages (no provenance recorded) ───────────────────────────────

  it('LEGACY issued package without a stamp, strict mode: award is refused for EVERYONE (fails closed) and the issued carve-out cannot establish one', async () => {
    await seedPolicy(true)
    await seedPackage('lg1', 'issued', USERS.qs, {}, { legacy: true })
    await seedBid('bid_lg1', 'lg1')
    for (const user of [USERS.admin, USERS.pm, USERS.qs, PM2]) {
      await assertFails(updateDoc(pkgRef(ctx(user), 'lg1'), awardWrite(user, 'bid_lg1')))
    }
    await assertFails(updateDoc(pkgRef(ctx(USERS.pm), 'lg1'), draftEdit(USERS.pm, { notes: 'x', ...materialStamp(USERS.pm) })))
    expect((await readPkg('lg1')).status).toBe('issued')
  })

  it('LEGACY draft without a stamp, strict mode: a cosmetic edit records nothing; a material save by A records A; after issue B (not the creator) may award, A and the creator may not', async () => {
    await seedPolicy(true)
    await seedPackage('lg2', 'draft', USERS.qs, {}, { legacy: true })
    await assertFails(updateDoc(pkgRef(ctx(USERS.pm), 'lg2'), draftEdit(USERS.pm, { notes: 'n', ...materialStamp(USERS.pm) })))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'lg2'), draftEdit(USERS.pm, { notes: 'n' })))
    expect((await readPkg('lg2')).lastMaterialEditBy).toBeUndefined()
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'lg2'), materialEdit(USERS.pm, { scope: 'Re-scoped' })))   // A = PM
    expect((await readPkg('lg2')).lastMaterialEditBy).toBe(USERS.pm.uid)
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.pm), 'lg2'), issueWrite(USERS.pm)))
    await seedBid('bid_lg2', 'lg2')
    await assertFails(updateDoc(pkgRef(ctx(USERS.pm), 'lg2'), awardWrite(USERS.pm, 'bid_lg2')))     // A
    await assertFails(updateDoc(pkgRef(ctx(USERS.qs), 'lg2'), awardWrite(USERS.qs, 'bid_lg2')))     // creator
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.admin), 'lg2'), awardWrite(USERS.admin, 'bid_lg2')))   // B
  })

  it('policy ENABLED: issue, issued edit and cancel are unchanged for the preparer', async () => {
    await seedPolicy(true)
    await seedPackage('p2', 'draft', USERS.qs)
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'p2'), issueWrite(USERS.qs)))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'p1'), draftEdit(USERS.qs, { notes: 'closing extended' })))
    await assertSucceeds(updateDoc(pkgRef(ctx(USERS.qs), 'p1'), cancelWrite(USERS.qs)))
  })
})
