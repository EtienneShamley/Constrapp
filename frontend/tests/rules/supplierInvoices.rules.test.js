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
import { invoiceTotals, gstForLine } from '../../src/lib/supplierInvoices'
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
// can rules sum sibling documents, so duplicate supplier references, two
// invoices against one approved claim, and cumulative over-invoicing against a
// PO all remain possible. The final describe block proves each of those, so the
// suite documents the security CEILING as explicitly as the floor.
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set, so it
// can never reach a production Firebase project. The npm script starts the
// emulator via `firebase emulators:exec`, which sets that variable.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
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

// Client-supplied clock values that must NEVER satisfy `== request.time`.
// Deliberately skewed rather than `Timestamp.now()` — see the note in
// supplierPayments.rules.test.js (docs/TESTING.md §0).
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

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

    const claim = (companyId, projectId, id, status) =>
      setDoc(doc(db, `companies/${companyId}/projects/${projectId}/progressClaims`, id), {
        claimNumber: 'PC-0001', status, poId: PO_SENT,
        approvedGst: 900, approvedTotal: 9900, retention: 1000,
      })
    await claim(COMPANY_A, PROJECT_A, CLAIM_APPROVED, 'approved')
    await claim(COMPANY_A, PROJECT_A, CLAIM_SUBMITTED, 'submitted')
    await claim(COMPANY_A, PROJECT_A, CLAIM_DRAFT, 'draft')
    await claim(COMPANY_B, PROJECT_A, CLAIM_APPROVED, 'approved')
  })
})

// ── Roles, membership & tenant isolation ─────────────────────────────────────

