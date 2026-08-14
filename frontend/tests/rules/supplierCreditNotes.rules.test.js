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

// ── Supplier Credit Note Security Rules — emulator tests ─────────────────────
//
// Executes every case documented in docs/TESTING.md §15r-x against the Firestore
// emulator. These verify the RULES, not the UI: each write below is a direct SDK
// call, exactly what a client bypassing the app would issue.
//
// Follows supplierPayments.rules.test.js conventions unchanged, plus ONE new
// class of case: the TARGET checks. This is the first financial block whose
// rules get() another document — the target supplier invoice must exist, be
// posted, carry zero retention, match the credit's supplier and currency, and
// its payableTotal must cover this credit's grossTotal. The CUMULATIVE cap
// across sibling credit notes is deliberately NOT tested as enforced — rules
// cannot sum sibling documents (Deferred Control 25), and one test below proves
// that gap honestly.
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

const creditNotesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/supplierCreditNotes`
const invoicesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/supplierInvoices`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const cnRef = (db, id, companyId = COMPANY_A) => doc(db, creditNotesPath(companyId), id)

// A valid draft payload, exactly as hooks/useSupplierCreditNotes.jsx writes it.
// Targets the seeded posted, retention-free invoice `si1` (payableTotal 1100).
function draftPayload(user, overrides = {}) {
  return {
    creditNumber: 'SCN-0001',
    status:       'draft',
    docType:      'credit_note',

    // Frozen target reference and supplier snapshot (from the invoice).
    supplierInvoiceId:     'si1',
    invoiceNumber:         'SI-0001',
    supplierInvoiceNumber: 'INV-4471',
    supplierId:            'contact1',
    supplierName:          'BuildCo Pty Ltd',

    supplierCreditReference: 'CN-9',
    creditDate: '2026-08-05',
    reason:     'Over-claimed quantities on the July claim',

    lineItems: [
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Credit slab overclaim', amount: 100, taxCode: 'gst', gstAmount: 10 },
    ],
    subtotal:   100,
    gstTotal:   10,
    grossTotal: 110,

    currency: 'AUD',
    revision: 1,
    notes:    '',

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

// Seeds a TARGET supplier invoice directly, bypassing rules. Only the fields the
// credit-note rules get() actually read matter (status, supplierId, currency,
// retentionTotal, payableTotal) — the rest keep the fixture realistic.
async function seedInvoice(id, over = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), invoicesPath(), id), {
      invoiceNumber: 'SI-0001',
      supplierInvoiceNumber: 'INV-4471',
      status: 'posted',
      docType: 'invoice',
      supplierId: 'contact1',
      supplierName: 'BuildCo Pty Ltd',
      currency: 'AUD',
      retention: 0, retentionGst: 0, retentionTotal: 0,
      subtotal: 1000, gstTotal: 100, grossTotal: 1100,
      net: 1000, payableGst: 100, payableTotal: 1100,
      createdAt: Timestamp.now(),
      ...over,
    })
  })
}

// Seeds a credit note directly, bypassing rules — the arrange step for updates.
async function seed(id, status, user = USERS.admin, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const base = draftPayload(user)
    const lifecycle =
      status === 'posted' ? { status: 'posted', postedAt: Timestamp.now(), postedBy: user.uid } :
      status === 'void'   ? { status: 'void', voidedAt: Timestamp.now(), voidedBy: user.uid, voidReason: 'Keyed twice' } :
      { status: 'draft' }
    await setDoc(doc(db, creditNotesPath(), id), {
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
const voidWrite = (user, reason = 'Supplier withdrew the credit', extra = {}) => ({
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
// ⚠️ DELIBERATELY SKEWED, NOT `Timestamp.now()` — see the note in
// supplierPayments.rules.test.js (a bare now() made assertions a coin flip).
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)), // clock ahead
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)), // clock behind
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')), // plainly forged
]

// Builds n credit lines of $1 ex-GST each, with matching header totals.
const manyLines = (n) => ({
  lineItems: Array.from({ length: n }, (_, i) => ({
    costCodeId: 'cc1', costCodeName: '03-100 — Concrete',
    description: `line ${i}`, amount: 1, taxCode: 'gst_free', gstAmount: 0,
  })),
  subtotal: n,
  gstTotal: 0,
  grossTotal: n,
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
  // The default valid target every draftPayload points at.
  await seedInvoice('si1')
})

