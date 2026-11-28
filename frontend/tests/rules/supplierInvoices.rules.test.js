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
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import {
  invoiceTotals, gstForLine, allocateClaimSourcedLineGst, claimReconciliationError,
} from '../../src/lib/supplierInvoices'
import { claimTotals } from '../../src/lib/progressClaims'
import { releaseTotals } from '../../src/lib/retention'
import { roundMoney } from '../../src/lib/purchaseOrders'

// ── Supplier Invoice Security Rules — emulator tests (ADR-40) ────────────────
//
// Executes every case documented in docs/TESTING.md §13f against the Firestore
// emulator. These verify the RULES, not the UI: each write below is a direct SDK
// call, exactly what a client bypassing the app would issue.
//
// This block was the highest-risk financial collection in the database: it
// enforced role and tenancy and NOTHING else, while three other blocks get()
// these documents and trust what they find (supplierCreditNotes,
// retentionReleases, supplierPayments). It now follows the ADR-22 standard, with
// one structural difference from every earlier hardened collection: a supplier
// invoice has TWO lifecycle points, not one —
//   · `approved` is the AUTHORING FREEZE POINT (content stops changing);
//   · `posted`  is the FINANCIAL COMMIT POINT (the invoice starts counting).
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (Deferred Control 28):
// rules can neither iterate nor index an array, so `lineItems` contents are
// wholly unverified — a per-line negative amount, a bogus cost code, an invalid
// tax code, and headers that contradict their own lines are all writable. Nor
// can rules sum sibling documents, so duplicate supplier references and
// cumulative over-invoicing against a PO remain possible. The final describe
// block proves each of those, so the suite documents the security CEILING as
// explicitly as the floor. Two invoices against one approved claim are NO
// LONGER possible for a new-format claim (SHIELD 2A, ADR-68 — the claim's own
// link is the sibling; tests/rules/claimInvoicePairing.rules.test.js).
//
// ⚠️ ADR-93 (Phase 2 step 3, trusted supplier finance). A supplier invoice is
// CREATED, its draft EDITED, APPROVED, POSTED and CANCELLED — and paired with
// its claim — ONLY by the trusted backend (functions/src/supplierFinance/),
// which verifies everything stored under the invoice's own calculation version
// before it becomes authoritative. The block is now
// `allow create, update, delete: if false` and the `supplierInvoices` counter is
// backend-only. Every test below whose subject was a client write that used to
// SUCCEED now proves that exact write is REFUSED for every financial role
// (company_admin, project_manager, qs) with nothing stored / the stored
// document (and, for a paired create, the claim) unchanged (`createRefused` /
// `pairedRefused` / `updateRefused`). Every denial the suite already asserted
// is kept unchanged — it still holds, now trivially. Where a scenario needs the
// document the old client write produced, it is then written with rules
// disabled (`storeAs` / `serverUpdate`), standing for what the backend stores.
// The "DEFERRED CONTROLS" block below therefore no longer proves gaps are
// OPEN to a client: each former ACCEPTED shape is now REFUSED, and whether the
// backend closes it is proven in tests/functions (supplier finance). Reads are
// unchanged: financial roles only, tenant-isolated.
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set, so it
// can never reach a production Firebase project. The npm script starts the
// emulator via `firebase emulators:exec`, which sets that variable.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'demo-constrap-test'
const COMPANY_A  = 'companyA'
const COMPANY_B  = 'companyB'
const PROJECT_A  = 'projectA'
const PROJECT_B  = 'projectB'   // second project in Company A — wrong-project refs

const USERS = {
  admin:   { uid: 'u_admin',   role: 'company_admin',   companyId: COMPANY_A },
  pm:      { uid: 'u_pm',      role: 'project_manager', companyId: COMPANY_A },
  qs:      { uid: 'u_qs',      role: 'qs',              companyId: COMPANY_A },
  sub:     { uid: 'u_sub',     role: 'subcontractor',   companyId: COMPANY_A },
  client:  { uid: 'u_client',  role: 'client',          companyId: COMPANY_A },
  other:   { uid: 'u_other',   role: 'company_admin',   companyId: COMPANY_B },
}
// Authenticated, but with NO users/{uid} membership document.
const ORPHAN_UID = 'u_orphan'

// Seeded source documents (the Tier-2 get() targets).
const PO_SENT       = 'po_sent'
const PO_CLOSED     = 'po_closed'
const PO_DRAFT      = 'po_draft'
const PO_CANCELLED  = 'po_cancelled'
const PO_OTHER_PROJ = 'po_other_project'   // lives in PROJECT_B
const CLAIM_APPROVED  = 'claim_approved'
const CLAIM_SUBMITTED = 'claim_submitted'
const CLAIM_DRAFT     = 'claim_draft'

let testEnv

const invoicesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/supplierInvoices`

const ctx    = (user) => testEnv.authenticatedContext(user.uid).firestore()
const invRef = (db, id, companyId = COMPANY_A, projectId = PROJECT_A) =>
  doc(db, invoicesPath(companyId, projectId), id)

// ── Fixtures ────────────────────────────────────────────────────────────────

// One ex-GST line of 10,000.00 attracting GST. Identity fields are UNVERIFIED by
// rules (they live inside the array) — realistic here only so fixtures read
// truthfully.
const line = (amount, taxCode = 'gst', over = {}) => ({
  poLineIndex:  0,
  costCodeId:   'cc1',
  costCodeName: '03-100 — Concrete',
  description:  'Ground floor slab',
  amount:       roundMoney(amount),
  taxCode,
  gstAmount:    gstForLine(amount, taxCode),
  ...over,
})

const DEFAULT_LINES = [line(10000)]

// A valid DRAFT payload, built through the REAL lib/supplierInvoices →
// invoiceTotals, so every header total the rules check is exactly what the app
// would write. If the rules' whole-cent identities and the client's roundMoney
// arithmetic ever diverge, these creates start failing — which is the point.
function invoicePayload(user, {
  source = 'direct_po',
  lines = DEFAULT_LINES,
  retention = 0,
  ...overrides
} = {}) {
  const totals = invoiceTotals(lines, retention)
  return {
    invoiceNumber:         'SI-0001',
    supplierInvoiceNumber: 'INV-4471',
    status:                'draft',
    docType:               'invoice',
    source,

    supplierId:   'contact1',
    supplierName: 'BuildCo Pty Ltd',

    poId:            PO_SENT,
    poNumber:        'PO-0001',
    progressClaimId: source === 'progress_claim' ? CLAIM_APPROVED : null,
    claimNumber:     source === 'progress_claim' ? 'PC-0001' : null,
    // ADR-63: the number of variation-origin lines (0 — no new-scope line here).
    variationLineCount: 0,

    invoiceDate:  '2026-08-05',
    receivedDate: '2026-08-06',
    dueDate:      '2026-09-05',
    paymentTerms: { days: 30, basis: 'invoice' },

    lineItems:      lines,
    retention:      totals.retention,
    retentionGst:   totals.retentionGst,
    retentionTotal: totals.retentionTotal,
    subtotal:       totals.subtotal,
    gstTotal:       totals.gstTotal,
    grossTotal:     totals.grossTotal,
    net:            totals.net,
    payableGst:     totals.payableGst,
    payableTotal:   totals.payableTotal,

    currency: 'AUD',
    revision: 1,
    notes:    '',

    approvedAt:  null,
    approvedBy:  null,
    postedAt:    null,
    postedBy:    null,
    cancelledAt: null,
    cancelledBy: null,

    paidAt:           null,
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

// Seeds an invoice directly, bypassing rules — the arrange step for update
// tests. `status` selects the lifecycle stamps a real document would carry.
async function seed(id, status = 'draft', user = USERS.admin, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    // `source` and `retention` shape the derived totals, so they are handed to
    // the builder rather than pasted over it — otherwise a claim-sourced seed
    // would store retention 0 and a "retention change" test would silently be
    // a NO-OP that rules correctly allow.
    const base = invoicePayload(user, {
      ...(extra.source ? { source: extra.source } : {}),
      ...(extra.retention !== undefined ? { retention: extra.retention } : {}),
    })
    const lifecycle =
      status === 'approved'  ? { status: 'approved', approvedAt: Timestamp.now(), approvedBy: user.uid } :
      status === 'posted'    ? { status: 'posted',   approvedAt: Timestamp.now(), approvedBy: user.uid,
                                 postedAt: Timestamp.now(), postedBy: user.uid } :
      status === 'cancelled' ? { status: 'cancelled', cancelledAt: Timestamp.now(), cancelledBy: user.uid } :
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

// The write shapes the app performs, so tests exercise the real payloads.
const stamps = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })

// hooks/useSupplierInvoices.jsx → updateSupplierInvoice, claim-sourced branch.
const headerEdit = (user, extra = {}) => ({
  supplierInvoiceNumber: 'INV-4471-A',
  invoiceDate:  '2026-08-07',
  receivedDate: '2026-08-08',
  dueDate:      '2026-09-07',
  notes:        'Corrected reference',
  ...stamps(user),
  ...extra,
})

// hooks/useSupplierInvoices.jsx → updateSupplierInvoice, direct_po branch.
function lineEdit(user, { lines = [line(9000)], retention = 0, ...extra } = {}) {
  const totals = invoiceTotals(lines, retention)
  return {
    supplierInvoiceNumber: 'INV-4471',
    invoiceDate:  '2026-08-05',
    receivedDate: '2026-08-06',
    dueDate:      '2026-09-05',
    notes:        '',
    lineItems:      lines,
    retention:      totals.retention,
    retentionGst:   totals.retentionGst,
    retentionTotal: totals.retentionTotal,
    subtotal:       totals.subtotal,
    gstTotal:       totals.gstTotal,
    grossTotal:     totals.grossTotal,
    net:            totals.net,
    payableGst:     totals.payableGst,
    payableTotal:   totals.payableTotal,
    ...stamps(user),
    ...extra,
  }
}

const approveWrite = (user, extra = {}) => ({
  status: 'approved', approvedAt: serverTimestamp(), approvedBy: user.uid, ...stamps(user), ...extra,
})
const postWrite = (user, extra = {}) => ({
  status: 'posted', postedAt: serverTimestamp(), postedBy: user.uid, ...stamps(user), ...extra,
})
const cancelWrite = (user, extra = {}) => ({
  status: 'cancelled', cancelledAt: serverTimestamp(), cancelledBy: user.uid, ...stamps(user), ...extra,
})

// SHIELD 2A (ADR-68): a CLAIM-SOURCED create is PAIRED — the invoice and the
// claim's `supplierInvoiceId` link land in ONE batch (the app's transaction,
// lib/supplierInvoiceActions.js), and the rules refuse either half alone. Every
// claim-sourced create in this suite goes through here; the seeded claims
// carry revision 1, so the link carries 2 (CLAIM_VAR carries 2 → 3).
function pairedCreate(user, id, payload, { claimId = payload.progressClaimId, revision = 2 } = {}) {
  const db = ctx(user)
  const batch = writeBatch(db)
  batch.set(invRef(db, id), payload)
  batch.update(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/progressClaims`, claimId), {
    supplierInvoiceId: id, supplierInvoiceLinkedAt: serverTimestamp(), supplierInvoiceLinkedBy: user.uid,
    revision, updatedAt: serverTimestamp(), updatedBy: user.uid,
  })
  return batch.commit()
}
// Frees a seeded claim for another paired create (a claim takes ONE active invoice).
async function unlinkClaim(claimId = CLAIM_APPROVED) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects/${PROJECT_A}/progressClaims`, claimId), {
      supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null, revision: 1,
    })
  })
}

// Client-supplied clock values that must NEVER satisfy `== request.time`.
// Deliberately skewed rather than `Timestamp.now()` — see the note in
// supplierPayments.rules.test.js (docs/TESTING.md §0).
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]
const claimDocRef = (db, id) => doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/progressClaims`, id)

