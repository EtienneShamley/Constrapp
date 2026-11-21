import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  admin, resetEmulators, seedCompany, seedUser, req, expectTeamError, clock, silentLog,
  callFunction, clientSignIn, clientSignOutAll, COMPANY_A, COMPANY_B,
} from './_harness.js'
import {
  buildTransferProposal, transferRequestKey, boqSourceInfo, TRANSFER_ROW_STATE,
} from '../../src/lib/boqBudgetTransfer'
import { boqLineAmount, boqTotals } from '../../src/lib/boq'
import { resolveBudgetSource, BUDGET_SOURCE } from '../../src/lib/budgetApproval'

// ── transferBoqToBudget against the Auth + Firestore (+ Functions) emulators ──
// (L4, ADR-81)
//
// The handler is called DIRECTLY with the real Admin SDK — real transactions,
// real QUERIES inside them — and, at the end, through the deployed onCall
// wrapper over HTTP (App Check, ID token). The reviewKey each test sends is
// built by the BROWSER's module (src/lib/boqBudgetTransfer.js) from the
// registers as read, exactly as the review dialog builds it.
//
// What is proven here:
//   · WHO may transfer, and that the company never comes from the request;
//   · that NO client amount exists: the written amounts are the server's own;
//   · source consistency: a BOQ edit, a NEW BOQ item and a NEW manual budget
//     line during the transfer are each ordered against it — never missed;
//   · idempotence: simultaneous and repeated requests write once, audit once;
//   · that no approved-budget document is read or written.

const PROJECT = 'projectA'
let A, handlersMod, H, now, hooks

const company = (c = COMPANY_A) => A.db.collection('companies').doc(c)
const base = (c = COMPANY_A, p = PROJECT) => company(c).collection('projects').doc(p)
const docsOf = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }))
const lines = (c = COMPANY_A, p = PROJECT) => base(c, p).collection('budgetLines').get().then(docsOf)
const line = (id) => base().collection('budgetLines').doc(id).get().then(s => (s.exists ? s.data() : null))
const audits = (c = COMPANY_A) => company(c).collection('auditEvents').where('type', '==', 'boq_budget.transferred').get().then(s => s.docs.map(d => d.data()))
const call = (uid, data) => H.transferBoqToBudget(req(uid, data))

async function fresh({ enabled = true, db = null, sourceLimit = undefined } = {}) {
  now = clock('2026-11-21T02:00:00Z')
  hooks = {}
  H = handlersMod.createBoqBudgetHandlers({ db: db ?? A.db, now, log: silentLog, config: () => ({ enabled }), hooks, ...(sourceLimit ? { sourceLimit } : {}) })
}

const CODES = [
  { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
  { id: 'cc2', code: '05-100', name: 'Steel', isActive: true },
  { id: 'cc3', code: '09-100', name: 'Finishes', isActive: true },
  { id: 'ccOff', code: '99-000', name: 'Retired', isActive: false },
]
const at = (i) => A.Timestamp.fromMillis(1_763_000_000_000 + i * 1000)
const boqItem = (costCodeId, quantity, rate, over = {}) => ({
  status: 'active', costCodeId, costCodeName: `${costCodeId} name`, description: 'Measured work', itemNumber: '', section: '', unit: 'm2',
  quantity, rate, amount: boqLineAmount(quantity, rate), currency: 'AUD', revision: 1, notes: '', ...over,
})
// cc1: 2 × 50 + 3 × 12.34 = 137.02 · cc2: 4 × 250 = 1,000.00
const ITEMS = { a: boqItem('cc1', 2, 50), b: boqItem('cc1', 3, 12.34), c: boqItem('cc2', 4, 250) }

async function seedProject({ items = ITEMS, budgetLines = {}, project = {}, c = COMPANY_A, p = PROJECT, codes = CODES } = {}) {
  const batch = A.db.batch()
  batch.set(company(c), { name: `Company ${c}`, baseCurrency: 'AUD' }, { merge: true })
  batch.set(base(c, p), { name: 'Harbour Road', currency: 'AUD', currencyLocked: false, createdAt: at(0), createdBy: 'seed', ...project })
  codes.forEach(({ id, ...rest }, i) => batch.set(company(c).collection('costCodes').doc(id), { ...rest, createdAt: at(i) }))
  Object.entries(items).forEach(([id, data], i) => batch.set(base(c, p).collection('boqItems').doc(id), { ...data, createdAt: at(i), createdBy: 'seed', updatedAt: at(i), updatedBy: 'seed' }))
  Object.entries(budgetLines).forEach(([id, data], i) => batch.set(base(c, p).collection('budgetLines').doc(id), { committed: 0, actual: 0, invoiced: 0, notes: '', ...data, createdAt: at(i), createdBy: 'seed' }))
  await batch.commit()
}

// The registers as the browser would hold them, and the proposal its dialog shows.
async function review(c = COMPANY_A, p = PROJECT) {
  const [boq, bl, cc] = await Promise.all([base(c, p).collection('boqItems').get(), base(c, p).collection('budgetLines').get(), company(c).collection('costCodes').get()])
  return buildTransferProposal({ boqItems: docsOf(boq), budgetLines: docsOf(bl), costCodes: docsOf(cc), currencyCode: 'AUD' })
}
const request = async (setToZero = []) => ({ projectId: PROJECT, reviewKey: (await review()).reviewKey, setToZero })

async function seedPeople() {
  await seedCompany(COMPANY_A, 'Acme Builders')
  await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A, name: 'Ada Admin' })
  await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A, name: 'Pat PM' })
  await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A, name: 'Quin QS' })
}

// The approved-budget documents of a project with an approved version AND an
// approved adjustment — the transfer must leave every one byte-for-byte alone.
async function seedApprovedBudget() {
  const entries = [{ lineId: 'm-old', costCodeId: 'cc3', costCodeName: '09-100 — Finishes', budgeted: 500 }]
  await base().collection('budgetLines').doc('m-old').set({ costCodeId: 'cc3', costCodeName: '09-100 — Finishes', budgeted: 500, committed: 0, actual: 0, invoiced: 0, notes: '', createdAt: at(0), createdBy: 'seed' })
  await base().collection('budgetApprovals').doc('ba1').set({ reason: 'Initial', status: 'approved', currency: 'AUD', entryCount: 1, total: 500, version: 1, approvedAt: at(1), approvedBy: 'u_pm', revision: 2, createdAt: at(0), createdBy: 'u_qs' })
  await base().collection('budgetApprovalSnapshots').doc('ba1').set({ entryCount: 1, total: 500, currency: 'AUD', capturedAt: at(0), capturedBy: 'u_qs', entries })
  await base().collection('budgetAdjustments').doc('adj1').set({ type: 'increase', costCodeId: 'cc3', costCodeName: '09-100 — Finishes', fromCostCodeId: null, fromCostCodeName: '', amount: 25, currency: 'AUD', reason: 'x', reference: '', baseApprovalId: 'ba1', baseVersion: 1, sequence: 1, status: 'approved', approvedAt: at(2), approvedBy: 'u_pm', revision: 2, createdAt: at(1), createdBy: 'u_qs' })
  await base().collection('approvedBudget').doc('current').set({ activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1, approvedAt: at(1), approvedBy: 'u_pm', createdAt: at(1), createdBy: 'u_pm', updatedAt: at(2), updatedBy: 'u_pm', adjustmentCount: 1, adjustmentNet: 25, lastAdjustmentId: 'adj1' })
}
const APPROVED_PATHS = [['budgetApprovals', 'ba1'], ['budgetApprovalSnapshots', 'ba1'], ['budgetAdjustments', 'adj1'], ['approvedBudget', 'current']]
const approvedState = async () => Promise.all(APPROVED_PATHS.map(async ([col, id]) => {
  const s = await base().collection(col).doc(id).get()
  return { path: `${col}/${id}`, data: JSON.stringify(s.data()), updateTime: s.updateTime.valueOf() }
}))

