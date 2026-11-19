import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import {
  doc, collection, query, where, orderBy, getDoc, getDocs, getDocFromServer, getDocsFromServer,
  setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, runTransaction,
} from 'firebase/firestore'
import {
  runFinalAccountPrepare, runFinalAccountWithdraw, FINAL_ACCOUNT_ERROR,
} from '../../src/lib/finalAccountActions'
import {
  computeFinalAccount, settledSourceStates, buildFinalAccountDraft, finalAccountContent, FINAL_ACCOUNT_LIMITS,
} from '../../src/lib/finalAccount'
import { readyProject, sourcesOf, EXPECTED_FIGURES, FA_PROJECT_COLLECTIONS } from '../fixtures/finalAccountProject'

// ── Final Accounts — Security Rules emulator tests (ADR-77, L2-B) ────────────
//
// The `finalAccounts` block against the Firestore emulator, with direct SDK
// writes — exactly what a client bypassing the app would issue — plus the
// app's own prepare / withdraw transactions (lib/finalAccountActions.js) run
// THROUGH the rules, including their fresh server reads of every register.
//
// The central control: NO CLIENT CAN APPROVE. Every route to
// `status: 'approved'` is denied for every role; approval exists only in the
// trusted callable (tests/functions/finalAccount.*.test.js).
//
// What these tests deliberately PROVE IS NOT ENFORCED (Deferred Control 47): a
// DRAFT's figures are whatever its author wrote — rules check their shape and
// size, never their value. That is safe only because a draft is never
// authoritative and the callable replaces the figures with its own.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

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
  qs2:    { uid: 'u_qs2',    role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  super:  { uid: 'u_super',  role: 'super_admin',     companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}
const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]
const OUTSIDERS = [USERS.sub, USERS.client, USERS.super, USERS.other]

const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))
let testEnv

