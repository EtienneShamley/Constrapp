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
  doc, getDoc, setDoc, updateDoc, deleteDoc, runTransaction, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { poTotals, lineTotal, roundMoney, PO_STATUS } from '../../src/lib/purchaseOrders'
import { invoiceTotals, gstForLine } from '../../src/lib/supplierInvoices'
import { runTransitionPurchaseOrder, PoWriteError, PO_WRITE_ERROR } from '../../src/lib/purchaseOrderActions'
import { PO_CANCEL_BLOCKER_KIND } from '../../src/lib/poCancellation'

// ── Purchase Order Security Rules — emulator tests (ADR-57, M2-B1) ──────────
//
// Executes every case documented in docs/TESTING.md §33 against the Firestore
// emulator. These verify the RULES, not the UI: each write below is a direct
// SDK call, exactly what a client bypassing the app would issue.
//
// Until M2-B1 the `purchaseOrders` block enforced tenant and role and NOTHING
// else, while `supplierInvoices` get()s these documents and trusts `status`
// (sent|closed) at invoice create, and every Committed / Forecast / Cash Flow
// figure trusts `status`, `lineItems` and the header totals at read time. A
// financial-role caller could therefore create a PO already `sent`, rewrite a
// sent PO's lines, move a cancelled PO back to sent, forge any stamp, or write
// a header total unrelated to its GST. The block now follows the ADR-40
// standard: one freeze-and-commit point (`sent`), draft-only content edits,
// four legal transitions carrying stamps only, actor == caller, time ==
// request.time, identity frozen, scalar money in whole cents, currency pinned
// to the project's resolved currency at create, delete blocked.
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (Deferred Control 35):
// rules can neither iterate an array nor read sibling documents, so
// `lineItems` CONTENTS, `subtotal == Σ lineTotal`, and whether any claim or
// invoice still counts against a PO being cancelled are all unverified. The
// final describe block proves each of those, so the suite documents the
// security CEILING as explicitly as the floor. The strict cancellation policy
// lives in the client (lib/poCancellation.js) and is exercised here through
// the REAL guarded transaction (lib/purchaseOrderActions.js).
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set, so
// it can never reach a production Firebase project.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A  = 'companyA'   // baseCurrency NZD
const COMPANY_B  = 'companyB'   // no baseCurrency
const PROJECT_A  = 'projectA'   // currency AUD (explicit)
const PROJECT_NOCUR = 'projectNoCurrency'  // Company A, no currency → NZD via company
const PROJECT_B  = 'projectB'   // Company B, no currency, company has none → AUD

const USERS = {
  admin:   { uid: 'u_admin',   role: 'company_admin',   companyId: COMPANY_A },
  pm:      { uid: 'u_pm',      role: 'project_manager', companyId: COMPANY_A },
  qs:      { uid: 'u_qs',      role: 'qs',              companyId: COMPANY_A },
  sub:     { uid: 'u_sub',     role: 'subcontractor',   companyId: COMPANY_A },
  client:  { uid: 'u_client',  role: 'client',          companyId: COMPANY_A },
  other:   { uid: 'u_other',   role: 'company_admin',   companyId: COMPANY_B },
}
const ORPHAN_UID = 'u_orphan'
const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]

let testEnv

const posPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/purchaseOrders`
const ctx   = (user) => testEnv.authenticatedContext(user.uid).firestore()
const poRef = (db, id, companyId = COMPANY_A, projectId = PROJECT_A) => doc(db, posPath(companyId, projectId), id)
const claimRef   = (db, id) => doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/progressClaims`, id)
const invoiceRef = (db, id) => doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/supplierInvoices`, id)
const variationRef = (db, id) => doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/variations`, id)

// ── Fixtures ────────────────────────────────────────────────────────────────

// A stored line exactly as lib/purchaseOrders.js → buildPoLineItem writes it.
const line = (qty = 10, unitPrice = 250, over = {}) => ({
  costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab pour',
  qty, unit: 'm3', unitPrice, lineTotal: lineTotal(qty, unitPrice), ...over,
})
const DEFAULT_LINES = [line()]

// A valid DRAFT payload built through the REAL poTotals, so every header
// figure the rules check is exactly what the app writes.
function poPayload(user, { lines = DEFAULT_LINES, ...overrides } = {}) {
  const { subtotal, gst, total } = poTotals(lines)
  return {
    poNumber: 'PO-0001', status: 'draft',
    supplierName: 'BuildCo Pty Ltd', supplierId: 'contact1',
    description: 'Level 1 concrete', notes: '',
    lineItems: lines, subtotal, gst, total,
    currency: 'AUD', revision: 1,
    sentAt: null, sentBy: null, closedAt: null, closedBy: null, cancelledAt: null, cancelledBy: null,
    externalRefs: {},
    createdAt: serverTimestamp(), createdBy: user.uid,
    updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}

// Seeds a PO directly, bypassing rules. `status` selects the stamps a real
// document would carry; `legacy: true` strips every ADR-57 key (the pre-M2-B1
// shape the hook wrote), and `extra` is pasted over the top.
async function seed(id, status = 'draft', user = USERS.admin, extra = {}, { legacy = false, projectId = PROJECT_A, companyId = COMPANY_A } = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const base = poPayload(user)
    const now = Timestamp.now()
    const lifecycle =
      status === 'sent'             ? { status, sentAt: now, sentBy: user.uid } :
      status === 'closed'           ? { status, sentAt: now, sentBy: user.uid, closedAt: now, closedBy: user.uid } :
      status === 'cancelled'        ? { status, cancelledAt: now, cancelledBy: user.uid } :
      status === 'pending_approval' ? { status } :
      { status: 'draft' }
    const docData = { ...base, createdAt: now, updatedAt: now, ...lifecycle, ...extra }
    if (legacy) {
      for (const k of ['sentBy', 'closedBy', 'cancelledBy', 'updatedAt', 'updatedBy']) delete docData[k]
    }
    await setDoc(doc(db, posPath(companyId, projectId), id), docData)
  })
}

const stamps = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })

// hooks/usePurchaseOrders.jsx → updatePurchaseOrder.
function draftEdit(user, { lines = [line(8, 250)], description = 'Level 1 concrete — revised', notes = 'Rate confirmed', ...extra } = {}) {
  const { subtotal, gst, total } = poTotals(lines)
  return { description, notes, lineItems: lines, subtotal, gst, total, ...stamps(user), ...extra }
}

// lib/purchaseOrderActions.js → transitionUpdate, as the app writes them.
const sendWrite   = (user, extra = {}) => ({ status: 'sent',      sentAt: serverTimestamp(),      sentBy: user.uid,      ...stamps(user), ...extra })
const closeWrite  = (user, extra = {}) => ({ status: 'closed',    closedAt: serverTimestamp(),    closedBy: user.uid,    ...stamps(user), ...extra })
const cancelWrite = (user, extra = {}) => ({ status: 'cancelled', cancelledAt: serverTimestamp(), cancelledBy: user.uid, ...stamps(user), ...extra })

