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
import { releaseTotals, cumulativeRetentionGst } from '../../src/lib/retention'

// ── Retention Release Security Rules — emulator tests ────────────────────────
//
// Executes every case documented in docs/TESTING.md §15q against the Firestore
// emulator. These verify the RULES, not the UI: each write below is a direct SDK
// call, exactly what a client bypassing the app would issue.
//
// This block enforces MORE than the allocation blocks can. Payment allocations
// live in an array, which rules can neither iterate nor get() per element;
// `supplierInvoiceId` here is a SCALAR, so the target invoice IS read and the
// per-document cap and the exact GST formula ARE enforced.
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (Deferred Control 24):
// two sibling releases can each claim `previouslyReleasedAmount: 0`, each pass
// the per-document cap, and TOGETHER over-release the invoice. Rules have no
// list/query/count and cannot sum siblings. The normal UI hard-blocks this; the
// rules cannot.
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set, so it
// can never reach a production Firebase project.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}

// Target supplier invoices seeded before each test.
const SI_POSTED    = 'si_posted'    // retention 1000.00, retentionGst 100.00
const SI_DRIFT     = 'si_drift'     // retention  100.05, retentionGst  10.01  (half-cent)
const SI_DRAFT     = 'si_draft'     // not posted — retention cannot be released
const SI_CANCELLED = 'si_cancelled' // cancelled — retention cannot be released

let testEnv

const releasesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/retentionReleases`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const relRef = (db, id, companyId = COMPANY_A) => doc(db, releasesPath(companyId), id)

// A supplier invoice exactly as hooks/useSupplierInvoices.jsx writes it — only
// the fields the rules read matter here.
const invoiceDoc = (overrides = {}) => ({
  invoiceNumber: 'SI-0001',
  supplierInvoiceNumber: 'INV-4471',
  status: 'posted',
  docType: 'invoice',
  supplierId: 'c_supplier',
  supplierName: 'Bloggs Concreting Pty Ltd',
  subtotal: 10000, gstTotal: 1000, grossTotal: 11000,
  retention: 1000, retentionGst: 100, retentionTotal: 1100,
  net: 9000, payableGst: 900, payableTotal: 9900,
  currency: 'AUD', revision: 1,
  ...overrides,
})

// A valid DRAFT release payload, exactly as hooks/useRetentionReleases.jsx
// writes it. Money defaults to a clean first release of 400.00 ex-GST.
function releasePayload(user, overrides = {}) {
  const money = releaseTotals(
    overrides.previouslyReleasedAmount ?? 0,
    overrides.amount ?? 400,
  )
  return {
    releaseNumber: 'RR-0001',
    status:        'draft',
    docType:       'retention_release',

    supplierInvoiceId:     SI_POSTED,
    invoiceNumber:         'SI-0001',
    supplierInvoiceNumber: 'INV-4471',

    supplierId:   'c_supplier',
    supplierName: 'Bloggs Concreting Pty Ltd',

    previouslyReleasedAmount: money.previouslyReleasedAmount,
    amount:                   money.amount,
    gstAmount:                money.gstAmount,
    releaseTotal:             money.releaseTotal,

    releaseDate: '2026-08-13',
    reason:      'Practical completion reached — first half of retention released',
    notes:       '',

    currency: 'AUD',
    revision: 1,

    postedAt:   null,
    postedBy:   null,
    voidedAt:   null,
    voidedBy:   null,
    voidReason: '',

    externalRefs: {},

    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

// Seeds a release directly, bypassing rules — the arrange step for update tests.
async function seed(id, status, user = USERS.admin, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const base = releasePayload(user)
    const lifecycle =
      status === 'void'
        ? { status: 'void', voidedAt: Timestamp.now(), voidedBy: user.uid, voidReason: 'Released in error' }
        : status === 'posted'
          ? { status: 'posted', postedAt: Timestamp.now(), postedBy: user.uid }
          : { status: 'draft' }
    await setDoc(doc(db, releasesPath(), id), {
      ...base,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...lifecycle,
      ...extra,
    })
  })
}

// The write shapes the app performs, so tests exercise the real payloads.
const draftEdit = (user, extra = {}) => ({
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const postWrite = (user, extra = {}) => ({
  status: 'posted',
  postedAt: serverTimestamp(), postedBy: user.uid,
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const voidWrite = (user, reason = 'Released in error', extra = {}) => ({
  status: 'void',
  voidedAt: serverTimestamp(), voidedBy: user.uid, voidReason: reason,
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
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
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })

    const inv = (id, overrides) =>
      setDoc(doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/supplierInvoices`, id), invoiceDoc(overrides))
    await inv(SI_POSTED, {})
    await inv(SI_DRIFT, { invoiceNumber: 'SI-0002', retention: 100.05, retentionGst: 10.01, retentionTotal: 110.06 })
    await inv(SI_DRAFT, { invoiceNumber: 'SI-0003', status: 'draft' })
    await inv(SI_CANCELLED, { invoiceNumber: 'SI-0004', status: 'cancelled' })
    // Company B needs a posted invoice too, so a cross-tenant test fails on the
    // MEMBERSHIP rule rather than incidentally on a missing target.
    await setDoc(
      doc(db, `companies/${COMPANY_B}/projects/${PROJECT_A}/supplierInvoices`, SI_POSTED),
      invoiceDoc(),
    )
  })
})

