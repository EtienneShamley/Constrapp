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
  doc, collection, query, orderBy, getDoc, getDocsFromServer, setDoc, updateDoc, deleteDoc,
  serverTimestamp, Timestamp, runTransaction,
} from 'firebase/firestore'
import {
  runBudgetCapture, runBudgetApprove, runBudgetWithdraw, checkBudgetDrift, BUDGET_APPROVAL_ERROR,
} from '../../src/lib/budgetApprovalActions'
import { BUDGET_SNAPSHOT_MAX_BYTES, estimateBudgetSnapshotBytes } from '../../src/lib/budgetApproval'

// ── Approved Budget Versions — Security Rules emulator tests (ADR-70, SHIELD 2B1) ──
//
// Executes docs/TESTING.md §47 against the Firestore emulator. These verify
// the RULES of the three new blocks — `budgetApprovals` (the header),
// `budgetApprovalSnapshots` (the ONE immutable payload) and
// `approvedBudget/current` (the pointer) — with direct SDK writes, exactly
// what a client bypassing the app would issue, plus the app's own
// transactions (lib/budgetApprovalActions.js) run against the real emulator
// with the real `getDocsFromServer`, including TWO CONCURRENT approvals.
//
// What these tests deliberately PROVE IS NOT ENFORCED (Deferred Control 44):
// a MIDDLE entry of any shape and a DUPLICATE line id between the two pinned
// ends, capture completeness, and the drift between the client's server
// query and the commit.
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
const READERS = [USERS.admin, USERS.pm, USERS.qs]
const NON_READERS = [USERS.sub, USERS.client, USERS.super, USERS.other]

let testEnv

const linesPath = (companyId = COMPANY_A, projectId = PROJECT_A) => `companies/${companyId}/projects/${projectId}/budgetLines`
const codesPath = (companyId = COMPANY_A) => `companies/${companyId}/costCodes`
const headersPath = (companyId = COMPANY_A, projectId = PROJECT_A) => `companies/${companyId}/projects/${projectId}/budgetApprovals`
const snapshotsPath = (companyId = COMPANY_A, projectId = PROJECT_A) => `companies/${companyId}/projects/${projectId}/budgetApprovalSnapshots`
const pointerPath = (companyId = COMPANY_A, projectId = PROJECT_A) => `companies/${companyId}/projects/${projectId}/approvedBudget/current`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const headerRef = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, headersPath(c, p), id)
const snapshotRef = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, snapshotsPath(c, p), id)
const pointerRef = (db, c = COMPANY_A, p = PROJECT_A) => doc(db, pointerPath(c, p))
const linesQuery = (db, c = COMPANY_A, p = PROJECT_A) => query(collection(db, linesPath(c, p)), orderBy('createdAt', 'desc'))
const codesQuery = (db, c = COMPANY_A) => query(collection(db, codesPath(c)), orderBy('code', 'asc'))

// The working register: bl1 (cc1, 1000), bl2 (cc2, 500.5), bl3 (cc1, 250).
const LINES = [
  { id: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 1000 },
  { id: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 500.5 },
  { id: 'bl3', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 250 },
]
const TOTAL = 1750.5

async function seedRegister(lines = LINES, companyId = COMPANY_A, projectId = PROJECT_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const [i, l] of lines.entries()) {
      await setDoc(doc(db, linesPath(companyId, projectId), l.id), {
        costCodeId: l.costCodeId, costCodeName: l.costCodeName, budgeted: l.budgeted,
        committed: 0, actual: 0, invoiced: 0, notes: '',
        createdAt: Timestamp.fromMillis(1_700_000_000_000 + i * 1000), createdBy: USERS.qs.uid,
      })
    }
  })
}

// One snapshot entry, exactly as lib/budgetApproval.js → projectBudgetEntry writes it.
const entry = (l) => ({ lineId: l.id, costCodeId: l.costCodeId, costCodeName: l.costCodeName, budgeted: l.budgeted })
const ENTRIES = [entry(LINES[0]), entry(LINES[2]), entry(LINES[1])] // capture order: name, then id
const sum = (es) => Math.round(es.reduce((s, e) => s + e.budgeted, 0) * 100) / 100

