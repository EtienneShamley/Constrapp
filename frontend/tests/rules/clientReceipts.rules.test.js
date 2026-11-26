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
  doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction,
  serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { readLedger, ledgerDocument, applyReceipt, applyReceiptVoid } from '../../src/lib/clientLedger'

// ── Client Receipt Security Rules — emulator tests ───────────────────────────
//
// Executes every case documented in docs/TESTING.md §15j-x against the Firestore
// emulator. These verify the RULES, not the UI: each write below is a direct SDK
// call, exactly what a client bypassing the app would issue.
//
// ⚠️ ADR-89. A client may CREATE a draft receipt, EDIT a draft and VOID A DRAFT —
// nothing else. POSTING a receipt and voiding a POSTED receipt are the trusted
// backend's (Admin SDK, which bypasses Rules): it records what each allocation
// adds to its invoice's ledger (`clientInvoiceLedgers/{invoiceId}.receivedCents`).
// The cases that used to assert a client COULD post, or void a posted receipt,
// are kept below INVERTED — the old permission is exactly what must be refused.
// Posted receipts and ledgers are SEEDED with rules disabled, standing in for
// what the backend writes. These tests prove nothing about the backend itself.
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

// ── ADR-89 helpers ───────────────────────────────────────────────────────────
const ANON = { uid: 'u_anon', role: 'unauthenticated', anonymous: true }
const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]
const OUTSIDERS = [USERS.sub, USERS.client, USERS.other, ANON]
const who = (user) => `${user.role}${user.companyId === COMPANY_B ? ' of another company' : ''}`
const dbOf = (user) => (user.anonymous ? testEnv.unauthenticatedContext().firestore() : ctx(user))

const ledgersPath = (companyId = COMPANY_A) => `companies/${companyId}/projects/${PROJECT_A}/clientInvoiceLedgers`
const invoicesPath = (companyId = COMPANY_A) => `companies/${companyId}/projects/${PROJECT_A}/clientInvoices`
const ledRef = (db, id, companyId = COMPANY_A) => doc(db, ledgersPath(companyId), id)
const invRef = (db, id, companyId = COMPANY_A) => doc(db, invoicesPath(companyId), id)

// Assertions that say WHICH request surprised us.
async function denied(what, promise) {
  try { await assertFails(promise) } catch (e) {
    throw new Error(`EXPECTED DENIED, but it was not: ${what} — ${e?.message ?? e}`, { cause: e })
  }
}
async function allowed(what, promise) {
  try { return await assertSucceeds(promise) } catch (e) {
    throw new Error(`EXPECTED ALLOWED, but it was refused: ${what} — ${e?.message ?? e}`, { cause: e })
  }
}

async function admin(fn) {
  let out
  await testEnv.withSecurityRulesDisabled(async (c) => { out = await fn(c.firestore()) })
  return out
}
const stored = (path, id) => admin(async (db) => {
  const snap = await getDoc(doc(db, path, id))
  return snap.exists() ? snap.data() : null
})
const receiptOf = (id) => stored(receiptsPath(), id)
const ledgerOf = (invoiceId) => stored(ledgersPath(), invoiceId)

// The seeded receipts allocate 1,100.00 to inv1: this is that allocation in cents.
const INV1_ALLOCATED_CENTS = 110000

