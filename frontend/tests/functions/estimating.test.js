import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  admin, resetEmulators, seedCompany, seedUser, req, expectTeamError, clock, silentLog, COMPANY_A, COMPANY_B,
} from './_harness.js'
import { boqLineAmount } from '../../src/lib/boq'
import { buildTransferProposal } from '../../src/lib/boqBudgetTransfer'
import { estimateSourceKey, defaultEstimateSettings, PRICING_POLICY, ALLOWANCE_MODE, COST_CLASS } from '../../src/lib/estimating'

// ── estimateOperation against the Auth + Firestore emulators (ADR-97) ────────
//
// Handlers are called directly with the Admin SDK (the variation / supplier
// finance pattern). Every expected figure is worked by hand beside its case.

let A, mod, ops, boqMod, H, T, now, hooks, tHooks

const PROJECT = 'projectA'
const company = (c = COMPANY_A) => A.db.collection('companies').doc(c)
const base = (c = COMPANY_A, p = PROJECT) => company(c).collection('projects').doc(p)
const estimateRef = (id, c = COMPANY_A) => base(c).collection('estimates').doc(id)
const header = (id, c = COMPANY_A) => estimateRef(id, c).get().then(s => (s.exists ? s.data() : null))
const chunks = (id) => estimateRef(id).collection('lines').get().then(s => s.docs.map(d => ({ id: d.id, ...d.data() })))
const audits = (type, c = COMPANY_A) => company(c).collection('auditEvents').where('type', '==', type).get().then(s => s.docs.map(d => d.data()))
const docsOf = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }))
const call = (uid, operation, request) => H.estimateOperation(req(uid, { operation, request }))

const settings = (over = {}) => ({ ...defaultEstimateSettings(), ...over })
const build = (uid, estimateId, s = settings(), expectedRevision = null) => call(uid, 'build', { projectId: PROJECT, estimateId, expectedRevision, settings: s })
const approve = async (uid, estimateId, over = {}) => {
  const h = await header(estimateId)
  return call(uid, 'approve', { projectId: PROJECT, estimateId, expectedRevision: h.revision, contentSha256: h.contentSha256, ...over })
}

const at = (i) => A.Timestamp.fromMillis(1_763_000_000_000 + i * 1000)
const boqItem = (costCodeId, quantity, rate, over = {}) => ({
  status: 'active', costCodeId, costCodeName: `${costCodeId} name`, description: 'Measured work', itemNumber: '', section: '', unit: 'm2',
  quantity, rate, amount: boqLineAmount(quantity, rate), currency: 'AUD', revision: 1, notes: '', ...over,
})
// cc1: 10 × 117.75 = 1,177.50 · 3 × 333.33 = 999.99 · ccP: 1 × 5,000.00 (preliminaries)
const ITEMS = {
  a1: boqItem('cc1', 10, 117.75, { itemNumber: '1.1' }),
  a2: boqItem('cc1', 3, 333.33, { itemNumber: '1.2' }),
  p1: boqItem('ccP', 1, 5000, { itemNumber: 'P.1' }),
}
const CODES = [{ id: 'cc1', code: '03-100', name: 'Concrete', isActive: true }, { id: 'ccP', code: '01-100', name: 'Preliminaries', isActive: true }]

async function seedProject({ items = ITEMS, c = COMPANY_A, p = PROJECT } = {}) {
  let batch = A.db.batch()
  let n = 0
  // Phase 2 company activation: on for every fixture company (refusals are tested by turning it off).
  batch.set(company(c), { name: `Company ${c}`, baseCurrency: 'AUD', commercialCompletionEnabled: true }, { merge: true })
  batch.set(base(c, p), { name: 'Harbour Road', currency: 'AUD', currencyLocked: true, createdAt: at(0), createdBy: 'seed' })
  CODES.forEach(({ id, ...rest }, i) => batch.set(company(c).collection('costCodes').doc(id), { ...rest, createdAt: at(i) }))
  for (const [id, data] of Object.entries(items)) {
    batch.set(base(c, p).collection('boqItems').doc(id), { ...data, createdAt: at(n), createdBy: 'seed', updatedAt: at(n), updatedBy: 'seed' })
    n += 1
    if (n % 400 === 0) { await batch.commit(); batch = A.db.batch() }
  }
  await batch.commit()
}
const policy = (segregationEnabled) => company().collection('approvalPolicy').doc('current').set({ segregationEnabled, version: 1, changedBy: 'operator', reason: 'test' })

function fresh({ enabled = true, sourceLimit } = {}) {
  now = clock('2026-11-28T02:00:00Z')
  hooks = {}
  tHooks = {}
  H = mod.createEstimateHandlers({ db: A.db, now, log: silentLog, config: () => ({ enabled }), hooks, ...(sourceLimit ? { sourceLimit } : {}) })
  T = boqMod.createBoqBudgetHandlers({ db: A.db, now, log: silentLog, config: () => ({ enabled: true }), hooks: tHooks })
}

const WORKED = settings({
  pricingPolicy: PRICING_POLICY.MARGIN_ON_SELL, pricingBps: 2000,
  overheadMode: ALLOWANCE_MODE.PERCENTAGE, overheadBps: 750, contingencyMode: ALLOWANCE_MODE.PERCENTAGE, contingencyBps: 500,
  costCodeClasses: [{ costCodeId: 'ccP', costClass: COST_CLASS.PRELIMINARIES }],
})

beforeAll(async () => {
  A = await admin()
  mod = await import('../../functions/src/estimating/handlers.js')
  ops = await import('../../functions/src/estimating/operations.js')
  boqMod = await import('../../functions/src/boqBudget/handlers.js')
})

beforeEach(async () => {
  await resetEmulators()
  await seedCompany(COMPANY_A)
  await seedCompany(COMPANY_B)
  for (const [uid, role] of [['u_admin', 'company_admin'], ['u_pm', 'project_manager'], ['u_pm2', 'project_manager'], ['u_qs', 'qs'], ['u_sub', 'subcontractor'], ['u_client', 'client']]) {
    await seedUser({ uid, email: `${uid}@a.test`, role, companyId: COMPANY_A })
  }
  await seedUser({ uid: 'u_other', email: 'o@b.test', role: 'company_admin', companyId: COMPANY_B })
  await seedProject()
  fresh()
})