async function readInv(id) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const snap = await getDoc(doc(c.firestore(), invoicesPath(), id))
    data = snap.exists() ? snap.data() : undefined
  })
  return data
}
async function readClaimDoc(id) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const snap = await getDoc(claimDocRef(c.firestore(), id))
    data = snap.exists() ? snap.data() : undefined
  })
  return data
}
// What the TRUSTED BACKEND stores, written with rules disabled.
async function serverCreate(id, data) {
  await testEnv.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), invoicesPath(), id), data) })
}
async function serverUpdate(id, data) {
  await testEnv.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), invoicesPath(), id), data) })
}
// ADR-93 — a client create is REFUSED for EVERY financial role; nothing is
// stored. With `storeAs`, the same document is then written with rules disabled.
async function createRefused(id, build, { storeAs = null } = {}) {
  for (const user of FINANCIAL) await assertFails(setDoc(invRef(ctx(user), id), build(user)))
  expect(await readInv(id)).toBeUndefined()
  if (storeAs) await serverCreate(id, build(storeAs))
}
// ADR-93 — the PAIRED claim-sourced create (invoice + claim link in one batch)
// is REFUSED for EVERY financial role: no invoice, the claim does not move.
// With `storeAs`, the backend's pair is then written with rules disabled.
async function pairedRefused(id, build, { claimId = null, revision = 2, storeAs = null } = {}) {
  const cid = claimId ?? build(USERS.qs).progressClaimId
  const before = await readClaimDoc(cid)
  for (const user of FINANCIAL) await assertFails(pairedCreate(user, id, build(user), { claimId: cid, revision }))
  expect(await readInv(id)).toBeUndefined()
  expect(await readClaimDoc(cid)).toEqual(before)
  if (storeAs) {
    await serverCreate(id, build(storeAs))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(claimDocRef(c.firestore(), cid), {
        supplierInvoiceId: id, supplierInvoiceLinkedAt: serverTimestamp(), supplierInvoiceLinkedBy: storeAs.uid,
        revision, updatedAt: serverTimestamp(), updatedBy: storeAs.uid,
      })
    })
  }
}
// ADR-93 — a client update is REFUSED for EVERY financial role; the stored
// document does not move. With `storeAs`, the update is then made with rules
// disabled, so the rest of a scenario runs over the backend's state.
async function updateRefused(id, build, { storeAs = null } = {}) {
  const before = await readInv(id)
  expect(before).toBeDefined()
  for (const user of FINANCIAL) await assertFails(updateDoc(invRef(ctx(user), id), build(user)))
  expect(await readInv(id)).toEqual(before)
  if (storeAs) await serverUpdate(id, build(storeAs))
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
    // NOTE: no users/ document for ORPHAN_UID — that is the point.
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    for (const [companyId, projectId] of [[COMPANY_A, PROJECT_A], [COMPANY_A, PROJECT_B], [COMPANY_B, PROJECT_A]]) {
      await setDoc(doc(db, `companies/${companyId}/projects`, projectId), { name: projectId, currency: 'AUD' })
    }

    const po = (companyId, projectId, id, status) =>
      setDoc(doc(db, `companies/${companyId}/projects/${projectId}/purchaseOrders`, id), {
        poNumber: 'PO-0001', status, supplierId: 'contact1', supplierName: 'BuildCo Pty Ltd',
        lineItems: [{ costCodeId: 'cc1', lineTotal: 20000 }], subtotal: 20000, gst: 2000, total: 22000,
      })
    await po(COMPANY_A, PROJECT_A, PO_SENT, 'sent')
    await po(COMPANY_A, PROJECT_A, PO_CLOSED, 'closed')
    await po(COMPANY_A, PROJECT_A, PO_DRAFT, 'draft')
    await po(COMPANY_A, PROJECT_A, PO_CANCELLED, 'cancelled')
    await po(COMPANY_A, PROJECT_B, PO_OTHER_PROJ, 'sent')
    // Company B needs a sent PO too, so a cross-tenant test fails on the
    // MEMBERSHIP rule rather than incidentally on a missing source document.
    await po(COMPANY_B, PROJECT_A, PO_SENT, 'sent')

    // ADR-68: NEW-FORMAT claims (link key present, null) carrying the PO,
    // supplier and number the invoice payload cites — the pairing compares
    // all three. A LEGACY (key-absent) claim is seeded by the pairing suite.
    const claimNow = Timestamp.now()
    const claim = (companyId, projectId, id, status) =>
      setDoc(doc(db, `companies/${companyId}/projects/${projectId}/progressClaims`, id), {
        claimNumber: 'PC-0001', status, poId: PO_SENT, poNumber: 'PO-0001', supplierId: 'contact1', supplierName: 'BuildCo Pty Ltd',
        claimRef: '', periodEnding: '', variationId: null, variationLineCount: 0,
        lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', poLineTotal: 20000, previouslyApproved: 0, claimedToDate: 10000, claimedThisPeriod: 10000, approvedThisPeriod: status === 'approved' ? 10000 : null }],
        retention: 1000, claimedSubtotal: 10000, claimedGst: 900, claimedTotal: 9900,
        approvedSubtotal: status === 'approved' ? 10000 : null, approvedGst: status === 'approved' ? 900 : null, approvedTotal: status === 'approved' ? 9900 : null,
        notes: '', assessmentNotes: '', currency: 'AUD', revision: 1,
        submittedAt: status === 'draft' ? null : claimNow, submittedBy: status === 'draft' ? null : 'u_admin',
        approvedAt: status === 'approved' ? claimNow : null, approvedBy: status === 'approved' ? 'u_admin' : null, rejectedAt: null, rejectedBy: null, invoicedAt: null,
        supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null,
        externalRefs: {}, createdAt: claimNow, createdBy: 'u_admin', updatedAt: claimNow, updatedBy: 'u_admin',
      })
    await claim(COMPANY_A, PROJECT_A, CLAIM_APPROVED, 'approved')
    await claim(COMPANY_A, PROJECT_A, CLAIM_SUBMITTED, 'submitted')
    await claim(COMPANY_A, PROJECT_A, CLAIM_DRAFT, 'draft')
    await claim(COMPANY_B, PROJECT_A, CLAIM_APPROVED, 'approved')
  })
})

// ── Roles, membership & tenant isolation ─────────────────────────────────────

describe('roles, membership and tenant isolation', () => {
  it('ADR-93 — a draft invoice create is REFUSED for every financial role; nothing is stored', async () => {
    for (const user of FINANCIAL) {
      await createRefused(`create-${user.uid}`, invoicePayload)
    }
  })

  it('every financial role can read an invoice', async () => {
    await seed('read1')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(invRef(ctx(user), 'read1')))
    }
  })

  it('ADR-93 — approve, post and cancel are REFUSED for every financial role; the stored invoice does not move', async () => {
    await seed('ap', 'draft')
    await updateRefused('ap', (user) => approveWrite(user))
    await seed('po', 'approved')
    await updateRefused('po', (user) => postWrite(user))
    await seed('ca', 'draft')
    await updateRefused('ca', (user) => cancelWrite(user))
  })

  it('tenant isolation of a REFUSED-anyway write — another company\'s admin also cannot read the backend\'s invoice', async () => {
    await seed('ti', 'draft')
    await assertFails(getDoc(invRef(ctx(USERS.other), 'ti')))
    await assertFails(updateDoc(invRef(ctx(USERS.other), 'ti'), approveWrite(USERS.other)))
    for (const user of FINANCIAL) await assertSucceeds(getDoc(invRef(ctx(user), 'ti')))
  })

  it('subcontractor and client can neither read nor write — the AP register is financial-role only', async () => {
    await seed('deny1')
    for (const user of [USERS.sub, USERS.client]) {
      await assertFails(getDoc(invRef(ctx(user), 'deny1')))
      await assertFails(setDoc(invRef(ctx(user), `deny-${user.uid}`), invoicePayload(user)))
      await assertFails(updateDoc(invRef(ctx(user), 'deny1'), headerEdit(user)))
    }
  })

  it('an unauthenticated caller can neither read nor write', async () => {
    await seed('deny2')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(invRef(db, 'deny2')))
    await assertFails(setDoc(invRef(db, 'deny3'), invoicePayload(USERS.admin)))
    await assertFails(updateDoc(invRef(db, 'deny2'), headerEdit(USERS.admin)))
  })

  it('an authenticated caller with NO membership document is denied', async () => {
    await seed('deny4')
    const db = testEnv.authenticatedContext(ORPHAN_UID).firestore()
    await assertFails(getDoc(invRef(db, 'deny4')))
    await assertFails(setDoc(invRef(db, 'deny5'), invoicePayload({ uid: ORPHAN_UID })))
  })

  it("a Company B admin cannot touch Company A's invoices", async () => {
    await seed('deny6')
    const db = ctx(USERS.other)
    await assertFails(getDoc(invRef(db, 'deny6')))
    await assertFails(setDoc(invRef(db, 'deny7'), invoicePayload(USERS.other)))
    await assertFails(updateDoc(invRef(db, 'deny6'), headerEdit(USERS.other)))
  })

  it('a Company A admin cannot write into Company B', async () => {
    await assertFails(setDoc(
      invRef(ctx(USERS.admin), 'crosstenant', COMPANY_B), invoicePayload(USERS.admin),
    ))
  })
})

// ── Valid creates ────────────────────────────────────────────────────────────

