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

// ── Supplier Payment Security Rules — emulator tests ─────────────────────────
//
// Executes every case documented in docs/TESTING.md §15k-x against the Firestore
// emulator. These verify the RULES, not the UI: each write below is a direct SDK
// call, exactly what a client bypassing the app would issue.
//
// The money-OUT mirror of clientReceipts.rules.test.js, deliberately built to
// the same standard and reusing its conventions unchanged.
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

const paymentsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/supplierPayments`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const payRef = (db, id, companyId = COMPANY_A) => doc(db, paymentsPath(companyId), id)

// A valid draft payload, exactly as hooks/useSupplierPayments.jsx writes it.
function draftPayload(user, overrides = {}) {
  return {
    paymentNumber: 'SP-0001',
    status:        'draft',
    docType:       'payment',

    // A payment made to nobody is not a record — required non-empty strings.
    // (Supplier INVOICES may carry a legacy supplierId: null; a payment may not.)
    supplierId:   'contact1',
    supplierName: 'BuildCo Pty Ltd',

    paymentDate: '2026-08-01',
    amount:      990,

    paymentMethod:       'bank_transfer',
    paymentMethodOther:  '',
    bankReference:       'CBA 20260801 771',
    remittanceReference: 'RA-0031',
    externalReference:   '',
    notes:               '',

    // Both invoice references are frozen: Constrapp's SI-#### and the supplier's
    // own number, which is what AP staff reconcile against.
    allocations: [
      { supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471', allocatedAmount: 990 },
    ],
    allocatedTotal:    990,
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
    await setDoc(doc(db, paymentsPath(), id), {
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
const voidWrite = (user, reason = 'Paid the wrong supplier', extra = {}) => ({
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
    supplierInvoiceId: `si${i}`,
    invoiceNumber: `SI-${String(i).padStart(4, '0')}`,
    supplierInvoiceNumber: `INV-${i}`,
    allocatedAmount: 1,
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
      await assertSucceeds(setDoc(payRef(ctx(user), `d_${user.uid}`), draftPayload(user)))
    }
  })

  it('1b. financial roles read the register', async () => {
    await seed('p1', 'draft')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(payRef(ctx(user), 'p1')))
    }
  })

  it('2. financial role edits a draft (supplier, amount, date, method, references, allocations)', async () => {
    await seed('p1', 'draft')
    await assertSucceeds(updateDoc(payRef(ctx(USERS.qs), 'p1'), draftEdit(USERS.qs, {
      supplierId: 'contact2',
      supplierName: 'SteelCo Pty Ltd',
      amount: 2500,
      paymentDate: '2026-08-14',
      paymentMethod: 'cheque',
      bankReference: 'CHQ 8812',
      remittanceReference: 'RA-0044',
      allocations: [
        { supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471', allocatedAmount: 1500 },
        { supplierInvoiceId: 'si2', invoiceNumber: 'SI-0002', supplierInvoiceNumber: 'INV-4488', allocatedAmount: 600 },
      ],
      allocatedTotal: 2100,
      unallocatedAmount: 400,
      notes: 'part settlement',
    })))
  })

  it('3. draft -> posted with correct postedAt/postedBy', async () => {
    await seed('p1', 'draft')
    await assertSucceeds(updateDoc(payRef(ctx(USERS.pm), 'p1'), postWrite(USERS.pm)))
  })

  it('4. draft -> void with a non-empty reason', async () => {
    await seed('p1', 'draft')
    await assertSucceeds(updateDoc(payRef(ctx(USERS.admin), 'p1'), voidWrite(USERS.admin)))
  })

  it('5. posted -> void with a non-empty reason', async () => {
    await seed('p1', 'posted')
    await assertSucceeds(updateDoc(payRef(ctx(USERS.admin), 'p1'), voidWrite(USERS.admin)))
  })

  it('6. a fully UNALLOCATED payment (supplier advance / on account) is permitted', async () => {
    await assertSucceeds(setDoc(payRef(ctx(USERS.admin), 'onacct'), draftPayload(USERS.admin, {
      allocations: [], allocatedTotal: 0, unallocatedAmount: 990,
    })))
  })

  it('7. exactly MAX_ALLOCATIONS (100) allocations are permitted', async () => {
    await assertSucceeds(setDoc(payRef(ctx(USERS.admin), 'max'), draftPayload(USERS.admin, manyAllocations(100))))
  })

  it('8. a backdated payment is permitted (last month\'s bank statement)', async () => {
    await assertSucceeds(setDoc(payRef(ctx(USERS.admin), 'back'), draftPayload(USERS.admin, {
      paymentDate: '2020-01-31',
    })))
  })

  it('8b. an allocation with an EMPTY supplierInvoiceNumber is permitted (legacy invoice, no supplier reference)', async () => {
    await assertSucceeds(setDoc(payRef(ctx(USERS.admin), 'nosupref'), draftPayload(USERS.admin, {
      allocations: [
        { supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: '', allocatedAmount: 990 },
      ],
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
    await assertSucceeds(setDoc(payRef(ctx(USERS.admin), 'c1'), draftPayload(USERS.admin, {
      amount: 0.30,
      allocations: [{ supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471', allocatedAmount: 0.10 }],
      allocatedTotal: 0.10,
      unallocatedAmount: 0.20,
    })))
  })

  it('accepts 10.01 = 3.33 + 6.68', async () => {
    await assertSucceeds(setDoc(payRef(ctx(USERS.admin), 'c2'), draftPayload(USERS.admin, {
      amount: 10.01,
      allocations: [{ supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471', allocatedAmount: 3.33 }],
      allocatedTotal: 3.33,
      unallocatedAmount: 6.68,
    })))
  })

  it('accepts 1000.00 = 999.99 + 0.01', async () => {
    await assertSucceeds(setDoc(payRef(ctx(USERS.admin), 'c3'), draftPayload(USERS.admin, {
      amount: 1000.00,
      allocations: [{ supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471', allocatedAmount: 999.99 }],
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
      // A retained invoice: payableTotal 990 of a 1,100 gross invoice.
      { amount: 990.00, allocatedTotal: 990.00, unallocatedAmount: 0 },
    ]
    for (const [i, c] of cases.entries()) {
      await assertSucceeds(setDoc(payRef(ctx(USERS.admin), `cc${i}`), draftPayload(USERS.admin, {
        ...c,
        allocations: [{ supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471', allocatedAmount: c.allocatedTotal }],
      })))
    }
  })

  it('STILL REJECTS a one-cent discrepancy in either direction', async () => {
    const db = ctx(USERS.admin)
    // Claims one cent more allocated than the payment holds.
    await assertFails(setDoc(payRef(db, 'bad1'), draftPayload(USERS.admin, {
      amount: 1000.00, allocatedTotal: 999.99, unallocatedAmount: 0.02,
    })))
    // Loses a cent.
    await assertFails(setDoc(payRef(db, 'bad2'), draftPayload(USERS.admin, {
      amount: 1000.00, allocatedTotal: 999.99, unallocatedAmount: 0.00,
    })))
    await assertFails(setDoc(payRef(db, 'bad3'), draftPayload(USERS.admin, {
      amount: 0.30, allocatedTotal: 0.10, unallocatedAmount: 0.21,
    })))
  })
})

// ── MUST REJECT ──────────────────────────────────────────────────────────────

describe('MUST REJECT', () => {
  it('1. create directly as posted (or void)', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(payRef(db, 'x1'), draftPayload(USERS.admin, {
      status: 'posted', postedAt: serverTimestamp(), postedBy: USERS.admin.uid,
    })))
    await assertFails(setDoc(payRef(db, 'x2'), draftPayload(USERS.admin, {
      status: 'void', voidedAt: serverTimestamp(), voidedBy: USERS.admin.uid, voidReason: 'nope',
    })))
  })

  it('2. create with forged lifecycle stamps', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(payRef(db, 'x1'), draftPayload(USERS.admin, { postedAt: Timestamp.now() })))
    await assertFails(setDoc(payRef(db, 'x2'), draftPayload(USERS.admin, { postedBy: USERS.admin.uid })))
    await assertFails(setDoc(payRef(db, 'x3'), draftPayload(USERS.admin, { voidedAt: Timestamp.now() })))
    await assertFails(setDoc(payRef(db, 'x4'), draftPayload(USERS.admin, { voidedBy: USERS.admin.uid })))
  })

  it('2b. create impersonating another user, or with a bad docType/currency/revision', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(payRef(db, 'x1'), draftPayload(USERS.admin, { createdBy: USERS.pm.uid })))
    await assertFails(setDoc(payRef(db, 'x2'), draftPayload(USERS.admin, { docType: 'refund' })))
    await assertFails(setDoc(payRef(db, 'x3'), draftPayload(USERS.admin, { docType: 'receipt' })))
    await assertFails(setDoc(payRef(db, 'x4'), draftPayload(USERS.admin, { currency: 'AU' })))
    await assertFails(setDoc(payRef(db, 'x5'), draftPayload(USERS.admin, { currency: 'aud' })))
    await assertFails(setDoc(payRef(db, 'x6'), draftPayload(USERS.admin, { currency: '1234' })))
    await assertFails(setDoc(payRef(db, 'x7'), draftPayload(USERS.admin, { revision: '1' })))
  })

  it('2c. create without a supplier (supplierId / supplierName are REQUIRED non-empty)', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(payRef(db, 'x1'), draftPayload(USERS.admin, { supplierId: null })))
    await assertFails(setDoc(payRef(db, 'x2'), draftPayload(USERS.admin, { supplierId: '' })))
    await assertFails(setDoc(payRef(db, 'x3'), draftPayload(USERS.admin, { supplierName: '' })))
    await assertFails(setDoc(payRef(db, 'x4'), draftPayload(USERS.admin, { supplierName: null })))
  })

  it('2d. create with a malformed paymentDate', async () => {
    const db = ctx(USERS.admin)
    for (const [i, paymentDate] of ['01/08/2026', '2026-8-1', '2026/08/01', '', 'today', '20260801'].entries()) {
      await assertFails(setDoc(payRef(db, `x${i}`), draftPayload(USERS.admin, { paymentDate })))
    }
    // A Timestamp is not the stored representation either.
    await assertFails(setDoc(payRef(db, 'xts'), draftPayload(USERS.admin, { paymentDate: Timestamp.now() })))
  })

  it('2e. create with an invalid amount (zero, negative, or non-number)', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(payRef(db, 'x1'), draftPayload(USERS.admin, {
      amount: 0, allocations: [], allocatedTotal: 0, unallocatedAmount: 0,
    })))
    await assertFails(setDoc(payRef(db, 'x2'), draftPayload(USERS.admin, {
      amount: -100, allocations: [], allocatedTotal: 0, unallocatedAmount: -100,
    })))
    await assertFails(setDoc(payRef(db, 'x3'), draftPayload(USERS.admin, {
      amount: '990', allocatedTotal: 990, unallocatedAmount: 0,
    })))
  })

  it('2f. create with negative or non-number allocatedTotal / unallocatedAmount', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(payRef(db, 'x1'), draftPayload(USERS.admin, {
      amount: 100, allocatedTotal: -50, unallocatedAmount: 150,
    })))
    await assertFails(setDoc(payRef(db, 'x2'), draftPayload(USERS.admin, {
      amount: 100, allocatedTotal: 150, unallocatedAmount: -50,
    })))
    await assertFails(setDoc(payRef(db, 'x3'), draftPayload(USERS.admin, {
      amount: 100, allocatedTotal: '50', unallocatedAmount: 50,
    })))
    await assertFails(setDoc(payRef(db, 'x4'), draftPayload(USERS.admin, {
      amount: 100, allocatedTotal: 50, unallocatedAmount: '50',
    })))
  })

  it('2g. create claiming more allocation than the payment amount', async () => {
    await assertFails(setDoc(payRef(ctx(USERS.admin), 'x1'), draftPayload(USERS.admin, {
      amount: 1000,
      allocations: [{ supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471', allocatedAmount: 5000 }],
      allocatedTotal: 5000,
      unallocatedAmount: 0,
    })))
  })

  it('2h. create with allocations that are not a list, or exceed the maximum', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(payRef(db, 'x1'), draftPayload(USERS.admin, {
      allocations: { si1: 990 },
    })))
    await assertFails(setDoc(payRef(db, 'x2'), draftPayload(USERS.admin, {
      allocations: 'si1',
    })))
    await assertFails(setDoc(payRef(db, 'x3'), draftPayload(USERS.admin, manyAllocations(101))))
  })

  it('2i. create with a missing, empty, or over-long payment method', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(payRef(db, 'x1'), draftPayload(USERS.admin, { paymentMethod: '' })))
    await assertFails(setDoc(payRef(db, 'x2'), draftPayload(USERS.admin, { paymentMethod: null })))
    await assertFails(setDoc(payRef(db, 'x3'), draftPayload(USERS.admin, { paymentMethod: 'x'.repeat(41) })))
  })

  it('3. draft edit changing paymentNumber', async () => {
    await seed('p1', 'draft')
    await assertFails(updateDoc(payRef(ctx(USERS.admin), 'p1'), draftEdit(USERS.admin, { paymentNumber: 'SP-9999' })))
  })

  it('4. draft edit changing currency', async () => {
    await seed('p1', 'draft')
    await assertFails(updateDoc(payRef(ctx(USERS.admin), 'p1'), draftEdit(USERS.admin, { currency: 'NZD' })))
  })

  it('5. draft edit changing createdAt / createdBy', async () => {
    await seed('p1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { createdAt: Timestamp.now() })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { createdBy: USERS.pm.uid })))
  })

  it('6. draft edit changing docType or revision', async () => {
    await seed('p1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { docType: 'refund' })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { revision: 2 })))
  })

  it('7. draft edit forging postedAt / postedBy / voidedAt / voidedBy', async () => {
    await seed('p1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { postedAt: Timestamp.now() })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { postedBy: USERS.admin.uid })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { voidedAt: Timestamp.now() })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { voidedBy: USERS.admin.uid })))
  })

  it('7b. draft edit breaking the scalar invariant, or the required shape', async () => {
    await seed('p1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { amount: 5000 })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { allocatedTotal: 999 })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { supplierId: '' })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { supplierName: '' })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { paymentDate: '14/08/2026' })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { paymentMethod: '' })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { allocations: 'not-a-list' })))
  })

  it('8. draft -> posted while also changing payment content', async () => {
    await seed('p1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin, { amount: 5000 })))
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin, { paymentDate: '2027-01-01' })))
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin, { allocations: [] })))
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin, { supplierId: 'contact9' })))
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin, { bankReference: 'changed' })))
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin, { remittanceReference: 'changed' })))
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin, { notes: 'sneaky' })))
  })

  it('9. draft -> posted with an incorrect postedBy (or updatedBy)', async () => {
    await seed('p1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin, { postedBy: USERS.pm.uid })))
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin, { updatedBy: USERS.pm.uid })))
  })

  it('10. void with an empty or whitespace-only reason, or a wrong voidedBy', async () => {
    await seed('p1', 'draft')
    await seed('p2', 'draft')
    await seed('p3', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(payRef(db, 'p1'), voidWrite(USERS.admin, '')))
    await assertFails(updateDoc(payRef(db, 'p2'), voidWrite(USERS.admin, '   ')))
    await assertFails(updateDoc(payRef(db, 'p3'), voidWrite(USERS.admin, 'Duplicate', { voidedBy: USERS.pm.uid })))
  })

  it('11. posted payment content edit (posted payments are immutable)', async () => {
    await seed('p1', 'posted')
    const db = ctx(USERS.admin)
    for (const patch of [
      { amount: 5000, allocatedTotal: 5000, unallocatedAmount: 0 },
      { allocations: [] },
      { allocatedTotal: 0, unallocatedAmount: 990 },
      { paymentDate: '2027-01-01' },
      { supplierId: 'contact2' },
      { supplierName: 'Someone Else' },
      { paymentMethod: 'cash' },
      { bankReference: 'after the fact' },
      { remittanceReference: 'after the fact' },
      { externalReference: 'after the fact' },
      { notes: 'after the fact' },
    ]) {
      await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, patch)))
    }
  })

  it('12. posted -> draft', async () => {
    await seed('p1', 'posted')
    await assertFails(updateDoc(payRef(ctx(USERS.admin), 'p1'), draftEdit(USERS.admin, {
      status: 'draft', postedAt: null, postedBy: null,
    })))
  })

  it('13. void -> posted, void -> draft, any update to a void payment, and a double void', async () => {
    await seed('p1', 'void')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin)))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { status: 'draft' })))
    await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { notes: 'edit a void' })))
    await assertFails(updateDoc(payRef(db, 'p1'), voidWrite(USERS.admin, 'again')))
  })

  it('14. any unknown / fabricated status', async () => {
    await seed('p1', 'draft')
    await seed('p2', 'posted')
    const db = ctx(USERS.admin)
    for (const status of ['paid', 'partially_paid', 'reconciled', 'cleared', 'issued', 'approved']) {
      await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(USERS.admin, { status })))
      await assertFails(updateDoc(payRef(db, 'p2'), draftEdit(USERS.admin, { status })))
      await assertFails(setDoc(payRef(db, `new_${status}`), draftPayload(USERS.admin, { status })))
    }
  })

  it('15. delete of a draft payment', async () => {
    await seed('p1', 'draft')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertFails(deleteDoc(payRef(ctx(user), 'p1')))
    }
  })

  it('16. delete of a posted (and a void) payment', async () => {
    await seed('p1', 'posted')
    await seed('p2', 'void')
    const db = ctx(USERS.admin)
    await assertFails(deleteDoc(payRef(db, 'p1')))
    await assertFails(deleteDoc(payRef(db, 'p2')))
  })

  it('17. subcontractor and client cannot read or write', async () => {
    await seed('p1', 'draft')
    for (const user of [USERS.sub, USERS.client]) {
      const db = ctx(user)
      await assertFails(getDoc(payRef(db, 'p1')))
      await assertFails(setDoc(payRef(db, 'new1'), draftPayload(user)))
      await assertFails(updateDoc(payRef(db, 'p1'), draftEdit(user, { notes: 'nope' })))
      await assertFails(updateDoc(payRef(db, 'p1'), postWrite(user)))
      await assertFails(deleteDoc(payRef(db, 'p1')))
    }
  })

  it('17b. an unauthenticated client cannot read or write', async () => {
    await seed('p1', 'draft')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(payRef(db, 'p1')))
    await assertFails(setDoc(payRef(db, 'new1'), draftPayload(USERS.admin)))
    await assertFails(updateDoc(payRef(db, 'p1'), postWrite(USERS.admin)))
  })

  it('18. cross-company read or write is denied', async () => {
    await seed('p1', 'draft')
    const dbOther = ctx(USERS.other)
    // Company B's admin reaching into Company A.
    await assertFails(getDoc(payRef(dbOther, 'p1')))
    await assertFails(setDoc(payRef(dbOther, 'new1'), draftPayload(USERS.other)))
    await assertFails(updateDoc(payRef(dbOther, 'p1'), postWrite(USERS.other)))
    await assertFails(deleteDoc(payRef(dbOther, 'p1')))
    // Company A's admin reaching into Company B.
    await assertFails(setDoc(payRef(ctx(USERS.admin), 'new2', COMPANY_B), draftPayload(USERS.admin)))
  })
})

// ── serverTimestamp() must satisfy the request.time checks ───────────────────

describe('serverTimestamp satisfies request.time', () => {
  it('create: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(setDoc(payRef(db, 'ok'), draftPayload(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await assertFails(setDoc(payRef(db, `badc${i}`), draftPayload(USERS.admin, { createdAt: stamp() })))
      await assertFails(setDoc(payRef(db, `badu${i}`), draftPayload(USERS.admin, { updatedAt: stamp() })))
    }
  })

  it('post: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    await seed('p_ok', 'draft')
    const db = ctx(USERS.admin)
    await assertSucceeds(updateDoc(payRef(db, 'p_ok'), postWrite(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await seed(`pp${i}`, 'draft')
      await seed(`pu${i}`, 'draft')
      await assertFails(updateDoc(payRef(db, `pp${i}`), postWrite(USERS.admin, { postedAt: stamp() })))
      await assertFails(updateDoc(payRef(db, `pu${i}`), postWrite(USERS.admin, { updatedAt: stamp() })))
    }
  })

  it('void: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    await seed('p_ok', 'posted')
    const db = ctx(USERS.admin)
    await assertSucceeds(updateDoc(payRef(db, 'p_ok'), voidWrite(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await seed(`pv${i}`, 'posted')
      await seed(`pw${i}`, 'posted')
      await assertFails(updateDoc(payRef(db, `pv${i}`), voidWrite(USERS.admin, 'r', { voidedAt: stamp() })))
      await assertFails(updateDoc(payRef(db, `pw${i}`), voidWrite(USERS.admin, 'r', { updatedAt: stamp() })))
    }
  })

  it('the full app write sequence succeeds end to end: create -> edit -> post -> void', async () => {
    const db = ctx(USERS.qs)
    const ref = payRef(db, 'flow')
    await assertSucceeds(setDoc(ref, draftPayload(USERS.qs)))
    await assertSucceeds(updateDoc(ref, draftEdit(USERS.qs, {
      amount: 2500,
      allocations: [
        { supplierInvoiceId: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471', allocatedAmount: 1500 },
        { supplierInvoiceId: 'si2', invoiceNumber: 'SI-0002', supplierInvoiceNumber: 'INV-4488', allocatedAmount: 999.99 },
      ],
      allocatedTotal: 2499.99,
      unallocatedAmount: 0.01,
    })))
    await assertSucceeds(updateDoc(ref, postWrite(USERS.qs)))

    // withSecurityRulesDisabled resolves to undefined — capture via closure.
    let after
    await testEnv.withSecurityRulesDisabled(async (c) => {
      after = (await getDoc(doc(c.firestore(), paymentsPath(), 'flow'))).data()
    })
    expect(after.status).toBe('posted')
    expect(after.postedBy).toBe(USERS.qs.uid)
    expect(after.postedAt).not.toBeNull()
    expect(after.paymentNumber).toBe('SP-0001')
    expect(after.allocatedTotal).toBe(2499.99)
    expect(after.unallocatedAmount).toBe(0.01)
    expect(after.allocations[0].supplierInvoiceNumber).toBe('INV-4471')

    // Posted content is now immutable; voiding is the only permitted update.
    await assertFails(updateDoc(ref, draftEdit(USERS.qs, { notes: 'too late' })))
    await assertSucceeds(updateDoc(ref, voidWrite(USERS.qs, 'Bank rejected the transfer')))
  })
})