describe('build — a populated BOQ becomes a stored draft revision, every figure the server’s', () => {
  it('the worked estimate, to the cent (direct 2,177.49 · prelims 5,000.00 · overheads 538.31 · contingency 358.87 · cost 8,074.67 · sell 10,093.34)', async () => {
    const out = await build('u_qs', 'e1', WORKED)
    expect(out).toMatchObject({ operation: 'build', alreadyApplied: false, state: 'draft', revision: 1, revisionNumber: 1, number: 'EST-0001', lineCount: 3, chunkCount: 1 })
    const h = await header('e1')
    expect(h.totals).toMatchObject({
      directCents: 217_749, preliminariesCents: 500_000, constructionCents: 717_749, overheadCents: 53_831, contingencyCents: 35_887,
      costTotalCents: 807_467, sellCents: 1_009_334, grossProfitCents: 201_867, boqTotalCents: 717_749,
    })
    expect(h).toMatchObject({ state: 'draft', currency: 'AUD', pricingPolicy: 'margin_on_sell', pricingBps: 2000, createdBy: 'u_qs', lastMaterialEditBy: 'u_qs', draftEditors: ['u_qs'] })
    expect(h.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    const boq = docsOf(await base().collection('boqItems').get())
    expect(h.sourceKey).toBe(estimateSourceKey(boq))
    const [chunk] = await chunks('e1')
    expect(chunk).toMatchObject({ id: '00000', index: 0, count: 3, runId: h.runId })
    expect(chunk.lines.map(l => [l.itemId, l.quantity, l.rate, l.amountCents, l.costClass])).toEqual([['a1', 10, 117.75, 117_750, 'direct'], ['a2', 3, 333.33, 99_999, 'direct'], ['p1', 1, 5000, 500_000, 'preliminaries']])
    const [event] = await audits('estimate.built')
    expect(event.after).toMatchObject({ estimateId: 'e1', revision: 1, lineCount: 3, costTotalCents: 807_467, sellCents: 1_009_334, contentSha256: h.contentSha256 })
  })

  it('an EMPTY BOQ, an unpriced item and a breakdown that no longer adds up are refused with nothing written', async () => {
    await base().collection('boqItems').doc('u').set({ ...boqItem('cc1', 2, null, { itemNumber: '9.9' }), createdAt: at(9) })
    const e = await expectTeamError(build('u_qs', 'e1'), A.CODE.ESTIMATE_SOURCE_INVALID)
    expect(e.details).toMatchObject({ problem: 'unpriced', problemCounts: { unpriced: 1 } })
    expect(e.message).toMatch(/9\.9/)
    expect(await header('e1')).toBeNull()

    await resetEmulators(); await seedCompany(COMPANY_A); await seedUser({ uid: 'u_qs', email: 'q@a.test', role: 'qs', companyId: COMPANY_A }); await seedProject({ items: {} })
    await expectTeamError(build('u_qs', 'e2'), A.CODE.ESTIMATE_SOURCE_INVALID)
    expect(await header('e2')).toBeNull()
  })

  it('rate breakdowns: saved only when they add up to the unit rate; a rate changed afterwards refuses the build naming the item', async () => {
    const ok = { labour: 45.5, material: 60.25, plant: 12, subcontractor: 0 }
    await expectTeamError(call('u_qs', 'setComponents', { projectId: PROJECT, items: [{ boqItemId: 'a1', components: { ...ok, plant: 13 } }] }), A.CODE.ESTIMATE_INVALID)
    expect(await call('u_qs', 'setComponents', { projectId: PROJECT, items: [{ boqItemId: 'a1', components: ok }] })).toMatchObject({ alreadyApplied: false, changed: 1 })
    expect(await call('u_qs', 'setComponents', { projectId: PROJECT, items: [{ boqItemId: 'a1', components: ok }] })).toMatchObject({ alreadyApplied: true })
    await build('u_qs', 'e1')
    expect((await header('e1')).totals).toMatchObject({ labourCents: 45_500, materialCents: 60_250, plantCents: 12_000, unanalysedCents: 599_999 })
    await base().collection('boqItems').doc('a1').update({ rate: 120, amount: 1200 })
    const e = await expectTeamError(build('u_qs', 'e2'), A.CODE.ESTIMATE_SOURCE_INVALID)
    expect(e.details.problem).toBe('components-unreconciled')
    expect(await call('u_qs', 'setComponents', { projectId: PROJECT, items: [{ boqItemId: 'a1', components: null }] })).toMatchObject({ changed: 1 })
    await build('u_qs', 'e2')
  })

  it('a DUPLICATE request is answered already-applied with nothing written twice; the same id with other settings is refused', async () => {
    await build('u_qs', 'e1', WORKED)
    const again = await build('u_qs', 'e1', WORKED)
    expect(again).toMatchObject({ alreadyApplied: true, revision: 1 })
    expect(await audits('estimate.built')).toHaveLength(1)
    await expectTeamError(build('u_qs', 'e1', settings()), A.CODE.ESTIMATE_ID_CONFLICT)
    await expectTeamError(build('u_pm', 'e1', WORKED), A.CODE.ESTIMATE_ID_CONFLICT)
    // Even after the BOQ moved, the repeat of the completed request is still already-applied.
    await base().collection('boqItems').doc('a2').update({ quantity: 4, amount: 1333.32 })
    expect(await build('u_qs', 'e1', WORKED)).toMatchObject({ alreadyApplied: true })
  })

  it('a new revision never alters an earlier one; numbers rise; a rebuild of a draft needs its current revision', async () => {
    await build('u_qs', 'e1')
    const before = await header('e1')
    const beforeChunks = await chunks('e1')
    await base().collection('boqItems').doc('a2').update({ quantity: 4, amount: 1333.32 })
    expect(await build('u_qs', 'e2')).toMatchObject({ revisionNumber: 2, number: 'EST-0002' })
    expect(await header('e1')).toEqual(before)
    expect(await chunks('e1')).toEqual(beforeChunks)
    await expectTeamError(build('u_qs', 'e1', settings(), 5), A.CODE.ESTIMATE_STALE)
    const rebuilt = await build('u_qs', 'e1', settings({ pricingBps: 1000 }), 1)
    expect(rebuilt).toMatchObject({ alreadyApplied: false, revision: 2 })
    expect((await header('e1')).totals.boqTotalCents).toBe(117_750 + 133_332 + 500_000)
  })
})

describe('the run fence — an interrupted or overtaken build is never approvable', () => {
  it('INTERRUPTED after its first chunks: the header stays `building`, approval is refused, the builder rebuilds and it completes', async () => {
    const items = Object.fromEntries(Array.from({ length: 1300 }, (_, i) => [`i${String(i).padStart(4, '0')}`, boqItem('cc1', 1, 1)]))
    await resetEmulators(); await seedCompany(COMPANY_A)
    for (const [uid, role] of [['u_qs', 'qs'], ['u_pm', 'project_manager']]) await seedUser({ uid, email: `${uid}@a.test`, role, companyId: COMPANY_A })
    await seedProject({ items })
    fresh()
    hooks.afterChunkGroup = async ({ written }) => { if (written === 4) throw new Error('simulated crash') }
    await expect(build('u_qs', 'e1')).rejects.toThrow('simulated crash')
    const h = await header('e1')
    expect(h.state).toBe('building')
    expect(h.totals).toBeUndefined()
    expect((await chunks('e1')).length).toBe(4)
    await expectTeamError(call('u_pm', 'approve', { projectId: PROJECT, estimateId: 'e1', expectedRevision: 1, contentSha256: 'a'.repeat(64) }), A.CODE.ESTIMATE_BUILDING)
    // Another member cannot reuse the id as a new revision, and may take over the
    // unfinished revision only after the build lease; the builder may resume at once
    // (the same request).
    await expectTeamError(build('u_pm', 'e1'), A.CODE.ESTIMATE_ID_CONFLICT)
    await expectTeamError(build('u_pm', 'e1', settings(), 0), A.CODE.ESTIMATE_BUILDING)
    hooks.afterChunkGroup = undefined
    const out = await build('u_qs', 'e1')
    expect(out).toMatchObject({ state: 'draft', lineCount: 1300, chunkCount: 6 })   // ⌈1,300 ÷ 250⌉
    const done = await header('e1')
    expect(done.runId).not.toBe(h.runId)
    expect((await chunks('e1')).map(c => c.runId)).toEqual(Array(6).fill(done.runId))
    await approve('u_pm', 'e1')
  })

  it('an unfinished revision may be taken over by another member once the build lease has passed', async () => {
    hooks.afterClaim = async () => { throw new Error('simulated crash') }
    await expect(build('u_qs', 'e1')).rejects.toThrow('simulated crash')
    hooks.afterClaim = undefined
    await expectTeamError(build('u_pm', 'e1', settings(), 0), A.CODE.ESTIMATE_BUILDING)
    now.advance(ops.ESTIMATE_BUILD_LEASE_MS + 1000)
    expect(await build('u_pm', 'e1', settings(), 0)).toMatchObject({ state: 'draft', revision: 1 })
    expect(await header('e1')).toMatchObject({ createdBy: 'u_qs', lastMaterialEditBy: 'u_pm' })
  })

  it('OVERTAKEN: a newer build (after the lease) replaces the run id; the older run stops typed and writes nothing more', async () => {
    let release
    const gate = new Promise(r => { release = r })
    hooks.afterClaim = async () => { hooks.afterClaim = undefined; await gate }
    const first = build('u_qs', 'e1')
    // Wait until the first run has claimed the header.
    for (let i = 0; i < 50 && !(await header('e1')); i++) await new Promise(r => setTimeout(r, 50))
    now.advance(ops.ESTIMATE_BUILD_LEASE_MS + 1000)
    await call('u_pm', 'discard', { projectId: PROJECT, estimateId: 'e1', expectedRevision: 0, reason: 'stuck' })
    release()
    await expectTeamError(first, A.CODE.ESTIMATE_SUPERSEDED)
    expect((await header('e1')).state).toBe('discarded')
    expect(await chunks('e1')).toEqual([])
    expect(await audits('estimate.built')).toHaveLength(0)
  })

  it('a CONCURRENT BOQ change during a build: the revision is the BOQ as read, and the change shows as drift at once', async () => {
    hooks.afterRead = async () => { await base().collection('boqItems').doc('a2').update({ quantity: 5, amount: 1666.65 }) }
    await build('u_qs', 'e1')
    const h = await header('e1')
    const [chunk] = await chunks('e1')
    expect(chunk.lines.find(l => l.itemId === 'a2').amountCents).toBe(99_999)
    expect(h.totals.boqTotalCents).toBe(717_749)
    expect(estimateSourceKey(docsOf(await base().collection('boqItems').get()))).not.toBe(h.sourceKey)
  })
})

describe('approve — bound to the reviewed revision and content; stored content re-verified; segregated', () => {
  it('a PM approves the QS’s draft; the revision becomes immutable; a second revision is approved later and the pointer follows', async () => {
    await build('u_qs', 'e1', WORKED)
    const out = await approve('u_pm', 'e1')
    expect(out).toMatchObject({ alreadyApplied: false, state: 'approved', revision: 2 })
    const h = await header('e1')
    expect(h).toMatchObject({ state: 'approved', approvedBy: 'u_pm' })
    const [event] = await audits('estimate.approved')
    expect(event.after).toMatchObject({ estimateId: 'e1', sellCents: 1_009_334, costTotalCents: 807_467, contentSha256: h.contentSha256, segregation: { policyEnabled: false } })
    expect((await base().collection('estimateState').doc('current').get()).data()).toMatchObject({ approvedEstimateId: 'e1', approvedRevisionNumber: 1 })
    // Immutable: no rebuild, no discard, no second approval.
    await expectTeamError(build('u_qs', 'e1', WORKED, 2), A.CODE.ESTIMATE_INVALID)
    await expectTeamError(call('u_qs', 'discard', { projectId: PROJECT, estimateId: 'e1', expectedRevision: 2, reason: '' }), A.CODE.ESTIMATE_INVALID)
    expect(await approve('u_pm', 'e1', { expectedRevision: 1 })).toMatchObject({ alreadyApplied: true })
    await build('u_qs', 'e2')
    await approve('u_admin', 'e2')
    expect((await base().collection('estimateState').doc('current').get()).data()).toMatchObject({ approvedEstimateId: 'e2', approvedRevisionNumber: 2 })
    expect((await header('e1')).state).toBe('approved')
  })

  it('STALE approval: a rebuild after the approver loaded it (revision or content) is refused', async () => {
    await build('u_qs', 'e1')
    const loaded = await header('e1')
    await build('u_qs', 'e1', settings({ pricingBps: 500 }), 1)
    await expectTeamError(call('u_pm', 'approve', { projectId: PROJECT, estimateId: 'e1', expectedRevision: loaded.revision, contentSha256: loaded.contentSha256 }), A.CODE.ESTIMATE_STALE)
    const now2 = await header('e1')
    await expectTeamError(call('u_pm', 'approve', { projectId: PROJECT, estimateId: 'e1', expectedRevision: now2.revision, contentSha256: loaded.contentSha256 }), A.CODE.ESTIMATE_STALE)
    await approve('u_pm', 'e1')
  })

  it('TAMPERED stored content (a chunk line, a total, a missing chunk) is refused before it becomes authoritative', async () => {
    await build('u_qs', 'e1')
    const chunkRef = estimateRef('e1').collection('lines').doc('00000')
    const original = (await chunkRef.get()).data()
    await chunkRef.update({ lines: original.lines.map((l, i) => (i === 0 ? { ...l, amountCents: l.amountCents + 1 } : l)) })
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.ESTIMATE_INCONSISTENT)
    await chunkRef.update({ lines: original.lines.map((l, i) => (i === 0 ? { ...l, rate: 117.76, amountCents: 117_760 } : l)) })
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.ESTIMATE_INCONSISTENT)
    await chunkRef.set(original)
    await estimateRef('e1').update({ 'totals.sellCents': 1 })
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.ESTIMATE_INCONSISTENT)
    await estimateRef('e1').update({ 'totals.sellCents': (await header('e1')).totals.costTotalCents })
    await chunkRef.delete()
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.ESTIMATE_INCONSISTENT)
    expect((await header('e1')).state).toBe('draft')
  })

  it('SEGREGATION enabled: the builder and the last material editor are refused; a title-only rebuild by another does not move the stamp; an independent PM approves', async () => {
    await policy(true)
    await build('u_pm', 'e1')                                                   // the PM builds
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.APPROVAL_SEGREGATION)
    await build('u_pm2', 'e1', settings({ title: 'Tender' }), 1)                // cosmetic: same content
    expect(await header('e1')).toMatchObject({ lastMaterialEditBy: 'u_pm', draftEditors: ['u_pm', 'u_pm2'] })
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.APPROVAL_SEGREGATION)    // still the material editor and creator
    await build('u_pm2', 'e1', settings({ title: 'Tender', pricingBps: 1500 }), 2)   // material
    expect((await header('e1')).lastMaterialEditBy).toBe('u_pm2')
    await expectTeamError(approve('u_pm2', 'e1'), A.CODE.APPROVAL_SEGREGATION)
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.APPROVAL_SEGREGATION)    // creator
    await approve('u_admin', 'e1')
    const [event] = await audits('estimate.approved')
    expect(event.after.segregation).toMatchObject({ policyEnabled: true, independent: true })
  })

  it('DISABLED (default): the builder may approve, and the audit event records it', async () => {
    await build('u_pm', 'e1')
    await approve('u_pm', 'e1')
    const [event] = await audits('estimate.approved')
    expect(event.after.segregation).toMatchObject({ policyEnabled: false, isCreator: true, independent: false })
  })
})