// A valid header + snapshot pair, as lib/budgetApprovalActions.js writes them.
function headerPayload(user, entries = ENTRIES, overrides = {}) {
  return {
    reason: 'Initial approved budget', status: 'draft', currency: 'AUD', entryCount: entries.length, total: sum(entries), version: null,
    approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    revision: 1, createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}
function snapshotPayload(user, entries = ENTRIES, overrides = {}) {
  return {
    entryCount: entries.length, total: sum(entries), currency: 'AUD', capturedAt: serverTimestamp(), capturedBy: user.uid, entries,
    ...overrides,
  }
}

// The pair in ONE transaction (what the app does).
const capturePair = (db, user, id, { header = {}, snapshot = {}, entries = ENTRIES, companyId = COMPANY_A, projectId = PROJECT_A } = {}) =>
  runTransaction(db, async (tx) => {
    tx.set(headerRef(db, id, companyId, projectId), headerPayload(user, entries, header))
    tx.set(snapshotRef(db, id, companyId, projectId), snapshotPayload(user, entries, snapshot))
  })

// Seeds a header (and optionally its snapshot / the pointer) directly.
async function seedApproval(id, { header = {}, entries = ENTRIES, withSnapshot = true, user = USERS.qs } = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(headerRef(db, id), { ...headerPayload(user, entries), createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...header })
    if (withSnapshot) await setDoc(snapshotRef(db, id), { ...snapshotPayload(user, entries), capturedAt: Timestamp.now() })
  })
}
async function seedPointer(data) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(pointerRef(c.firestore()), {
      activeApprovalId: 'ba0', originalApprovalId: 'ba0', versionCount: 1,
      approvedAt: Timestamp.now(), approvedBy: USERS.pm.uid, createdAt: Timestamp.now(), createdBy: USERS.pm.uid,
      updatedAt: Timestamp.now(), updatedBy: USERS.pm.uid, ...data,
    })
  })
}

const approveHeaderWrite = (user, version, extra = {}) => ({
  status: 'approved', version, approvedAt: serverTimestamp(), approvedBy: user.uid,
  revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})
const pointerCreate = (user, id, extra = {}) => ({
  activeApprovalId: id, originalApprovalId: id, versionCount: 1, approvedAt: serverTimestamp(), approvedBy: user.uid,
  createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})
const pointerAdvance = (user, id, versionCount, extra = {}) => ({
  activeApprovalId: id, versionCount, approvedAt: serverTimestamp(), approvedBy: user.uid,
  updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})
// The approval pair in ONE transaction (what the app does): header → approved + pointer created / advanced.
const approvePair = (db, user, id, { version = 1, header = {}, pointer = {}, create = true } = {}) =>
  runTransaction(db, async (tx) => {
    tx.update(headerRef(db, id), approveHeaderWrite(user, version, header))
    if (create) tx.set(pointerRef(db), pointerCreate(user, id, pointer))
    else tx.update(pointerRef(db), pointerAdvance(user, id, version, pointer))
  })
const withdrawWrite = (user, reason = 'Captured before the revised allocations', extra = {}) => ({
  status: 'withdrawn', withdrawnAt: serverTimestamp(), withdrawnBy: user.uid, withdrawReason: reason,
  revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid, ...extra,
})

const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

const readDoc = async (ref) => {
  let data = null
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(ref(c.firestore()))
    data = s.exists() ? { id: s.id, ...s.data() } : null
  })
  return data
}
const readHeader = (id) => readDoc((db) => headerRef(db, id))
const readSnapshot = (id) => readDoc((db) => snapshotRef(db, id))
const readPointer = () => readDoc((db) => pointerRef(db))

