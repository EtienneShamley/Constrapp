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
import { releaseTotals, cumulativeRetentionGst } from '../../src/lib/retention'
import { roundMoney } from '../../src/lib/purchaseOrders'

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
// ⚠️ ADR-94 (Phase 2 step 4, trusted supplier finance). A retention release is
// CREATED, its draft EDITED, POSTED and VOIDED only by the trusted backend
// (functions/src/supplierFinance/), through the invoice ledger: the cumulative
// cap (Deferred Control 24), GST as a share of the stored retention GST (ADR-91
// Decision 4) and dependency-safe voids (G3). The block is now `allow create,
// update, delete: if false` and the `retentionReleases` counter is
// backend-only. Every test below whose subject was a client write that used to
// SUCCEED now proves that exact write is REFUSED for every financial role
// (company_admin, project_manager, qs) with nothing stored / the stored
// document unchanged (`createRefused` / `updateRefused`). Every denial the
// suite already asserted is kept unchanged — it still holds, now trivially.
// The pure-JS expectations on lib/retention.js are kept as they were. Reads
// are unchanged: financial roles only, tenant-isolated.
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set, so it
// can never reach a production Firebase project.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'demo-constrap-test'
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

const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]

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

async function readRel(id, companyId = COMPANY_A) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const snap = await getDoc(doc(c.firestore(), releasesPath(companyId), id))
    data = snap.exists() ? snap.data() : undefined
  })
  return data
}
// ADR-94 — a client create is REFUSED for EVERY financial role; nothing is stored.
async function createRefused(id, build, companyId = COMPANY_A) {
  for (const user of FINANCIAL) await assertFails(setDoc(relRef(ctx(user), id, companyId), build(user)))
  expect(await readRel(id, companyId)).toBeUndefined()
}
// ADR-94 — a client update is REFUSED for EVERY financial role; the stored
// document does not move.
async function updateRefused(id, build) {
  const before = await readRel(id)
  expect(before).toBeDefined()
  for (const user of FINANCIAL) await assertFails(updateDoc(relRef(ctx(user), id), build(user)))
  expect(await readRel(id)).toEqual(before)
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
  it('ADR-94 — a draft release create is REFUSED for every financial role; nothing is stored', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await createRefused(`create-${user.uid}`, (user) => releasePayload(user))
    }
  })

  it('every financial role can read a release', async () => {
    await seed('read1', 'draft')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(relRef(ctx(user), 'read1')))
    }
  })

  it('ADR-94 — a post and a void are REFUSED for every financial role; the release does not move', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await seed(`post-${user.uid}`, 'draft')
      await updateRefused(`post-${user.uid}`, (user) => postWrite(user))
      await seed(`void-${user.uid}`, 'posted')
      await updateRefused(`void-${user.uid}`, (user) => voidWrite(user))
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

describe('the target supplier invoice (ADR-94: verified by the backend; every client create REFUSED)', () => {
  it('ADR-94 — a release against a POSTED invoice is REFUSED for every financial role', async () => {
    await createRefused('ok', (user) => releasePayload(user))
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

describe('the retention cap (ADR-94: the backend\'s, against the ledger; every client create REFUSED)', () => {
  it('ADR-94 — a release exactly equal to the full retention is REFUSED', async () => {
    await createRefused('full', (user) => releasePayload(user, { amount: 1000 }))
  })

  it('rejects a release of one cent more than the full retention', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'over'),
      releasePayload(USERS.admin, { amount: 1000.01 })))
  })

  it('ADR-94 — a second release whose cumulative total exactly reaches retention is REFUSED', async () => {
    await createRefused('second', (user) => releasePayload(user, { previouslyReleasedAmount: 400, amount: 600 }))
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

describe('the cumulative GST formula (ADR-94: the backend\'s; every client create REFUSED)', () => {
  it('ADR-94 — the correct first-release GST: the create is REFUSED', async () => {
    await createRefused('gst-ok', (user) => releasePayload(user, { amount: 400 }))
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

  it('ADR-94 — the mid-sequence cumulative delta: the create is REFUSED', async () => {
    // prev 333.33 → 666.66: the delta is NOT roundMoney(333.33 × 10%).
    await createRefused('gst-mid', (user) => releasePayload(user, { previouslyReleasedAmount: 333.33, amount: 333.33 }))
  })
})

// ── math.round parity between Firestore Rules and JavaScript ─────────────────
//
// ⚠️ LOAD-BEARING. lib/retention.js computes GST with JS Math.round (via
// roundMoney) and the rules re-derive it with math.round. If the two disagreed
// on a .5 boundary, a legitimate client write would be rejected in production
// while every unit test passed. These cases put a .5 on BOTH sides of the
// subtraction and are the reason the client helper may never be "simplified".

describe('half-cent boundaries (ADR-94: the JS expectations stand; every client create is REFUSED)', () => {
  it('ADR-94 — a first release whose cumulative GST lands exactly on a half cent: the create is REFUSED', async () => {
    // retention 100.05 → 100.05 × 10% = 10.005 → 1000.5 cents.
    expect(cumulativeRetentionGst(100.05)).toBe(10.01)
    await createRefused('half-1', (user) => releasePayload(user, {
        supplierInvoiceId: SI_DRIFT, invoiceNumber: 'SI-0002',
        previouslyReleasedAmount: 0, amount: 100.05,
      }))
  })

  it('ADR-94 — a partial release with a half cent on BOTH cumulative endpoints: the create is REFUSED', async () => {
    // prev 50.05 → 500.5 cents of GST; next 100.05 → 1000.5 cents of GST.
    expect(cumulativeRetentionGst(50.05)).toBe(5.01)
    expect(releaseTotals(50.05, 50).gstAmount).toBe(5)
    await createRefused('half-2', (user) => releasePayload(user, {
        supplierInvoiceId: SI_DRIFT, invoiceNumber: 'SI-0002',
        previouslyReleasedAmount: 50.05, amount: 50,
      }))
  })

  it('ADR-94 — the three-step rounding-remainder sequence: every create is REFUSED', async () => {
    // Two releases of 50.025 are impossible (sub-cent), so use the real drift
    // case: 33.35 + 33.35 + 33.35 = 100.05. The last release must carry the
    // remainder, which is NOT roundMoney(33.35 × 10%) = 3.34 but 3.33.
    const r1 = releaseTotals(0, 33.35)
    const r2 = releaseTotals(33.35, 33.35)
    const r3 = releaseTotals(66.70, 33.35)
    expect(r1.gstAmount + r2.gstAmount + r3.gstAmount).toBeCloseTo(10.01, 10)
    for (const [i, r] of [r1, r2, r3].entries()) {
      await createRefused(`remainder-${i}`, (user) => releasePayload(user, {
          supplierInvoiceId: SI_DRIFT, invoiceNumber: 'SI-0002',
          previouslyReleasedAmount: r.previouslyReleasedAmount, amount: r.amount,
        }))
    }
  })

  it('still rejects a one-cent deviation ABOVE half-up on the half-cent invoice', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'half-bad'),
      releasePayload(USERS.admin, {
        supplierInvoiceId: SI_DRIFT, invoiceNumber: 'SI-0002',
        previouslyReleasedAmount: 0, amount: 100.05, gstAmount: 10.02, releaseTotal: 110.07,
      })))
  })
})

// ── GST boundary hotfix (finding F2) — the client's half-cent-DOWN delta ──────
//
// lib/retention.js → releaseGstAmount is roundMoney(next × 0.1) − roundMoney(
// prev × 0.1). Each roundMoney computes in binary floating point and on SOME
// half-cent boundaries lands a hair below .5 and rounds DOWN (40.15 × 0.1 =
// 4.015 → 4.01 where half-up gives 4.02; 100.05 happens to round UP, which is
// why the cases above never caught it). The rule pinned the delta to EXACT
// half-up, so a first release of 40.15 was refused with permission-denied. It
// now admits the delta as exact, ONE cent below when `next` is on a boundary,
// or ONE cent above when `prev` is — the app's own output and nothing else.

describe('GST boundary hotfix cases (ADR-94: every client create is REFUSED, the client\'s own delta included)', () => {
  const BOUNDARY_FIRST_RELEASES = [40.15, 41.05, 42.65, 80.85, 81.55, 83.35]

  BOUNDARY_FIRST_RELEASES.forEach((amount, i) => {
    it(`ADR-94 — the app's own first release of ${amount.toFixed(2)} (half-cent DOWN): the create is REFUSED`, async () => {
      const money = releaseTotals(0, amount)
      const halfUp = Math.floor((Math.round(amount * 100) + 5) / 10)
      expect(Math.round(money.gstAmount * 100)).toBe(halfUp - 1)
      await createRefused(`boundary-first-${i}`, (user) => releasePayload(user, { previouslyReleasedAmount: 0, amount }))
    })
  })

  it('ADR-94 — BOTH alternatives for a first release of 40.15 — 4.01 and 4.02 — are REFUSED', async () => {
    expect(releaseTotals(0, 40.15).gstAmount).toBe(4.01)
    await createRefused('b-client', (user) => releasePayload(user, { previouslyReleasedAmount: 0, amount: 40.15 }))
    await createRefused('b-exact', (user) => releasePayload(user, { previouslyReleasedAmount: 0, amount: 40.15, gstAmount: 4.02, releaseTotal: 44.17 }))
  })

  it('rejects a first release of 40.15 one cent ABOVE half-up (4.03) or two cents below (4.00)', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'b-up'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 0, amount: 40.15, gstAmount: 4.03, releaseTotal: 44.18 })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'b-down2'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 0, amount: 40.15, gstAmount: 4.00, releaseTotal: 44.15 })))
  })

  it('rejects a one-cent deviation OFF a boundary in either direction (first release of 40.14)', async () => {
    expect(releaseTotals(0, 40.14).gstAmount).toBe(4.01)
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'off-up'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 0, amount: 40.14, gstAmount: 4.02, releaseTotal: 44.16 })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'off-down'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 0, amount: 40.14, gstAmount: 4.00, releaseTotal: 44.14 })))
  })

  it('a later release after a boundary cumulative (prev 40.15, amount 10.01): ADR-94 — the client delta and +1 are REFUSED; ±1 beyond still fails', async () => {
    // exact: gstCents(5016) − gstCents(4015) = 502 − 402 = 100 cents. The
    // client subtracts roundMoney(4.015) = 4.01 instead of 4.02, so its delta
    // may be 1.01 — one ABOVE exact, admitted only because `prev` is on a
    // boundary. 0.99 (next is NOT on a boundary) and 1.02 are refused.
    const money = releaseTotals(40.15, 10.01)
    expect([1.00, 1.01]).toContain(money.gstAmount)
    await createRefused('later-client', (user) => releasePayload(user, { previouslyReleasedAmount: 40.15, amount: 10.01 }))
    await createRefused('later-plus-one', (user) => releasePayload(user, { previouslyReleasedAmount: 40.15, amount: 10.01, gstAmount: 1.01, releaseTotal: 11.02 }))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'later-minus-one'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 40.15, amount: 10.01, gstAmount: 0.99, releaseTotal: 11.00 })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'later-plus-two'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 40.15, amount: 10.01, gstAmount: 1.02, releaseTotal: 11.03 })))
  })

  it('ADR-94 — the telescoping sequence 40.15 + 40.15 + 19.70 = 100.00: every create is REFUSED', async () => {
    const steps = [releaseTotals(0, 40.15), releaseTotals(40.15, 40.15), releaseTotals(80.30, 19.70)]
    expect(roundMoney(steps.reduce((s, r) => s + r.gstAmount, 0))).toBe(cumulativeRetentionGst(100))
    for (const [i, r] of steps.entries()) {
      await createRefused(`telescope-${i}`, (user) => releasePayload(user, { previouslyReleasedAmount: r.previouslyReleasedAmount, amount: r.amount }))
    }
  })

  it('still rejects an arbitrary gstAmount even when releaseTotal adds up, and a non-number amount', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'arb-1'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 0, amount: 40.15, gstAmount: 0, releaseTotal: 40.15 })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'arb-2'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: '0', amount: 40.15 })))
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'arb-3'),
      releasePayload(USERS.admin, { previouslyReleasedAmount: 0, amount: '40.15' })))
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

  it('rejects a missing supplierName; ADR-94 — a legacy null supplierId is REFUSED too', async () => {
    await assertFails(setDoc(relRef(ctx(USERS.admin), 'noname'),
      releasePayload(USERS.admin, { supplierName: '' })))
    // Pre-Contacts invoices carry supplierId: null and are never backfilled.
    await createRefused('legacy', (user) => releasePayload(user, { supplierId: null }))
  })
})