// A ledger document exactly as the BACKEND stores it: lib/clientLedger.js →
// ledgerDocument() writes seq, lines, lastEntry*, ALL SIX credit/release totals
// and receivedCents, whatever kind of entry created it.
async function seedLedger(invoiceId, state) {
  const body = {
    ...ledgerDocument(state),
    createdAt: Timestamp.now(), createdBy: USERS.admin.uid, updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
  }
  await admin((db) => setDoc(ledRef(db, invoiceId), body))
  return body
}
// What the backend's posting of receipt `id` leaves behind: the receipt POSTED
// and inv1's ledger carrying its allocation.
async function seedPostedWithLedger(id = 'r1') {
  await seed(id, 'posted')
  return seedLedger('inv1', applyReceipt(readLedger(await ledgerOf('inv1')), INV1_ALLOCATED_CENTS, id))
}
// The ledger body a CLIENT would send for `next` — the backend's own shape.
function ledgerBody(user, next, { create }) {
  const body = { ...ledgerDocument(next), updatedAt: serverTimestamp(), updatedBy: user.uid }
  return create ? { ...body, createdAt: serverTimestamp(), createdBy: user.uid } : body
}
// An ISSUED client invoice (seeded), for the invoice-void checks.
async function seedInvoice(id) {
  await admin((db) => setDoc(invRef(db, id), {
    invoiceNumber: `CI-${id}`, status: 'issued', docType: 'invoice',
    clientId: 'contact1', clientName: 'Acme Developments', currency: 'AUD', revision: 1,
    invoiceDate: '2026-07-01', dueDate: '2026-08-01',
    lineItems: [{ description: 'Stage 1', amount: 1000, taxCode: 'gst', gstAmount: 100 }],
    subtotal: 1000, gstTotal: 100, grossTotal: 1100,
    issuedAt: Timestamp.now(), issuedBy: USERS.admin.uid, voidedAt: null, voidedBy: null, voidReason: '',
    createdAt: Timestamp.now(), createdBy: USERS.admin.uid, updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
  }))
}
const invoiceVoid = (user) => ({
  status: 'void', voidedAt: serverTimestamp(), voidedBy: user.uid, voidReason: 'Issued in error',
  updatedAt: serverTimestamp(), updatedBy: user.uid,
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

  // 3. (draft -> posted) is no longer a client permission — see the INVERTED
  //    case in "ADR-89 — posting and posted-voids are refused for every client".

  it('4. draft -> void with a non-empty reason', async () => {
    await seed('r1', 'draft')
    await assertSucceeds(updateDoc(rcpRef(ctx(USERS.admin), 'r1'), voidWrite(USERS.admin)))
  })

  it('4b. draft -> void by every financial role', async () => {
    for (const user of FINANCIAL) {
      await seed(`r_${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(rcpRef(ctx(user), `r_${user.uid}`), voidWrite(user)))
    }
  })

  // 5. (posted -> void) is no longer a client permission — see the INVERTED
  //    case in "ADR-89 — posting and posted-voids are refused for every client".

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

describe('supported monetary range — a receipt is bounded at 9,999,999,999,999.90 (ten maximum invoices)', () => {
  const sized = (amount) => draftPayload(USERS.admin, { amount, allocations: [], allocatedTotal: 0, unallocatedAmount: amount })

  it('AT the maximum is accepted; one cent above is refused; a draft cannot be edited past it', async () => {
    await assertSucceeds(setDoc(rcpRef(ctx(USERS.admin), 'max'), sized(9999999999999.9)))
    await assertFails(setDoc(rcpRef(ctx(USERS.admin), 'over'), sized(9999999999999.91)))
    await assertSucceeds(setDoc(rcpRef(ctx(USERS.admin), 'e1'), sized(100)))
    await assertFails(updateDoc(rcpRef(ctx(USERS.admin), 'e1'), draftEdit(USERS.admin, { amount: 10000000000000, allocatedTotal: 0, unallocatedAmount: 10000000000000 })))
  })
})

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
    // ADR-89: the posting is refused with or without the content change (see the
    // inverted cases); the content change on its own is an ordinary draft edit.
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin)))
    await assertSucceeds(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { notes: 'not sneaky' })))
  })

  it('9. draft -> posted with an incorrect postedBy (or updatedBy)', async () => {
    await seed('r1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin, { postedBy: USERS.pm.uid })))
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin, { updatedBy: USERS.pm.uid })))
    // ADR-89: a correct postedBy is refused as well — no client posts.
    await assertFails(updateDoc(rcpRef(db, 'r1'), postWrite(USERS.admin)))
    await assertSucceeds(updateDoc(rcpRef(db, 'r1'), draftEdit(USERS.admin, { notes: 'still a draft' })))
  })

  it('10. void with an empty or whitespace-only reason, or a wrong voidedBy', async () => {
    await seed('r1', 'draft')
    await seed('r2', 'draft')
    await seed('r3', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r1'), voidWrite(USERS.admin, '')))
    await assertFails(updateDoc(rcpRef(db, 'r2'), voidWrite(USERS.admin, '   ')))
    await assertFails(updateDoc(rcpRef(db, 'r3'), voidWrite(USERS.admin, 'Duplicate', { voidedBy: USERS.pm.uid })))
    // Control: the same void with a reason and the caller's own stamp.
    await assertSucceeds(updateDoc(rcpRef(db, 'r3'), voidWrite(USERS.admin, 'Duplicate')))
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

  it('post [INVERTED, ADR-89]: no stamp makes a client posting acceptable — serverTimestamp() and client clocks alike are refused', async () => {
    await seed('r_ok', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r_ok'), postWrite(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await seed(`rp${i}`, 'draft')
      await seed(`ru${i}`, 'draft')
      await assertFails(updateDoc(rcpRef(db, `rp${i}`), postWrite(USERS.admin, { postedAt: stamp() })))
      await assertFails(updateDoc(rcpRef(db, `ru${i}`), postWrite(USERS.admin, { updatedAt: stamp() })))
    }
    // Control: the draft is still an editable draft for that caller.
    await assertSucceeds(updateDoc(rcpRef(db, 'r_ok'), draftEdit(USERS.admin, { notes: 'still editable' })))
    expect((await receiptOf('r_ok')).status).toBe('draft')
  })

  it('void of a DRAFT: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    await seed('r_ok', 'draft')
    const db = ctx(USERS.admin)
    await assertSucceeds(updateDoc(rcpRef(db, 'r_ok'), voidWrite(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await seed(`rv${i}`, 'draft')
      await seed(`rw${i}`, 'draft')
      await assertFails(updateDoc(rcpRef(db, `rv${i}`), voidWrite(USERS.admin, 'r', { voidedAt: stamp() })))
      await assertFails(updateDoc(rcpRef(db, `rw${i}`), voidWrite(USERS.admin, 'r', { updatedAt: stamp() })))
      // Control: the same void, server-stamped.
      await assertSucceeds(updateDoc(rcpRef(db, `rv${i}`), voidWrite(USERS.admin, 'r')))
    }
  })

  it('void of a POSTED receipt [INVERTED, ADR-89]: refused whatever the stamp', async () => {
    await seed('r_ok', 'posted')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(rcpRef(db, 'r_ok'), voidWrite(USERS.admin)))
    for (const stamp of CLIENT_CLOCKS) {
      await assertFails(updateDoc(rcpRef(db, 'r_ok'), voidWrite(USERS.admin, 'r', { voidedAt: stamp() })))
      await assertFails(updateDoc(rcpRef(db, 'r_ok'), voidWrite(USERS.admin, 'r', { updatedAt: stamp() })))
    }
    expect((await receiptOf('r_ok')).status).toBe('posted')
  })

  it('the client write sequence end to end [CHANGED, ADR-89]: create -> edit succeed, post is REFUSED, void of the draft succeeds', async () => {
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
    // Posting is the backend's: the client's own posting write is refused.
    await assertFails(updateDoc(ref, postWrite(USERS.qs)))

    const after = await receiptOf('flow')
    expect(after.status).toBe('draft')
    expect(after.postedBy).toBeNull()
    expect(after.postedAt).toBeNull()
    expect(after.receiptNumber).toBe('CR-0001')
    expect(after.allocatedTotal).toBe(2499.99)
    expect(after.unallocatedAmount).toBe(0.01)

    // The draft stays the client's to edit and to void; once void it is final.
    await assertSucceeds(updateDoc(ref, draftEdit(USERS.qs, { notes: 'not too late' })))
    await assertSucceeds(updateDoc(ref, voidWrite(USERS.qs, 'Bank reversed the transfer')))
    await assertFails(updateDoc(ref, draftEdit(USERS.qs, { notes: 'too late' })))
  })

  it('once the BACKEND has posted a receipt it is immutable to the client: no edit and no void', async () => {
    await seed('flow', 'posted', USERS.qs)
    const ref = rcpRef(ctx(USERS.qs), 'flow')
    await assertFails(updateDoc(ref, draftEdit(USERS.qs, { notes: 'too late' })))
    await assertFails(updateDoc(ref, voidWrite(USERS.qs, 'Bank reversed the transfer')))
    await assertSucceeds(getDoc(ref))
  })
})

// ── ADR-89 — role and tenancy matrix for what a client may still do ──────────

describe('ADR-89 — role and tenancy matrix (read, draft create, draft edit, draft void, delete)', () => {
  it('READ: every financial role gets and lists receipts in every state; nobody else gets or lists anything', async () => {
    await seed('rDraft', 'draft')
    await seed('rPosted', 'posted')
    await seed('rVoid', 'void')
    for (const user of FINANCIAL) {
      const db = ctx(user)
      for (const id of ['rDraft', 'rPosted', 'rVoid']) {
        expect((await allowed(`${who(user)} get ${id}`, getDoc(rcpRef(db, id)))).exists()).toBe(true)
      }
      expect((await allowed(`${who(user)} list`, getDocs(collection(db, receiptsPath())))).size).toBe(3)
    }
    for (const user of OUTSIDERS) {
      const db = dbOf(user)
      for (const id of ['rDraft', 'rPosted', 'rVoid']) await denied(`${who(user)} get ${id}`, getDoc(rcpRef(db, id)))
      await denied(`${who(user)} list`, getDocs(collection(db, receiptsPath())))
    }
  })

  it('DRAFT CREATE: every financial role may; subcontractor, client, another company and unauthenticated may not', async () => {
    for (const user of FINANCIAL) {
      await allowed(`${who(user)} creates`, setDoc(rcpRef(ctx(user), `c_${user.uid}`), draftPayload(user)))
    }
    for (const user of OUTSIDERS) {
      // Stamped with the CALLER's own uid: the only thing wrong with the request is who sends it.
      await denied(`${who(user)} creates`, setDoc(rcpRef(dbOf(user), `c_${user.uid}`), draftPayload(user)))
    }
  })

  it('DRAFT EDIT: every financial role may edit any draft of the company; the others may not', async () => {
    await seed('r1', 'draft')
    for (const user of OUTSIDERS) {
      await denied(`${who(user)} edits`, updateDoc(rcpRef(dbOf(user), 'r1'), draftEdit(user, { notes: `by ${user.uid}` })))
    }
    for (const user of FINANCIAL) {
      await allowed(`${who(user)} edits`, updateDoc(rcpRef(ctx(user), 'r1'), draftEdit(user, { notes: `by ${user.uid}` })))
    }
    expect((await receiptOf('r1')).notes).toBe('by u_qs')
  })

  it('DRAFT VOID: every financial role may void a draft; the others may not', async () => {
    await seed('target', 'draft')
    for (const user of OUTSIDERS) {
      await denied(`${who(user)} voids`, updateDoc(rcpRef(dbOf(user), 'target'), voidWrite(user)))
    }
    expect((await receiptOf('target')).status).toBe('draft')
    for (const user of FINANCIAL) {
      await seed(`v_${user.uid}`, 'draft')
      await allowed(`${who(user)} voids`, updateDoc(rcpRef(ctx(user), `v_${user.uid}`), voidWrite(user)))
    }
  })

  it('DELETE: nobody deletes a draft, posted or void receipt', async () => {
    await seed('rDraft', 'draft')
    await seed('rPosted', 'posted')
    await seed('rVoid', 'void')
    for (const user of [...FINANCIAL, ...OUTSIDERS]) {
      for (const id of ['rDraft', 'rPosted', 'rVoid']) await denied(`${who(user)} deletes ${id}`, deleteDoc(rcpRef(dbOf(user), id)))
    }
    // Control: path and membership are good — the admin may edit the draft it could not delete.
    await allowed('admin edits the draft', updateDoc(rcpRef(ctx(USERS.admin), 'rDraft'), draftEdit(USERS.admin, { notes: 'still here' })))
  })

  it('CROSS-COMPANY: membership is of the company in the PATH, in both directions', async () => {
    await seed('r1', 'draft')
    await admin((db) => setDoc(rcpRef(db, 'theirs', COMPANY_B), { ...draftPayload(USERS.other), createdAt: Timestamp.now(), updatedAt: Timestamp.now() }))
    // Company B's admin in company A.
    await denied('other admin edits A draft', updateDoc(rcpRef(ctx(USERS.other), 'r1'), draftEdit(USERS.other, { notes: 'x' })))
    await denied('other admin voids A draft', updateDoc(rcpRef(ctx(USERS.other), 'r1'), voidWrite(USERS.other)))
    // Company A's financial roles in company B.
    for (const user of FINANCIAL) {
      await denied(`${who(user)} reads B`, getDoc(rcpRef(ctx(user), 'theirs', COMPANY_B)))
      await denied(`${who(user)} lists B`, getDocs(collection(ctx(user), receiptsPath(COMPANY_B))))
      await denied(`${who(user)} creates in B`, setDoc(rcpRef(ctx(user), `n_${user.uid}`, COMPANY_B), draftPayload(user)))
      await denied(`${who(user)} edits B draft`, updateDoc(rcpRef(ctx(user), 'theirs', COMPANY_B), draftEdit(user, { notes: 'x' })))
      await denied(`${who(user)} voids B draft`, updateDoc(rcpRef(ctx(user), 'theirs', COMPANY_B), voidWrite(user)))
    }
    // Control: company B's admin under the same rules in company B.
    await allowed('other admin reads own', getDoc(rcpRef(ctx(USERS.other), 'theirs', COMPANY_B)))
    await allowed('other admin creates own', setDoc(rcpRef(ctx(USERS.other), 'mine', COMPANY_B), draftPayload(USERS.other)))
    await allowed('other admin edits own', updateDoc(rcpRef(ctx(USERS.other), 'theirs', COMPANY_B), draftEdit(USERS.other, { notes: 'ours' })))
    await allowed('other admin voids own', updateDoc(rcpRef(ctx(USERS.other), 'theirs', COMPANY_B), voidWrite(USERS.other)))
  })
})

// ── ADR-89 — posting and posted-voids are the trusted backend's ──────────────
//
// Every case here is a request the app no longer makes: a direct SDK write that
// tries to post a receipt, void a posted one, or move the ledger. Each deny
// group carries a control showing the SAME caller can still edit / void a draft,
// so the denial is about the transition and not about the caller or the path.

describe('ADR-89 — posting and posted-voids are refused for every client (direct bypass attempts)', () => {
  it('INVERTED (was MUST ALLOW 3): draft -> posted with correct postedAt/postedBy is DENIED for admin, pm and qs', async () => {
    for (const user of FINANCIAL) {
      const id = `r_${user.uid}`
      await seed(id, 'draft')
      const ref = rcpRef(ctx(user), id)
      await denied(`${who(user)} posts`, updateDoc(ref, postWrite(user)))
      expect(await receiptOf(id)).toMatchObject({ status: 'draft', postedAt: null, postedBy: null })
      // Controls: the same caller CAN edit that draft and CAN void that draft.
      await allowed(`${who(user)} edits the draft`, updateDoc(ref, draftEdit(user, { notes: 'edited' })))
      await allowed(`${who(user)} voids the draft`, updateDoc(ref, voidWrite(user)))
    }
  })

  it('INVERTED (was MUST ALLOW 5): posted -> void with a non-empty reason is DENIED for admin, pm and qs', async () => {
    await seed('posted', 'posted')
    for (const user of FINANCIAL) {
      await denied(`${who(user)} voids a posted receipt`, updateDoc(rcpRef(ctx(user), 'posted'), voidWrite(user)))
      // Control: the identical void write is accepted on a DRAFT.
      await seed(`d_${user.uid}`, 'draft')
      await allowed(`${who(user)} voids a draft`, updateDoc(rcpRef(ctx(user), `d_${user.uid}`), voidWrite(user)))
    }
    expect(await receiptOf('posted')).toMatchObject({ status: 'posted', voidedAt: null, voidedBy: null, voidReason: '' })
  })

  it('draft -> posted ALONE is denied in every write form (update, status only, overwrite, merge)', async () => {
    await seed('r1', 'draft')
    for (const user of FINANCIAL) {
      const ref = rcpRef(ctx(user), 'r1')
      await denied(`${who(user)} update`, updateDoc(ref, postWrite(user)))
      await denied(`${who(user)} status only`, updateDoc(ref, draftEdit(user, { status: 'posted' })))
      await denied(`${who(user)} overwrite`, setDoc(ref, draftPayload(user, { status: 'posted', postedAt: serverTimestamp(), postedBy: user.uid })))
      await denied(`${who(user)} merge`, setDoc(ref, postWrite(user), { merge: true }))
      await allowed(`${who(user)} edits the draft`, updateDoc(ref, draftEdit(user, { notes: `by ${user.uid}` })))
    }
    expect(await receiptOf('r1')).toMatchObject({ status: 'draft', postedAt: null, postedBy: null })
  })

  it('draft -> posted in a BATCH / TRANSACTION with a correct ledger CREATE (receivedCents exactly as the backend would write) is denied', async () => {
    await seed('r1', 'draft')
    // r1 allocates 1,100.00 to inv1; no ledger exists yet. This IS the backend's document.
    const next = applyReceipt(readLedger(null), INV1_ALLOCATED_CENTS, 'r1')
    expect(ledgerDocument(next)).toMatchObject({ seq: 1, receivedCents: 110000, lastEntryId: 'r1', lastEntryKind: 'receipt', creditedSubtotalCents: 0 })
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const batch = writeBatch(db)
      batch.update(rcpRef(db, 'r1'), postWrite(user))
      batch.set(ledRef(db, 'inv1'), ledgerBody(user, next, { create: true }))
      await denied(`${who(user)} posting + ledger batch`, batch.commit())
      await denied(`${who(user)} posting + ledger transaction`, runTransaction(db, async (tx) => {
        await tx.get(rcpRef(db, 'r1'))
        await tx.get(ledRef(db, 'inv1'))
        tx.set(ledRef(db, 'inv1'), ledgerBody(user, next, { create: true }))
        tx.update(rcpRef(db, 'r1'), postWrite(user))
      }))
      // Control: a batch of legitimate draft writes commits — batches are not what is refused.
      const ok = writeBatch(db)
      ok.update(rcpRef(db, 'r1'), draftEdit(user, { notes: `batched by ${user.uid}` }))
      ok.set(rcpRef(db, `new_${user.uid}`), draftPayload(user))
      await allowed(`${who(user)} batch of draft writes`, ok.commit())
    }
    expect((await receiptOf('r1')).status).toBe('draft')
    expect(await ledgerOf('inv1')).toBeNull()
  })

  it('draft -> posted with a correct ledger UPDATE (the invoice already has received money) is denied', async () => {
    await seedPostedWithLedger('earlier')
    await seed('r2', 'draft')
    const before = await ledgerOf('inv1')
    const next = applyReceipt(readLedger(before), INV1_ALLOCATED_CENTS, 'r2')
    expect(next.receivedCents).toBe(220000)
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const batch = writeBatch(db)
      batch.update(rcpRef(db, 'r2'), postWrite(user))
      batch.update(ledRef(db, 'inv1'), ledgerBody(user, next, { create: false }))
      await denied(`${who(user)} posting + ledger update`, batch.commit())
      await allowed(`${who(user)} edits the draft`, updateDoc(rcpRef(db, 'r2'), draftEdit(user, { notes: 'ok' })))
    }
    expect((await receiptOf('r2')).status).toBe('draft')
    expect(await ledgerOf('inv1')).toEqual(before)
  })

  it('posted -> void is denied alone AND with a correct ledger reversal in the same batch', async () => {
    await seedPostedWithLedger('r1')
    const before = await ledgerOf('inv1')
    const back = applyReceiptVoid(readLedger(before), INV1_ALLOCATED_CENTS, 'r1')
    expect(ledgerDocument(back)).toMatchObject({ seq: 2, receivedCents: 0, lastEntryKind: 'receipt_void' })
    for (const user of FINANCIAL) {
      const db = ctx(user)
      await denied(`${who(user)} void alone`, updateDoc(rcpRef(db, 'r1'), voidWrite(user)))
      const batch = writeBatch(db)
      batch.update(rcpRef(db, 'r1'), voidWrite(user))
      batch.update(ledRef(db, 'inv1'), ledgerBody(user, back, { create: false }))
      await denied(`${who(user)} void + ledger reversal`, batch.commit())
      await denied(`${who(user)} ledger reversal alone`, updateDoc(ledRef(db, 'inv1'), ledgerBody(user, back, { create: false })))
      // Control: the identical void is accepted on a draft.
      await seed(`d_${user.uid}`, 'draft')
      await allowed(`${who(user)} voids a draft`, updateDoc(rcpRef(db, `d_${user.uid}`), voidWrite(user)))
    }
    expect(await receiptOf('r1')).toMatchObject({ status: 'posted', voidedAt: null })
    expect(await ledgerOf('inv1')).toEqual(before)
  })

  it('posted -> draft and ANY content edit of a posted receipt are denied for every financial role', async () => {
    await seed('posted', 'posted')
    await seed('draft', 'draft')
    const edits = [
      { amount: 5000, allocatedTotal: 5000, unallocatedAmount: 0 },
      { amount: 1100, allocations: [], allocatedTotal: 0, unallocatedAmount: 1100 },
      { receiptDate: '2027-01-01' },
      { clientId: 'contact2', clientName: 'Someone Else' },
      { paymentMethod: 'cash' },
      { bankReference: 'after the fact' },
      { notes: 'after the fact' },
      {},
    ]
    for (const user of FINANCIAL) {
      const db = ctx(user)
      await denied(`${who(user)} posted -> draft`, updateDoc(rcpRef(db, 'posted'), draftEdit(user, { status: 'draft', postedAt: null, postedBy: null })))
      await denied(`${who(user)} posted -> draft (status only)`, updateDoc(rcpRef(db, 'posted'), draftEdit(user, { status: 'draft' })))
      await denied(`${who(user)} re-stamps the posting`, updateDoc(rcpRef(db, 'posted'), postWrite(user)))
      for (const patch of edits) {
        await denied(`${who(user)} edits posted ${JSON.stringify(patch)}`, updateDoc(rcpRef(db, 'posted'), draftEdit(user, patch)))
        // Control: the same patch is an ordinary edit of a draft.
        await allowed(`${who(user)} edits draft ${JSON.stringify(patch)}`, updateDoc(rcpRef(db, 'draft'), draftEdit(user, patch)))
      }
    }
    expect(await receiptOf('posted')).toMatchObject({ status: 'posted', amount: 1100, notes: '' })
  })

  it('ANY edit of a void receipt is denied for every financial role', async () => {
    await seed('void', 'void')
    await seed('draft', 'draft')
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const ref = rcpRef(db, 'void')
      await denied(`${who(user)} void -> posted`, updateDoc(ref, postWrite(user)))
      await denied(`${who(user)} void -> draft`, updateDoc(ref, draftEdit(user, { status: 'draft', voidedAt: null, voidedBy: null, voidReason: '' })))
      await denied(`${who(user)} voids again`, updateDoc(ref, voidWrite(user, 'again')))
      await denied(`${who(user)} rewrites the reason`, updateDoc(ref, draftEdit(user, { voidReason: 'rewritten' })))
      await denied(`${who(user)} edits content`, updateDoc(ref, draftEdit(user, { notes: 'edit a void' })))
      await denied(`${who(user)} stamps only`, updateDoc(ref, draftEdit(user)))
      await allowed(`${who(user)} same content edit on a draft`, updateDoc(rcpRef(db, 'draft'), draftEdit(user, { notes: 'edit a draft' })))
    }
    expect((await receiptOf('void')).voidReason).toBe('Keyed twice')
  })

  it('a receipt cannot be CREATED already posted, alone or with its ledger', async () => {
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const id = `p_${user.uid}`
      const body = draftPayload(user, { status: 'posted', postedAt: serverTimestamp(), postedBy: user.uid })
      await denied(`${who(user)} creates posted`, setDoc(rcpRef(db, id), body))
      const batch = writeBatch(db)
      batch.set(rcpRef(db, id), body)
      batch.set(ledRef(db, 'inv1'), ledgerBody(user, applyReceipt(readLedger(null), INV1_ALLOCATED_CENTS, id), { create: true }))
      await denied(`${who(user)} creates posted + ledger`, batch.commit())
      // Control: the same body as a draft.
      await allowed(`${who(user)} creates the draft`, setDoc(rcpRef(db, id), draftPayload(user)))
    }
    expect(await ledgerOf('inv1')).toBeNull()
  })

  it('NO client writes a ledger: a receivedCents create, increment, reset or delete is denied even when the figure is right', async () => {
    await seed('posted', 'posted')
    // The receipt IS posted (seeded) and this is exactly its ledger — nothing about the body is wrong.
    const first = applyReceipt(readLedger(null), INV1_ALLOCATED_CENTS, 'posted')
    for (const user of FINANCIAL) {
      await denied(`${who(user)} creates the correct ledger`, setDoc(ledRef(ctx(user), 'inv1'), ledgerBody(user, first, { create: true })))
      await denied(`${who(user)} creates receivedCents by merge`, setDoc(ledRef(ctx(user), 'inv1'), { receivedCents: 110000 }, { merge: true }))
    }
    expect(await ledgerOf('inv1')).toBeNull()
    const before = await seedLedger('inv1', first)
    for (const user of FINANCIAL) {
      const ref = ledRef(ctx(user), 'inv1')
      await denied(`${who(user)} increments`, updateDoc(ref, { receivedCents: 220000, updatedAt: serverTimestamp(), updatedBy: user.uid }))
      await denied(`${who(user)} resets`, updateDoc(ref, { receivedCents: 0, updatedAt: serverTimestamp(), updatedBy: user.uid }))
      await denied(`${who(user)} overwrites`, setDoc(ref, ledgerBody(user, first, { create: true })))
      await denied(`${who(user)} deletes`, deleteDoc(ref))
      await allowed(`${who(user)} reads`, getDoc(ref))
    }
    expect(await ledgerOf('inv1')).toEqual(before)
  })

  it('HONEST GAP — allocatedInvoiceIds (a SERVER-written field) IS accepted on a draft: the draft shape is not key-restricted; the backend, not the Rules, refuses a draft that is not exactly the app\'s document', async () => {
    // What the Rules ACTUALLY do, recorded so nobody assumes otherwise.
    for (const user of FINANCIAL) {
      await allowed(`${who(user)} creates a draft carrying allocatedInvoiceIds`,
        setDoc(rcpRef(ctx(user), `a_${user.uid}`), draftPayload(user, { allocatedInvoiceIds: ['inv1', 'inv-never-allocated'] })))
    }
    await seed('r1', 'draft')
    await allowed('adds allocatedInvoiceIds by edit', updateDoc(rcpRef(ctx(USERS.admin), 'r1'), draftEdit(USERS.admin, { allocatedInvoiceIds: ['inv9'] })))
    await allowed('any other unknown field too', updateDoc(rcpRef(ctx(USERS.admin), 'r1'), draftEdit(USERS.admin, { anything: { goes: true } })))
    expect((await receiptOf('r1')).allocatedInvoiceIds).toEqual(['inv9'])
    // What the Rules DO guarantee: it stays a draft — no client can post it, and no ledger moves.
    for (const user of FINANCIAL) {
      await denied(`${who(user)} posts the doctored draft`, updateDoc(rcpRef(ctx(user), 'r1'), postWrite(user)))
    }
    expect(await ledgerOf('inv1')).toBeNull()
  })

  it('allocatedInvoiceIds cannot be written onto a POSTED or VOID receipt, nor slipped in while voiding a draft', async () => {
    await seed('posted', 'posted', USERS.admin, { allocatedInvoiceIds: ['inv1'] })
    await seed('void', 'void')
    await seed('draft', 'draft')
    for (const user of FINANCIAL) {
      const db = ctx(user)
      await denied(`${who(user)} rewrites it on a posted receipt`, updateDoc(rcpRef(db, 'posted'), draftEdit(user, { allocatedInvoiceIds: [] })))
      await denied(`${who(user)} adds it to a void receipt`, updateDoc(rcpRef(db, 'void'), draftEdit(user, { allocatedInvoiceIds: ['inv1'] })))
      await denied(`${who(user)} adds it while voiding a draft`, updateDoc(rcpRef(db, 'draft'), voidWrite(user, 'Duplicate', { allocatedInvoiceIds: ['inv1'] })))
    }
    await allowed('control: the void alone', updateDoc(rcpRef(ctx(USERS.admin), 'draft'), voidWrite(USERS.admin)))
    expect((await receiptOf('posted')).allocatedInvoiceIds).toEqual(['inv1'])
  })
})

// ── ADR-89 — seeded backend state: who reads it, and what it blocks ──────────

describe('ADR-89 — seeded backend state (a posted receipt and a ledger carrying receivedCents)', () => {
  it('a posted receipt and its ledger are readable (get and list) by admin, pm and qs — and by nobody else', async () => {
    await seedPostedWithLedger('r1')
    for (const user of FINANCIAL) {
      const db = ctx(user)
      expect((await allowed(`${who(user)} get receipt`, getDoc(rcpRef(db, 'r1')))).data().status).toBe('posted')
      expect((await allowed(`${who(user)} get ledger`, getDoc(ledRef(db, 'inv1')))).data().receivedCents).toBe(110000)
      expect((await allowed(`${who(user)} list receipts`, getDocs(collection(db, receiptsPath())))).size).toBe(1)
      expect((await allowed(`${who(user)} list ledgers`, getDocs(collection(db, ledgersPath())))).size).toBe(1)
    }
    for (const user of OUTSIDERS) {
      const db = dbOf(user)
      await denied(`${who(user)} get receipt`, getDoc(rcpRef(db, 'r1')))
      await denied(`${who(user)} get ledger`, getDoc(ledRef(db, 'inv1')))
      await denied(`${who(user)} list receipts`, getDocs(collection(db, receiptsPath())))
      await denied(`${who(user)} list ledgers`, getDocs(collection(db, ledgersPath())))
    }
  })

  it('an invoice with RECEIPTS can still be voided (pre-existing behaviour): a ledger with receivedCents > 0 and zero credited / released totals does NOT block ledgerClear', async () => {
    for (const user of FINANCIAL) {
      const id = `inv_${user.uid}`
      await seedInvoice(id)
      // As the backend writes it for a receipt-created ledger: all six totals present and zero.
      const body = await seedLedger(id, applyReceipt(readLedger(null), INV1_ALLOCATED_CENTS, 'r1'))
      expect(body).toMatchObject({ receivedCents: 110000, creditedSubtotalCents: 0, releasedRetentionCents: 0 })
      await allowed(`${who(user)} voids an invoice that has receipts`, updateDoc(invRef(ctx(user), id), invoiceVoid(user)))
    }
  })

  it('control for the above: the same ledger with a credited or a released amount DOES block the invoice void', async () => {
    await seedInvoice('invC')
    await seedInvoice('invR')
    const received = applyReceipt(readLedger(null), INV1_ALLOCATED_CENTS, 'r1')
    await seedLedger('invC', { ...received, creditedSubtotalCents: 1000, creditedGstCents: 100 })
    await seedLedger('invR', { ...received, releasedRetentionCents: 500, releasedRetentionGstCents: 50 })
    for (const user of FINANCIAL) {
      await denied(`${who(user)} voids a credited invoice`, updateDoc(invRef(ctx(user), 'invC'), invoiceVoid(user)))
      await denied(`${who(user)} voids a released invoice`, updateDoc(invRef(ctx(user), 'invR'), invoiceVoid(user)))
    }
  })

  it('a ledger holding ONLY receivedCents (no credit / release keys at all) does NOT block the invoice void — ledgerClear reads a missing total as zero', async () => {
    await seedInvoice('invBare')
    await admin((db) => setDoc(ledRef(db, 'invBare'), {
      seq: 1, receivedCents: 110000, lastEntryId: 'r1', lastEntryKind: 'receipt', lines: {},
      createdAt: Timestamp.now(), createdBy: USERS.admin.uid, updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
    }))
    await allowed('voids against a receipt-only ledger without the six totals', updateDoc(invRef(ctx(USERS.admin), 'invBare'), invoiceVoid(USERS.admin)))
    // Control: the same sparse shape WITH a credited amount still blocks.
    await seedInvoice('invBare2')
    await admin((db) => setDoc(ledRef(db, 'invBare2'), {
      seq: 1, receivedCents: 0, creditedSubtotalCents: 100, lastEntryId: 'c1', lastEntryKind: 'credit', lines: {},
      createdAt: Timestamp.now(), createdBy: USERS.admin.uid, updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
    }))
    for (const user of FINANCIAL) {
      await denied(`${who(user)} voids while the sparse ledger shows a credit`, updateDoc(invRef(ctx(user), 'invBare2'), invoiceVoid(user)))
    }
  })

  it('voiding the invoice does not let the client touch the receipt or the ledger behind it', async () => {
    await seedInvoice('inv1')
    await seedPostedWithLedger('r1')
    const before = await ledgerOf('inv1')
    const db = ctx(USERS.admin)
    const batch = writeBatch(db)
    batch.update(invRef(db, 'inv1'), invoiceVoid(USERS.admin))
    batch.update(ledRef(db, 'inv1'), { receivedCents: 0, updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid })
    await denied('invoice void + ledger reset', batch.commit())
    const both = writeBatch(db)
    both.update(invRef(db, 'inv1'), invoiceVoid(USERS.admin))
    both.update(rcpRef(db, 'r1'), voidWrite(USERS.admin))
    await denied('invoice void + posted receipt void', both.commit())
    await allowed('the invoice void alone', updateDoc(invRef(db, 'inv1'), invoiceVoid(USERS.admin)))
    expect(await ledgerOf('inv1')).toEqual(before)
    expect((await receiptOf('r1')).status).toBe('posted')
  })
})