// The app's capture for `user` (real getDocsFromServer on the user's own db).
const appCapture = (user, id, input = { reason: 'Initial approved budget' }, currencyCode = 'AUD') => {
  const db = ctx(user)
  return runBudgetCapture({
    db, headerRef: headerRef(db, id), snapshotRef: snapshotRef(db, id),
    budgetLinesQuery: linesQuery(db), costCodesQuery: codesQuery(db), getDocsFromServer,
    input, uid: user.uid, currencyCode, runTransaction, serverTimestamp,
  })
}
const appApprove = async (user, id, { acknowledgedDriftKey = '', seenVersionCount = 0 } = {}) => {
  const db = ctx(user)
  const seen = await readHeader(id)
  const snapshot = await readSnapshot(id)
  return runBudgetApprove({
    db, headerRef: headerRef(db, id), snapshotRef: snapshotRef(db, id), pointerRef: pointerRef(db),
    budgetLinesQuery: linesQuery(db), getDocsFromServer, seen, snapshot, acknowledgedDriftKey, seenVersionCount,
    uid: user.uid, runTransaction, serverTimestamp,
  })
}
const appWithdraw = async (user, id, reason = 'Typo in the allocations') => {
  const db = ctx(user)
  const seen = await readHeader(id)
  return runBudgetWithdraw({ db, headerRef: headerRef(db, id), seen, reason, uid: user.uid, runTransaction, serverTimestamp })
}

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
    await setDoc(doc(db, codesPath(COMPANY_B), 'cc1'), { code: '03-100', name: 'Concrete', category: '', unit: '', isActive: true })
  })
  await seedRegister()
})

// ── Read matrix ──────────────────────────────────────────────────────────────

describe('read matrix — the three documents are financial-role-only', () => {
  beforeEach(async () => {
    await seedApproval('ba1', { header: { status: 'approved', version: 1, approvedAt: Timestamp.now(), approvedBy: USERS.pm.uid } })
    await seedPointer({ activeApprovalId: 'ba1', originalApprovalId: 'ba1' })
  })

  for (const u of READERS) {
    it(`${u.role} reads the header, the snapshot and the pointer`, async () => {
      await assertSucceeds(getDoc(headerRef(ctx(u), 'ba1')))
      await assertSucceeds(getDoc(snapshotRef(ctx(u), 'ba1')))
      await assertSucceeds(getDoc(pointerRef(ctx(u))))
    })
  }
  for (const u of NON_READERS) {
    it(`${u.role}${u === USERS.other ? ' of another company' : ''} cannot read any of them`, async () => {
      await assertFails(getDoc(headerRef(ctx(u), 'ba1')))
      await assertFails(getDoc(snapshotRef(ctx(u), 'ba1')))
      await assertFails(getDoc(pointerRef(ctx(u))))
    })
  }
  it('an unauthenticated caller cannot read', async () => {
    await assertFails(getDoc(headerRef(anon(), 'ba1')))
    await assertFails(getDoc(pointerRef(anon())))
  })
})

// ── Capture: the pair (direct SDK) ───────────────────────────────────────────