describe('formerly valid create — ADR-93: every one REFUSED for every financial role', () => {
  it('ADR-93 — a direct_po draft against a SENT purchase order is REFUSED', async () => {
    await createRefused('c1', invoicePayload)
  })

  it('ADR-93 — a direct_po draft against a CLOSED purchase order is REFUSED', async () => {
    await createRefused('c2', (u) => invoicePayload(u, { poId: PO_CLOSED }))
  })

  it('ADR-93 — a progress_claim draft against an APPROVED claim, with retention, paired with the claim link (ADR-68), is REFUSED; the claim stays unlinked', async () => {
    await pairedRefused('c3', (u) => invoicePayload(u, { source: 'progress_claim', retention: 1000 }))
  })

  it('ADR-93 — a legacy pre-Contacts supplier (supplierId null) create is REFUSED', async () => {
    await createRefused('c4', (u) => invoicePayload(u, { supplierId: null }))
  })

  it('ADR-93 — an empty supplierInvoiceNumber, receivedDate and dueDate: REFUSED', async () => {
    await createRefused('c5', (u) => invoicePayload(u, { supplierInvoiceNumber: '', receivedDate: '', dueDate: '' }))
  })

  it('ADR-93 — a null paymentTerms snapshot: REFUSED', async () => {
    await createRefused('c6', (u) => invoicePayload(u, { paymentTerms: null }))
  })

  it('ADR-93 — a mixed tax-code line set: REFUSED', async () => {
    await createRefused('c7', (u) => invoicePayload(u, {
      lines: [line(5000, 'gst'), line(3000, 'gst_free'), line(2000, 'input_taxed')],
    }))
  })

  it('ADR-93 — a wholly GST-FREE invoice carrying retention (payableGst and payableTotal NEGATIVE) is REFUSED', async () => {
    // The deferred domain issue recorded in SECURITY.md → Deferred Control 29.
    // Rules deliberately apply NO `payableGst >= 0` / `payableTotal >= 0` floor,
    // because under the current financial model this document is app-reachable.
    const payload = invoicePayload(USERS.qs, {
      lines: [line(10000, 'gst_free')], retention: 10000,
    })
    expect(payload.gstTotal).toBe(0)
    expect(payload.payableGst).toBeLessThan(0)
    expect(payload.payableTotal).toBeLessThan(0)
    await createRefused('c8', () => payload)
  })

  it('ADR-93 — a gstTotal ABOVE 10% of subtotal (per-line roundings) is REFUSED', async () => {
    // Two 0.05 lines each round to 0.01 GST, so gstTotal is 0.02 against a naive
    // ceiling of 0.01. Any `gstTotal <= 10% of subtotal` rule would reject this.
    const payload = invoicePayload(USERS.qs, { lines: [line(0.05), line(0.05)] })
    expect(payload.subtotal).toBe(0.1)
    expect(payload.gstTotal).toBe(0.02)
    await createRefused('c9', () => payload)
  })

  it('ADR-93 — retention exactly equal to the subtotal: REFUSED', async () => {
    await createRefused('c10', (u) => invoicePayload(u, { retention: 10000 }))
  })
})

// ── Create — provenance and audit stamps ─────────────────────────────────────

describe('create provenance', () => {
  it('rejects a forged createdBy', async () => {
    await assertFails(setDoc(
      invRef(ctx(USERS.qs), 'p1'), invoicePayload(USERS.qs, { createdBy: USERS.admin.uid }),
    ))
  })

  it('rejects a forged updatedBy', async () => {
    await assertFails(setDoc(
      invRef(ctx(USERS.qs), 'p2'), invoicePayload(USERS.qs, { updatedBy: USERS.admin.uid }),
    ))
  })

  it('rejects a client-supplied createdAt from any skewed clock', async () => {
    let i = 0
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(
        invRef(ctx(USERS.qs), `p3-${i++}`), invoicePayload(USERS.qs, { createdAt: clock() }),
      ))
    }
  })

  it('rejects a client-supplied updatedAt from any skewed clock', async () => {
    let i = 0
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(
        invRef(ctx(USERS.qs), `p4-${i++}`), invoicePayload(USERS.qs, { updatedAt: clock() }),
      ))
    }
  })

  it('rejects a create with no updatedAt / updatedBy at all', async () => {
    for (const key of ['updatedAt', 'updatedBy']) {
      const payload = invoicePayload(USERS.qs)
      delete payload[key]
      await assertFails(setDoc(invRef(ctx(USERS.qs), `p5-${key}`), payload))
    }
  })
})

// ── Create — status, source and docType ──────────────────────────────────────

describe('create status, source and docType', () => {
  it('rejects every status but draft — including the reserved and deprecated ones', async () => {
    const forged = ['approved', 'posted', 'cancelled', 'paid', 'received', 'under_review', 'disputed', '', 42]
    let i = 0
    for (const status of forged) {
      await assertFails(setDoc(
        invRef(ctx(USERS.qs), `s1-${i++}`), invoicePayload(USERS.qs, { status }),
      ))
    }
  })

  it('rejects an unknown or malformed source', async () => {
    let i = 0
    for (const source of ['', 'manual', 'progress-claim', null, 42]) {
      await assertFails(setDoc(
        invRef(ctx(USERS.qs), `s2-${i++}`), invoicePayload(USERS.qs, { source }),
      ))
    }
  })

  it('rejects any docType but invoice — credit_note is superseded (ADR-31)', async () => {
    let i = 0
    for (const docType of ['credit_note', '', null]) {
      await assertFails(setDoc(
        invRef(ctx(USERS.qs), `s3-${i++}`), invoicePayload(USERS.qs, { docType }),
      ))
    }
  })
})

// ── Create — forged lifecycle stamps ─────────────────────────────────────────

describe('create cannot forge a lifecycle stamp', () => {
  it('rejects a non-null approval, posting or cancellation stamp', async () => {
    const forgeries = [
      { approvedAt: Timestamp.now() }, { approvedBy: USERS.qs.uid },
      { postedAt: Timestamp.now() },   { postedBy: USERS.qs.uid },
      { cancelledAt: Timestamp.now() },{ cancelledBy: USERS.qs.uid },
    ]
    let i = 0
    for (const over of forgeries) {
      await assertFails(setDoc(invRef(ctx(USERS.qs), `f1-${i++}`), invoicePayload(USERS.qs, over)))
    }
  })

  it('rejects a non-null paidAt — payment state is DERIVED, never authored (ADR-24)', async () => {
    await assertFails(setDoc(
      invRef(ctx(USERS.qs), 'f2'), invoicePayload(USERS.qs, { paidAt: Timestamp.now() }),
    ))
  })

  it('rejects a non-null adjustsInvoiceId — the credit link lives on the credit note (ADR-31)', async () => {
    await assertFails(setDoc(
      invRef(ctx(USERS.qs), 'f3'), invoicePayload(USERS.qs, { adjustsInvoiceId: 'si_other' }),
    ))
  })
})

// ── Create — shape ───────────────────────────────────────────────────────────

describe('create shape validation', () => {
  it('rejects a malformed currency', async () => {
    let i = 0
    for (const currency of ['aud', 'AUDX', 'AU', '', 42, null]) {
      await assertFails(setDoc(
        invRef(ctx(USERS.qs), `sh1-${i++}`), invoicePayload(USERS.qs, { currency }),
      ))
    }
  })

  it('rejects a missing or malformed invoiceDate', async () => {
    let i = 0
    for (const invoiceDate of ['', '05/08/2026', '2026-8-5', 20260805, null]) {
      await assertFails(setDoc(
        invRef(ctx(USERS.qs), `sh2-${i++}`), invoicePayload(USERS.qs, { invoiceDate }),
      ))
    }
  })

  it('rejects a malformed receivedDate or dueDate; ADR-93 — the empty strings are REFUSED too', async () => {
    await assertFails(setDoc(
      invRef(ctx(USERS.qs), 'sh3a'), invoicePayload(USERS.qs, { receivedDate: '6 Aug' }),
    ))
    await assertFails(setDoc(
      invRef(ctx(USERS.qs), 'sh3b'), invoicePayload(USERS.qs, { dueDate: null }),
    ))
    await createRefused('sh3c', (u) => invoicePayload(u, { receivedDate: '', dueDate: '' }))
  })

  it('rejects a non-string or empty invoiceNumber, and a non-number revision', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh4a'), invoicePayload(USERS.qs, { invoiceNumber: '' })))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh4b'), invoicePayload(USERS.qs, { invoiceNumber: 1 })))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh4c'), invoicePayload(USERS.qs, { revision: '1' })))
  })

  it('rejects an empty, missing or non-list lineItems', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh5a'), invoicePayload(USERS.qs, { lineItems: [] })))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh5b'), invoicePayload(USERS.qs, { lineItems: 'nope' })))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh5c'), invoicePayload(USERS.qs, { lineItems: null })))
  })

  it('rejects more than 200 line items', async () => {
    const many = Array.from({ length: 201 }, () => line(10))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh6'), invoicePayload(USERS.qs, { lines: many })))
  })

  it('rejects a non-string supplierName and an empty-string supplierId', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh7a'), invoicePayload(USERS.qs, { supplierName: null })))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh7b'), invoicePayload(USERS.qs, { supplierId: '' })))
  })

  it('rejects a non-string notes and a non-list attachments / non-map externalRefs', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh8a'), invoicePayload(USERS.qs, { notes: null })))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh8b'), invoicePayload(USERS.qs, { attachments: {} })))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'sh8c'), invoicePayload(USERS.qs, { externalRefs: [] })))
  })
})

// ── Create — money types, signs and arithmetic ───────────────────────────────

