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
import { poTotals, lineTotal, roundMoney, remainingCommittedByCostCode, committedByCostCode } from '../../src/lib/purchaseOrders'
import {
  CLAIM_STATUS, claimTotals, buildClaimLine, buildVariationClaimLine, actualClaimsByCostCode, recognisedClaimsByPoLine,
  recognisedClaimsByVariationLine, claimedPendingByCostCode, previouslyApprovedByPoLine, previouslyApprovedByVariationLine,
} from '../../src/lib/progressClaims'
import { invoiceTotals, gstForLine, invoicedClaimIds, postedInvoicedByPoLine } from '../../src/lib/supplierInvoices'
import {
  runUpdateClaimDraft, runTransitionClaim, ClaimWriteError, CLAIM_WRITE_ERROR,
} from '../../src/lib/progressClaimActions'

// ── Progress Claim Security Rules — emulator tests (ADR-58, M2-B2) ──────────
//
// Executes every case documented in docs/TESTING.md §34 against the Firestore
// emulator. These verify the RULES, not the UI: each write below is a direct
// SDK call, exactly what a client bypassing the app would issue.
//
// Until M2-B2 the `progressClaims` block enforced tenant and role and NOTHING
// else, while `supplierInvoices` get()s a claim and trusts `status ==
// 'approved'` at invoice create (ADR-40), and Actual, Remaining Committed,
// Forecast Final Cost, Cash Flow, Margin, PULSE and SHIELD all trust a claim's
// `status`, `lineItems` and header totals at read time. A financial-role
// caller could therefore create a claim already `approved` against any (or no)
// PO, certify more than was claimed, rewrite an approved claim's lines or
// supplier, move a rejected claim back to approved, forge `approvedBy`, or
// write a header unrelated to its GST. The block now follows the ADR-40 /
// ADR-57 standard: born draft against a SENT PO of the same project (number,
// supplier and line count pinned by get()), draft-only content edits with a
// fixed line count, three legal transitions carrying stamps only (approval
// also carrying the certified lines, the approved header and the notes),
// actor == caller, time == request.time, identity frozen, scalar money in
// whole cents on both sides, approved subtotal never above the claimed one,
// currency pinned to the project's resolved currency at create, revision
// exactly +1 on every update, delete blocked.
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (Deferred Control 36):
// rules can neither iterate an array nor read sibling documents, so
// `lineItems` CONTENTS, `Σ claimedThisPeriod == claimedSubtotal`, one open
// claim per PO, cumulative claiming against the PO value, the mixed-mode
// overlap with a direct invoice, creator ≠ approver, and a stale write that
// reads first and writes `stored + 1` are all unverified. The final describe
// block proves each of those, so the suite documents the security CEILING as
// explicitly as the floor. The app's own guards run in the client and are
// exercised here through the REAL guarded transactions
// (lib/progressClaimActions.js).
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

const claimsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/progressClaims`
const posPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/purchaseOrders`
const ctx      = (user) => testEnv.authenticatedContext(user.uid).firestore()
const claimRef = (db, id, companyId = COMPANY_A, projectId = PROJECT_A) => doc(db, claimsPath(companyId, projectId), id)
const poRef    = (db, id, companyId = COMPANY_A, projectId = PROJECT_A) => doc(db, posPath(companyId, projectId), id)
const invoiceRef = (db, id) => doc(db, `companies/${COMPANY_A}/projects/${PROJECT_A}/supplierInvoices`, id)

// ── Fixtures ────────────────────────────────────────────────────────────────

// The sent PO every claim is raised against: two lines, 10 × 250 and 4 × 500.
const PO_ID = 'po1'
const poLine = (costCodeId, costCodeName, description, qty, unitPrice) => ({
  costCodeId, costCodeName, description, qty, unit: 'm3', unitPrice, lineTotal: lineTotal(qty, unitPrice),
})
const PO_LINES = [
  poLine('cc1', '03-100 — Concrete', 'Slab pour', 10, 250),
  poLine('cc2', '05-200 — Steel', 'Beams', 4, 500),
]
function poDoc(status = 'sent', { lines = PO_LINES, supplierId = 'contact1', supplierName = 'BuildCo Pty Ltd', currency = 'AUD' } = {}) {
  const { subtotal, gst, total } = poTotals(lines)
  const now = Timestamp.now()
  return {
    poNumber: 'PO-0001', status, supplierName, supplierId, description: 'Level 1', notes: '',
    lineItems: lines, subtotal, gst, total, currency, revision: 1,
    sentAt: status === 'draft' || status === 'pending_approval' ? null : now, sentBy: status === 'draft' || status === 'pending_approval' ? null : 'u_admin',
    closedAt: status === 'closed' ? now : null, closedBy: status === 'closed' ? 'u_admin' : null,
    cancelledAt: status === 'cancelled' ? now : null, cancelledBy: status === 'cancelled' ? 'u_admin' : null,
    externalRefs: {}, createdAt: now, createdBy: 'u_admin', updatedAt: now, updatedBy: 'u_admin',
  }
}
async function seedPo(id, status = 'sent', opts = {}, { companyId = COMPANY_A, projectId = PROJECT_A } = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(poRef(c.firestore(), id, companyId, projectId), poDoc(status, opts))
  })
}

// Claim lines exactly as the editor builds them (lib/progressClaims.js →
// buildClaimLine over the PO lines): claimed-to-date 1,000 on line 0, 0 on
// line 1 → claimedThisPeriod [1000, 0].
const claimLines = (toDate = [1000, 0], prev = [0, 0], lines = PO_LINES) =>
  lines.map((li, idx) => buildClaimLine(li, { poLineIndex: idx, previouslyApproved: prev[idx] ?? 0, claimedToDate: toDate[idx] ?? 0 }))
const DEFAULT_LINES = claimLines()

// A valid DRAFT payload built through the REAL claimTotals, so every header
// figure the rules check is exactly what the app writes
// (hooks/useProgressClaims.jsx → createProgressClaim).
function claimPayload(user, { lines = DEFAULT_LINES, retention = 0, ...overrides } = {}) {
  const t = claimTotals(lines.map(li => li.claimedThisPeriod), retention)
  return {
    claimNumber: 'PC-0001', status: 'draft', poId: PO_ID, poNumber: 'PO-0001',
    supplierName: 'BuildCo Pty Ltd', supplierId: 'contact1',
    claimRef: 'S-1', periodEnding: '2026-08-31', variationId: null,
    // ADR-63: the number of variation-origin lines after the PO lines (0 here).
    variationLineCount: 0,
    lineItems: lines,
    retention: t.retention, claimedSubtotal: t.subtotal, claimedGst: t.gst, claimedTotal: t.total,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null,
    notes: '', assessmentNotes: '',
    currency: 'AUD', revision: 1,
    submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, invoicedAt: null,
    externalRefs: {},
    createdAt: serverTimestamp(), createdBy: user.uid,
    updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}

// Seeds a claim directly, bypassing rules. `status` selects the stamps a real
// document would carry; `legacy: true` strips every ADR-58 key (the pre-M2-B2
// shape the hook wrote — no submittedBy / rejectedBy / updatedAt / updatedBy),
// and `extra` is pasted over the top.
async function seed(id, status = 'draft', user = USERS.admin, extra = {}, { legacy = false, projectId = PROJECT_A, companyId = COMPANY_A } = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const base = claimPayload(user)
    const now = Timestamp.now()
    const approvedLines = base.lineItems.map(li => ({ ...li, approvedThisPeriod: li.claimedThisPeriod }))
    const approvedTotals = claimTotals(approvedLines.map(li => li.approvedThisPeriod), base.retention)
    const lifecycle =
      status === 'submitted'    ? { status, submittedAt: now, submittedBy: user.uid } :
      status === 'under_review' ? { status, submittedAt: now, submittedBy: user.uid } :
      status === 'approved'     ? { status, submittedAt: now, submittedBy: user.uid, approvedAt: now, approvedBy: user.uid,
                                    lineItems: approvedLines, approvedSubtotal: approvedTotals.subtotal, approvedGst: approvedTotals.gst, approvedTotal: approvedTotals.total,
                                    assessmentNotes: 'Certified in full' } :
      status === 'invoiced'     ? { status, submittedAt: now, submittedBy: user.uid, approvedAt: now, approvedBy: user.uid, invoicedAt: now,
                                    lineItems: approvedLines, approvedSubtotal: approvedTotals.subtotal, approvedGst: approvedTotals.gst, approvedTotal: approvedTotals.total } :
      status === 'rejected'     ? { status, submittedAt: now, submittedBy: user.uid, rejectedAt: now, rejectedBy: user.uid } :
      { status: 'draft' }
    const docData = { ...base, createdAt: now, updatedAt: now, ...lifecycle, ...extra }
    if (legacy) {
      for (const k of ['submittedBy', 'rejectedBy', 'updatedAt', 'updatedBy']) delete docData[k]
    }
    await setDoc(doc(db, claimsPath(companyId, projectId), id), docData)
  })
}

const stamps = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })

// hooks/useProgressClaims.jsx → updateProgressClaim (lib/progressClaimActions.js
// → draftUpdate): the authored content, the re-derived header, revision + 1 and
// the audit stamps. Over the DEFAULT seed (revision 1).
function draftEdit(user, { toDate = [1500, 800], retention = 100, claimRef = 'S-1b', periodEnding = '2026-09-30', notes = 'Revised', revision = 2, ...extra } = {}) {
  const lines = claimLines(toDate)
  const t = claimTotals(lines.map(li => li.claimedThisPeriod), retention)
  return {
    claimRef, periodEnding, notes, lineItems: lines,
    retention: t.retention, claimedSubtotal: t.subtotal, claimedGst: t.gst, claimedTotal: t.total,
    revision, ...stamps(user), ...extra,
  }
}

// lib/progressClaimActions.js → transitionUpdate, as the app writes them.
const submitWrite = (user, extra = {}) =>
  ({ status: 'submitted', submittedAt: serverTimestamp(), submittedBy: user.uid, revision: 2, ...stamps(user), ...extra })
const rejectWrite = (user, extra = {}) =>
  ({ status: 'rejected', rejectedAt: serverTimestamp(), rejectedBy: user.uid, revision: 2, ...stamps(user), ...extra })
// Approval over the DEFAULT seed (claimed [1000, 0], retention 0): certify
// `amounts` per line.
function approveWrite(user, { amounts = [1000, 0], retention = 0, lines = DEFAULT_LINES, assessmentNotes = '', revision = 2, ...extra } = {}) {
  const approved = lines.map((li, idx) => ({ ...li, approvedThisPeriod: amounts[idx] ?? 0 }))
  const t = claimTotals(amounts, retention)
  return {
    status: 'approved', lineItems: approved,
    approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total,
    assessmentNotes, approvedAt: serverTimestamp(), approvedBy: user.uid,
    revision, ...stamps(user), ...extra,
  }
}

// Client-supplied clock values that must NEVER satisfy `== request.time`
// (docs/TESTING.md §0 — deliberately skewed, never Timestamp.now()).
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

async function readClaim(id) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const snap = await getDoc(doc(c.firestore(), claimsPath(), id))
    data = snap.exists() ? { id: snap.id, ...snap.data() } : undefined
  })
  return data
}
const readStatus = async (id) => (await readClaim(id))?.status

async function expectKind(promise, kind) {
  let caught
  try { await promise } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(ClaimWriteError)
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
    // The sent PO every default claim is raised against, in every project that
    // takes a claim below.
    await setDoc(poRef(db, PO_ID), poDoc('sent'))
    await setDoc(poRef(db, PO_ID, COMPANY_A, PROJECT_NOCUR), poDoc('sent'))
    await setDoc(poRef(db, PO_ID, COMPANY_B, PROJECT_B), poDoc('sent'))
  })
})