beforeAll(async () => {
  A = await admin()
  handlersMod = await import('../../functions/src/boqBudget/handlers.js')
})
beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  await fresh()
  await seedPeople()
})
afterAll(async () => { await clientSignOutAll() })

// ── Authorisation ────────────────────────────────────────────────────────────

describe('who may transfer', () => {
  beforeEach(async () => { await seedProject() })

  it('an unauthenticated request is refused before validation and before any read', async () => {
    await expectTeamError(H.transferBoqToBudget(req(null, { nonsense: true })), A.CODE.UNAUTHENTICATED)
  })
  it('a signed-in uid with no membership is refused', async () => {
    await A.auth.createUser({ uid: 'u_bare', email: 'bare@x.test', password: 'correct-horse-battery' })
    await expectTeamError(call('u_bare', await request()), A.CODE.NO_MEMBERSHIP)
  })
  it.each(['u_admin', 'u_pm', 'u_qs'])('%s — an active financial role — transfers', async (uid) => {
    const res = await call(uid, await request())
    expect(res).toMatchObject({ outcome: 'applied', created: 2, refreshed: 0, zeroed: 0 })
    expect((await line('boq-cc1')).createdBy).toBe(uid)
  })
  it('subcontractor, client and super_admin are refused, and nothing is written', async () => {
    await seedUser({ uid: 'u_sub', email: 'sub@x.test', role: 'subcontractor', companyId: COMPANY_A })
    await seedUser({ uid: 'u_client', email: 'client@x.test', role: 'client', companyId: COMPANY_A })
    await seedUser({ uid: 'u_super', email: 'super@x.test', role: 'super_admin', companyId: COMPANY_A })
    const data = await request()
    for (const uid of ['u_sub', 'u_client', 'u_super']) await expectTeamError(call(uid, data), A.CODE.BOQ_TRANSFER_FORBIDDEN)
    expect(await lines()).toEqual([])
    expect(await audits()).toEqual([])
  })
  it('a deactivated member is refused', async () => {
    await A.db.collection('users').doc('u_qs').update({ status: 'deactivated', companyId: null })
    await expectTeamError(call('u_qs', await request()), A.CODE.MEMBERSHIP_INACTIVE)
  })
  it('a role removed INSIDE the transaction window is refused by the transaction\'s own membership read', async () => {
    const data = await request()
    // The fail-fast check passes; the membership the transaction reads is the changed one.
    const realGet = A.db.collection('users').doc('u_qs')
    const proxied = new Proxy(A.db, {
      get(target, prop) {
        if (prop !== 'runTransaction') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v }
        return async (fn, opts) => { await realGet.update({ role: 'client' }); return target.runTransaction(fn, opts) }
      },
    })
    await fresh({ db: proxied })
    await expectTeamError(call('u_qs', data), A.CODE.BOQ_TRANSFER_FORBIDDEN)
    expect(await lines()).toEqual([])
  })
  it("another company's admin gets NOT FOUND for this project id — the company is never taken from the request", async () => {
    await seedCompany(COMPANY_B, 'Other Co')
    await seedUser({ uid: 'u_adminB', email: 'admin@other.test', role: 'company_admin', companyId: COMPANY_B })
    const data = await request()
    await expectTeamError(call('u_adminB', data), A.CODE.NOT_FOUND)
    // With a project of the SAME id in their own company they reach only their own records:
    // Company A's review key does not match Company B's (empty) BOQ — a stale review that reveals nothing.
    await seedProject({ items: {}, c: COMPANY_B, codes: [] })
    const err = await expectTeamError(call('u_adminB', data), A.CODE.BOQ_TRANSFER_STALE)
    expect(Object.keys(err.details)).toEqual(['code'])
    expect(await lines()).toEqual([])
    expect(await lines(COMPANY_B)).toEqual([])
    expect(await audits(COMPANY_B)).toEqual([])
  })
  it('the kill switch answers boq-transfer-disabled before authentication or any read', async () => {
    await fresh({ enabled: false })
    await expectTeamError(H.transferBoqToBudget(req(null, {})), A.CODE.BOQ_TRANSFER_DISABLED)
    await expectTeamError(call('u_admin', await request()), A.CODE.BOQ_TRANSFER_DISABLED)
    expect(await lines()).toEqual([])
  })
  it('an amount, a line list or a companyId in the request is refused as invalid', async () => {
    const data = await request()
    for (const extra of [{ budgeted: 1 }, { lines: [{ costCodeId: 'cc1', amount: 9 }] }, { companyId: COMPANY_A }, { total: 5 }]) {
      await expectTeamError(call('u_admin', { ...data, ...extra }), A.CODE.INVALID_ARGUMENT)
    }
    expect(await lines()).toEqual([])
  })
})

// ── The transfer ─────────────────────────────────────────────────────────────