describe('capture — header and snapshot are born together, by a financial role, pinned to the register', () => {
  for (const u of PREPARERS) {
    it(`${u.role} captures a valid pair in one transaction`, async () => {
      await assertSucceeds(capturePair(ctx(u), u, 'ba1'))
      const h = await readHeader('ba1')
      expect(h).toMatchObject({ status: 'draft', revision: 1, version: null, entryCount: 3, total: TOTAL, currency: 'AUD', createdBy: u.uid })
      const s = await readSnapshot('ba1')
      expect(s.entries).toEqual(ENTRIES)
      expect(s.capturedBy).toBe(u.uid)
    })
  }
  for (const u of [USERS.sub, USERS.client, USERS.super]) {
    it(`${u.role} cannot capture`, async () => {
      await assertFails(capturePair(ctx(u), u, 'ba1'))
    })
  }
  it('a company B admin cannot capture in company A, and company A cannot capture in company B', async () => {
    await assertFails(capturePair(ctx(USERS.other), USERS.other, 'ba1'))
    await assertFails(capturePair(ctx(USERS.admin), USERS.admin, 'ba1', { companyId: COMPANY_B }))
  })

  it('a header ALONE is refused; a snapshot ALONE is refused; a snapshot against a pre-existing header is refused', async () => {
    await assertFails(setDoc(headerRef(ctx(USERS.pm), 'ba1'), headerPayload(USERS.pm)))
    await assertFails(setDoc(snapshotRef(ctx(USERS.pm), 'ba1'), snapshotPayload(USERS.pm)))
    await seedApproval('ba2', { withSnapshot: false })
    await assertFails(setDoc(snapshotRef(ctx(USERS.pm), 'ba2'), snapshotPayload(USERS.pm)))
    expect(await readHeader('ba1')).toBeNull()
    expect(await readSnapshot('ba1')).toBeNull()
  })

  it('the two halves must agree on count, total and currency, actor and server time', async () => {
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'a', { header: { entryCount: 2 } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'b', { snapshot: { entryCount: 2 } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'c', { header: { total: 1 } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'd', { snapshot: { total: 1 } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'e', { snapshot: { currency: 'NZD' } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'f', { snapshot: { capturedBy: USERS.qs.uid } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'g', { header: { createdBy: USERS.qs.uid } }))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'h', { header: { createdAt: clock() } }))
      await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'i', { snapshot: { capturedAt: clock() } }))
    }
  })

  it('the header currency is pinned to the PROJECT currency (resolvedCurrency); a draft in another currency is refused', async () => {
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'a', { header: { currency: 'USD' }, snapshot: { currency: 'USD' } }))
    // Project B resolves NZD: an AUD pair there is refused, an NZD pair passes.
    await seedRegister(LINES, COMPANY_A, PROJECT_B)
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'b', { projectId: PROJECT_B }))
    await assertSucceeds(capturePair(ctx(USERS.pm), USERS.pm, 'c', { projectId: PROJECT_B, header: { currency: 'NZD' }, snapshot: { currency: 'NZD' } }))
  })

  it('born draft at revision 1 with null approval / withdrawal fields; a non-blank bounded reason; exact keys', async () => {
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'a', { header: { status: 'approved' } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'b', { header: { version: 1 } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'c', { header: { revision: 2 } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'd', { header: { approvedBy: USERS.pm.uid } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'e', { header: { reason: '   ' } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'f', { header: { reason: 'x'.repeat(501) } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'g', { header: { extra: true } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'h', { snapshot: { extra: true } }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'i', { header: { total: -1 }, snapshot: { total: -1 } }))
  })

  it('the FIRST and LAST entries are pinned to their source lines: amount, cost code, existence — and to a real company cost code', async () => {
    const wrongAmount = [{ ...ENTRIES[0], budgeted: 999 }, ENTRIES[1], ENTRIES[2]]
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'a', { entries: wrongAmount, header: { total: sum(wrongAmount) }, snapshot: { total: sum(wrongAmount) } }))
    const wrongCode = [ENTRIES[0], ENTRIES[1], { ...ENTRIES[2], costCodeId: 'cc1' }]
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'b', { entries: wrongCode }))
    const ghostLine = [{ ...ENTRIES[0], lineId: 'nope' }, ENTRIES[1], ENTRIES[2]]
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'c', { entries: ghostLine }))
    // A line of ANOTHER project is not a source of this one.
    await seedRegister([{ id: 'blB', costCodeId: 'cc1', costCodeName: 'x', budgeted: 1000 }], COMPANY_A, PROJECT_B)
    const otherProject = [{ lineId: 'blB', costCodeId: 'cc1', costCodeName: 'x', budgeted: 1000 }, ENTRIES[1], ENTRIES[2]]
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'd', { entries: otherProject }))
    // A real line whose cost code is not in the company library.
    await seedRegister([...LINES, { id: 'bl4', costCodeId: 'ccX', costCodeName: 'x', budgeted: 5 }])
    const ghostCode = [ENTRIES[0], ENTRIES[1], ENTRIES[2], { lineId: 'bl4', costCodeId: 'ccX', costCodeName: 'x', budgeted: 5 }]
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'e', { entries: ghostCode }))
    // Entry shape: exact keys, non-empty strings, non-negative number.
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'f', { entries: [{ ...ENTRIES[0], extra: 1 }, ENTRIES[1], ENTRIES[2]] }))
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'g', { entries: [ENTRIES[0], ENTRIES[1], { ...ENTRIES[2], costCodeName: 'n'.repeat(171) }] }))
  })

  it('⚠️ NOT ENFORCED (DC44): a garbage MIDDLE entry and a DUPLICATE middle entry are accepted by the rules — the app refuses them', async () => {
    const garbage = [ENTRIES[0], { nonsense: true }, ENTRIES[2]]
    await assertSucceeds(capturePair(ctx(USERS.pm), USERS.pm, 'a', { entries: garbage, header: { total: 1250 }, snapshot: { total: 1250 } }))
    const dup = [ENTRIES[0], ENTRIES[0], ENTRIES[2]]
    await assertSucceeds(capturePair(ctx(USERS.pm), USERS.pm, 'b', { entries: dup, header: { total: sum(dup) }, snapshot: { total: sum(dup) } }))
    // The app's capture never produces these: it refuses by name (unit-tested)
    // and the read-time validation reports them as integrity problems.
  })

  it('the list is bounded 1–2000 and equal to entryCount; a 2,000-entry worst case writes within the document limit', async () => {
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'a', { entries: [], header: { entryCount: 0, total: 0 }, snapshot: { entryCount: 0, total: 0 } }))
    const over = [ENTRIES[0], ...Array.from({ length: 1999 }, () => ({ pad: true })), ENTRIES[2]]
    await assertFails(capturePair(ctx(USERS.pm), USERS.pm, 'b', { entries: over, header: { total: 1250 }, snapshot: { total: 1250 } }))
    const max = [ENTRIES[0], ...Array.from({ length: 1998 }, (_, i) => ({ lineId: `m${i}`, costCodeId: 'cc1', costCodeName: 'n'.repeat(170), budgeted: 1 })), ENTRIES[2]]
    expect(estimateBudgetSnapshotBytes(max)).toBeLessThan(BUDGET_SNAPSHOT_MAX_BYTES)
    await assertSucceeds(capturePair(ctx(USERS.pm), USERS.pm, 'c', { entries: max, header: { total: sum(max) }, snapshot: { total: sum(max) } }))
    expect((await readSnapshot('c')).entries).toHaveLength(2000)
  })
})