// ── Roles, membership & tenant isolation ─────────────────────────────────────

describe('roles, membership and tenant isolation', () => {
  it('every financial role can create a draft claim', async () => {
    for (const user of FINANCIAL) {
      await assertSucceeds(setDoc(claimRef(ctx(user), `create-${user.uid}`), claimPayload(user)))
    }
  })

  it('every financial role can read a claim', async () => {
    await seed('read1', 'approved')
    for (const user of FINANCIAL) await assertSucceeds(getDoc(claimRef(ctx(user), 'read1')))
  })

  it('every financial role can edit a draft, submit, approve and reject', async () => {
    for (const user of FINANCIAL) {
      await seed(`ed-${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(claimRef(ctx(user), `ed-${user.uid}`), draftEdit(user)))
      await seed(`su-${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(claimRef(ctx(user), `su-${user.uid}`), submitWrite(user)))
      await seed(`ap-${user.uid}`, 'submitted')
      await assertSucceeds(updateDoc(claimRef(ctx(user), `ap-${user.uid}`), approveWrite(user)))
      await seed(`re-${user.uid}`, 'submitted')
      await assertSucceeds(updateDoc(claimRef(ctx(user), `re-${user.uid}`), rejectWrite(user)))
    }
  })

  it('subcontractor and client can neither read nor write', async () => {
    await seed('deny1', 'draft')
    await seed('deny1s', 'submitted')
    for (const user of [USERS.sub, USERS.client]) {
      await assertFails(getDoc(claimRef(ctx(user), 'deny1')))
      await assertFails(setDoc(claimRef(ctx(user), `deny-${user.uid}`), claimPayload(user)))
      await assertFails(updateDoc(claimRef(ctx(user), 'deny1'), draftEdit(user)))
      await assertFails(updateDoc(claimRef(ctx(user), 'deny1'), submitWrite(user)))
      await assertFails(updateDoc(claimRef(ctx(user), 'deny1s'), approveWrite(user)))
      await assertFails(updateDoc(claimRef(ctx(user), 'deny1s'), rejectWrite(user)))
    }
  })

  it('an unauthenticated caller can neither read nor write', async () => {
    await seed('deny2', 'draft')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(claimRef(db, 'deny2')))
    await assertFails(setDoc(claimRef(db, 'deny3'), claimPayload(USERS.admin)))
    await assertFails(updateDoc(claimRef(db, 'deny2'), submitWrite(USERS.admin)))
  })

  it('an authenticated caller with NO membership document is denied', async () => {
    await seed('deny4', 'draft')
    const db = testEnv.authenticatedContext(ORPHAN_UID).firestore()
    await assertFails(getDoc(claimRef(db, 'deny4')))
    await assertFails(setDoc(claimRef(db, 'deny5'), claimPayload({ uid: ORPHAN_UID })))
    await assertFails(updateDoc(claimRef(db, 'deny4'), submitWrite({ uid: ORPHAN_UID })))
  })

  it("a Company B admin cannot touch Company A's claims, and Company A cannot write into Company B", async () => {
    await seed('deny6', 'draft')
    await assertFails(getDoc(claimRef(ctx(USERS.other), 'deny6')))
    await assertFails(setDoc(claimRef(ctx(USERS.other), 'deny7'), claimPayload(USERS.other)))
    await assertFails(updateDoc(claimRef(ctx(USERS.other), 'deny6'), submitWrite(USERS.other)))
    await assertFails(setDoc(claimRef(ctx(USERS.admin), 'crosstenant', COMPANY_B, PROJECT_B), claimPayload(USERS.admin)))
  })

  it('delete is blocked for every role in every status', async () => {
    for (const status of ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'invoiced']) {
      await seed(`del-${status}`, status)
      for (const user of [...FINANCIAL, USERS.sub, USERS.client, USERS.other]) {
        await assertFails(deleteDoc(claimRef(ctx(user), `del-${status}`)))
      }
      await assertFails(deleteDoc(claimRef(testEnv.unauthenticatedContext().firestore(), `del-${status}`)))
    }
  })
})

// ── Valid create ─────────────────────────────────────────────────────────────

describe('valid create', () => {
  it('accepts the hook payload for each financial role', async () => {
    for (const user of FINANCIAL) await assertSucceeds(setDoc(claimRef(ctx(user), `c-${user.uid}`), claimPayload(user)))
  })

  it('accepts a legacy pre-Contacts supplier — supplierId null on the PO and the claim', async () => {
    await seedPo('poLegacy', 'sent', { supplierId: null })
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'c1'), claimPayload(USERS.qs, { poId: 'poLegacy', supplierId: null })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'c2'), claimPayload(USERS.qs, { poId: 'poLegacy', supplierId: 'contact1' })))   // not the PO's
  })

  it('accepts a retention, a five-digit claim number, an empty period and blank refs', async () => {
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'c3'), claimPayload(USERS.qs, { retention: 100 })))
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'c4'), claimPayload(USERS.qs, { claimNumber: 'PC-12345', periodEnding: '', claimRef: '', notes: 'x'.repeat(5000) })))
  })

  it('accepts a retention equal to the subtotal (payable zero) and a second line claimed on a later claim (cumulative seed)', async () => {
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'c5'), claimPayload(USERS.qs, { retention: 1000 })))
    const later = claimLines([1000, 1200], [1000, 0])   // line 0 fully approved earlier; line 1 claimed now
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'c6'), claimPayload(USERS.qs, { claimNumber: 'PC-0002', lines: later })))
  })

  it('accepts the REAL claimTotals on half-cent GST boundaries where floating point rounds down (net 40.15, 41.05, 80.85)', async () => {
    for (const [i, net] of [40.15, 41.05, 80.85, 327680.05, 0.05, 1234.45].entries()) {
      const lines = claimLines([net, 0])
      const t = claimTotals(lines.map(li => li.claimedThisPeriod), 0)
      await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), `b${i}`), claimPayload(USERS.qs, { lines })))
      // and with the retention moving the NET onto the boundary
      const lines2 = claimLines([net + 100, 0])
      await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), `r${i}`), claimPayload(USERS.qs, { lines: lines2, retention: 100 })))
      expect(t.subtotal).toBe(net)
    }
  })

  it('accepts 200 lines when the PO has 200 lines', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => poLine('cc1', 'cc', `L${i}`, 1, 10))
    await seedPo('po200', 'sent', { lines })
    const cl = claimLines(lines.map(() => 10), lines.map(() => 0), lines)
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'c200'), claimPayload(USERS.qs, { poId: 'po200', lines: cl })))
  })
})

// ── Source PO ────────────────────────────────────────────────────────────────

describe('source purchase order at create (get())', () => {
  it('refuses a PO that does not exist, an empty / non-string poId', async () => {
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x1'), claimPayload(USERS.qs, { poId: 'nope' })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x2'), claimPayload(USERS.qs, { poId: '' })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x3'), claimPayload(USERS.qs, { poId: null })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x4'), claimPayload(USERS.qs, { poId: 7 })))
  })

  it('refuses a draft, pending_approval, closed or cancelled PO — only sent is claimable (CLAIMABLE_PO_STATUSES)', async () => {
    for (const status of ['draft', 'pending_approval', 'closed', 'cancelled']) {
      await seedPo(`po-${status}`, status)
      await assertFails(setDoc(claimRef(ctx(USERS.qs), `x-${status}`), claimPayload(USERS.qs, { poId: `po-${status}` })))
    }
  })

  it('refuses a PO from another project or another company — the reference is same-project by path', async () => {
    await seedPo('poElsewhere', 'sent', {}, { projectId: PROJECT_NOCUR })
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x5'), claimPayload(USERS.qs, { poId: 'poElsewhere' })))
    // The same id exists in Company B's project — still not reachable from Company A's path.
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x6', COMPANY_A, 'ghostProject'), claimPayload(USERS.qs)))
  })

  it("refuses a poNumber, supplierName or supplierId that is not the PO's — supplier identity is pinned", async () => {
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x7'), claimPayload(USERS.qs, { poNumber: 'PO-0002' })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x8'), claimPayload(USERS.qs, { supplierName: 'Other Supplier' })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x9'), claimPayload(USERS.qs, { supplierId: 'contact2' })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x10'), claimPayload(USERS.qs, { supplierId: null })))
  })

  it("refuses a line count that is not the PO's — the set is one line per PO line", async () => {
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x11'), claimPayload(USERS.qs, { lines: claimLines([1000]).slice(0, 1) })))
    const three = [...claimLines([1000, 0]), buildClaimLine(poLine('cc3', 'x', 'y', 1, 1), { poLineIndex: 2, previouslyApproved: 0, claimedToDate: 1 })]
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'x12'), claimPayload(USERS.qs, { lines: three })))
  })
})

// ── Currency ─────────────────────────────────────────────────────────────────

describe('currency and project consistency at create', () => {
  it("accepts the project's explicit currency and refuses any other well-formed code", async () => {
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'cur1'), claimPayload(USERS.qs, { currency: 'AUD' })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cur2'), claimPayload(USERS.qs, { currency: 'NZD' })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cur3'), claimPayload(USERS.qs, { currency: 'USD' })))
  })

  it("falls back to the company's baseCurrency when the project stores none (lib/currency.js → resolveProjectCurrency)", async () => {
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'cur4', COMPANY_A, PROJECT_NOCUR), claimPayload(USERS.qs, { currency: 'NZD' })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cur5', COMPANY_A, PROJECT_NOCUR), claimPayload(USERS.qs, { currency: 'AUD' })))
  })

  it('falls back to AUD when neither the project nor the company stores a currency', async () => {
    await assertSucceeds(setDoc(claimRef(ctx(USERS.other), 'cur6', COMPANY_B, PROJECT_B), claimPayload(USERS.other, { currency: 'AUD' })))
    await assertFails(setDoc(claimRef(ctx(USERS.other), 'cur7', COMPANY_B, PROJECT_B), claimPayload(USERS.other, { currency: 'NZD' })))
  })

  it('refuses a malformed currency and a claim under a project that does not exist', async () => {
    for (const currency of ['aud', 'AU', 'AUDD', '', null, 123]) {
      await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cur8'), claimPayload(USERS.qs, { currency })))
    }
    await seedPo(PO_ID, 'sent', {}, { projectId: 'ghost' })
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cur9', COMPANY_A, 'ghost'), claimPayload(USERS.qs)))
  })
})

// ── Create shape ─────────────────────────────────────────────────────────────