describe('roles, tenants and the switch', () => {
  it('QS prepares but cannot approve; external roles can do neither; a deactivated member is refused', async () => {
    await build('u_qs', 'e1')
    await expectTeamError(approve('u_qs', 'e1'), A.CODE.ESTIMATE_FORBIDDEN)
    for (const uid of ['u_sub', 'u_client']) {
      await expectTeamError(build(uid, `x_${uid}`), A.CODE.ESTIMATE_FORBIDDEN)
      await expectTeamError(approve(uid, 'e1'), A.CODE.ESTIMATE_FORBIDDEN)
    }
    await A.db.collection('users').doc('u_pm').update({ status: 'deactivated' })
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.MEMBERSHIP_INACTIVE)
  })

  it('another company’s administrator cannot read the project or touch its estimate: not found', async () => {
    await build('u_qs', 'e1')
    await company(COMPANY_B).set({ commercialCompletionEnabled: true }, { merge: true })   // B active too: the refusal is the tenant boundary
    await expectTeamError(call('u_other', 'build', { projectId: PROJECT, estimateId: 'e9', expectedRevision: null, settings: settings() }), A.CODE.NOT_FOUND)
    await expectTeamError(call('u_other', 'approve', { projectId: PROJECT, estimateId: 'e1', expectedRevision: 1, contentSha256: (await header('e1')).contentSha256 }), A.CODE.NOT_FOUND)
    expect(await header('e9', COMPANY_B)).toBeNull()
  })

  it('an unknown operation, an extra key, a figure in the request and a 100% margin are refused before anything is read; the switch off refuses everything', async () => {
    await expectTeamError(H.estimateOperation(req('u_qs', { operation: 'post', request: {} })), A.CODE.INVALID_ARGUMENT)
    await expectTeamError(H.estimateOperation(req('u_qs', { operation: 'build', request: { projectId: PROJECT, estimateId: 'e1', expectedRevision: null, settings: settings(), sellCents: 1 } })), A.CODE.INVALID_ARGUMENT)
    await expectTeamError(build('u_qs', 'e1', { ...settings(), totals: {} }), A.CODE.INVALID_ARGUMENT)
    await expectTeamError(build('u_qs', 'e1', settings({ pricingPolicy: PRICING_POLICY.MARGIN_ON_SELL, pricingBps: 10000 })), A.CODE.INVALID_ARGUMENT)
    await expectTeamError(H.estimateOperation(req(null, { operation: 'build', request: {} })), A.CODE.UNAUTHENTICATED)
    fresh({ enabled: false })
    await expectTeamError(build('u_qs', 'e1'), A.CODE.ESTIMATE_DISABLED)
    expect(await header('e1')).toBeNull()
  })
})