// Client-supplied clock values that must NEVER satisfy `== request.time`
// (docs/TESTING.md §0 — deliberately skewed, never Timestamp.now()).
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

async function readStatus(id) {
  let status
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const snap = await getDoc(doc(c.firestore(), posPath(), id))
    status = snap.exists() ? snap.data().status : undefined
  })
  return status
}

async function expectKind(promise, kind) {
  let caught
  try { await promise } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(PoWriteError)
  expect(caught.kind).toBe(kind)
  return caught
}

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
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', countryCode: 'NZ', baseCurrency: 'NZD' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A),     { name: 'A', currency: 'AUD', currencyLocked: true })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_NOCUR), { name: 'No currency' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_B),     { name: 'B' })
  })
})

// ── Roles, membership & tenant isolation ─────────────────────────────────────

describe('roles, membership and tenant isolation', () => {
  it('every financial role can create a draft PO', async () => {
    for (const user of FINANCIAL) {
      await assertSucceeds(setDoc(poRef(ctx(user), `create-${user.uid}`), poPayload(user)))
    }
  })

  it('every financial role can read a PO', async () => {
    await seed('read1', 'sent')
    for (const user of FINANCIAL) await assertSucceeds(getDoc(poRef(ctx(user), 'read1')))
  })

  it('every financial role can edit a draft, send, close and cancel', async () => {
    for (const user of FINANCIAL) {
      await seed(`ed-${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(poRef(ctx(user), `ed-${user.uid}`), draftEdit(user)))
      await seed(`se-${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(poRef(ctx(user), `se-${user.uid}`), sendWrite(user)))
      await seed(`cl-${user.uid}`, 'sent')
      await assertSucceeds(updateDoc(poRef(ctx(user), `cl-${user.uid}`), closeWrite(user)))
      await seed(`ca-${user.uid}`, 'sent')
      await assertSucceeds(updateDoc(poRef(ctx(user), `ca-${user.uid}`), cancelWrite(user)))
    }
  })

  it('subcontractor and client can neither read nor write', async () => {
    await seed('deny1', 'draft')
    for (const user of [USERS.sub, USERS.client]) {
      await assertFails(getDoc(poRef(ctx(user), 'deny1')))
      await assertFails(setDoc(poRef(ctx(user), `deny-${user.uid}`), poPayload(user)))
      await assertFails(updateDoc(poRef(ctx(user), 'deny1'), draftEdit(user)))
      await assertFails(updateDoc(poRef(ctx(user), 'deny1'), sendWrite(user)))
    }
  })

  it('an unauthenticated caller can neither read nor write', async () => {
    await seed('deny2', 'draft')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(poRef(db, 'deny2')))
    await assertFails(setDoc(poRef(db, 'deny3'), poPayload(USERS.admin)))
    await assertFails(updateDoc(poRef(db, 'deny2'), sendWrite(USERS.admin)))
  })

  it('an authenticated caller with NO membership document is denied', async () => {
    await seed('deny4', 'draft')
    const db = testEnv.authenticatedContext(ORPHAN_UID).firestore()
    await assertFails(getDoc(poRef(db, 'deny4')))
    await assertFails(setDoc(poRef(db, 'deny5'), poPayload({ uid: ORPHAN_UID })))
    await assertFails(updateDoc(poRef(db, 'deny4'), sendWrite({ uid: ORPHAN_UID })))
  })

  it("a Company B admin cannot touch Company A's POs, and Company A cannot write into Company B", async () => {
    await seed('deny6', 'draft')
    await assertFails(getDoc(poRef(ctx(USERS.other), 'deny6')))
    await assertFails(setDoc(poRef(ctx(USERS.other), 'deny7'), poPayload(USERS.other)))
    await assertFails(updateDoc(poRef(ctx(USERS.other), 'deny6'), sendWrite(USERS.other)))
    await assertFails(setDoc(poRef(ctx(USERS.admin), 'crosstenant', COMPANY_B, PROJECT_B), poPayload(USERS.admin)))
  })

  it('delete is blocked for every role in every status', async () => {
    for (const status of ['draft', 'pending_approval', 'sent', 'closed', 'cancelled']) {
      await seed(`del-${status}`, status)
      for (const user of [...FINANCIAL, USERS.sub, USERS.client, USERS.other]) {
        await assertFails(deleteDoc(poRef(ctx(user), `del-${status}`)))
      }
      await assertFails(deleteDoc(poRef(testEnv.unauthenticatedContext().firestore(), `del-${status}`)))
    }
  })
})

// ── Valid create ─────────────────────────────────────────────────────────────

describe('valid create', () => {
  it('accepts the hook payload for each financial role', async () => {
    for (const user of FINANCIAL) await assertSucceeds(setDoc(poRef(ctx(user), `c-${user.uid}`), poPayload(user)))
  })

  it('accepts a legacy pre-Contacts supplier — supplierId null', async () => {
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'c2'), poPayload(USERS.qs, { supplierId: null })))
  })

  it('accepts a PO whose lines are blank (qty / rate 0 → subtotal 0) — the editor does not require them', async () => {
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'c3'), poPayload(USERS.qs, { lines: [line(0, 0)] })))
  })

  it('accepts a five-digit PO number and exactly 200 lines', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => line(1, i + 1))
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'c4'), poPayload(USERS.qs, { poNumber: 'PO-10001', lines })))
  })

  it('accepts the REAL poTotals for subtotals on half-cent GST boundaries where floating point rounds down (40.15, 41.05, 80.85, 327,680.05)', async () => {
    // 40.15 × 0.1 = 4.0149999… in binary floating point → roundMoney gives
    // 4.01 where exact half-up is 4.02. The rules admit exactly that one cent
    // BELOW, on a boundary only; an exact pin would refuse these app writes.
    // (0.05, 0.15 and 1,234.45 are boundaries where the app DOES round up.)
    const cases = [[1, 40.15], [1, 41.05], [1, 80.85], [1, 327680.05], [1, 0.05], [3, 0.15], [1, 1234.45]]
    let i = 0
    for (const [qty, unitPrice] of cases) {
      const lines = [line(qty, unitPrice)]
      await assertSucceeds(setDoc(poRef(ctx(USERS.qs), `gst-${i++}`), poPayload(USERS.qs, { lines })))
    }
  })
})

// ── Currency and project consistency (create) ────────────────────────────────