// ── MUST ALLOW ───────────────────────────────────────────────────────────────

describe('MUST ALLOW', () => {
  it('1. financial roles create a draft (company_admin, project_manager, qs)', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(setDoc(cnRef(ctx(user), `d_${user.uid}`), draftPayload(user)))
    }
  })

  it('1b. financial roles read the register', async () => {
    await seed('cn1', 'draft')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(cnRef(ctx(user), 'cn1')))
    }
  })

  it('2. financial role edits a draft (date, reason, reference, lines, totals, notes)', async () => {
    await seed('cn1', 'draft')
    await assertSucceeds(updateDoc(cnRef(ctx(USERS.qs), 'cn1'), draftEdit(USERS.qs, {
      supplierCreditReference: 'CN-10',
      creditDate: '2026-08-14',
      reason: 'Back-charge for rectification',
      lineItems: [
        { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Rectification', amount: 200, taxCode: 'gst', gstAmount: 20 },
        { costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Rejected forms', amount: 50, taxCode: 'gst_free', gstAmount: 0 },
      ],
      subtotal: 250,
      gstTotal: 20,
      grossTotal: 270,
      notes: 'agreed with supplier 14 Aug',
    })))
  })

  it('3. draft -> posted with correct postedAt/postedBy', async () => {
    await seed('cn1', 'draft')
    await assertSucceeds(updateDoc(cnRef(ctx(USERS.pm), 'cn1'), postWrite(USERS.pm)))
  })

  it('4. draft -> void with a non-empty reason', async () => {
    await seed('cn1', 'draft')
    await assertSucceeds(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), voidWrite(USERS.admin)))
  })

  it('5. posted -> void with a non-empty reason', async () => {
    await seed('cn1', 'posted')
    await assertSucceeds(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), voidWrite(USERS.admin)))
  })

  it('6. a FULL credit — grossTotal exactly equal to the target payableTotal, to the cent', async () => {
    await assertSucceeds(setDoc(cnRef(ctx(USERS.admin), 'full'), draftPayload(USERS.admin, {
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Full credit', amount: 1000, taxCode: 'gst', gstAmount: 100 }],
      subtotal: 1000, gstTotal: 100, grossTotal: 1100,
    })))
  })

  it('7. exactly 100 lines are permitted', async () => {
    await assertSucceeds(setDoc(cnRef(ctx(USERS.admin), 'max'), draftPayload(USERS.admin, manyLines(100))))
  })

  it('8. empty supplierInvoiceNumber and supplierCreditReference are permitted (never invented)', async () => {
    await assertSucceeds(setDoc(cnRef(ctx(USERS.admin), 'norefs'), draftPayload(USERS.admin, {
      supplierInvoiceNumber: '', supplierCreditReference: '',
    })))
  })

  it('8b. a LEGACY target with supplierId null is creditable when the credit freezes null too', async () => {
    await seedInvoice('si_legacy', { supplierId: null, invoiceNumber: 'SI-0002' })
    await assertSucceeds(setDoc(cnRef(ctx(USERS.admin), 'legacy'), draftPayload(USERS.admin, {
      supplierInvoiceId: 'si_legacy', invoiceNumber: 'SI-0002', supplierId: null,
    })))
  })

  it('8c. cumulative over-credit across SIBLINGS is NOT rules-enforced (Deferred Control 25 — honestly proven)', async () => {
    // A posted sibling credit already consumed 1000 of si1's 1100 payable. The
    // app HARD-BLOCKS this second 200 credit; the rules CANNOT — they have no
    // list/query/count over sibling documents. This test documents the gap:
    // if it ever starts failing, the rules got stronger and DC25 must be updated.
    await seed('cn_sib', 'posted', USERS.admin, {
      creditNumber: 'SCN-0009',
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'big', amount: 909.09, taxCode: 'gst', gstAmount: 90.91 }],
      subtotal: 909.09, gstTotal: 90.91, grossTotal: 1000,
    })
    await assertSucceeds(setDoc(cnRef(ctx(USERS.admin), 'cn_over'), draftPayload(USERS.admin, {
      creditNumber: 'SCN-0010',
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'second', amount: 181.82, taxCode: 'gst', gstAmount: 18.18 }],
      subtotal: 181.82, gstTotal: 18.18, grossTotal: 200,
    })))
  })
})