// ── Draft edits ──────────────────────────────────────────────────────────────

describe('draft edits (ADR-94: every client edit REFUSED)', () => {
  it('ADR-94 — an edit of the money, date, reason and notes is REFUSED for every financial role', async () => {
    await seed('edit1', 'draft')
    const money = releaseTotals(0, 250)
    await updateRefused('edit1', (user) => draftEdit(user, {
      amount: money.amount, gstAmount: money.gstAmount, releaseTotal: money.releaseTotal,
      releaseDate: '2026-09-01', reason: 'Revised — half of first moiety', notes: 'Agreed on site',
    }))
  })

  it('ADR-94 — a re-save refreshing a stale cumulative snapshot is REFUSED', async () => {
    await seed('edit2', 'draft')
    const money = releaseTotals(400, 300)
    await updateRefused('edit2', (user) => draftEdit(user, {
      previouslyReleasedAmount: money.previouslyReleasedAmount,
      amount: money.amount, gstAmount: money.gstAmount, releaseTotal: money.releaseTotal,
    }))
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

describe('posting (ADR-94: every client post REFUSED)', () => {
  it('ADR-94 — a status-only post with authentic stamps is REFUSED for every financial role', async () => {
    await seed('post1', 'draft')
    await updateRefused('post1', (user) => postWrite(user))
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

describe('a posted release is immutable (ADR-94: the void is the backend\'s)', () => {
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

  it('ADR-94 — a client void is REFUSED for every financial role', async () => {
    await seed('imm3', 'posted')
    await updateRefused('imm3', (user) => voidWrite(user))
  })
})

// ── Voiding ──────────────────────────────────────────────────────────────────

describe('voiding (ADR-94: every client void REFUSED)', () => {
  it('ADR-94 — a void from draft and from posted is REFUSED for every financial role', async () => {
    await seed('void1', 'draft')
    await updateRefused('void1', (user) => voidWrite(user))
    await seed('void2', 'posted')
    await updateRefused('void2', (user) => voidWrite(user))
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

  it('ADR-94 — a void after the target invoice was cancelled is REFUSED for every financial role (the backend voids)', async () => {
    // The release that most needs withdrawing is withdrawn by the backend
    // (ADR-94, dependency-safe void G3); no client path remains.
    await seed('void7', 'posted', USERS.admin, { supplierInvoiceId: SI_CANCELLED })
    await updateRefused('void7', (user) => voidWrite(user))
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

describe('former limitations (DC24) — ADR-94: no client create at all, so the sibling gaps are closed at the Rules', () => {
  it('ADR-94 — two sibling releases that together over-release the invoice are both REFUSED', async () => {
    // THE FORMER GAP. Each document claims previouslyReleasedAmount 0 and each
    // passed the per-document cap of 1000.00, so BOTH succeeded and the invoice
    // was released 2000.00 against 1000.00 of retention. ADR-94 moves every
    // write to the backend, which caps against the invoice ledger (DC24).
    await createRefused('sib1', (user) => releasePayload(user, { previouslyReleasedAmount: 0, amount: 1000 }))
    await createRefused('sib2', (user) => releasePayload(user, { previouslyReleasedAmount: 0, amount: 1000 }))
  })

  it('ADR-94 — a non-contiguous cumulative snapshot is REFUSED', async () => {
    // A gap in the snapshots broke the GST telescoping to invoice.retentionGst;
    // the Rules could not see it. No client create is admitted now.
    await createRefused('gap', (user) => releasePayload(user, { previouslyReleasedAmount: 900, amount: 100 }))
  })

  it('ADR-94 — a release the supplier never agreed to is REFUSED at the Rules (the agreement itself stays unevidenced — DC17 posture)', async () => {
    // A release asserts a commercial authorisation, not a bank movement. No rule
    // can evidence the underlying agreement (the DC17 posture).
    await createRefused('unagreed', (user) => releasePayload(user, { reason: 'No agreement exists' }))
  })
})

// ── ADR-94 — the retentionReleases counter is backend-only ───────────────────

describe('ADR-94 — the retentionReleases number counter', () => {
  const counter = (db, id, companyId = COMPANY_A) => doc(db, `companies/${companyId}/counters`, id)
  const readCounter = async (id) => {
    let data
    await testEnv.withSecurityRulesDisabled(async (c) => { const s = await getDoc(counter(c.firestore(), id)); data = s.exists() ? s.data() : undefined })
    return data
  }

  it('every financial role is REFUSED a read, a create, an advance and the old numbering transaction; the stored value does not move', async () => {
    for (const user of FINANCIAL) await assertFails(setDoc(counter(ctx(user), 'retentionReleases'), { next: 2 }, { merge: true }))
    expect(await readCounter('retentionReleases')).toBeUndefined()
    await testEnv.withSecurityRulesDisabled(async (c) => { await setDoc(counter(c.firestore(), 'retentionReleases'), { next: 7 }) })
    for (const user of FINANCIAL) {
      const db = ctx(user)
      await assertFails(getDoc(counter(db, 'retentionReleases')))
      await assertFails(updateDoc(counter(db, 'retentionReleases'), { next: 8 }))
      await assertFails(setDoc(counter(db, 'retentionReleases'), { next: 1 }, { merge: true }))
      await assertFails(runTransaction(db, async (tx) => {
        const snap = await tx.get(counter(db, 'retentionReleases'))
        tx.set(counter(db, 'retentionReleases'), { next: (snap.exists() ? snap.data().next : 1) + 1 }, { merge: true })
      }))
    }
    expect(await readCounter('retentionReleases')).toEqual({ next: 7 })
  })

  it('another register\'s counter (purchaseOrders) still reads and advances for every financial role', async () => {
    for (const user of FINANCIAL) {
      await assertSucceeds(setDoc(counter(ctx(user), 'purchaseOrders'), { next: 2 }, { merge: true }))
      await assertSucceeds(getDoc(counter(ctx(user), 'purchaseOrders')))
    }
  })
})