describe('currency and project consistency at create', () => {
  it("accepts the project's explicit currency and refuses any other well-formed code", async () => {
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'cur1'), poPayload(USERS.qs, { currency: 'AUD' })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cur2'), poPayload(USERS.qs, { currency: 'NZD' })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cur3'), poPayload(USERS.qs, { currency: 'USD' })))
  })

  it("falls back to the company's baseCurrency when the project stores none (lib/currency.js → resolveProjectCurrency)", async () => {
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'cur4', COMPANY_A, PROJECT_NOCUR), poPayload(USERS.qs, { currency: 'NZD' })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cur5', COMPANY_A, PROJECT_NOCUR), poPayload(USERS.qs, { currency: 'AUD' })))
  })

  it('falls back to AUD when neither the project nor the company stores a currency', async () => {
    await assertSucceeds(setDoc(poRef(ctx(USERS.other), 'cur6', COMPANY_B, PROJECT_B), poPayload(USERS.other, { currency: 'AUD' })))
    await assertFails(setDoc(poRef(ctx(USERS.other), 'cur7', COMPANY_B, PROJECT_B), poPayload(USERS.other, { currency: 'NZD' })))
  })

  it('refuses a malformed currency and a PO under a project that does not exist', async () => {
    for (const currency of ['aud', 'AU', 'AUDX', '', null, 123]) {
      await assertFails(setDoc(poRef(ctx(USERS.qs), `cur-bad-${String(currency)}`), poPayload(USERS.qs, { currency })))
    }
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cur8', COMPANY_A, 'no_such_project'), poPayload(USERS.qs)))
  })
})

// ── Create shape, stamps and money ───────────────────────────────────────────

describe('create shape — identity, stamps and exact keys', () => {
  it('must be born draft — every other status is refused at create', async () => {
    for (const status of ['sent', 'closed', 'cancelled', 'pending_approval', 'approved', 'paid', '']) {
      await assertFails(setDoc(poRef(ctx(USERS.qs), `st-${status}`), poPayload(USERS.qs, { status })))
    }
  })

  it('createdBy and updatedBy must be the caller', async () => {
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cb1'), poPayload(USERS.qs, { createdBy: USERS.admin.uid })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cb2'), poPayload(USERS.qs, { updatedBy: USERS.admin.uid })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cb3'), poPayload(USERS.qs, { createdBy: null })))
  })

  it('createdAt and updatedAt must be server time — three skewed client clocks each', async () => {
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(poRef(ctx(USERS.qs), 'ca'), poPayload(USERS.qs, { createdAt: clock() })))
      await assertFails(setDoc(poRef(ctx(USERS.qs), 'ua'), poPayload(USERS.qs, { updatedAt: clock() })))
    }
  })

  it('every lifecycle stamp must be null at create — a forged send, close or cancel stamp is refused', async () => {
    for (const key of ['sentAt', 'closedAt', 'cancelledAt']) {
      await assertFails(setDoc(poRef(ctx(USERS.qs), `fs-${key}`), poPayload(USERS.qs, { [key]: Timestamp.now() })))
    }
    for (const key of ['sentBy', 'closedBy', 'cancelledBy']) {
      await assertFails(setDoc(poRef(ctx(USERS.qs), `fs-${key}`), poPayload(USERS.qs, { [key]: USERS.qs.uid })))
    }
  })

  it('the key set is exact — a missing key or an extra key is refused', async () => {
    for (const key of ['sentBy', 'updatedAt', 'updatedBy', 'externalRefs', 'currency', 'revision', 'notes']) {
      const p = poPayload(USERS.qs)
      delete p[key]
      await assertFails(setDoc(poRef(ctx(USERS.qs), `mk-${key}`), p))
    }
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'xk1'), poPayload(USERS.qs, { committed: 2500 })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'xk2'), poPayload(USERS.qs, { approvedBy: USERS.qs.uid })))
  })

  it('identity shape — PO number pattern, supplier name, supplier id, revision, externalRefs', async () => {
    for (const poNumber of ['PO-001', 'po-0001', 'PC-0001', '0001', '', null]) {
      await assertFails(setDoc(poRef(ctx(USERS.qs), 'id1'), poPayload(USERS.qs, { poNumber })))
    }
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'id2'), poPayload(USERS.qs, { supplierName: '' })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'id3'), poPayload(USERS.qs, { supplierName: 'x'.repeat(201) })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'id4'), poPayload(USERS.qs, { supplierId: '' })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'id5'), poPayload(USERS.qs, { supplierId: 7 })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'id6'), poPayload(USERS.qs, { revision: '1' })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'id7'), poPayload(USERS.qs, { externalRefs: [] })))
  })

  it('content shape — description / notes bounds, at least one line, at most 200', async () => {
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cs1'), poPayload(USERS.qs, { description: 'x'.repeat(2001) })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cs2'), poPayload(USERS.qs, { notes: 'x'.repeat(5001) })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cs3'), poPayload(USERS.qs, { description: null })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cs4'), { ...poPayload(USERS.qs), lineItems: [], subtotal: 0, gst: 0, total: 0 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cs5'), { ...poPayload(USERS.qs), lineItems: 'none' }))
    const lines = Array.from({ length: 201 }, (_, i) => line(1, i + 1))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'cs6'), poPayload(USERS.qs, { lines })))
  })
})