describe('roles, membership and tenant isolation', () => {
  it('every financial role can create a draft invoice', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(setDoc(invRef(ctx(user), `create-${user.uid}`), invoicePayload(user)))
    }
  })

  it('every financial role can read an invoice', async () => {
    await seed('read1')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(invRef(ctx(user), 'read1')))
    }
  })

  it('every financial role can approve, post and cancel', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await seed(`ap-${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(invRef(ctx(user), `ap-${user.uid}`), approveWrite(user)))
      await seed(`po-${user.uid}`, 'approved')
      await assertSucceeds(updateDoc(invRef(ctx(user), `po-${user.uid}`), postWrite(user)))
      await seed(`ca-${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(invRef(ctx(user), `ca-${user.uid}`), cancelWrite(user)))
    }
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

describe('valid create', () => {
  it('accepts a direct_po draft against a SENT purchase order', async () => {
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'c1'), invoicePayload(USERS.qs)))
  })

  it('accepts a direct_po draft against a CLOSED purchase order', async () => {
    await assertSucceeds(setDoc(
      invRef(ctx(USERS.qs), 'c2'), invoicePayload(USERS.qs, { poId: PO_CLOSED }),
    ))
  })

  it('accepts a progress_claim draft against an APPROVED claim, with retention', async () => {
    await assertSucceeds(setDoc(
      invRef(ctx(USERS.qs), 'c3'),
      invoicePayload(USERS.qs, { source: 'progress_claim', retention: 1000 }),
    ))
  })

  it('accepts a legacy pre-Contacts supplier — supplierId null', async () => {
    await assertSucceeds(setDoc(
      invRef(ctx(USERS.qs), 'c4'), invoicePayload(USERS.qs, { supplierId: null }),
    ))
  })

  it('accepts an empty supplierInvoiceNumber, receivedDate and dueDate', async () => {
    await assertSucceeds(setDoc(
      invRef(ctx(USERS.qs), 'c5'),
      invoicePayload(USERS.qs, { supplierInvoiceNumber: '', receivedDate: '', dueDate: '' }),
    ))
  })

  it('accepts a null paymentTerms snapshot', async () => {
    await assertSucceeds(setDoc(
      invRef(ctx(USERS.qs), 'c6'), invoicePayload(USERS.qs, { paymentTerms: null }),
    ))
  })

  it('accepts a mixed tax-code line set', async () => {
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'c7'), invoicePayload(USERS.qs, {
      lines: [line(5000, 'gst'), line(3000, 'gst_free'), line(2000, 'input_taxed')],
    })))
  })

  it('accepts a wholly GST-FREE invoice carrying retention — payableGst and payableTotal go NEGATIVE', async () => {
    // The deferred domain issue recorded in SECURITY.md → Deferred Control 29.
    // Rules deliberately apply NO `payableGst >= 0` / `payableTotal >= 0` floor,
    // because under the current financial model this document is app-reachable.
    const payload = invoicePayload(USERS.qs, {
      lines: [line(10000, 'gst_free')], retention: 10000,
    })
    expect(payload.gstTotal).toBe(0)
    expect(payload.payableGst).toBeLessThan(0)
    expect(payload.payableTotal).toBeLessThan(0)
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'c8'), payload))
  })

  it('accepts a gstTotal ABOVE 10% of subtotal — per-line roundings can exceed one rounding of the sum', async () => {
    // Two 0.05 lines each round to 0.01 GST, so gstTotal is 0.02 against a naive
    // ceiling of 0.01. Any `gstTotal <= 10% of subtotal` rule would reject this.
    const payload = invoicePayload(USERS.qs, { lines: [line(0.05), line(0.05)] })
    expect(payload.subtotal).toBe(0.1)
    expect(payload.gstTotal).toBe(0.02)
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'c9'), payload))
  })

  it('accepts retention exactly equal to the subtotal', async () => {
    await assertSucceeds(setDoc(
      invRef(ctx(USERS.qs), 'c10'), invoicePayload(USERS.qs, { retention: 10000 }),
    ))
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

  it('rejects a malformed receivedDate or dueDate while allowing empty strings', async () => {
    await assertFails(setDoc(
      invRef(ctx(USERS.qs), 'sh3a'), invoicePayload(USERS.qs, { receivedDate: '6 Aug' }),
    ))
    await assertFails(setDoc(
      invRef(ctx(USERS.qs), 'sh3b'), invoicePayload(USERS.qs, { dueDate: null }),
    ))
    await assertSucceeds(setDoc(
      invRef(ctx(USERS.qs), 'sh3c'), invoicePayload(USERS.qs, { receivedDate: '', dueDate: '' }),
    ))
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

  it('accepts the untouched retention-bearing payload', async () => {
    await assertSucceeds(setDoc(
      invRef(ctx(USERS.qs), 'a0'),
      invoicePayload(USERS.qs, { source: 'progress_claim', retention: 1000 }),
    ))
  })

  CASES.forEach(([label, over], idx) => {
    it(`rejects a document that breaks: ${label}`, async () => {
      await assertFails(setDoc(
        invRef(ctx(USERS.qs), `a${idx + 1}`),
        invoicePayload(USERS.qs, { source: 'progress_claim', retention: 1000, ...over }),
      ))
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
    it(`accepts retention ${retention.toFixed(2)} with its exact derived GST`, async () => {
      const payload = invoicePayload(USERS.qs, { retention })
      expect(payload.retentionGst).toBe(roundMoney(retention * 0.1))
      await assertSucceeds(setDoc(invRef(ctx(USERS.qs), `g${i}`), payload))
    })
  })

  it('rejects a retention GST one cent off the derived value', async () => {
    const payload = invoicePayload(USERS.qs, { retention: 100.05 })
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'g-bad'), {
      ...payload,
      retentionGst:   10.00,
      retentionTotal: 110.05,
      payableGst:     990.00,
      payableTotal:   10889.95,
    }))
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
      await assertFails(setDoc(invRef(ctx(USERS.qs), `t5-${claimId}`), invoicePayload(USERS.qs, {
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

  it('THE REFERENCES ARE NEVER REVALIDATED after create — a later PO status change cannot trap the invoice', async () => {
    // The ADR-34 rule: an UNCHANGED reference is never re-checked. poId is
    // core-preserved, so re-validating it on an edit or a transition could only
    // strand a legitimate invoice whose PO was later closed or cancelled.
    await seed('t8', 'draft')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects/${PROJECT_A}/purchaseOrders`, PO_SENT), { status: 'cancelled' })
    })
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 't8'), lineEdit(USERS.qs)))
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 't8'), approveWrite(USERS.qs)))
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 't8'), postWrite(USERS.qs)))
  })

  it('a claim-sourced invoice survives its claim changing status afterwards', async () => {
    await seed('t9', 'draft', USERS.admin, { source: 'progress_claim', retention: 1000 })
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects/${PROJECT_A}/progressClaims`, CLAIM_APPROVED), { status: 'rejected' })
    })
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 't9'), headerEdit(USERS.qs)))
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 't9'), approveWrite(USERS.qs)))
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

describe('legal lifecycle transitions', () => {
  it('draft -> approved with the exact hook payload', async () => {
    await seed('l1', 'draft')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'l1'), approveWrite(USERS.qs)))
  })

  it('approved -> posted with the exact hook payload', async () => {
    await seed('l2', 'approved')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'l2'), postWrite(USERS.qs)))
  })

  it('draft -> cancelled and approved -> cancelled', async () => {
    await seed('l3', 'draft')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'l3'), cancelWrite(USERS.qs)))
    await seed('l4', 'approved')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'l4'), cancelWrite(USERS.qs)))
  })

  it('the full draft -> approved -> posted walk on one document', async () => {
    const db = ctx(USERS.pm)
    await assertSucceeds(setDoc(invRef(db, 'l5'), invoicePayload(USERS.pm)))
    await assertSucceeds(updateDoc(invRef(db, 'l5'), approveWrite(USERS.pm)))
    await assertSucceeds(updateDoc(invRef(db, 'l5'), postWrite(USERS.pm)))
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

  it('leaves exactly two updates available from approved: post and cancel', async () => {
    await seed('z5', 'approved')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'z5'), postWrite(USERS.qs)))
    await seed('z6', 'approved')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'z6'), cancelWrite(USERS.qs)))
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