describe('money types and signs', () => {
  const MONEY_KEYS = [
    'subtotal', 'gstTotal', 'grossTotal', 'retention', 'retentionGst',
    'retentionTotal', 'net', 'payableGst', 'payableTotal',
  ]

  it('rejects a non-numeric value in any money field', async () => {
    let i = 0
    for (const key of MONEY_KEYS) {
      for (const bad of ['100', null]) {
        // ⚠️ The override is applied to the BUILT payload, not handed to the
        // builder: `retention` is a NAMED parameter of invoicePayload (it feeds
        // invoiceTotals), so passing it through would be coerced by
        // `Number(retention) || 0` into a perfectly valid document and the test
        // would assert nothing. Everything here must land on the STORED field.
        // The label is part of the assertion too — a bare "expected to fail"
        // gives no clue which of the eighteen writes slipped through.
        await assertFails(setDoc(
          invRef(ctx(USERS.qs), `m1-${i++}`), { ...invoicePayload(USERS.qs), [key]: bad },
        )).catch((e) => { throw new Error(`${key} = ${JSON.stringify(bad)}: ${e.message}`) })
      }
    }
  })

  it('REJECTS A NEGATIVE RETENTION — the create-path asymmetry ADR-40 closes', async () => {
    // invoiceTotals clamps only the UPPER bound, so before ADR-40 a negative
    // retention was stored verbatim and made payableTotal exceed grossTotal.
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'm3'), {
      ...invoicePayload(USERS.qs),
      retention: -500, retentionGst: -50, retentionTotal: -550,
      net: 10500, payableGst: 1050, payableTotal: 11550,
    }))
  })

  it('rejects a negative retentionGst, retentionTotal or net', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'm4a'), {
      ...invoicePayload(USERS.qs),
      retentionGst: -10, retentionTotal: -10, gstTotal: 1000, payableGst: 1010,
    }))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'm4b'), {
      ...invoicePayload(USERS.qs), net: -1, subtotal: 10000, retention: 10001,
    }))
  })

  it('rejects a zero or negative subtotal and grossTotal', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'm5a'), invoicePayload(USERS.qs, {
      subtotal: 0, gstTotal: 0, grossTotal: 0, net: 0, payableGst: 0, payableTotal: 0,
    })))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'm5b'), invoicePayload(USERS.qs, {
      subtotal: -100, gstTotal: 0, grossTotal: -100, net: -100, payableGst: 0, payableTotal: -100,
    })))
  })

  it('rejects a negative gstTotal', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'm6'), invoicePayload(USERS.qs, {
      gstTotal: -1000, grossTotal: 9000, payableGst: -1000, payableTotal: 9000,
    })))
  })

  it('rejects retention ABOVE the subtotal — invoiceTotals clamps it, rules refuse it', async () => {
    // Applied to the BUILT payload: invoiceTotals would clamp a retention above
    // the subtotal down to the subtotal, so the forged value must be written
    // over the stored field. Every other total is made internally consistent, so
    // the ONLY thing rejecting this document is `retention <= subtotal`.
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'm7'), {
      ...invoicePayload(USERS.qs),
      retention: 10001, retentionGst: 1000.1, retentionTotal: 11001.1,
      net: -1, payableGst: -0.1, payableTotal: -1.1,
    }))
  })
})

describe('scalar arithmetic identities — one cent breaks each', () => {
  // Each case perturbs ONE stored total by a single cent, leaving every other
  // field as the real invoiceTotals produced it. Rules compare in whole cents, so
  // a one-cent discrepancy must fail while the untouched payload succeeds.
  const CASES = [
    ['subtotal + gstTotal == grossTotal',           { grossTotal: 11000.01 }],
    ['retention + retentionGst == retentionTotal',  { retentionTotal: 1100.01 }],
    ['subtotal - retention == net',                 { net: 9000.01 }],
    ['gstTotal - retentionGst == payableGst',       { payableGst: 900.01 }],
    ['grossTotal - retentionTotal == payableTotal', { payableTotal: 9900.01 }],
    ['retentionGst is exactly 10% of retention',    { retentionGst: 100.01, retentionTotal: 1100.01, payableGst: 899.99, payableTotal: 9899.99 }],
  ]

  it('ADR-93 — the untouched retention-bearing payload is REFUSED for every financial role', async () => {
    await pairedRefused('a0', (u) => invoicePayload(u, { source: 'progress_claim', retention: 1000 }))
  })

  CASES.forEach(([label, over], idx) => {
    it(`rejects a document that breaks: ${label}`, async () => {
      await assertFails(pairedCreate(USERS.qs, `a${idx + 1}`, invoicePayload(USERS.qs, { source: 'progress_claim', retention: 1000, ...over })))
    })
  })
})

describe('retention GST rounding — math.floor((c+5)/10) matches JavaScript roundMoney', () => {
  // The one place Firestore Rules and JavaScript can silently disagree: Rules
  // integer `/` TRUNCATES. Every value below is built by the real invoiceTotals,
  // so if the rules formula ever drifts from roundMoney(x * 10%) these creates
  // start failing. Half-cent boundaries are the cases that actually diverge.
  const RETENTIONS = [0, 0.05, 0.1, 100.05, 100.04, 100.06, 1000, 1234.55, 1234.54, 9999.95]

  RETENTIONS.forEach((retention, i) => {
    it(`ADR-93 — retention ${retention.toFixed(2)} with its exact derived GST: REFUSED`, async () => {
      const payload = invoicePayload(USERS.qs, { retention })
      expect(payload.retentionGst).toBe(roundMoney(retention * 0.1))
      await createRefused(`g${i}`, (u) => invoicePayload(u, { retention }))
    })
  })

  // ── GST boundary hotfix (finding F2) ──────────────────────────────────────
  // roundMoney(x × 0.1) computes in binary floating point and on SOME half-cent
  // boundaries lands a hair below .5 and rounds DOWN (40.15 × 0.1 = 4.015 →
  // 4.01 where half-up gives 4.02). The retentionGst pin was EXACT half-up, so
  // the app's own direct-PO invoice with a 5% retention on $803.00 — and any
  // claim-sourced invoice whose claim carried such a retention — was refused
  // with permission-denied. The pin is now the shared gstPinned(): exact, or
  // one cent below ON A BOUNDARY ONLY. Nothing else is admitted.
  const BOUNDARY_RETENTIONS = [40.15, 41.05, 42.65, 80.85, 81.55, 83.35]

  BOUNDARY_RETENTIONS.forEach((retention, i) => {
    it(`ADR-93 — the app's own retention ${retention.toFixed(2)} payload (half-cent DOWN) is REFUSED`, async () => {
      const payload = invoicePayload(USERS.qs, { retention })
      // the client figure IS one cent below half-up for these values
      const halfUp = Math.floor((Math.round(retention * 100) + 5) / 10) / 100
      expect(payload.retentionGst).toBe(roundMoney(retention * 0.1))
      expect(Math.round(payload.retentionGst * 100)).toBe(Math.round(halfUp * 100) - 1)
      await createRefused(`gb${i}`, (u) => invoicePayload(u, { retention }))
    })
  })

  it('ADR-93 — BOTH boundary alternatives for 40.15 — 4.01 (the client) and 4.02 (exact half-up, historical) — are REFUSED', async () => {
    const base = invoicePayload(USERS.qs, { retention: 40.15 })
    expect(base.retentionGst).toBe(4.01)
    await createRefused('gb-client', (u) => invoicePayload(u, { retention: 40.15 }))
    const totals = invoiceTotals(DEFAULT_LINES, 0)
    await createRefused('gb-exact', (u) => ({
      ...invoicePayload(u, { retention: 40.15 }),
      retentionGst:   4.02,
      retentionTotal: 44.17,
      payableGst:     roundMoney(totals.gstTotal - 4.02),
      payableTotal:   roundMoney(totals.grossTotal - 44.17),
    }))
  })

  it('rejects one cent ABOVE half-up on a boundary (40.15 → 4.03) and two cents below (4.00)', async () => {
    const base = invoicePayload(USERS.qs, { retention: 40.15 })
    const totals = invoiceTotals(DEFAULT_LINES, 0)
    for (const [rgst, id] of [[4.03, 'gb-up'], [4.00, 'gb-down2']]) {
      const rtot = roundMoney(40.15 + rgst)
      await assertFails(setDoc(invRef(ctx(USERS.qs), id), {
        ...base,
        retentionGst:   rgst,
        retentionTotal: rtot,
        payableGst:     roundMoney(totals.gstTotal - rgst),
        payableTotal:   roundMoney(totals.grossTotal - rtot),
      }))
    }
  })

  it('rejects a one-cent deviation OFF a boundary in either direction (100.04 → 10.01 / 9.99)', async () => {
    const base = invoicePayload(USERS.qs, { retention: 100.04 })
    expect(base.retentionGst).toBe(10.00)
    const totals = invoiceTotals(DEFAULT_LINES, 0)
    for (const [rgst, id] of [[10.01, 'g-off-up'], [9.99, 'g-off-down']]) {
      const rtot = roundMoney(100.04 + rgst)
      await assertFails(setDoc(invRef(ctx(USERS.qs), id), {
        ...base,
        retentionGst:   rgst,
        retentionTotal: rtot,
        payableGst:     roundMoney(totals.gstTotal - rgst),
        payableTotal:   roundMoney(totals.grossTotal - rtot),
      }))
    }
  })

  it('rejects a retention GST one cent ABOVE the derived value on the 100.05 boundary (the pre-hotfix case, direction preserved)', async () => {
    const payload = invoicePayload(USERS.qs, { retention: 100.05 })
    expect(payload.retentionGst).toBe(10.01)
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'g-bad'), {
      ...payload,
      retentionGst:   10.02,
      retentionTotal: 110.07,
      payableGst:     989.98,
      payableTotal:   10889.93,
    }))
  })

  it('still rejects an arbitrary self-consistent retentionGst (10% of nothing)', async () => {
    const payload = invoicePayload(USERS.qs, { retention: 40.15 })
    const totals = invoiceTotals(DEFAULT_LINES, 0)
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'g-arbitrary'), {
      ...payload,
      retentionGst:   0,
      retentionTotal: 40.15,
      payableGst:     totals.gstTotal,
      payableTotal:   roundMoney(totals.grossTotal - 40.15),
    }))
  })
})