describe('create money — scalar header invariants in whole cents', () => {
  it('refuses a negative subtotal, gst or total', async () => {
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm1'), { ...poPayload(USERS.qs), subtotal: -2500, gst: -250, total: -2750 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm2'), { ...poPayload(USERS.qs), gst: -250, total: 2250 }))
  })

  it('refuses non-numeric money', async () => {
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm3'), { ...poPayload(USERS.qs), subtotal: '2500' }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm4'), { ...poPayload(USERS.qs), gst: null }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm5'), { ...poPayload(USERS.qs), total: true }))
  })

  it('total must equal subtotal + gst EXACTLY — one cent either way is refused', async () => {
    const p = poPayload(USERS.qs)   // 2500 / 250 / 2750
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm6'), { ...p, total: roundMoney(p.total + 0.01) }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm7'), { ...p, total: roundMoney(p.total - 0.01) }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm8'), { ...p, total: 0 }))
  })

  it('gst must be EXACTLY 10% round-half-up off a half-cent boundary — one cent either way is refused', async () => {
    const p = poPayload(USERS.qs)   // 2500.00 → gst 250.00 (cents 250000 — not a boundary)
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'm9'),  { ...p, gst: 250,    total: 2750 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm10'), { ...p, gst: 250.01, total: 2750.01 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm11'), { ...p, gst: 249.99, total: 2749.99 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm12'), { ...p, gst: 250.02, total: 2750.02 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm13'), { ...p, gst: 0,      total: 2500 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm14'), { ...p, gst: 500,    total: 3000 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'm15'), { ...p, gst: 375,    total: 2875 }))   // a 15% rate is never valid — GST is a flat 10%
  })

  it('on a half-cent boundary (subtotal cents ending in 5) BOTH the half-up value and one cent below are accepted; above, or two below, is refused', async () => {
    // 40.15 × 10% = 4.015 → half-up 4.02; the app’s floating point writes 4.01.
    const lines = [line(1, 40.15)]
    const base = { ...poPayload(USERS.qs, { lines }), subtotal: 40.15 }
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'hb1'), { ...base, gst: 4.02, total: 44.17 }))
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'hb2'), { ...base, gst: 4.01, total: 44.16 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'hb3'), { ...base, gst: 4.03, total: 44.18 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'hb4'), { ...base, gst: 4.00, total: 44.15 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'hb5'), { ...base, gst: 4.01, total: 44.17 }))   // total must still be exact
    // 0.05 is the smallest boundary: half-up 0.01, one below 0.00.
    const tiny = { ...poPayload(USERS.qs, { lines: [line(1, 0.05)] }), subtotal: 0.05 }
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'hb6'), { ...tiny, gst: 0.01, total: 0.06 }))
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'hb7'), { ...tiny, gst: 0,    total: 0.05 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'hb8'), { ...tiny, gst: 0.02, total: 0.07 }))
  })

  it('zero and large values — zero money passes only as exact zeros; a large exact header passes and one cent off fails', async () => {
    const zero = { ...poPayload(USERS.qs, { lines: [line(0, 0)] }) }
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'z1'), { ...zero, subtotal: 0, gst: 0, total: 0 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'z2'), { ...zero, subtotal: 0, gst: 0.01, total: 0.01 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'z3'), { ...zero, subtotal: 0, gst: 0, total: 0.01 }))
    const big = poPayload(USERS.qs, { lines: [line(1, 12345678.9)] })      // 12,345,678.90 → gst 1,234,567.89
    expect(big.gst).toBe(1234567.89)
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'z4'), big))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'z5'), { ...big, gst: 1234567.88, total: roundMoney(big.subtotal + 1234567.88) }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'z6'), { ...big, gst: 1234567.90, total: roundMoney(big.subtotal + 1234567.90) }))
    const bigBoundary = poPayload(USERS.qs, { lines: [line(1, 327680.05)] })  // the app writes 32,768.00 (half-up 32,768.01)
    expect(bigBoundary.gst).toBe(32768)
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'z7'), bigBoundary))
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'z8'), { ...bigBoundary, gst: 32768.01, total: 360448.06 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'z9'), { ...bigBoundary, gst: 32768.02, total: 360448.07 }))
  })

  it('GST is a flat 10% whatever the currency — an NZD project accepts 10% and refuses 15% (currency is a label, not tax)', async () => {
    const nz = { ...poPayload(USERS.qs, { lines: [line(1, 1000)] }), currency: 'NZD' }
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'nz-ok', COMPANY_A, PROJECT_NOCUR), { ...nz, gst: 100, total: 1100 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'nz-15', COMPANY_A, PROJECT_NOCUR), { ...nz, gst: 150, total: 1150 }))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'nz-0', COMPANY_A, PROJECT_NOCUR), { ...nz, gst: 0, total: 1000 }))
  })

  it('a header that is internally consistent but unrelated to its lines is ACCEPTED (lines are unverifiable — DC35)', async () => {
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'm15'), { ...poPayload(USERS.qs), subtotal: 100, gst: 10, total: 110 }))
  })
})

// ── Draft edit ───────────────────────────────────────────────────────────────

describe('draft edit (hooks/usePurchaseOrders.jsx → updatePurchaseOrder)', () => {
  it('accepts the hook payload — content and derived header, with the audit stamps', async () => {
    await seed('e1', 'draft')
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 'e1'), draftEdit(USERS.qs)))
  })

  it('accepts adding, removing and re-pricing lines (count may change on a draft)', async () => {
    await seed('e2', 'draft')
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 'e2'), draftEdit(USERS.qs, { lines: [line(), line(2, 5, { costCodeId: 'cc2' }), line(1, 40.15)] })))
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 'e2'), draftEdit(USERS.qs, { lines: [line(0, 0)] })))
  })

  it('a document written before ADR-57 (no updatedAt / updatedBy / *By keys) is editable and acquires the stamps', async () => {
    await seed('e3', 'draft', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 'e3'), draftEdit(USERS.qs)))
  })

  it('refuses an edit without the audit stamps, with a forged updatedBy, or with a client-clock updatedAt', async () => {
    await seed('e4', 'draft')
    const bare = draftEdit(USERS.qs)
    delete bare.updatedAt; delete bare.updatedBy
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e4'), bare))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e4'), draftEdit(USERS.qs, { updatedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e4'), draftEdit(USERS.qs, { updatedAt: clock() })))
    }
  })

  it('refuses an edit that moves the status or touches a lifecycle stamp', async () => {
    await seed('e5', 'draft')
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, { status: 'sent' })))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, { status: 'sent', sentAt: serverTimestamp(), sentBy: USERS.qs.uid })))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, { sentAt: serverTimestamp() })))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, { cancelledBy: USERS.qs.uid })))
  })

  it('refuses an edit that rewrites identity — number, supplier, currency, revision, externalRefs, provenance', async () => {
    await seed('e6', 'draft')
    const forged = {
      poNumber: 'PO-0099', supplierName: 'Someone Else', supplierId: 'contact9', currency: 'NZD',
      revision: 2, externalRefs: { xero: 'abc' }, createdBy: USERS.pm.uid, createdAt: Timestamp.now(),
    }   // the seed's createdBy is the ADMIN, so every value here differs from what is stored
    for (const [k, v] of Object.entries(forged)) {
      await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e6'), draftEdit(USERS.qs, { [k]: v })))
    }
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e6'), { supplierId: null, ...stamps(USERS.qs) }))
  })

  it('refuses an edit that breaks the shape or the money invariants', async () => {
    await seed('e7', 'draft')
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e7'), { ...draftEdit(USERS.qs), lineItems: [], subtotal: 0, gst: 0, total: 0 }))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e7'), { ...draftEdit(USERS.qs), total: 9999 }))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e7'), { ...draftEdit(USERS.qs), subtotal: -1, gst: 0, total: -1 }))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e7'), { ...draftEdit(USERS.qs), notes: 'x'.repeat(5001) }))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'e7'), { ...draftEdit(USERS.qs), description: 42 }))
  })

  it('refuses a content edit on a pending_approval, sent, closed or cancelled PO — the freeze after send', async () => {
    for (const status of ['pending_approval', 'sent', 'closed', 'cancelled']) {
      await seed(`e8-${status}`, status)
      await assertFails(updateDoc(poRef(ctx(USERS.admin), `e8-${status}`), draftEdit(USERS.admin)))
      await assertFails(updateDoc(poRef(ctx(USERS.admin), `e8-${status}`), { notes: 'just a note', ...stamps(USERS.admin) }))
      await assertFails(updateDoc(poRef(ctx(USERS.admin), `e8-${status}`), { lineItems: [line(1, 1)], subtotal: 1, gst: 0.1, total: 1.1, ...stamps(USERS.admin) }))
      await assertFails(updateDoc(poRef(ctx(USERS.admin), `e8-${status}`), { subtotal: 1, gst: 0.1, total: 1.1, ...stamps(USERS.admin) }))
      await assertFails(updateDoc(poRef(ctx(USERS.admin), `e8-${status}`), { description: 'x', ...stamps(USERS.admin) }))
    }
  })
})

// ── Transitions ──────────────────────────────────────────────────────────────