describe('draft edit — direct_po', () => {
  it('accepts the exact hook payload', async () => {
    await seed('e1', 'draft')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'e1'), lineEdit(USERS.qs)))
  })

  it('accepts re-authored retention within the subtotal', async () => {
    await seed('e2', 'draft')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'e2'), lineEdit(USERS.qs, { retention: 500 })))
  })

  it('accepts a header-only correction (line money unchanged)', async () => {
    await seed('e3', 'draft')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'e3'), headerEdit(USERS.qs)))
  })

  it('accepts a stored line taken to zero while ANOTHER line stays positive', async () => {
    await seed('e4', 'draft', USERS.admin, { lineItems: [line(6000), line(4000, 'gst', { poLineIndex: 1 })], subtotal: 10000, gstTotal: 1000, grossTotal: 11000, net: 10000, payableGst: 1000, payableTotal: 11000 })
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'e4'), lineEdit(USERS.qs, {
      lines: [line(6000), line(0, 'gst', { poLineIndex: 1 })],
    })))
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

  it('accepts the exact claim-sourced hook payload', async () => {
    await claimSeed('h1')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'h1'), headerEdit(USERS.qs)))
  })

  it('accepts a partial header correction', async () => {
    await claimSeed('h2')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'h2'), {
      supplierInvoiceNumber: 'INV-CORRECTED', ...stamps(USERS.qs),
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

  it('still allows approve, post and cancel on a claim-sourced invoice', async () => {
    await claimSeed('h9')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'h9'), approveWrite(USERS.qs)))
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'h9'), postWrite(USERS.qs)))
  })
})

// ── Legacy documents (raised before ADR-40) ──────────────────────────────────