describe('transfer', () => {
  it('creates ONE working line per cost code at the server\'s own amounts, with provenance, the currency lock and one audit event', async () => {
    await seedProject()
    const data = await request()
    const res = await call('u_qs', data)
    expect(res).toMatchObject({ outcome: 'applied', created: 2, refreshed: 0, zeroed: 0, blocked: 0, before: 0, after: 1137.02, attempts: 1 })

    const all = await lines()
    expect(all.map(l => l.id).sort()).toEqual(['boq-cc1', 'boq-cc2'])
    const l1 = await line('boq-cc1')
    expect(l1).toMatchObject({
      costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 137.02, committed: 0, actual: 0, invoiced: 0, notes: '',
      createdBy: 'u_qs', updatedBy: 'u_qs',
    })
    expect(l1.createdAt.toMillis()).toBe(l1.updatedAt.toMillis())
    expect(l1.boqSource.first).toMatchObject({ by: 'u_qs', amount: 137.02, itemCount: 2 })
    expect(l1.boqSource.latest).toMatchObject({ by: 'u_qs', amount: 137.02, itemCount: 2, operation: 'create', transferCount: 1 })
    expect(l1.boqSource.first.at.toMillis()).toBe(l1.createdAt.toMillis())                // server time, same commit
    expect(l1.boqSource.latest.requestKey).toBe(transferRequestKey(data.reviewKey, []))
    expect(l1.boqSource.latest.resultKey).toBe((await review()).reviewKey)                // the state it produced IS the current state
    expect(l1.boqSource.latest.fingerprint).toBe(l1.boqSource.first.fingerprint)
    expect((await line('boq-cc2')).budgeted).toBe(1000)

    // Σ working lines == the BOQ priced total, to the cent.
    const boq = docsOf(await base().collection('boqItems').get())
    expect(Math.round(all.reduce((s, l) => s + l.budgeted, 0) * 100)).toBe(Math.round(boqTotals(boq).pricedTotal * 100))
    expect((await base().get()).data().currencyLocked).toBe(true)

    const events = await audits()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorUid: 'u_qs', source: 'callable', before: { amount: 0 } })
    expect(events[0].after).toMatchObject({ projectId: PROJECT, currency: 'AUD', created: 2, refreshed: 0, zeroed: 0, amount: 1137.02, requestKey: l1.boqSource.latest.requestKey, resultKey: l1.boqSource.latest.resultKey })
    expect(events[0].after.lines).toEqual([
      expect.objectContaining({ costCodeId: 'cc1', operation: 'create', from: null, to: 137.02, itemCount: 2 }),
      expect.objectContaining({ costCodeId: 'cc2', operation: 'create', from: null, to: 1000, itemCount: 1 }),
    ])
  })

  it('a refresh after a BOQ price change moves budgeted and the latest-transfer evidence TOGETHER and preserves the first', async () => {
    await seedProject()
    await call('u_qs', await request())
    const before = await line('boq-cc2')
    await base().collection('boqItems').doc('c').update({ rate: 260, amount: 1040 })
    expect((await review()).rows.find(r => r.costCodeId === 'cc2')).toMatchObject({ state: TRANSFER_ROW_STATE.REFRESH, boqCents: 104000, sourcedCents: 100000 })
    now.advance(60000)
    const res = await call('u_pm', await request())
    expect(res).toMatchObject({ outcome: 'applied', created: 0, refreshed: 1, before: 1000, after: 1040 })
    const after = await line('boq-cc2')
    expect(after.budgeted).toBe(1040)
    expect(after.boqSource.latest).toMatchObject({ by: 'u_pm', amount: 1040, operation: 'refresh', transferCount: 2 })
    expect(after.boqSource.latest.at.toMillis()).toBe(after.updatedAt.toMillis())
    expect(after.boqSource.latest.fingerprint).not.toBe(before.boqSource.latest.fingerprint)
    expect(after.boqSource.first).toEqual(before.boqSource.first)                         // the ORIGINAL source evidence never moves
    expect(after.createdAt.toMillis()).toBe(before.createdAt.toMillis())
    expect(after.createdBy).toBe('u_qs')
    expect(after.updatedBy).toBe('u_pm')
    // The untouched code was not rewritten.
    expect((await line('boq-cc1')).boqSource.latest.transferCount).toBe(1)
    expect(await audits()).toHaveLength(2)
  })

  it('a manual edit of a BOQ-sourced line is visible as a discrepancy, and the next transfer offers to refresh it', async () => {
    await seedProject()
    await call('u_qs', await request())
    await base().collection('budgetLines').doc('boq-cc2').update({ budgeted: 1250 })     // what the Budget tab's editor writes
    const edited = { id: 'boq-cc2', ...(await line('boq-cc2')) }
    expect(boqSourceInfo(edited)).toMatchObject({ isBoqSourced: true, manuallyChanged: true })
    expect(edited.boqSource.latest.amount).toBe(1000)                                    // evidence describes the TRANSFER, not the edit
    const res = await call('u_qs', await request())
    expect(res).toMatchObject({ outcome: 'applied', refreshed: 1, before: 1250, after: 1000 })
    expect(boqSourceInfo({ id: 'boq-cc2', ...(await line('boq-cc2')) }).manuallyChanged).toBe(false)
  })

  it('blocked cost codes are left alone while the others transfer: unpriced, manual line, inactive, missing, currency', async () => {
    await seedProject({
      items: {
        ...ITEMS,
        u1: boqItem('cc3', 1, 100), u2: boqItem('cc3', 2, null),             // partially priced
        off: boqItem('ccOff', 1, 10), gone: boqItem('ccGone', 1, 10),
      },
      budgetLines: { manual1: { costCodeId: 'cc2', costCodeName: '05-100 — Steel', budgeted: 900 } },
    })
    const res = await call('u_qs', await request())
    expect(res).toMatchObject({ outcome: 'applied', created: 1, blocked: 4 })
    expect((await lines()).map(l => l.id).sort()).toEqual(['boq-cc1', 'manual1'])
    expect((await line('manual1')).budgeted).toBe(900)                                   // the manual line is never touched
  })

  it('a currency mismatch blocks its cost code — nothing in another currency enters the budget', async () => {
    await seedProject({ items: { a: boqItem('cc1', 2, 50, { currency: 'NZD' }), c: ITEMS.c } })
    const res = await call('u_qs', await request())
    expect(res).toMatchObject({ outcome: 'applied', created: 1, blocked: 1 })
    expect((await lines()).map(l => l.id)).toEqual(['boq-cc2'])
  })

  it('the project currency is the server\'s own resolution: a review made in another currency is stale', async () => {
    await seedProject({ project: { currency: 'NZD' } })
    // The browser key above assumes AUD; the server resolves NZD and every AUD item is a mismatch.
    await expectTeamError(call('u_qs', await request()), A.CODE.BOQ_TRANSFER_STALE)
    expect(await lines()).toEqual([])
  })

  it('zero rate is a price: the code transfers at 0', async () => {
    await seedProject({ items: { z: boqItem('cc3', 5, 0) } })
    expect(await call('u_qs', await request())).toMatchObject({ outcome: 'applied', created: 1, after: 0 })
    expect((await line('boq-cc3')).budgeted).toBe(0)
  })
})

// ── Fully voided source ──────────────────────────────────────────────────────

describe('a fully voided source', () => {
  beforeEach(async () => {
    await seedProject()
    await call('u_qs', await request())
    await base().collection('boqItems').doc('c').update({ status: 'void' })
  })
  it('is NOT zeroed by default: an unticked request writes nothing', async () => {
    const res = await call('u_qs', await request())
    expect(res).toMatchObject({ outcome: 'unchanged', created: 0, refreshed: 0, zeroed: 0 })
    expect((await line('boq-cc2')).budgeted).toBe(1000)
    expect(await audits()).toHaveLength(1)
  })
  it('is set to zero only when ticked — with provenance and an audit event', async () => {
    const res = await call('u_pm', await request(['cc2']))
    expect(res).toMatchObject({ outcome: 'applied', zeroed: 1, before: 1000, after: 0 })
    const l = await line('boq-cc2')
    expect(l.budgeted).toBe(0)
    expect(l.boqSource.latest).toMatchObject({ amount: 0, itemCount: 0, operation: 'zero', transferCount: 2, by: 'u_pm' })
    expect(l.boqSource.first.amount).toBe(1000)
    expect((await audits())).toHaveLength(2)
  })
  it('set-to-zero on a code that is NOT eligible refuses the whole request as blocked', async () => {
    const err = await expectTeamError(call('u_pm', await request(['cc1'])), A.CODE.BOQ_TRANSFER_BLOCKED)
    expect(err.details.costCodeIds).toEqual(['cc1'])
    expect((await line('boq-cc1')).budgeted).toBe(137.02)
    expect((await line('boq-cc2')).budgeted).toBe(1000)
  })
})

// ── Stale review, repeats and no-ops ─────────────────────────────────────────