describe('legal transitions', () => {
  it('draft → sent, with the send stamps', async () => {
    await seed('t1', 'draft')
    await assertSucceeds(updateDoc(poRef(ctx(USERS.pm), 't1'), sendWrite(USERS.pm)))
    expect(await readStatus('t1')).toBe('sent')
  })

  it('pending_approval → sent and → cancelled (a reserved status already stored is not stranded)', async () => {
    await seed('t2', 'pending_approval')
    await assertSucceeds(updateDoc(poRef(ctx(USERS.pm), 't2'), sendWrite(USERS.pm)))
    await seed('t3', 'pending_approval')
    await assertSucceeds(updateDoc(poRef(ctx(USERS.pm), 't3'), cancelWrite(USERS.pm)))
  })

  it('sent → closed', async () => {
    await seed('t4', 'sent')
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 't4'), closeWrite(USERS.qs)))
  })

  it('draft → cancelled and sent → cancelled', async () => {
    await seed('t5', 'draft')
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 't5'), cancelWrite(USERS.qs)))
    await seed('t6', 'sent')
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 't6'), cancelWrite(USERS.qs)))
  })

  it('the creator may send their own PO — self-approval is permitted (separation of duties is not approved)', async () => {
    await seed('t7', 'draft', USERS.qs)
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 't7'), sendWrite(USERS.qs)))
  })

  it('a PO written before ADR-57 can be sent, closed and cancelled — the *By stamps are added, nothing else is required of it', async () => {
    await seed('t8', 'draft', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 't8'), sendWrite(USERS.qs)))
    await seed('t9', 'sent', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 't9'), closeWrite(USERS.qs)))
    await seed('t10', 'sent', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 't10'), cancelWrite(USERS.qs)))
  })

  it('a legacy document with NO externalRefs key and NO supplierId key still takes every write', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const base = poPayload(USERS.admin)
      for (const k of ['sentBy', 'closedBy', 'cancelledBy', 'updatedAt', 'updatedBy', 'externalRefs', 'supplierId']) delete base[k]
      await setDoc(doc(c.firestore(), posPath(), 't11'), { ...base, createdAt: Timestamp.now() })
    })
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 't11'), draftEdit(USERS.qs)))
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 't11'), sendWrite(USERS.qs)))
  })
})

describe('illegal transitions', () => {
  it('draft → closed (skipping send) and draft → pending_approval (reserved — nothing enters it) are refused; a bare re-stamp of a DRAFT is an empty draft edit and moves nothing', async () => {
    await seed('i1', 'draft')
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i1'), closeWrite(USERS.admin)))
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i1'), { status: 'pending_approval', ...stamps(USERS.admin) }))
    // `status: 'draft'` on a draft is not a change, so this is the draft-edit
    // branch with no content key — harmless, and accepted.
    await assertSucceeds(updateDoc(poRef(ctx(USERS.admin), 'i1'), { status: 'draft', ...stamps(USERS.admin) }))
    expect(await readStatus('i1')).toBe('draft')
  })

  it('sent → draft, sent → pending_approval, sent → sent (re-stamp)', async () => {
    await seed('i2', 'sent')
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i2'), { status: 'draft', sentAt: null, sentBy: null, ...stamps(USERS.admin) }))
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i2'), { status: 'pending_approval', ...stamps(USERS.admin) }))
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i2'), sendWrite(USERS.admin)))
    // Unlike a draft, a SENT PO has no edit branch: even a bare re-stamp is refused.
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i2'), { ...stamps(USERS.admin) }))
  })

  it('closed is terminal — no reopen, no cancel, no re-close', async () => {
    await seed('i3', 'closed')
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i3'), sendWrite(USERS.admin)))
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i3'), { status: 'draft', ...stamps(USERS.admin) }))
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i3'), cancelWrite(USERS.admin)))
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i3'), closeWrite(USERS.admin)))
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i3'), { ...stamps(USERS.admin) }))
  })

  it('cancelled is terminal — no revival to draft, sent or closed', async () => {
    await seed('i4', 'cancelled')
    for (const w of [
      { status: 'draft', cancelledAt: null, cancelledBy: null, ...stamps(USERS.admin) },
      sendWrite(USERS.admin), closeWrite(USERS.admin), cancelWrite(USERS.admin),
    ]) {
      await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i4'), w))
    }
    expect(await readStatus('i4')).toBe('cancelled')
  })

  it('an unknown status is unauthorable from every state', async () => {
    for (const from of ['draft', 'sent']) {
      await seed(`i5-${from}`, from)
      for (const status of ['approved', 'paid', 'posted', 'void', 'SENT']) {
        await assertFails(updateDoc(poRef(ctx(USERS.admin), `i5-${from}`), { status, ...stamps(USERS.admin) }))
      }
    }
  })

  it('a draft with no lines cannot be sent — there is nothing to freeze', async () => {
    await seed('i6', 'draft', USERS.admin, { lineItems: [], subtotal: 0, gst: 0, total: 0 })
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'i6'), sendWrite(USERS.admin)))
    await assertSucceeds(updateDoc(poRef(ctx(USERS.admin), 'i6'), cancelWrite(USERS.admin)))
  })
})

describe('transition purity — stamps only, actor == caller, time == server', () => {
  const smuggled = () => ([
    { notes: 'changed on the way out' },
    { description: 'changed' },
    { lineItems: [line(1, 1)], subtotal: 1, gst: 0.1, total: 1.1 },
    { subtotal: 99999, gst: 9999.9, total: 109998.9 },
    { supplierName: 'Someone Else' },
    { currency: 'NZD' },
    { externalRefs: { xero: 'x' } },
    { createdBy: USERS.pm.uid },   // the seed's creator is the admin — a different uid is a change
  ])

  it('send carries no content change — eight kinds of smuggled content refused', async () => {
    await seed('p1', 'draft')
    for (const extra of smuggled()) {
      await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p1'), sendWrite(USERS.qs, extra)))
    }
    expect(await readStatus('p1')).toBe('draft')
  })

  it('close and cancel carry no content change', async () => {
    await seed('p2', 'sent')
    for (const extra of smuggled()) {
      await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p2'), closeWrite(USERS.qs, extra)))
      await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p2'), cancelWrite(USERS.qs, extra)))
    }
  })

  it('a transition may not touch another transition’s stamps', async () => {
    await seed('p3', 'draft')
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p3'), sendWrite(USERS.qs, { closedAt: serverTimestamp() })))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p3'), sendWrite(USERS.qs, { cancelledBy: USERS.qs.uid })))
    await seed('p4', 'sent')
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p4'), closeWrite(USERS.qs, { sentAt: serverTimestamp() })))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p4'), cancelWrite(USERS.qs, { sentBy: USERS.pm.uid })))   // seed's sentBy is the admin
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p4'), cancelWrite(USERS.qs, { closedAt: serverTimestamp(), closedBy: USERS.qs.uid })))
  })

  it('forged actor — sentBy / closedBy / cancelledBy must be the caller', async () => {
    await seed('p5', 'draft')
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p5'), sendWrite(USERS.qs, { sentBy: USERS.admin.uid })))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p5'), sendWrite(USERS.qs, { sentBy: null })))
    await seed('p6', 'sent')
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p6'), closeWrite(USERS.qs, { closedBy: USERS.pm.uid })))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p6'), cancelWrite(USERS.qs, { cancelledBy: USERS.pm.uid })))
    const noBy = sendWrite(USERS.qs); delete noBy.sentBy
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p5'), noBy))
  })

  it('forged time — three skewed client clocks on each transition stamp and on updatedAt', async () => {
    for (const clock of CLIENT_CLOCKS) {
      await seed('p7', 'draft')
      await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p7'), sendWrite(USERS.qs, { sentAt: clock() })))
      await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p7'), sendWrite(USERS.qs, { updatedAt: clock() })))
      await seed('p8', 'sent')
      await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p8'), closeWrite(USERS.qs, { closedAt: clock() })))
      await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p8'), cancelWrite(USERS.qs, { cancelledAt: clock() })))
    }
  })

  it('a transition without the audit stamps, or with a forged updatedBy, is refused', async () => {
    await seed('p9', 'draft')
    const noStamps = { status: 'sent', sentAt: serverTimestamp(), sentBy: USERS.qs.uid }
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p9'), noStamps))
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p9'), sendWrite(USERS.qs, { updatedBy: USERS.admin.uid })))
    const missingAt = sendWrite(USERS.qs); delete missingAt.sentAt
    await assertFails(updateDoc(poRef(ctx(USERS.qs), 'p9'), missingAt))
  })
})