describe('the claim-sourced invoice the app built (GST boundary hotfix, finding F3) — ADR-93: REFUSED from every client', () => {
  // Three certified claim lines of 10.05: the claim certifies GST on its net
  // total (3.02); per-line 10% roundings gave 3.03 and the client guard refused
  // the invoice. The lines now carry the certified GST APPORTIONED
  // (allocateClaimSourcedLineGst) — this is the exact document the hook writes,
  // built through the real lib, so a rules/client divergence shows up here.
  const CLAIM_AMOUNTS = [10.05, 10.05, 10.05]
  const claimLines = CLAIM_AMOUNTS.map((amount, idx) => line(amount, 'gst', { poLineIndex: idx, costCodeId: `cc${idx}` }))

  it('ADR-93 — create, approve and post of a claim-sourced invoice whose lines carry the apportioned certified GST are each REFUSED for every financial role; the backend\'s document carries the certified figures', async () => {
    const certified = claimTotals(CLAIM_AMOUNTS, 0)
    expect(certified.gst).toBe(3.02)
    const lines = allocateClaimSourcedLineGst(claimLines, { certifiedGst: certified.gst, retention: 0 })
    expect(lines.map(l => l.gstAmount)).toEqual([1.01, 1.01, 1.00])
    const totals = invoiceTotals(lines, 0)
    expect(claimReconciliationError(totals, { approvedGst: certified.gst, approvedTotal: certified.total })).toBeNull()

    const ref = invRef(ctx(USERS.qs), 'claim-apportioned')
    await pairedRefused('claim-apportioned', (u) => invoicePayload(u, { source: 'progress_claim', lines }), { storeAs: USERS.qs })
    await updateRefused('claim-apportioned', (u) => ({
      status: 'approved', approvedAt: serverTimestamp(), approvedBy: u.uid, ...stamps(u),
    }), { storeAs: USERS.qs })
    await updateRefused('claim-apportioned', (u) => ({
      status: 'posted', postedAt: serverTimestamp(), postedBy: u.uid, ...stamps(u),
    }), { storeAs: USERS.qs })
    const snap = await getDoc(ref)   // a financial-role READ still succeeds
    expect(snap.data().gstTotal).toBe(3.02)
    expect(snap.data().payableGst).toBe(certified.gst)
    expect(snap.data().payableTotal).toBe(certified.total)
  })

  it('ADR-93 — the same claim with a boundary retention (803.00 at 5% = 40.15): the paired create is REFUSED', async () => {
    const certified = claimTotals([803], 40.15)
    const srcLines = [line(803, 'gst', { poLineIndex: 0 })]
    const lines = allocateClaimSourcedLineGst(srcLines, { certifiedGst: certified.gst, retention: 40.15 })
    const totals = invoiceTotals(lines, 40.15)
    expect(totals.retentionGst).toBe(4.01)   // the client's half-cent-down figure
    expect(claimReconciliationError(totals, { approvedGst: certified.gst, approvedTotal: certified.total })).toBeNull()
    await pairedRefused('claim-boundary-retention', (u) => invoicePayload(u, { source: 'progress_claim', lines, retention: 40.15 }))
  })
})

// ── Tier 2 — source-document validation (CREATE ONLY) ────────────────────────

describe('Tier 2 source-document validation at create', () => {
  it('rejects a poId that names nothing', async () => {
    await assertFails(setDoc(
      invRef(ctx(USERS.qs), 't1'), invoicePayload(USERS.qs, { poId: 'po_missing' }),
    ))
  })

  it('rejects a null or empty poId', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 't2a'), invoicePayload(USERS.qs, { poId: null })))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 't2b'), invoicePayload(USERS.qs, { poId: '' })))
  })

  it('rejects a DRAFT or CANCELLED purchase order — neither is a commitment', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 't3a'), invoicePayload(USERS.qs, { poId: PO_DRAFT })))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 't3b'), invoicePayload(USERS.qs, { poId: PO_CANCELLED })))
  })

  it("rejects another project's purchase order", async () => {
    await assertFails(setDoc(
      invRef(ctx(USERS.qs), 't4'), invoicePayload(USERS.qs, { poId: PO_OTHER_PROJ }),
    ))
  })

  it('rejects a progress_claim invoice whose claim is not approved', async () => {
    for (const claimId of [CLAIM_SUBMITTED, CLAIM_DRAFT, 'claim_missing']) {
      await assertFails(pairedCreate(USERS.qs, `t5-${claimId}`, invoicePayload(USERS.qs, {
        source: 'progress_claim', progressClaimId: claimId, retention: 1000,
      })))
    }
  })

  it('rejects a progress_claim invoice with a null progressClaimId', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 't6'), invoicePayload(USERS.qs, {
      source: 'progress_claim', progressClaimId: null, retention: 1000,
    })))
  })

  it('rejects a direct_po invoice carrying a claim reference — it would erase that claim from Actual', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 't7'), invoicePayload(USERS.qs, {
      source: 'direct_po', progressClaimId: CLAIM_APPROVED,
    })))
  })

  it('a later PO status change — ADR-93: the line edit, approve and post that used to pass are each REFUSED for every financial role', async () => {
    // The ADR-34 rule: an UNCHANGED reference is never re-checked. poId is
    // core-preserved, so re-validating it on an edit or a transition could only
    // strand a legitimate invoice whose PO was later closed or cancelled.
    await seed('t8', 'draft')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects/${PROJECT_A}/purchaseOrders`, PO_SENT), { status: 'cancelled' })
    })
    await updateRefused('t8', (u) => lineEdit(u), { storeAs: USERS.qs })
    await updateRefused('t8', (u) => approveWrite(u), { storeAs: USERS.qs })
    await updateRefused('t8', (u) => postWrite(u))
  })

  it('a claim-sourced invoice whose claim changed status afterwards — ADR-93: the header edit and approve are REFUSED for every financial role', async () => {
    await seed('t9', 'draft', USERS.admin, { source: 'progress_claim', retention: 1000 })
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects/${PROJECT_A}/progressClaims`, CLAIM_APPROVED), { status: 'rejected' })
    })
    await updateRefused('t9', (u) => headerEdit(u), { storeAs: USERS.qs })
    await updateRefused('t9', (u) => approveWrite(u))
  })
})

// ── Immutable identity ───────────────────────────────────────────────────────

describe('immutable core identity', () => {
  const CORE = {
    invoiceNumber:    'SI-9999',
    docType:          'credit_note',
    source:           'progress_claim',
    currency:         'NZD',
    revision:         2,
    supplierId:       'contact2',
    supplierName:     'Someone Else Pty Ltd',
    poId:             PO_CLOSED,
    poNumber:         'PO-9999',
    progressClaimId:  CLAIM_APPROVED,
    claimNumber:      'PC-9999',
    paymentTerms:     { days: 7, basis: 'eom' },
    paidAt:           Timestamp.now(),
    adjustsInvoiceId: 'si_other',
  }

  it('rejects every core field change on a DRAFT edit', async () => {
    for (const [key, value] of Object.entries(CORE)) {
      await seed(`i1-${key}`, 'draft')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `i1-${key}`), lineEdit(USERS.qs, { [key]: value })))
    }
  })

  it('rejects every core field change smuggled into an APPROVE', async () => {
    for (const [key, value] of Object.entries(CORE)) {
      await seed(`i2-${key}`, 'draft')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `i2-${key}`), approveWrite(USERS.qs, { [key]: value })))
    }
  })

  it('rejects createdAt / createdBy rewriting on any path', async () => {
    await seed('i3', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'i3'), lineEdit(USERS.qs, { createdBy: USERS.qs.uid })))
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'i3'), lineEdit(USERS.qs, { createdAt: Timestamp.now() })))
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'i3'), approveWrite(USERS.qs, { createdAt: serverTimestamp() })))
  })
})

// ── Legal transitions ────────────────────────────────────────────────────────

describe('formerly legal lifecycle transitions — ADR-93: every one REFUSED for every financial role', () => {
  it('ADR-93 — draft -> approved with the exact hook payload is REFUSED', async () => {
    await seed('l1', 'draft')
    await updateRefused('l1', (u) => approveWrite(u))
  })

  it('ADR-93 — approved -> posted with the exact hook payload is REFUSED', async () => {
    await seed('l2', 'approved')
    await updateRefused('l2', (u) => postWrite(u))
  })

  it('ADR-93 — draft -> cancelled and approved -> cancelled are REFUSED', async () => {
    await seed('l3', 'draft')
    await updateRefused('l3', (u) => cancelWrite(u))
    await seed('l4', 'approved')
    await updateRefused('l4', (u) => cancelWrite(u))
  })

  it('ADR-93 — the full draft -> approved -> posted walk is REFUSED at every step (each stored state written as the backend would)', async () => {
    await createRefused('l5', invoicePayload, { storeAs: USERS.pm })
    await updateRefused('l5', (u) => approveWrite(u), { storeAs: USERS.pm })
    await updateRefused('l5', (u) => postWrite(u), { storeAs: USERS.pm })
    expect((await readInv('l5')).status).toBe('posted')
  })
})

// ── Illegal transitions ──────────────────────────────────────────────────────

describe('illegal lifecycle transitions', () => {
  it('rejects draft -> posted — posting can never skip the approval freeze point', async () => {
    await seed('x1', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'x1'), postWrite(USERS.qs)))
  })

  it('rejects approved -> draft (reopening the authoring freeze)', async () => {
    await seed('x2', 'approved')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'x2'), { status: 'draft', ...stamps(USERS.qs) }))
  })

  it('rejects every exit from posted', async () => {
    for (const status of ['draft', 'approved', 'cancelled', 'paid']) {
      await seed(`x3-${status}`, 'posted')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `x3-${status}`), { status, ...stamps(USERS.qs) }))
    }
  })

  it('rejects every exit from cancelled', async () => {
    for (const status of ['draft', 'approved', 'posted']) {
      await seed(`x4-${status}`, 'cancelled')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `x4-${status}`), { status, ...stamps(USERS.qs) }))
    }
  })

  it('rejects a move into any reserved or deprecated status', async () => {
    for (const status of ['received', 'under_review', 'disputed', 'paid']) {
      await seed(`x5-${status}`, 'draft')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `x5-${status}`), { status, ...stamps(USERS.qs) }))
      await seed(`x6-${status}`, 'approved')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `x6-${status}`), { status, ...stamps(USERS.qs) }))
    }
  })

  it("rejects forging status 'paid' on a POSTED invoice — the ADR-24 hole is closed", async () => {
    await seed('x7', 'posted')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'x7'), {
      status: 'paid', paidAt: serverTimestamp(), ...stamps(USERS.qs),
    }))
  })

  it('rejects an unknown status string', async () => {
    await seed('x8', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'x8'), { status: 'settled', ...stamps(USERS.qs) }))
  })
})

// ── Transition purity ────────────────────────────────────────────────────────