describe('handover — ADR-81 unchanged without an estimate; provenance only while the BOQ matches the approved revision', () => {
  const review = async () => {
    const [boq, bl, cc] = await Promise.all([base().collection('boqItems').get(), base().collection('budgetLines').get(), company().collection('costCodes').get()])
    return buildTransferProposal({ boqItems: docsOf(boq), budgetLines: docsOf(bl), costCodes: docsOf(cc), currencyCode: 'AUD' })
  }
  const transfer = async (uid, extra = {}) => T.transferBoqToBudget(req(uid, { projectId: PROJECT, reviewKey: (await review()).reviewKey, setToZero: [], ...extra }))

  it('no estimate at all: the transfer works exactly as before and records no estimate', async () => {
    const out = await transfer('u_qs')
    expect(out).toMatchObject({ outcome: 'applied', created: 2, estimateId: null })
    const line = (await base().collection('budgetLines').doc('boq-cc1').get()).data()
    expect(line.budgeted).toBe(2177.49)
    expect(line.boqSource.latest.estimate).toBeUndefined()
  })

  it('an approved, matching estimate: COST values transferred (never the selling price), provenance recorded, approved budget untouched', async () => {
    await build('u_qs', 'e1', WORKED)
    await approve('u_pm', 'e1')
    const h = await header('e1')
    const out = await transfer('u_qs', { estimateId: 'e1' })
    expect(out).toMatchObject({ outcome: 'applied', estimateId: 'e1' })
    const lines = docsOf(await base().collection('budgetLines').get())
    expect(lines.reduce((s, l) => s + Math.round(l.budgeted * 100), 0)).toBe(h.totals.boqTotalCents)   // 7,177.49 — not 10,093.34
    for (const l of lines) expect(l.boqSource.latest.estimate).toEqual({ estimateId: 'e1', revisionNumber: 1, number: 'EST-0001', sourceKey: h.sourceKey, contentSha256: h.contentSha256 })
    const [event] = await audits('boq_budget.transferred')
    expect(event.after.estimate).toMatchObject({ estimateId: 'e1' })
    expect((await base().collection('budgetApprovals').get()).size).toBe(0)
    expect((await base().collection('approvedBudget').get()).size).toBe(0)
  })

  it('DRIFT: once the BOQ changes, the transfer cannot claim the estimate — refused, nothing written — and still works without it', async () => {
    await build('u_qs', 'e1')
    await approve('u_pm', 'e1')
    await base().collection('boqItems').doc('a2').update({ quantity: 4, amount: 1333.32 })
    await expectTeamError(transfer('u_qs', { estimateId: 'e1' }), A.CODE.BOQ_TRANSFER_ESTIMATE_DRIFT)
    expect((await base().collection('budgetLines').get()).size).toBe(0)
    expect(await transfer('u_qs')).toMatchObject({ outcome: 'applied', estimateId: null })
  })

  it('a draft, a discarded or a foreign estimate cannot be named', async () => {
    await build('u_qs', 'e1')
    await expectTeamError(transfer('u_qs', { estimateId: 'e1' }), A.CODE.BOQ_TRANSFER_ESTIMATE_INVALID)
    await expectTeamError(transfer('u_qs', { estimateId: 'nope' }), A.CODE.BOQ_TRANSFER_ESTIMATE_INVALID)
    expect((await base().collection('budgetLines').get()).size).toBe(0)
  })
})

