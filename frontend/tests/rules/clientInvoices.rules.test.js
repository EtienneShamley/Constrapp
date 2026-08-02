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

// ── Client Invoice Security Rules — emulator tests ───────────────────────────
//
// Executes every case documented in docs/TESTING.md §15i-x against the Firestore
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

const invoicesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/clientInvoices`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const invRef = (db, id, companyId = COMPANY_A) => doc(db, invoicesPath(companyId), id)

// A valid draft payload, exactly as hooks/useClientInvoices.jsx writes it.
function draftPayload(user, overrides = {}) {
  return {
    invoiceNumber: 'CI-0001',
    status:        'draft',
    docType:       'invoice',

    clientId:        'contact1',
    clientName:      'Acme Developments',
    clientLegalName: 'Acme Developments Pty Ltd',
    clientAbn:       '51824753556',
    clientEmail:     'ap@acme.test',
    clientPhone:     '0400000000',
    clientAddress:   { street: '1 Test St', suburb: 'Sydney', state: 'NSW', postcode: '2000' },

    clientRef:                'PO-CLIENT-77',
    externalInvoiceReference: '',
    description:  '',
    periodEnding: '',

    invoiceDate:  '2026-08-01',
    dueDate:      '2026-08-31',
    paymentTerms: { days: 30, basis: 'invoice' },

    lineItems: [
      {
        description: 'Contract works to date', amount: 1000, taxCode: 'gst', gstAmount: 100,
        variationId: null, variationNumber: null, variationDescription: null,
        costCodeId: null, costCodeName: null, sortOrder: 0,
      },
    ],
    subtotal:   1000,
    gstTotal:   100,
    grossTotal: 1100,

    currency: 'AUD',
    revision: 1,
    notes:    '',

    issuedAt:   null,
    issuedBy:   null,
    voidedAt:   null,
    voidedBy:   null,
    voidReason: '',

    adjustsInvoiceId: null,
    attachments:      [],
    externalRefs:     {},

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
      status === 'issued' ? { status: 'issued', issuedAt: Timestamp.now(), issuedBy: user.uid } :
      status === 'void'   ? { status: 'void', voidedAt: Timestamp.now(), voidedBy: user.uid, voidReason: 'Superseded' } :
      { status: 'draft' }
    await setDoc(doc(db, invoicesPath(), id), {
      ...base,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...lifecycle,
      ...extra,
    })
  })
}

// The three write shapes the app performs, so tests exercise the real payloads.
const issueWrite = (user, extra = {}) => ({
  status: 'issued',
  issuedAt: serverTimestamp(), issuedBy: user.uid,
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const voidWrite = (user, reason = 'Duplicate of CI-0007', extra = {}) => ({
  status: 'void',
  voidedAt: serverTimestamp(), voidedBy: user.uid, voidReason: reason,
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const draftEdit = (user, extra = {}) => ({
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
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
      await assertSucceeds(setDoc(invRef(ctx(user), `d_${user.uid}`), draftPayload(user)))
    }
  })

  it('1b. financial roles read the register', async () => {
    await seed('inv1', 'draft')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(invRef(ctx(user), 'inv1')))
    }
  })

  it('2. financial role edits a draft (content freely editable)', async () => {
    await seed('inv1', 'draft')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'inv1'), draftEdit(USERS.qs, {
      lineItems: [{
        description: 'Revised works', amount: 2000, taxCode: 'gst', gstAmount: 200,
        variationId: null, variationNumber: null, variationDescription: null,
        costCodeId: null, costCodeName: null, sortOrder: 0,
      }],
      subtotal: 2000, gstTotal: 200, grossTotal: 2200,
      dueDate: '2026-09-30',
      externalInvoiceReference: 'Xero INV-0421',
      clientName: 'Acme Developments (renamed)',
      notes: 'edited',
    })))
  })

  it('3. draft -> issued with correct issuedAt/issuedBy', async () => {
    await seed('inv1', 'draft')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.pm), 'inv1'), issueWrite(USERS.pm)))
  })

  it('4. draft -> void with a non-empty reason', async () => {
    await seed('inv1', 'draft')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.admin), 'inv1'), voidWrite(USERS.admin)))
  })

  it('5. issued -> void with a non-empty reason', async () => {
    await seed('inv1', 'issued')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.admin), 'inv1'), voidWrite(USERS.admin)))
  })
})

// ── MUST REJECT ──────────────────────────────────────────────────────────────

describe('MUST REJECT', () => {
  it('1. create directly as issued (or void)', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(invRef(db, 'x1'), draftPayload(USERS.admin, {
      status: 'issued', issuedAt: serverTimestamp(), issuedBy: USERS.admin.uid,
    })))
    await assertFails(setDoc(invRef(db, 'x2'), draftPayload(USERS.admin, {
      status: 'void', voidedAt: serverTimestamp(), voidedBy: USERS.admin.uid, voidReason: 'nope',
    })))
  })

  it('2. create with forged lifecycle stamps', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(invRef(db, 'x1'), draftPayload(USERS.admin, { issuedAt: Timestamp.now() })))
    await assertFails(setDoc(invRef(db, 'x2'), draftPayload(USERS.admin, { issuedBy: USERS.admin.uid })))
    await assertFails(setDoc(invRef(db, 'x3'), draftPayload(USERS.admin, { voidedAt: Timestamp.now() })))
    await assertFails(setDoc(invRef(db, 'x4'), draftPayload(USERS.admin, { voidedBy: USERS.admin.uid })))
  })

  it('2b. create impersonating another user, or with a bad docType/currency/revision', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(invRef(db, 'x1'), draftPayload(USERS.admin, { createdBy: USERS.pm.uid })))
    await assertFails(setDoc(invRef(db, 'x2'), draftPayload(USERS.admin, { docType: 'credit_note' })))
    await assertFails(setDoc(invRef(db, 'x3'), draftPayload(USERS.admin, { currency: 'AU' })))
    await assertFails(setDoc(invRef(db, 'x4'), draftPayload(USERS.admin, { currency: 'aud' })))
    await assertFails(setDoc(invRef(db, 'x5'), draftPayload(USERS.admin, { revision: '1' })))
  })

  it('3. draft edit changing invoiceNumber', async () => {
    await seed('inv1', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.admin), 'inv1'), draftEdit(USERS.admin, { invoiceNumber: 'CI-9999' })))
  })

  it('4. draft edit changing currency', async () => {
    await seed('inv1', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.admin), 'inv1'), draftEdit(USERS.admin, { currency: 'NZD' })))
  })

  it('5. draft edit changing createdAt / createdBy', async () => {
    await seed('inv1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { createdAt: Timestamp.now() })))
    await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { createdBy: USERS.pm.uid })))
  })

  it('6. draft edit changing docType or revision', async () => {
    await seed('inv1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { docType: 'credit_note' })))
    await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { revision: 2 })))
  })

  it('7. draft edit forging issuedAt / issuedBy / voidedAt / voidedBy', async () => {
    await seed('inv1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { issuedAt: Timestamp.now() })))
    await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { issuedBy: USERS.admin.uid })))
    await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { voidedAt: Timestamp.now() })))
    await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { voidedBy: USERS.admin.uid })))
  })

  it('8. draft -> issued while also changing invoice content', async () => {
    await seed('inv1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(invRef(db, 'inv1'), issueWrite(USERS.admin, { subtotal: 5000 })))
    await assertFails(updateDoc(invRef(db, 'inv1'), issueWrite(USERS.admin, { dueDate: '2027-01-01' })))
    await assertFails(updateDoc(invRef(db, 'inv1'), issueWrite(USERS.admin, { externalInvoiceReference: 'Xero INV-1' })))
    await assertFails(updateDoc(invRef(db, 'inv1'), issueWrite(USERS.admin, { notes: 'sneaky' })))
  })

  it('9. draft -> issued with an incorrect issuedBy (or updatedBy)', async () => {
    await seed('inv1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(invRef(db, 'inv1'), issueWrite(USERS.admin, { issuedBy: USERS.pm.uid })))
    await assertFails(updateDoc(invRef(db, 'inv1'), issueWrite(USERS.admin, { updatedBy: USERS.pm.uid })))
  })

  it('10. draft -> void with an empty or whitespace-only reason, or a wrong voidedBy', async () => {
    await seed('inv1', 'draft')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(invRef(db, 'inv1'), voidWrite(USERS.admin, '')))
    await assertFails(updateDoc(invRef(db, 'inv1'), voidWrite(USERS.admin, 'Duplicate', { voidedBy: USERS.pm.uid })))
  })

  it('11. issued invoice content edit (issued invoices are immutable)', async () => {
    await seed('inv1', 'issued')
    const db = ctx(USERS.admin)
    for (const patch of [
      { subtotal: 5000, gstTotal: 500, grossTotal: 5500 },
      { lineItems: [] },
      { clientName: 'Someone Else' },
      { dueDate: '2027-01-01' },
      { notes: 'after the fact' },
      { externalInvoiceReference: 'Xero INV-9999' },
    ]) {
      await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, patch)))
    }
  })

  it('12. issued -> draft', async () => {
    await seed('inv1', 'issued')
    await assertFails(updateDoc(invRef(ctx(USERS.admin), 'inv1'), draftEdit(USERS.admin, {
      status: 'draft', issuedAt: null, issuedBy: null,
    })))
  })

  it('13. void -> issued, void -> draft, and any update to a void invoice', async () => {
    await seed('inv1', 'void')
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(invRef(db, 'inv1'), issueWrite(USERS.admin)))
    await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { status: 'draft' })))
    await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { notes: 'edit a void' })))
    await assertFails(updateDoc(invRef(db, 'inv1'), voidWrite(USERS.admin, 'again')))
  })

  it('14. any paid / partially_paid / sent status', async () => {
    await seed('inv1', 'draft')
    await seed('inv2', 'issued')
    const db = ctx(USERS.admin)
    for (const status of ['paid', 'partially_paid', 'sent']) {
      await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(USERS.admin, { status })))
      await assertFails(updateDoc(invRef(db, 'inv2'), draftEdit(USERS.admin, { status })))
      await assertFails(setDoc(invRef(db, `new_${status}`), draftPayload(USERS.admin, { status })))
    }
  })

  it('15. delete of a draft invoice', async () => {
    await seed('inv1', 'draft')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertFails(deleteDoc(invRef(ctx(user), 'inv1')))
    }
  })

  it('16. delete of an issued (and a void) invoice', async () => {
    await seed('inv1', 'issued')
    await seed('inv2', 'void')
    const db = ctx(USERS.admin)
    await assertFails(deleteDoc(invRef(db, 'inv1')))
    await assertFails(deleteDoc(invRef(db, 'inv2')))
  })

  it('17. subcontractor and client cannot read or write', async () => {
    await seed('inv1', 'draft')
    for (const user of [USERS.sub, USERS.client]) {
      const db = ctx(user)
      await assertFails(getDoc(invRef(db, 'inv1')))
      await assertFails(setDoc(invRef(db, 'new1'), draftPayload(user)))
      await assertFails(updateDoc(invRef(db, 'inv1'), draftEdit(user, { notes: 'nope' })))
      await assertFails(updateDoc(invRef(db, 'inv1'), issueWrite(user)))
      await assertFails(deleteDoc(invRef(db, 'inv1')))
    }
  })

  it('17b. an unauthenticated client cannot read or write', async () => {
    await seed('inv1', 'draft')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(invRef(db, 'inv1')))
    await assertFails(setDoc(invRef(db, 'new1'), draftPayload(USERS.admin)))
  })

  it('18. cross-company read or write is denied', async () => {
    await seed('inv1', 'draft')
    const dbOther = ctx(USERS.other)
    // Company B's admin reaching into Company A.
    await assertFails(getDoc(invRef(dbOther, 'inv1')))
    await assertFails(setDoc(invRef(dbOther, 'new1'), draftPayload(USERS.other)))
    await assertFails(updateDoc(invRef(dbOther, 'inv1'), issueWrite(USERS.other)))
    await assertFails(deleteDoc(invRef(dbOther, 'inv1')))
    // Company A's admin reaching into Company B.
    await assertFails(setDoc(invRef(ctx(USERS.admin), 'new2', COMPANY_B), draftPayload(USERS.admin)))
  })
})

// ── serverTimestamp() must satisfy the request.time checks ───────────────────

describe('serverTimestamp satisfies request.time', () => {
  it('create: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(setDoc(invRef(db, 'ok'), draftPayload(USERS.admin)))
    await assertFails(setDoc(invRef(db, 'bad1'), draftPayload(USERS.admin, { createdAt: Timestamp.now() })))
    await assertFails(setDoc(invRef(db, 'bad2'), draftPayload(USERS.admin, { updatedAt: Timestamp.now() })))
    // A skewed clock must not pass either.
    await assertFails(setDoc(invRef(db, 'bad3'), draftPayload(USERS.admin, {
      createdAt: Timestamp.fromDate(new Date(Date.now() + 60_000)),
    })))
  })

  it('issue: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    await seed('inv1', 'draft')
    await seed('inv2', 'draft')
    await seed('inv3', 'draft')
    const db = ctx(USERS.admin)
    await assertSucceeds(updateDoc(invRef(db, 'inv1'), issueWrite(USERS.admin)))
    await assertFails(updateDoc(invRef(db, 'inv2'), issueWrite(USERS.admin, { issuedAt: Timestamp.now() })))
    await assertFails(updateDoc(invRef(db, 'inv3'), issueWrite(USERS.admin, { updatedAt: Timestamp.now() })))
  })

  it('void: serverTimestamp() is accepted; a client clock value is rejected', async () => {
    await seed('inv1', 'issued')
    await seed('inv2', 'issued')
    await seed('inv3', 'issued')
    const db = ctx(USERS.admin)
    await assertSucceeds(updateDoc(invRef(db, 'inv1'), voidWrite(USERS.admin)))
    await assertFails(updateDoc(invRef(db, 'inv2'), voidWrite(USERS.admin, 'r', { voidedAt: Timestamp.now() })))
    await assertFails(updateDoc(invRef(db, 'inv3'), voidWrite(USERS.admin, 'r', { updatedAt: Timestamp.now() })))
  })

  it('the full app write sequence succeeds end to end: create -> edit -> issue -> void', async () => {
    const db = ctx(USERS.qs)
    const ref = invRef(db, 'flow')
    await assertSucceeds(setDoc(ref, draftPayload(USERS.qs)))
    await assertSucceeds(updateDoc(ref, draftEdit(USERS.qs, {
      subtotal: 2500, gstTotal: 250, grossTotal: 2750, externalInvoiceReference: 'Xero INV-0500',
    })))
    await assertSucceeds(updateDoc(ref, issueWrite(USERS.qs)))
    // withSecurityRulesDisabled resolves to undefined — capture via closure.
    let after
    await testEnv.withSecurityRulesDisabled(async (c) => {
      after = (await getDoc(doc(c.firestore(), invoicesPath(), 'flow'))).data()
    })
    expect(after.status).toBe('issued')
    expect(after.issuedBy).toBe(USERS.qs.uid)
    expect(after.issuedAt).not.toBeNull()
    expect(after.invoiceNumber).toBe('CI-0001')
    await assertSucceeds(updateDoc(ref, voidWrite(USERS.qs, 'Client cancelled the claim')))
  })
})