describe('create shape — identity, stamps and exact keys', () => {
  it('must be born draft — every other status is refused at create, with stamps that look right', async () => {
    for (const status of ['submitted', 'under_review', 'approved', 'rejected', 'invoiced', 'bogus']) {
      await assertFails(setDoc(claimRef(ctx(USERS.qs), `s-${status}`), claimPayload(USERS.qs, { status })))
    }
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 's-sub'), claimPayload(USERS.qs, { status: 'submitted', submittedAt: serverTimestamp(), submittedBy: USERS.qs.uid })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 's-app'), claimPayload(USERS.qs, {
      ...approveWrite(USERS.qs, { revision: 1 }), submittedAt: serverTimestamp(), submittedBy: USERS.qs.uid,
    })))
  })

  it('createdBy and updatedBy must be the caller', async () => {
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cb1'), claimPayload(USERS.qs, { createdBy: USERS.admin.uid })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cb2'), claimPayload(USERS.qs, { updatedBy: USERS.admin.uid })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cb3'), claimPayload(USERS.qs, { createdBy: null })))
  })

  it('createdAt and updatedAt must be server time — three skewed client clocks each', async () => {
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(claimRef(ctx(USERS.qs), 'ca1'), claimPayload(USERS.qs, { createdAt: clock() })))
      await assertFails(setDoc(claimRef(ctx(USERS.qs), 'ca2'), claimPayload(USERS.qs, { updatedAt: clock() })))
    }
  })

  it('every lifecycle stamp and every approved value must be null at create', async () => {
    const forged = {
      submittedAt: serverTimestamp(), submittedBy: USERS.qs.uid, approvedAt: serverTimestamp(), approvedBy: USERS.qs.uid,
      rejectedAt: serverTimestamp(), rejectedBy: USERS.qs.uid, invoicedAt: serverTimestamp(),
      approvedSubtotal: 1000, approvedGst: 100, approvedTotal: 1100,
    }
    for (const [k, v] of Object.entries(forged)) {
      await assertFails(setDoc(claimRef(ctx(USERS.qs), `st-${k}`), claimPayload(USERS.qs, { [k]: v })))
    }
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'st-notes'), claimPayload(USERS.qs, { assessmentNotes: 'certified already' })))
  })

  it('the key set is exact — a missing key or an extra key is refused', async () => {
    const full = claimPayload(USERS.qs)
    for (const k of Object.keys(full)) {
      const { [k]: _omit, ...without } = full   // eslint-disable-line no-unused-vars
      await assertFails(setDoc(claimRef(ctx(USERS.qs), `mk-${k}`), without))
    }
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'ek1'), { ...full, invoicedBy: null }))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'ek2'), { ...full, approved: true }))
  })

  it('identity shape — claim number pattern, supplier name bound, revision 1, externalRefs map, reserved variationId null', async () => {
    for (const claimNumber of ['PC-001', 'PO-0001', 'pc-0001', 'PC-', '', null, 1]) {
      await assertFails(setDoc(claimRef(ctx(USERS.qs), 'id1'), claimPayload(USERS.qs, { claimNumber })))
    }
    await seedPo('poLong', 'sent', { supplierName: 'x'.repeat(201) })
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'id2'), claimPayload(USERS.qs, { poId: 'poLong', supplierName: 'x'.repeat(201) })))
    for (const revision of [0, 2, '1', null]) {
      await assertFails(setDoc(claimRef(ctx(USERS.qs), 'id3'), claimPayload(USERS.qs, { revision })))
    }
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'id4'), claimPayload(USERS.qs, { externalRefs: [] })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'id5'), claimPayload(USERS.qs, { externalRefs: null })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'id6'), claimPayload(USERS.qs, { variationId: 'sv1' })))
  })

  it('content shape — claimRef / notes bounds, periodEnding shape, at least one line, at most 200', async () => {
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cs1'), claimPayload(USERS.qs, { claimRef: 'x'.repeat(201) })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cs2'), claimPayload(USERS.qs, { notes: 'x'.repeat(5001) })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cs3'), claimPayload(USERS.qs, { claimRef: null })))
    for (const periodEnding of ['31/08/2026', '2026-8-31', 'August', null, 20260831]) {
      await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cs4'), claimPayload(USERS.qs, { periodEnding })))
    }
    await seedPo('po0', 'sent', { lines: [] })
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cs5'), claimPayload(USERS.qs, { poId: 'po0', lines: [] })))
    const lines = Array.from({ length: 201 }, (_, i) => poLine('cc1', 'cc', `L${i}`, 1, 10))
    await seedPo('po201', 'sent', { lines })
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cs6'), claimPayload(USERS.qs, { poId: 'po201', lines: claimLines(lines.map(() => 10), lines.map(() => 0), lines) })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'cs7'), claimPayload(USERS.qs, { lineItems: 'two lines' })))
  })
})

// ── Create money ─────────────────────────────────────────────────────────────

describe('create money — the claimed header in whole cents', () => {
  const t = claimTotals([1000, 0], 0)   // subtotal 1000, gst 100, total 1100

  // `claimTotals` clamps and coerces the retention it is handed, so a raw
  // stored value is pasted over the built payload to reach the rule itself.
  const raw = (user, over) => ({ ...claimPayload(user), ...over })

  it('refuses a negative retention (the ADR-40 floor), a retention above the subtotal, and a zero / negative subtotal', async () => {
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'm1'), raw(USERS.qs, { retention: -1 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'm1b'), raw(USERS.qs, { retention: -0.01, claimedGst: 100, claimedTotal: 1100.01 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'm2'), raw(USERS.qs, { retention: 1000.01, claimedGst: 0, claimedTotal: 0 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'm2b'), raw(USERS.qs, { retention: 1000.01, claimedGst: 0, claimedTotal: -0.01 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'm3'), claimPayload(USERS.qs, { claimedSubtotal: 0, claimedGst: 0, claimedTotal: 0 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'm4'), claimPayload(USERS.qs, { claimedSubtotal: -1000, claimedGst: -100, claimedTotal: -1100 })))
  })

  it('refuses non-numeric money', async () => {
    for (const k of ['retention', 'claimedSubtotal', 'claimedGst', 'claimedTotal']) {
      for (const v of ['100', null, true, {}]) {
        await assertFails(setDoc(claimRef(ctx(USERS.qs), `nn-${k}`), raw(USERS.qs, { [k]: v })))
      }
    }
  })

  it('total must equal (subtotal − retention) + gst EXACTLY — one cent either way is refused', async () => {
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'tt1'), claimPayload(USERS.qs, { claimedTotal: t.total + 0.01 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'tt2'), claimPayload(USERS.qs, { claimedTotal: t.total - 0.01 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'tt3'), claimPayload(USERS.qs, { retention: 100, claimedTotal: t.total })))   // retention ignored in the total
  })

  it('gst must be EXACTLY 10% of the NET (subtotal − retention), round-half-up off a boundary — one cent either way is refused', async () => {
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'g1'), claimPayload(USERS.qs, { claimedGst: 100.01, claimedTotal: 1100.01 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'g2'), claimPayload(USERS.qs, { claimedGst: 99.99, claimedTotal: 1099.99 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'g3'), claimPayload(USERS.qs, { claimedGst: 0, claimedTotal: 1000 })))
    // GST on the GROSS (the PO formula) is refused when retention is withheld: net 900 → gst 90, not 100.
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'g4'), claimPayload(USERS.qs, { retention: 100, claimedGst: 100, claimedTotal: 1000 })))
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'g5'), claimPayload(USERS.qs, { retention: 100, claimedGst: 90, claimedTotal: 990 })))
  })

  it('on a half-cent boundary (net cents ending in 5) BOTH the half-up value and one cent below are accepted; above, or two below, is refused', async () => {
    const lines = claimLines([40.15, 0])
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'hb1'), claimPayload(USERS.qs, { lines, claimedGst: 4.02, claimedTotal: 44.17 })))
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'hb2'), claimPayload(USERS.qs, { lines, claimedGst: 4.01, claimedTotal: 44.16 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'hb3'), claimPayload(USERS.qs, { lines, claimedGst: 4.03, claimedTotal: 44.18 })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'hb4'), claimPayload(USERS.qs, { lines, claimedGst: 4.00, claimedTotal: 44.15 })))
  })

  it('GST is a flat 10% whatever the currency — an NZD project accepts 10% and refuses 15%', async () => {
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'nz1', COMPANY_A, PROJECT_NOCUR), claimPayload(USERS.qs, { currency: 'NZD' })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'nz2', COMPANY_A, PROJECT_NOCUR), claimPayload(USERS.qs, { currency: 'NZD', claimedGst: 150, claimedTotal: 1150 })))
  })

  it('a header that is internally consistent but unrelated to its lines is ACCEPTED (lines are unverifiable — DC36)', async () => {
    const t2 = claimTotals([5000], 0)
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'un1'), claimPayload(USERS.qs, {
      claimedSubtotal: t2.subtotal, claimedGst: t2.gst, claimedTotal: t2.total,
    })))
  })
})

// ── Draft edit ───────────────────────────────────────────────────────────────

describe('draft edit (hooks/useProgressClaims.jsx → updateProgressClaim)', () => {
  it('accepts the hook payload — content, the re-derived header, revision 2 and the audit stamps', async () => {
    await seed('e1', 'draft')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'e1'), draftEdit(USERS.qs)))
    const after = await readClaim('e1')
    expect(after.revision).toBe(2)
    expect(after.claimedSubtotal).toBe(2300)
    expect(after.status).toBe('draft')
  })

  it('accepts a second edit at revision 3, a retention equal to the subtotal, and emptied refs', async () => {
    await seed('e2', 'draft')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'e2'), draftEdit(USERS.qs)))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'e2'), draftEdit(USERS.qs, { revision: 3, retention: 2300, claimRef: '', periodEnding: '', notes: '' })))
  })

  it('a document written before ADR-58 (no updatedAt / updatedBy / *By keys) is editable and acquires the stamps', async () => {
    await seed('e3', 'draft', USERS.admin, {}, { legacy: true })
    expect('updatedBy' in (await readClaim('e3'))).toBe(false)
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'e3'), draftEdit(USERS.pm)))
    const after = await readClaim('e3')
    expect(after.updatedBy).toBe(USERS.pm.uid)
    expect(after.revision).toBe(2)
  })

  it('refuses an edit without the audit stamps, with a forged updatedBy, or with a client-clock updatedAt', async () => {
    await seed('e4', 'draft')
    const { updatedAt: _a, updatedBy: _b, ...bare } = draftEdit(USERS.qs)   // eslint-disable-line no-unused-vars
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e4'), bare))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e4'), draftEdit(USERS.qs, { updatedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e4'), draftEdit(USERS.qs, { updatedAt: clock() })))
    }
  })

  it('refuses an edit that moves the status, touches a lifecycle stamp, an approved value or the assessment notes', async () => {
    await seed('e5', 'draft')
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, { status: 'submitted' })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, { status: 'approved' })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, { submittedAt: serverTimestamp() })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, { approvedBy: USERS.qs.uid })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, { approvedSubtotal: 1 })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, { assessmentNotes: 'x' })))
  })

  it('refuses an edit that rewrites identity — number, PO, supplier, currency, externalRefs, provenance, reserved link', async () => {
    await seed('e6', 'draft')
    for (const forged of [
      { claimNumber: 'PC-0009' }, { poId: 'po2' }, { poNumber: 'PO-0002' }, { supplierName: 'Other' }, { supplierId: 'contact9' },
      { supplierId: null }, { currency: 'NZD' }, { externalRefs: { xero: '1' } }, { createdBy: USERS.qs.uid },
      { createdAt: Timestamp.now() }, { variationId: 'sv1' },
    ]) {
      await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e6'), draftEdit(USERS.qs, forged)))
    }
  })

  it('refuses an edit that changes the line COUNT, breaks the shape or the money invariants', async () => {
    await seed('e7', 'draft')
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { lineItems: claimLines([1500, 800]).slice(0, 1) })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { lineItems: [] })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { retention: -1 })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { claimedGst: 221 })))   // net 2200 → 220
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { claimedTotal: 2420.01 })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { claimedSubtotal: 0, claimedGst: 0, claimedTotal: 0, retention: 0 })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { periodEnding: 'soon' })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { notes: 'x'.repeat(5001) })))
  })

  it('refuses a content edit on a submitted, under_review, approved, rejected or invoiced claim — the freeze after submit', async () => {
    for (const status of ['submitted', 'under_review', 'approved', 'rejected', 'invoiced']) {
      await seed(`fr-${status}`, status)
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), `fr-${status}`), draftEdit(USERS.admin)))
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), `fr-${status}`), { notes: 'late note', revision: 2, ...stamps(USERS.admin) }))
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), `fr-${status}`), { retention: 0, revision: 2, ...stamps(USERS.admin) }))
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), `fr-${status}`), { lineItems: claimLines([9999, 0]), revision: 2, ...stamps(USERS.admin) }))
    }
  })
})