// ── Capture: the app's transaction ───────────────────────────────────────────

describe('capture — the app transaction against the real rules', () => {
  for (const u of PREPARERS) {
    it(`${u.role} prepares a draft from the SERVER register`, async () => {
      const r = await appCapture(u, 'ba1')
      expect(r).toMatchObject({ id: 'ba1', total: TOTAL, counts: { captured: 3, costCodes: 2, invalid: 0 } })
      expect(await readHeader('ba1')).toMatchObject({ status: 'draft', entryCount: 3, total: TOTAL, createdBy: u.uid })
      expect((await readSnapshot('ba1')).entries).toEqual(ENTRIES)
    })
  }
  it('a subcontractor is refused at the server read (PERMISSION) and nothing is written', async () => {
    await expect(appCapture(USERS.sub, 'ba1')).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.PERMISSION })
    expect(await readHeader('ba1')).toBeNull()
  })
  it('a currency that is not the project\'s is refused by the rules (the app passes the resolved project currency)', async () => {
    await expect(appCapture(USERS.pm, 'ba1', undefined, 'USD')).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.PERMISSION })
    expect(await readHeader('ba1')).toBeNull()
  })
  it('an invalid register (a line on an unknown cost code) is refused BEFORE the transaction', async () => {
    await seedRegister([...LINES, { id: 'bl4', costCodeId: 'ccX', costCodeName: 'x', budgeted: 5 }])
    await expect(appCapture(USERS.pm, 'ba1')).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.INVALID })
    expect(await readHeader('ba1')).toBeNull()
  })
})

// ── Approve: the pair with the pointer (direct SDK) ──────────────────────────

