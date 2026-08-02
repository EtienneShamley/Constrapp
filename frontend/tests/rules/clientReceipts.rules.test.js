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

// ── Client Receipt Security Rules — emulator tests ───────────────────────────
//
// Executes every case documented in docs/TESTING.md §15j-x against the Firestore
// emulator. These verify the RULES, not the UI: each write below is a direct SDK
// call, exactly what a client bypassing the app would issue.
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set, so it
// can never reach a production Firebase project. The npm script starts the
// emulator via `firebase emulators:exec`, which sets that variable.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'

// One user per role, all in Company A, plus one financial-role user in Company B
// for tenant-isolation checks.
const USERS = {
  admin: { uid: 'u_admin', role: 'company_admin',   companyId: COMPANY_A },
  pm:    { uid: 'u_pm',    role: 'project_manager', companyId: COMPANY_A },
  qs:    { uid: 'u_qs',    role: 'qs',              companyId: COMPANY_A },
  sub:   { uid: 'u_sub',   role: 'subcontractor',   companyId: COMPANY_A },
  client:{ uid: 'u_client',role: 'client',          companyId: COMPANY_A },
  other: { uid: 'u_other', role: 'company_admin',   companyId: COMPANY_B },
}

let testEnv

const receiptsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/clientReceipts`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const rcpRef = (db, id, companyId = COMPANY_A) => doc(db, receiptsPath(companyId), id)

// A valid draft payload, exactly as hooks/useClientReceipts.jsx writes it.
function draftPayload(user, overrides = {}) {
  return {
    receiptNumber: 'CR-0001',
    status:        'draft',
    docType:       'receipt',

    // A receipt without a client is not a record — required non-empty strings.
    clientId:   'contact1',
    clientName: 'Acme Developments',

    receiptDate: '2026-08-01',
    amount:      1100,

    paymentMethod:      'bank_transfer',
    paymentMethodOther: '',
    bankReference:      'CBA 20260801 998',
    externalReference:  '',
    notes:              '',

    allocations: [
      { clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', allocatedAmount: 1100 },
    ],
    allocatedTotal:    1100,
    unallocatedAmount: 0,

    currency: 'AUD',
    revision: 1,

    postedAt:   null,
    postedBy:   null,
    voidedAt:   null,
    voidedBy:   null,
    voidReason: '',

    attachments:  [],
    externalRefs: {},

    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

// Seeds a document directly, bypassing rules — the arrange step for update tests.
async function seed(id, status, user = USERS.admin, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const base = draftPayload(user)
    const lifecycle =
      status === 'posted' ? { status: 'posted', postedAt: Timestamp.now(), postedBy: user.uid } :
      status === 'void'   ? { status: 'void', voidedAt: Timestamp.now(), voidedBy: user.uid, voidReason: 'Keyed twice' } :
      { status: 'draft' }
    await setDoc(doc(db, receiptsPath(), id), {
      ...base,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...lifecycle,
      ...extra,
    })
  })
}

// The three write shapes the app performs, so tests exercise the real payloads.
const postWrite = (user, extra = {}) => ({
  status: 'posted',
  postedAt: serverTimestamp(), postedBy: user.uid,
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const voidWrite = (user, reason = 'Duplicate of CR-0007', extra = {}) => ({
  status: 'void',
  voidedAt: serverTimestamp(), voidedBy: user.uid, voidReason: reason,
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const draftEdit = (user, extra = {}) => ({
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})

// Client-supplied clock values that must NEVER satisfy `== request.time`.
//
// ⚠️ DELIBERATELY SKEWED, NOT `Timestamp.now()`. A bare `Timestamp.now()` is the
// client clock read microseconds before the write reaches the emulator, so it
// can legitimately coincide with `request.time` — which makes the rule ACCEPT it
// and turns the assertion into a coin flip. (This was not hypothetical:
// clientInvoices.rules.test.js used `Timestamp.now()` and failed intermittently
// for exactly this reason until it was moved to the same pattern.) These offsets
// are far enough from server time to be deterministic while still proving the
// same rule: a forged stamp is rejected.
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)), // clock ahead
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)), // clock behind
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')), // plainly forged
]

// Builds n allocations of $1 each, with matching scalar totals.
const manyAllocations = (n) => ({
  allocations: Array.from({ length: n }, (_, i) => ({
    clientInvoiceId: `inv${i}`, invoiceNumber: `CI-${String(i).padStart(4, '0')}`, allocatedAmount: 1,
  })),
  amount: n,
  allocatedTotal: n,
  unallocatedAmount: 0,
})

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
      await assertSucceeds(setDoc(rcpRef(ctx(user), `d_${user.uid}`), draftPayload(user)))
    }
  })

  it('1b. financial roles read the register', async () => {
    await seed('r1', 'draft')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(rcpRef(ctx(user), 'r1')))
    }
  })

  it('2. financial role edits a draft (amount, date, method, references, allocations)', async () => {
    await seed('r1', 'draft')
    await assertSucceeds(updateDoc(rcpRef(ctx(USERS.qs), 'r1'), draftEdit(USERS.qs, {
      amount: 2500,
      receiptDate: '2026-08-14',
      paymentMethod: 'cheque',
      bankReference: 'CHQ 4471',
      allocations: [
        { clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', allocatedAmount: 1500 },
        { clientInvoiceId: 'inv2', invoiceNumber: 'CI-0002', allocatedAmount: 600 },
      ],
      allocatedTotal: 2100,
      unallocatedAmount: 400,
      notes: 'part settlement',
    })))
  })

  it('3. draft -> posted with correct postedAt/postedBy', async () => {
    await seed('r1', 'draft')
    await assertSucceeds(updateDoc(rcpRef(ctx(USERS.pm), 'r1'), postWrite(USERS.pm)))
  })

  it('4. draft -> void with a non-empty reason', async () => {
    await seed('r1', 'draft')
    await assertSucceeds(updateDoc(rcpRef(ctx(USERS.admin), 'r1'), voidWrite(USERS.admin)))
  })

  it('5. posted -> void with a non-empty reason', async () => {
    await seed('r1', 'posted')
    await assertSucceeds(updateDoc(rcpRef(ctx(USERS.admin), 'r1'), voidWrite(USERS.admin)))
  })

  it('6. a fully UNALLOCATED receipt (money on account) is permitted', async () => {
    await assertSucceeds(setDoc(rcpRef(ctx(USERS.admin), 'onacct'), draftPayload(USERS.admin, {
      allocations: [], allocatedTotal: 0, unallocatedAmount: 1100,
    })))
  })

  it('7. exactly MAX_ALLOCATIONS (100) allocations are permitted', async () => {
    await assertSucceeds(setDoc(rcpRef(ctx(USERS.admin), 'max'), draftPayload(USERS.admin, manyAllocations(100))))
  })

  it('8. a backdated receipt is permitted (last month\'s bank statement)', async () => {
    await assertSucceeds(setDoc(rcpRef(ctx(USERS.admin), 'back'), draftPayload(USERS.admin, {
      receiptDate: '2020-01-31',
    })))
  })
})

// ── CENT ARITHMETIC ──────────────────────────────────────────────────────────
//
// Money is decimal; rules numbers are IEEE-754 doubles. An exact
// `allocatedTotal + unallocatedAmount == amount` would REJECT legitimate cent
// values (0.10 + 0.20 === 0.30000000000000004). The rules compare WHOLE CENTS
// via math.round(v * 100) instead — equivalent to a half-cent tolerance, so a
// discrepancy of one cent or more still fails. These cases prove both halves.

describe('cent arithmetic (the scalar invariant must accept real money)', () => {
  it('accepts 0.30 = 0.10 + 0.20 (the classic float failure)', async () => {
    await assertSucceeds(setDoc(rcpRef(ctx(USERS.admin), 'c1'), draftPayload(USERS.admin, {
      amount: 0.30,
      allocations: [{ clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', allocatedAmount: 0.10 }],
      allocatedTotal: 0.10,
      unallocatedAmount: 0.20,
    })))
  })

  it('accepts 10.01 = 3.33 + 6.68', async () => {
    await assertSucceeds(setDoc(rcpRef(ctx(USERS.admin), 'c2'), draftPayload(USERS.admin, {
      amount: 10.01,
      allocations: [{ clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', allocatedAmount: 3.33 }],
      allocatedTotal: 3.33,
      unallocatedAmount: 6.68,
    })))
  })

  it('accepts 1000.00 = 999.99 + 0.01', async () => {
    await assertSucceeds(setDoc(rcpRef(ctx(USERS.admin), 'c3'), draftPayload(USERS.admin, {
      amount: 1000.00,
      allocations: [{ clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', allocatedAmount: 999.99 }],
      allocatedTotal: 999.99,
      unallocatedAmount: 0.01,
    })))
  })

  it('accepts several other cent combinations', async () => {
    const cases = [
      { amount: 0.03, allocatedTotal: 0.01, unallocatedAmount: 0.02 },
      { amount: 1.15, allocatedTotal: 1.10, unallocatedAmount: 0.05 },
      { amount: 12345.67, allocatedTotal: 12345.66, unallocatedAmount: 0.01 },
      { amount: 0.07, allocatedTotal: 0.07, unallocatedAmount: 0 },
    ]
    for (const [i, c] of cases.entries()) {
      await assertSucceeds(setDoc(rcpRef(ctx(USERS.admin), `cc${i}`), draftPayload(USERS.admin, {
        ...c,
        allocations: [{ clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', allocatedAmount: c.allocatedTotal }],
      })))
    }
  })

  it('STILL REJECTS a one-cent discrepancy in either direction', async () => {
    const db = ctx(USERS.admin)
    // Claims one cent more allocated than the receipt holds.
    await assertFails(setDoc(rcpRef(db, 'bad1'), draftPayload(USERS.admin, {
      amount: 1000.00, allocatedTotal: 999.99, unallocatedAmount: 0.02,
    })))
    // Loses a cent.
    await assertFails(setDoc(rcpRef(db, 'bad2'), draftPayload(USERS.admin, {
      amount: 1000.00, allocatedTotal: 999.99, unallocatedAmount: 0.00,
    })))
    await assertFails(setDoc(rcpRef(db, 'bad3'), draftPayload(USERS.admin, {
      amount: 0.30, allocatedTotal: 0.10, unallocatedAmount: 0.21,
    })))
  })
})

// ── MUST REJECT ──────────────────────────────────────────────────────────────

describe('MUST REJECT', () => {
  it('1. create directly as posted (or void)', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(rcpRef(db, 'x1'), draftPayload(USERS.admin, {
      status: 'posted', postedAt: serverTimestamp(), postedBy: USERS.admin.uid,
    })))
    await assertFails(setDoc(rcpRef(db, 'x2'), draftPayload(USERS.admin, {
      status: 'void', voidedAt: serverTimestamp(), voidedBy: USERS.admin.uid, voidReason: 'nope',
    })))
  })

  it('2. create with forged lifecycle stamps', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(rcpRef(db, 'x1'), draftPayload(USERS.admin, { postedAt: Timestamp.now() })))
    await assertFails(setDoc(rcpRef(db, 'x2'), draftPayload(USERS.admin, { postedBy: USERS.admin.uid })))
    await assertFails(setDoc(rcpRef(db, 'x3'), draftPayload(USERS.admin, { voidedAt: Timestamp.now() })))
    await assertFails(setDoc(rcpRef(db, 'x4'), draftPayload(USERS.admin, { voidedBy: USERS.admin.uid })))
  })

  it('2b. create impersonating another user, or with a bad docType/currency/revision', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(rcpRef(db, 'x1'), draftPayload(USERS.admin, { createdBy: USERS.pm.uid })))
    await assertFails(setDoc(rcpRef(db, 'x2'), draftPayload(USERS.admin, { docType: 'refund' })))
    await assertFails(setDoc(rcpRef(db, 'x3'), draftPayload(USERS.admin, { currency: 'AU' })))
    await assertFails(setDoc(rcpRef(db, 'x4'), draftPayload(USERS.admin, { currency: 'aud' })))
    await assertFails(setDoc(rcpRef(db, 'x5'), draftPayload(USERS.admin, { currency: '1234' })))
    await assertFails(setDoc(rcpRef(db, 'x6'), draftPayload(USERS.admin, { revision: '1' })))
  })

  it('2c. create without a client (clientId / clientName are REQUIRED non-empty)', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(rcpRef(db, 'x1'), draftPayload(USERS.admin, { clientId: null })))
    await assertFails(setDoc(rcpRef(db, 'x2'), draftPayload(USERS.admin, { clientId: '' })))
    await assertFails(setDoc(rcpRef(db, 'x3'), draftPayload(USERS.admin, { clientName: '' })))
    await assertFails(setDoc(rcpRef(db, 'x4'), draftPayload(USERS.admin, { clientName: null })))
  })

  it('2d. create with a malformed receiptDate', async () => {
    const db = ctx(USERS.admin)
    for (const [i, receiptDate] of ['01/08/2026', '2026-8-1', '2026/08/01', '', 'today', '20260801'].entries()) {
      await assertFails(setDoc(rcpRef(db, `x${i}`), draftPayload(USERS.admin, { receiptDate })))
    }
    // A Timestamp is not the stored representation either.
    await assertFails(setDoc(rcpRef(db, 'xts'), draftPayload(USERS.admin, { receiptDate: Timestamp.now() })))
  })

  it('2e. create with an invalid amount (zero, negative, or non-number)', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(rcpRef(db, 'x1'), draftPayload(USERS.admin, {
      amount: 0, allocations: [], allocatedTotal: 0, unallocatedAmount: 0,
    })))
    await assertFails(setDoc(rcpRef(db, 'x2'), draftPayload(USERS.admin, {
      amount: -100, allocations: [], allocatedTotal: 0, unallocatedAmount: -100,
    })))
    await assertFails(setDoc(rcpRef(db, 'x3'), draftPayload(USERS.admin, {
      amount: '1100', allocatedTotal: 1100, unallocatedAmount: 0,
    })))
  })

  it('2f. create with negative allocatedTotal / unallocatedAmount', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(rcpRef(db, 'x1'), draftPayload(USERS.admin, {
      amount: 100, allocatedTotal: -50, unallocatedAmount: 150,
    })))
    await assertFails(setDoc(rcpRef(db, 'x2'), draftPayload(USERS.admin, {
      amount: 100, allocatedTotal: 150, unallocatedAmount: -50,
    })))
    await assertFails(setDoc(rcpRef(db, 'x3'), draftPayload(USERS.admin, {
      amount: 100, allocatedTotal: '50', unallocatedAmount: 50,
    })))
  })

  it('2g. create claiming more allocation than the receipt amount', async () => {
    await assertFails(setDoc(rcpRef(ctx(USERS.admin), 'x1'), draftPayload(USERS.admin, {
      amount: 1000,
      allocations: [{ clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', allocatedAmount: 5000 }],
      allocatedTotal: 5000,
      unallocatedAmount: 0,
    })))
  })

  it('2h. create with allocations that are not a list, or exceed the maximum', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(rcpRef(db, 'x1'), draftPayload(USERS.admin, {
      allocations: { inv1: 1100 },
    })))
    await assertFails(setDoc(rcpRef(db, 'x2'), draftPayload(USERS.admin, {
      allocations: 'inv1',
    })))
    await assertFails(setDoc(rcpRef(db, 'x3'), draftPayload(USERS.admin, manyAllocations(101))))
  })

  it('2i. create with a missing or empty payment method', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(rcpRef(db, 'x1'), draftPayload(USERS.admin, { paymentMethod: '' })))
    await assertFails(setDoc(rcpRef(db, 'x2'), draftPayload(USERS.admin, { paymentMethod: null })))
    await assertFails(setDoc(rcpRef(db, 'x3'), draftPayload(USERS.admin, { paymentMethod: 'x'.repeat(41) })))
  })

  it('3. draft edit changing receiptNumber', async () => {
    await seed('r1', 'draft')
    await assertFails(updateDoc(rcpRef(ctx(USERS.admin), 'r1'), draftEdit(USERS.admin, { receiptNumber: 'CR-9999' })))
  })

  it('4. draft edit changing currency', async () => {
    await seed('r1', 'draft')
    await assertFails(updateDoc(rcpRef(ctx(USERS.admin), 'r1'), draftEdit(USERS.admin, { currency: 'NZD' })))
  })

  it('5. draft edit changing createdAt / createdBy', async () => {
    await seed('r1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { createdAt: Timestamp.now() })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { createdBy: USERS.pm.uid })))
  })

  it('6. draft edit changing docType or revision', async () => {
    await seed('r1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { docType: 'refund' })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { revision: 2 })))
  })

  it('7. draft edit forging postedAt / postedBy / voidedAt / voidedBy', async () => {
    await seed('r1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { postedAt: Timestamp.now() })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { postedBy: USERS.admin.uid })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { voidedAt: Timestamp.now() })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { voidedBy: USERS.admin.uid })))
  })

  it('7b. draft edit breaking the scalar invariant, or the required shape', async () => {
    await seed('r1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { amount: 5000 })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { allocatedTotal: 999 })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { clientId: '' })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { receiptDate: '14/08/2026' })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { paymentMethod: '' })))
  })

  it('8. draft -> posted while also changing receipt content', async () => {
    await seed('r1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin, { amount: 5000 })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin, { receiptDate: '2027-01-01' })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin, { allocations: [] })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin, { bankReference: 'changed' })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin, { notes: 'sneaky' })))
  })

  it('9. draft -> posted with an incorrect postedBy (or updatedBy)', async () => {
    await seed('r1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin, { postedBy: USERS.pm.uid })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin, { updatedBy: USERS.pm.uid })))
  })

  it('10. void with an empty or whitespace-only reason, or a wrong voidedBy', async () => {
    await seed('r1', 'draft')
    await seed('r2', 'draft')
    await seed('r3', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r1'), voidWrite(USERS.admin, '')))
    await assertFails(updateDoc(rcpRef(db, 'r2'), voidWrite(USERS.admin, '   ')))
    await assertFails(updateDoc(rcpRef(db, 'r3'), voidWrite(USERS.admin, 'Duplicate', { voidedBy: USERS.pm.uid })))
  })

  it('11. posted receipt content edit (posted receipts are immutable)', async () => {
    await seed('r1', 'posted')
    const db = ctx(USERS.admin)
    for (const patch of [
      { amount: 5000, allocatedTotal: 5000, unallocatedAmount: 0 },
      { allocations: [] },
      { allocatedTotal: 0, unallocatedAmount: 1100 },
      { receiptDate: '2027-01-01' },
      { clientId: 'contact2' },
      { clientName: 'Someone Else' },
      { paymentMethod: 'cash' },
      { bankReference: 'after the fact' },
      { notes: 'after the fact' },
    ]) {
      await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, patch)))
    }
  })

  it('12. posted -> draft', async () => {
    await seed('r1', 'posted')
    await assertFails(updateDoc(rcpRef(ctx(USERS.admin), 'r1'), draftEdit(USERS.admin, {
      status: 'draft', postedAt: null, postedBy: null,
    })))
  })

  it('13. void -> posted, void -> draft, and any update to a void receipt', async () => {
    await seed('r1', 'void')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin)))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { status: 'draft' })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { notes: 'edit a void' })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), voidWrite(USERS.admin, 'again')))
  })

  it('14. any unknown / fabricated status', async () => {
    await seed('r1', 'draft')
    await seed('r2', 'posted')
    const db = ctx(USERS.admin)
    for (const status of ['paid', 'partially_paid', 'reconciled', 'cleared', 'issued']) {
      await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { status })))
      await assertFails(updateDoc(rcpRef(db, 'r2'), draftEdit(USERS.admin, { status })))
      await assertFails(setDoc(rcpRef(db, `new_${status}`), draftPayload(USERS.admin, { status })))
    }
  })

  it('15. delete of a draft receipt', async () => {
    await seed('r1', 'draft')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertFails(deleteDoc(rcpRef(ctx(user), 'r1')))
    }
  })

  it('16. delete of a posted (and a void) receipt', async () => {
    await seed('r1', 'posted')
    await seed('r2', 'void')
    const db = ctx(USERS.admin)
    await assertFails(deleteDoc(rcpRef(db, 'r1')))
    await assertFails(deleteDoc(rcpRef(db, 'r2')))
  })

  it('17. subcontractor and client cannot read or write', async () => {
    await seed('r1', 'draft')
    for (const user of [USERS.sub, USERS.client]) {
      const db = ctx(user)
      await assertFails(getDoc(rcpRef(db, 'r1')))
      await assertFails(setDoc(rcpRef(db, 'new1'), draftPayload(user)))
      await assertFails(updateDoc(rcpRef(db, 'r1'), draftEdit(user, { notes: 'nope' })))
      await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(user)))
      await assertFails(deleteDoc(rcpRef(db, 'r1')))
    }
  })

  it('17b. an unauthenticated client cannot read or write', async () => {
    await seed('r1', 'draft')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(rcpRef(db, 'r1')))
    await assertFails(setDoc(rcpRef(db, 'new1'), draftPayload(USERS.admin)))
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin)))
  })

  it('18. cross-company read or write is denied', async () => {
    await seed('r1', 'draft')
    const dbOther = ctx(USERS.other)
    // Company B's admin reaching into Company A.
    await assertFails(getDoc(rcpRef(dbOther, 'r1')))
    await assertFails(setDoc(rcpRef(dbOther, 'new1'), draftPayload(USERS.other)))
    await assertFails(updateDoc(rcpRef(dbOther, 'r1'), postWrite(USERS.other)))
    await assertFails(deleteDoc(rcpRef(dbOther, 'r1')))
    // Company A's admin reaching into Company B.
    await assertFails(setDoc(rcpRef(ctx(USERS.admin), 'new2', COMPANY_B), draftPayload(USERS.admin)))
  })
})

// ── serverTimestamp() must satisfy the request.time checks ───────────────────

describe('serverTimestamp satisfies request.time', () => {
  it('create: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(setDoc(rcpRef(db, 'ok'), draftPayload(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await assertFails(setDoc(rcpRef(db, `badc${i}`), draftPayload(USERS.admin, { createdAt: stamp() })))
      await assertFails(setDoc(rcpRef(db, `badu${i}`), draftPayload(USERS.admin, { updatedAt: stamp() })))
    }
  })

  it('post: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    await seed('r_ok', 'draft')
    const db = ctx(USERS.admin)
    await assertSucceeds(updateDoc(rcpRef(db, 'r_ok'), postWrite(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await seed(`rp${i}`, 'draft')
      await seed(`ru${i}`, 'draft')
      await assertFails(updateDoc(rcpRef(db, `rp${i}`), postWrite(USERS.admin, { postedAt: stamp() })))
      await assertFails(updateDoc(rcpRef(db, `ru${i}`), postWrite(USERS.admin, { updatedAt: stamp() })))
    }
  })

  it('void: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    await seed('r_ok', 'posted')
    const db = ctx(USERS.admin)
    await assertSucceeds(updateDoc(rcpRef(db, 'r_ok'), voidWrite(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await seed(`rv${i}`, 'posted')
      await seed(`rw${i}`, 'posted')
      await assertFails(updateDoc(rcpRef(db, `rv${i}`), voidWrite(USERS.admin, 'r', { voidedAt: stamp() })))
      await assertFails(updateDoc(rcpRef(db, `rw${i}`), voidWrite(USERS.admin, 'r', { updatedAt: stamp() })))
    }
  })

  it('the full app write sequence succeeds end to end: create -> edit -> post -> void', async () => {
    const db = ctx(USERS.qs)
    const ref = rcpRef(db, 'flow')
    await assertSucceeds(setDoc(ref, draftPayload(USERS.qs)))
    await assertSucceeds(updateDoc(ref, draftEdit(USERS.qs, {
      amount: 2500,
      allocations: [
        { clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', allocatedAmount: 1500 },
        { clientInvoiceId: 'inv2', invoiceNumber: 'CI-0002', allocatedAmount: 999.99 },
      ],
      allocatedTotal: 2499.99,
      unallocatedAmount: 0.01,
    })))
    await assertSucceeds(updateDoc(ref, postWrite(USERS.qs)))

    // withSecurityRulesDisabled resolves to undefined — capture via closure.
    let after
    await testEnv.withSecurityRulesDisabled(async (c) => {
      after = (await getDoc(doc(c.firestore(), receiptsPath(), 'flow'))).data()
    })
    expect(after.status).toBe('posted')
    expect(after.postedBy).toBe(USERS.qs.uid)
    expect(after.postedAt).not.toBeNull()
    expect(after.receiptNumber).toBe('CR-0001')
    expect(after.allocatedTotal).toBe(2499.99)
    expect(after.unallocatedAmount).toBe(0.01)

    // Posted content is now immutable; voiding is the only permitted update.
    await assertFails(updateDoc(ref, draftEdit(USERS.qs, { notes: 'too late' })))
    await assertSucceeds(updateDoc(ref, voidWrite(USERS.qs, 'Bank reversed the transfer')))
  })
})