// ── Revision ─────────────────────────────────────────────────────────────────

describe('revision — exactly +1 on every update', () => {
  it('the same revision, +2, a string, null or a missing revision is refused on every branch', async () => {
    for (const [status, write] of [['draft', draftEdit], ['draft', submitWrite], ['submitted', approveWrite], ['submitted', rejectWrite]]) {
      await seed('rv1', status)
      for (const revision of [1, 3, '2', null, 0]) {
        await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'rv1'), write(USERS.qs, { revision })))
      }
      const { revision: _r, ...missing } = write(USERS.qs)   // eslint-disable-line no-unused-vars
      await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'rv1'), missing))
    }
  })

  it('a stored revision of 7 takes 8 only; a legacy document with NO revision key takes 1', async () => {
    await seed('rv2', 'draft', USERS.admin, { revision: 7 })
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'rv2'), submitWrite(USERS.qs, { revision: 2 })))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'rv2'), submitWrite(USERS.qs, { revision: 8 })))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const { revision: _r, ...noRev } = { ...claimPayload(USERS.admin), createdAt: Timestamp.now(), updatedAt: Timestamp.now() }   // eslint-disable-line no-unused-vars
      await setDoc(claimRef(c.firestore(), 'rv3'), noRev)
    })
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'rv3'), submitWrite(USERS.qs, { revision: 2 })))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'rv3'), submitWrite(USERS.qs, { revision: 1 })))
  })

  it('two writers who both reviewed revision 1: the second plain update is refused (it carries 2 over a stored 2)', async () => {
    await seed('rv4', 'draft')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'rv4'), draftEdit(USERS.qs)))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'rv4'), draftEdit(USERS.pm, { toDate: [1200, 0], retention: 0 })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'rv4'), submitWrite(USERS.pm)))
    expect((await readClaim('rv4')).claimedSubtotal).toBe(2300)   // the first edit stands
  })
})

// ── Legal transitions ────────────────────────────────────────────────────────

describe('legal transitions', () => {
  it('draft → submitted, with the submit stamps', async () => {
    await seed('t1', 'draft')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 't1'), submitWrite(USERS.qs)))
    const after = await readClaim('t1')
    expect(after.status).toBe('submitted')
    expect(after.submittedBy).toBe(USERS.qs.uid)
    expect(after.revision).toBe(2)
  })

  it('submitted → approved in full, with the certified lines, the approved header and the stamps', async () => {
    await seed('t2', 'submitted')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't2'), approveWrite(USERS.pm, { assessmentNotes: 'Certified in full' })))
    const after = await readClaim('t2')
    expect(after.status).toBe('approved')
    expect(after.approvedBy).toBe(USERS.pm.uid)
    expect(after.approvedSubtotal).toBe(1000)
    expect(after.approvedGst).toBe(100)
    expect(after.approvedTotal).toBe(1100)
    expect(after.lineItems[0].approvedThisPeriod).toBe(1000)
    expect(after.claimedSubtotal).toBe(1000)   // untouched
  })

  it('submitted → approved PARTIALLY (certify less than claimed), including zero', async () => {
    await seed('t3', 'submitted')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't3'), approveWrite(USERS.pm, { amounts: [600, 0], assessmentNotes: 'Defects on bay 3' })))
    expect((await readClaim('t3')).approvedSubtotal).toBe(600)
    await seed('t4', 'submitted')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't4'), approveWrite(USERS.pm, { amounts: [0, 0] })))
    expect((await readClaim('t4')).approvedTotal).toBe(0)
  })

  it('approval with a stored retention: the retention is clamped to the approved subtotal, never rewritten', async () => {
    // claimed 1000, retention 300 → certify 200: retained = min(300, 200) = 200, net 0, gst 0, total 0
    await seed('t5', 'submitted', USERS.admin, { retention: 300, claimedGst: 70, claimedTotal: 770 })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't5'), approveWrite(USERS.pm, { amounts: [200, 0], retention: 300 })))
    const after = await readClaim('t5')
    expect(after.retention).toBe(300)
    expect(after.approvedTotal).toBe(0)
    // and certify 800: retained 300, net 500, gst 50, total 550
    await seed('t6', 'submitted', USERS.admin, { retention: 300, claimedGst: 70, claimedTotal: 770 })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't6'), approveWrite(USERS.pm, { amounts: [800, 0], retention: 300 })))
    expect((await readClaim('t6')).approvedTotal).toBe(550)
  })

  it('under_review → approved and → rejected (a reserved status already stored is not stranded)', async () => {
    await seed('t7', 'under_review')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't7'), approveWrite(USERS.pm)))
    await seed('t8', 'under_review')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't8'), rejectWrite(USERS.pm)))
  })

  it('draft → rejected (withdrawal, no notes) and submitted → rejected (with notes)', async () => {
    await seed('t9', 'draft')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 't9'), rejectWrite(USERS.qs)))
    await seed('t10', 'submitted')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't10'), rejectWrite(USERS.pm, { assessmentNotes: 'Not due yet' })))
    expect((await readClaim('t10')).assessmentNotes).toBe('Not due yet')
  })

  it('the creator may submit AND approve their own claim — self-approval is permitted (separation of duties is not approved)', async () => {
    await seed('t11', 'draft', USERS.qs)
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 't11'), submitWrite(USERS.qs)))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 't11'), approveWrite(USERS.qs, { revision: 3 })))
  })

  it('a claim written before ADR-58 can be submitted, approved and rejected — the *By stamps are added, nothing else is required of it', async () => {
    await seed('t12', 'draft', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 't12'), submitWrite(USERS.qs)))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't12'), approveWrite(USERS.pm, { revision: 3 })))
    const after = await readClaim('t12')
    expect(after.submittedBy).toBe(USERS.qs.uid)
    expect(after.approvedBy).toBe(USERS.pm.uid)
    await seed('t13', 'submitted', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't13'), rejectWrite(USERS.pm)))
    expect((await readClaim('t13')).rejectedBy).toBe(USERS.pm.uid)
  })

  it('a legacy submitted claim with a NEGATIVE retention (the characterised pre-ADR-58 state) still approves exactly as claimTotals computes it', async () => {
    // claimed 1000, retention −50 → claimTotals: retained −50, net 1050, gst 105, total 1155
    const ct = claimTotals([1000, 0], -50)
    await seed('t14', 'submitted', USERS.admin, { retention: ct.retention, claimedGst: ct.gst, claimedTotal: ct.total }, { legacy: true })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't14'), approveWrite(USERS.pm, { amounts: [1000, 0], retention: -50 })))
    expect((await readClaim('t14')).approvedTotal).toBe(1155)
    // and on a negative half-cent boundary: certify 0.05 with retention −40.10 → net −… no: net = 0.05 + 40.10 = 40.15
    const ct2 = claimTotals([0.05, 0], -40.1)
    await seed('t15', 'submitted', USERS.admin, { retention: -40.1, claimedGst: ct2.gst, claimedTotal: ct2.total }, { legacy: true })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't15'), approveWrite(USERS.pm, { amounts: [0.05, 0], retention: -40.1 })))
  })

  it('a legacy document with NO externalRefs key and NO supplierId key still takes every write', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const { externalRefs: _e, supplierId: _s, submittedBy: _sb, rejectedBy: _rb, updatedAt: _ua, updatedBy: _ub, ...rest } =   // eslint-disable-line no-unused-vars
        { ...claimPayload(USERS.admin), createdAt: Timestamp.now() }
      await setDoc(claimRef(c.firestore(), 't16'), rest)
    })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 't16'), draftEdit(USERS.qs)))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 't16'), submitWrite(USERS.qs, { revision: 3 })))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 't16'), approveWrite(USERS.pm, { revision: 4, amounts: [1500, 800], lines: claimLines([1500, 800]), retention: 100 })))
  })
})

// ── Illegal transitions ──────────────────────────────────────────────────────

describe('illegal transitions', () => {
  it('draft → approved (skipping submit), → under_review and → invoiced (reserved — nothing enters them) are refused', async () => {
    await seed('i1', 'draft')
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i1'), approveWrite(USERS.pm)))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i1'), { status: 'under_review', revision: 2, ...stamps(USERS.pm) }))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i1'), { status: 'invoiced', invoicedAt: serverTimestamp(), revision: 2, ...stamps(USERS.pm) }))
    // A bare re-stamp of a DRAFT (status unchanged) is an EMPTY draft edit and
    // moves nothing — the ADR-57 PO precedent; it still costs a revision.
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'i1'), { status: 'draft', revision: 2, ...stamps(USERS.pm) }))
    expect(await readStatus('i1')).toBe('draft')
    expect((await readClaim('i1')).revision).toBe(2)
  })

  it('submitted → draft, → submitted (re-stamp), → under_review, → invoiced', async () => {
    await seed('i2', 'submitted')
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i2'), { status: 'draft', submittedAt: null, submittedBy: null, revision: 2, ...stamps(USERS.pm) }))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i2'), submitWrite(USERS.pm)))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i2'), { status: 'under_review', revision: 2, ...stamps(USERS.pm) }))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i2'), { status: 'invoiced', invoicedAt: serverTimestamp(), revision: 2, ...stamps(USERS.pm) }))
    expect(await readStatus('i2')).toBe('submitted')
  })

  it('approved is terminal by rules — no reopen, no re-approve, no reject, and the reserved → invoiced is unauthorable', async () => {
    await seed('i3', 'approved')
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i3'), { status: 'draft', revision: 2, ...stamps(USERS.pm) }))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i3'), { status: 'submitted', revision: 2, ...stamps(USERS.pm) }))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i3'), approveWrite(USERS.pm, { amounts: [500, 0] })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i3'), rejectWrite(USERS.pm)))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'i3'), { status: 'invoiced', invoicedAt: serverTimestamp(), revision: 2, ...stamps(USERS.pm) }))
    expect(await readStatus('i3')).toBe('approved')
  })

  it('rejected and invoiced are terminal — no revival to any status', async () => {
    for (const status of ['rejected', 'invoiced']) {
      await seed(`i4-${status}`, status)
      for (const target of ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'invoiced']) {
        await assertFails(updateDoc(claimRef(ctx(USERS.admin), `i4-${status}`), { status: target, revision: 2, ...stamps(USERS.admin) }))
      }
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), `i4-${status}`), submitWrite(USERS.admin)))
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), `i4-${status}`), approveWrite(USERS.admin)))
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), `i4-${status}`), rejectWrite(USERS.admin)))
      expect(await readStatus(`i4-${status}`)).toBe(status)
    }
  })

  it('an unknown status is unauthorable from every state', async () => {
    for (const status of ['draft', 'submitted', 'under_review', 'approved']) {
      await seed(`i5-${status}`, status)
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), `i5-${status}`), { status: 'certified', revision: 2, ...stamps(USERS.admin) }))
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), `i5-${status}`), { status: null, revision: 2, ...stamps(USERS.admin) }))
    }
  })

  it('a draft with no lines cannot be submitted — there is nothing to freeze', async () => {
    await seed('i6', 'draft', USERS.admin, { lineItems: [] })
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'i6'), submitWrite(USERS.qs)))
  })
})

// ── Transition purity ────────────────────────────────────────────────────────