describe('stale review and idempotent repeats', () => {
  it('a review made before a BOQ edit is refused and nothing is written', async () => {
    await seedProject()
    const data = await request()
    await base().collection('boqItems').doc('a').update({ quantity: 3, amount: 150 })
    await expectTeamError(call('u_qs', data), A.CODE.BOQ_TRANSFER_STALE)
    expect(await lines()).toEqual([])
    expect(await audits()).toEqual([])
    expect((await base().get()).data().currencyLocked).toBe(false)
  })
  it('a review made before a manual budget line appeared is refused', async () => {
    await seedProject()
    const data = await request()
    await base().collection('budgetLines').doc('late').set({ costCodeId: 'cc1', costCodeName: 'x', budgeted: 5, createdAt: at(9), createdBy: 'u_pm' })
    await expectTeamError(call('u_qs', data), A.CODE.BOQ_TRANSFER_STALE)
    expect((await lines()).map(l => l.id)).toEqual(['late'])
  })
  it('a manual line WITHOUT createdAt — invisible to the ordered browser query — is still seen by the server and blocks its code', async () => {
    await seedProject()
    const data = await request()
    await base().collection('budgetLines').doc('nostamp').set({ costCodeId: 'cc2', budgeted: 5 })
    await expectTeamError(call('u_qs', data), A.CODE.BOQ_TRANSFER_STALE)
    expect((await lines()).map(l => l.id)).toEqual(['nostamp'])
  })
  it('the IDENTICAL request repeated after a successful commit is ALREADY APPLIED: no second line, no second audit event, no rewrite', async () => {
    await seedProject()
    const data = await request()
    const first = await call('u_qs', data)
    expect(first.outcome).toBe('applied')
    const stamp = (await base().collection('budgetLines').doc('boq-cc1').get()).updateTime.valueOf()
    const again = await call('u_qs', data)
    expect(again).toMatchObject({ outcome: 'already-applied', created: 0, refreshed: 0, zeroed: 0, byCaller: true })
    expect((await call('u_pm', data))).toMatchObject({ outcome: 'already-applied', byCaller: false })
    expect((await lines()).map(l => l.id).sort()).toEqual(['boq-cc1', 'boq-cc2'])
    expect((await base().collection('budgetLines').doc('boq-cc1').get()).updateTime.valueOf()).toBe(stamp)
    expect(await audits()).toHaveLength(1)
  })
  it('the same request repeated after the BOQ CHANGED is a stale review — not "already applied"', async () => {
    await seedProject()
    const data = await request()
    await call('u_qs', data)
    await base().collection('boqItems').doc('late').set({ ...boqItem('cc1', 1, 5), createdAt: at(50) })
    await expectTeamError(call('u_qs', data), A.CODE.BOQ_TRANSFER_STALE)
    expect((await line('boq-cc1')).budgeted).toBe(137.02)
    expect(await audits()).toHaveLength(1)
  })
  it('the same request repeated after a working line was EDITED BY HAND is a stale review — not "already applied"', async () => {
    await seedProject()
    const data = await request()
    await call('u_qs', data)
    await base().collection('budgetLines').doc('boq-cc2').update({ budgeted: 999 })
    await expectTeamError(call('u_qs', data), A.CODE.BOQ_TRANSFER_STALE)
    expect((await line('boq-cc2')).budgeted).toBe(999)
  })
  it('the same review with DIFFERENT set-to-zero choices is not the applied request', async () => {
    await seedProject()
    const data = await request()
    await call('u_qs', data)
    await expectTeamError(call('u_qs', { ...data, setToZero: ['cc1'] }), A.CODE.BOQ_TRANSFER_STALE)
  })
  it('a current review with nothing to write is UNCHANGED: no write and NO audit event', async () => {
    await seedProject()
    await call('u_qs', await request())
    const stamps = async () => (await base().collection('budgetLines').get()).docs.map(d => d.updateTime.valueOf())
    const before = await stamps()
    const res = await call('u_pm', await request())
    expect(res).toMatchObject({ outcome: 'unchanged', created: 0, refreshed: 0, zeroed: 0, before: 0, after: 0 })
    expect(await stamps()).toEqual(before)
    expect(await audits()).toHaveLength(1)
  })
  it('an empty BOQ is UNCHANGED and locks no currency', async () => {
    await seedProject({ items: {} })
    expect((await call('u_qs', await request())).outcome).toBe('unchanged')
    expect((await base().get()).data().currencyLocked).toBe(false)
    expect(await audits()).toEqual([])
  })
})

// ── Races ────────────────────────────────────────────────────────────────────

describe('simultaneous transfers', () => {
  it('TWO users at once with the same review: one set of lines, one audit event; the other is answered already-applied', async () => {
    await seedProject()
    const data = await request()
    const results = await Promise.allSettled([call('u_pm', data), call('u_admin', data)])
    expect(results.every(r => r.status === 'fulfilled')).toBe(true)
    expect(results.map(r => r.value.outcome).sort()).toEqual(['already-applied', 'applied'])
    expect((await lines()).map(l => l.id).sort()).toEqual(['boq-cc1', 'boq-cc2'])
    expect(await audits()).toHaveLength(1)
    expect((await line('boq-cc1')).boqSource.latest.transferCount).toBe(1)
  })
  it('the SAME user double-submitting: one write, one audit event', async () => {
    await seedProject()
    const data = await request()
    const results = await Promise.allSettled([call('u_qs', data), call('u_qs', data), call('u_qs', data)])
    expect(results.every(r => r.status === 'fulfilled')).toBe(true)
    expect(results.map(r => r.value.outcome).sort()).toEqual(['already-applied', 'already-applied', 'applied'])
    expect(await audits()).toHaveLength(1)
    expect((await lines())).toHaveLength(2)
  })
  it('a transaction aborted by contention is retried and still writes exactly once', async () => {
    await seedProject()
    hooks.afterRead = async ({ attempt }) => { if (attempt === 1) throw Object.assign(new Error('forced contention'), { code: 10 }) }
    const res = await call('u_qs', await request())
    expect(res).toMatchObject({ outcome: 'applied', attempts: 2 })
    expect(await audits()).toHaveLength(1)
  })
})

// A competing write is started WHILE the transfer transaction is between its
// reads and its writes. Serializability allows exactly two histories:
//   (A) the write is ordered BEFORE the transfer — the transfer is retried,
//       sees it, the review no longer matches, and it refuses; or
//   (B) the transfer is ordered FIRST — it succeeds on what it read, and the
//       write commits strictly AFTER it.
// What must never happen: a transfer that succeeded although a source write it
// did not account for had ALREADY committed.
async function raceTransferAgainst(startWrite) {
  await seedProject()
  const data = await request()
  let pending = null
  hooks.afterRead = async ({ attempt }) => {
    if (attempt !== 1) return
    pending = startWrite().then(r => ({ ok: true, time: r.writeTime }), e => ({ ok: false, e }))
    await new Promise(r => setTimeout(r, 400))    // let the competing write reach the backend
  }
  const outcome = await call('u_qs', data).then(v => ({ applied: true, v }), e => ({ applied: false, e }))
  const write = await pending
  expect(write.ok).toBe(true)                      // the competing write is never lost
  const cc1 = await base().collection('budgetLines').doc('boq-cc1').get()
  console.log(`[history] ${outcome.applied ? 'B — transfer first, competing write after' : `A — competing write first, transfer refused (${outcome.e?.details?.code ?? outcome.e?.message})`}`)
  return { outcome, write, cc1 }
}