describe('a transition may carry no content change', () => {
  const SMUGGLE = [
    { notes: 'slipped in' },
    { supplierInvoiceNumber: 'INV-OTHER' },
    { subtotal: 20000 },
    { payableTotal: 99999 },
    { lineItems: [line(20000)] },
    { dueDate: '2027-01-01' },
    { attachments: ['x'] },
  ]

  it('rejects content smuggled into an approve', async () => {
    let i = 0
    for (const over of SMUGGLE) {
      await seed(`y1-${i}`, 'draft')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `y1-${i++}`), approveWrite(USERS.qs, over)))
    }
  })

  it('rejects content smuggled into a post', async () => {
    let i = 0
    for (const over of SMUGGLE) {
      await seed(`y2-${i}`, 'approved')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `y2-${i++}`), postWrite(USERS.qs, over)))
    }
  })

  it('rejects content smuggled into a cancel', async () => {
    let i = 0
    for (const over of SMUGGLE) {
      await seed(`y3-${i}`, 'approved')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `y3-${i++}`), cancelWrite(USERS.qs, over)))
    }
  })

  it('rejects an approval stamped for another user, or from a skewed clock', async () => {
    await seed('y4', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'y4'), approveWrite(USERS.qs, { approvedBy: USERS.admin.uid })))
    let i = 0
    for (const clock of CLIENT_CLOCKS) {
      await seed(`y5-${i}`, 'draft')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `y5-${i++}`), approveWrite(USERS.qs, { approvedAt: clock() })))
    }
  })

  it('rejects a posting stamped for another user, or from a skewed clock', async () => {
    await seed('y6', 'approved')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'y6'), postWrite(USERS.qs, { postedBy: USERS.admin.uid })))
    let i = 0
    for (const clock of CLIENT_CLOCKS) {
      await seed(`y7-${i}`, 'approved')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `y7-${i++}`), postWrite(USERS.qs, { postedAt: clock() })))
    }
  })

  it('rejects a cancellation stamped for another user, or from a skewed clock', async () => {
    await seed('y8', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'y8'), cancelWrite(USERS.qs, { cancelledBy: USERS.admin.uid })))
    let i = 0
    for (const clock of CLIENT_CLOCKS) {
      await seed(`y9-${i}`, 'draft')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `y9-${i++}`), cancelWrite(USERS.qs, { cancelledAt: clock() })))
    }
  })

  it('rejects any transition that omits updatedAt / updatedBy', async () => {
    await seed('y10', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'y10'), {
      status: 'approved', approvedAt: serverTimestamp(), approvedBy: USERS.qs.uid,
    }))
  })

  it('rejects a cancellation that omits cancelledBy', async () => {
    await seed('y11', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'y11'), {
      status: 'cancelled', cancelledAt: serverTimestamp(), ...stamps(USERS.qs),
    }))
  })
})

// ── Approved authoring freeze ────────────────────────────────────────────────

describe('approved is the AUTHORING FREEZE POINT', () => {
  it('rejects a header edit on an approved invoice', async () => {
    await seed('z1', 'approved')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'z1'), headerEdit(USERS.qs)))
  })

  it('rejects a line, retention or total edit on an approved invoice', async () => {
    await seed('z2', 'approved')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'z2'), lineEdit(USERS.qs)))
    await seed('z3', 'approved')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'z3'), lineEdit(USERS.qs, { retention: 500 })))
  })

  it('rejects an identical-data rewrite of an approved invoice', async () => {
    await seed('z4', 'approved')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'z4'), { notes: '', ...stamps(USERS.qs) }))
  })

  it('ADR-93 — the two updates formerly available from approved (post and cancel) are REFUSED for every financial role', async () => {
    await seed('z5', 'approved')
    await updateRefused('z5', (u) => postWrite(u))
    await seed('z6', 'approved')
    await updateRefused('z6', (u) => cancelWrite(u))
  })
})

// ── Posted and cancelled are terminal ────────────────────────────────────────

describe('posted is TERMINAL and immutable', () => {
  it('rejects every content edit on a posted invoice', async () => {
    const writes = [
      (u) => headerEdit(u),
      (u) => lineEdit(u),
      (u) => ({ notes: 'x', ...stamps(u) }),
      (u) => ({ payableTotal: 1, ...stamps(u) }),
      (u) => ({ retention: 0, retentionGst: 0, retentionTotal: 0, ...stamps(u) }),
      (u) => ({ paidAt: serverTimestamp(), ...stamps(u) }),
      (u) => ({ attachments: ['forged'], ...stamps(u) }),
    ]
    let i = 0
    for (const build of writes) {
      await seed(`w1-${i}`, 'posted')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `w1-${i++}`), build(USERS.qs)))
    }
  })

  it('rejects an identical-data rewrite of a posted invoice', async () => {
    await seed('w2', 'posted')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'w2'), { notes: '', ...stamps(USERS.qs) }))
  })

  it('CANNOT CANCEL A POSTED INVOICE — corrections are Supplier Credit Notes (ADR-31)', async () => {
    await seed('w3', 'posted')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'w3'), cancelWrite(USERS.qs)))
  })
})

describe('cancelled is TERMINAL and immutable', () => {
  it('rejects every update on a cancelled invoice', async () => {
    const writes = [
      (u) => headerEdit(u),
      (u) => lineEdit(u),
      (u) => approveWrite(u),
      (u) => ({ notes: 'x', ...stamps(u) }),
    ]
    let i = 0
    for (const build of writes) {
      await seed(`v1-${i}`, 'cancelled')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `v1-${i++}`), build(USERS.qs)))
    }
  })
})

describe('delete is blocked everywhere', () => {
  it('rejects delete for every role and every status', async () => {
    for (const status of ['draft', 'approved', 'posted', 'cancelled']) {
      for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client]) {
        await seed(`d-${status}-${user.uid}`, status)
        await assertFails(deleteDoc(invRef(ctx(user), `d-${status}-${user.uid}`)))
      }
    }
  })
})

// ── Draft editing — direct_po ────────────────────────────────────────────────

describe('draft edit — direct_po (ADR-93: the well-formed edits are REFUSED too)', () => {
  it('ADR-93 — the exact hook payload is REFUSED for every financial role', async () => {
    await seed('e1', 'draft')
    await updateRefused('e1', (u) => lineEdit(u))
  })

  it('ADR-93 — re-authored retention within the subtotal is REFUSED', async () => {
    await seed('e2', 'draft')
    await updateRefused('e2', (u) => lineEdit(u, { retention: 500 }))
  })

  it('ADR-93 — a header-only correction (line money unchanged) is REFUSED', async () => {
    await seed('e3', 'draft')
    await updateRefused('e3', (u) => headerEdit(u))
  })

  it('ADR-93 — a stored line taken to zero while ANOTHER line stays positive is REFUSED', async () => {
    await seed('e4', 'draft', USERS.admin, { lineItems: [line(6000), line(4000, 'gst', { poLineIndex: 1 })], subtotal: 10000, gstTotal: 1000, grossTotal: 11000, net: 10000, payableGst: 1000, payableTotal: 11000 })
    await updateRefused('e4', (u) => lineEdit(u, {
      lines: [line(6000), line(0, 'gst', { poLineIndex: 1 })],
    }))
  })

  it('REJECTS a grown or shrunk line set — the stored line set is fixed (ADR-38)', async () => {
    await seed('e5', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'e5'), lineEdit(USERS.qs, {
      lines: [line(5000), line(5000, 'gst', { poLineIndex: 1 })],
    })))
    await seed('e6', 'draft', USERS.admin, { lineItems: [line(6000), line(4000, 'gst', { poLineIndex: 1 })] })
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'e6'), lineEdit(USERS.qs, { lines: [line(10000)] })))
  })

  it('rejects a negative retention on a draft edit', async () => {
    await seed('e7', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'e7'), {
      ...lineEdit(USERS.qs), retention: -100, retentionGst: -10, retentionTotal: -110,
      net: 9100, payableGst: 910, payableTotal: 10010,
    }))
  })

  it('rejects a draft edit that breaks a scalar identity by one cent', async () => {
    await seed('e8', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'e8'), lineEdit(USERS.qs, { grossTotal: 9900.01 })))
  })

  it('rejects a draft edit that forges a lifecycle stamp', async () => {
    for (const over of [{ approvedAt: Timestamp.now() }, { approvedBy: USERS.qs.uid }, { postedBy: USERS.qs.uid }, { cancelledAt: Timestamp.now() }, { cancelledBy: USERS.qs.uid }]) {
      await seed('e9', 'draft')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), 'e9'), lineEdit(USERS.qs, over)))
    }
  })

  it('rejects a draft edit missing updatedAt / updatedBy', async () => {
    await seed('e10', 'draft')
    const payload = lineEdit(USERS.qs)
    delete payload.updatedAt
    delete payload.updatedBy
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'e10'), payload))
  })

  it('rejects a draft edit whose updatedAt comes from a client clock', async () => {
    let i = 0
    for (const clock of CLIENT_CLOCKS) {
      await seed(`e11-${i}`, 'draft')
      await assertFails(updateDoc(invRef(ctx(USERS.qs), `e11-${i++}`), lineEdit(USERS.qs, { updatedAt: clock() })))
    }
  })

  it('rejects a malformed invoiceDate on a draft edit', async () => {
    await seed('e12', 'draft')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'e12'), lineEdit(USERS.qs, { invoiceDate: '' })))
  })
})

// ── Draft editing — progress_claim (header only) ──────────────────────────────

describe('draft edit — progress_claim is HEADER-ONLY by rules', () => {
  // A REAL claim-sourced invoice: it withholds the claim's certified retention,
  // so a "change the retention" test is a genuine change rather than a no-op.
  const claimSeed = (id) => seed(id, 'draft', USERS.admin, { source: 'progress_claim', retention: 1000 })

  it('ADR-93 — the exact claim-sourced hook payload is REFUSED for every financial role', async () => {
    await claimSeed('h1')
    await updateRefused('h1', (u) => headerEdit(u))
  })

  it('ADR-93 — a partial header correction is REFUSED', async () => {
    await claimSeed('h2')
    await updateRefused('h2', (u) => ({
      supplierInvoiceNumber: 'INV-CORRECTED', ...stamps(u),
    }))
  })

  it('REJECTS any line-item change — certified money has no channel', async () => {
    await claimSeed('h3')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'h3'), {
      lineItems: [line(9000)], ...stamps(USERS.qs),
    }))
  })

  it('REJECTS a retention change', async () => {
    await claimSeed('h4')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'h4'), {
      retention: 0, retentionGst: 0, retentionTotal: 0, ...stamps(USERS.qs),
    }))
  })

  it('REJECTS any header total change, even an internally consistent one', async () => {
    await claimSeed('h5')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'h5'), lineEdit(USERS.qs)))
  })

  it('REJECTS a payableTotal change — the claim reconciliation is structurally unbreakable', async () => {
    await claimSeed('h6')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'h6'), {
      payableTotal: 99999, ...stamps(USERS.qs),
    }))
  })

  it('rejects an attachments or externalRefs change on the claim-sourced path', async () => {
    await claimSeed('h7')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'h7'), { attachments: ['x'], ...stamps(USERS.qs) }))
  })

  it('rejects a malformed date on a claim-sourced header edit', async () => {
    await claimSeed('h8')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'h8'), headerEdit(USERS.qs, { invoiceDate: 'soon' })))
  })

  it('ADR-93 — approve and post on a claim-sourced invoice are REFUSED for every financial role', async () => {
    await claimSeed('h9')
    await updateRefused('h9', (u) => approveWrite(u), { storeAs: USERS.qs })
    await updateRefused('h9', (u) => postWrite(u))
  })
})

// ── Legacy documents (raised before ADR-40) ──────────────────────────────────