// ── CENT ARITHMETIC ──────────────────────────────────────────────────────────
//
// Money is decimal; rules numbers are IEEE-754 doubles. An exact
// `subtotal + gstTotal == grossTotal` would REJECT legitimate cent values
// (0.10 + 0.20 === 0.30000000000000004). The rules compare WHOLE CENTS via
// math.round(v * 100) — equivalent to a half-cent tolerance, so a discrepancy
// of one cent or more still fails. The payable cap compares cents the same way.

describe('cent arithmetic (header invariant and payable cap must accept real money)', () => {
  it('accepts 0.30 = 0.10 + 0.20 (the classic float failure)', async () => {
    await assertSucceeds(setDoc(cnRef(ctx(USERS.admin), 'c1'), draftPayload(USERS.admin, {
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 0.10, taxCode: 'gst', gstAmount: 0.20 }],
      subtotal: 0.10, gstTotal: 0.20, grossTotal: 0.30,
    })))
  })

  it('accepts 10.01 = 3.33 + 6.68 and 1000.00 = 999.99 + 0.01', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(setDoc(cnRef(db, 'c2'), draftPayload(USERS.admin, {
      subtotal: 3.33, gstTotal: 6.68, grossTotal: 10.01,
    })))
    await assertSucceeds(setDoc(cnRef(db, 'c3'), draftPayload(USERS.admin, {
      subtotal: 999.99, gstTotal: 0.01, grossTotal: 1000.00,
    })))
  })

  it('STILL REJECTS a one-cent discrepancy in either direction', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(cnRef(db, 'bad1'), draftPayload(USERS.admin, {
      subtotal: 100, gstTotal: 10, grossTotal: 110.01,
    })))
    await assertFails(setDoc(cnRef(db, 'bad2'), draftPayload(USERS.admin, {
      subtotal: 100, gstTotal: 10, grossTotal: 109.99,
    })))
  })

  it('the payable cap is cent-exact: 1100.00 passes, 1100.01 fails', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(setDoc(cnRef(db, 'cap_ok'), draftPayload(USERS.admin, {
      subtotal: 1000, gstTotal: 100, grossTotal: 1100,
    })))
    await assertFails(setDoc(cnRef(db, 'cap_over'), draftPayload(USERS.admin, {
      subtotal: 1000.01, gstTotal: 100, grossTotal: 1100.01,
    })))
  })
})

// ── MUST REJECT — target checks (the get() class) ────────────────────────────