describe('consistency with concurrent source writes', () => {
  it('a BOQ EDIT during the transfer is ordered against it', async () => {
    const { outcome, write, cc1 } = await raceTransferAgainst(() => base().collection('boqItems').doc('a').update({ quantity: 3, amount: 150 }))
    if (outcome.applied) {
      // History (B): transferred on quantity 2; the edit committed strictly after.
      expect(cc1.data().budgeted).toBe(137.02)
      expect(write.time.valueOf() > cc1.updateTime.valueOf()).toBe(true)
    } else {
      // History (A): the retry saw the edit and refused.
      expect(outcome.e.details.code).toBe(A.CODE.BOQ_TRANSFER_STALE)
      expect(cc1.exists).toBe(false)
      expect(await audits()).toHaveLength(0)
    }
    // Either way the BOQ and the budget are never silently inconsistent: a fresh review shows the truth.
    const state = (await review()).rows.find(r => r.costCodeId === 'cc1').state
    expect(state).toBe(outcome.applied ? TRANSFER_ROW_STATE.REFRESH : TRANSFER_ROW_STATE.CREATE)
  })

  it('a NEW BOQ item appearing during the transfer is ordered against it — never missed', async () => {
    const { outcome, write, cc1 } = await raceTransferAgainst(() =>
      base().collection('boqItems').doc('late').set({ ...boqItem('cc1', 1, 500), createdAt: A.Timestamp.now(), createdBy: 'u_pm' }))
    if (outcome.applied) {
      expect(cc1.data().budgeted).toBe(137.02)
      expect(cc1.data().boqSource.latest.itemCount).toBe(2)
      expect(write.time.valueOf() > cc1.updateTime.valueOf()).toBe(true)
    } else {
      expect(outcome.e.details.code).toBe(A.CODE.BOQ_TRANSFER_STALE)
      expect(cc1.exists).toBe(false)
    }
  })

  it('a NEW UNPRICED item appearing during the transfer cannot be skipped: applied-before, or refused', async () => {
    const { outcome, write, cc1 } = await raceTransferAgainst(() =>
      base().collection('boqItems').doc('late').set({ ...boqItem('cc1', 1, null), createdAt: A.Timestamp.now(), createdBy: 'u_pm' }))
    if (outcome.applied) expect(write.time.valueOf() > cc1.updateTime.valueOf()).toBe(true)
    else { expect(outcome.e.details.code).toBe(A.CODE.BOQ_TRANSFER_STALE); expect(cc1.exists).toBe(false) }
  })

  it('a MANUAL budget line created during the transfer never ends up beside a BOQ-sourced line it did not see', async () => {
    const { outcome, write, cc1 } = await raceTransferAgainst(() =>
      base().collection('budgetLines').doc('manual-late').set({ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 70, committed: 0, actual: 0, invoiced: 0, notes: '', createdAt: A.Timestamp.now(), createdBy: 'u_pm' }))
    if (outcome.applied) {
      expect(write.time.valueOf() > cc1.updateTime.valueOf()).toBe(true)
      // The later manual line is then reported: the code is blocked as multiple lines, not double-counted silently.
      expect((await review()).rows.find(r => r.costCodeId === 'cc1').blockers).toEqual(['multiple-lines'])
    } else {
      expect(outcome.e.details.code).toBe(A.CODE.BOQ_TRANSFER_STALE)
      expect(cc1.exists).toBe(false)
      expect((await lines()).map(l => l.id)).toEqual(['manual-late'])
    }
  })

  it('a BOQ item VOIDED during the transfer is ordered against it', async () => {
    const { outcome, write, cc1 } = await raceTransferAgainst(() => base().collection('boqItems').doc('b').update({ status: 'void' }))
    if (outcome.applied) expect(write.time.valueOf() > cc1.updateTime.valueOf()).toBe(true)
    else expect(outcome.e.details.code).toBe(A.CODE.BOQ_TRANSFER_STALE)
  })
})

// ── Deterministic overlap: BOTH serial orders, forced ────────────────────────
//
// The races above let the backend choose the order (the emulator always chose
// "transfer first"). These force each order with explicit synchronisation and
// then verify the order from the server's own commit times.
//
//   ORDER B (transfer first). The competing write is started after the
//   transfer has read its sources and is PROVEN still unsettled when the
//   transfer proceeds to its writes — the transaction's locks are holding it.
//
//   ORDER A (source write first). The competing write is started the same way,
//   then the transfer's first attempt is aborted (the retryable ABORTED the
//   backend itself raises under contention). Its locks are released, the write
//   commits, and a gate holds the second attempt until that commit is
//   acknowledged — so the attempt that finally decides reads the CHANGED
//   source, inside one continuous transferBoqToBudget call.
//
// No guard was added to the Function for this: the tests observe Firestore's
// existing transaction guarantees.
const settledWithin = (promise, ms) => Promise.race([promise.then(() => true), new Promise(r => setTimeout(() => r(false), ms))])

// Order B. Returns the transfer result, the competing write and what the hook saw.
async function overlapTransferFirst(data, startWrite) {
  let pending = null
  let writeSettledBeforeTransferCommit = null
  hooks.afterRead = async ({ attempt }) => {
    if (attempt !== 1) return
    pending = startWrite()
    writeSettledBeforeTransferCommit = await settledWithin(pending, 500)
  }
  const result = await call('u_qs', data)
  const write = await pending
  hooks.afterRead = undefined
  return { result, write, writeSettledBeforeTransferCommit }
}

// Order A. `data` is the request; the transfer's outcome is returned as-is.
async function overlapSourceWriteFirst(data, startWrite) {
  let pending = null
  let committed = null
  const order = []
  hooks.afterRead = async ({ attempt }) => {
    order.push(`transfer attempt ${attempt} read`)
    if (attempt !== 1) return
    pending = startWrite().then((w) => { order.push('source write committed'); committed = w; return w })
    await new Promise(r => setTimeout(r, 300))                   // the write is now waiting on this attempt's locks
    order.push('transfer attempt 1 aborted')
    throw Object.assign(new Error('forced contention'), { code: 10 })
  }
  // Hold every later attempt until the source write is acknowledged. A
  // transaction that has read nothing holds no lock, so this cannot deadlock.
  const gated = new Proxy(A.db, {
    get(target, prop) {
      if (prop !== 'runTransaction') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v }
      return (fn, opts) => target.runTransaction(async (tx) => { if (pending) await pending; return fn(tx) }, opts)
    },
  })
  const savedHooks = hooks
  await fresh({ db: gated })
  hooks.afterRead = savedHooks.afterRead
  const outcome = await call('u_qs', data).then(v => ({ applied: true, v }), e => ({ applied: false, e }))
  await pending
  await fresh()
  return { outcome, write: committed, order }
}

// The review key of the state a planned source change WILL produce — what a
// reviewer who had already seen that change would send.
async function reviewKeyAfter(mutate) {
  const [boq, bl, cc] = await Promise.all([base().collection('boqItems').get(), base().collection('budgetLines').get(), company().collection('costCodes').get()])
  const state = { boqItems: docsOf(boq), budgetLines: docsOf(bl), costCodes: docsOf(cc), currencyCode: 'AUD' }
  mutate(state)
  return buildTransferProposal(state).reviewKey
}

const lineSnap = (id) => base().collection('budgetLines').doc(id).get()