describe('transition purity — stamps only, actor == caller, time == server', () => {
  const smuggled = [
    { notes: 'late' }, { retention: 50 }, { claimedSubtotal: 1 }, { claimedGst: 0.1 }, { claimedTotal: 1.1 },
    { lineItems: claimLines([5000, 0]) }, { claimRef: 'X' }, { periodEnding: '2027-01-01' },
    { supplierName: 'Other' }, { poId: 'po2' }, { claimNumber: 'PC-0099' }, { currency: 'NZD' },
    { approvedSubtotal: 1 }, { assessmentNotes: 'note' },
  ]

  it('submit carries no content change — fourteen kinds of smuggled content refused', async () => {
    await seed('p1', 'draft')
    for (const extra of smuggled) {
      await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p1'), submitWrite(USERS.qs, extra)))
    }
    expect(await readStatus('p1')).toBe('draft')
  })

  it('reject carries no content change beyond the optional notes', async () => {
    await seed('p2', 'submitted')
    for (const extra of smuggled.filter(e => !('assessmentNotes' in e))) {
      await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p2'), rejectWrite(USERS.pm, extra)))
    }
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p2'), rejectWrite(USERS.pm, { assessmentNotes: 'x'.repeat(5001) })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p2'), rejectWrite(USERS.pm, { assessmentNotes: null })))
  })

  it('approve may not touch the claimed header, the retention, the content or the identity', async () => {
    await seed('p3', 'submitted')
    for (const extra of [
      { claimedSubtotal: 900, approvedSubtotal: 900, approvedGst: 90, approvedTotal: 990 },   // lower the claimed figure to fit
      { retention: 50 }, { notes: 'x' }, { claimRef: 'X' }, { periodEnding: '2027-01-01' },
      { supplierName: 'Other' }, { poId: 'po2' }, { supplierId: 'contact2' }, { currency: 'NZD' }, { claimNumber: 'PC-0099' },
      { submittedAt: serverTimestamp() }, { submittedBy: USERS.pm.uid }, { rejectedAt: serverTimestamp() }, { invoicedAt: serverTimestamp() },
    ]) {
      await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p3'), approveWrite(USERS.pm, extra)))
    }
    expect(await readStatus('p3')).toBe('submitted')
  })

  it('a transition may not touch another transition’s stamps', async () => {
    await seed('p4', 'draft')
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p4'), submitWrite(USERS.qs, { approvedAt: serverTimestamp() })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p4'), submitWrite(USERS.qs, { rejectedBy: USERS.qs.uid })))
    await seed('p5', 'submitted')
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p5'), approveWrite(USERS.pm, { rejectedAt: serverTimestamp() })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p5'), rejectWrite(USERS.pm, { approvedAt: serverTimestamp() })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p5'), rejectWrite(USERS.pm, { submittedBy: USERS.qs.uid })))
  })

  it('forged actor — submittedBy / approvedBy / rejectedBy must be the caller', async () => {
    await seed('p6', 'draft')
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p6'), submitWrite(USERS.qs, { submittedBy: USERS.admin.uid })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p6'), submitWrite(USERS.qs, { submittedBy: null })))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p6'), rejectWrite(USERS.qs, { rejectedBy: USERS.admin.uid })))
    await seed('p7', 'submitted')
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p7'), approveWrite(USERS.pm, { approvedBy: USERS.admin.uid })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p7'), approveWrite(USERS.pm, { approvedBy: null })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p7'), rejectWrite(USERS.pm, { rejectedBy: USERS.admin.uid })))
  })

  it('forged time — three skewed client clocks on each transition stamp and on updatedAt', async () => {
    for (const clock of CLIENT_CLOCKS) {
      await seed('p8', 'draft')
      await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p8'), submitWrite(USERS.qs, { submittedAt: clock() })))
      await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p8'), submitWrite(USERS.qs, { updatedAt: clock() })))
      await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p8'), rejectWrite(USERS.qs, { rejectedAt: clock() })))
      await seed('p9', 'submitted')
      await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p9'), approveWrite(USERS.pm, { approvedAt: clock() })))
      await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p9'), approveWrite(USERS.pm, { updatedAt: clock() })))
      await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p9'), rejectWrite(USERS.pm, { updatedAt: clock() })))
    }
  })

  it('a transition without the audit stamps, or with a forged updatedBy, is refused', async () => {
    await seed('p10', 'draft')
    const { updatedAt: _a, updatedBy: _b, ...bare } = submitWrite(USERS.qs)   // eslint-disable-line no-unused-vars
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p10'), bare))
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'p10'), submitWrite(USERS.qs, { updatedBy: USERS.admin.uid })))
    await seed('p11', 'submitted')
    const { updatedAt: _c, updatedBy: _d, ...bareApprove } = approveWrite(USERS.pm)   // eslint-disable-line no-unused-vars
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p11'), bareApprove))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'p11'), approveWrite(USERS.pm, { updatedBy: USERS.admin.uid })))
  })
})

// ── Approval money ───────────────────────────────────────────────────────────

describe('approval money — approved header in whole cents, never above the claimed subtotal', () => {
  it('approvedSubtotal may not exceed the STORED claimedSubtotal — one cent over is refused', async () => {
    await seed('am1', 'submitted')   // claimed 1000
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am1'), approveWrite(USERS.pm, { amounts: [1000.01, 0] })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am1'), approveWrite(USERS.pm, { amounts: [1000, 500] })))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'am1'), approveWrite(USERS.pm, { amounts: [1000, 0] })))
  })

  it('refuses a negative approved subtotal and non-numeric approved money', async () => {
    await seed('am2', 'submitted')
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am2'), approveWrite(USERS.pm, { approvedSubtotal: -1, approvedGst: -0.1, approvedTotal: -1.1 })))
    for (const k of ['approvedSubtotal', 'approvedGst', 'approvedTotal']) {
      for (const v of [null, '100', true]) {
        await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am2'), approveWrite(USERS.pm, { [k]: v })))
      }
    }
  })

  it('approved gst must be 10% of (approvedSubtotal − clamped retention) and the total exact — one cent either way is refused', async () => {
    await seed('am3', 'submitted')
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am3'), approveWrite(USERS.pm, { amounts: [600, 0], approvedGst: 60.01, approvedTotal: 660.01 })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am3'), approveWrite(USERS.pm, { amounts: [600, 0], approvedGst: 59.99, approvedTotal: 659.99 })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am3'), approveWrite(USERS.pm, { amounts: [600, 0], approvedTotal: 660.01 })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am3'), approveWrite(USERS.pm, { amounts: [600, 0], approvedGst: 0, approvedTotal: 600 })))
    // with retention 300 stored: certify 600 → net 300 → gst 30, total 330; the PO formula (gst 60) is refused
    await seed('am4', 'submitted', USERS.admin, { retention: 300, claimedGst: 70, claimedTotal: 770 })
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am4'), approveWrite(USERS.pm, { amounts: [600, 0], retention: 0 })))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'am4'), approveWrite(USERS.pm, { amounts: [600, 0], retention: 300 })))
  })

  it('on a half-cent boundary the approved gst accepts half-up or one cent below, like the claimed side', async () => {
    const lines = claimLines([40.15, 0])
    const ct = claimTotals([40.15, 0], 0)
    await seed('am5', 'submitted', USERS.admin, { lineItems: lines, claimedSubtotal: ct.subtotal, claimedGst: ct.gst, claimedTotal: ct.total })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'am5'), approveWrite(USERS.pm, { amounts: [40.15, 0], lines, approvedGst: 4.02, approvedTotal: 44.17 })))
    await seed('am6', 'submitted', USERS.admin, { lineItems: lines, claimedSubtotal: ct.subtotal, claimedGst: ct.gst, claimedTotal: ct.total })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'am6'), approveWrite(USERS.pm, { amounts: [40.15, 0], lines, approvedGst: 4.01, approvedTotal: 44.16 })))
    await seed('am7', 'submitted', USERS.admin, { lineItems: lines, claimedSubtotal: ct.subtotal, claimedGst: ct.gst, claimedTotal: ct.total })
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am7'), approveWrite(USERS.pm, { amounts: [40.15, 0], lines, approvedGst: 4.03, approvedTotal: 44.18 })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am7'), approveWrite(USERS.pm, { amounts: [40.15, 0], lines, approvedGst: 4.00, approvedTotal: 44.15 })))
  })

  it('the certified line COUNT is pinned; the line CONTENTS are not (an approvedThisPeriod above its line is ACCEPTED — DC36)', async () => {
    await seed('am8', 'submitted')
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am8'), approveWrite(USERS.pm, { lineItems: [{ ...DEFAULT_LINES[0], approvedThisPeriod: 1000 }] })))
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'am8'), approveWrite(USERS.pm, { lineItems: [] })))
    // Per-line over-certification that still sums under the claimed subtotal passes the scalar rule.
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'am8'), approveWrite(USERS.pm, {
      amounts: [0, 900], lineItems: [{ ...DEFAULT_LINES[0], approvedThisPeriod: 0 }, { ...DEFAULT_LINES[1], approvedThisPeriod: 900 }],
    })))
  })
})

// ── Direct SDK bypass attempts ───────────────────────────────────────────────

describe('direct SDK bypass attempts', () => {
  it('cannot create a claim already submitted or approved, against no PO, or against another supplier’s PO', async () => {
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'b1'), claimPayload(USERS.qs, { status: 'approved', ...approveWrite(USERS.qs, { revision: 1 }), submittedAt: serverTimestamp(), submittedBy: USERS.qs.uid })))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'b2'), claimPayload(USERS.qs, { poId: 'none' })))
    await seedPo('poOther', 'sent', { supplierName: 'Rival Co', supplierId: 'contact9' })
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'b3'), claimPayload(USERS.qs, { poId: 'poOther' })))
  })

  it('cannot rewrite a submitted claim’s lines, totals or supplier with a full-document setDoc', async () => {
    await seed('b4', 'submitted')
    const live = await readClaim('b4')
    const { id: _id, ...stored } = live   // eslint-disable-line no-unused-vars
    await assertFails(setDoc(claimRef(ctx(USERS.admin), 'b4'), { ...stored, lineItems: claimLines([9000, 0]), claimedSubtotal: 9000, claimedGst: 900, claimedTotal: 9900, revision: 2, ...stamps(USERS.admin) }))
    await assertFails(setDoc(claimRef(ctx(USERS.admin), 'b4'), { ...stored, supplierName: 'Rival Co', revision: 2, ...stamps(USERS.admin) }))
    await assertFails(setDoc(claimRef(ctx(USERS.admin), 'b4'), { ...stored, poId: 'po2', revision: 2, ...stamps(USERS.admin) }))
    expect((await readClaim('b4')).claimedSubtotal).toBe(1000)
  })

  it('cannot move an approved claim’s cost to another PO, supplier, company or project, nor change its certified value', async () => {
    await seed('b5', 'approved')
    const { id: _id, ...stored } = await readClaim('b5')   // eslint-disable-line no-unused-vars
    for (const forged of [{ poId: 'po2' }, { poNumber: 'PO-0002' }, { supplierId: 'contact9' }, { supplierName: 'Rival Co' }, { approvedSubtotal: 5000, approvedGst: 500, approvedTotal: 5500 }, { lineItems: claimLines([9000, 0]).map(l => ({ ...l, approvedThisPeriod: 9000 })) }]) {
      await assertFails(setDoc(claimRef(ctx(USERS.admin), 'b5'), { ...stored, ...forged, revision: 2, ...stamps(USERS.admin) }))
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), 'b5'), { ...forged, revision: 2, ...stamps(USERS.admin) }))
    }
    // A copy of the approved document cannot be created under another project either (its PO is not there).
    await assertFails(setDoc(claimRef(ctx(USERS.admin), 'b5copy', COMPANY_A, PROJECT_NOCUR), { ...stored, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }))
    expect((await readClaim('b5')).approvedSubtotal).toBe(1000)
  })

  it('cannot revive a rejected claim or re-open an approved one by rewriting the whole document', async () => {
    await seed('b6', 'rejected')
    const { id: _i, ...rejected } = await readClaim('b6')   // eslint-disable-line no-unused-vars
    await assertFails(setDoc(claimRef(ctx(USERS.admin), 'b6'), { ...rejected, status: 'approved', rejectedAt: null, rejectedBy: null, approvedAt: serverTimestamp(), approvedBy: USERS.admin.uid, approvedSubtotal: 1000, approvedGst: 100, approvedTotal: 1100, revision: 2, ...stamps(USERS.admin) }))
    await assertFails(setDoc(claimRef(ctx(USERS.admin), 'b6'), { ...rejected, status: 'draft', rejectedAt: null, rejectedBy: null, revision: 2, ...stamps(USERS.admin) }))
    await seed('b7', 'approved')
    const { id: _j, ...approved } = await readClaim('b7')   // eslint-disable-line no-unused-vars
    await assertFails(setDoc(claimRef(ctx(USERS.admin), 'b7'), { ...approved, status: 'submitted', approvedAt: null, approvedBy: null, approvedSubtotal: null, approvedGst: null, approvedTotal: null, revision: 2, ...stamps(USERS.admin) }))
  })

  it('cannot strip the stamps or provenance from a document', async () => {
    await seed('b8', 'approved')
    for (const strip of [{ approvedBy: null }, { approvedAt: null }, { submittedBy: null }, { createdBy: null }, { createdAt: null }]) {
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), 'b8'), { ...strip, revision: 2, ...stamps(USERS.admin) }))
    }
  })
})