describe('documents raised before ADR-40 stay writable', () => {
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

  it('a legacy direct_po draft can still be edited, and gains the audit fields', async () => {
    await seedLegacy('lg1')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'lg1'), lineEdit(USERS.qs)))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const snap = await getDoc(doc(c.firestore(), invoicesPath(), 'lg1'))
      expect(snap.data().updatedBy).toBe(USERS.qs.uid)
      expect(snap.data().updatedAt).toBeTruthy()
    })
  })

  it('a legacy claim-sourced draft can still take a header correction', async () => {
    await seedLegacy('lg2', 'draft', 'progress_claim')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'lg2'), headerEdit(USERS.qs)))
  })

  it('a legacy draft can still be approved, posted and cancelled', async () => {
    await seedLegacy('lg3')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'lg3'), approveWrite(USERS.qs)))
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'lg3'), postWrite(USERS.qs)))
    await seedLegacy('lg4')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'lg4'), cancelWrite(USERS.qs)))
  })

  it('a legacy POSTED invoice is still terminal', async () => {
    await seedLegacy('lg5', 'posted')
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'lg5'), cancelWrite(USERS.qs)))
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'lg5'), headerEdit(USERS.qs)))
  })
})

// ── Downstream regression — the collections that get() these documents ───────

describe('downstream collections still trust a hardened invoice', () => {
  // supplierCreditNotes and retentionReleases both get() a supplier invoice and
  // read status / supplierId / currency / retention / retentionTotal /
  // payableTotal. An invoice created and posted through the NEW rules must still
  // satisfy both target checks unchanged.
  async function createAndPost(id, opts = {}) {
    const db = ctx(USERS.qs)
    await assertSucceeds(setDoc(invRef(db, id), invoicePayload(USERS.qs, opts)))
    await assertSucceeds(updateDoc(invRef(db, id), approveWrite(USERS.qs)))
    await assertSucceeds(updateDoc(invRef(db, id), postWrite(USERS.qs)))
  }

  it('a Supplier Credit Note can target an invoice posted through the new rules', async () => {
    await createAndPost('dn1')   // zero retention — the credit-note precondition
    const db = ctx(USERS.qs)
    await assertSucceeds(setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/supplierCreditNotes`, 'cn1'), {
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
    }))
  })

  it('a Retention Release can target a retention-bearing invoice posted through the new rules', async () => {
    await createAndPost('dn2', { source: 'progress_claim', retention: 1000 })
    const money = releaseTotals(0, 400)
    const db = ctx(USERS.qs)
    await assertSucceeds(setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/retentionReleases`, 'rr1'), {
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
    }))
  })
})

// ── The security ceiling — deferred controls, proven UNENFORCED ──────────────