describe('forced overlap — a BOQ item UPDATE', () => {
  const update = () => base().collection('boqItems').doc('a').update({ quantity: 3, amount: 150 })   // cc1: 137.02 → 187.02

  it('ORDER B — the transfer commits first on the earlier source; the update commits after it and shows as drift', async () => {
    await seedProject()
    const { result, write, writeSettledBeforeTransferCommit } = await overlapTransferFirst(await request(), update)
    expect(writeSettledBeforeTransferCommit).toBe(false)            // it was held while the transfer finished
    expect(result).toMatchObject({ outcome: 'applied', created: 2, attempts: 1 })
    const cc1 = await lineSnap('boq-cc1')
    expect(cc1.data().budgeted).toBe(137.02)                        // the valid EARLIER source state
    expect(cc1.data().boqSource.latest.itemCount).toBe(2)
    expect(write.writeTime.valueOf() > cc1.updateTime.valueOf()).toBe(true)   // serialisation order, from the server
    expect((await base().collection('boqItems').doc('a').get()).data().quantity).toBe(3)   // the update was not lost
    // …and is visible afterwards as reconciliation drift: the line is offered a refresh to the new BOQ total.
    expect((await review()).rows.find(r => r.costCodeId === 'cc1')).toMatchObject({ state: TRANSFER_ROW_STATE.REFRESH, boqCents: 18702, sourcedCents: 13702 })
    expect(await audits()).toHaveLength(1)
  })

  it('ORDER A — the update commits first; a review of the OLD source is refused as stale and nothing is written', async () => {
    await seedProject()
    const { outcome, write, order } = await overlapSourceWriteFirst(await request(), update)
    expect(order).toEqual(['transfer attempt 1 read', 'transfer attempt 1 aborted', 'source write committed', 'transfer attempt 2 read'])
    expect(outcome.applied).toBe(false)
    expect(outcome.e.details.code).toBe(A.CODE.BOQ_TRANSFER_STALE)
    expect(write.writeTime).toBeTruthy()
    expect(await lines()).toEqual([])
    expect(await audits()).toEqual([])
    expect((await base().get()).data().currencyLocked).toBe(false)
    expect((await base().collection('boqItems').doc('a').get()).data().quantity).toBe(3)
  })

  it('ORDER A — the update commits first; a review of the NEW source is applied on the CHANGED source', async () => {
    await seedProject()
    const reviewKey = await reviewKeyAfter(s => { Object.assign(s.boqItems.find(i => i.id === 'a'), { quantity: 3, amount: 150 }) })
    const { outcome, write, order } = await overlapSourceWriteFirst({ projectId: PROJECT, reviewKey, setToZero: [] }, update)
    expect(order).toEqual(['transfer attempt 1 read', 'transfer attempt 1 aborted', 'source write committed', 'transfer attempt 2 read'])
    expect(outcome.applied).toBe(true)
    expect(outcome.v).toMatchObject({ outcome: 'applied', created: 2, attempts: 2, after: 1187.02 })
    const cc1 = await lineSnap('boq-cc1')
    expect(cc1.data().budgeted).toBe(187.02)                        // the CHANGED source, never the stale 137.02
    expect(cc1.updateTime.valueOf() > write.writeTime.valueOf()).toBe(true)
    expect((await review()).rows.every(r => r.state === TRANSFER_ROW_STATE.UNCHANGED)).toBe(true)   // consistent: no drift
    expect(await audits()).toHaveLength(1)
  })
})

describe('forced overlap — a BOQ item CREATE', () => {
  const create = () => base().collection('boqItems').doc('late').set({ ...boqItem('cc1', 1, 500), createdAt: A.Timestamp.now(), createdBy: 'u_pm' })   // cc1: 137.02 → 637.02

  it('ORDER B — the transfer commits first without the new item; the item commits after it and shows as drift', async () => {
    await seedProject()
    const { result, write, writeSettledBeforeTransferCommit } = await overlapTransferFirst(await request(), create)
    expect(writeSettledBeforeTransferCommit).toBe(false)
    expect(result).toMatchObject({ outcome: 'applied', created: 2, attempts: 1 })
    const cc1 = await lineSnap('boq-cc1')
    expect(cc1.data()).toMatchObject({ budgeted: 137.02 })
    expect(cc1.data().boqSource.latest.itemCount).toBe(2)
    expect(write.writeTime.valueOf() > cc1.updateTime.valueOf()).toBe(true)
    expect((await review()).rows.find(r => r.costCodeId === 'cc1')).toMatchObject({ state: TRANSFER_ROW_STATE.REFRESH, boqCents: 63702, itemCount: 3 })
  })

  it('ORDER A — the new item commits first; a review made without it is refused as stale', async () => {
    await seedProject()
    const { outcome, order } = await overlapSourceWriteFirst(await request(), create)
    expect(order).toEqual(['transfer attempt 1 read', 'transfer attempt 1 aborted', 'source write committed', 'transfer attempt 2 read'])
    expect(outcome.applied).toBe(false)
    expect(outcome.e.details.code).toBe(A.CODE.BOQ_TRANSFER_STALE)
    expect(await lines()).toEqual([])
    expect((await base().collection('boqItems').doc('late').get()).exists).toBe(true)
  })

  it('ORDER A — the new item commits first; a review that includes it is applied WITH it', async () => {
    await seedProject()
    const reviewKey = await reviewKeyAfter(s => { s.boqItems.push({ id: 'late', ...boqItem('cc1', 1, 500) }) })
    const { outcome, write } = await overlapSourceWriteFirst({ projectId: PROJECT, reviewKey, setToZero: [] }, create)
    expect(outcome.applied).toBe(true)
    const cc1 = await lineSnap('boq-cc1')
    expect(cc1.data().budgeted).toBe(637.02)
    expect(cc1.data().boqSource.latest.itemCount).toBe(3)
    expect(cc1.updateTime.valueOf() > write.writeTime.valueOf()).toBe(true)
  })

  it('ORDER A — a new UNPRICED item commits first; a review that includes it leaves its cost code blocked, never partly summed', async () => {
    await seedProject()
    const unpriced = () => base().collection('boqItems').doc('late').set({ ...boqItem('cc1', 1, null), createdAt: A.Timestamp.now(), createdBy: 'u_pm' })
    const reviewKey = await reviewKeyAfter(s => { s.boqItems.push({ id: 'late', ...boqItem('cc1', 1, null) }) })
    const { outcome } = await overlapSourceWriteFirst({ projectId: PROJECT, reviewKey, setToZero: [] }, unpriced)
    expect(outcome.v).toMatchObject({ outcome: 'applied', created: 1, blocked: 1 })
    expect((await lines()).map(l => l.id)).toEqual(['boq-cc2'])      // cc1 was NOT transferred at the stale 137.02
  })
})