// ── Dependent collections and figures ────────────────────────────────────────

describe('the claim-to-invoice lifecycle and the M1 figures are unchanged', () => {
  const invLine = (poLineIndex, costCodeId, amount) => ({
    poLineIndex, costCodeId, costCodeName: 'cc', description: 'Slab',
    amount: roundMoney(amount), taxCode: 'gst', gstAmount: gstForLine(amount, 'gst'),
  })
  // A claim-sourced invoice paying exactly the approved claim's certified value.
  function claimInvoicePayload(user, claimId, claim) {
    const lines = claim.lineItems.map(li => invLine(li.poLineIndex, li.costCodeId, li.approvedThisPeriod || 0))
    const t = invoiceTotals(lines, claim.retention)
    return {
      invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-1', status: 'draft', docType: 'invoice', source: 'progress_claim',
      supplierId: claim.supplierId, supplierName: claim.supplierName, poId: claim.poId, poNumber: claim.poNumber,
      progressClaimId: claimId, claimNumber: claim.claimNumber,
      invoiceDate: '2026-09-05', receivedDate: '', dueDate: '', paymentTerms: null,
      lineItems: lines, retention: t.retention, retentionGst: t.retentionGst, retentionTotal: t.retentionTotal,
      subtotal: t.subtotal, gstTotal: t.gstTotal, grossTotal: t.grossTotal, net: t.net, payableGst: t.payableGst, payableTotal: t.payableTotal,
      currency: 'AUD', revision: 1, notes: '',
      approvedAt: null, approvedBy: null, postedAt: null, postedBy: null, cancelledAt: null, cancelledBy: null,
      paidAt: null, adjustsInvoiceId: null, attachments: [], externalRefs: {},
      createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    }
  }
  const siStamp = (user, status, at, by) => ({ status, [at]: serverTimestamp(), [by]: user.uid, ...stamps(user) })

  it('a claim raised, submitted and approved through the new rules is a valid progress_claim invoice source; a draft, submitted or rejected one is not', async () => {
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'd1'), claimPayload(USERS.qs)))
    let claim = await readClaim('d1')
    await assertFails(setDoc(invoiceRef(ctx(USERS.qs), 'inv0'), claimInvoicePayload(USERS.qs, 'd1', { ...claim, lineItems: claim.lineItems.map(l => ({ ...l, approvedThisPeriod: l.claimedThisPeriod })) })))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'd1'), submitWrite(USERS.qs)))
    await assertFails(setDoc(invoiceRef(ctx(USERS.qs), 'inv0'), claimInvoicePayload(USERS.qs, 'd1', { ...claim, lineItems: claim.lineItems.map(l => ({ ...l, approvedThisPeriod: l.claimedThisPeriod })) })))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'd1'), approveWrite(USERS.pm, { revision: 3 })))
    claim = await readClaim('d1')
    await assertSucceeds(setDoc(invoiceRef(ctx(USERS.qs), 'inv1'), claimInvoicePayload(USERS.qs, 'd1', claim)))
    await seed('d2', 'rejected')
    await assertFails(setDoc(invoiceRef(ctx(USERS.qs), 'inv2'), claimInvoicePayload(USERS.qs, 'd2', { ...(await readClaim('d2')), lineItems: DEFAULT_LINES.map(l => ({ ...l, approvedThisPeriod: l.claimedThisPeriod })) })))
  })

  it('posting the claim-sourced invoice needs NO write to the claim — the claim stays approved and a direct `invoiced` write is refused', async () => {
    await seed('d3', 'approved')
    const claim = await readClaim('d3')
    await assertSucceeds(setDoc(invoiceRef(ctx(USERS.qs), 'inv3'), claimInvoicePayload(USERS.qs, 'd3', claim)))
    await assertSucceeds(updateDoc(invoiceRef(ctx(USERS.qs), 'inv3'), siStamp(USERS.qs, 'approved', 'approvedAt', 'approvedBy')))
    await assertSucceeds(updateDoc(invoiceRef(ctx(USERS.qs), 'inv3'), siStamp(USERS.qs, 'posted', 'postedAt', 'postedBy')))
    expect(await readStatus('d3')).toBe('approved')
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'd3'), { status: 'invoiced', invoicedAt: serverTimestamp(), revision: 2, ...stamps(USERS.qs) }))
    // Read-time hand-over: the posted invoice replaces the claim in Actual, the claim document untouched.
    let inv
    await testEnv.withSecurityRulesDisabled(async (c) => { inv = { id: 'inv3', ...(await getDoc(invoiceRef(c.firestore(), 'inv3'))).data() } })
    const excluded = invoicedClaimIds([inv])
    expect(excluded.has('d3')).toBe(true)
    expect(actualClaimsByCostCode([claim], excluded)).toEqual({})
    expect(actualClaimsByCostCode([claim])).toEqual({ cc1: 1000, cc2: 0 })
  })

  it('M1: a claim approved through the new rules recognises its cost exactly once — Actual 1000, Remaining Committed 1500, Σ unchanged; a submitted one is pending exposure only', async () => {
    const po = { id: PO_ID, ...poDoc('sent') }
    await seed('d4', 'draft')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'd4'), submitWrite(USERS.qs)))
    let claim = await readClaim('d4')
    expect(claimedPendingByCostCode([claim])).toEqual({ cc1: 1000, cc2: 0 })
    expect(actualClaimsByCostCode([claim])).toEqual({})
    expect(committedByCostCode([po])).toEqual({ cc1: 2500, cc2: 2000 })
    expect(remainingCommittedByCostCode([po], {}, recognisedClaimsByPoLine([claim]))).toEqual({ cc1: 2500, cc2: 2000 })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'd4'), approveWrite(USERS.pm, { revision: 3 })))
    claim = await readClaim('d4')
    expect(claimedPendingByCostCode([claim])).toEqual({})
    expect(actualClaimsByCostCode([claim])).toEqual({ cc1: 1000, cc2: 0 })
    expect(recognisedClaimsByPoLine([claim])).toEqual({ [PO_ID]: { 0: 1000, 1: 0 } })
    expect(remainingCommittedByCostCode([po], {}, recognisedClaimsByPoLine([claim]))).toEqual({ cc1: 1500, cc2: 2000 })
    expect(previouslyApprovedByPoLine([claim], PO_ID)).toEqual({ 0: 1000, 1: 0 })
    // the added keys change no figure: strip them and the derivation is identical
    const { submittedBy: _s, updatedAt: _u, updatedBy: _b, rejectedBy: _r, ...legacyShape } = claim   // eslint-disable-line no-unused-vars
    expect(actualClaimsByCostCode([legacyShape])).toEqual(actualClaimsByCostCode([claim]))
    expect(remainingCommittedByCostCode([po], {}, recognisedClaimsByPoLine([legacyShape]))).toEqual(remainingCommittedByCostCode([po], {}, recognisedClaimsByPoLine([claim])))
    expect(postedInvoicedByPoLine([])).toEqual({})
  })

  it('a rejected claim contributes nothing, and a second claim on the same PO after approval seeds from the certified amounts', async () => {
    await seed('d5', 'submitted')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'd5'), rejectWrite(USERS.pm)))
    const rejected = await readClaim('d5')
    expect(actualClaimsByCostCode([rejected])).toEqual({})
    expect(claimedPendingByCostCode([rejected])).toEqual({})
    await seed('d6', 'submitted')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'd6'), approveWrite(USERS.pm, { amounts: [600, 0] })))
    const prev = previouslyApprovedByPoLine([await readClaim('d6')], PO_ID)
    expect(prev).toEqual({ 0: 600, 1: 0 })
    const second = claimLines([1000, 500], [prev[0] || 0, prev[1] || 0])   // +400 on line 0, +500 on line 1
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'd7'), claimPayload(USERS.qs, { claimNumber: 'PC-0002', lines: second })))
    expect((await readClaim('d7')).claimedSubtotal).toBe(900)
  })

  it('a claim against a PO that is later closed or cancelled still submits, approves and rejects (the PO is read at create only)', async () => {
    await seed('d8', 'draft')
    await seed('d9', 'submitted')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(poRef(c.firestore(), PO_ID), { status: 'cancelled', cancelledAt: Timestamp.now(), cancelledBy: 'u_admin' })
    })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'd8'), draftEdit(USERS.qs)))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'd8'), submitWrite(USERS.qs, { revision: 3 })))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'd9'), approveWrite(USERS.pm)))
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'd10'), claimPayload(USERS.qs, { claimNumber: 'PC-0003' })))   // but no NEW claim
  })
})

// ── The REAL guarded transactions (lib/progressClaimActions.js) ──────────────