describe('documents raised before ADR-40 — ADR-93: no longer client-writable', () => {
  // Existing invoices carry no updatedAt, updatedBy or cancelledBy. Rules read
  // cancelledBy through get(key, null) on BOTH sides, and the new audit stamps
  // are required only of the INCOMING document, so a legacy record acquires them
  // on its next valid write rather than being trapped.
  async function seedLegacy(id, status = 'draft', source = 'direct_po') {
    await seed(id, status, USERS.admin, { source })
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const db = c.firestore()
      const snap = await getDoc(doc(db, invoicesPath(), id))
      const data = { ...snap.data() }
      delete data.updatedAt
      delete data.updatedBy
      delete data.cancelledBy
      await setDoc(doc(db, invoicesPath(), id), data)
    })
  }

  it('ADR-93 — a legacy direct_po draft edit is REFUSED for every financial role and the document acquires no audit field', async () => {
    await seedLegacy('lg1')
    await updateRefused('lg1', (u) => lineEdit(u))
    const after = await readInv('lg1')
    expect('updatedBy' in after).toBe(false)
    expect('updatedAt' in after).toBe(false)
  })

  it('ADR-93 — a legacy claim-sourced draft header correction is REFUSED', async () => {
    await seedLegacy('lg2', 'draft', 'progress_claim')
    await updateRefused('lg2', (u) => headerEdit(u))
  })

  it('ADR-93 — a legacy draft approve, post and cancel are REFUSED', async () => {
    await seedLegacy('lg3')
    await updateRefused('lg3', (u) => approveWrite(u), { storeAs: USERS.qs })
    await updateRefused('lg3', (u) => postWrite(u))
    await seedLegacy('lg4')
    await updateRefused('lg4', (u) => cancelWrite(u))
  })

  it('a legacy POSTED invoice is still terminal', async () => {
    await seedLegacy('lg5', 'posted')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'lg5'), cancelWrite(USERS.qs)))
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'lg5'), headerEdit(USERS.qs)))
  })
})

// ── Downstream regression — the collections that get() these documents ───────