// ── Direct-SDK bypass attempts the old block admitted ────────────────────────

describe('direct SDK bypass attempts', () => {
  it('cannot create a PO already sent or closed, with stamps that look right', async () => {
    const now = Timestamp.now()
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'b1'), poPayload(USERS.qs, { status: 'sent', sentAt: now, sentBy: USERS.qs.uid })))
    await assertFails(setDoc(poRef(ctx(USERS.qs), 'b2'), poPayload(USERS.qs, {
      status: 'sent', sentAt: serverTimestamp(), sentBy: USERS.qs.uid,
    })))
  })

  it('cannot rewrite a sent PO’s lines or totals with a full-document setDoc', async () => {
    await seed('b3', 'sent')
    let stored
    await testEnv.withSecurityRulesDisabled(async (c) => { stored = (await getDoc(doc(c.firestore(), posPath(), 'b3'))).data() })
    await assertFails(setDoc(poRef(ctx(USERS.admin), 'b3'), {
      ...stored, lineItems: [line(1, 999999)], subtotal: 999999, gst: 99999.9, total: 1099998.9,
      updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid,
    }))
    await assertFails(setDoc(poRef(ctx(USERS.admin), 'b3'), { ...stored, supplierName: 'Another Supplier', updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid }))
  })

  it('cannot revive a cancelled PO or reopen a closed one by rewriting the whole document', async () => {
    await seed('b4', 'cancelled')
    let stored
    await testEnv.withSecurityRulesDisabled(async (c) => { stored = (await getDoc(doc(c.firestore(), posPath(), 'b4'))).data() })
    await assertFails(setDoc(poRef(ctx(USERS.admin), 'b4'), {
      ...stored, status: 'sent', cancelledAt: null, cancelledBy: null, sentAt: serverTimestamp(), sentBy: USERS.admin.uid,
      updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid,
    }))
    expect(await readStatus('b4')).toBe('cancelled')
  })

  it('cannot strip the stamps or provenance from a document', async () => {
    await seed('b5', 'sent')
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'b5'), { sentBy: null, ...stamps(USERS.admin) }))
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'b5'), { createdBy: null, ...stamps(USERS.admin) }))
    await assertFails(updateDoc(poRef(ctx(USERS.admin), 'b5'), { createdAt: null, ...stamps(USERS.admin) }))
  })
})

// ── Dependent collections ────────────────────────────────────────────────────

describe('dependent collections are unaffected', () => {
  const invLine = (amount) => ({
    poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab',
    amount: roundMoney(amount), taxCode: 'gst', gstAmount: gstForLine(amount, 'gst'),
  })
  function invoicePayload(user, poId) {
    const lines = [invLine(1000)]
    const t = invoiceTotals(lines, 0)
    return {
      invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-1', status: 'draft', docType: 'invoice', source: 'direct_po',
      supplierId: 'contact1', supplierName: 'BuildCo Pty Ltd', poId, poNumber: 'PO-0001', progressClaimId: null, claimNumber: null,
      invoiceDate: '2026-08-05', receivedDate: '', dueDate: '', paymentTerms: null,
      lineItems: lines, retention: t.retention, retentionGst: t.retentionGst, retentionTotal: t.retentionTotal,
      subtotal: t.subtotal, gstTotal: t.gstTotal, grossTotal: t.grossTotal, net: t.net, payableGst: t.payableGst, payableTotal: t.payableTotal,
      currency: 'AUD', revision: 1, notes: '',
      approvedAt: null, approvedBy: null, postedAt: null, postedBy: null, cancelledAt: null, cancelledBy: null,
      paidAt: null, adjustsInvoiceId: null, attachments: [], externalRefs: {},
      createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    }
  }

  it('a PO created and sent through the new rules is a valid direct_po invoice source; a draft or cancelled one is not', async () => {
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'dep1'), poPayload(USERS.qs)))
    await assertFails(setDoc(invoiceRef(ctx(USERS.qs), 'inv0'), invoicePayload(USERS.qs, 'dep1')))     // still draft
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 'dep1'), sendWrite(USERS.qs)))
    await assertSucceeds(setDoc(invoiceRef(ctx(USERS.qs), 'inv1'), invoicePayload(USERS.qs, 'dep1')))
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 'dep1'), closeWrite(USERS.qs)))
    await assertSucceeds(setDoc(invoiceRef(ctx(USERS.qs), 'inv2'), invoicePayload(USERS.qs, 'dep1')))  // closed still invoiceable
    await seed('dep2', 'cancelled')
    await assertFails(setDoc(invoiceRef(ctx(USERS.qs), 'inv3'), invoicePayload(USERS.qs, 'dep2')))
  })

  it('a progress claim against a PO sent through these rules creates; against a draft or cancelled one it does not (ADR-58 get()s the PO)', async () => {
    // The ADR-58 claim shape (hooks/useProgressClaims.jsx): one claim line per
    // PO line, a balanced claimed header, the creator / audit stamps.
    const claim = (poId) => ({
      claimNumber: 'PC-0001', status: 'draft', poId, poNumber: 'PO-0001', supplierName: 'BuildCo Pty Ltd', supplierId: 'contact1',
      claimRef: '', periodEnding: '', variationId: null,
      lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab pour',
        poLineTotal: 2500, previouslyApproved: 0, claimedToDate: 1000, claimedThisPeriod: 1000, approvedThisPeriod: null }],
      retention: 0, claimedSubtotal: 1000, claimedGst: 100, claimedTotal: 1100,
      approvedSubtotal: null, approvedGst: null, approvedTotal: null, notes: '', assessmentNotes: '', currency: 'AUD', revision: 1,
      submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, invoicedAt: null,
      externalRefs: {}, createdAt: serverTimestamp(), createdBy: USERS.qs.uid, updatedAt: serverTimestamp(), updatedBy: USERS.qs.uid,
    })
    await seed('dep3', 'draft')
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cl0'), claim('dep3')))
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 'dep3'), sendWrite(USERS.qs)))
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'cl1'), claim('dep3')))
    await seed('dep4', 'cancelled')
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cl2'), claim('dep4')))
  })
})