describe('approve — header and pointer move together, by an approver, at the next version', () => {
  beforeEach(async () => { await seedApproval('ba1') })

  for (const u of APPROVERS) {
    it(`${u.role} approves the FIRST version: header → approved v1, pointer created (original == active)`, async () => {
      await assertSucceeds(approvePair(ctx(u), u, 'ba1'))
      expect(await readHeader('ba1')).toMatchObject({ status: 'approved', version: 1, revision: 2, approvedBy: u.uid, total: TOTAL })
      expect(await readPointer()).toMatchObject({ activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1, approvedBy: u.uid })
    })
  }
  for (const u of [USERS.qs, USERS.sub, USERS.client, USERS.super, USERS.other]) {
    it(`${u.role}${u === USERS.other ? ' of another company' : ''} cannot approve`, async () => {
      await assertFails(approvePair(ctx(u), u, 'ba1'))
      expect((await readHeader('ba1')).status).toBe('draft')
      expect(await readPointer()).toBeNull()
    })
  }

  it('the header cannot become approved WITHOUT the pointer, and the pointer cannot be created WITHOUT the approval', async () => {
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'ba1'), approveHeaderWrite(USERS.pm, 1)))
    await assertFails(setDoc(pointerRef(ctx(USERS.pm)), pointerCreate(USERS.pm, 'ba1')))
    expect((await readHeader('ba1')).status).toBe('draft')
    expect(await readPointer()).toBeNull()
  })

  it('the pair must agree: version == versionCount == 1 on the first approval, same actor, same server time, the pointer naming THIS header', async () => {
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { version: 2 }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { version: 1, pointer: { versionCount: 2 } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { pointer: { activeApprovalId: 'other' } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { pointer: { originalApprovalId: 'other' } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { header: { approvedBy: USERS.admin.uid } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { pointer: { approvedBy: USERS.admin.uid } }))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { header: { approvedAt: clock() } }))
      await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { pointer: { approvedAt: clock() } }))
    }
    expect(await readPointer()).toBeNull()
  })

  it('approval is stamps-only with revision + 1: it may not change the reason, total, count, currency or provenance, and revision + 2 is refused', async () => {
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { header: { total: 1 } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { header: { reason: 'edited' } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { header: { entryCount: 1 } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { header: { currency: 'NZD' } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { header: { createdBy: USERS.pm.uid } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { header: { revision: 3 } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { header: { withdrawReason: 'x' } }))
  })

  it('a LATER version: the pointer advances by EXACTLY one to a DIFFERENT header; +2, same id, a changed original or a changed provenance are refused', async () => {
    await assertSucceeds(approvePair(ctx(USERS.pm), USERS.pm, 'ba1'))
    await seedApproval('ba2')
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba2', { version: 3, create: false }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba2', { version: 2, create: false, pointer: { versionCount: 3 } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba2', { version: 2, create: false, pointer: { originalApprovalId: 'ba2' } }))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba2', { version: 2, create: false, pointer: { createdBy: USERS.pm.uid, createdAt: serverTimestamp() } }))
    // A second pointer "create" over the existing one is an update and must obey the +1.
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba2', { version: 1, create: true }))
    await assertSucceeds(approvePair(ctx(USERS.admin), USERS.admin, 'ba2', { version: 2, create: false }))
    expect(await readPointer()).toMatchObject({ activeApprovalId: 'ba2', originalApprovalId: 'ba1', versionCount: 2, approvedBy: USERS.admin.uid })
    expect(await readHeader('ba1')).toMatchObject({ status: 'approved', version: 1 }) // untouched
    expect(await readHeader('ba2')).toMatchObject({ status: 'approved', version: 2 })
  })

  it('an approved header is IMMUTABLE for everyone: no rename, no re-approval, no withdrawal, no return to draft, no delete', async () => {
    await assertSucceeds(approvePair(ctx(USERS.pm), USERS.pm, 'ba1'))
    for (const u of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertFails(updateDoc(headerRef(ctx(u), 'ba1'), { reason: 'x', revision: 3, updatedAt: serverTimestamp(), updatedBy: u.uid }))
      await assertFails(updateDoc(headerRef(ctx(u), 'ba1'), { total: 1, revision: 3, updatedAt: serverTimestamp(), updatedBy: u.uid }))
      await assertFails(updateDoc(headerRef(ctx(u), 'ba1'), { status: 'draft', version: null, revision: 3, updatedAt: serverTimestamp(), updatedBy: u.uid }))
      await assertFails(updateDoc(headerRef(ctx(u), 'ba1'), withdrawWrite(u, 'x', { revision: 3 })))
      await assertFails(approvePair(ctx(u), u, 'ba1', { header: { revision: 3 }, create: false, version: 2 }))
      await assertFails(deleteDoc(headerRef(ctx(u), 'ba1')))
      await assertFails(deleteDoc(pointerRef(ctx(u))))
    }
    expect(await readHeader('ba1')).toMatchObject({ status: 'approved', version: 1, revision: 2 })
  })

  it('a snapshot is NEVER updated or deleted, by anyone, in any state', async () => {
    for (const u of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertFails(updateDoc(snapshotRef(ctx(u), 'ba1'), { total: 1 }))
      await assertFails(updateDoc(snapshotRef(ctx(u), 'ba1'), { entries: [] }))
      await assertFails(setDoc(snapshotRef(ctx(u), 'ba1'), snapshotPayload(u)))
      await assertFails(deleteDoc(snapshotRef(ctx(u), 'ba1')))
    }
    await assertSucceeds(approvePair(ctx(USERS.pm), USERS.pm, 'ba1'))
    await assertFails(updateDoc(snapshotRef(ctx(USERS.admin), 'ba1'), { entries: [] }))
    await assertFails(deleteDoc(snapshotRef(ctx(USERS.admin), 'ba1')))
    expect((await readSnapshot('ba1')).entries).toEqual(ENTRIES)
  })

  it('the pointer cannot be forged directly: no create without an approval in the commit, no bare advance, no exact-keys violation', async () => {
    await assertFails(setDoc(pointerRef(ctx(USERS.admin)), pointerCreate(USERS.admin, 'ba1')))
    await seedPointer({ activeApprovalId: 'ba0', originalApprovalId: 'ba0', versionCount: 1 })
    await assertFails(updateDoc(pointerRef(ctx(USERS.admin)), pointerAdvance(USERS.admin, 'ba1', 2)))
    await assertFails(updateDoc(pointerRef(ctx(USERS.admin)), { versionCount: 2, updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid }))
    await assertFails(setDoc(pointerRef(ctx(USERS.admin)), { ...pointerCreate(USERS.admin, 'ba1'), extra: 1 }))
    expect(await readPointer()).toMatchObject({ activeApprovalId: 'ba0', versionCount: 1 })
  })
})

// ── Approve: the app's transaction, including two concurrent approvals ──────

describe('approve — the app transaction against the real rules', () => {
  it('a PM approves a prepared draft: version 1, the pointer created; a second draft becomes version 2 and the original stays version 1', async () => {
    await appCapture(USERS.qs, 'ba1')
    await expect(appApprove(USERS.pm, 'ba1')).resolves.toEqual({ version: 1 })
    expect(await readPointer()).toMatchObject({ activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1 })
    await appCapture(USERS.qs, 'ba2', { reason: 'Re-approved after the revised scope' })
    await expect(appApprove(USERS.admin, 'ba2', { seenVersionCount: 1 })).resolves.toEqual({ version: 2 })
    expect(await readPointer()).toMatchObject({ activeApprovalId: 'ba2', originalApprovalId: 'ba1', versionCount: 2 })
    expect(await readHeader('ba1')).toMatchObject({ status: 'approved', version: 1 })
  })

  it('a QS cannot approve through the app either — the rules refuse the transaction (PERMISSION) and nothing changes', async () => {
    await appCapture(USERS.qs, 'ba1')
    await expect(appApprove(USERS.qs, 'ba1')).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.PERMISSION })
    expect((await readHeader('ba1')).status).toBe('draft')
    expect(await readPointer()).toBeNull()
  })

  it('drift: a line edited after the capture is refused until the approver acknowledges THAT drift by key', async () => {
    await appCapture(USERS.qs, 'ba1')
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), linesPath(), 'bl2'), { budgeted: 600 })
    })
    const err = await appApprove(USERS.pm, 'ba1').catch(e => e)
    expect(err.kind).toBe(BUDGET_APPROVAL_ERROR.DRIFT)
    expect(err.details.drift.changed.map(x => x.lineId)).toEqual(['bl2'])
    await expect(appApprove(USERS.pm, 'ba1', { acknowledgedDriftKey: err.details.drift.key })).resolves.toEqual({ version: 1 })
    // The approved snapshot holds the amount AS CAPTURED, not the edited one.
    expect((await readSnapshot('ba1')).entries.find(e => e.lineId === 'bl2').budgeted).toBe(500.5)
    const drift = await checkBudgetDrift({ budgetLinesQuery: linesQuery(ctx(USERS.pm)), getDocsFromServer, snapshot: await readSnapshot('ba1') })
    expect(drift.changed).toHaveLength(1)
  })

  it('SUPERSEDED: a reviewer who opened the draft before another version was approved is refused — the pointer is the concurrency boundary', async () => {
    await appCapture(USERS.qs, 'ba1')
    await appCapture(USERS.qs, 'ba2')
    await appApprove(USERS.pm, 'ba1')
    await expect(appApprove(USERS.pm, 'ba2', { seenVersionCount: 0 })).rejects.toMatchObject({ kind: BUDGET_APPROVAL_ERROR.SUPERSEDED })
    expect((await readHeader('ba2')).status).toBe('draft')
    expect(await readPointer()).toMatchObject({ versionCount: 1, activeApprovalId: 'ba1' })
  })

  it('TWO CONCURRENT approvals of two drafts: exactly one lands as version 1, the other is refused (superseded / stale), never two version-1s', async () => {
    await appCapture(USERS.qs, 'ba1')
    await appCapture(USERS.qs, 'ba2')
    const results = await Promise.allSettled([appApprove(USERS.pm, 'ba1'), appApprove(USERS.admin, 'ba2')])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect([BUDGET_APPROVAL_ERROR.SUPERSEDED, BUDGET_APPROVAL_ERROR.STALE, BUDGET_APPROVAL_ERROR.PERMISSION]).toContain(rejected[0].reason.kind)
    const pointer = await readPointer()
    expect(pointer.versionCount).toBe(1)
    const h1 = await readHeader('ba1')
    const h2 = await readHeader('ba2')
    expect([h1.status, h2.status].sort()).toEqual(['approved', 'draft'])
    expect(pointer.activeApprovalId).toBe(h1.status === 'approved' ? 'ba1' : 'ba2')
  })

  it('a retry of an approval that already committed never creates a second version', async () => {
    await appCapture(USERS.qs, 'ba1')
    await appApprove(USERS.pm, 'ba1')
    const err = await appApprove(USERS.pm, 'ba1', { seenVersionCount: 1 }).catch(e => e)
    expect([BUDGET_APPROVAL_ERROR.INVALID, BUDGET_APPROVAL_ERROR.STALE]).toContain(err.kind)
    expect(await readPointer()).toMatchObject({ versionCount: 1 })
  })
})