describe('downstream collections — ADR-93 / ADR-94: an invoice and its credit note / retention release are all backend-only', () => {
  // supplierCreditNotes and retentionReleases both get() a supplier invoice and
  // read status / supplierId / currency / retention / retentionTotal /
  // payableTotal. An invoice created and posted through the NEW rules must still
  // satisfy both target checks unchanged.
  // ADR-93: each step the app used to take is REFUSED for every financial role;
  // the backend's state is then written with rules disabled.
  async function createAndPost(id, opts = {}) {
    if (opts.source === 'progress_claim') await pairedRefused(id, (u) => invoicePayload(u, opts), { storeAs: USERS.qs })
    else await createRefused(id, (u) => invoicePayload(u, opts), { storeAs: USERS.qs })
    await updateRefused(id, (u) => approveWrite(u), { storeAs: USERS.qs })
    await updateRefused(id, (u) => postWrite(u), { storeAs: USERS.qs })
  }
  const refusedDownstream = async (collection, id, data) => {
    for (const user of FINANCIAL) await assertFails(setDoc(doc(ctx(user), `companies/${COMPANY_A}/projects/${PROJECT_A}/${collection}`, id), data))
    let stored
    await testEnv.withSecurityRulesDisabled(async (c) => { stored = (await getDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects/${PROJECT_A}/${collection}`, id))).exists() })
    expect(stored).toBe(false)
  }

  it('ADR-94 — a Supplier Credit Note targeting a (backend-)posted invoice is REFUSED for every financial role', async () => {
    await createAndPost('dn1')   // zero retention — the credit-note precondition
    await refusedDownstream('supplierCreditNotes', 'cn1', {
      creditNumber: 'SCN-0001', status: 'draft', docType: 'credit_note',
      supplierInvoiceId: 'dn1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471',
      supplierId: 'contact1', supplierName: 'BuildCo Pty Ltd',
      supplierCreditReference: 'CN-9', creditDate: '2026-08-20',
      reason: 'Over-claimed quantities',
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Credit', amount: 100, taxCode: 'gst', gstAmount: 10 }],
      subtotal: 100, gstTotal: 10, grossTotal: 110,
      currency: 'AUD', revision: 1, notes: '',
      postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
      attachments: [], externalRefs: {},
      createdAt: serverTimestamp(), createdBy: USERS.qs.uid,
      updatedAt: serverTimestamp(), updatedBy: USERS.qs.uid,
    })
  })

  it('ADR-94 — a Retention Release targeting a (backend-)posted retention-bearing invoice is REFUSED for every financial role', async () => {
    await createAndPost('dn2', { source: 'progress_claim', retention: 1000 })
    const money = releaseTotals(0, 400)
    await refusedDownstream('retentionReleases', 'rr1', {
      releaseNumber: 'RR-0001', status: 'draft', docType: 'retention_release',
      supplierInvoiceId: 'dn2', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-4471',
      supplierId: 'contact1', supplierName: 'BuildCo Pty Ltd',
      previouslyReleasedAmount: money.previouslyReleasedAmount,
      amount: money.amount, gstAmount: money.gstAmount, releaseTotal: money.releaseTotal,
      releaseDate: '2026-09-01', reason: 'Practical completion reached', notes: '',
      currency: 'AUD', revision: 1,
      postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
      externalRefs: {},
      createdAt: serverTimestamp(), createdBy: USERS.qs.uid,
      updatedAt: serverTimestamp(), updatedBy: USERS.qs.uid,
    })
  })
})

// ── The security ceiling — deferred controls, proven UNENFORCED ──────────────

// ADR-93: every shape below USED to be ACCEPTED from a client (the honest
// ceiling of the client-written block). Each is now REFUSED for every financial
// role; whether the BACKEND closes the gap is proven in tests/functions.
describe('formerly DEFERRED CONTROLS — ADR-93: every former client-accepted shape is now REFUSED', () => {
  it('ADR-93 — DUPLICATE supplier invoice references: both creates REFUSED', async () => {
    await createRefused('dc1a', (u) => invoicePayload(u, { supplierInvoiceNumber: 'INV-DUP' }), { storeAs: USERS.qs })
    await createRefused('dc1b', (u) => invoicePayload(u, { supplierInvoiceNumber: 'INV-DUP' }))
  })

  it('ADR-93 — DUPLICATE SI-#### numbers: both creates REFUSED (and the counter is backend-only)', async () => {
    await createRefused('dc2a', (u) => invoicePayload(u, { invoiceNumber: 'SI-0007' }), { storeAs: USERS.qs })
    await createRefused('dc2b', (u) => invoicePayload(u, { invoiceNumber: 'SI-0007' }))
  })

  it('TWO invoices against ONE approved claim are NOT possible — ADR-93: the first paired create is REFUSED too; once the backend has paired, the second is refused', async () => {
    const claimInv = { source: 'progress_claim', retention: 1000 }
    await pairedRefused('dc3a', (u) => invoicePayload(u, claimInv), { storeAs: USERS.qs })
    await assertFails(pairedCreate(USERS.qs, 'dc3b', invoicePayload(USERS.qs, claimInv)))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'dc3c'), invoicePayload(USERS.qs, claimInv)))
    // What rules still cannot see: a claim with NO link key at all (legacy) —
    // fail-closed, never a second invoice (tests/rules/claimInvoicePairing.rules.test.js).
  })

  it('ADR-93 — CUMULATIVE over-invoicing against a PO: every one of the three 10,000 creates is REFUSED', async () => {
    // The seeded PO totals 20,000 ex-GST.
    for (const id of ['dc4a', 'dc4b', 'dc4c']) {
      await createRefused(id, invoicePayload, { storeAs: USERS.qs })
    }
  })

  it('ADR-93 — HEADER TOTALS CONTRADICTING THEIR OWN LINES: REFUSED', async () => {
    // The lines say 10.00; the headers say 10,000.00.
    await createRefused('dc5', (u) => invoicePayload(u, {
      lines: [line(10)], subtotal: 10000, gstTotal: 1000, grossTotal: 11000,
      retention: 0, retentionGst: 0, retentionTotal: 0,
      net: 10000, payableGst: 1000, payableTotal: 11000,
    }))
  })

  it('ADR-93 — A NEGATIVE PER-LINE AMOUNT: REFUSED', async () => {
    await createRefused('dc6', (u) => invoicePayload(u, {
      lines: [line(12000), line(-2000, 'gst', { poLineIndex: 1 })],
    }))
  })

  it('ADR-93 — A BOGUS per-line costCodeId and an INVALID taxCode: REFUSED', async () => {
    await createRefused('dc7', (u) => invoicePayload(u, {
      lines: [line(10000, 'gst', { costCodeId: 'does-not-exist', taxCode: 'made_up' })],
    }))
  })

  it('ADR-93 — A per-line gstAmount that disagrees with its own amount and taxCode: REFUSED', async () => {
    const lines = [{ ...line(10000), gstAmount: 1000 }]
    const forged = [{ ...lines[0], gstAmount: 9999 }]
    await createRefused('dc8', (u) => ({
      ...invoicePayload(u, { lines }), lineItems: forged,
    }))
  })

  it('ADR-93 — A per-line poLineIndex pointing anywhere: REFUSED', async () => {
    await createRefused('dc9', (u) => invoicePayload(u, {
      lines: [line(10000, 'gst', { poLineIndex: 99 })],
    }))
  })

  it('ADR-93 — CREATOR == APPROVER == POSTER: create, approve and post by one user are each REFUSED for every financial role', async () => {
    await createRefused('dc10', invoicePayload, { storeAs: USERS.qs })
    await updateRefused('dc10', (u) => approveWrite(u), { storeAs: USERS.qs })
    await updateRefused('dc10', (u) => postWrite(u))
  })

  it('ADR-93 — AN IMPOSSIBLE-BUT-WELL-SHAPED DATE: REFUSED', async () => {
    await createRefused('dc11', (u) => invoicePayload(u, {
      invoiceDate: '2026-02-30', dueDate: '2026-13-45',
    }))
  })

  it('ADR-93 — A FUTURE-DATED invoice: REFUSED', async () => {
    await createRefused('dc12', (u) => invoicePayload(u, {
      invoiceDate: '2099-01-01',
    }))
  })

  it('ADR-93 — CONCURRENT draft editors: both edits REFUSED; the draft does not move', async () => {
    await seed('dc13', 'draft')
    await updateRefused('dc13', (u) => lineEdit(u, { lines: [line(1000)] }))
    await updateRefused('dc13', (u) => lineEdit(u, { lines: [line(2000)] }))
  })

  it('ADR-93 — attachments and externalRefs on a direct_po draft: REFUSED', async () => {
    await seed('dc14', 'draft')
    await updateRefused('dc14', (u) => lineEdit(u, {
      attachments: ['anything'], externalRefs: { xero: 'INV-1' },
    }))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// M3-B2 (ADR-63) — variation-origin invoice lines and the `variationLineCount`
// guard: a claim that carries variation lines can be invoiced only by a client
// that declares the count (the pre-M3-B2 bundle never does), the count is
// bounded by the claim's and frozen, a direct PO invoice carries none, and the
// last line's shape must match the count.
// ═════════════════════════════════════════════════════════════════════════════

const CLAIM_VAR = 'claim_var'
const varInvLine = (amount) => line(amount, 'gst', { poLineIndex: null, variationId: 'svScoped', variationNumber: 'SV-0007', variationLineIndex: 0, description: 'New scope' })
async function seedVariationClaim() {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const now = Timestamp.now()
    await setDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects/${PROJECT_A}/progressClaims`, CLAIM_VAR), {
      claimNumber: 'PC-0007', status: 'approved', poId: PO_SENT, poNumber: 'PO-0001', supplierName: 'BuildCo Pty Ltd', supplierId: 'contact1',
      claimRef: '', periodEnding: '', variationId: null, variationLineCount: 1,
      lineItems: [
        { poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', poLineTotal: 10000, previouslyApproved: 0, claimedToDate: 0, claimedThisPeriod: 0, approvedThisPeriod: 0 },
        { poLineIndex: null, variationId: 'svScoped', variationNumber: 'SV-0007', variationLineIndex: 0, variationLineTotal: 4000, poLineTotal: null, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'New scope', previouslyApproved: 0, claimedToDate: 2000, claimedThisPeriod: 2000, approvedThisPeriod: 2000 },
      ],
      retention: 0, claimedSubtotal: 2000, claimedGst: 200, claimedTotal: 2200, approvedSubtotal: 2000, approvedGst: 200, approvedTotal: 2200,
      notes: '', assessmentNotes: '', currency: 'AUD', revision: 2,
      submittedAt: now, submittedBy: 'u_admin', approvedAt: now, approvedBy: 'u_admin', rejectedAt: null, rejectedBy: null, invoicedAt: null,
      supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null,   // ADR-68: new-format, unlinked
      externalRefs: {}, createdAt: now, createdBy: 'u_admin', updatedAt: now, updatedBy: 'u_admin',
    })
  })
}
const varPaired = (user, id, over = {}) => pairedCreate(user, id, fromVarClaim(user, over), { revision: 3 })
const fromVarClaim = (user, over = {}) => invoicePayload(user, { source: 'progress_claim', progressClaimId: CLAIM_VAR, claimNumber: 'PC-0007', lines: [varInvLine(2000)], variationLineCount: 1, ...over })

describe('ADR-63 — the claim-sourced variationLineCount guard', () => {
  it('ADR-93 — the NEW bundle\'s invoice from a claim with a variation line (count 1 and the variation-origin line) is REFUSED for every financial role; nothing stored, the claim unlinked', async () => {
    await seedVariationClaim()
    await pairedRefused('nv', (u) => fromVarClaim(u), { claimId: CLAIM_VAR, revision: 3 })
    expect((await readClaimDoc(CLAIM_VAR)).supplierInvoiceId).toBeNull()
  })

  it('the OLD bundle’s payload against that claim — no count key, the line attributed to PO line 0 — is REFUSED, so a posted invoice can never carry the new-scope work onto PO line 0', async () => {
    await seedVariationClaim()
    const old = fromVarClaim(USERS.qs, { lines: [line(2000)] })
    delete old.variationLineCount
    await assertFails(pairedCreate(USERS.qs, 'old', old, { revision: 3 }))
    // Even with the right line shape, the count must be declared.
    const noCount = fromVarClaim(USERS.qs)
    delete noCount.variationLineCount
    await assertFails(pairedCreate(USERS.qs, 'old2', noCount, { revision: 3 }))
  })

  it('the count is bounded by the claim’s and must match the last line’s shape: above the claim, negative, non-integer, or a mismatched last line is refused; ADR-93 — 0 with no variation line stored is REFUSED too', async () => {
    await seedVariationClaim()
    await assertFails(varPaired(USERS.qs, 'b1', { variationLineCount: 2 }))
    await assertFails(varPaired(USERS.qs, 'b2', { variationLineCount: -1 }))
    await assertFails(varPaired(USERS.qs, 'b3', { variationLineCount: 1.5 }))
    await assertFails(varPaired(USERS.qs, 'b4', { variationLineCount: 1, lines: [line(2000)] }))
    await assertFails(varPaired(USERS.qs, 'b5', { variationLineCount: 1, lines: [line(2000, 'gst', { poLineIndex: 0, variationId: 'svScoped', variationLineIndex: 0 })] }))
    await assertFails(varPaired(USERS.qs, 'b6', { variationLineCount: 0, lines: [varInvLine(2000)] }))
    // The variation line was certified at zero and is not stored: count 0, PO lines only → ADR-93: REFUSED.
    await pairedRefused('b7', (u) => fromVarClaim(u, { variationLineCount: 0, lines: [line(10)] }), { claimId: CLAIM_VAR, revision: 3 })
  })

  it('a claim WITHOUT variation lines: ADR-93 — an absent key (old bundle) and 0 (new bundle) are REFUSED for every financial role; a positive count is refused', async () => {
    const absent = (u) => {
      const d = invoicePayload(u, { source: 'progress_claim' })
      delete d.variationLineCount
      return d
    }
    await pairedRefused('c1', absent)
    await unlinkClaim()
    await pairedRefused('c2', (u) => invoicePayload(u, { source: 'progress_claim', variationLineCount: 0 }))
    await unlinkClaim()
    await assertFails(pairedCreate(USERS.qs, 'c3', invoicePayload(USERS.qs, { source: 'progress_claim', variationLineCount: 1, lines: [varInvLine(2000)] })))
  })

  it('a direct PO invoice carries no variation line: ADR-93 — count 0 or absent is REFUSED for every financial role; count 1 (with or without a variation-shaped line) is refused', async () => {
    const db = ctx(USERS.qs)
    await createRefused('d1', (u) => {
      const d = invoicePayload(u)
      delete d.variationLineCount
      return d
    })
    await createRefused('d2', (u) => invoicePayload(u, { variationLineCount: 0 }))
    await assertFails(setDoc(invRef(db, 'd3'), invoicePayload(USERS.qs, { variationLineCount: 1, lines: [varInvLine(2000)] })))
    await assertFails(setDoc(invRef(db, 'd4'), invoicePayload(USERS.qs, { variationLineCount: 1 })))
    await assertFails(setDoc(invRef(db, 'd5'), invoicePayload(USERS.qs, { variationLineCount: 0, lines: [varInvLine(2000)] })))
  })

  it('variationLineCount is frozen for the invoice’s life (header edit, line edit, approve, post); ADR-93 — the well-formed header edit, approve and post are REFUSED for every financial role', async () => {
    await seedVariationClaim()
    await seed('f1', 'draft', USERS.admin, { source: 'progress_claim', progressClaimId: CLAIM_VAR, claimNumber: 'PC-0007', variationLineCount: 1, lineItems: [varInvLine(2000)] })
    const db = ctx(USERS.qs)
    await assertFails(updateDoc(invRef(db, 'f1'), headerEdit(USERS.qs, { variationLineCount: 0 })))
    await assertFails(updateDoc(invRef(db, 'f1'), headerEdit(USERS.qs, { variationLineCount: 2 })))
    await updateRefused('f1', (u) => headerEdit(u), { storeAs: USERS.qs })
    await assertFails(updateDoc(invRef(db, 'f1'), approveWrite(USERS.qs, { variationLineCount: 0 })))
    await updateRefused('f1', (u) => approveWrite(u), { storeAs: USERS.qs })
    await updateRefused('f1', (u) => postWrite(u))
    await seed('f2', 'draft')
    await assertFails(updateDoc(invRef(db, 'f2'), lineEdit(USERS.qs, { variationLineCount: 1 })))
  })

  it('formerly NOT enforced (DC40) — ADR-93: a count of 1 with a variation line naming a DIFFERENT variation, or a different amount, is REFUSED for every financial role (the backend compares the lines)', async () => {
    await seedVariationClaim()
    await pairedRefused('n1', (u) => fromVarClaim(u, { lines: [line(9000, 'gst', { poLineIndex: null, variationId: 'svElsewhere', variationLineIndex: 4 })] }), { claimId: CLAIM_VAR, revision: 3 })
  })
})

// ── ADR-93 — the supplierInvoices number counter is backend-only ─────────────

describe('ADR-93 — the supplierInvoices number counter', () => {
  const counter = (db, id) => doc(db, `companies/${COMPANY_A}/counters`, id)
  const readCounter = async (id) => {
    let data
    await testEnv.withSecurityRulesDisabled(async (c) => { const s = await getDoc(counter(c.firestore(), id)); data = s.exists() ? s.data() : undefined })
    return data
  }

  it('every financial role is REFUSED a read, a create, an advance and the old numbering transaction; the stored value does not move', async () => {
    for (const user of FINANCIAL) await assertFails(setDoc(counter(ctx(user), 'supplierInvoices'), { next: 2 }, { merge: true }))
    expect(await readCounter('supplierInvoices')).toBeUndefined()
    await testEnv.withSecurityRulesDisabled(async (c) => { await setDoc(counter(c.firestore(), 'supplierInvoices'), { next: 7 }) })
    for (const user of FINANCIAL) {
      const db = ctx(user)
      await assertFails(getDoc(counter(db, 'supplierInvoices')))
      await assertFails(updateDoc(counter(db, 'supplierInvoices'), { next: 8 }))
      await assertFails(setDoc(counter(db, 'supplierInvoices'), { next: 1 }, { merge: true }))
      await assertFails(runTransaction(db, async (tx) => {
        const snap = await tx.get(counter(db, 'supplierInvoices'))
        tx.set(counter(db, 'supplierInvoices'), { next: (snap.exists() ? snap.data().next : 1) + 1 }, { merge: true })
      }))
    }
    expect(await readCounter('supplierInvoices')).toEqual({ next: 7 })
  })

  it('another register\'s counter (purchaseOrders) still reads and advances for every financial role', async () => {
    for (const user of FINANCIAL) {
      await assertSucceeds(setDoc(counter(ctx(user), 'purchaseOrders'), { next: 2 }, { merge: true }))
      await assertSucceeds(getDoc(counter(ctx(user), 'purchaseOrders')))
    }
  })
})