describe('DEFERRED CONTROLS — these gaps are real and must never be reported as enforced', () => {
  it('DUPLICATE supplier invoice references remain possible — rules cannot query siblings', async () => {
    const db = ctx(USERS.qs)
    await assertSucceeds(setDoc(invRef(db, 'dc1a'), invoicePayload(USERS.qs, { supplierInvoiceNumber: 'INV-DUP' })))
    await assertSucceeds(setDoc(invRef(db, 'dc1b'), invoicePayload(USERS.qs, { supplierInvoiceNumber: 'INV-DUP' })))
  })

  it('DUPLICATE SI-#### numbers remain possible — the counter is client-writable (DC 6)', async () => {
    const db = ctx(USERS.qs)
    await assertSucceeds(setDoc(invRef(db, 'dc2a'), invoicePayload(USERS.qs, { invoiceNumber: 'SI-0007' })))
    await assertSucceeds(setDoc(invRef(db, 'dc2b'), invoicePayload(USERS.qs, { invoiceNumber: 'SI-0007' })))
  })

  it('TWO invoices against ONE approved claim remain possible — no sibling aggregation (DC 3)', async () => {
    const db = ctx(USERS.qs)
    const claimInv = { source: 'progress_claim', retention: 1000 }
    await assertSucceeds(setDoc(invRef(db, 'dc3a'), invoicePayload(USERS.qs, claimInv)))
    await assertSucceeds(setDoc(invRef(db, 'dc3b'), invoicePayload(USERS.qs, claimInv)))
  })

  it('CUMULATIVE over-invoicing against a PO remains possible — rules cannot sum siblings', async () => {
    // The seeded PO totals 20,000 ex-GST; three 10,000 invoices all succeed.
    const db = ctx(USERS.qs)
    for (const id of ['dc4a', 'dc4b', 'dc4c']) {
      await assertSucceeds(setDoc(invRef(db, id), invoicePayload(USERS.qs)))
    }
  })

  it('HEADER TOTALS CONTRADICTING THEIR OWN LINES remain possible — rules cannot sum an array', async () => {
    // The lines say 10.00; the headers say 10,000.00. Internally consistent
    // headers, arbitrary lines: rules see only the scalars.
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'dc5'), invoicePayload(USERS.qs, {
      lines: [line(10)], subtotal: 10000, gstTotal: 1000, grossTotal: 11000,
      retention: 0, retentionGst: 0, retentionTotal: 0,
      net: 10000, payableGst: 1000, payableTotal: 11000,
    })))
  })

  it('A NEGATIVE PER-LINE AMOUNT remains possible — only the header scalars are checked', async () => {
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'dc6'), invoicePayload(USERS.qs, {
      lines: [line(12000), line(-2000, 'gst', { poLineIndex: 1 })],
    })))
  })

  it('A BOGUS per-line costCodeId and an INVALID taxCode remain possible', async () => {
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'dc7'), invoicePayload(USERS.qs, {
      lines: [line(10000, 'gst', { costCodeId: 'does-not-exist', taxCode: 'made_up' })],
    })))
  })

  it('A per-line gstAmount that disagrees with its own amount and taxCode remains possible', async () => {
    const lines = [{ ...line(10000), gstAmount: 1000 }]
    const forged = [{ ...lines[0], gstAmount: 9999 }]
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'dc8'), {
      ...invoicePayload(USERS.qs, { lines }), lineItems: forged,
    }))
  })

  it('A per-line poLineIndex pointing anywhere remains possible', async () => {
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'dc9'), invoicePayload(USERS.qs, {
      lines: [line(10000, 'gst', { poLineIndex: 99 })],
    })))
  })

  it('CREATOR == APPROVER == POSTER remains possible — no segregation of duties (DC 4)', async () => {
    const db = ctx(USERS.qs)
    await assertSucceeds(setDoc(invRef(db, 'dc10'), invoicePayload(USERS.qs)))
    await assertSucceeds(updateDoc(invRef(db, 'dc10'), approveWrite(USERS.qs)))
    await assertSucceeds(updateDoc(invRef(db, 'dc10'), postWrite(USERS.qs)))
  })

  it('AN IMPOSSIBLE-BUT-WELL-SHAPED DATE remains possible — rules have no calendar', async () => {
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'dc11'), invoicePayload(USERS.qs, {
      invoiceDate: '2026-02-30', dueDate: '2026-13-45',
    })))
  })

  it('A FUTURE-DATED invoice remains possible', async () => {
    await assertSucceeds(setDoc(invRef(ctx(USERS.qs), 'dc12'), invoicePayload(USERS.qs, {
      invoiceDate: '2099-01-01',
    })))
  })

  it('CONCURRENT draft editors remain last-write-wins', async () => {
    await seed('dc13', 'draft')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'dc13'), lineEdit(USERS.qs, { lines: [line(1000)] })))
    await assertSucceeds(updateDoc(invRef(ctx(USERS.pm), 'dc13'), lineEdit(USERS.pm, { lines: [line(2000)] })))
  })

  it('attachments and externalRefs stay freely writable while a direct_po invoice is draft', async () => {
    await seed('dc14', 'draft')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'dc14'), lineEdit(USERS.qs, {
      attachments: ['anything'], externalRefs: { xero: 'INV-1' },
    })))
  })
})