describe('historical reconstruction and scale', () => {
  it('an approved revision reconstructs exactly after the live BOQ is edited and voided', async () => {
    await build('u_qs', 'e1', WORKED)
    await approve('u_pm', 'e1')
    const h = await header('e1')
    await base().collection('boqItems').doc('a1').update({ status: 'void', voidReason: 'omitted' })
    await base().collection('boqItems').doc('a2').update({ quantity: 9, amount: 2999.97, description: 'changed' })
    const calc = await import('../../functions/src/generated/estimatingCalc.js')
    const lines = (await chunks('e1')).flatMap(c => c.lines)
    const s = Object.fromEntries(calc.ESTIMATE_SETTINGS_KEYS.map(k => [k, h[k]]))
    expect(calc.estimateTotals(lines, calc.normaliseEstimateSettings(s)).totals).toEqual(h.totals)
    expect(calc.sourceKeyOfLines(lines)).toBe(h.sourceKey)
    expect(ops.contentSha256({ currency: h.currency, settings: calc.normaliseEstimateSettings(s), totals: h.totals, lines, sourceKey: h.sourceKey })).toBe(h.contentSha256)
    expect(lines.find(l => l.itemId === 'a2')).toMatchObject({ quantity: 3, description: 'Measured work' })
  })

  it('MEASURED: 5,000 items build and approve; a register over the bound is refused by name', async () => {
    const items = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`i${String(i).padStart(5, '0')}`, boqItem(i % 2 ? 'cc1' : 'ccP', (i % 97) + 1, Math.round(((i % 1000) + 0.37) * 100) / 100, {
      itemNumber: `${Math.floor(i / 100)}.${i % 100}`, description: `Measured work item ${i} — ${'x'.repeat(120)}`,
    })]))
    await resetEmulators(); await seedCompany(COMPANY_A)
    for (const [uid, role] of [['u_qs', 'qs'], ['u_pm', 'project_manager']]) await seedUser({ uid, email: `${uid}@a.test`, role, companyId: COMPANY_A })
    await seedProject({ items })
    fresh()
    const t0 = Date.now()
    const out = await build('u_qs', 'big')
    const buildMs = Date.now() - t0
    expect(out).toMatchObject({ lineCount: 5000, chunkCount: 20 })
    const stored = await chunks('big')
    const sizes = stored.map(c => Buffer.byteLength(JSON.stringify(c), 'utf8'))
    const headerBytes = Buffer.byteLength(JSON.stringify(await header('big')), 'utf8')
    const t1 = Date.now()
    await approve('u_pm', 'big')
    const approveMs = Date.now() - t1
    process.stderr.write(`[ADR-97 measured] 5,000 items: build ${buildMs} ms, approve ${approveMs} ms, ${stored.length} chunks, chunk JSON ${Math.min(...sizes)}–${Math.max(...sizes)} bytes, header ${headerBytes} bytes\n`)
    expect(Math.max(...sizes)).toBeLessThan(400_000)
    // One more item than the bound: refused, nothing written.
    await base().collection('boqItems').doc('extra').set({ ...boqItem('cc1', 1, 1), createdAt: at(1) })
    const e = await expectTeamError(build('u_qs', 'big2'), A.CODE.ESTIMATE_SOURCE_INVALID)
    expect(e.details).toMatchObject({ problem: 'too-large', limit: 5000 })
    expect(await header('big2')).toBeNull()
  }, 240_000)
})

// ── Final verification (ADR-97): activation, concurrency, byte bounds ────────

const reviewNow = async () => {
  const [boq, bl, cc] = await Promise.all([base().collection('boqItems').get(), base().collection('budgetLines').get(), company().collection('costCodes').get()])
  return buildTransferProposal({ boqItems: docsOf(boq), budgetLines: docsOf(bl), costCodes: docsOf(cc), currencyCode: 'AUD' })
}
const transferNow = async (uid, extra = {}) => T.transferBoqToBudget(req(uid, { projectId: PROJECT, reviewKey: (await reviewNow()).reviewKey, setToZero: [], ...extra }))
const liveKey = async () => estimateSourceKey(docsOf(await base().collection('boqItems').get()))
const editA2 = () => base().collection('boqItems').doc('a2').update({ quantity: 5, amount: 1666.65 })   // 5 × 333.33
const setActivation = (on) => company().update({ commercialCompletionEnabled: on })

// The revision reconstructs from ITS OWN stored documents alone, and is
// exactly the BOQ whose key it stores — `expectedKey`, the BOQ as it stood
// before the competing edit — while the live BOQ has drifted from it.
async function expectRepresents(estimateId, expectedKey) {
  const calc = await import('../../functions/src/generated/estimatingCalc.js')
  const h = await header(estimateId)
  const lines = (await chunks(estimateId)).sort((a, b) => a.index - b.index).flatMap(c => c.lines)
  const s = calc.normaliseEstimateSettings(Object.fromEntries(calc.ESTIMATE_SETTINGS_KEYS.map(k => [k, h[k]])))
  expect(h.sourceKey).toBe(expectedKey)
  expect(calc.sourceKeyOfLines(lines)).toBe(h.sourceKey)
  expect(calc.estimateTotals(lines, s).totals).toEqual(h.totals)
  expect(ops.contentSha256({ currency: h.currency, settings: s, totals: h.totals, lines, sourceKey: h.sourceKey })).toBe(h.contentSha256)
  expect(await liveKey()).not.toBe(h.sourceKey)   // drift, visible at once
  return { h, lines }
}