describe('forced overlap — a MANUAL budget line insert', () => {
  const insert = () => base().collection('budgetLines').doc('manual-late').set({ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 70, committed: 0, actual: 0, invoiced: 0, notes: '', createdAt: A.Timestamp.now(), createdBy: 'u_pm' })

  it('ORDER B — the transfer commits first; the manual line commits after it and the code is then REPORTED as two lines', async () => {
    await seedProject()
    const { result, write, writeSettledBeforeTransferCommit } = await overlapTransferFirst(await request(), insert)
    expect(writeSettledBeforeTransferCommit).toBe(false)
    expect(result).toMatchObject({ outcome: 'applied', created: 2 })
    const cc1 = await lineSnap('boq-cc1')
    expect(write.writeTime.valueOf() > cc1.updateTime.valueOf()).toBe(true)
    // The transfer was consistent at its own instant (no manual line existed). The later line is not hidden:
    expect((await review()).rows.find(r => r.costCodeId === 'cc1')).toMatchObject({ state: TRANSFER_ROW_STATE.BLOCKED, blockers: ['multiple-lines'], workingCents: 20702 })
  })

  it('ORDER A — the manual line commits first; a review made without it is refused and NO BOQ line is placed beside it', async () => {
    await seedProject()
    const { outcome, order } = await overlapSourceWriteFirst(await request(), insert)
    expect(order).toEqual(['transfer attempt 1 read', 'transfer attempt 1 aborted', 'source write committed', 'transfer attempt 2 read'])
    expect(outcome.applied).toBe(false)
    expect(outcome.e.details.code).toBe(A.CODE.BOQ_TRANSFER_STALE)
    expect((await lines()).map(l => l.id)).toEqual(['manual-late'])
    expect(await audits()).toEqual([])
  })

  it('ORDER A — the manual line commits first; a review that includes it transfers the OTHER codes and blocks this one', async () => {
    await seedProject()
    const reviewKey = await reviewKeyAfter(s => { s.budgetLines.push({ id: 'manual-late', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 70 }) })
    const { outcome, write } = await overlapSourceWriteFirst({ projectId: PROJECT, reviewKey, setToZero: [] }, insert)
    expect(outcome.v).toMatchObject({ outcome: 'applied', created: 1, blocked: 1 })
    expect((await lines()).map(l => l.id).sort()).toEqual(['boq-cc2', 'manual-late'])   // never boq-cc1 beside the manual line
    expect((await line('manual-late')).budgeted).toBe(70)
    expect((await lineSnap('boq-cc2')).updateTime.valueOf() > write.writeTime.valueOf()).toBe(true)
  })
})

// ── Failures ─────────────────────────────────────────────────────────────────

describe('failure handling', () => {
  it('a failure inside the transaction writes NOTHING — no partial lines, no lock, no audit event', async () => {
    await seedProject()
    hooks.afterRead = async () => { throw new Error('boom') }
    await expect(call('u_qs', await request())).rejects.toThrow('boom')
    expect(await lines()).toEqual([])
    expect(await audits()).toEqual([])
    expect((await base().get()).data().currencyLocked).toBe(false)
  })
  it('a write REJECTED AT COMMIT rolls back every line: no partial transfer survives', async () => {
    await seedProject()
    const data = await request()
    // A real commit-time failure: the second line's create is pointed at a
    // document that already exists, so the server rejects the commit
    // (ALREADY_EXISTS) after the first create was staged.
    const taken = company().collection('scratch').doc('taken')
    await taken.set({ here: true })
    const colliding = new Proxy(A.db, {
      get(target, prop) {
        if (prop !== 'runTransaction') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v }
        return (fn, opts) => target.runTransaction((tx) => fn(new Proxy(tx, {
          get(t, p) {
            const v = t[p]
            if (p !== 'create') return typeof v === 'function' ? v.bind(t) : v
            return (ref, payload) => t.create(ref.id === 'boq-cc2' ? taken : ref, payload)
          },
        })), opts)
      },
    })
    await fresh({ db: colliding })
    const err = await call('u_qs', data).then(() => null, e => e)
    expect(err).not.toBeNull()
    expect(err.details?.code).toBeUndefined()                   // not a typed refusal
    expect(await lines()).toEqual([])                           // the first create did not survive
    expect(await audits()).toEqual([])
    expect((await base().get()).data().currencyLocked).toBe(false)
    expect((await taken.get()).data()).toEqual({ here: true })
  })
  it('contention on EVERY attempt: a typed boq-transfer-busy after five attempts; certainly nothing written', async () => {
    await seedProject()
    let seen = 0
    hooks.afterRead = async ({ attempt }) => { seen = attempt; throw Object.assign(new Error('contention'), { code: 10 }) }
    const data = await request()
    const err = await expectTeamError(call('u_qs', data), A.CODE.BOQ_TRANSFER_BUSY)
    expect(seen).toBe(5)
    expect(err.details.attempts).toBe(5)
    expect(err.code).toBe('aborted')
    expect(await lines()).toEqual([])
    hooks.afterRead = undefined
    expect((await call('u_qs', data)).outcome).toBe('applied')
  })
  it('a timeout (DEADLINE_EXCEEDED) is NOT turned into a typed refusal; a repeat of the same request is safe either way', async () => {
    await seedProject()
    const data = await request()
    hooks.afterRead = async () => { throw Object.assign(new Error('deadline exceeded'), { code: 4 }) }
    const err = await call('u_qs', data).then(() => null, e => e)
    expect(err).not.toBeNull()
    expect(err.details?.code).toBeUndefined()                   // the onCall wrapper reports it as a bare `internal`
    hooks.afterRead = undefined
    expect((await call('u_qs', data)).outcome).toBe('applied')  // it had not landed: applied now, once
    expect((await call('u_qs', data)).outcome).toBe('already-applied')
    expect(await audits()).toHaveLength(1)
  })
  it('a lost RESPONSE after a commit: the repeat is answered already-applied and nothing is written twice', async () => {
    await seedProject()
    const data = await request()
    // The transaction commits, then the answer is "lost" on the way back.
    const lossy = new Proxy(A.db, {
      get(target, prop) {
        if (prop !== 'runTransaction') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v }
        return async (fn, opts) => { await target.runTransaction(fn, opts); throw Object.assign(new Error('socket hang up'), { code: 14 }) }
      },
    })
    await fresh({ db: lossy })
    const err = await call('u_qs', data).then(() => null, e => e)
    expect(err.details?.code).toBeUndefined()                   // untyped: the client must call it uncertain
    expect(await lines()).toHaveLength(2)                       // …and it DID commit
    await fresh()
    expect(await call('u_qs', data)).toMatchObject({ outcome: 'already-applied', byCaller: true })
    expect(await audits()).toHaveLength(1)
    expect((await line('boq-cc1')).boqSource.latest.transferCount).toBe(1)
  })
  it('a register over the document bound is REFUSED by name — never truncated into a smaller budget', async () => {
    await seedProject()
    await fresh({ sourceLimit: 2 })
    const err = await expectTeamError(call('u_qs', await request()), A.CODE.BOQ_TRANSFER_TOO_LARGE)
    expect(err.details.registers).toEqual(['boqItems', 'costCodes'])
    expect(err.details.limit).toBe(2)
    expect(await lines()).toEqual([])
  })
})

// ── Approved budget invariance ───────────────────────────────────────────────