// ── Withdraw ─────────────────────────────────────────────────────────────────

describe('withdraw — a draft only, by an approver or its capturer, with a reason; terminal', () => {
  beforeEach(async () => { await seedApproval('ba1', { user: USERS.qs }) })

  it('the capturer (a QS) withdraws their own draft; another QS cannot; an approver can', async () => {
    await assertFails(updateDoc(headerRef(ctx(USERS.qs2), 'ba1'), withdrawWrite(USERS.qs2)))
    await assertSucceeds(updateDoc(headerRef(ctx(USERS.qs), 'ba1'), withdrawWrite(USERS.qs)))
    expect(await readHeader('ba1')).toMatchObject({ status: 'withdrawn', revision: 2, withdrawnBy: USERS.qs.uid })
    await seedApproval('ba2', { user: USERS.qs })
    await assertSucceeds(updateDoc(headerRef(ctx(USERS.pm), 'ba2'), withdrawWrite(USERS.pm)))
    await seedApproval('ba3', { user: USERS.qs })
    await expect(appWithdraw(USERS.admin, 'ba3')).resolves.toBe(2)
  })

  it('needs a non-blank bounded reason, the caller\'s stamps at server time, revision + 1, and touches nothing else', async () => {
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'ba1'), withdrawWrite(USERS.pm, '   ')))
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'ba1'), withdrawWrite(USERS.pm, 'x'.repeat(501))))
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'ba1'), withdrawWrite(USERS.pm, 'r', { withdrawnBy: USERS.admin.uid })))
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'ba1'), withdrawWrite(USERS.pm, 'r', { revision: 3 })))
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'ba1'), withdrawWrite(USERS.pm, 'r', { total: 1 })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'ba1'), withdrawWrite(USERS.pm, 'r', { withdrawnAt: clock() })))
    }
    for (const u of [USERS.sub, USERS.client, USERS.super, USERS.other]) {
      await assertFails(updateDoc(headerRef(ctx(u), 'ba1'), withdrawWrite(u)))
    }
  })

  it('withdrawn is terminal: no re-approval, no return to draft, no second withdrawal, no delete', async () => {
    await assertSucceeds(updateDoc(headerRef(ctx(USERS.pm), 'ba1'), withdrawWrite(USERS.pm)))
    await assertFails(approvePair(ctx(USERS.pm), USERS.pm, 'ba1', { header: { revision: 3 } }))
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'ba1'), { status: 'draft', revision: 3, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid }))
    await assertFails(updateDoc(headerRef(ctx(USERS.pm), 'ba1'), withdrawWrite(USERS.pm, 'again', { revision: 3 })))
    await assertFails(deleteDoc(headerRef(ctx(USERS.admin), 'ba1')))
  })
})
