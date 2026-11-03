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
  doc, collection, query, where, orderBy, getDoc, getDocs, getDocFromServer, getDocsFromServer,
  setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, runTransaction,
} from 'firebase/firestore'
import {
  runBudgetAdjustmentPrepare, runBudgetAdjustmentApprove, runBudgetAdjustmentWithdraw, BUDGET_ADJUSTMENT_ERROR,
} from '../../src/lib/budgetAdjustmentActions'
import {
  runBudgetCapture, runBudgetApprove, BUDGET_APPROVAL_ERROR,
} from '../../src/lib/budgetApprovalActions'
import { resolveBudgetSource, budgetSupersessionKey, BUDGET_SOURCE, BUDGET_INTEGRITY_PROBLEM } from '../../src/lib/budgetApproval'
import { isAdjustmentAmount } from '../../src/lib/budgetAdjustment'

// ── Approved Budget ADJUSTMENTS — Security Rules emulator tests (ADR-71, SHIELD 2B2) ──
//
// Executes docs/TESTING.md §48 against the Firestore emulator: the new
// `budgetAdjustments` block and the 2B2 changes to `approvedBudget/current`
// (the optional adjustment ledger, its paired advance and its reset on every
// version approval), with direct SDK writes — exactly what a client bypassing
// the app would issue — plus the app's own transactions
// (lib/budgetAdjustmentActions.js, lib/budgetApprovalActions.js) against the
// real emulator, including concurrent approvals and the re-approval race.
//
// What these tests deliberately PROVE IS NOT ENFORCED (Deferred Control 45):
// a forged paired approval that takes a cost code's ACCUMULATED adjusted
// figure below zero is accepted by the rules (rules cannot sum sibling
// records) — the shared adapter then reports it and the figure is
// Unavailable.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const PROJECT_B = 'projectB'

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  qs2:    { uid: 'u_qs2',    role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  super:  { uid: 'u_super',  role: 'super_admin',     companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}
const PREPARERS = [USERS.admin, USERS.pm, USERS.qs]
const APPROVERS = [USERS.admin, USERS.pm]
const NON_READERS = [USERS.sub, USERS.client, USERS.super, USERS.other]

let testEnv

const P = (c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}`
const linesPath = (c, p) => `${P(c, p)}/budgetLines`
const codesPath = (c = COMPANY_A) => `companies/${c}/costCodes`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const adjRef = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, `${P(c, p)}/budgetAdjustments`, id)
const headerRef = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, `${P(c, p)}/budgetApprovals`, id)
const snapshotRef = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, `${P(c, p)}/budgetApprovalSnapshots`, id)
const pointerRef = (db, c = COMPANY_A, p = PROJECT_A) => doc(db, `${P(c, p)}/approvedBudget/current`)
const linesQuery = (db) => query(collection(db, linesPath()), orderBy('createdAt', 'desc'))
const codesQuery = (db) => query(collection(db, codesPath()), orderBy('code', 'asc'))
const adjustmentsQuery = (db) => (baseId) => query(collection(db, `${P()}/budgetAdjustments`), where('baseApprovalId', '==', baseId))

// The working register: bl1 (cc1, 1000), bl2 (cc2, 500.5), bl3 (cc1, 250) — Σ 1750.5.
const LINES = [
  { id: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 1000 },
  { id: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 500.5 },
  { id: 'bl3', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 250 },
]
const entry = (l) => ({ lineId: l.id, costCodeId: l.costCodeId, costCodeName: l.costCodeName, budgeted: l.budgeted })
const ENTRIES = [entry(LINES[0]), entry(LINES[2]), entry(LINES[1])]

async function seedLines(lines = LINES) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const [i, l] of lines.entries()) {
      await setDoc(doc(db, linesPath(), l.id), {
        costCodeId: l.costCodeId, costCodeName: l.costCodeName, budgeted: l.budgeted,
        committed: 0, actual: 0, invoiced: 0, notes: '',
        createdAt: Timestamp.fromMillis(1_700_000_000_000 + i * 1000), createdBy: USERS.qs.uid,
      })
    }
  })
}

// An APPROVED version (header + snapshot) and the pointer naming it, seeded.
async function seedVersion(id, { version = 1, pointer = {}, original = null } = {}) {
  const total = 1750.5
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(headerRef(db, id), {
      reason: `Version ${version}`, status: 'approved', currency: 'AUD', entryCount: ENTRIES.length, total, version,
      approvedAt: Timestamp.now(), approvedBy: USERS.pm.uid, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
      revision: 2, createdAt: Timestamp.now(), createdBy: USERS.qs.uid, updatedAt: Timestamp.now(), updatedBy: USERS.pm.uid,
    })
    await setDoc(snapshotRef(db, id), {
      entryCount: ENTRIES.length, total, currency: 'AUD', capturedAt: Timestamp.now(), capturedBy: USERS.qs.uid, entries: ENTRIES,
    })
    await setDoc(pointerRef(db), {
      activeApprovalId: id, originalApprovalId: original ?? id, versionCount: version,
      approvedAt: Timestamp.now(), approvedBy: USERS.pm.uid, createdAt: Timestamp.now(), createdBy: USERS.pm.uid,
      updatedAt: Timestamp.now(), updatedBy: USERS.pm.uid, ...pointer,
    })
  })
}

// A draft adjustment exactly as lib/budgetAdjustmentActions.js writes it.
function draftPayload(user, overrides = {}) {
  return {
    type: 'increase', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', fromCostCodeId: null, fromCostCodeName: '',
    amount: 50, currency: 'AUD', reason: 'Client-instructed scope', reference: 'CI-007',
    baseApprovalId: 'ba1', baseVersion: 1, sequence: null, status: 'draft',
    approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    revision: 1, createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}
const TRANSFER = { type: 'transfer', fromCostCodeId: 'cc2', fromCostCodeName: '03-200 — Formwork', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', amount: 100 }

async function seedDraft(id, { user = USERS.qs, ...overrides } = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(adjRef(c.firestore(), id), {
      ...draftPayload(user, overrides), createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    })
  })
}
async function seedApproved(id, sequence, { user = USERS.qs, ...overrides } = {}) {
  await seedDraft(id, { user, status: 'approved', sequence, approvedAt: Timestamp.now(), approvedBy: USERS.pm.uid, revision: 2, ...overrides })
}

const approveAdjWrite = (user, sequence, extra = {}) => ({
  status: 'approved', sequence, approvedAt: serverTimestamp(), approvedBy: user.uid,
  revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})
const ledgerWrite = (user, id, count, net, extra = {}) => ({
  adjustmentCount: count, adjustmentNet: net, lastAdjustmentId: id,
  updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})
// The approve pair in ONE transaction (what the app does).
const approvePair = (db, user, id, { sequence = 1, count = 1, net = 50, adj = {}, pointer = {}, skipPointer = false, skipAdj = false } = {}) =>
  runTransaction(db, async (tx) => {
    if (!skipAdj) tx.update(adjRef(db, id), approveAdjWrite(user, sequence, adj))
    if (!skipPointer) tx.update(pointerRef(db), ledgerWrite(user, id, count, net, pointer))
  })
const withdrawWrite = (user, reason = 'Raised in error', extra = {}) => ({
  status: 'withdrawn', withdrawnAt: serverTimestamp(), withdrawnBy: user.uid, withdrawReason: reason,
  revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})

const readDoc = async (ref) => {
  let data = null
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(ref(c.firestore()))
    data = s.exists() ? { id: s.id, ...s.data() } : null
  })
  return data
}
const readAdj = (id) => readDoc((db) => adjRef(db, id))
const readPointer = () => readDoc((db) => pointerRef(db))
const readHeader = (id) => readDoc((db) => headerRef(db, id))
const readSnapshot = (id) => readDoc((db) => snapshotRef(db, id))

// The authoritative figure, resolved by THE shared adapter from stored records.
async function resolveStored() {
  let out = null
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const p = await getDoc(pointerRef(db))
    const pointer = p.exists() ? p.data() : null
    const h = await getDoc(headerRef(db, pointer.activeApprovalId))
    const s = await getDoc(snapshotRef(db, pointer.activeApprovalId))
    const a = await getDocs(query(collection(db, `${P()}/budgetAdjustments`), where('baseApprovalId', '==', pointer.activeApprovalId)))
    out = resolveBudgetSource({
      approvedBudget: {
        pointer, header: { id: h.id, ...h.data() }, snapshot: { id: s.id, ...s.data() },
        adjustments: a.docs.map(d => ({ id: d.id, ...d.data() })),
      },
      currencyCode: 'AUD',
    })
  })
  return out
}

// ── The app's own actions for `user` ─────────────────────────────────────────

const appPrepare = (user, id, input, { currencyCode = 'AUD', seenBase = null } = {}) => {
  const db = ctx(user)
  return runBudgetAdjustmentPrepare({
    db, adjustmentRef: adjRef(db, id), pointerRef: pointerRef(db), costCodesQuery: codesQuery(db), getDocsFromServer,
    input, uid: user.uid, currencyCode, seenBase, runTransaction, serverTimestamp,
  })
}
const appApproveAdj = async (user, id) => {
  const db = ctx(user)
  const seen = await readAdj(id)
  return runBudgetAdjustmentApprove({
    db, adjustmentRef: adjRef(db, id), pointerRef: pointerRef(db),
    approvalHeaderRef: (x) => headerRef(db, x), approvalSnapshotRef: (x) => snapshotRef(db, x),
    adjustmentsQuery: adjustmentsQuery(db), getDocFromServer, getDocsFromServer,
    seen, uid: user.uid, currencyCode: 'AUD', runTransaction, serverTimestamp,
  })
}
const appWithdrawAdj = async (user, id, reason = 'No longer needed') => {
  const db = ctx(user)
  const seen = await readAdj(id)
  return runBudgetAdjustmentWithdraw({ db, adjustmentRef: adjRef(db, id), seen, reason, uid: user.uid, runTransaction, serverTimestamp })
}
const appCapture = (user, id) => {
  const db = ctx(user)
  return runBudgetCapture({
    db, headerRef: headerRef(db, id), snapshotRef: snapshotRef(db, id),
    budgetLinesQuery: linesQuery(db), costCodesQuery: codesQuery(db), getDocsFromServer,
    input: { reason: 'Re-approval' }, uid: user.uid, currencyCode: 'AUD', runTransaction, serverTimestamp,
  })
}
// A re-approval as the 2B2 app issues it, with the reviewer's view `seenAs`
// (defaults: what the adapter resolves from the stored records right now).
const appReapprove = async (user, id, seenAs = null) => {
  const db = ctx(user)
  const resolved = await resolveStored()
  const seen = await readHeader(id)
  const snapshot = await readSnapshot(id)
  const view = seenAs ?? {
    seenVersionCount: resolved.versionCount,
    seenAdjustmentCount: resolved.adjustmentCount,
    seenAdjustmentNet: resolved.adjustmentNet,
    seenBaseTotal: resolved.baseTotal,
    acknowledgedSupersessionKey: resolved.adjustmentCount > 0
      ? budgetSupersessionKey({
        versionCount: resolved.versionCount, adjustmentCount: resolved.adjustmentCount,
        adjustmentNet: resolved.adjustmentNet, baseTotal: resolved.baseTotal, proposedTotal: snapshot.total,
      })
      : '',
  }
  return runBudgetApprove({
    db, headerRef: headerRef(db, id), snapshotRef: snapshotRef(db, id), pointerRef: pointerRef(db),
    budgetLinesQuery: linesQuery(db), getDocsFromServer, seen, snapshot, acknowledgedDriftKey: '',
    ...view, uid: user.uid, runTransaction, serverTimestamp,
  })
}

const INCREASE = { type: 'increase', costCodeId: 'cc1', amount: '50', reason: 'Client-instructed scope', reference: 'CI-007' }

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set — refusing to run Rules tests outside the emulator. Run `npm run test:rules`.')
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
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', baseCurrency: 'AUD' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B', baseCurrency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_B), { name: 'Project B', currency: 'NZD' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })
    await setDoc(doc(db, codesPath(), 'cc1'), { code: '03-100', name: 'Concrete', category: '', unit: '', isActive: true })
    await setDoc(doc(db, codesPath(), 'cc2'), { code: '03-200', name: 'Formwork', category: '', unit: '', isActive: true })
    await setDoc(doc(db, codesPath(), 'cc9'), { code: '99-000', name: 'Contingency', category: 'Reserve', unit: '', isActive: true })
    await setDoc(doc(db, codesPath(COMPANY_B), 'cc1'), { code: '03-100', name: 'Concrete', category: '', unit: '', isActive: true })
  })
  await seedLines()
})

// ── Read matrix ──────────────────────────────────────────────────────────────

describe('read matrix — financial roles only, tenant-isolated', () => {
  beforeEach(async () => { await seedVersion('ba1'); await seedDraft('adj1') })

  for (const u of PREPARERS) {
    it(`${u.role} reads an adjustment and runs the active-version query`, async () => {
      await assertSucceeds(getDoc(adjRef(ctx(u), 'adj1')))
      await assertSucceeds(getDocs(adjustmentsQuery(ctx(u))('ba1')))
    })
  }
  for (const u of NON_READERS) {
    it(`${u.role} cannot read an adjustment or list them`, async () => {
      await assertFails(getDoc(adjRef(ctx(u), 'adj1')))
      await assertFails(getDocs(adjustmentsQuery(ctx(u))('ba1')))
    })
  }
  it('an unauthenticated caller reads nothing', async () => {
    await assertFails(getDoc(adjRef(anon(), 'adj1')))
  })
})

// ── Prepare (create) ─────────────────────────────────────────────────────────

describe('prepare — born draft, bound to the ACTIVE version, a valid movement', () => {
  beforeEach(async () => { await seedVersion('ba1') })

  for (const u of PREPARERS) {
    it(`${u.role} creates a valid draft`, async () => {
      await assertSucceeds(setDoc(adjRef(ctx(u), 'adj1'), draftPayload(u)))
    })
  }
  for (const u of [USERS.sub, USERS.client, USERS.super, USERS.other]) {
    it(`${u.role} cannot create one`, async () => {
      await assertFails(setDoc(adjRef(ctx(u), 'adj1'), draftPayload(u)))
    })
  }
  it('a transfer (incl. a contingency reallocation) and a decrease are valid movements', async () => {
    await assertSucceeds(setDoc(adjRef(ctx(USERS.qs), 'adj1'), draftPayload(USERS.qs, TRANSFER)))
    await assertSucceeds(setDoc(adjRef(ctx(USERS.qs), 'adj2'), draftPayload(USERS.qs, { ...TRANSFER, fromCostCodeId: 'cc9', fromCostCodeName: '99-000 — Contingency' })))
    await assertSucceeds(setDoc(adjRef(ctx(USERS.qs), 'adj3'), draftPayload(USERS.qs, { type: 'decrease' })))
  })
  it('NO POINTER — no approved version — denies any adjustment (no invented baseline)', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => { await deleteDoc(pointerRef(c.firestore())) })
    await assertFails(setDoc(adjRef(ctx(USERS.qs), 'adj1'), draftPayload(USERS.qs)))
  })
  it('the base must be the pointer\'s ACTIVE approval and version', async () => {
    await assertFails(setDoc(adjRef(ctx(USERS.qs), 'adj1'), draftPayload(USERS.qs, { baseApprovalId: 'ba0' })))
    await assertFails(setDoc(adjRef(ctx(USERS.qs), 'adj1'), draftPayload(USERS.qs, { baseVersion: 2 })))
  })
  it('the currency is pinned to the project\'s resolved currency', async () => {
    await assertFails(setDoc(adjRef(ctx(USERS.qs), 'adj1'), draftPayload(USERS.qs, { currency: 'NZD' })))
  })
  it('another tenant\'s project path is denied', async () => {
    await assertFails(setDoc(adjRef(ctx(USERS.qs), 'adj1', COMPANY_B, PROJECT_A), draftPayload(USERS.qs)))
  })
  it('refuses an unknown type, missing/foreign cost codes, and a malformed transfer', async () => {
    const qs = ctx(USERS.qs)
    for (const o of [
      { type: 'contingency' },
      { costCodeId: 'nope' },
      { costCodeId: '' },
      { fromCostCodeId: 'cc2', fromCostCodeName: 'x' },              // increase with a source
      { fromCostCodeName: 'stray' },                                  // increase with a source name
      { ...TRANSFER, fromCostCodeId: 'cc1' },                         // transfer to itself
      { ...TRANSFER, fromCostCodeId: null },                          // transfer without a source
      { ...TRANSFER, fromCostCodeId: 'nope' },                        // source does not exist
      { costCodeName: 'x'.repeat(171) },
    ]) {
      await assertFails(setDoc(adjRef(qs, 'adjX'), draftPayload(USERS.qs, o)))
    }
  })
  it('refuses a zero, negative, non-numeric or ceiling-breaking amount', async () => {
    const qs = ctx(USERS.qs)
    for (const amount of [0, -50, '50', null, 1_000_000_000_000, 5e12]) {
      await assertFails(setDoc(adjRef(qs, 'adjX'), draftPayload(USERS.qs, { amount })))
    }
  })
  it('refuses a lifecycle other than a fresh draft, foreign stamps, and bad text', async () => {
    const qs = ctx(USERS.qs)
    const past = Timestamp.fromDate(new Date('2020-01-01T00:00:00Z'))
    for (const o of [
      { status: 'approved' }, { sequence: 1 }, { approvedBy: USERS.qs.uid }, { withdrawReason: 'x' },
      { revision: 2 }, { createdBy: USERS.pm.uid }, { updatedBy: USERS.pm.uid }, { createdAt: past }, { updatedAt: past },
      { reason: '   ' }, { reason: 'x'.repeat(501) }, { reference: 'x'.repeat(201) }, { reference: null },
    ]) {
      await assertFails(setDoc(adjRef(qs, 'adjX'), draftPayload(USERS.qs, o)))
    }
  })
  it('refuses a missing key and an extra key (incl. a stored signed net)', async () => {
    const missing = draftPayload(USERS.qs)
    delete missing.reference
    await assertFails(setDoc(adjRef(ctx(USERS.qs), 'adjX'), missing))
    await assertFails(setDoc(adjRef(ctx(USERS.qs), 'adjX'), draftPayload(USERS.qs, { net: 50 })))
  })
  it('a second create on the same id (a double-click through the SDK) is refused', async () => {
    await assertSucceeds(setDoc(adjRef(ctx(USERS.qs), 'adj1'), draftPayload(USERS.qs)))
    await assertFails(setDoc(adjRef(ctx(USERS.qs), 'adj1'), draftPayload(USERS.qs)))
  })
})

// ── The two-decimal rules pin — boundary evidence ────────────────────────────

describe('two-decimal amount pin — `cents(a) / 100.0 == a` agrees with the client on boundary values', () => {
  beforeEach(async () => { await seedVersion('ba1') })

  const VALID = [
    0.01, 0.07, 0.1, 0.29, 0.57, 0.58, 1.01, 1.1, 1.15, 2.67, 4.35, 8.2, 10.01, 19.99, 40.15, 123.45, 999.99,
    1000.1, 1234.56, 50000, 1234567.89, 99999999.99, 999999999.99, 9999999999.99, 99999999999.99, 999999999999.99,
  ]
  const INVALID = [0.001, 0.005, 0.015, 1.005, 2.675, 10.555, 0.1 + 0.2, 1234567.891, 0.299999]

  it('the client mirror agrees with the intended set (sanity)', () => {
    for (const v of VALID) expect(isAdjustmentAmount(v), `valid ${v}`).toBe(true)
    for (const v of INVALID) expect(isAdjustmentAmount(v), `invalid ${v}`).toBe(false)
  })
  it('every whole-cent boundary value is ACCEPTED by the rules', async () => {
    const qs = ctx(USERS.qs)
    for (const [i, amount] of VALID.entries()) {
      await assertSucceeds(setDoc(adjRef(qs, `v${i}`), draftPayload(USERS.qs, { amount })))
    }
  })
  it('every sub-cent value is REFUSED by the rules', async () => {
    const qs = ctx(USERS.qs)
    for (const [i, amount] of INVALID.entries()) {
      await assertFails(setDoc(adjRef(qs, `i${i}`), draftPayload(USERS.qs, { amount })))
    }
  })
})

// ── Approve — the paired ledger ──────────────────────────────────────────────

describe('approve — paired with the pointer ledger, both ways', () => {
  beforeEach(async () => { await seedVersion('ba1'); await seedDraft('adj1') })

  for (const u of APPROVERS) {
    it(`${u.role} approves as sequence 1, the ledger +1 and +amount`, async () => {
      await assertSucceeds(approvePair(ctx(u), u, 'adj1'))
      expect(await readPointer()).toMatchObject({ adjustmentCount: 1, adjustmentNet: 50, lastAdjustmentId: 'adj1', activeApprovalId: 'ba1', versionCount: 1 })
    })
  }
  it('a QS (the preparer) cannot approve, even paired', async () => {
    await assertFails(approvePair(ctx(USERS.qs), USERS.qs, 'adj1'))
  })
  it('the adjustment alone, or the ledger alone, is refused', async () => {
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { skipPointer: true }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { skipAdj: true }))
  })
  it('the sequence must be the new count, and the count moves by EXACTLY one', async () => {
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { sequence: 2, count: 2 }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { sequence: 2, count: 1 }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { sequence: 0, count: 0 }))
  })
  it('the net moves by EXACTLY the derived movement (increase +amount)', async () => {
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { net: 0 }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { net: 50.01 }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { net: -50 }))
  })
  it('a decrease moves the net by −amount; a transfer by exactly 0', async () => {
    await seedDraft('adjD', { type: 'decrease', amount: 20 })
    await seedDraft('adjT', TRANSFER)
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adjD', { net: 20 }))
    await assertSucceeds(approvePair(ctx(USERS.pm), USERS.pm, 'adjD', { net: -20 }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adjT', { sequence: 2, count: 2, net: 80 }))
    await assertSucceeds(approvePair(ctx(USERS.pm), USERS.pm, 'adjT', { sequence: 2, count: 2, net: -20 }))
    expect(await readPointer()).toMatchObject({ adjustmentCount: 2, adjustmentNet: -20 })
  })
  it('the pointer must name THIS adjustment as the last one', async () => {
    await seedDraft('adj2')
    const pm = ctx(USERS.pm)
    await assertFails(runTransaction(pm, async (tx) => {
      tx.update(adjRef(pm, 'adj1'), approveAdjWrite(USERS.pm, 1))
      tx.update(pointerRef(pm), ledgerWrite(USERS.pm, 'adj2', 1, 50))
    }))
  })
  it('the adjustment branch can never move the active version, the count of versions or the original', async () => {
    for (const pointer of [{ activeApprovalId: 'ba2' }, { versionCount: 2 }, { originalApprovalId: 'ba9' }, { approvedBy: USERS.admin.uid }]) {
      await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { pointer }))
    }
  })
  it('foreign actor or client clock on either half is refused', async () => {
    const past = Timestamp.fromDate(new Date('2020-01-01T00:00:00Z'))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { adj: { approvedBy: USERS.admin.uid } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { adj: { approvedAt: past } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { pointer: { updatedBy: USERS.admin.uid } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { adj: { revision: 3 } }))
  })
  it('approval cannot rewrite the movement, its base or its provenance', async () => {
    for (const adj of [{ amount: 500 }, { costCodeId: 'cc2' }, { type: 'decrease' }, { baseApprovalId: 'ba2' }, { createdBy: USERS.pm.uid }, { reason: 'changed' }]) {
      await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { adj }))
    }
  })
  it('a draft bound to a REPLACED version cannot be approved (stale base)', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(pointerRef(c.firestore()), { activeApprovalId: 'ba2', versionCount: 2 })
    })
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'adj1'))
  })
  it('a forged ledger write with no adjustment at all is refused', async () => {
    await assertFails(updateDoc(pointerRef(ctx(USERS.pm)), ledgerWrite(USERS.pm, 'ghost', 1, 1_000_000)))
    await assertFails(updateDoc(pointerRef(ctx(USERS.pm)), { adjustmentCount: 0, adjustmentNet: 0, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid }))
  })
})

// ── Immutability and withdraw ────────────────────────────────────────────────

describe('approved / withdrawn are terminal; drafts withdraw by approver or preparer', () => {
  beforeEach(async () => { await seedVersion('ba1', { pointer: { adjustmentCount: 1, adjustmentNet: 50, lastAdjustmentId: 'adjA' } }) })

  it('an APPROVED adjustment can never be edited, withdrawn, re-approved or deleted', async () => {
    await seedApproved('adjA', 1)
    const pm = ctx(USERS.pm)
    await assertFails(updateDoc(adjRef(pm, 'adjA'), { amount: 1, revision: 3, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid }))
    await assertFails(updateDoc(adjRef(pm, 'adjA'), withdrawWrite(USERS.pm, 'x', { revision: 3 })))
    await assertFails(approvePair(pm, USERS.pm, 'adjA', { sequence: 2, count: 2, net: 100, adj: { revision: 3 } }))
    await assertFails(deleteDoc(adjRef(pm, 'adjA')))
  })
  it('the preparer (QS) withdraws their own draft; another QS cannot; an approver can', async () => {
    await seedDraft('adj1', { user: USERS.qs })
    await seedDraft('adj2', { user: USERS.qs })
    await assertFails(updateDoc(adjRef(ctx(USERS.qs2), 'adj1'), withdrawWrite(USERS.qs2)))
    await assertSucceeds(updateDoc(adjRef(ctx(USERS.qs), 'adj1'), withdrawWrite(USERS.qs)))
    await assertSucceeds(updateDoc(adjRef(ctx(USERS.pm), 'adj2'), withdrawWrite(USERS.pm)))
  })
  it('a withdrawal needs a reason and cannot touch the movement; a withdrawn draft is terminal', async () => {
    await seedDraft('adj1')
    const qs = ctx(USERS.qs)
    await assertFails(updateDoc(adjRef(qs, 'adj1'), withdrawWrite(USERS.qs, '  ')))
    await assertFails(updateDoc(adjRef(qs, 'adj1'), withdrawWrite(USERS.qs, 'x', { amount: 1 })))
    await assertSucceeds(updateDoc(adjRef(qs, 'adj1'), withdrawWrite(USERS.qs)))
    await assertFails(updateDoc(adjRef(qs, 'adj1'), withdrawWrite(USERS.qs, 'again', { revision: 3 })))
    await assertFails(deleteDoc(adjRef(qs, 'adj1')))
  })
  it('a STALE draft (its version replaced) can still be withdrawn', async () => {
    await seedDraft('adj1')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(pointerRef(c.firestore()), { activeApprovalId: 'ba2', versionCount: 2, adjustmentCount: 0, adjustmentNet: 0 })
    })
    await assertSucceeds(updateDoc(adjRef(ctx(USERS.qs), 'adj1'), withdrawWrite(USERS.qs)))
  })
})

// ── Version approval: the ledger reset ───────────────────────────────────────

describe('version approval resets the ledger; a legacy 2B1 pointer stays valid', () => {
  // ba2 is a captured DRAFT re-approval (header + snapshot), as 2B1 writes it.
  async function seedDraftVersion(id = 'ba2') {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const db = c.firestore()
      await setDoc(headerRef(db, id), {
        reason: 'Re-approval', status: 'draft', currency: 'AUD', entryCount: ENTRIES.length, total: 1750.5, version: null,
        approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
        revision: 1, createdAt: Timestamp.now(), createdBy: USERS.qs.uid, updatedAt: Timestamp.now(), updatedBy: USERS.qs.uid,
      })
      await setDoc(snapshotRef(db, id), {
        entryCount: ENTRIES.length, total: 1750.5, currency: 'AUD', capturedAt: Timestamp.now(), capturedBy: USERS.qs.uid, entries: ENTRIES,
      })
    })
  }
  const versionPair = (db, user, id, pointerExtra = {}) => runTransaction(db, async (tx) => {
    tx.update(headerRef(db, id), {
      status: 'approved', version: 2, approvedAt: serverTimestamp(), approvedBy: user.uid,
      revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid,
    })
    tx.update(pointerRef(db), {
      activeApprovalId: id, versionCount: 2, approvedAt: serverTimestamp(), approvedBy: user.uid,
      updatedAt: serverTimestamp(), updatedBy: user.uid, ...pointerExtra,
    })
  })

  it('with approved adjustments: a re-approval that RESETS the ledger succeeds', async () => {
    await seedVersion('ba1', { pointer: { adjustmentCount: 2, adjustmentNet: 75, lastAdjustmentId: 'adjB' } })
    await seedDraftVersion()
    await assertSucceeds(versionPair(ctx(USERS.pm), USERS.pm, 'ba2', { adjustmentCount: 0, adjustmentNet: 0, lastAdjustmentId: null }))
    expect(await readPointer()).toMatchObject({ activeApprovalId: 'ba2', versionCount: 2, adjustmentCount: 0, adjustmentNet: 0, lastAdjustmentId: null })
  })
  it('a re-approval that resets the count and net but KEEPS the last-adjustment reference is refused', async () => {
    await seedVersion('ba1', { pointer: { adjustmentCount: 2, adjustmentNet: 75, lastAdjustmentId: 'adjB' } })
    await seedDraftVersion()
    await assertFails(versionPair(ctx(USERS.pm), USERS.pm, 'ba2', { adjustmentCount: 0, adjustmentNet: 0 }))
    await assertFails(versionPair(ctx(USERS.pm), USERS.pm, 'ba2', { adjustmentCount: 0, adjustmentNet: 0, lastAdjustmentId: 'adjB' }))
    expect(await readPointer()).toMatchObject({ versionCount: 1, lastAdjustmentId: 'adjB' })
  })
  it('a re-approval that keeps the ledger (an OLD 2B1 bundle) fails CLOSED — no carried-over adjustments', async () => {
    await seedVersion('ba1', { pointer: { adjustmentCount: 2, adjustmentNet: 75, lastAdjustmentId: 'adjB' } })
    await seedDraftVersion()
    await assertFails(versionPair(ctx(USERS.pm), USERS.pm, 'ba2'))
    await assertFails(versionPair(ctx(USERS.pm), USERS.pm, 'ba2', { adjustmentCount: 0, adjustmentNet: 75 }))
    await assertFails(versionPair(ctx(USERS.pm), USERS.pm, 'ba2', { adjustmentCount: 2, adjustmentNet: 0 }))
  })
  it('a LEGACY pointer (no ledger keys) re-approves with the unchanged 2B1 payload', async () => {
    await seedVersion('ba1')
    await seedDraftVersion()
    await assertSucceeds(versionPair(ctx(USERS.pm), USERS.pm, 'ba2'))
  })
  it('a version approval and an adjustment approval can never share one commit', async () => {
    await seedVersion('ba1')
    await seedDraftVersion()
    await seedDraft('adj1')
    const db = ctx(USERS.pm)
    await assertFails(runTransaction(db, async (tx) => {
      tx.update(headerRef(db, 'ba2'), {
        status: 'approved', version: 2, approvedAt: serverTimestamp(), approvedBy: USERS.pm.uid,
        revision: 2, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid,
      })
      tx.update(adjRef(db, 'adj1'), approveAdjWrite(USERS.pm, 1))
      tx.update(pointerRef(db), {
        activeApprovalId: 'ba2', versionCount: 2, approvedAt: serverTimestamp(), approvedBy: USERS.pm.uid,
        adjustmentCount: 1, adjustmentNet: 50, lastAdjustmentId: 'adj1', updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid,
      })
    }))
  })
  it('the FIRST approval cannot create a pointer with a non-empty ledger', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => { await deleteDoc(pointerRef(c.firestore())) })
    await seedDraftVersion('ba1')
    const pm = ctx(USERS.pm)
    await assertFails(runTransaction(pm, async (tx) => {
      tx.update(headerRef(pm, 'ba1'), {
        status: 'approved', version: 1, approvedAt: serverTimestamp(), approvedBy: USERS.pm.uid,
        revision: 2, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid,
      })
      tx.set(pointerRef(pm), {
        activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1, approvedAt: serverTimestamp(), approvedBy: USERS.pm.uid,
        createdAt: serverTimestamp(), createdBy: USERS.pm.uid, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid,
        adjustmentCount: 1, adjustmentNet: 50,
      })
    }))
    await assertFails(runTransaction(pm, async (tx) => {
      tx.update(headerRef(pm, 'ba1'), {
        status: 'approved', version: 1, approvedAt: serverTimestamp(), approvedBy: USERS.pm.uid,
        revision: 2, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid,
      })
      tx.set(pointerRef(pm), {
        activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1, approvedAt: serverTimestamp(), approvedBy: USERS.pm.uid,
        createdAt: serverTimestamp(), createdBy: USERS.pm.uid, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid,
        lastAdjustmentId: 'ghost',
      })
    }))
  })
})

// ── The app's transactions against the emulator ──────────────────────────────

describe('app actions — prepare / approve / withdraw (real transactions)', () => {
  beforeEach(async () => { await seedVersion('ba1') })

  it('prepare → approve an increase: sequence 1, ledger 1 / +50, adjusted figure 1800.50', async () => {
    const r = await appPrepare(USERS.qs, 'adj1', INCREASE)
    expect(r).toEqual({ id: 'adj1', existing: false })
    expect(await readAdj('adj1')).toMatchObject({ status: 'draft', baseApprovalId: 'ba1', baseVersion: 1, costCodeName: '03-100 — Concrete', amount: 50, fromCostCodeId: null })
    const out = await appApproveAdj(USERS.pm, 'adj1')
    expect(out.sequence).toBe(1)
    expect(await readPointer()).toMatchObject({ adjustmentCount: 1, adjustmentNet: 50, lastAdjustmentId: 'adj1' })
    const resolved = await resolveStored()
    expect(resolved.kind).toBe(BUDGET_SOURCE.APPROVED)
    expect(resolved.baseTotal).toBe(1750.5)
    expect(resolved.total).toBe(1800.5)
    expect(resolved.byCostCode).toEqual({ cc1: 1300, cc2: 500.5 })
  })
  it('a contingency reallocation is a plain transfer: net 0, project total unchanged', async () => {
    await appPrepare(USERS.qs, 'adj1', { type: 'increase', costCodeId: 'cc9', amount: '200', reason: 'Contingency allowance' })
    await appApproveAdj(USERS.pm, 'adj1')
    await appPrepare(USERS.qs, 'adj2', { type: 'transfer', fromCostCodeId: 'cc9', costCodeId: 'cc2', amount: '150', reason: 'Draw down contingency' })
    await appApproveAdj(USERS.admin, 'adj2')
    const resolved = await resolveStored()
    expect(resolved.total).toBe(1950.5)
    expect(resolved.byCostCode).toEqual({ cc1: 1250, cc2: 650.5, cc9: 50 })
    expect(await readPointer()).toMatchObject({ adjustmentCount: 2, adjustmentNet: 200 })
  })
  it('a double-click / retry on the SAME id writes ONE draft and reports the existing one', async () => {
    const results = await Promise.allSettled([appPrepare(USERS.qs, 'adj1', INCREASE), appPrepare(USERS.qs, 'adj1', INCREASE)])
    expect(results.every(r => r.status === 'fulfilled')).toBe(true)
    expect(results.map(r => r.value.existing).sort()).toEqual([false, true])
    expect(await appPrepare(USERS.qs, 'adj1', INCREASE)).toEqual({ id: 'adj1', existing: true })
  })
  it('prepare with NO approved version is refused NO_BASE; a stale preview base is refused STALE_BASE', async () => {
    await expect(appPrepare(USERS.qs, 'adj1', INCREASE, { seenBase: 'ba0' })).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.STALE_BASE })
    await testEnv.withSecurityRulesDisabled(async (c) => { await deleteDoc(pointerRef(c.firestore())) })
    await expect(appPrepare(USERS.qs, 'adj2', INCREASE)).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.NO_BASE })
  })
  it('prepare refuses a non-existent cost code and a third decimal before writing', async () => {
    await expect(appPrepare(USERS.qs, 'adj1', { ...INCREASE, costCodeId: 'nope' })).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
    await expect(appPrepare(USERS.qs, 'adj1', { ...INCREASE, amount: '1.005' })).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
    expect(await readAdj('adj1')).toBeNull()
  })
  it('a movement that would take a cost code below zero is refused NEGATIVE; nothing is written', async () => {
    await appPrepare(USERS.qs, 'adj1', { type: 'transfer', fromCostCodeId: 'cc2', costCodeId: 'cc1', amount: '500.51', reason: 'Too much' })
    const err = await appApproveAdj(USERS.pm, 'adj1').catch(e => e)
    expect(err.kind).toBe(BUDGET_ADJUSTMENT_ERROR.NEGATIVE)
    expect(err.details.preview.negative[0]).toMatchObject({ costCodeId: 'cc2', after: -0.01 })
    expect(await readAdj('adj1')).toMatchObject({ status: 'draft' })
    expect((await readPointer()).adjustmentCount).toBeUndefined()
    // Exactly to zero is allowed.
    await appPrepare(USERS.qs, 'adj2', { type: 'decrease', costCodeId: 'cc2', amount: '500.5', reason: 'Descoped' })
    await appApproveAdj(USERS.pm, 'adj2')
    expect((await resolveStored()).byCostCode.cc2).toBe(0)
  })
  it('a QS cannot approve (rules), and a retry of a committed approval never applies twice', async () => {
    await appPrepare(USERS.qs, 'adj1', INCREASE)
    await expect(appApproveAdj(USERS.qs, 'adj1')).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.PERMISSION })
    await appApproveAdj(USERS.pm, 'adj1')
    const retry = await appApproveAdj(USERS.pm, 'adj1').catch(e => e)
    expect([BUDGET_ADJUSTMENT_ERROR.INVALID, BUDGET_ADJUSTMENT_ERROR.STALE]).toContain(retry.kind)
    expect(await readPointer()).toMatchObject({ adjustmentCount: 1, adjustmentNet: 50 })
  })
  it('a retry with the reviewer\'s ORIGINAL draft copy (timed-out commit) is refused STALE; the ledger is unchanged', async () => {
    await appPrepare(USERS.qs, 'adj1', INCREASE)
    const db = ctx(USERS.pm)
    const seen = await readAdj('adj1')
    const args = {
      db, adjustmentRef: adjRef(db, 'adj1'), pointerRef: pointerRef(db),
      approvalHeaderRef: (x) => headerRef(db, x), approvalSnapshotRef: (x) => snapshotRef(db, x),
      adjustmentsQuery: adjustmentsQuery(db), getDocFromServer, getDocsFromServer,
      seen, uid: USERS.pm.uid, currencyCode: 'AUD', runTransaction, serverTimestamp,
    }
    await runBudgetAdjustmentApprove(args)
    await expect(runBudgetAdjustmentApprove(args)).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.STALE })
    expect(await readPointer()).toMatchObject({ adjustmentCount: 1, adjustmentNet: 50 })
  })
  it('TWO CONCURRENT approvals: exactly one lands per ledger step — never a lost or doubled movement', async () => {
    await appPrepare(USERS.qs, 'adj1', INCREASE)
    await appPrepare(USERS.qs, 'adj2', { ...INCREASE, amount: '25' })
    const results = await Promise.allSettled([appApproveAdj(USERS.pm, 'adj1'), appApproveAdj(USERS.admin, 'adj2')])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    // Either both serialise (each re-reading the other's ledger) or exactly one is refused — never both at sequence 1.
    if (rejected.length > 0) {
      expect(fulfilled).toHaveLength(1)
      expect([BUDGET_ADJUSTMENT_ERROR.SUPERSEDED, BUDGET_ADJUSTMENT_ERROR.STALE]).toContain(rejected[0].reason.kind)
    }
    const pointer = await readPointer()
    const a1 = await readAdj('adj1')
    const a2 = await readAdj('adj2')
    const approved = [a1, a2].filter(a => a.status === 'approved')
    expect(pointer.adjustmentCount).toBe(approved.length)
    expect(approved.map(a => a.sequence).sort()).toEqual(approved.map((_, i) => i + 1))
    expect(pointer.adjustmentNet).toBe(approved.reduce((s, a) => s + a.amount, 0))
    // The refused one approves cleanly on a fresh review, as the next sequence.
    for (const a of [a1, a2].filter(x => x.status === 'draft')) await appApproveAdj(USERS.pm, a.id)
    expect(await readPointer()).toMatchObject({ adjustmentCount: 2, adjustmentNet: 75 })
    expect((await resolveStored()).total).toBe(1825.5)
  })
  it('withdraw: a draft only, with a reason; then terminal', async () => {
    await appPrepare(USERS.qs, 'adj1', INCREASE)
    await appWithdrawAdj(USERS.qs, 'adj1')
    expect(await readAdj('adj1')).toMatchObject({ status: 'withdrawn', withdrawnBy: USERS.qs.uid, withdrawReason: 'No longer needed' })
    await expect(appWithdrawAdj(USERS.qs, 'adj1')).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
    await expect(appApproveAdj(USERS.pm, 'adj1')).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.INVALID })
  })
})

// ── Version rollover: no double counting, explicit supersession ──────────────

describe('re-approval — supersession acknowledged, the ledger reset, NO double counting', () => {
  beforeEach(async () => { await seedVersion('ba1') })

  async function approvedIncrease(id, amount = '50') {
    await appPrepare(USERS.qs, id, { ...INCREASE, amount })
    await appApproveAdj(USERS.pm, id)
  }

  it('v1 1750.50 + adj +50 = 1800.50; v2 capturing 1800.50 resolves to 1800.50 — NOT 1850.50', async () => {
    await approvedIncrease('adj1')
    expect((await resolveStored()).total).toBe(1800.5)
    // The working register is brought in line with the adjusted figure, then re-approved.
    await testEnv.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), linesPath(), 'bl1'), { budgeted: 1050 }) })
    await appCapture(USERS.qs, 'ba2')
    await appReapprove(USERS.pm, 'ba2')
    const resolved = await resolveStored()
    expect(resolved).toMatchObject({ kind: BUDGET_SOURCE.APPROVED, versionCount: 2, baseTotal: 1800.5, total: 1800.5, adjustmentCount: 0, adjustmentNet: 0 })
    expect(await readPointer()).toMatchObject({ activeApprovalId: 'ba2', adjustmentCount: 0, adjustmentNet: 0, lastAdjustmentId: null })
    // The superseded adjustment is kept, untouched, identifiable by its base.
    expect(await readAdj('adj1')).toMatchObject({ status: 'approved', baseApprovalId: 'ba1', sequence: 1 })
  })
  it('v2 capturing the UNCHANGED register (1750.50) lowers the figure by 50 — only after acknowledgement', async () => {
    await approvedIncrease('adj1')
    await appCapture(USERS.qs, 'ba2')
    const resolved = await resolveStored()
    const base = { seenVersionCount: 1, seenAdjustmentCount: 1, seenAdjustmentNet: 50, seenBaseTotal: 1750.5 }
    // No acknowledgement → refused.
    await expect(appReapprove(USERS.pm, 'ba2', { ...base, acknowledgedSupersessionKey: '' }))
      .rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.SUPERSESSION })
    // An acknowledgement of DIFFERENT figures → refused.
    const wrongKey = budgetSupersessionKey({ versionCount: 1, adjustmentCount: 1, adjustmentNet: 50, baseTotal: 1750.5, proposedTotal: 1800.5 })
    await expect(appReapprove(USERS.pm, 'ba2', { ...base, acknowledgedSupersessionKey: wrongKey }))
      .rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.SUPERSESSION })
    expect((await readPointer()).versionCount).toBe(1)
    // The acknowledged key of THESE figures → approved; the figure is the capture.
    const key = budgetSupersessionKey({ versionCount: 1, adjustmentCount: 1, adjustmentNet: 50, baseTotal: resolved.baseTotal, proposedTotal: 1750.5 })
    await appReapprove(USERS.pm, 'ba2', { ...base, acknowledgedSupersessionKey: key })
    expect((await resolveStored()).total).toBe(1750.5)
  })
  it('an adjustment approved AFTER the reviewer looked refuses the re-approval (SUPERSEDED)', async () => {
    await approvedIncrease('adj1')
    await appCapture(USERS.qs, 'ba2')
    const stale = await resolveStored()
    await approvedIncrease('adj2', '10')
    const key = budgetSupersessionKey({ versionCount: 1, adjustmentCount: 1, adjustmentNet: 50, baseTotal: stale.baseTotal, proposedTotal: 1750.5 })
    await expect(appReapprove(USERS.pm, 'ba2', {
      seenVersionCount: 1, seenAdjustmentCount: 1, seenAdjustmentNet: 50, seenBaseTotal: 1750.5, acknowledgedSupersessionKey: key,
    })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.SUPERSEDED })
    expect((await readPointer())).toMatchObject({ versionCount: 1, adjustmentCount: 2 })
  })
  it('RACE: a re-approval and an adjustment approval at once — exactly one lands', async () => {
    await approvedIncrease('adj1')
    await appPrepare(USERS.qs, 'adj2', { ...INCREASE, amount: '10' })
    await appCapture(USERS.qs, 'ba2')
    const results = await Promise.allSettled([appReapprove(USERS.pm, 'ba2'), appApproveAdj(USERS.admin, 'adj2')])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    const pointer = await readPointer()
    const adj2 = await readAdj('adj2')
    if (pointer.versionCount === 2) {
      expect(pointer).toMatchObject({ activeApprovalId: 'ba2', adjustmentCount: 0, adjustmentNet: 0 })
      expect(adj2.status).toBe('draft')
      // The draft is now STALE: approval refused, withdrawal allowed.
      await expect(appApproveAdj(USERS.pm, 'adj2')).rejects.toMatchObject({ kind: BUDGET_ADJUSTMENT_ERROR.STALE_BASE })
      await appWithdrawAdj(USERS.qs, 'adj2')
    } else {
      expect(pointer).toMatchObject({ versionCount: 1, adjustmentCount: 2, adjustmentNet: 60 })
      expect(adj2).toMatchObject({ status: 'approved', sequence: 2 })
    }
    expect((await resolveStored()).kind).toBe(BUDGET_SOURCE.APPROVED)
  })
  it('after a re-approval, a NEW adjustment binds to v2 and counts from sequence 1; v1 adjustments never count', async () => {
    await approvedIncrease('adj1')
    await appCapture(USERS.qs, 'ba2')
    await appReapprove(USERS.pm, 'ba2')
    await approvedIncrease('adj3', '5')
    expect(await readAdj('adj3')).toMatchObject({ baseApprovalId: 'ba2', baseVersion: 2, sequence: 1 })
    expect(await readPointer()).toMatchObject({ lastAdjustmentId: 'adj3' })
    const resolved = await resolveStored()
    expect(resolved).toMatchObject({ total: 1755.5, adjustmentCount: 1, adjustmentNet: 5 })
  })
})

// ── Deferred Control 45 — what rules deliberately cannot prove ───────────────

describe('DC45 — a forged, rules-valid paired approval that drives a cost code negative', () => {
  it('is ACCEPTED by the rules (no sibling sums) and the adapter fails closed — Unavailable, never a figure', async () => {
    await seedVersion('ba1')
    await seedDraft('adj1', { type: 'decrease', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', amount: 600 })
    await assertSucceeds(approvePair(ctx(USERS.pm), USERS.pm, 'adj1', { net: -600 }))
    const resolved = await resolveStored()
    expect(resolved.kind).toBe(BUDGET_SOURCE.UNAVAILABLE)
    expect(resolved.problems).toContain(BUDGET_INTEGRITY_PROBLEM.ADJUSTED_NEGATIVE)
    expect(resolved.total).toBeNull()
  })
})