describe('Phase 2 company activation — every operation, fail fast and inside its transaction', () => {
  it('an INACTIVE company: build, approve, discard and setComponents are refused, nothing written', async () => {
    await build('u_qs', 'e1')
    const before = await header('e1')
    await setActivation(false)
    await expectTeamError(build('u_qs', 'e2'), A.CODE.COMMERCIAL_NOT_ACTIVATED)
    expect(await header('e2')).toBeNull()
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.COMMERCIAL_NOT_ACTIVATED)
    await expectTeamError(call('u_qs', 'discard', { projectId: PROJECT, estimateId: 'e1', expectedRevision: 1, reason: 'x' }), A.CODE.COMMERCIAL_NOT_ACTIVATED)
    await expectTeamError(call('u_qs', 'setComponents', { projectId: PROJECT, items: [{ boqItemId: 'a1', components: { labour: 117.75, material: 0, plant: 0, subcontractor: 0 } }] }), A.CODE.COMMERCIAL_NOT_ACTIVATED)
    expect(await header('e1')).toEqual(before)                                // the draft, unchanged
    expect((await base().collection('estimateItemInputs').get()).size).toBe(0)
    expect(await audits('estimate.approved')).toHaveLength(0)
    expect(await audits('estimate.discarded')).toHaveLength(0)
    // Only the boolean `true` activates.
    await company().update({ commercialCompletionEnabled: 'true' })
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.COMMERCIAL_NOT_ACTIVATED)
    await setActivation(true)
    await approve('u_pm', 'e1')
  })

  it('the global switch OFF refuses an ACTIVE company', async () => {
    expect((await company().get()).data().commercialCompletionEnabled).toBe(true)
    fresh({ enabled: false })
    await expectTeamError(build('u_qs', 'e1'), A.CODE.ESTIMATE_DISABLED)
    expect(await header('e1')).toBeNull()
  })

  it('DEACTIVATED between build and approval: the approval is refused; deactivated DURING a build (past the fast check): completion is refused inside its transaction and the header stays `building`', async () => {
    await build('u_qs', 'e1')
    await setActivation(false)
    await expectTeamError(approve('u_pm', 'e1'), A.CODE.COMMERCIAL_NOT_ACTIVATED)
    expect((await header('e1')).state).toBe('draft')
    await setActivation(true)
    hooks.beforeComplete = async () => { await setActivation(false) }
    await expectTeamError(build('u_qs', 'e2'), A.CODE.COMMERCIAL_NOT_ACTIVATED)
    hooks.beforeComplete = undefined
    expect((await header('e2')).state).toBe('building')
    expect((await audits('estimate.built')).map(e => e.after.estimateId)).toEqual(['e1'])
  })
})

describe('CONCURRENCY — a BOQ edit wherever it lands never yields an approved revision or a handover that misstates its BOQ', () => {
  it('(a) AFTER THE SNAPSHOT READ: the revision is the BOQ as read; it approves as that BOQ; the handover cannot claim it', async () => {
    const k0 = await liveKey()
    hooks.afterRead = async () => { await editA2() }
    await build('u_qs', 'e1')
    hooks.afterRead = undefined
    const { lines } = await expectRepresents('e1', k0)
    expect(lines.find(l => l.itemId === 'a2')).toMatchObject({ quantity: 3, amountCents: 99_999 })
    await approve('u_pm', 'e1')
    await expectRepresents('e1', k0)
    await expectTeamError(transferNow('u_qs', { estimateId: 'e1' }), A.CODE.BOQ_TRANSFER_ESTIMATE_DRIFT)
    expect((await base().collection('budgetLines').get()).size).toBe(0)
  })

  it('(b) BETWEEN CHUNK WRITES: the partial revision cannot be approved; the completed one is the BOQ as read', async () => {
    const items = Object.fromEntries(Array.from({ length: 1300 }, (_, i) => [`i${String(i).padStart(4, '0')}`, boqItem('cc1', 1, 1)]))
    await seedProject({ items })
    const k0 = await liveKey()
    const seen = []
    hooks.afterChunkGroup = async ({ written, total }) => {
      if (written !== 4) return
      await base().collection('boqItems').doc('i0000').update({ quantity: 2, amount: 2 })
      const e = await expectTeamError(call('u_pm', 'approve', { projectId: PROJECT, estimateId: 'e1', expectedRevision: 1, contentSha256: 'a'.repeat(64) }), A.CODE.ESTIMATE_BUILDING)
      seen.push([written, total, e.details.code])
    }
    const out = await build('u_qs', 'e1')
    hooks.afterChunkGroup = undefined
    expect(seen).toEqual([[4, 6, A.CODE.ESTIMATE_BUILDING]])
    expect(out).toMatchObject({ lineCount: 1303, chunkCount: 6 })
    const { lines } = await expectRepresents('e1', k0)
    expect(lines.find(l => l.itemId === 'i0000')).toMatchObject({ quantity: 1, amountCents: 100 })
    await approve('u_pm', 'e1')
    await expectTeamError(transferNow('u_qs', { estimateId: 'e1' }), A.CODE.BOQ_TRANSFER_ESTIMATE_DRIFT)
  })

  it('(c) JUST BEFORE COMPLETION: the unfinished revision cannot be approved even with the hash it will store; the result is the BOQ as read', async () => {
    const k0 = await liveKey()
    let attempted = null
    hooks.beforeComplete = async ({ contentSha256 }) => {
      await editA2()
      attempted = await expectTeamError(call('u_pm', 'approve', { projectId: PROJECT, estimateId: 'e1', expectedRevision: 1, contentSha256 }), A.CODE.ESTIMATE_BUILDING)
    }
    await build('u_qs', 'e1')
    hooks.beforeComplete = undefined
    expect(attempted).not.toBeNull()
    await expectRepresents('e1', k0)
    expect(await audits('estimate.approved')).toHaveLength(0)
  })

  it('(d) BETWEEN COMPLETION AND APPROVAL: approval approves the revision as priced (never re-priced); the handover cannot claim it; without the claim ADR-81 is unchanged', async () => {
    const k0 = await liveKey()
    await build('u_qs', 'e1', WORKED)
    const draft = await header('e1')
    await editA2()
    await approve('u_pm', 'e1')
    const { h } = await expectRepresents('e1', k0)
    expect(h.totals).toEqual(draft.totals)
    expect(h.contentSha256).toBe(draft.contentSha256)
    await expectTeamError(transferNow('u_qs', { estimateId: 'e1' }), A.CODE.BOQ_TRANSFER_ESTIMATE_DRIFT)
    expect((await base().collection('budgetLines').get()).size).toBe(0)
    expect(await transferNow('u_qs')).toMatchObject({ outcome: 'applied', estimateId: null })
    for (const l of docsOf(await base().collection('budgetLines').get())) expect(l.boqSource.latest.estimate).toBeUndefined()
  })

  it('(e) BETWEEN APPROVAL AND HANDOVER, landing INSIDE the transfer: the edit is held until the transfer commits, so the recorded provenance is true of the BOQ the transfer read; afterwards the claim is refused', async () => {
    await build('u_qs', 'e1')
    await approve('u_pm', 'e1')
    const h = await header('e1')
    let pending = null
    let settledBeforeCommit = null
    tHooks.afterRead = async ({ attempt }) => {
      if (attempt !== 1) return
      pending = editA2()
      settledBeforeCommit = await Promise.race([pending.then(() => true), new Promise(r => setTimeout(() => r(false), 500))])
    }
    const out = await transferNow('u_qs', { estimateId: 'e1' })
    const write = await pending
    tHooks.afterRead = undefined
    expect(settledBeforeCommit).toBe(false)                                     // held by the transfer's read locks
    expect(out).toMatchObject({ outcome: 'applied', estimateId: 'e1', attempts: 1 })
    const cc1 = await base().collection('budgetLines').doc('boq-cc1').get()
    expect(cc1.data().budgeted).toBe(2177.49)                                   // 1,177.50 + 999.99 — the approved revision's cc1 cost
    expect(cc1.data().boqSource.latest.estimate).toMatchObject({ estimateId: 'e1', sourceKey: h.sourceKey })
    expect(write.writeTime.valueOf() > cc1.updateTime.valueOf()).toBe(true)     // the edit committed strictly AFTER the handover
    // Edit committed BEFORE the next transfer: the claim is refused, nothing written.
    const linesBefore = docsOf(await base().collection('budgetLines').get())
    await expectTeamError(transferNow('u_qs', { estimateId: 'e1' }), A.CODE.BOQ_TRANSFER_ESTIMATE_DRIFT)
    expect(docsOf(await base().collection('budgetLines').get())).toEqual(linesBefore)
  })

  it('an estimate is the WHOLE project BOQ: an edit on a cost code it does not classify, or a new item, is drift too', async () => {
    await build('u_qs', 'e1', WORKED)
    await approve('u_pm', 'e1')
    const h = await header('e1')
    await base().collection('boqItems').doc('n1').set({ ...boqItem('ccX', 1, 1), createdAt: at(20) })
    expect(await liveKey()).not.toBe(h.sourceKey)
    await expectTeamError(transferNow('u_qs', { estimateId: 'e1' }), A.CODE.BOQ_TRANSFER_ESTIMATE_DRIFT)
    await base().collection('boqItems').doc('n1').update({ status: 'void' })      // voided again: the register matches once more
    expect(await liveKey()).toBe(h.sourceKey)
  })
})