describe('MUST REJECT — target invoice checks (rules get() the target)', () => {
  it('T1. a target that does not exist', async () => {
    await assertFails(setDoc(cnRef(ctx(USERS.admin), 'x1'), draftPayload(USERS.admin, {
      supplierInvoiceId: 'ghost',
    })))
  })

  it('T2. a target that is not posted — draft, approved, cancelled, and the deprecated forgeable paid', async () => {
    const db = ctx(USERS.admin)
    for (const status of ['draft', 'approved', 'cancelled', 'paid']) {
      await seedInvoice(`si_${status}`, { status })
      await assertFails(setDoc(cnRef(db, `x_${status}`), draftPayload(USERS.admin, {
        supplierInvoiceId: `si_${status}`,
      })))
    }
  })

  it('T3. a RETAINED target — retentionTotal must be zero (even one cent blocks)', async () => {
    await seedInvoice('si_ret', { retention: 50, retentionGst: 5, retentionTotal: 55, payableTotal: 1045 })
    await seedInvoice('si_ret_cent', { retentionTotal: 0.01 })
    const db = ctx(USERS.admin)
    await assertFails(setDoc(cnRef(db, 'x1'), draftPayload(USERS.admin, { supplierInvoiceId: 'si_ret' })))
    await assertFails(setDoc(cnRef(db, 'x2'), draftPayload(USERS.admin, { supplierInvoiceId: 'si_ret_cent' })))
  })

  it('T4. a supplier mismatch between the credit and its target', async () => {
    await seedInvoice('si_other', { supplierId: 'contact9', supplierName: 'Someone Else' })
    const db = ctx(USERS.admin)
    // Credit freezes contact1 but the target belongs to contact9.
    await assertFails(setDoc(cnRef(db, 'x1'), draftPayload(USERS.admin, { supplierInvoiceId: 'si_other' })))
    // Null on the credit does not match a real id on the target.
    await assertFails(setDoc(cnRef(db, 'x2'), draftPayload(USERS.admin, { supplierId: null })))
  })

  it('T5. a currency mismatch between the credit and its target', async () => {
    await seedInvoice('si_nzd', { currency: 'NZD' })
    const db = ctx(USERS.admin)
    await assertFails(setDoc(cnRef(db, 'x1'), draftPayload(USERS.admin, { supplierInvoiceId: 'si_nzd' })))
    await assertFails(setDoc(cnRef(db, 'x2'), draftPayload(USERS.admin, { currency: 'NZD' })))
  })

  it('T6. a single credit note above the target payableTotal', async () => {
    await seedInvoice('si_small', { subtotal: 100, gstTotal: 10, grossTotal: 110, payableTotal: 110 })
    await assertFails(setDoc(cnRef(ctx(USERS.admin), 'x1'), draftPayload(USERS.admin, {
      supplierInvoiceId: 'si_small',
      // 110 gross credit against a 110 payable is fine; 110.01 is not — but use
      // a clearly-over figure so the failure is unambiguous.
      subtotal: 200, gstTotal: 20, grossTotal: 220,
    })))
  })

  it('T7. a draft edit is re-validated: raising the totals beyond the target payable fails', async () => {
    await seed('cn1', 'draft')
    await assertFails(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), draftEdit(USERS.admin, {
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'too big', amount: 2000, taxCode: 'gst', gstAmount: 200 }],
      subtotal: 2000, gstTotal: 200, grossTotal: 2200,
    })))
  })

  it('T8. a draft edit fails once the target has been cancelled — but VOIDING still succeeds', async () => {
    await seed('cn1', 'draft')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), { status: 'cancelled' })
    })
    const db = ctx(USERS.admin)
    // Content edits re-run targetValid() and fail against a cancelled target…
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { notes: 'still here' })))
    // …but the void branch carries no target check, so the record can be closed out.
    await assertSucceeds(updateDoc(cnRef(db, 'cn1'), voidWrite(USERS.admin, 'Target invoice was cancelled')))
  })

  // ── POST-TIME REVALIDATION ────────────────────────────────────────────────
  //
  // Posting is the FINANCIAL COMMIT POINT. Supplier-invoice integrity is itself
  // deferred (Deferred Controls 1 and 2), so a target validated when the draft
  // was written can be changed by a direct SDK call before the draft is posted.
  // Each case below saves a legitimate draft, mutates the target behind the
  // rules' back, and proves the POST is rejected.

  it('P1. posting fails when the target was CANCELLED after the draft was saved', async () => {
    await seed('cn1', 'draft')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), { status: 'cancelled' })
    })
    await assertFails(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), postWrite(USERS.admin)))
  })

  it('P1b. posting fails for every non-posted target status, including the forgeable `paid`', async () => {
    for (const status of ['draft', 'approved', 'paid']) {
      await seed(`cn_${status}`, 'draft')
      await testEnv.withSecurityRulesDisabled(async (c) => {
        await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), { status })
      })
      await assertFails(updateDoc(cnRef(ctx(USERS.admin), `cn_${status}`), postWrite(USERS.admin)))
      await testEnv.withSecurityRulesDisabled(async (c) => {
        await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), { status: 'posted' })
      })
    }
  })

  it('P2. posting fails when RETENTION was added to the target after the draft was saved', async () => {
    await seed('cn1', 'draft')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), {
        retention: 500, retentionGst: 50, retentionTotal: 550, payableTotal: 550,
      })
    })
    await assertFails(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), postWrite(USERS.admin)))
  })

  it('P2b. even one cent of retention on the target blocks the post', async () => {
    await seed('cn1', 'draft')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), { retentionTotal: 0.01 })
    })
    await assertFails(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), postWrite(USERS.admin)))
  })

  it('P3. posting fails when payableTotal was REDUCED below the credit gross', async () => {
    await seed('cn1', 'draft') // grossTotal 110
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), { payableTotal: 10 })
    })
    await assertFails(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), postWrite(USERS.admin)))
  })

  it('P3b. a payableTotal reduction that still covers the credit gross permits the post', async () => {
    await seed('cn1', 'draft') // grossTotal 110
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), { payableTotal: 110 })
    })
    await assertSucceeds(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), postWrite(USERS.admin)))
  })

  it('P4. posting fails when the target SUPPLIER or CURRENCY changed after the draft was saved', async () => {
    await seed('cn_sup', 'draft')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), { supplierId: 'contact9' })
    })
    await assertFails(updateDoc(cnRef(ctx(USERS.admin), 'cn_sup'), postWrite(USERS.admin)))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), { supplierId: 'contact1', currency: 'NZD' })
    })
    await seed('cn_cur', 'draft')
    await assertFails(updateDoc(cnRef(ctx(USERS.admin), 'cn_cur'), postWrite(USERS.admin)))
  })

  it('P5. posting fails when the target was DELETED after the draft was saved', async () => {
    await seed('cn1', 'draft')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await deleteDoc(doc(c.firestore(), invoicesPath(), 'si1'))
    })
    await assertFails(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), postWrite(USERS.admin)))
  })

  it('P6. voiding a draft whose target went bad STILL succeeds (the record can always be closed out)', async () => {
    await seed('cn1', 'draft')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), invoicesPath(), 'si1'), { status: 'cancelled' })
    })
    await assertSucceeds(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), voidWrite(USERS.admin, 'Target was cancelled')))
  })

  it('P7. an unchanged, still-valid target posts normally (no regression)', async () => {
    await seed('cn1', 'draft')
    await assertSucceeds(updateDoc(cnRef(ctx(USERS.admin), 'cn1'), postWrite(USERS.admin)))
  })
})