describe('the approved budget is never touched', () => {
  it('create, refresh and set-to-zero leave every approved-budget document byte-for-byte unchanged, and the approved figure does not move', async () => {
    await seedProject()
    await seedApprovedBudget()
    const before = await approvedState()
    const resolved = async () => {
      const [ptr, hdr, snap, adj, bl] = await Promise.all([
        base().collection('approvedBudget').doc('current').get(), base().collection('budgetApprovals').doc('ba1').get(),
        base().collection('budgetApprovalSnapshots').doc('ba1').get(), base().collection('budgetAdjustments').get(), base().collection('budgetLines').get(),
      ])
      return resolveBudgetSource({
        approvedBudget: { pointer: ptr.data(), header: { id: 'ba1', ...hdr.data() }, snapshot: snap.data(), adjustments: docsOf(adj) },
        budgetLines: docsOf(bl), currencyCode: 'AUD',
      })
    }
    const approvedBefore = await resolved()
    expect(approvedBefore).toMatchObject({ kind: BUDGET_SOURCE.APPROVED, total: 525, version: 1, adjustmentCount: 1 })

    expect((await call('u_qs', await request())).outcome).toBe('applied')                 // create
    await base().collection('boqItems').doc('a').update({ quantity: 4, amount: 200 })
    expect((await call('u_qs', await request())).outcome).toBe('applied')                 // refresh
    await base().collection('boqItems').doc('c').update({ status: 'void' })
    expect((await call('u_pm', await request(['cc2']))).outcome).toBe('applied')          // set to zero

    expect(await approvedState()).toEqual(before)
    const approvedAfter = await resolved()
    expect(approvedAfter).toMatchObject({ kind: BUDGET_SOURCE.APPROVED, total: 525, version: 1, adjustmentCount: 1 })
    expect(approvedAfter.byCostCode).toEqual(approvedBefore.byCostCode)
    // The working register DID move — and the manual line the version was captured from did not.
    expect((await line('boq-cc1')).budgeted).toBe(237.02)
    expect((await line('m-old')).budgeted).toBe(500)
  })

  it('writes ONLY budget lines, the currency lock and the audit event — no other project collection', async () => {
    await seedProject()
    const roots = async () => (await base().listCollections()).map(c => c.id).sort()
    const before = await roots()
    await call('u_qs', await request())
    expect(await roots()).toEqual([...new Set([...before, 'budgetLines'])].sort())
    const boqAfter = docsOf(await base().collection('boqItems').get())
    expect(boqAfter.map(i => i.updatedBy)).toEqual(['seed', 'seed', 'seed'])               // the BOQ itself is never written
    const project = (await base().get()).data()
    expect(Object.keys(project).sort()).toEqual(['createdAt', 'createdBy', 'currency', 'currencyLocked', 'name'])
  })

  it('a project whose currency is already locked is not rewritten', async () => {
    await seedProject({ project: { currencyLocked: true } })
    const stamp = (await base().get()).updateTime.valueOf()
    await call('u_qs', await request())
    expect((await base().get()).updateTime.valueOf()).toBe(stamp)
  })
})

// ── Scale, measured ──────────────────────────────────────────────────────────

async function seedLarge(itemCount, codeCount) {
  await seedProject({ items: {}, codes: [] })
  const codes = Array.from({ length: codeCount }, (_, i) => ({ id: `k${String(i).padStart(4, '0')}`, code: `20-${String(i).padStart(4, '0')}`, name: `Trade ${i}`, isActive: true }))
  const items = Array.from({ length: itemCount }, (_, i) => ({ id: `it${String(i).padStart(5, '0')}`, ...boqItem(codes[i % codeCount].id, (i % 17) + 0.5, ((i * 37) % 991) / 7) }))
  const writes = [
    ...codes.map(({ id, ...rest }, i) => [company().collection('costCodes').doc(id), { ...rest, createdAt: at(i) }]),
    ...items.map(({ id, ...rest }, i) => [base().collection('boqItems').doc(id), { ...rest, createdAt: at(i), createdBy: 'seed' }]),
  ]
  for (let start = 0; start < writes.length; start += 400) {
    const batch = A.db.batch()
    writes.slice(start, start + 400).forEach(([ref, data]) => batch.set(ref, data))
    await batch.commit()
  }
  return { items, codes }
}

describe('scale, measured', () => {
  it.each([
    [150, 40],
    [2000, 500],
  ])('%i BOQ items over %i cost codes: read and written in ONE transaction, total equal to the BOQ to the cent', async (itemCount, codeCount) => {
    const { items } = await seedLarge(itemCount, codeCount)
    const data = await request()
    const started = Date.now()
    const res = await call('u_qs', data)
    const elapsed = Date.now() - started
    expect(res).toMatchObject({ outcome: 'applied', created: codeCount, attempts: 1 })
    const all = await lines()
    expect(all).toHaveLength(codeCount)
    const expected = items.reduce((s, i) => s + Math.round(i.amount * 100), 0)
    expect(all.reduce((s, l) => s + Math.round(l.budgeted * 100), 0)).toBe(expected)
    expect(Math.round(res.after * 100)).toBe(expected)
    const events = await audits()
    expect(events).toHaveLength(1)
    expect(events[0].after.lines).toHaveLength(codeCount)
    const auditBytes = Buffer.byteLength(JSON.stringify(events[0]), 'utf8')
    expect(auditBytes).toBeLessThan(900000)                    // the one audit document, under Firestore's 1 MiB
    expect(elapsed).toBeLessThan(60000)                        // far inside the 270-second transaction limit
    console.log(`[measured] transferBoqToBudget: ${itemCount} items / ${codeCount} cost codes → ${codeCount} lines in ${elapsed} ms; audit event ${auditBytes} bytes`)
    // …and a repeat is recognised at the same scale.
    expect((await call('u_qs', data)).outcome).toBe('already-applied')
  }, 180000)
})

// ── Through the deployed wrapper ─────────────────────────────────────────────

describe('the callable as deployed (Functions emulator)', () => {
  beforeEach(async () => { await seedProject() })

  it('a request without an App Check token is refused before the handler runs', async () => {
    const user = await clientSignIn('qs@acme.test')
    const r = await callFunction('transferBoqToBudget', await request(), { idToken: await user.getIdToken(), appCheck: null })
    expect(r.status).toBe(401)
    expect(r.error).toMatchObject({ status: 'UNAUTHENTICATED' })
    expect(await lines()).toEqual([])
  })
  it('an unauthenticated request with App Check gets the typed refusal', async () => {
    const r = await callFunction('transferBoqToBudget', await request())
    expect(r.status).toBe(401)
    expect(r.error).toMatchObject({ details: { code: 'unauthenticated' } })
  })
  it('a client role is refused; an amount in the request is invalid-argument', async () => {
    await seedUser({ uid: 'u_client', email: 'client@acme.test', role: 'client', companyId: COMPANY_A })
    const client = await clientSignIn('client@acme.test')
    const r = await callFunction('transferBoqToBudget', await request(), { idToken: await client.getIdToken() })
    expect(r.status).toBe(403)
    expect(r.error).toMatchObject({ status: 'PERMISSION_DENIED', details: { code: 'boq-transfer-forbidden' } })
    await clientSignOutAll()
    const qs = await clientSignIn('qs@acme.test')
    const bad = await callFunction('transferBoqToBudget', { ...(await request()), budgeted: 5 }, { idToken: await qs.getIdToken() })
    expect(bad.status).toBe(400)
    expect(bad.error).toMatchObject({ details: { code: 'invalid-argument' } })
    expect(await lines()).toEqual([])
  })
  it('a qs transfers end to end; a stale review is a typed refusal; a repeat is already-applied', async () => {
    const qs = await clientSignIn('qs@acme.test')
    const idToken = await qs.getIdToken()
    const data = await request()
    const stale = await callFunction('transferBoqToBudget', { ...data, reviewKey: 'v1:' + '0'.repeat(32) }, { idToken })
    expect(stale.status).toBe(400)
    expect(stale.error).toMatchObject({ status: 'FAILED_PRECONDITION', details: { code: 'boq-transfer-stale-review' } })
    const done = await callFunction('transferBoqToBudget', data, { idToken })
    expect(done.status).toBe(200)
    expect(done.result).toMatchObject({ outcome: 'applied', created: 2, after: 1137.02 })
    const again = await callFunction('transferBoqToBudget', data, { idToken })
    expect(again.result).toMatchObject({ outcome: 'already-applied' })
    expect(await line('boq-cc1')).toMatchObject({ budgeted: 137.02, createdBy: 'u_qs' })
  })
})