// ── The REAL guarded transaction (lib/purchaseOrderActions.js) ───────────────

describe('runTransitionPurchaseOrder — the app’s own transaction against the real rules', () => {
  const sdk = (user) => ({ db: ctx(user), uid: user.uid, runTransaction, serverTimestamp })
  const seen = (id, status, over = {}) => ({ id, poNumber: 'PO-0001', status, ...over })

  async function seedClaim(id, status, poId = 'tx1') {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(claimRef(c.firestore(), id), { claimNumber: `PC-${id}`, status, poId, claimedSubtotal: 100 })
    })
  }
  async function seedInvoice(id, status, poId = 'tx1') {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(invoiceRef(c.firestore(), id), { invoiceNumber: `SI-${id}`, status, poId, subtotal: 100 })
    })
  }
  async function seedVariation(id, status, poId = 'tx1', variationType = 'supplier') {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(variationRef(c.firestore(), id), { variationNumber: `SV-${id}`, variationType, status, poId, approvedSubtotal: 500 })
    })
  }

  it('send from the reviewed copy writes exactly status + sentAt/sentBy + the audit stamps', async () => {
    await seed('tx1', 'draft')
    const qs = sdk(USERS.qs)
    await runTransitionPurchaseOrder({ ...qs, poRef: poRef(qs.db, 'tx1'), seen: seen('tx1', 'draft'), nextStatus: PO_STATUS.SENT })
    let data
    await testEnv.withSecurityRulesDisabled(async (c) => { data = (await getDoc(doc(c.firestore(), posPath(), 'tx1'))).data() })
    expect(data.status).toBe('sent')
    expect(data.sentBy).toBe(USERS.qs.uid)
    expect(data.sentAt).toBeTruthy()
    expect(data.updatedBy).toBe(USERS.qs.uid)
    expect(data.closedAt).toBeNull()
    expect(data.cancelledAt).toBeNull()
    expect(data.subtotal).toBe(2500)
  })

  it('a STALE copy (sent underneath) is refused with nothing written; the fresh copy then closes', async () => {
    await seed('tx1', 'draft')
    const qs = sdk(USERS.qs)
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), posPath(), 'tx1'), { status: 'sent', sentAt: Timestamp.now(), sentBy: USERS.admin.uid })
    })
    await expectKind(runTransitionPurchaseOrder({ ...qs, poRef: poRef(qs.db, 'tx1'), seen: seen('tx1', 'draft'), nextStatus: PO_STATUS.SENT }), PO_WRITE_ERROR.STALE)
    expect(await readStatus('tx1')).toBe('sent')
    await runTransitionPurchaseOrder({ ...qs, poRef: poRef(qs.db, 'tx1'), seen: seen('tx1', 'sent'), nextStatus: PO_STATUS.CLOSED })
    expect(await readStatus('tx1')).toBe('closed')
  })

  it('an illegal move, a missing document and a reserved target are refused before any read', async () => {
    const qs = sdk(USERS.qs)
    await expectKind(runTransitionPurchaseOrder({ ...qs, poRef: poRef(qs.db, 'nope'), seen: seen('nope', 'closed'), nextStatus: PO_STATUS.SENT }), PO_WRITE_ERROR.INVALID)
    await expectKind(runTransitionPurchaseOrder({ ...qs, poRef: poRef(qs.db, 'nope'), seen: seen('nope', 'draft'), nextStatus: PO_STATUS.PENDING_APPROVAL }), PO_WRITE_ERROR.INVALID)
    await expectKind(runTransitionPurchaseOrder({ ...qs, poRef: poRef(qs.db, 'nope'), seen: seen('nope', 'draft'), nextStatus: PO_STATUS.SENT }), PO_WRITE_ERROR.MISSING)
  })

  it('cancel is BLOCKED by a draft claim, a submitted claim, an approved claim, a draft invoice and a posted invoice — the PO stays sent and no linked record changes', async () => {
    const qs = sdk(USERS.qs)
    const cases = [
      ['claim draft',     () => seedClaim('c1', 'draft'),       { kind: PO_CANCEL_BLOCKER_KIND.CLAIM,   id: 'c1' }],
      ['claim submitted', () => seedClaim('c2', 'submitted'),   { kind: PO_CANCEL_BLOCKER_KIND.CLAIM,   id: 'c2' }],
      ['claim approved',  () => seedClaim('c3', 'approved'),    { kind: PO_CANCEL_BLOCKER_KIND.CLAIM,   id: 'c3' }],
      ['claim invoiced',  () => seedClaim('c4', 'invoiced'),    { kind: PO_CANCEL_BLOCKER_KIND.CLAIM,   id: 'c4' }],
      ['invoice draft',   () => seedInvoice('i1', 'draft'),     { kind: PO_CANCEL_BLOCKER_KIND.INVOICE, id: 'i1' }],
      ['invoice posted',  () => seedInvoice('i2', 'posted'),    { kind: PO_CANCEL_BLOCKER_KIND.INVOICE, id: 'i2' }],
    ]
    for (const [, arrange, linked] of cases) {
      await seed('tx1', 'sent')
      await arrange()
      const ref = linked.kind === PO_CANCEL_BLOCKER_KIND.CLAIM ? claimRef(qs.db, linked.id) : invoiceRef(qs.db, linked.id)
      const err = await expectKind(runTransitionPurchaseOrder({
        ...qs, poRef: poRef(qs.db, 'tx1'), seen: seen('tx1', 'sent'), nextStatus: PO_STATUS.CANCELLED,
        linkedRefs: [{ kind: linked.kind, ref }],
      }), PO_WRITE_ERROR.BLOCKED)
      expect(err.message).toContain('cannot be cancelled')
      expect(await readStatus('tx1')).toBe('sent')
    }
  })

  it('cancel is BLOCKED by a draft, submitted or approved SUPPLIER variation on the PO; a rejected or withdrawn one, a manual-mode (poId null) one and a client variation do not block', async () => {
    const qs = sdk(USERS.qs)
    for (const status of ['draft', 'submitted', 'approved']) {
      await seed('tx1', 'sent')
      await seedVariation(`v-${status}`, status)
      const err = await expectKind(runTransitionPurchaseOrder({
        ...qs, poRef: poRef(qs.db, 'tx1'), seen: seen('tx1', 'sent'), nextStatus: PO_STATUS.CANCELLED,
        linkedRefs: [{ kind: PO_CANCEL_BLOCKER_KIND.VARIATION, ref: variationRef(qs.db, `v-${status}`) }],
      }), PO_WRITE_ERROR.BLOCKED)
      expect(err.message).toContain('supplier variation')
      expect(await readStatus('tx1')).toBe('sent')
    }
    await seed('tx1', 'sent')
    await seedVariation('v-rej', 'rejected')
    await seedVariation('v-wd', 'withdrawn')
    await seedVariation('v-client', 'approved', 'tx1', 'client')   // a client variation never links to a PO in the model; pinned anyway
    await seedVariation('v-manual', 'approved', null)
    await runTransitionPurchaseOrder({
      ...qs, poRef: poRef(qs.db, 'tx1'), seen: seen('tx1', 'sent'), nextStatus: PO_STATUS.CANCELLED,
      linkedRefs: ['v-rej', 'v-wd', 'v-client', 'v-manual'].map(id => ({ kind: PO_CANCEL_BLOCKER_KIND.VARIATION, ref: variationRef(qs.db, id) })),
    })
    expect(await readStatus('tx1')).toBe('cancelled')
  })

  it('cancel SUCCEEDS when every linked claim is rejected and every linked invoice is cancelled, and when nothing is linked', async () => {
    const qs = sdk(USERS.qs)
    await seed('tx1', 'sent')
    await seedClaim('c5', 'rejected')
    await seedInvoice('i3', 'cancelled')
    await runTransitionPurchaseOrder({
      ...qs, poRef: poRef(qs.db, 'tx1'), seen: seen('tx1', 'sent'), nextStatus: PO_STATUS.CANCELLED,
      linkedRefs: [{ kind: PO_CANCEL_BLOCKER_KIND.CLAIM, ref: claimRef(qs.db, 'c5') }, { kind: PO_CANCEL_BLOCKER_KIND.INVOICE, ref: invoiceRef(qs.db, 'i3') }],
    })
    expect(await readStatus('tx1')).toBe('cancelled')
    await seed('tx2', 'draft')
    await runTransitionPurchaseOrder({ ...qs, poRef: poRef(qs.db, 'tx2'), seen: seen('tx2', 'draft'), nextStatus: PO_STATUS.CANCELLED, linkedRefs: [] })
    expect(await readStatus('tx2')).toBe('cancelled')
  })

  it('the SERVER copy decides: a claim the snapshot showed rejected but that is approved on the server blocks; a linked record deleted underneath cannot block', async () => {
    const qs = sdk(USERS.qs)
    await seed('tx1', 'sent')
    await seedClaim('c6', 'approved')   // the caller believed it rejected; the server says approved
    await expectKind(runTransitionPurchaseOrder({
      ...qs, poRef: poRef(qs.db, 'tx1'), seen: seen('tx1', 'sent'), nextStatus: PO_STATUS.CANCELLED,
      linkedRefs: [{ kind: PO_CANCEL_BLOCKER_KIND.CLAIM, ref: claimRef(qs.db, 'c6') }],
    }), PO_WRITE_ERROR.BLOCKED)
    expect(await readStatus('tx1')).toBe('sent')
    await runTransitionPurchaseOrder({
      ...qs, poRef: poRef(qs.db, 'tx1'), seen: seen('tx1', 'sent'), nextStatus: PO_STATUS.CANCELLED,
      linkedRefs: [{ kind: PO_CANCEL_BLOCKER_KIND.CLAIM, ref: claimRef(qs.db, 'gone') }],
    })
    expect(await readStatus('tx1')).toBe('cancelled')
  })

  it('a denied role is refused by the RULES as PERMISSION with nothing written', async () => {
    await seed('tx1', 'draft')
    const sub = sdk(USERS.sub)
    await expectKind(runTransitionPurchaseOrder({ ...sub, poRef: poRef(sub.db, 'tx1'), seen: seen('tx1', 'draft'), nextStatus: PO_STATUS.SENT }), PO_WRITE_ERROR.PERMISSION)
    expect(await readStatus('tx1')).toBe('draft')
  })
})