// ── MUST REJECT — shape, lifecycle, immutability ─────────────────────────────

describe('MUST REJECT', () => {
  it('1. create directly as posted (or void)', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(cnRef(db, 'x1'), draftPayload(USERS.admin, {
      status: 'posted', postedAt: serverTimestamp(), postedBy: USERS.admin.uid,
    })))
    await assertFails(setDoc(cnRef(db, 'x2'), draftPayload(USERS.admin, {
      status: 'void', voidedAt: serverTimestamp(), voidedBy: USERS.admin.uid, voidReason: 'nope',
    })))
  })

  it('2. create with forged lifecycle stamps', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(cnRef(db, 'x1'), draftPayload(USERS.admin, { postedAt: Timestamp.now() })))
    await assertFails(setDoc(cnRef(db, 'x2'), draftPayload(USERS.admin, { postedBy: USERS.admin.uid })))
    await assertFails(setDoc(cnRef(db, 'x3'), draftPayload(USERS.admin, { voidedAt: Timestamp.now() })))
    await assertFails(setDoc(cnRef(db, 'x4'), draftPayload(USERS.admin, { voidedBy: USERS.admin.uid })))
  })

  it('2b. create impersonating another user, or with a bad docType/currency/revision', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(cnRef(db, 'x1'), draftPayload(USERS.admin, { createdBy: USERS.pm.uid })))
    await assertFails(setDoc(cnRef(db, 'x2'), draftPayload(USERS.admin, { docType: 'invoice' })))
    await assertFails(setDoc(cnRef(db, 'x3'), draftPayload(USERS.admin, { docType: 'refund' })))
    await assertFails(setDoc(cnRef(db, 'x4'), draftPayload(USERS.admin, { currency: 'AU' })))
    await assertFails(setDoc(cnRef(db, 'x5'), draftPayload(USERS.admin, { currency: 'aud' })))
    await assertFails(setDoc(cnRef(db, 'x6'), draftPayload(USERS.admin, { revision: '1' })))
  })

  it('2c. create without a target reference or supplier snapshot', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(cnRef(db, 'x1'), draftPayload(USERS.admin, { supplierInvoiceId: '' })))
    await assertFails(setDoc(cnRef(db, 'x2'), draftPayload(USERS.admin, { supplierInvoiceId: null })))
    await assertFails(setDoc(cnRef(db, 'x3'), draftPayload(USERS.admin, { supplierName: '' })))
    // An empty-string supplierId is neither null nor a real id.
    await assertFails(setDoc(cnRef(db, 'x4'), draftPayload(USERS.admin, { supplierId: '' })))
  })

  it('2d. create with a malformed creditDate', async () => {
    const db = ctx(USERS.admin)
    for (const [i, creditDate] of ['05/08/2026', '2026-8-5', '2026/08/05', '', 'today', '20260805'].entries()) {
      await assertFails(setDoc(cnRef(db, `x${i}`), draftPayload(USERS.admin, { creditDate })))
    }
    await assertFails(setDoc(cnRef(db, 'xts'), draftPayload(USERS.admin, { creditDate: Timestamp.now() })))
  })

  it('2e. create with an empty or whitespace-only reason (a credit needs a stated cause)', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(cnRef(db, 'x1'), draftPayload(USERS.admin, { reason: '' })))
    await assertFails(setDoc(cnRef(db, 'x2'), draftPayload(USERS.admin, { reason: '   ' })))
    await assertFails(setDoc(cnRef(db, 'x3'), draftPayload(USERS.admin, { reason: null })))
  })

  it('2f. create breaking the header invariant (zero, negative, or non-number totals)', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(cnRef(db, 'x1'), draftPayload(USERS.admin, { subtotal: 0, gstTotal: 0, grossTotal: 0 })))
    await assertFails(setDoc(cnRef(db, 'x2'), draftPayload(USERS.admin, { subtotal: -100, gstTotal: -10, grossTotal: -110 })))
    await assertFails(setDoc(cnRef(db, 'x3'), draftPayload(USERS.admin, { subtotal: '100' })))
    await assertFails(setDoc(cnRef(db, 'x4'), draftPayload(USERS.admin, { gstTotal: '10' })))
    await assertFails(setDoc(cnRef(db, 'x5'), draftPayload(USERS.admin, { grossTotal: '110' })))
    await assertFails(setDoc(cnRef(db, 'x6'), draftPayload(USERS.admin, { gstTotal: -10, grossTotal: 90 })))
  })

  it('2g. create with lineItems that are not a list, an EMPTY list, or above the maximum', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(cnRef(db, 'x1'), draftPayload(USERS.admin, { lineItems: { cc1: 100 } })))
    await assertFails(setDoc(cnRef(db, 'x2'), draftPayload(USERS.admin, { lineItems: 'cc1' })))
    await assertFails(setDoc(cnRef(db, 'x3'), draftPayload(USERS.admin, { lineItems: [] })))
    await assertFails(setDoc(cnRef(db, 'x4'), draftPayload(USERS.admin, manyLines(101))))
  })

  it('3. draft edit changing creditNumber / currency / createdAt / createdBy / docType / revision', async () => {
    await seed('cn1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { creditNumber: 'SCN-9999' })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { currency: 'NZD' })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { createdAt: Timestamp.now() })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { createdBy: USERS.pm.uid })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { docType: 'invoice' })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { revision: 2 })))
  })

  it('3b. draft edit RETARGETING the credit — every frozen target field is immutable', async () => {
    await seedInvoice('si2', { invoiceNumber: 'SI-0002' })
    await seed('cn1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { supplierInvoiceId: 'si2' })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { invoiceNumber: 'SI-0002' })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { supplierInvoiceNumber: 'INV-9999' })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { supplierId: 'contact9' })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { supplierName: 'Someone Else' })))
  })

  it('4. draft edit forging postedAt / postedBy / voidedAt / voidedBy', async () => {
    await seed('cn1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { postedAt: Timestamp.now() })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { postedBy: USERS.admin.uid })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { voidedAt: Timestamp.now() })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, { voidedBy: USERS.admin.uid })))
  })

  it('5. draft -> posted while also changing content', async () => {
    await seed('cn1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(cnRef(db, 'cn1'), postWrite(USERS.admin, { grossTotal: 55, subtotal: 50, gstTotal: 5 })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), postWrite(USERS.admin, { reason: 'sneaky' })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), postWrite(USERS.admin, { creditDate: '2027-01-01' })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), postWrite(USERS.admin, { lineItems: [] })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), postWrite(USERS.admin, { notes: 'sneaky' })))
  })

  it('6. draft -> posted with an incorrect postedBy (or updatedBy)', async () => {
    await seed('cn1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(cnRef(db, 'cn1'), postWrite(USERS.admin, { postedBy: USERS.pm.uid })))
    await assertFails(updateDoc(cnRef(db, 'cn1'), postWrite(USERS.admin, { updatedBy: USERS.pm.uid })))
  })

  it('7. void with an empty or whitespace-only reason, or a wrong voidedBy', async () => {
    await seed('cn1', 'draft')
    await seed('cn2', 'draft')
    await seed('cn3', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(cnRef(db, 'cn1'), voidWrite(USERS.admin, '')))
    await assertFails(updateDoc(cnRef(db, 'cn2'), voidWrite(USERS.admin, '   ')))
    await assertFails(updateDoc(cnRef(db, 'cn3'), voidWrite(USERS.admin, 'Duplicate', { voidedBy: USERS.pm.uid })))
  })

  it('8. posted credit-note content edit (posted credit notes are immutable)', async () => {
    await seed('cn1', 'posted')
    const db = ctx(USERS.admin)
    for (const patch of [
      { subtotal: 50, gstTotal: 5, grossTotal: 55 },
      { lineItems: [] },
      { reason: 'after the fact' },
      { creditDate: '2027-01-01' },
      { supplierCreditReference: 'after the fact' },
      { notes: 'after the fact' },
    ]) {
      await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, patch)))
    }
  })

  it('9. posted -> draft; void is terminal; unknown statuses are rejected', async () => {
    await seed('cn1', 'posted')
    await seed('cn2', 'void')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(USERS.admin, {
      status: 'draft', postedAt: null, postedBy: null,
    })))
    await assertFails(updateDoc(cnRef(db, 'cn2'), postWrite(USERS.admin)))
    await assertFails(updateDoc(cnRef(db, 'cn2'), draftEdit(USERS.admin, { notes: 'edit a void' })))
    await assertFails(updateDoc(cnRef(db, 'cn2'), voidWrite(USERS.admin, 'again')))
    for (const status of ['approved', 'issued', 'applied', 'refunded']) {
      await assertFails(setDoc(cnRef(db, `new_${status}`), draftPayload(USERS.admin, { status })))
    }
  })

  it('10. delete is blocked for every status and every role', async () => {
    await seed('cn1', 'draft')
    await seed('cn2', 'posted')
    await seed('cn3', 'void')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertFails(deleteDoc(cnRef(ctx(user), 'cn1')))
    }
    const db = ctx(USERS.admin)
    await assertFails(deleteDoc(cnRef(db, 'cn2')))
    await assertFails(deleteDoc(cnRef(db, 'cn3')))
  })

  it('11. subcontractor and client cannot read or write', async () => {
    await seed('cn1', 'draft')
    for (const user of [USERS.sub, USERS.client]) {
      const db = ctx(user)
      await assertFails(getDoc(cnRef(db, 'cn1')))
      await assertFails(setDoc(cnRef(db, 'new1'), draftPayload(user)))
      await assertFails(updateDoc(cnRef(db, 'cn1'), draftEdit(user, { notes: 'nope' })))
      await assertFails(updateDoc(cnRef(db, 'cn1'), postWrite(user)))
      await assertFails(deleteDoc(cnRef(db, 'cn1')))
    }
  })

  it('11b. an unauthenticated client cannot read or write', async () => {
    await seed('cn1', 'draft')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(cnRef(db, 'cn1')))
    await assertFails(setDoc(cnRef(db, 'new1'), draftPayload(USERS.admin)))
    await assertFails(updateDoc(cnRef(db, 'cn1'), postWrite(USERS.admin)))
  })

  it('12. cross-company read or write is denied', async () => {
    await seed('cn1', 'draft')
    const dbOther = ctx(USERS.other)
    await assertFails(getDoc(cnRef(dbOther, 'cn1')))
    await assertFails(setDoc(cnRef(dbOther, 'new1'), draftPayload(USERS.other)))
    await assertFails(updateDoc(cnRef(dbOther, 'cn1'), postWrite(USERS.other)))
    await assertFails(deleteDoc(cnRef(dbOther, 'cn1')))
    // Company A's admin reaching into Company B (whose project holds no si1 —
    // the membership gate fails before the target check even runs).
    await assertFails(setDoc(cnRef(ctx(USERS.admin), 'new2', COMPANY_B), draftPayload(USERS.admin)))
  })
})