// Firestore's documented STORAGE size (cloud.google.com/firestore/docs/storage-size)
// and the actual PROTOBUF encoding of the Admin SDK — both measured independently
// of the module's own bound.
const storageBytes = (v) => {
  if (typeof v === 'string') return Buffer.byteLength(v, 'utf8') + 1
  if (v === null || typeof v === 'boolean') return 1
  if (typeof v === 'number' || v instanceof A.Timestamp) return 8
  if (Array.isArray(v)) return v.reduce((s, x) => s + storageBytes(x), 0)
  return Object.entries(v).reduce((s, [k, x]) => s + Buffer.byteLength(k, 'utf8') + 1 + storageBytes(x), 0)
}
const docStorageBytes = (ref, data) => ref.path.split('/').reduce((s, seg) => s + Buffer.byteLength(seg, 'utf8') + 1, 16) + storageBytes(data) + 32
let proto = null
const protoBytes = (ref, data) => {
  proto ??= createRequire(import.meta.url)(fileURLToPath(new URL('../../functions/node_modules/@google-cloud/firestore/build/protos/firestore_v1_proto_api.js', import.meta.url))).google.firestore.v1
  const doc = proto.Document.fromObject({ name: `projects/demo-constrap-test/databases/(default)/documents/${ref.path}`, fields: A.db._serializer.encodeFields(data) })
  return proto.Write.encode(proto.Write.fromObject({ update: doc })).finish().length
}

describe('D3 #53 — unsupported BOQ text fails safely and clearly (never clipped)', () => {
  it('one description over the bound: the build is refused naming the item and field; no revision is written; the BOQ item is untouched', async () => {
    await seedProject({ items: { ...ITEMS, a1: boqItem('cc1', 10, 117.75, { itemNumber: '1.1', description: 'x'.repeat(1001) }) } })
    const before = (await base().collection('boqItems').doc('a1').get()).data()
    const err = await expectTeamError(build('u_qs', 'eLong'), 'estimate-source-invalid')
    expect(err.details).toMatchObject({ problem: 'text-too-long' })
    expect(err.details.items).toEqual([expect.objectContaining({ kind: 'text-too-long', itemId: 'a1', detail: 'description' })])
    expect(err.message).toMatch(/never shortens it/)
    expect(await header('eLong')).toBeNull()
    expect((await base().collection('boqItems').doc('a1').get()).data()).toEqual(before)
  })
})