// ── NOT ENFORCED — the honest ceiling (Deferred Control 35) ──────────────────

describe('NOT ENFORCED by rules — proven, so the ceiling is documented (DC35)', () => {
  it('a direct-SDK cancel of a sent PO with an APPROVED claim, a POSTED invoice and an APPROVED supplier variation against it is ACCEPTED — the strict policy is the client’s', async () => {
    await seed('nz1', 'sent')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(claimRef(c.firestore(), 'nzc'),   { claimNumber: 'PC-0001', status: 'approved', poId: 'nz1' })
      await setDoc(invoiceRef(c.firestore(), 'nzi'), { invoiceNumber: 'SI-0001', status: 'posted', poId: 'nz1' })
      await setDoc(variationRef(c.firestore(), 'nzv'), { variationNumber: 'SV-0001', variationType: 'supplier', status: 'approved', poId: 'nz1' })
    })
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 'nz1'), cancelWrite(USERS.qs)))
  })

  it('lineItems CONTENTS are unverified — junk elements, a negative lineTotal and a bogus cost code are ACCEPTED', async () => {
    const junk = [{ foo: 'bar' }, 'not a line', 42, { costCodeId: 'no-such-code', lineTotal: -5000 }]
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'nz2'), { ...poPayload(USERS.qs), lineItems: junk, subtotal: 10, gst: 1, total: 11 }))
  })

  it('subtotal need not equal Σ lineTotal — a header unrelated to its lines is ACCEPTED', async () => {
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'nz3'), { ...poPayload(USERS.qs), subtotal: 1, gst: 0.1, total: 1.1 }))
  })

  it('creator == sender is ACCEPTED (self-approval permitted by decision); duplicate PO numbers are ACCEPTED (the counter is client-written — DC6)', async () => {
    await seed('nz4', 'draft', USERS.qs)
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 'nz4'), sendWrite(USERS.qs)))
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'nz5'), poPayload(USERS.qs, { poNumber: 'PO-0001' })))
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'nz6'), poPayload(USERS.qs, { poNumber: 'PO-0001' })))
  })

  it('a supplierId naming no contact and a well-formed but unknown currency on a project that stores it are ACCEPTED', async () => {
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'nz7'), poPayload(USERS.qs, { supplierId: 'no-such-contact' })))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects`, 'pXYZ'), { name: 'X', currency: 'XYZ' })
    })
    await assertSucceeds(setDoc(poRef(ctx(USERS.qs), 'nz8', COMPANY_A, 'pXYZ'), poPayload(USERS.qs, { currency: 'XYZ' })))
  })

  it('a blind last-write-wins draft edit (no version guard) is ACCEPTED', async () => {
    await seed('nz9', 'draft')
    await assertSucceeds(updateDoc(poRef(ctx(USERS.qs), 'nz9'), draftEdit(USERS.qs, { notes: 'A' })))
    await assertSucceeds(updateDoc(poRef(ctx(USERS.pm), 'nz9'), draftEdit(USERS.pm, { notes: 'B' })))
  })
})