// ── serverTimestamp() must satisfy the request.time checks ───────────────────

describe('serverTimestamp satisfies request.time', () => {
  it('create: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(setDoc(cnRef(db, 'ok'), draftPayload(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await assertFails(setDoc(cnRef(db, `badc${i}`), draftPayload(USERS.admin, { createdAt: stamp() })))
      await assertFails(setDoc(cnRef(db, `badu${i}`), draftPayload(USERS.admin, { updatedAt: stamp() })))
    }
  })

  it('post: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    await seed('cn_ok', 'draft')
    const db = ctx(USERS.admin)
    await assertSucceeds(updateDoc(cnRef(db, 'cn_ok'), postWrite(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await seed(`cp${i}`, 'draft')
      await seed(`cu${i}`, 'draft')
      await assertFails(updateDoc(cnRef(db, `cp${i}`), postWrite(USERS.admin, { postedAt: stamp() })))
      await assertFails(updateDoc(cnRef(db, `cu${i}`), postWrite(USERS.admin, { updatedAt: stamp() })))
    }
  })

  it('void: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    await seed('cn_ok', 'posted')
    const db = ctx(USERS.admin)
    await assertSucceeds(updateDoc(cnRef(db, 'cn_ok'), voidWrite(USERS.admin)))
    for (const [i, stamp] of CLIENT_CLOCKS.entries()) {
      await seed(`cv${i}`, 'posted')
      await seed(`cw${i}`, 'posted')
      await assertFails(updateDoc(cnRef(db, `cv${i}`), voidWrite(USERS.admin, 'r', { voidedAt: stamp() })))
      await assertFails(updateDoc(cnRef(db, `cw${i}`), voidWrite(USERS.admin, 'r', { updatedAt: stamp() })))
    }
  })

  it('the full app write sequence succeeds end to end: create -> edit -> post -> void', async () => {
    const db = ctx(USERS.qs)
    const ref = cnRef(db, 'flow')
    await assertSucceeds(setDoc(ref, draftPayload(USERS.qs)))
    await assertSucceeds(updateDoc(ref, draftEdit(USERS.qs, {
      reason: 'Agreed reduction after remeasure',
      lineItems: [
        { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Remeasure', amount: 499.99, taxCode: 'gst', gstAmount: 50 },
        { costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Remeasure', amount: 0.01, taxCode: 'gst_free', gstAmount: 0 },
      ],
      subtotal: 500,
      gstTotal: 50,
      grossTotal: 550,
    })))
    await assertSucceeds(updateDoc(ref, postWrite(USERS.qs)))

    // withSecurityRulesDisabled resolves to undefined — capture via closure.
    let after
    await testEnv.withSecurityRulesDisabled(async (c) => {
      after = (await getDoc(doc(c.firestore(), creditNotesPath(), 'flow'))).data()
    })
    expect(after.status).toBe('posted')
    expect(after.postedBy).toBe(USERS.qs.uid)
    expect(after.postedAt).not.toBeNull()
    expect(after.creditNumber).toBe('SCN-0001')
    expect(after.supplierInvoiceId).toBe('si1')
    expect(after.grossTotal).toBe(550)

    // Posted content is now immutable; voiding is the only permitted update.
    await assertFails(updateDoc(ref, draftEdit(USERS.qs, { notes: 'too late' })))
    await assertSucceeds(updateDoc(ref, voidWrite(USERS.qs, 'Supplier reissued the credit at a different value')))
  })
})