describe('runUpdateClaimDraft / runTransitionClaim — the app’s own transactions against the real rules', () => {
  const qs = { db: null, uid: USERS.qs.uid }
  const pm = { db: null, uid: USERS.pm.uid }
  beforeEach(() => { qs.db = ctx(USERS.qs); pm.db = ctx(USERS.pm) })

  const edit = { periodEnding: '2026-09-30', claimRef: 'S-1b', notes: 'Revised', retention: '100', claimedToDate: ['1500', '800'] }
  const run = (who, fn, args) => fn({ db: who.db, claimRef: claimRef(who.db, args.id), uid: who.uid, runTransaction, serverTimestamp, ...args })

  it('a draft edit from the reviewed copy writes the rebuilt lines, the header, revision 2 and the stamps', async () => {
    await seed('x1', 'draft')
    const seen = await readClaim('x1')
    await run(qs, runUpdateClaimDraft, { id: 'x1', seen, data: edit })
    const after = await readClaim('x1')
    expect(after.revision).toBe(2)
    expect(after.claimedSubtotal).toBe(2300)
    expect(after.retention).toBe(100)
    expect(after.claimedTotal).toBe(2420)
    expect(after.updatedBy).toBe(USERS.qs.uid)
    expect(after.lineItems.map(l => l.claimedToDate)).toEqual([1500, 800])
    expect(after.lineItems.map(l => l.approvedThisPeriod)).toEqual([null, null])
  })

  it('a STALE copy (edited underneath — revision moved) is refused with nothing written; the fresh copy then saves', async () => {
    await seed('x2', 'draft')
    const seen = await readClaim('x2')
    await run(pm, runUpdateClaimDraft, { id: 'x2', seen, data: { ...edit, claimedToDate: ['1200', '0'], retention: '' } })
    const err = await expectKind(run(qs, runUpdateClaimDraft, { id: 'x2', seen, data: edit }), CLAIM_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/changed by another user/)
    expect((await readClaim('x2')).claimedSubtotal).toBe(1200)
    await run(qs, runUpdateClaimDraft, { id: 'x2', seen: await readClaim('x2'), data: edit })
    expect((await readClaim('x2')).revision).toBe(3)
  })

  it('a STALE copy (submitted underneath — status moved) is refused for an edit and names the new status', async () => {
    await seed('x3', 'draft')
    const seen = await readClaim('x3')
    await run(qs, runTransitionClaim, { id: 'x3', seen, nextStatus: CLAIM_STATUS.SUBMITTED })
    const err = await expectKind(run(pm, runUpdateClaimDraft, { id: 'x3', seen, data: edit }), CLAIM_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/now Submitted, not Draft/)
  })

  it('an invalid edit (count mismatch, below previously approved, nothing claimed, negative retention) is refused before any read', async () => {
    await seed('x4', 'draft', USERS.admin, { lineItems: claimLines([1000, 0], [500, 0]) })
    const seen = await readClaim('x4')
    for (const data of [
      { ...edit, claimedToDate: ['1500'] },
      { ...edit, claimedToDate: ['400', '0'] },
      { ...edit, claimedToDate: ['500', '0'] },
      { ...edit, retention: '-1' },
    ]) {
      await expectKind(run(qs, runUpdateClaimDraft, { id: 'x4', seen, data }), CLAIM_WRITE_ERROR.INVALID)
    }
    expect((await readClaim('x4')).revision).toBe(1)
  })

  it('submit, approve (certified amounts normalised to cents) and reject from the reviewed copies, each +1', async () => {
    await seed('x5', 'draft')
    await run(qs, runTransitionClaim, { id: 'x5', seen: await readClaim('x5'), nextStatus: CLAIM_STATUS.SUBMITTED })
    let live = await readClaim('x5')
    expect(live).toMatchObject({ status: 'submitted', submittedBy: USERS.qs.uid, revision: 2 })
    await run(pm, runTransitionClaim, { id: 'x5', seen: live, nextStatus: CLAIM_STATUS.APPROVED, extras: { approvedAmounts: ['599.999', 0], assessmentNotes: ' Minor defects ' } })
    live = await readClaim('x5')
    expect(live).toMatchObject({ status: 'approved', approvedBy: USERS.pm.uid, revision: 3, approvedSubtotal: 600, approvedGst: 60, approvedTotal: 660, assessmentNotes: 'Minor defects' })
    expect(live.lineItems[0].approvedThisPeriod).toBe(600)
    await seed('x6', 'submitted')
    await run(pm, runTransitionClaim, { id: 'x6', seen: await readClaim('x6'), nextStatus: CLAIM_STATUS.REJECTED, extras: { assessmentNotes: 'Not due' } })
    expect(await readClaim('x6')).toMatchObject({ status: 'rejected', rejectedBy: USERS.pm.uid, revision: 2, assessmentNotes: 'Not due' })
  })

  it('a STALE assessment (approved underneath) is refused with nothing written — the second assessor never overwrites the first', async () => {
    await seed('x7', 'submitted')
    const seen = await readClaim('x7')
    await run(pm, runTransitionClaim, { id: 'x7', seen, nextStatus: CLAIM_STATUS.APPROVED, extras: { approvedAmounts: [1000, 0] } })
    await expectKind(run(qs, runTransitionClaim, { id: 'x7', seen, nextStatus: CLAIM_STATUS.APPROVED, extras: { approvedAmounts: [500, 0] } }), CLAIM_WRITE_ERROR.STALE)
    await expectKind(run(qs, runTransitionClaim, { id: 'x7', seen, nextStatus: CLAIM_STATUS.REJECTED }), CLAIM_WRITE_ERROR.STALE)
    expect((await readClaim('x7')).approvedSubtotal).toBe(1000)
  })

  it('an illegal move, a reserved target, an over-certification and a missing document are refused before any write', async () => {
    await seed('x8', 'submitted')
    const seen = await readClaim('x8')
    await expectKind(run(pm, runTransitionClaim, { id: 'x8', seen, nextStatus: CLAIM_STATUS.DRAFT }), CLAIM_WRITE_ERROR.INVALID)
    await expectKind(run(pm, runTransitionClaim, { id: 'x8', seen, nextStatus: CLAIM_STATUS.UNDER_REVIEW }), CLAIM_WRITE_ERROR.INVALID)
    await expectKind(run(pm, runTransitionClaim, { id: 'x8', seen, nextStatus: CLAIM_STATUS.APPROVED, extras: { approvedAmounts: [1000.01, 0] } }), CLAIM_WRITE_ERROR.INVALID)
    await expectKind(run(pm, runTransitionClaim, { id: 'x8', seen, nextStatus: CLAIM_STATUS.APPROVED, extras: { approvedAmounts: [1000] } }), CLAIM_WRITE_ERROR.INVALID)
    await seed('x9', 'approved')
    await expectKind(run(pm, runTransitionClaim, { id: 'x9', seen: await readClaim('x9'), nextStatus: CLAIM_STATUS.INVOICED }), CLAIM_WRITE_ERROR.INVALID)
    await expectKind(run(pm, runTransitionClaim, { id: 'gone', seen: { ...seen, id: 'gone' }, nextStatus: CLAIM_STATUS.APPROVED, extras: { approvedAmounts: [1000, 0] } }), CLAIM_WRITE_ERROR.MISSING)
    expect((await readClaim('x8')).revision).toBe(1)
  })

  it('a denied role is refused by the RULES as PERMISSION with nothing written', async () => {
    await seed('x10', 'draft')
    const sub = { db: ctx(USERS.sub), uid: USERS.sub.uid }
    const seen = await readClaim('x10')
    await expectKind(run(sub, runTransitionClaim, { id: 'x10', seen, nextStatus: CLAIM_STATUS.SUBMITTED }), CLAIM_WRITE_ERROR.PERMISSION)
    await expectKind(run(sub, runUpdateClaimDraft, { id: 'x10', seen, data: edit }), CLAIM_WRITE_ERROR.PERMISSION)
    expect(await readStatus('x10')).toBe('draft')
  })

  it('a legacy draft (no revision stamps) edits and submits through the transactions, acquiring the keys', async () => {
    await seed('x11', 'draft', USERS.admin, {}, { legacy: true })
    const seen = await readClaim('x11')
    await run(qs, runUpdateClaimDraft, { id: 'x11', seen, data: edit })
    await run(qs, runTransitionClaim, { id: 'x11', seen: await readClaim('x11'), nextStatus: CLAIM_STATUS.SUBMITTED })
    expect(await readClaim('x11')).toMatchObject({ status: 'submitted', revision: 3, submittedBy: USERS.qs.uid, updatedBy: USERS.qs.uid })
  })
})

// ── NOT enforced — the honest ceiling ────────────────────────────────────────

describe('NOT ENFORCED by rules — proven, so the ceiling is documented (DC36)', () => {
  it('a SECOND open claim on the same PO is ACCEPTED (one-open-claim is the client’s — no sibling reads)', async () => {
    await seed('n1', 'submitted')
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'n2'), claimPayload(USERS.qs, { claimNumber: 'PC-0002' })))
  })

  it('lineItems CONTENTS are unverified — junk elements, a wrong poLineIndex, a bogus cost code and a negative line are ACCEPTED', async () => {
    const junk = [{ foo: 'bar' }, { poLineIndex: 9, costCodeId: 'ccX', claimedThisPeriod: -5, approvedThisPeriod: 99999 }]
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'n3'), claimPayload(USERS.qs, { lineItems: junk })))
  })

  it('claimedSubtotal need not equal Σ claimedThisPeriod, and cumulative claiming above the PO line is ACCEPTED (warn-only in the app)', async () => {
    const t = claimTotals([99999], 0)
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'n4'), claimPayload(USERS.qs, { claimedSubtotal: t.subtotal, claimedGst: t.gst, claimedTotal: t.total })))
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'n5'), claimPayload(USERS.qs, { claimNumber: 'PC-0002', lines: claimLines([25000, 0]) })))
  })

  it('creator == approver is ACCEPTED (self-approval permitted by decision); duplicate claim numbers are ACCEPTED (the counter is client-written — DC6)', async () => {
    await seed('n6', 'submitted', USERS.qs)
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'n6'), approveWrite(USERS.qs)))
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'n7'), claimPayload(USERS.qs, { claimNumber: 'PC-0001' })))
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'n8'), claimPayload(USERS.qs, { claimNumber: 'PC-0001' })))
  })

  it('the mixed-mode overlap is ACCEPTED — a claim on a PO line a direct invoice already prices (DC34)', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(invoiceRef(c.firestore(), 'direct1'), { status: 'posted', source: 'direct_po', poId: PO_ID, progressClaimId: null, lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', amount: 500 }] })
    })
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'n9'), claimPayload(USERS.qs)))
  })

  it('a direct-SDK caller who reads first and writes stored + 1 passes the revision rule — the stale guard is rules-ASSISTED, not rules-proven', async () => {
    await seed('n10', 'draft')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'n10'), draftEdit(USERS.qs)))               // revision 2
    const live = await readClaim('n10')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'n10'), draftEdit(USERS.pm, { toDate: [1200, 0], retention: 0, revision: live.revision + 1 })))
    expect((await readClaim('n10')).claimedSubtotal).toBe(1200)
  })

  it('a claimed line below its previously approved amount (negative claimedThisPeriod) is ACCEPTED when the header still balances', async () => {
    const lines = [{ ...DEFAULT_LINES[0], previouslyApproved: 1500, claimedToDate: 1000, claimedThisPeriod: -500 }, { ...DEFAULT_LINES[1], claimedToDate: 1500, claimedThisPeriod: 1500 }]
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'n11'), claimPayload(USERS.qs, { lines })))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// M3-B2 (ADR-63) — variation-origin claim lines: the `variationLineCount`
// header, the count pin (PO lines + count), the first/last-line shape pins
// that stop a pre-M3-B2 client rewriting variation lines onto PO line 0, and
// what stays client-only (DC40).
// ═════════════════════════════════════════════════════════════════════════════

const VAR_ROW = { variationId: 'svScoped', variationNumber: 'SV-0007', lineIndex: 0, amount: 4000, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'New scope' }
const VAR_ROW_2 = { ...VAR_ROW, variationId: 'svOther', variationNumber: 'SV-0008', lineIndex: 2, amount: 1500, costCodeId: 'cc2', costCodeName: '05-200 — Steel' }
const varLine = (toDate = 2000, prev = 0, row = VAR_ROW) => buildVariationClaimLine(row, { previouslyApproved: prev, claimedToDate: toDate })
// A claim with the two PO lines and one variation-origin line after them.
const VAR_LINES = [...claimLines([1000, 0]), varLine(2000)]
const varPayload = (user, extra = {}) => claimPayload(user, { lines: VAR_LINES, variationLineCount: 1, ...extra })
// hooks → draftUpdate over STORED lines: identity preserved, amounts re-authored.
function varDraftEdit(user, { lines = [...claimLines([1500, 800]), varLine(3000)], retention = 0, revision = 2, ...extra } = {}) {
  const t = claimTotals(lines.map(li => li.claimedThisPeriod), retention)
  return { claimRef: 'S-1b', periodEnding: '2026-09-30', notes: 'Revised', lineItems: lines, retention: t.retention, claimedSubtotal: t.subtotal, claimedGst: t.gst, claimedTotal: t.total, revision, ...stamps(user), ...extra }
}
// What a pre-M3-B2 client's buildClaimLine would write for the variation line:
// `poLineIndex` coerced to 0, the variation keys dropped.
const oldClientRebuild = (li) => {
  const { variationId, variationNumber, variationLineIndex, variationLineTotal, ...rest } = li   // eslint-disable-line no-unused-vars
  return { ...rest, poLineIndex: 0, poLineTotal: 0 }
}