// ── Roles & tenant isolation ─────────────────────────────────────────────────

describe('roles and tenant isolation', () => {
  it('every financial role can create a draft release', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(setDoc(relRef(ctx(user), `create-${user.uid}`), releasePayload(user)))
    }
  })

  it('every financial role can read a release', async () => {
    await seed('read1', 'draft')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(relRef(ctx(user), 'read1')))
    }
  })

  it('every financial role can post and void', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await seed(`post-${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(relRef(ctx(user), `post-${user.uid}`), postWrite(user)))
      await seed(`void-${user.uid}`, 'posted')
      await assertSucceeds(updateDoc(relRef(ctx(user), `void-${user.uid}`), voidWrite(user)))
    }
  })

  it('subcontractor and client can neither read nor write', async () => {
    await seed('deny1', 'draft')
    for (const user of [USERS.sub, USERS.client]) {
      await assertFails(getDoc(relRef(ctx(user), 'deny1')))
      await assertFails(setDoc(relRef(ctx(user), `deny-${user.uid}`), releasePayload(user)))
    }
  })

  it('an unauthenticated caller can neither read nor write', async () => {
    await seed('deny2', 'draft')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(relRef(db, 'deny2')))
    await assertFails(setDoc(relRef(db, 'deny3'), releasePayload(USERS.admin)))
  })

  it('a user from another company cannot read or write this company releases', async () => {
    await seed('deny4', 'posted')
    await assertFails(getDoc(relRef(ctx(USERS.other), 'deny4')))
    await assertFails(setDoc(relRef(ctx(USERS.other), 'deny5'), releasePayload(USERS.other)))
  })
})

// ── Target supplier invoice ──────────────────────────────────────────────────

describe('the target supplier invoice is verified server-side', () => {
  it('accepts a release against a POSTED invoice', async () => {
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'ok'), releasePayload(USERS.admin)))
  })

  it('rejects a release against a MISSING invoice', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'missing'),
      releasePayload(USERS.admin, { supplierInvoiceId: 'si_does_not_exist' })))
  })

  it('rejects a release against a DRAFT invoice', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'draftinv'),
      releasePayload(USERS.admin, { supplierInvoiceId: SI_DRAFT })))
  })

  it('rejects a release against a CANCELLED invoice', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'cancelledinv'),
      releasePayload(USERS.admin, { supplierInvoiceId: SI_CANCELLED })))
  })

  it('rejects an empty or non-string supplierInvoiceId', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'blank'),
      releasePayload(USERS.admin, { supplierInvoiceId: '' })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'nullid'),
      releasePayload(USERS.admin, { supplierInvoiceId: null })))
  })

  it('cannot re-point a draft release at a different invoice', async () => {
    await seed('repoint', 'draft')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'repoint'),
      draftEdit(USERS.admin, { supplierInvoiceId: SI_DRIFT })))
  })
})

// ── Per-document cap ─────────────────────────────────────────────────────────

describe('the per-document retention cap is enforced', () => {
  it('accepts a release exactly equal to the full retention', async () => {
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'full'),
      releasePayload(USERS.admin, { amount: 1000 })))
  })

  it('rejects a release of one cent more than the full retention', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'over'),
      releasePayload(USERS.admin, { amount: 1000.01 })))
  })

  it('accepts a second release whose cumulative total exactly reaches retention', async () => {
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'second'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 400, amount: 600 })))
  })

  it('rejects a second release whose cumulative total exceeds retention', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'second-over'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 400, amount: 600.01 })))
  })

  it('rejects a zero or negative amount', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'zero'),
      releasePayload(USERS.admin, { amount: 0, gstAmount: 0, releaseTotal: 0 })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'neg'),
      releasePayload(USERS.admin, { amount: -100, gstAmount: -10, releaseTotal: -110 })))
  })

  it('rejects a negative previouslyReleasedAmount', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'negprev'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: -100, amount: 400, gstAmount: 40, releaseTotal: 440 })))
  })
})

// ── GST formula ──────────────────────────────────────────────────────────────

describe('the exact cumulative GST formula is enforced', () => {
  it('accepts the correct first-release GST', async () => {
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'gst-ok'),
      releasePayload(USERS.admin, { amount: 400 })))
  })

  it('rejects gstAmount one cent HIGH', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'gst-high'),
      releasePayload(USERS.admin, { amount: 400, gstAmount: 40.01, releaseTotal: 440.01 })))
  })

  it('rejects gstAmount one cent LOW', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'gst-low'),
      releasePayload(USERS.admin, { amount: 400, gstAmount: 39.99, releaseTotal: 439.99 })))
  })

  it('rejects an ARBITRARY gstAmount even when releaseTotal adds up correctly', async () => {
    // The decisive case: releaseTotal == amount + gstAmount is satisfied, and it
    // is still rejected, because gstAmount is pinned to the cumulative delta.
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'gst-arbitrary'),
      releasePayload(USERS.admin, { amount: 400, gstAmount: 900, releaseTotal: 1300 })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'gst-zero'),
      releasePayload(USERS.admin, { amount: 400, gstAmount: 0, releaseTotal: 400 })))
  })

  it('rejects a releaseTotal that does not reconcile to amount + gstAmount', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'total-bad'),
      releasePayload(USERS.admin, { amount: 400, gstAmount: 40, releaseTotal: 441 })))
  })

  it('accepts the mid-sequence cumulative delta', async () => {
    // prev 333.33 → 666.66: the delta is NOT roundMoney(333.33 × 10%).
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'gst-mid'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 333.33, amount: 333.33 })))
  })
})

// ── math.round parity between Firestore Rules and JavaScript ─────────────────
//
// ⚠️ LOAD-BEARING. lib/retention.js computes GST with JS Math.round (via
// roundMoney) and the rules re-derive it with math.round. If the two disagreed
// on a .5 boundary, a legitimate client write would be rejected in production
// while every unit test passed. These cases put a .5 on BOTH sides of the
// subtraction and are the reason the client helper may never be "simplified".

describe('Firestore Rules math.round matches JavaScript on half-cent boundaries', () => {
  it('accepts a first release whose cumulative GST lands exactly on a half cent', async () => {
    // retention 100.05 → 100.05 × 10% = 10.005 → 1000.5 cents.
    expect(cumulativeRetentionGst(100.05)).toBe(10.01)
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'half-1'),
      releasePayload(USERS.admin, {
        supplierInvoiceId: SI_DRIFT, invoiceNumber: 'SI-0002',
        previouslyReleasedAmount: 0, amount: 100.05,
      })))
  })

  it('accepts a partial release with a half cent on BOTH cumulative endpoints', async () => {
    // prev 50.05 → 500.5 cents of GST; next 100.05 → 1000.5 cents of GST.
    expect(cumulativeRetentionGst(50.05)).toBe(5.01)
    expect(releaseTotals(50.05, 50).gstAmount).toBe(5)
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'half-2'),
      releasePayload(USERS.admin, {
        supplierInvoiceId: SI_DRIFT, invoiceNumber: 'SI-0002',
        previouslyReleasedAmount: 50.05, amount: 50,
      })))
  })

  it('accepts the FINAL rounding remainder a naive per-release rule would reject', async () => {
    // Two releases of 50.025 are impossible (sub-cent), so use the real drift
    // case: 33.35 + 33.35 + 33.35 = 100.05. The last release must carry the
    // remainder, which is NOT roundMoney(33.35 × 10%) = 3.34 but 3.33.
    const r1 = releaseTotals(0, 33.35)
    const r2 = releaseTotals(33.35, 33.35)
    const r3 = releaseTotals(66.70, 33.35)
    expect(r1.gstAmount + r2.gstAmount + r3.gstAmount).toBeCloseTo(10.01, 10)
    for (const [i, r] of [r1, r2, r3].entries()) {
      await assertSucceeds(setDoc(relRef(ctx(USERS.admin), `remainder-${i}`),
        releasePayload(USERS.admin, {
          supplierInvoiceId: SI_DRIFT, invoiceNumber: 'SI-0002',
          previouslyReleasedAmount: r.previouslyReleasedAmount, amount: r.amount,
        })))
    }
  })

  it('still rejects a one-cent deviation on the half-cent invoice', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'half-bad'),
      releasePayload(USERS.admin, {
        supplierInvoiceId: SI_DRIFT, invoiceNumber: 'SI-0002',
        previouslyReleasedAmount: 0, amount: 100.05, gstAmount: 10.00, releaseTotal: 110.05,
      })))
  })
})

// ── Create-time shape & stamps ───────────────────────────────────────────────

describe('create requires a valid draft with authentic stamps', () => {
  it('rejects creation in any status but draft', async () => {
    for (const status of ['posted', 'void', 'active', 'paid']) {
      await assertFails(setDoc(relRef(ctx(USERS.admin), `status-${status}`),
        releasePayload(USERS.admin, { status })))
    }
  })

  it('rejects a wrong docType', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'doctype'),
      releasePayload(USERS.admin, { docType: 'invoice' })))
  })

  it('rejects forged lifecycle stamps at creation', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'forge-post'),
      releasePayload(USERS.admin, { postedAt: Timestamp.now(), postedBy: USERS.admin.uid })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'forge-void'),
      releasePayload(USERS.admin, { voidedAt: Timestamp.now(), voidedBy: USERS.admin.uid })))
  })

  it('rejects a createdBy that is not the caller', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'notme'),
      releasePayload(USERS.admin, { createdBy: USERS.pm.uid })))
  })

  it('rejects a client-supplied createdAt/updatedAt', async () => {
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(relRef(ctx(USERS.admin), 'clock-created'),
        releasePayload(USERS.admin, { createdAt: clock() })))
      await assertFails(setDoc(relRef(ctx(USERS.admin), 'clock-updated'),
        releasePayload(USERS.admin, { updatedAt: clock() })))
    }
  })

  it('rejects a malformed currency or releaseDate', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'cur'),
      releasePayload(USERS.admin, { currency: 'aud' })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'date1'),
      releasePayload(USERS.admin, { releaseDate: '13/08/2026' })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'date2'),
      releasePayload(USERS.admin, { releaseDate: '' })))
  })

  it('rejects a blank or whitespace-only reason', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'reason1'),
      releasePayload(USERS.admin, { reason: '' })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'reason2'),
      releasePayload(USERS.admin, { reason: '   ' })))
  })

  it('rejects a missing supplierName but ACCEPTS a legacy null supplierId', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'noname'),
      releasePayload(USERS.admin, { supplierName: '' })))
    // Pre-Contacts invoices carry supplierId: null and are never backfilled.
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'legacy'),
      releasePayload(USERS.admin, { supplierId: null })))
  })
})

// ── Draft edits ──────────────────────────────────────────────────────────────

describe('draft edits', () => {
  it('allow the money, date, reason and notes to change', async () => {
    await seed('edit1', 'draft')
    const money = releaseTotals(0, 250)
    await assertSucceeds(updateDoc(relRef(ctx(USERS.admin), 'edit1'), draftEdit(USERS.admin, {
      amount: money.amount, gstAmount: money.gstAmount, releaseTotal: money.releaseTotal,
      releaseDate: '2026-09-01', reason: 'Revised — half of first moiety', notes: 'Agreed on site',
    })))
  })

  it('re-saving refreshes a stale cumulative snapshot', async () => {
    await seed('edit2', 'draft')
    const money = releaseTotals(400, 300)
    await assertSucceeds(updateDoc(relRef(ctx(USERS.admin), 'edit2'), draftEdit(USERS.admin, {
      previouslyReleasedAmount: money.previouslyReleasedAmount,
      amount: money.amount, gstAmount: money.gstAmount, releaseTotal: money.releaseTotal,
    })))
  })

  it('reject a status move disguised as an edit', async () => {
    await seed('edit3', 'draft')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'edit3'),
      draftEdit(USERS.admin, { status: 'posted' })))
  })

  it('reject forged lifecycle stamps', async () => {
    await seed('edit4', 'draft')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'edit4'),
      draftEdit(USERS.admin, { postedAt: Timestamp.now(), postedBy: USERS.admin.uid })))
  })

  it('reject rewriting the document identity', async () => {
    await seed('edit5', 'draft')
    for (const patch of [
      { releaseNumber: 'RR-9999' },
      { currency: 'NZD' },
      { revision: 2 },
      { docType: 'invoice' },
      { createdBy: USERS.pm.uid },
      { createdAt: Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')) },
    ]) {
      await assertFails(updateDoc(relRef(ctx(USERS.admin), 'edit5'), draftEdit(USERS.admin, patch)))
    }
  })

  it('reject an edit that breaks the cap or the GST formula', async () => {
    await seed('edit6', 'draft')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'edit6'),
      draftEdit(USERS.admin, { amount: 1000.01, gstAmount: 100.001, releaseTotal: 1100.011 })))
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'edit6'),
      draftEdit(USERS.admin, { amount: 400, gstAmount: 80, releaseTotal: 480 })))
  })

  it('reject an unstamped edit', async () => {
    await seed('edit7', 'draft')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'edit7'), { reason: 'No stamps' }))
  })
})

// ── Posting ──────────────────────────────────────────────────────────────────

describe('posting', () => {
  it('accepts a status-only post with authentic stamps', async () => {
    await seed('post1', 'draft')
    await assertSucceeds(updateDoc(relRef(ctx(USERS.admin), 'post1'), postWrite(USERS.admin)))
  })

  it('rejects a post that also changes content', async () => {
    await seed('post2', 'draft')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'post2'),
      postWrite(USERS.admin, { amount: 999, gstAmount: 99.9, releaseTotal: 1098.9 })))
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'post2'),
      postWrite(USERS.admin, { reason: 'Changed while posting' })))
  })

  it('rejects a forged postedBy or postedAt', async () => {
    await seed('post3', 'draft')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'post3'),
      postWrite(USERS.admin, { postedBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(relRef(ctx(USERS.admin), 'post3'),
        postWrite(USERS.admin, { postedAt: clock() })))
    }
  })

  it('rejects posting a release whose target invoice was cancelled', async () => {
    await seed('post4', 'draft', USERS.admin, { supplierInvoiceId: SI_CANCELLED })
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'post4'), postWrite(USERS.admin)))
  })

  it('rejects re-posting an already posted release', async () => {
    await seed('post5', 'posted')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'post5'), postWrite(USERS.admin)))
  })

  it('rejects posting a void release', async () => {
    await seed('post6', 'void')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'post6'), postWrite(USERS.admin)))
  })
})

// ── Posted immutability ──────────────────────────────────────────────────────

describe('a posted release is immutable except for voiding', () => {
  it('rejects every content edit', async () => {
    await seed('imm1', 'posted')
    for (const patch of [
      { amount: 500 }, { gstAmount: 50 }, { releaseTotal: 550 },
      { previouslyReleasedAmount: 100 }, { releaseDate: '2027-01-01' },
      { reason: 'Rewritten after posting' }, { notes: 'Sneaky' },
    ]) {
      await assertFails(updateDoc(relRef(ctx(USERS.admin), 'imm1'), draftEdit(USERS.admin, patch)))
    }
  })

  it('rejects a return to draft', async () => {
    await seed('imm2', 'posted')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'imm2'),
      draftEdit(USERS.admin, { status: 'draft' })))
  })

  it('permits voiding', async () => {
    await seed('imm3', 'posted')
    await assertSucceeds(updateDoc(relRef(ctx(USERS.admin), 'imm3'), voidWrite(USERS.admin)))
  })
})

// ── Voiding ──────────────────────────────────────────────────────────────────

describe('voiding', () => {
  it('accepts a void from draft and from posted', async () => {
    await seed('void1', 'draft')
    await assertSucceeds(updateDoc(relRef(ctx(USERS.admin), 'void1'), voidWrite(USERS.admin)))
    await seed('void2', 'posted')
    await assertSucceeds(updateDoc(relRef(ctx(USERS.admin), 'void2'), voidWrite(USERS.admin)))
  })

  it('requires a non-whitespace reason', async () => {
    await seed('void3', 'posted')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'void3'), voidWrite(USERS.admin, '')))
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'void3'), voidWrite(USERS.admin, '   ')))
  })

  it('rejects a void that also changes content', async () => {
    await seed('void4', 'posted')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'void4'),
      voidWrite(USERS.admin, 'Released in error', { amount: 1 })))
  })

  it('rejects forged void stamps', async () => {
    await seed('void5', 'posted')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'void5'),
      voidWrite(USERS.admin, 'Released in error', { voidedBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(relRef(ctx(USERS.admin), 'void5'),
        voidWrite(USERS.admin, 'Released in error', { voidedAt: clock() })))
    }
  })

  it('is TERMINAL — a void release can never change again', async () => {
    await seed('void6', 'void')
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'void6'), postWrite(USERS.admin)))
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'void6'), voidWrite(USERS.admin)))
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'void6'),
      draftEdit(USERS.admin, { status: 'draft' })))
    await assertFails(updateDoc(relRef(ctx(USERS.admin), 'void6'),
      draftEdit(USERS.admin, { reason: 'Rewritten' })))
  })

  it('remains possible even when the target invoice was cancelled afterwards', async () => {
    // The release that most needs withdrawing must never be trapped by a rule
    // that re-verifies the target — this is why the void branch omits it.
    await seed('void7', 'posted', USERS.admin, { supplierInvoiceId: SI_CANCELLED })
    await assertSucceeds(updateDoc(relRef(ctx(USERS.admin), 'void7'), voidWrite(USERS.admin)))
  })
})

// ── Deletion ─────────────────────────────────────────────────────────────────

describe('deletion is blocked for every role and every status', () => {
  it('no financial role may delete a release', async () => {
    for (const status of ['draft', 'posted', 'void']) {
      await seed(`del-${status}`, status)
      for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
        await assertFails(deleteDoc(relRef(ctx(user), `del-${status}`)))
      }
    }
  })
})

// ── Documented gaps — proven NOT enforced (Deferred Control 24) ──────────────

describe('accepted limitations — rules cannot sum sibling releases', () => {
  it('ACCEPTS two sibling releases that together over-release the invoice', async () => {
    // ⚠️ THE DOCUMENTED GAP. Each document claims previouslyReleasedAmount 0 and
    // each passes the per-document cap of 1000.00, so BOTH succeed and the
    // invoice is released 2000.00 against 1000.00 of retention. Rules have no
    // list, query, or count and cannot detect this. The normal UI hard-blocks it
    // (lib/retention.js → validateReleaseDraft), and the register reports the
    // resulting over-release rather than hiding it. See docs/SECURITY.md → DC24.
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'sib1'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 0, amount: 1000 })))
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'sib2'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 0, amount: 1000 })))
  })

  it('ACCEPTS a non-contiguous cumulative snapshot', async () => {
    // A gap in the snapshots breaks the GST telescoping to invoice.retentionGst.
    // Rules cannot see it; only the client keeps the sequence contiguous.
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'gap'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 900, amount: 100 })))
  })

  it('ACCEPTS a release the supplier never agreed to', async () => {
    // A release asserts a commercial authorisation, not a bank movement. No rule
    // can evidence the underlying agreement (the DC17 posture).
    await assertSucceeds(setDoc(relRef(ctx(USERS.admin), 'unagreed'),
      releasePayload(USERS.admin, { reason: 'No agreement exists' })))
  })
})