const P = (c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}`
const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const faRef = (db, n, c = COMPANY_A, p = PROJECT_A) => doc(db, `${P(c, p)}/finalAccounts`, String(n))
const faCol = (db, c = COMPANY_A, p = PROJECT_A) => collection(db, `${P(c, p)}/finalAccounts`)

// Seed the READY project (rules disabled): every register with a createdAt, so
// the app's ordered queries return it.
async function seedProject(mutate = (p) => p, c = COMPANY_A, p = PROJECT_A) {
  const data = readyProject()
  mutate(data)
  await testEnv.withSecurityRulesDisabled(async (env) => {
    const db = env.firestore()
    const at = (i) => Timestamp.fromMillis(1_760_000_000_000 + i * 1000)
    await setDoc(doc(db, 'companies', c), data.company)
    await setDoc(doc(db, P(c, p)), { ...data.project, createdAt: at(0), createdBy: 'seed' })
    for (const [i, cc] of data.costCodes.entries()) { const { id, ...rest } = cc; await setDoc(doc(db, `companies/${c}/costCodes`, id), { ...rest, createdAt: at(i) }) }
    await setDoc(doc(db, `${P(c, p)}/commercial/baseline`), { ...data.baseline, createdAt: at(0), createdBy: 'seed', updatedAt: at(0), updatedBy: 'seed' })
    if (data.pointer) await setDoc(doc(db, `${P(c, p)}/approvedBudget/current`), data.pointer)
    for (const name of FA_PROJECT_COLLECTIONS) {
      for (const [i, d] of (data[name] ?? []).entries()) { const { id, ...rest } = d; await setDoc(doc(db, `${P(c, p)}/${name}`, id), { ...rest, createdAt: at(i), createdBy: 'seed' }) }
    }
  })
  return data
}

// The refs and queries hooks/useFinalAccounts.jsx hands to the actions.
function serverReads(db, c = COMPANY_A, p = PROJECT_A) {
  const sub = (name) => collection(db, `${P(c, p)}/${name}`)
  const ordered = (name) => query(sub(name), orderBy('createdAt', 'desc'))
  return {
    accountsQuery: query(sub('finalAccounts'), orderBy('createdAt', 'asc')),
    queries: {
      budgetLines: ordered('budgetLines'), purchaseOrders: ordered('purchaseOrders'), progressClaims: ordered('progressClaims'),
      supplierInvoices: ordered('supplierInvoices'), supplierCreditNotes: ordered('supplierCreditNotes'), variations: ordered('variations'),
      forecastLines: sub('forecastLines'), supplierPayments: ordered('supplierPayments'), retentionReleases: ordered('retentionReleases'),
      clientInvoices: ordered('clientInvoices'), clientReceipts: ordered('clientReceipts'),
      costCodes: query(collection(db, `companies/${c}/costCodes`), orderBy('code', 'asc')),
    },
    refs: {
      baseline: doc(db, `${P(c, p)}/commercial/baseline`),
      pointer: doc(db, `${P(c, p)}/approvedBudget/current`),
      header: (id) => doc(db, `${P(c, p)}/budgetApprovals`, id),
      snapshot: (id) => doc(db, `${P(c, p)}/budgetApprovalSnapshots`, id),
      adjustments: (id) => query(sub('budgetAdjustments'), where('baseApprovalId', '==', id)),
    },
  }
}

const INPUT = { reason: 'Works complete; subcontract accounts agreed', reference: 'FA-2026-01', acknowledged: true }

const appPrepare = (user, input = INPUT) => {
  const db = ctx(user)
  return runFinalAccountPrepare({
    db, accountRef: (n) => faRef(db, n), ...serverReads(db), getDocsFromServer, getDocFromServer,
    project: { id: PROJECT_A, name: 'Harbour Road Units' }, currencyCode: 'AUD', input,
    uid: user.uid, preparedByName: user.uid, runTransaction, serverTimestamp,
  })
}
const readFa = async (n) => {
  let out = null
  await testEnv.withSecurityRulesDisabled(async (env) => { const s = await getDoc(faRef(env.firestore(), n)); out = s.exists() ? s.data() : null })
  return out
}
const appWithdraw = async (user, n, reason = 'Superseded by late invoice') => {
  const db = ctx(user)
  const seen = (await getDoc(faRef(db, n))).data()
  return runFinalAccountWithdraw({ db, accountRef: faRef(db, n), seen, reason, uid: user.uid, runTransaction, serverTimestamp })
}

// A draft document exactly as the prepare action writes it (for direct writes).
function draftDoc(user, number = 1, overrides = {}) {
  const data = readyProject()
  const computation = computeFinalAccount({ project: { id: PROJECT_A }, currencyCode: 'AUD', sources: sourcesOf(data), sourceStates: settledSourceStates() })
  const built = buildFinalAccountDraft({ computation, number, input: INPUT, currencyCode: 'AUD', preparedByName: 'Someone' })
  return {
    ...built.payload, status: 'draft', revision: 1,
    approvedAt: null, approvedBy: null, approvedByName: null, approvedByRole: null, selfApproved: null, sourcesReadAt: null,
    withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}

// Seed a revision in a given state WITHOUT rules (as the callable, or history).
async function seedRevision(number, status, createdBy = USERS.qs.uid) {
  const now = Timestamp.now()
  const base = draftDoc({ uid: createdBy }, number, { createdAt: now, updatedAt: now })
  const extra = status === 'approved'
    ? { status, revision: 2, approvedAt: now, approvedBy: USERS.pm.uid, approvedByName: 'Pat PM', approvedByRole: 'project_manager', selfApproved: false, sourcesReadAt: now, updatedBy: USERS.pm.uid }
    : status === 'withdrawn'
      ? { status, revision: 2, withdrawnAt: now, withdrawnBy: createdBy, withdrawReason: 'Withdrawn' }
      : {}
  await testEnv.withSecurityRulesDisabled(async (env) => { await setDoc(faRef(env.firestore(), number), { ...base, ...extra }) })
}

const withdrawPatch = (user, over = {}) => ({
  status: 'withdrawn', withdrawnAt: serverTimestamp(), withdrawnBy: user.uid, withdrawReason: 'No longer needed',
  revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid, ...over,
})
const approvePatch = (user, over = {}) => ({
  status: 'approved', approvedAt: serverTimestamp(), approvedBy: user.uid, approvedByName: 'Forged', approvedByRole: user.role,
  selfApproved: false, sourcesReadAt: serverTimestamp(), revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid, ...over,
})

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set — refusing to run rules tests outside the emulator. Run `npm run test:rules`.')
  }
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync(RULES_PATH, 'utf8') } })
})
afterAll(async () => { await testEnv?.cleanup() })

beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (env) => {
    const db = env.firestore()
    for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { name: u.uid, email: `${u.uid}@x.test`, role: u.role, companyId: u.companyId })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Other Co', baseCurrency: 'AUD' })
  })
  await seedProject()
})

// ── Reads and tenancy ────────────────────────────────────────────────────────

describe('reads', () => {
  beforeEach(async () => { await seedRevision(1, 'approved') })

  it.each(FINANCIAL)('$role reads a revision and lists the history', async (u) => {
    await assertSucceeds(getDoc(faRef(ctx(u), 1)))
    await assertSucceeds(getDocs(query(faCol(ctx(u)), orderBy('createdAt', 'asc'))))
  })
  it.each(OUTSIDERS)('$role ($companyId) is denied get and list', async (u) => {
    await assertFails(getDoc(faRef(ctx(u), 1)))
    await assertFails(getDocs(faCol(ctx(u))))
  })
  it('an unauthenticated caller is denied', async () => {
    await assertFails(getDoc(faRef(anon(), 1)))
    await assertFails(getDocs(faCol(anon())))
  })
  it("another tenant's admin cannot read, create, withdraw or delete here — and cannot write this company's project path", async () => {
    const db = ctx(USERS.other)
    await assertFails(getDoc(faRef(db, 1)))
    await assertFails(setDoc(faRef(db, 2), draftDoc(USERS.other, 2)))
    await assertFails(deleteDoc(faRef(db, 1)))
    await seedRevision(2, 'draft')
    await assertFails(updateDoc(faRef(db, 2), withdrawPatch(USERS.other)))
  })
})

// ── Draft creation ───────────────────────────────────────────────────────────

describe('draft creation', () => {
  it.each(FINANCIAL)('$role prepares revision 1 through the app action (fresh server reads through the rules)', async (u) => {
    const res = await appPrepare(u)
    expect(res.number).toBe(1)
    const d = await readFa(1)
    expect(d).toMatchObject({ number: 1, status: 'draft', revision: 1, currency: 'AUD', rowCount: 2, openItemsAcknowledged: true, createdBy: u.uid, approvedAt: null, approvedBy: null })
    expect(d.figures).toEqual(EXPECTED_FIGURES)
    expect(d.sources.budgetApprovalId).toBe('ba1')
  })
  it.each(OUTSIDERS)('$role ($companyId) cannot create a draft', async (u) => {
    await assertFails(setDoc(faRef(ctx(u), 1), draftDoc(u, 1)))
  })
  it('a direct create exactly as the app writes it is accepted', async () => {
    await assertSucceeds(setDoc(faRef(ctx(USERS.qs), 1), draftDoc(USERS.qs, 1)))
  })

  const bad = [
    ['an id that is not the revision number', 'x1', {}],
    ['a number that does not match the id', 1, { number: 2 }],
    ['revision 0', 0, { number: 0 }],
    ['a non-integer number', 1, { number: 1.5 }],
    ['born approved', 1, { status: 'approved' }],
    ['born withdrawn', 1, { status: 'withdrawn' }],
    ['born with an approver', 1, { approvedBy: 'u_qs' }],
    ['born with an approval time', 1, { approvedAt: Timestamp.now() }],
    ['born with an approver name', 1, { approvedByName: 'Me' }],
    ['born with a self-approval flag', 1, { selfApproved: false }],
    ['born with a source read time', 1, { sourcesReadAt: Timestamp.now() }],
    ['a revision other than 1', 1, { revision: 2 }],
    ['an empty basis', 1, { reason: '   ' }],
    ['a 501-character basis', 1, { reason: 'x'.repeat(501) }],
    ['a 201-character reference', 1, { reference: 'x'.repeat(201) }],
    ['a currency that is not the project currency', 1, { currency: 'USD' }],
    ['no acknowledgement', 1, { openItemsAcknowledged: false }],
    ['figures that are not a map', 1, { figures: 'nope' }],
    ['rows that are not a list', 1, { rows: {} }],
    ['a rowCount that is not the list size', 1, { rowCount: 5 }],
    ['an extra key', 1, { finalised: true }],
    ['another user as creator', 1, { createdBy: 'u_pm' }],
    ['a client-chosen creation time', 1, { createdAt: Timestamp.fromMillis(1) }],
    ['a withdrawal already recorded', 1, { withdrawnBy: 'u_qs' }],
  ]
  it.each(bad)('refused: %s', async (_label, id, over) => {
    await assertFails(setDoc(faRef(ctx(USERS.qs), id), draftDoc(USERS.qs, typeof id === 'number' ? id : 1, over)))
  })
  it('refused: a missing required key', async () => {
    await assertFails(setDoc(faRef(ctx(USERS.qs), 1), without(draftDoc(USERS.qs, 1), 'sources')))
  })

  it('1,000 cost-code rows of 170-character names are accepted as ONE document; 1,001 are refused', async () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => ({
      costCodeId: `cc${String(i).padStart(18, '0')}`, costCodeName: 'N'.repeat(170), approvedBudget: 1234567.89, actualCost: 1234567.89, variance: 0,
    }))
    await assertFails(setDoc(faRef(ctx(USERS.qs), 1), draftDoc(USERS.qs, 1, { rows: rows(1001), rowCount: 1001 })))
    await assertSucceeds(setDoc(faRef(ctx(USERS.qs), 1), draftDoc(USERS.qs, 1, { rows: rows(FINAL_ACCOUNT_LIMITS.ROWS), rowCount: FINAL_ACCOUNT_LIMITS.ROWS, reason: 'r'.repeat(500), reference: 'x'.repeat(200) })))
    expect((await readFa(1)).rows).toHaveLength(1000)
  })

  it('DC47, stated plainly: a draft with invented figures IS accepted — a draft is not authoritative', async () => {
    const forged = draftDoc(USERS.qs, 1)
    forged.figures = { ...forged.figures, finalProfit: 99999999 }
    await assertSucceeds(setDoc(faRef(ctx(USERS.qs), 1), forged))
    // …and it still cannot be approved by any client (below).
    await assertFails(updateDoc(faRef(ctx(USERS.admin), 1), approvePatch(USERS.admin)))
  })
})

// ── Revision numbering and the single open draft ─────────────────────────────

describe('revision numbering', () => {
  it('revision 2 is refused while revision 1 does not exist, and while it is still a draft', async () => {
    await assertFails(setDoc(faRef(ctx(USERS.qs), 2), draftDoc(USERS.qs, 2)))
    await appPrepare(USERS.qs)
    await assertFails(setDoc(faRef(ctx(USERS.pm), 2), draftDoc(USERS.pm, 2)))
    await expect(appPrepare(USERS.pm)).rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.OPEN_DRAFT })
  })
  it('revision 2 opens once revision 1 is approved, and once it is withdrawn', async () => {
    await seedRevision(1, 'approved')
    expect((await appPrepare(USERS.qs)).number).toBe(2)
    await appWithdraw(USERS.qs, 2)
    expect((await appPrepare(USERS.pm)).number).toBe(3)
    expect((await readFa(1)).status).toBe('approved')   // the earlier approved revision is untouched
  })
  it('a revision number can never be reused: a create over an existing revision is an update, and is refused', async () => {
    await seedRevision(1, 'withdrawn')
    await assertFails(setDoc(faRef(ctx(USERS.qs), 1), draftDoc(USERS.qs, 1)))
    await seedRevision(2, 'approved')
    await assertFails(setDoc(faRef(ctx(USERS.admin), 2), draftDoc(USERS.admin, 2)))
  })
  it('revision 3 cannot skip a missing revision 2', async () => {
    await seedRevision(1, 'approved')
    await assertFails(setDoc(faRef(ctx(USERS.qs), 3), draftDoc(USERS.qs, 3)))
  })
  it('TWO CONCURRENT prepares land exactly ONE draft', async () => {
    const results = await Promise.allSettled([appPrepare(USERS.qs), appPrepare(USERS.pm)])
    const ok = results.filter(r => r.status === 'fulfilled')
    const refused = results.filter(r => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect([FINAL_ACCOUNT_ERROR.OPEN_DRAFT, FINAL_ACCOUNT_ERROR.STALE, FINAL_ACCOUNT_ERROR.PERMISSION]).toContain(refused[0].reason.kind)
    let docs = []
    await testEnv.withSecurityRulesDisabled(async (env) => { docs = (await getDocs(faCol(env.firestore()))).docs.map(d => d.data()) })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ number: 1, status: 'draft' })
  })
  it('the app refuses to prepare when a requirement is not met — nothing is written', async () => {
    await testEnv.withSecurityRulesDisabled(async (env) => {
      await setDoc(doc(env.firestore(), `${P()}/variations`, 'v9'), { variationType: 'client', status: 'submitted', submittedSubtotal: 5, lineItems: [], createdAt: Timestamp.now() })
    })
    await expect(appPrepare(USERS.qs)).rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.NOT_READY, details: { blockers: ['clientVariations'] } })
    expect(await readFa(1)).toBeNull()
  })
})

// ── NO client can approve ────────────────────────────────────────────────────

describe('direct client approval is denied', () => {
  beforeEach(async () => { await appPrepare(USERS.qs) })

  it.each([USERS.admin, USERS.pm, USERS.qs])('$role cannot flip a draft to approved', async (u) => {
    await assertFails(updateDoc(faRef(ctx(u), 1), approvePatch(u)))
    await assertFails(updateDoc(faRef(ctx(u), 1), { status: 'approved', revision: 2, updatedAt: serverTimestamp(), updatedBy: u.uid }))
    expect((await readFa(1)).status).toBe('draft')
  })
  it('no shape of approval is accepted: with figures, without, by set-merge, or in a transaction', async () => {
    const db = ctx(USERS.admin)
    const c = computeFinalAccount({ project: { id: PROJECT_A }, currencyCode: 'AUD', sources: sourcesOf(readyProject()), sourceStates: settledSourceStates() })
    await assertFails(updateDoc(faRef(db, 1), { ...approvePatch(USERS.admin), ...finalAccountContent(c) }))
    await assertFails(setDoc(faRef(db, 1), approvePatch(USERS.admin), { merge: true }))
    await assertFails(setDoc(faRef(db, 1), { ...draftDoc(USERS.admin, 1), ...approvePatch(USERS.admin) }))
    await assertFails(runTransaction(db, async (tx) => { await tx.get(faRef(db, 1)); tx.update(faRef(db, 1), approvePatch(USERS.admin)) }))
  })
  it('a draft\'s figures, rows, basis and provenance cannot be edited by anyone', async () => {
    const db = ctx(USERS.admin)
    const stamp = { revision: 2, updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid }
    await assertFails(updateDoc(faRef(db, 1), { 'figures.finalProfit': 1, ...stamp }))
    await assertFails(updateDoc(faRef(db, 1), { rows: [], rowCount: 0, ...stamp }))
    await assertFails(updateDoc(faRef(db, 1), { reason: 'Edited', ...stamp }))
    await assertFails(updateDoc(faRef(db, 1), { sources: {}, ...stamp }))
    await assertFails(updateDoc(faRef(db, 1), { currency: 'USD', ...stamp }))
    await assertFails(updateDoc(faRef(db, 1), { createdBy: USERS.admin.uid, ...stamp }))
  })
})

// ── Withdrawal ───────────────────────────────────────────────────────────────

describe('withdrawal', () => {
  beforeEach(async () => { await appPrepare(USERS.qs) })

  it('the preparer withdraws their draft through the app', async () => {
    expect(await appWithdraw(USERS.qs, 1)).toBe(2)
    expect(await readFa(1)).toMatchObject({ status: 'withdrawn', withdrawnBy: USERS.qs.uid, withdrawReason: 'Superseded by late invoice', revision: 2 })
  })
  it.each([USERS.admin, USERS.pm])('$role (an approver) withdraws another user\'s draft', async (u) => {
    await assertSucceeds(updateDoc(faRef(ctx(u), 1), withdrawPatch(u)))
  })
  it('another qs who did not prepare it cannot withdraw it', async () => {
    await assertFails(updateDoc(faRef(ctx(USERS.qs2), 1), withdrawPatch(USERS.qs2)))
  })
  it.each(OUTSIDERS)('$role ($companyId) cannot withdraw', async (u) => {
    await assertFails(updateDoc(faRef(ctx(u), 1), withdrawPatch(u)))
  })

  const badWithdraw = [
    ['no reason', { withdrawReason: '  ' }],
    ['a 501-character reason', { withdrawReason: 'x'.repeat(501) }],
    ['another user recorded as withdrawing', { withdrawnBy: 'u_pm' }],
    ['a client-chosen withdrawal time', { withdrawnAt: Timestamp.fromMillis(1) }],
    ['no revision increment', { revision: 1 }],
    ['a revision jump', { revision: 3 }],
    ['a figure changed in the same write', { 'figures.finalProfit': 1 }],
    ['the basis changed in the same write', { reason: 'Edited' }],
    ['an approver recorded in the same write', { approvedBy: 'u_qs' }],
  ]
  it.each(badWithdraw)('refused: %s', async (_label, over) => {
    await assertFails(updateDoc(faRef(ctx(USERS.qs), 1), withdrawPatch(USERS.qs, over)))
  })
  it('a stale copy is refused by the app (revision and stamps)', async () => {
    const db = ctx(USERS.qs)
    const seen = { ...(await getDoc(faRef(db, 1))).data(), revision: 7 }
    await expect(runFinalAccountWithdraw({ db, accountRef: faRef(db, 1), seen, reason: 'x', uid: USERS.qs.uid, runTransaction, serverTimestamp }))
      .rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.STALE })
    expect((await readFa(1)).status).toBe('draft')
  })
})

// ── Terminal states and deletion ─────────────────────────────────────────────

describe('approved and withdrawn revisions are terminal and immutable', () => {
  it.each(['approved', 'withdrawn'])('a %s revision accepts no update of any kind, from any role', async (status) => {
    await seedRevision(1, status)
    for (const u of [USERS.admin, USERS.pm, USERS.qs]) {
      const db = ctx(u)
      const stamp = { revision: 3, updatedAt: serverTimestamp(), updatedBy: u.uid }
      await assertFails(updateDoc(faRef(db, 1), withdrawPatch(u, { revision: 3 })))
      await assertFails(updateDoc(faRef(db, 1), approvePatch(u, { revision: 3 })))
      await assertFails(updateDoc(faRef(db, 1), { status: 'draft', ...stamp }))
      await assertFails(updateDoc(faRef(db, 1), { 'figures.finalProfit': 1, ...stamp }))
      await assertFails(updateDoc(faRef(db, 1), { reason: 'Edited', ...stamp }))
      await assertFails(updateDoc(faRef(db, 1), { approvedByName: 'Someone else', ...stamp }))
      await assertFails(setDoc(faRef(db, 1), draftDoc(u, 1)))
    }
    expect((await readFa(1)).status).toBe(status)
  })
  it('the app refuses to withdraw an approved revision', async () => {
    await seedRevision(1, 'approved')
    await expect(appWithdraw(USERS.admin, 1)).rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.STALE })
  })
  it.each(['draft', 'approved', 'withdrawn'])('a %s revision can never be deleted, by any role', async (status) => {
    await seedRevision(1, status)
    for (const u of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.other]) await assertFails(deleteDoc(faRef(ctx(u), 1)))
    expect(await readFa(1)).not.toBeNull()
  })
  it('a later approved revision leaves the earlier one byte-for-byte unchanged (supersession is derived)', async () => {
    await seedRevision(1, 'approved')
    const before = JSON.stringify(await readFa(1))
    await seedRevision(2, 'approved')
    expect(JSON.stringify(await readFa(1))).toBe(before)
  })
})

// ── No other collection is affected ──────────────────────────────────────────

describe('scope', () => {
  it('preparing and withdrawing a Final Account writes no other document', async () => {
    const snapshotAll = async () => {
      const out = {}
      await testEnv.withSecurityRulesDisabled(async (env) => {
        const db = env.firestore()
        for (const name of [...FA_PROJECT_COLLECTIONS, 'commercial', 'approvedBudget']) {
          out[name] = JSON.stringify((await getDocs(collection(db, `${P()}/${name}`))).docs.map(d => [d.id, d.data()]))
        }
      })
      return out
    }
    const before = await snapshotAll()
    await appPrepare(USERS.qs)
    await appWithdraw(USERS.qs, 1)
    expect(await snapshotAll()).toEqual(before)
  })
})