describe('ADR-63 — create with variation-origin lines', () => {
  it('every financial role creates a claim with PO lines + one variation line when the count says 1; the header and line identity are stored as written', async () => {
    for (const user of FINANCIAL) {
      await assertSucceeds(setDoc(claimRef(ctx(user), `v_${user.uid}`), varPayload(user)))
      const c = await readClaim(`v_${user.uid}`)
      expect(c.variationLineCount).toBe(1)
      expect(c.variationId).toBeNull()
      expect(c.lineItems[2]).toMatchObject({ poLineIndex: null, variationId: 'svScoped', variationLineIndex: 0, variationLineTotal: 4000 })
    }
    // Several variation lines, from several variations, in one claim.
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'multi'), claimPayload(USERS.qs, { lines: [...claimLines([1000, 0]), varLine(2000), varLine(500, 0, VAR_ROW_2)], variationLineCount: 2 })))
  })

  it('FINAL RULES — a create WITHOUT the variationLineCount key (the M3-B1 bundle) is refused; a negative, fractional or string count is refused', async () => {
    const noKey = claimPayload(USERS.qs)
    delete noKey.variationLineCount
    await assertFails(setDoc(claimRef(ctx(USERS.qs), 'nk'), noKey))
    for (const bad of [-1, 1.5, '1', null]) {
      await assertFails(setDoc(claimRef(ctx(USERS.qs), 'bad'), claimPayload(USERS.qs, { variationLineCount: bad })))
    }
  })

  it('the count pin: PO lines + variationLineCount must equal the line count — a variation line without its count, a count without its line, and a wrong count are refused', async () => {
    const db = ctx(USERS.qs)
    await assertFails(setDoc(claimRef(db, 'p1'), claimPayload(USERS.qs, { lines: VAR_LINES, variationLineCount: 0 })))
    await assertFails(setDoc(claimRef(db, 'p2'), claimPayload(USERS.qs, { lines: VAR_LINES, variationLineCount: 2 })))
    await assertFails(setDoc(claimRef(db, 'p3'), claimPayload(USERS.qs, { variationLineCount: 1 })))
    await assertFails(setDoc(claimRef(db, 'p4'), claimPayload(USERS.qs, { lines: claimLines([1000, 0]).slice(0, 1), variationLineCount: 1 })))
  })

  it('the shape pins: the first and last variation lines must carry a null poLineIndex and a string variationId; with count 0 the last line must carry no variationId', async () => {
    const db = ctx(USERS.qs)
    await assertFails(setDoc(claimRef(db, 's1'), varPayload(USERS.qs, { lines: [...claimLines([1000, 0]), oldClientRebuild(varLine(2000))] })))
    await assertFails(setDoc(claimRef(db, 's2'), varPayload(USERS.qs, { lines: [...claimLines([1000, 0]), { ...varLine(2000), poLineIndex: 0 }] })))
    await assertFails(setDoc(claimRef(db, 's3'), varPayload(USERS.qs, { lines: [...claimLines([1000, 0]), { ...varLine(2000), variationId: null }] })))
    await assertFails(setDoc(claimRef(db, 's4'), varPayload(USERS.qs, { lines: [...claimLines([1000, 0]), { ...varLine(2000), variationId: 7 }] })))
    // Count 2: the FIRST variation line (index size − 2) is pinned too.
    await assertFails(setDoc(claimRef(db, 's5'), claimPayload(USERS.qs, { lines: [...claimLines([1000, 0]), oldClientRebuild(varLine(2000)), varLine(500, 0, VAR_ROW_2)], variationLineCount: 2 })))
    // Count 0 but the last line carries a variation id → refused.
    await assertFails(setDoc(claimRef(db, 's6'), claimPayload(USERS.qs, { lines: [claimLines([1000, 0])[0], { ...varLine(2000) }], variationLineCount: 0 })))
  })
})

describe('ADR-63 — OLD-CLIENT PROTECTION on update: a pre-M3-B2 draft edit cannot move variation lines onto PO line 0', () => {
  const t = claimTotals(VAR_LINES.map(li => li.claimedThisPeriod), 0)
  const seedVar = (id, status = 'draft', extra = {}) =>
    seed(id, status, USERS.admin, { lineItems: VAR_LINES, variationLineCount: 1, claimedSubtotal: t.subtotal, claimedGst: t.gst, claimedTotal: t.total, ...extra })

  it('the NEW bundle’s draft edit (identity preserved, amounts re-authored) passes; the OLD bundle’s rebuild (variation line → PO line 0, keys dropped) is REFUSED with nothing written', async () => {
    await seedVar('e1')
    const db = ctx(USERS.qs)
    const oldShape = varDraftEdit(USERS.qs, { lines: [...claimLines([1500, 800]), oldClientRebuild(varLine(3000))] })
    await assertFails(updateDoc(claimRef(db, 'e1'), oldShape))
    const before = await readClaim('e1')
    expect(before.revision).toBe(1)
    expect(before.lineItems[2].variationId).toBe('svScoped')
    await assertSucceeds(updateDoc(claimRef(db, 'e1'), varDraftEdit(USERS.qs)))
    const after = await readClaim('e1')
    expect(after.lineItems[2]).toMatchObject({ poLineIndex: null, variationId: 'svScoped', variationLineIndex: 0, claimedToDate: 3000 })
    expect(after.variationLineCount).toBe(1)
  })

  it('a draft edit that re-points the variation line (another variation id or line index) or drops/changes the count is refused', async () => {
    await seedVar('e2')
    const db = ctx(USERS.qs)
    await assertFails(updateDoc(claimRef(db, 'e2'), varDraftEdit(USERS.qs, { lines: [...claimLines([1500, 800]), { ...varLine(3000), variationId: 'svOther' }] })))
    await assertFails(updateDoc(claimRef(db, 'e2'), varDraftEdit(USERS.qs, { lines: [...claimLines([1500, 800]), { ...varLine(3000), variationLineIndex: 1 }] })))
    await assertFails(updateDoc(claimRef(db, 'e2'), varDraftEdit(USERS.qs, { variationLineCount: 0 })))
    await assertFails(updateDoc(claimRef(db, 'e2'), varDraftEdit(USERS.qs, { variationLineCount: 2 })))
    expect((await readClaim('e2')).revision).toBe(1)
  })

  it('approval preserves the identity: the certified lines keep the variation keys; an approve that rewrites them is refused', async () => {
    await seedVar('a1', 'submitted')
    const approvedLines = VAR_LINES.map((li, idx) => ({ ...li, approvedThisPeriod: [1000, 0, 2000][idx] }))
    const tt = claimTotals([1000, 0, 2000], 0)
    const good = { status: 'approved', lineItems: approvedLines, approvedSubtotal: tt.subtotal, approvedGst: tt.gst, approvedTotal: tt.total, assessmentNotes: '', approvedAt: serverTimestamp(), approvedBy: USERS.pm.uid, revision: 2, ...stamps(USERS.pm) }
    const rewritten = { ...good, lineItems: [approvedLines[0], approvedLines[1], oldClientRebuild(approvedLines[2])] }
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'a1'), rewritten))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'a1'), good))
    const c = await readClaim('a1')
    expect(c.lineItems[2]).toMatchObject({ variationId: 'svScoped', variationLineIndex: 0, approvedThisPeriod: 2000 })
    // The recognition selectors key the certified amount by the VARIATION line, never PO line 0.
    expect(recognisedClaimsByVariationLine([c])).toEqual({ svScoped: { 0: 2000 } })
    expect(recognisedClaimsByPoLine([c])).toEqual({ [PO_ID]: { 0: 1000, 1: 0 } })
    expect(previouslyApprovedByVariationLine([c])).toEqual({ svScoped: { 0: 2000 } })
    expect(previouslyApprovedByPoLine([c], PO_ID)).toEqual({ 0: 1000, 1: 0 })
  })

  // A LEGACY claim: no variationLineCount key (every pre-M3-B2 document), PO
  // lines only, no audit stamps — absent reads 0 on every path.
  const seedLegacyNoCount = async (id, status) => {
    await seed(id, status, USERS.admin, {}, { legacy: true })
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const { deleteField } = await import('firebase/firestore')
      await updateDoc(doc(c.firestore(), claimsPath(), id), { variationLineCount: deleteField() })
    })
    expect(await readClaim(id)).not.toHaveProperty('variationLineCount')
  }

  it('a LEGACY claim (no variationLineCount key, PO lines only) still EDITS — absent reads 0, never backfilled', async () => {
    await seedLegacyNoCount('legE', 'draft')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'legE'), draftEdit(USERS.qs)))
    expect(await readClaim('legE')).not.toHaveProperty('variationLineCount')
  })

  it('a LEGACY claim (no variationLineCount key) still SUBMITS', async () => {
    await seedLegacyNoCount('legS', 'draft')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'legS'), submitWrite(USERS.qs)))
  })

  it('a LEGACY claim (no variationLineCount key) still APPROVES — the certified lines keep their PO identity', async () => {
    await seedLegacyNoCount('legA', 'submitted')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'legA'), approveWrite(USERS.pm)))
    const c = await readClaim('legA')
    expect(c.status).toBe('approved')
    expect(c).not.toHaveProperty('variationLineCount')
  })

  it('the app’s runUpdateClaimDraft over a claim with a variation line passes the real rules and keeps the identity', async () => {
    await seedVar('tx')
    const db = ctx(USERS.qs)
    const seen = await readClaim('tx')
    await runUpdateClaimDraft({
      db, claimRef: claimRef(db, 'tx'), seen, data: { periodEnding: '2026-09-30', claimRef: 'S-2', notes: '', retention: 0, claimedToDate: ['1200', '0', '3500'] },
      uid: USERS.qs.uid, runTransaction, serverTimestamp,
    })
    const after = await readClaim('tx')
    expect(after.revision).toBe(2)
    expect(after.lineItems[2]).toMatchObject({ poLineIndex: null, variationId: 'svScoped', variationLineIndex: 0, variationLineTotal: 4000, claimedToDate: 3500, claimedThisPeriod: 3500 })
  })
})

describe('ADR-63 — NOT enforced by rules (Deferred Control 40)', () => {
  it('rules cannot see whether the variation exists, is approved, scope-committed, on this PO, positive, or matches the cost code and ceiling — a create naming a NONEXISTENT variation with a wrong cost code and ceiling is ACCEPTED (the create transaction and SHIELD check 4 condition H are the controls)', async () => {
    const forged = varLine(2000, 0, { ...VAR_ROW, variationId: 'svNowhere', amount: 999_999, costCodeId: 'cc9', costCodeName: 'Wrong' })
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'f1'), claimPayload(USERS.qs, { lines: [...claimLines([1000, 0]), forged], variationLineCount: 1 })))
  })

  it('rules pin only the FIRST and LAST variation lines: with three variation lines the middle one can be malformed and is ACCEPTED (the client identity check refuses it)', async () => {
    const middle = { ...varLine(10, 0, VAR_ROW_2), poLineIndex: 0, variationId: undefined }
    delete middle.variationId
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'f2'), claimPayload(USERS.qs, { lines: [...claimLines([1000, 0]), varLine(2000), middle, varLine(5, 0, { ...VAR_ROW_2, lineIndex: 3 })], variationLineCount: 3 })))
  })

  it('a duplicated variation line in one claim is ACCEPTED by rules (sourceLineIdentityError refuses it in the app)', async () => {
    await assertSucceeds(setDoc(claimRef(ctx(USERS.qs), 'f3'), claimPayload(USERS.qs, { lines: [...claimLines([1000, 0]), varLine(2000), varLine(2000)], variationLineCount: 2 })))
  })
})