describe('BYTE bounds — maximum-length text at the item limit', () => {
  it('MEASURED: 5,000 items, every stored text at its maximum in three-byte characters, a breakdown on every item, 1,000 classified cost codes: builds, approves and reconstructs; every document and transaction within the bound', async () => {
    const calc = await import('../../functions/src/generated/estimatingCalc.js')
    const W = (n, tag = '') => (tag + '€'.repeat(n)).slice(0, n)                        // € is three UTF-8 bytes
    const id128 = (p) => p.padEnd(calc.ESTIMATE_ID_MAX, 'x')
    const codeIds = Array.from({ length: 1001 }, (_, c) => id128(`cc${c}_`))             // 1,000 classified + 1 direct
    const N = calc.ESTIMATE_MAX_ITEMS
    const ids = Array.from({ length: N }, (_, i) => id128(`i${String(i).padStart(5, '0')}_`))
    const rate = 123.4567
    const comps = { labour: 100.1234, material: 20.3333, plant: 3, subcontractor: 0 }   // Σ = 123.4567
    await resetEmulators(); await seedCompany(COMPANY_A)
    for (const [uid, role] of [['u_qs', 'qs'], ['u_pm', 'project_manager']]) await seedUser({ uid, email: `${uid}@a.test`, role, companyId: COMPANY_A })
    await seedProject({ items: {} })
    let batch = A.db.batch()
    let n = 0
    const flush = async () => { if (++n % 400 === 0) { await batch.commit(); batch = A.db.batch() } }
    for (const [i, id] of ids.entries()) {
      const costCodeId = codeIds[i % codeIds.length]
      batch.set(base().collection('boqItems').doc(id), {
        ...boqItem(costCodeId, (i % 89) + 1, rate, {
          // D3 #53: every text AT its bound (one more character is refused, never clipped).
          itemNumber: W(40, String(i)), section: W(200, 'S'), description: W(1000, `D${i}`), unit: W(40, 'u'),
          costCodeName: W(200, 'C'), notes: '',
        }), createdAt: at(i), createdBy: 'seed',
      })
      await flush()
      batch.set(base().collection('estimateItemInputs').doc(id), { components: comps, rate, updatedAt: at(i), updatedBy: 'seed' })
      await flush()
    }
    // A VOID item beyond the bound is not part of the estimate and does not count against it.
    batch.set(base().collection('boqItems').doc(id128('zvoid_')), { ...boqItem(codeIds[0], 1, 1), status: 'void', createdAt: at(0) })
    await batch.commit()
    fresh()
    const s = settings({
      title: W(calc.ESTIMATE_TITLE_MAX), notes: W(calc.ESTIMATE_NOTES_MAX),
      pricingPolicy: PRICING_POLICY.MARGIN_ON_SELL, pricingBps: 1500,
      costCodeClasses: codeIds.slice(0, 1000).map(costCodeId => ({ costCodeId, costClass: COST_CLASS.PRELIMINARIES })),
    })

    const t0 = Date.now()
    const out = await build('u_qs', 'max', s)
    const buildMs = Date.now() - t0
    const hRef = estimateRef('max')
    const h = await header('max')
    const stored = (await chunks('max')).sort((a, b) => a.index - b.index)
    expect(out).toMatchObject({ lineCount: N, chunkCount: stored.length })
    // Every stored text at its bound, stored whole (nothing is clipped).
    const first = stored[0].lines[0]
    expect([first.itemId.length, first.itemNumber.length, first.section.length, first.description.length, first.unit.length, first.costCodeId.length, first.costCodeName.length])
      .toEqual([128, 40, 200, 1000, 40, 128, 200])

    const sizes = stored.map(c => {
      const ref = hRef.collection('lines').doc(c.id)
      const data = { index: c.index, count: c.count, runId: c.runId, lines: c.lines }
      const bound = c.lines.reduce((t, l) => t + calc.lineBytes(l), 0)
      return { lines: c.lines.length, bound, storage: docStorageBytes(ref, data), proto: protoBytes(ref, data) }
    })
    for (const c of sizes) {
      expect(c.bound).toBeLessThanOrEqual(calc.CHUNK_MAX_BYTES)
      expect(c.storage).toBeLessThanOrEqual(c.bound + calc.CHUNK_ENVELOPE_BYTES)        // the bound holds (documented storage size)
      expect(c.proto).toBeLessThanOrEqual(c.bound + calc.CHUNK_ENVELOPE_BYTES)          // the bound holds (wire encoding)
      expect(c.storage).toBeLessThan(calc.FIRESTORE_DOCUMENT_MAX_BYTES * 0.4)
    }
    expect(stored.length).toBeGreaterThan(Math.ceil(N / calc.CHUNK_MAX_LINES))          // the BYTE bound is the binding one here
    for (const c of stored) for (const l of c.lines) expect(calc.lineBytes(l)).toBeLessThanOrEqual(calc.LINE_MAX_BYTES)
    const headerStorage = docStorageBytes(hRef, h)
    const headerProto = protoBytes(hRef, h)
    expect(headerStorage).toBeLessThan(calc.FIRESTORE_DOCUMENT_MAX_BYTES * 0.4)
    // The largest chunk transaction: CHUNKS_PER_TX consecutive chunks.
    let txProto = 0
    for (let i = 0; i < sizes.length; i += ops.CHUNKS_PER_TX) txProto = Math.max(txProto, sizes.slice(i, i + ops.CHUNKS_PER_TX).reduce((t, c) => t + c.proto, 0))
    expect(txProto).toBeLessThan(calc.FIRESTORE_REQUEST_MAX_BYTES * 0.2)

    const t1 = Date.now()
    await approve('u_pm', 'max')
    const approveMs = Date.now() - t1
    // Reconstruction from the approved revision ALONE after the live BOQ changes.
    await base().collection('boqItems').doc(ids[0]).update({ status: 'void' })
    await base().collection('boqItems').doc(ids[1]).update({ quantity: 999, amount: 123333.24, description: 'changed' })
    await base().collection('estimateItemInputs').doc(ids[2]).delete()
    const t2 = Date.now()
    const again = (await chunks('max')).sort((a, b) => a.index - b.index).flatMap(c => c.lines)
    const approved = await header('max')
    const ns = calc.normaliseEstimateSettings(Object.fromEntries(calc.ESTIMATE_SETTINGS_KEYS.map(k => [k, approved[k]])))
    expect(approved.state).toBe('approved')
    expect(calc.estimateTotals(again, ns).totals).toEqual(approved.totals)
    expect(calc.sourceKeyOfLines(again)).toBe(approved.sourceKey)
    expect(ops.contentSha256({ currency: approved.currency, settings: ns, totals: approved.totals, lines: again, sourceKey: approved.sourceKey })).toBe(approved.contentSha256)
    expect(again.find(l => l.itemId === ids[1])).toMatchObject({ quantity: 2, description: W(1000, 'D1') })
    expect(again.find(l => l.itemId === ids[2]).components).toEqual(comps)
    const reconstructMs = Date.now() - t2
    expect(approved.totals.labourCents + approved.totals.materialCents + approved.totals.plantCents + approved.totals.subcontractorCents).toBe(approved.totals.boqTotalCents)
    process.stderr.write(`[ADR-97 max-text measured] ${N} items: build ${buildMs} ms, approve ${approveMs} ms, reconstruct ${reconstructMs} ms; ${stored.length} chunks of ${Math.min(...sizes.map(c => c.lines))}–${Math.max(...sizes.map(c => c.lines))} lines; chunk bound ≤ ${Math.max(...sizes.map(c => c.bound))}, storage ${Math.min(...sizes.map(c => c.storage))}–${Math.max(...sizes.map(c => c.storage))}, proto ${Math.max(...sizes.map(c => c.proto))} bytes; header storage ${headerStorage}, proto ${headerProto} bytes; largest chunk transaction ${txProto} bytes; revision total storage ${sizes.reduce((t, c) => t + c.storage, 0)} bytes; LINE_MAX_BYTES ${calc.LINE_MAX_BYTES}\n`)
  }, 240_000)
})
