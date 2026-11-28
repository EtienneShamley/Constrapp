import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { doc, setDoc, updateDoc, getDoc, runTransaction, serverTimestamp } from 'firebase/firestore'
import {
  admin, resetEmulators, seedCompany, activateCommercial, seedUser, req, expectTeamError, clock, silentLog,
  callFunction, clientSdk, clientSignIn, clientSignOutAll, COMPANY_A, COMPANY_B,
} from './_harness.js'
import { runTransitionVariation, VariationWriteError, VARIATION_WRITE_ERROR } from '../../src/lib/variationActions'
import {
  approvedSupplierVariationsByCostCode, approvedClientVariationsTotal, pendingSupplierVariationExposureTotal,
  appliedSupplierVariationAdjustments, variationIncorporation, INCORPORATION_STATE, claimableNewScopeLines,
} from '../../src/lib/variations'

// ── The three variation callables against the Auth + Firestore (+ Functions)
// emulators (ADR-90, ADR-91)
//
// The handlers are called DIRECTLY with the real Admin SDK — real transactions
// — and, at the end, through the deployed onCall wrappers over HTTP (App
// Check, ID token). The browser's remaining writes (submit, reject, withdraw)
// run through the app's own function over the CLIENT SDK, against the real
// Security Rules the emulator loads from firebase.json.
//
// This is where the requirements that tests/rules/variations.rules.test.js
// used to prove of a client create, approve and legacy apply are now proven of
// their supported replacements:
//   · WHO may act, and that the company never comes from the request;
//   · that no derived figure, number, snapshot or stamp is taken from a
//     request: the stored document is the server's own derivation;
//   · the source checks — purchase order sent / closed, RFI eligible, cost
//     codes real — and the approve-time commitment decision (ADR-62 / ADR-63);
//   · the legacy and the exact calculation versions, each on its own documents;
//   · stale revisions, replays and concurrent requests;
//   · that the old direct paths are closed to every client.
//
// EXPECTED FIGURES are worked in the comments in whole cents, independently of
// the code under test.

const PROJECT = 'projectA'
const OTHER_PROJECT = 'projectB'
const AUDIT_TYPES = ['variation.created', 'variation.approved', 'variation.commitment_applied']
let A, handlersMod, H, now, hooks

const company = (c = COMPANY_A) => A.db.collection('companies').doc(c)
const project = (p = PROJECT, c = COMPANY_A) => company(c).collection('projects').doc(p)
const variationRef = (id, p = PROJECT) => project(p).collection('variations').doc(id)
const poRef = (id, p = PROJECT) => project(p).collection('purchaseOrders').doc(id)
const rfiRef = (id, p = PROJECT) => project(p).collection('rfis').doc(id)
const counter = (id) => company().collection('counters').doc(id)
const data = (ref) => ref.get().then(s => (s.exists ? s.data() : null))
const variation = (id) => data(variationRef(id))
const audits = async (c = COMPANY_A) => (await company(c).collection('auditEvents').get()).docs.map(d => d.data()).filter(e => AUDIT_TYPES.includes(e.type))
const cents = (n) => Math.round(n * 100)
const without = (object, ...keys) => { const copy = { ...object }; for (const k of keys) delete copy[k]; return copy }

const PO_LINES = [
  { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', qty: 10, unit: 'm3', unitPrice: 250, lineTotal: 2500 },
  { costCodeId: 'cc4', costCodeName: '04-200 — Masonry', description: 'Blockwork', qty: 1, unit: 'item', unitPrice: 900, lineTotal: 900 },
]
const purchaseOrder = (status, o = {}) => ({ poNumber: 'PO-0001', status, supplierName: 'Steel Co', supplierId: 'contactS1', lineItems: PO_LINES, subtotal: 3400, gst: 340, total: 3740, ...o })

const createRequest = (variationId, o = {}) => ({
  projectId: PROJECT, variationId, variationType: 'supplier',
  title: 'Additional steel', description: '', reason: 'design_change',
  clientId: null, clientName: null, clientRef: null,
  supplierId: 'contactS1', supplierName: 'Steel Co', supplierRef: 'Q-9', poId: null,
  originRfiId: null, identifiedDate: '2026-11-01', submittedDate: '', responseDueDate: '', effectiveDate: '', notes: '',
  lines: [{ poLineIndex: null, costCodeId: 'cc2', description: 'Extra steel', submittedAmount: 1000, taxCode: 'gst' }],
  ...o,
})
const linkedRequest = (variationId, o = {}) => createRequest(variationId, {
  poId: 'poSent', supplierId: null, supplierName: null,
  lines: [
    { poLineIndex: 0, costCodeId: null, description: 'Thicker slab', submittedAmount: 40.15, taxCode: 'gst' },
    { poLineIndex: null, costCodeId: 'cc2', description: 'New steel', submittedAmount: 250, taxCode: 'gst' },
  ],
  ...o,
})
const clientRequest = (variationId, o = {}) => createRequest(variationId, {
  variationType: 'client', clientId: 'contactC1', clientName: 'Client Pty', clientRef: 'CR-1',
  supplierId: null, supplierName: null, supplierRef: null, ...o,
})

const create = (uid, request) => H.createVariation(req(uid, request))
const updateRequest = (variationId, expectedRevision, o = {}) => ({
  projectId: PROJECT, variationId, expectedRevision,
  title: 'Additional steel', description: '', reason: 'design_change', clientRef: null, supplierRef: 'Q-9',
  identifiedDate: '2026-11-01', responseDueDate: '', effectiveDate: '', notes: null, changeOriginRfi: false, originRfiId: null,
  lines: [{ poLineIndex: null, costCodeId: 'cc2', description: 'Extra steel', submittedAmount: 1000, taxCode: 'gst' }],
  ...o,
})
const update = (uid, variationId, expectedRevision, o = {}) => H.updateVariationDraft(req(uid, updateRequest(variationId, expectedRevision, o)))
const approve = (uid, variationId, o = {}) => H.approveVariation(req(uid, { projectId: PROJECT, variationId, expectedRevision: 2, approvedAmounts: [1000], assessmentNotes: '', approvedDate: '2026-11-27', ...o }))
const apply = (uid, variationId, expectedRevision, o = {}) => H.applyVariationCommitment(req(uid, { projectId: PROJECT, variationId, expectedRevision, ...o }))

async function fresh({ enabled = true } = {}) {
  now = clock('2026-11-27T02:00:00Z')
  hooks = {}
  H = handlersMod.createVariationHandlers({ db: A.db, now, log: silentLog, config: () => ({ enabled }), hooks })
}

async function seedA() {
  await seedCompany(COMPANY_A)
  await activateCommercial(COMPANY_A)
  await seedCompany(COMPANY_B)
  await activateCommercial(COMPANY_B)
  await seedUser({ uid: 'u_admin', email: 'admin@a.test', role: 'company_admin', companyId: COMPANY_A })
  await seedUser({ uid: 'u_pm', email: 'pm@a.test', role: 'project_manager', companyId: COMPANY_A })
  await seedUser({ uid: 'u_qs', email: 'qs@a.test', role: 'qs', companyId: COMPANY_A })
  await seedUser({ uid: 'u_sub', email: 'sub@a.test', role: 'subcontractor', companyId: COMPANY_A })
  await seedUser({ uid: 'u_client', email: 'client@a.test', role: 'client', companyId: COMPANY_A })
  await seedUser({ uid: 'u_other', email: 'admin@b.test', role: 'company_admin', companyId: COMPANY_B })
  await project().set({ name: 'Project A', status: 'active' })
  await project(OTHER_PROJECT).set({ name: 'Project B', status: 'active', currency: 'NZD' })
  await project('projectZ', COMPANY_B).set({ name: 'Other tenant', status: 'active' })
  await poRef('poSent').set(purchaseOrder('sent'))
  await poRef('poClosed').set(purchaseOrder('closed', { poNumber: 'PO-0002' }))
  await poRef('poCancelled').set(purchaseOrder('cancelled', { poNumber: 'PO-0003' }))
  await poRef('poDraft').set(purchaseOrder('draft', { poNumber: 'PO-0004' }))
  await poRef('poElsewhere', OTHER_PROJECT).set(purchaseOrder('sent', { poNumber: 'PO-0009' }))
  await company().collection('costCodes').doc('cc2').set({ code: '05-100', name: 'Structural steel', status: 'active' })
  await company().collection('costCodes').doc('cc3').set({ code: '01-000', name: 'Preliminaries', status: 'active' })
  await company(COMPANY_B).collection('costCodes').doc('ccB').set({ code: '99-000', name: 'Other tenant code' })
  await rfiRef('rfiOpen').set({ rfiNumber: 'RFI-0001', title: 'Revised connection', status: 'open' })
  await rfiRef('rfiDraft').set({ rfiNumber: 'RFI-0002', title: 'Not yet asked', status: 'draft' })
  await rfiRef('rfiCancelled').set({ rfiNumber: 'RFI-0003', title: 'Withdrawn', status: 'cancelled' })
  await rfiRef('rfiElsewhere', OTHER_PROJECT).set({ rfiNumber: 'RFI-0001', title: 'Other project', status: 'open' })
}

// The browser's own writes, through the client SDK and the real Rules.
const appSdk = (uid) => ({ db: clientSdk().db, uid, runTransaction, serverTimestamp })
const clientVariationRef = (id) => doc(clientSdk().db, 'companies', COMPANY_A, 'projects', PROJECT, 'variations', id)
async function submitAs(email, uid, id) {
  await clientSignIn(email)
  const seen = { id, ...(await variation(id)) }
  await runTransitionVariation({ ...appSdk(uid), variationRef: clientVariationRef(id), seen, nextStatus: 'submitted', today: '2026-11-20' })
}
// A submitted variation, the supported way: created by the backend, submitted
// by a browser under the Rules. Revision 2 afterwards.
async function submitted(id, request = createRequest(id), by = ['qs@a.test', 'u_qs']) {
  await create(by[1], request)
  await submitAs(by[0], by[1], id)
}

// A LEGACY document, exactly as the application stored one before ADR-90 /
// ADR-91: no `calcVersion`, GST from the legacy expression (40.15 → 4.01).
function legacyVariation(o = {}) {
  return {
    variationNumber: 'SV-0901', variationType: 'supplier', status: 'submitted',
    title: 'Legacy variation', description: '', reason: '',
    clientId: null, clientName: null, clientRef: null,
    supplierId: 'contactS1', supplierName: 'Steel Co', supplierRef: '', poId: null, poNumber: null,
    originRfiId: null, originRfiNumber: null, originRfiTitle: null,
    lineItems: [
      { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Bolts', submittedAmount: 40.15, submittedGst: 4.01, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
      { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Credit', submittedAmount: -40.15, submittedGst: -4.01, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
    ],
    submittedSubtotal: 0, submittedGst: 0, submittedTotal: 0,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null, forecastAmount: null,
    identifiedDate: '2026-09-01', submittedDate: '2026-09-02', responseDueDate: '', approvedDate: '', effectiveDate: '',
    currency: 'AUD', revision: 2, notes: '', assessmentNotes: '',
    submittedAt: A.Timestamp.fromDate(new Date('2026-09-02T00:00:00Z')), submittedBy: 'u_qs',
    approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, withdrawnAt: null, withdrawnBy: null,
    attachments: [], externalRefs: {}, supersededByVariationId: null,
    createdAt: A.Timestamp.fromDate(new Date('2026-09-01T00:00:00Z')), createdBy: 'u_qs',
    updatedAt: A.Timestamp.fromDate(new Date('2026-09-02T00:00:00Z')), updatedBy: 'u_qs',
    ...o,
  }
}

beforeAll(async () => {
  A = await admin()
  handlersMod = await import('../../functions/src/variations/handlers.js')
})
beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  await fresh()
  await seedA()
})
afterAll(async () => { await clientSignOutAll() })

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2 company activation (final release batch)', () => {
  it('an INACTIVE company cannot create a variation (nothing written); the other, active company can', async () => {
    await activateCommercial(COMPANY_A, false)
    await expectTeamError(create('u_qs', createRequest('m1')), 'commercial-completion-not-activated')
    expect(await variation('m1')).toBeNull()
    await activateCommercial(COMPANY_A, true)
    expect((await create('u_qs', createRequest('m1'))).alreadyApplied).toBe(false)
  })
})

describe('createVariation — who may create, and for which company', () => {
  it('company_admin, project_manager and qs each create a manual-mode supplier, a PO-linked and a client variation; each is read back by every financial role through the Rules', async () => {
    const made = []
    for (const [uid, n] of [['u_admin', 1], ['u_pm', 2], ['u_qs', 3]]) {
      expect(await create(uid, createRequest(`m${n}`))).toMatchObject({ variationId: `m${n}`, alreadyApplied: false })
      expect((await create(uid, linkedRequest(`l${n}`))).alreadyApplied).toBe(false)
      expect((await create(uid, clientRequest(`c${n}`))).variationNumber).toBe(`CV-000${n}`)
      made.push(`m${n}`, `l${n}`, `c${n}`)
    }
    // Two supplier variations per user, one client: the counters are per type.
    expect((await variation('m1')).variationNumber).toBe('SV-0001')
    expect((await variation('l3')).variationNumber).toBe('SV-0006')
    expect((await data(counter('variationsSupplier'))).next).toBe(7)
    expect((await data(counter('variationsClient'))).next).toBe(4)
    expect((await audits()).filter(e => e.type === 'variation.created').map(e => e.actorUid).sort()).toEqual(['u_admin', 'u_admin', 'u_admin', 'u_pm', 'u_pm', 'u_pm', 'u_qs', 'u_qs', 'u_qs'])
    await clientSignIn('pm@a.test')
    for (const id of made) expect((await getDoc(clientVariationRef(id))).exists()).toBe(true)
  })

  it('a subcontractor, a client, a deactivated member, an unknown account and an anonymous caller are refused with NOTHING written', async () => {
    await expectTeamError(create('u_sub', createRequest('x')), A.CODE.VARIATION_FORBIDDEN)
    await expectTeamError(create('u_client', createRequest('x')), A.CODE.VARIATION_FORBIDDEN)
    await expectTeamError(create('u_ghost', createRequest('x')), A.CODE.NO_MEMBERSHIP)
    await expectTeamError(create(null, createRequest('x')), A.CODE.UNAUTHENTICATED)
    await A.db.collection('users').doc('u_qs').update({ status: 'deactivated', companyId: null, role: null })
    await expectTeamError(create('u_qs', createRequest('x')), A.CODE.MEMBERSHIP_INACTIVE)
    expect(await variation('x')).toBeNull()
    expect(await data(counter('variationsSupplier'))).toBeNull()
    expect(await audits()).toEqual([])
  })

  it('TENANT ISOLATION — the company comes from the caller’s membership: another tenant’s project, purchase order, RFI and cost code are simply not found', async () => {
    // Company B's admin names Company A's project.
    await expectTeamError(create('u_other', createRequest('x')), A.CODE.NOT_FOUND)
    // Company A's member names Company B's project.
    await expectTeamError(create('u_admin', createRequest('x', { projectId: 'projectZ' })), A.CODE.NOT_FOUND)
    // …and Company B's cost code, on Company A's own project.
    await expectTeamError(create('u_admin', createRequest('x', { lines: [{ poLineIndex: null, costCodeId: 'ccB', description: '', submittedAmount: 1, taxCode: 'gst' }] })), A.CODE.VARIATION_COST_CODE_INVALID)
    // A companyId in the request is an unexpected key.
    await expectTeamError(create('u_other', { ...createRequest('x'), companyId: COMPANY_A }), A.CODE.INVALID_ARGUMENT)
    expect(await variation('x')).toBeNull()
    expect((await variationRef('x', OTHER_PROJECT).get()).exists).toBe(false)
    expect(await audits(COMPANY_B)).toEqual([])
    await expectTeamError(create('u_admin', createRequest('x', { projectId: 'noSuchProject' })), A.CODE.NOT_FOUND)
  })

  it('the switch: with it off every operation is refused before any read, and nothing is written', async () => {
    await fresh({ enabled: false })
    await expectTeamError(create('u_admin', createRequest('x')), A.CODE.VARIATION_DISABLED)
    await expectTeamError(update('u_admin', 'x', 1), A.CODE.VARIATION_DISABLED)
    await expectTeamError(approve('u_admin', 'x'), A.CODE.VARIATION_DISABLED)
    await expectTeamError(apply('u_admin', 'x', 3), A.CODE.VARIATION_DISABLED)
    expect(await variation('x')).toBeNull()
    expect(await audits()).toEqual([])
  })
})

describe('createVariation — the stored document is the SERVER’S derivation', () => {
  it('the exact document: number, currency, calculation version 2, exact GST, server stamps — and no commitment key', async () => {
    // 1,000.00 GST → 100.00;  40.15 GST → 4.02 (half up; legacy gave 4.01);
    // -40.15 GST → -4.02 (half away from zero);  500.00 GST-free → 0.
    // subtotal 1,500.00 · GST 100.00 · total 1,600.00
    await create('u_qs', createRequest('v1', {
      originRfiId: 'rfiOpen', effectiveDate: '2026-12-01', notes: 'note',
      lines: [
        { poLineIndex: null, costCodeId: 'cc2', description: 'Extra steel', submittedAmount: 1000, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc2', description: 'Bolts', submittedAmount: 40.15, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc2', description: 'Credit', submittedAmount: -40.15, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc3', description: 'Permit', submittedAmount: 500, taxCode: 'gst_free' },
      ],
    }))
    const v = await variation('v1')
    const { createdAt, updatedAt, ...rest } = v
    expect(createdAt).toBeInstanceOf(A.Timestamp)
    expect(updatedAt.isEqual(createdAt)).toBe(true)
    expect(rest).toEqual({
      variationNumber: 'SV-0001', variationType: 'supplier', status: 'draft',
      title: 'Additional steel', description: '', reason: 'design_change',
      clientId: null, clientName: null, clientRef: null,
      supplierId: 'contactS1', supplierName: 'Steel Co', supplierRef: 'Q-9', poId: null, poNumber: null,
      originRfiId: 'rfiOpen', originRfiNumber: 'RFI-0001', originRfiTitle: 'Revised connection',
      lineItems: [
        { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Extra steel', submittedAmount: 1000, submittedGst: 100, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
        { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Bolts', submittedAmount: 40.15, submittedGst: 4.02, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
        { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Credit', submittedAmount: -40.15, submittedGst: -4.02, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
        { costCodeId: 'cc3', costCodeName: '01-000 — Preliminaries', description: 'Permit', submittedAmount: 500, submittedGst: 0, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst_free' },
      ],
      submittedSubtotal: 1500, submittedGst: 100, submittedTotal: 1600,
      approvedSubtotal: null, approvedGst: null, approvedTotal: null, forecastAmount: null,
      identifiedDate: '2026-11-01', submittedDate: '', responseDueDate: '', approvedDate: '', effectiveDate: '2026-12-01',
      currency: 'AUD', calcVersion: 2, revision: 1, notes: 'note', assessmentNotes: '',
      submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, withdrawnAt: null, withdrawnBy: null,
      attachments: [], externalRefs: {}, supersededByVariationId: null,
      createdBy: 'u_qs', updatedBy: 'u_qs',
      // ADR-96: the backend records the draft's editor provenance (approval segregation, D4).
      draftEditors: ['u_qs'], lastMaterialEditBy: 'u_qs',
    })
    // The link wrote nothing onto the RFI.
    expect(await data(rfiRef('rfiOpen'))).toEqual({ rfiNumber: 'RFI-0001', title: 'Revised connection', status: 'open' })
  })

  it('currency resolves as lib/currency.js: the project’s explicit code, else the company base currency — and the project currency lock is engaged in the same commit', async () => {
    await create('u_qs', createRequest('a1'))
    expect((await variation('a1')).currency).toBe('AUD')                          // company base currency
    expect((await data(project())).currencyLocked).toBe(true)
    await create('u_qs', createRequest('b1', { projectId: OTHER_PROJECT }))
    expect((await data(variationRef('b1', OTHER_PROJECT))).currency).toBe('NZD')  // the project's own
    expect((await data(project(OTHER_PROJECT))).currencyLocked).toBe(true)
    // An already-locked project is not rewritten.
    const before = (await project().get()).updateTime
    await create('u_qs', createRequest('a2'))
    expect((await project().get()).updateTime.isEqual(before)).toBe(true)
  })

  it('PO-linked: the supplier, the PO number and each PO line’s cost code are the PURCHASE ORDER’S — a sent and a closed order are accepted', async () => {
    await create('u_pm', linkedRequest('v1'))
    expect(await variation('v1')).toMatchObject({ poId: 'poSent', poNumber: 'PO-0001', supplierName: 'Steel Co', supplierId: 'contactS1', supplierRef: 'Q-9' })
    expect((await variation('v1')).lineItems.map(l => [l.poLineIndex, l.costCodeId, l.costCodeName, l.submittedAmount, l.submittedGst])).toEqual([
      [0, 'cc1', '03-100 — Concrete', 40.15, 4.02],
      [null, 'cc2', '05-100 — Structural steel', 250, 25],
    ])
    await create('u_pm', linkedRequest('v2', { poId: 'poClosed' }))
    expect((await variation('v2')).poNumber).toBe('PO-0002')
    // A pre-Contacts purchase order (no supplierId key) stores null.
    await poRef('poOld').set({ poNumber: 'PO-0005', status: 'sent', supplierName: 'Old Supplier', lineItems: PO_LINES })
    await create('u_pm', linkedRequest('v3', { poId: 'poOld' }))
    expect(await variation('v3')).toMatchObject({ supplierId: null, supplierName: 'Old Supplier' })
  })

  it('a draft, cancelled or missing purchase order, and one from another project, refuse the create — nothing written, the number not consumed', async () => {
    for (const poId of ['poDraft', 'poCancelled', 'noSuchPo', 'poElsewhere']) {
      await expectTeamError(create('u_pm', linkedRequest('x', { poId })), A.CODE.VARIATION_PO_INVALID)
    }
    expect(await variation('x')).toBeNull()
    expect(await data(counter('variationsSupplier'))).toBeNull()
    expect(await audits()).toEqual([])
    expect((await data(project())).currencyLocked).toBeUndefined()
  })

  it('a PO line index that names no line, an unknown cost code, and a draft, cancelled, missing or other-project RFI refuse the create', async () => {
    const line = { poLineIndex: 2, costCodeId: null, description: '', submittedAmount: 1, taxCode: 'gst' }
    await expectTeamError(create('u_pm', linkedRequest('x', { lines: [line] })), A.CODE.VARIATION_COST_CODE_INVALID)
    await expectTeamError(create('u_pm', createRequest('x', { lines: [{ poLineIndex: null, costCodeId: 'ghost', description: '', submittedAmount: 1, taxCode: 'gst' }] })), A.CODE.VARIATION_COST_CODE_INVALID)
    for (const originRfiId of ['rfiDraft', 'rfiCancelled', 'noSuchRfi', 'rfiElsewhere']) {
      await expectTeamError(create('u_pm', createRequest('x', { originRfiId })), A.CODE.VARIATION_RFI_INVALID)
    }
    expect(await variation('x')).toBeNull()
    expect(await audits()).toEqual([])
  })

  it('a request that carries a figure, a number, a stamp or a status is refused whole — a forged total can never be stored', async () => {
    for (const forged of [{ submittedGst: 0 }, { submittedTotal: 1 }, { variationNumber: 'SV-9999' }, { status: 'approved' }, { calcVersion: 1 }, { createdBy: 'u_admin' }, { currency: 'USD' }, { commitmentAppliedAt: 'x' }]) {
      await expectTeamError(create('u_qs', { ...createRequest('x'), ...forged }), A.CODE.INVALID_ARGUMENT)
    }
    await expectTeamError(create('u_qs', createRequest('x', { lines: [{ ...createRequest('x').lines[0], submittedGst: 0 }] })), A.CODE.INVALID_ARGUMENT)
    expect(await variation('x')).toBeNull()
  })

  it('a counter that is not a positive whole number is never guessed around', async () => {
    await counter('variationsSupplier').set({ next: 'seven' })
    await expectTeamError(create('u_qs', createRequest('x')), A.CODE.VARIATION_UNSUPPORTED_RECORD)
    for (const next of [0, -5, 1.5, null, 1_000_000_000, Number.MAX_SAFE_INTEGER]) {
      await counter('variationsSupplier').set({ next })
      await expectTeamError(create('u_qs', createRequest('x')), A.CODE.VARIATION_UNSUPPORTED_RECORD)
    }
    expect(await variation('x')).toBeNull()
    // A tampered counter of one register never touches the other.
    expect((await create('u_qs', clientRequest('cx'))).variationNumber).toBe('CV-0001')
    await counter('variationsSupplier').set({ next: 41 })
    expect((await create('u_qs', createRequest('y'))).variationNumber).toBe('SV-0041')
    expect((await data(counter('variationsSupplier'))).next).toBe(42)
  })

  it('200 lines are stored; SIGNED, zero-value and mixed-tax variations are not clamped', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ poLineIndex: null, costCodeId: i % 2 ? 'cc2' : 'cc3', description: `L${i}`, submittedAmount: i % 3 === 0 ? -0.05 : 0.05, taxCode: 'gst' }))
    await create('u_qs', createRequest('big', { lines }))
    const v = await variation('big')
    expect(v.lineItems).toHaveLength(200)
    // 67 lines of -0.05 (GST -0.01 each) and 133 of 0.05 (GST 0.01 each): subtotal 3.30, GST 0.66.
    expect([cents(v.submittedSubtotal), cents(v.submittedGst), cents(v.submittedTotal)]).toEqual([330, 66, 396])
    await create('u_qs', createRequest('credit', { lines: [{ poLineIndex: null, costCodeId: 'cc2', description: 'Omission', submittedAmount: -5000, taxCode: 'gst' }] }))
    expect(await variation('credit')).toMatchObject({ submittedSubtotal: -5000, submittedGst: -500, submittedTotal: -5500 })
    await create('u_qs', createRequest('zero', { lines: [{ poLineIndex: null, costCodeId: 'cc2', description: 'Nil', submittedAmount: 0, taxCode: 'gst' }] }))
    expect(await variation('zero')).toMatchObject({ submittedSubtotal: 0, submittedGst: 0, submittedTotal: 0 })
  })
})

describe('createVariation — replays and concurrency', () => {
  it('a repeat with the SAME id by the same user is answered already-created: one document, one number, one audit event', async () => {
    const first = await create('u_qs', createRequest('v1'))
    const again = await create('u_qs', createRequest('v1'))
    expect(first).toMatchObject({ variationNumber: 'SV-0001', alreadyApplied: false })
    expect(again).toMatchObject({ variationNumber: 'SV-0001', alreadyApplied: true })
    // Even with different content: the id is the request's identity, and the stored document stands.
    const third = await create('u_qs', createRequest('v1', { title: 'Something else' }))
    expect(third.alreadyApplied).toBe(true)
    expect((await variation('v1')).title).toBe('Additional steel')
    expect((await data(counter('variationsSupplier'))).next).toBe(2)
    expect(await audits()).toHaveLength(1)
  })

  it('an id another user’s variation already holds is refused — never overwritten, never adopted', async () => {
    await create('u_qs', createRequest('v1'))
    await expectTeamError(create('u_pm', createRequest('v1', { title: 'Mine' })), A.CODE.VARIATION_ID_CONFLICT)
    expect(await variation('v1')).toMatchObject({ createdBy: 'u_qs', title: 'Additional steel' })
    expect(await audits()).toHaveLength(1)
  })

  it('SIX concurrent creates: six documents, six DISTINCT consecutive numbers, the counter advanced exactly six times', async () => {
    const users = ['u_admin', 'u_pm', 'u_qs', 'u_admin', 'u_pm', 'u_qs']
    const results = await Promise.allSettled(users.map((uid, i) => create(uid, createRequest(`c${i}`))))
    const done = results.filter(r => r.status === 'fulfilled').map(r => r.value.variationNumber)
    // A request that lost every attempt to contention is a typed "busy" — nothing written for it.
    for (const r of results.filter(x => x.status === 'rejected')) expect(r.reason?.details?.code).toBe(A.CODE.VARIATION_BUSY)
    expect(new Set(done).size).toBe(done.length)
    const stored = (await project().collection('variations').get()).docs.map(d => d.data().variationNumber).sort()
    expect(stored).toEqual(done.slice().sort())
    expect(stored).toEqual(Array.from({ length: done.length }, (_, i) => `SV-000${i + 1}`))
    expect((await data(counter('variationsSupplier'))).next).toBe(done.length + 1)
    expect(await audits()).toHaveLength(done.length)
    expect(done.length).toBe(6)
  })

  it('the same request sent TWICE at once creates one variation', async () => {
    const results = await Promise.allSettled([create('u_qs', createRequest('v1')), create('u_qs', createRequest('v1'))])
    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value)
    expect(ok.length).toBeGreaterThanOrEqual(1)
    expect(ok.filter(r => r.alreadyApplied === false)).toHaveLength(1)
    expect((await project().collection('variations').get()).size).toBe(1)
    expect((await data(counter('variationsSupplier'))).next).toBe(2)
    expect(await audits()).toHaveLength(1)
  })

  it('forced contention is retried and lands once; contention on every attempt is a typed "busy" with nothing written; any other failure stays untyped', async () => {
    hooks.afterRead = async ({ attempt }) => { if (attempt === 1) throw Object.assign(new Error('forced contention'), { code: 10 }) }
    expect((await create('u_qs', createRequest('v1'))).attempts).toBe(2)
    expect(await audits()).toHaveLength(1)
    hooks.afterRead = async () => { throw Object.assign(new Error('contention'), { code: 10 }) }
    await expectTeamError(create('u_qs', createRequest('v2')), A.CODE.VARIATION_BUSY)
    expect(await variation('v2')).toBeNull()
    hooks.afterRead = async () => { throw Object.assign(new Error('deadline exceeded'), { code: 4 }) }
    const outcome = await create('u_qs', createRequest('v3')).then(() => null, e => e)
    expect(outcome?.details?.code).toBeUndefined()   // uncertain outcomes are never reported as a refusal
    expect(await variation('v3')).toBeNull()
  })
})

describe('the browser’s remaining writes work on a backend-created variation, under the real Rules', () => {
  it('a draft edited through the backend is re-derived exactly, then submitted by the browser under the Rules, and approved', async () => {
    await create('u_qs', createRequest('v1'))
    await update('u_qs', 'v1', 1, { title: 'Additional steel (revised)', supplierRef: 'Q-10', lines: [{ poLineIndex: null, costCodeId: 'cc2', description: 'Bolts', submittedAmount: 40.15, taxCode: 'gst' }] })
    const edited = await variation('v1')
    expect(edited).toMatchObject({ title: 'Additional steel (revised)', supplierRef: 'Q-10', calcVersion: 2, revision: 2, submittedSubtotal: 40.15, submittedGst: 4.02, submittedTotal: 44.17 })
    await clientSignIn('qs@a.test')
    await runTransitionVariation({ ...appSdk('u_qs'), variationRef: clientVariationRef('v1'), seen: { id: 'v1', ...edited }, nextStatus: 'submitted', today: '2026-11-20' })
    expect(await variation('v1')).toMatchObject({ status: 'submitted', submittedBy: 'u_qs', submittedDate: '2026-11-20', revision: 3 })
    expect(await approve('u_pm', 'v1', { expectedRevision: 3, approvedAmounts: [40.15] })).toMatchObject({ alreadyApplied: false, commitmentApplied: false })
    expect(await variation('v1')).toMatchObject({ status: 'approved', approvedSubtotal: 40.15, approvedGst: 4.02, approvedTotal: 44.17, revision: 4 })
  })

  it('reject and withdraw of a backend-created variation stay browser transitions; the app refuses to approve through a transaction', async () => {
    await submitted('v1')
    await clientSignIn('pm@a.test')
    await runTransitionVariation({ ...appSdk('u_pm'), variationRef: clientVariationRef('v1'), seen: { id: 'v1', ...(await variation('v1')) }, nextStatus: 'rejected', extras: { assessmentNotes: 'Not agreed' } })
    expect(await variation('v1')).toMatchObject({ status: 'rejected', rejectedBy: 'u_pm', assessmentNotes: 'Not agreed', calcVersion: 2 })
    await create('u_qs', createRequest('v2'))
    await clientSignIn('qs@a.test')
    await runTransitionVariation({ ...appSdk('u_qs'), variationRef: clientVariationRef('v2'), seen: { id: 'v2', ...(await variation('v2')) }, nextStatus: 'withdrawn' })
    expect((await variation('v2')).status).toBe('withdrawn')
    await submitted('v3')
    const err = await runTransitionVariation({ ...appSdk('u_qs'), variationRef: clientVariationRef('v3'), seen: { id: 'v3', ...(await variation('v3')) }, nextStatus: 'approved', extras: { approvedAmounts: [1000] } }).then(() => null, e => e)
    expect(err).toBeInstanceOf(VariationWriteError)
    expect(err.kind).toBe(VARIATION_WRITE_ERROR.INVALID)
    expect((await variation('v3')).status).toBe('submitted')
  })

  it('THE OLD DIRECT PATHS ARE CLOSED — every financial role is refused by the Rules: create, approve, the commitment stamps, and any change to calcVersion', async () => {
    await submitted('v1', linkedRequest('v1'))
    const stored = await variation('v1')
    for (const [email, uid] of [['admin@a.test', 'u_admin'], ['pm@a.test', 'u_pm'], ['qs@a.test', 'u_qs']]) {
      await clientSignIn(email)
      const denied = async (promise) => expect((await promise.then(() => null, e => e))?.code).toBe('permission-denied')
      // A create with the exact document the old bundle wrote.
      const oldShape = without(stored, 'calcVersion')
      await denied(setDoc(clientVariationRef(`direct_${uid}`), { ...oldShape, status: 'draft', revision: 1, submittedAt: null, submittedBy: null, submittedDate: '', createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid }))
      // The old approve payload, with and without the stamp pairs.
      const approvePayload = {
        status: 'approved', lineItems: stored.lineItems.map(l => ({ ...l, approvedAmount: l.submittedAmount, approvedGst: l.submittedGst })),
        approvedSubtotal: stored.submittedSubtotal, approvedGst: stored.submittedGst, approvedTotal: stored.submittedTotal,
        assessmentNotes: '', approvedDate: '2026-11-27', effectiveDate: '2026-11-27',
        approvedAt: serverTimestamp(), approvedBy: uid, revision: stored.revision + 1, updatedAt: serverTimestamp(), updatedBy: uid,
      }
      await denied(updateDoc(clientVariationRef('v1'), approvePayload))
      await denied(updateDoc(clientVariationRef('v1'), { ...approvePayload, commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: uid, scopeCommittedAt: serverTimestamp(), scopeCommittedBy: uid }))
      // A draft CONTENT edit — the write the old bundle made — on the submitted
      // document and, below, on a draft.
      await denied(updateDoc(clientVariationRef('v1'), { title: 'Edited directly', revision: stored.revision + 1, updatedAt: serverTimestamp(), updatedBy: uid }))
      // The stamps and the calculation version, alone.
      await denied(updateDoc(clientVariationRef('v1'), { commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: uid, scopeCommittedAt: serverTimestamp(), scopeCommittedBy: uid, revision: stored.revision + 1, updatedAt: serverTimestamp(), updatedBy: uid }))
      await denied(updateDoc(clientVariationRef('v1'), { calcVersion: 1, revision: stored.revision + 1, updatedAt: serverTimestamp(), updatedBy: uid }))
    }
    expect(await variation('v1')).toEqual(stored)
    expect((await project().collection('variations').get()).size).toBe(1)
  })

  it('A DRAFT ADMITS NO CLIENT CONTENT WRITE — title, lines, header, references, dates, notes and the RFI link are each refused by the Rules for every financial role; the three counters of the variation register are unreadable and unwritable', async () => {
    await create('u_qs', createRequest('d1'))
    const stored = await variation('d1')
    const counterDoc = (id) => doc(clientSdk().db, 'companies', COMPANY_A, 'counters', id)
    for (const [email, uid] of [['admin@a.test', 'u_admin'], ['pm@a.test', 'u_pm'], ['qs@a.test', 'u_qs']]) {
      await clientSignIn(email)
      const stamps = { revision: 2, updatedAt: serverTimestamp(), updatedBy: uid }
      const forgeries = [
        { title: 'Forged title' },
        { lineItems: [{ ...stored.lineItems[0], submittedAmount: 999999, submittedGst: 0 }] },
        { lineItems: [{ ...stored.lineItems[0], costCodeId: 'ghost' }] },
        { submittedSubtotal: 5000, submittedGst: 500, submittedTotal: 5500 },
        { supplierRef: 'X' }, { identifiedDate: '2026-01-01' }, { notes: 'x' }, { description: 'x' }, { reason: 'other' },
        { originRfiId: 'rfiOpen', originRfiNumber: 'RFI-0001', originRfiTitle: 'Revised connection' },
      ]
      for (const forged of forgeries) {
        const err = await updateDoc(clientVariationRef('d1'), { ...forged, ...stamps }).then(() => null, e => e)
        expect(err?.code, `${uid} ${Object.keys(forged)}`).toBe('permission-denied')
      }
      for (const id of ['variationsSupplier', 'variationsClient']) {
        expect((await getDoc(counterDoc(id)).then(() => null, e => e))?.code, `${uid} read ${id}`).toBe('permission-denied')
        for (const next of [1, 2, 999999, 'x']) {
          expect((await setDoc(counterDoc(id), { next }, { merge: true }).then(() => null, e => e))?.code, `${uid} write ${id} ${next}`).toBe('permission-denied')
        }
      }
    }
    expect(await variation('d1')).toEqual(stored)
    expect(await data(counter('variationsSupplier'))).toEqual({ next: 2 })
    expect(await data(counter('variationsClient'))).toBeNull()
  })

  it('a version-2 DRAFT cannot have its calculation version changed, removed or its commitment keys set by a draft edit', async () => {
    await create('u_qs', createRequest('v1'))
    await clientSignIn('qs@a.test')
    const stamps = { revision: 2, updatedAt: serverTimestamp(), updatedBy: 'u_qs' }
    for (const forged of [{ calcVersion: 1 }, { calcVersion: null }, { commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: 'u_qs' }, { scopeCommittedAt: serverTimestamp(), scopeCommittedBy: 'u_qs' }, { variationNumber: 'SV-9999' }, { currency: 'USD' }, { createdBy: 'u_pm' }]) {
      const err = await updateDoc(clientVariationRef('v1'), { title: 'Edited', ...forged, ...stamps }).then(() => null, e => e)
      expect(err?.code, JSON.stringify(Object.keys(forged))).toBe('permission-denied')
    }
    expect((await variation('v1')).calcVersion).toBe(2)
    expect((await variation('v1')).title).toBe('Additional steel')
  })
})

describe('updateVariationDraft — a draft is edited only by the backend', () => {
  it('every financial role edits a draft; the stored document is the server’s derivation and nothing but the editable content moves', async () => {
    await create('u_qs', createRequest('v1', { originRfiId: 'rfiOpen', notes: 'original note' }))
    const before = await variation('v1')
    let revision = 1
    for (const uid of ['u_admin', 'u_pm', 'u_qs']) {
      const out = await update(uid, 'v1', revision, { title: `Edited by ${uid}` })
      expect(out).toMatchObject({ variationId: 'v1', alreadyApplied: false, calcVersion: 2 })
      revision += 1
      expect(await variation('v1')).toMatchObject({ title: `Edited by ${uid}`, updatedBy: uid, revision })
    }
    // 250.55 GST 25.06 (250.555 → half up); -40.15 GST -4.02; 12.00 GST-free → 222.40 · 21.04 · 243.44
    await update('u_qs', 'v1', revision, {
      title: 'Final', description: 'desc', reason: 'site_condition', supplierRef: 'Q-22',
      identifiedDate: '2026-11-05', responseDueDate: '2026-12-01', effectiveDate: '2026-12-15',
      lines: [
        { poLineIndex: null, costCodeId: 'cc2', description: 'Steel', submittedAmount: 250.55, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc2', description: 'Credit', submittedAmount: -40.15, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc3', description: 'Permit', submittedAmount: 12, taxCode: 'gst_free' },
      ],
    })
    const after = await variation('v1')
    expect(after).toMatchObject({
      title: 'Final', description: 'desc', reason: 'site_condition', supplierRef: 'Q-22', clientRef: null,
      identifiedDate: '2026-11-05', responseDueDate: '2026-12-01', effectiveDate: '2026-12-15',
      submittedSubtotal: 222.4, submittedGst: 21.04, submittedTotal: 243.44, calcVersion: 2, revision: 5, updatedBy: 'u_qs',
      // Not in the request → kept exactly.
      notes: 'original note', originRfiId: 'rfiOpen', originRfiNumber: 'RFI-0001', originRfiTitle: 'Revised connection',
    })
    expect(after.lineItems.map(l => [l.costCodeId, l.costCodeName, l.submittedAmount, l.submittedGst, l.approvedAmount, l.taxCode])).toEqual([
      ['cc2', '05-100 — Structural steel', 250.55, 25.06, null, 'gst'],
      ['cc2', '05-100 — Structural steel', -40.15, -4.02, null, 'gst'],
      ['cc3', '01-000 — Preliminaries', 12, 0, null, 'gst_free'],
    ])
    for (const k of ['variationNumber', 'variationType', 'status', 'supplierId', 'supplierName', 'poId', 'poNumber', 'currency', 'createdBy', 'submittedAt', 'approvedAt', 'approvedSubtotal', 'submittedDate']) {
      expect(after[k], k).toEqual(before[k])
    }
    expect(after.createdAt.isEqual(before.createdAt)).toBe(true)
    expect(after.updatedAt.valueOf() > before.updatedAt.valueOf()).toBe(true)
    // A draft edit creates no financial fact: no audit event beyond the create.
    expect((await audits()).map(e => e.type)).toEqual(['variation.created'])
  })

  it('a request carrying a derived figure, an identity field, a status or a stamp is refused whole', async () => {
    await create('u_qs', createRequest('v1'))
    for (const forged of [{ submittedGst: 0 }, { submittedTotal: 1 }, { status: 'approved' }, { calcVersion: 1 }, { variationNumber: 'SV-9999' }, { poId: 'poSent' }, { supplierName: 'Forged' }, { variationType: 'client' }, { revision: 9 }, { commitmentAppliedAt: 'x' }]) {
      await expectTeamError(H.updateVariationDraft(req('u_qs', { ...updateRequest('v1', 1), ...forged })), A.CODE.INVALID_ARGUMENT)
    }
    await expectTeamError(update('u_qs', 'v1', 1, { lines: [{ poLineIndex: null, costCodeId: 'cc2', description: '', submittedAmount: 1, taxCode: 'gst', submittedGst: 0 }] }), A.CODE.INVALID_ARGUMENT)
    expect((await variation('v1')).revision).toBe(1)
  })

  it('who may edit: a subcontractor, a client, another tenant, a deactivated member and an anonymous caller may not; a missing variation is not found', async () => {
    await create('u_qs', createRequest('v1'))
    await expectTeamError(update('u_sub', 'v1', 1), A.CODE.VARIATION_FORBIDDEN)
    await expectTeamError(update('u_client', 'v1', 1), A.CODE.VARIATION_FORBIDDEN)
    await expectTeamError(update('u_other', 'v1', 1), A.CODE.NOT_FOUND)
    await expectTeamError(update(null, 'v1', 1), A.CODE.UNAUTHENTICATED)
    await expectTeamError(update('u_pm', 'gone', 1), A.CODE.NOT_FOUND)
    await A.db.collection('users').doc('u_pm').update({ status: 'deactivated', companyId: null, role: null })
    await expectTeamError(update('u_pm', 'v1', 1), A.CODE.MEMBERSHIP_INACTIVE)
    expect((await variation('v1')).revision).toBe(1)
  })

  it('ONLY A DRAFT is editable — submitted, approved, rejected and withdrawn variations admit no edit by anyone', async () => {
    await submitted('sub1')
    await expectTeamError(update('u_admin', 'sub1', 2), A.CODE.VARIATION_NOT_DRAFT)
    await approve('u_pm', 'sub1')
    const approved = await variation('sub1')
    await expectTeamError(update('u_admin', 'sub1', 3), A.CODE.VARIATION_NOT_DRAFT)
    expect(await variation('sub1')).toEqual(approved)
    for (const status of ['rejected', 'withdrawn', 'under_review', 'disputed', 'superseded']) {
      await variationRef(`s_${status}`).set(legacyVariation({ status }))
      await expectTeamError(update('u_admin', `s_${status}`, 2), A.CODE.VARIATION_NOT_DRAFT)
    }
  })

  it('a STALE editor is refused — an edit lands only on the revision that was opened; the other editor’s save stands', async () => {
    await create('u_qs', createRequest('v1'))
    await update('u_pm', 'v1', 1, { title: 'PM got there first' })
    await expectTeamError(update('u_qs', 'v1', 1, { title: 'QS stale copy' }), A.CODE.VARIATION_STALE)
    await expectTeamError(update('u_qs', 'v1', 5, { title: 'From the future' }), A.CODE.VARIATION_STALE)
    expect(await variation('v1')).toMatchObject({ title: 'PM got there first', revision: 2, updatedBy: 'u_pm' })
    expect((await update('u_qs', 'v1', 2, { title: 'QS fresh copy' })).alreadyApplied).toBe(false)
  })

  it('a REPEAT of an edit already saved is answered already-saved with nothing written; TWO editors at once: exactly one edit lands', async () => {
    await create('u_qs', createRequest('v1'))
    await update('u_qs', 'v1', 1, { title: 'Saved once' })
    const stored = await variationRef('v1').get()
    expect(await update('u_qs', 'v1', 1, { title: 'Saved once' })).toMatchObject({ alreadyApplied: true })
    expect((await variationRef('v1').get()).updateTime.isEqual(stored.updateTime)).toBe(true)
    // The same content from somebody else, or different content from the same user, is stale — not a repeat.
    await expectTeamError(update('u_pm', 'v1', 1, { title: 'Saved once' }), A.CODE.VARIATION_STALE)
    await expectTeamError(update('u_qs', 'v1', 1, { title: 'Something else' }), A.CODE.VARIATION_STALE)
    const results = await Promise.allSettled([update('u_pm', 'v1', 2, { title: 'PM edit' }), update('u_admin', 'v1', 2, { title: 'Admin edit' })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const lost = results.find(r => r.status === 'rejected')
    expect([A.CODE.VARIATION_STALE, A.CODE.VARIATION_BUSY]).toContain(lost.reason?.details?.code)
    const v = await variation('v1')
    expect(v.revision).toBe(3)
    expect([['u_pm', 'PM edit'], ['u_admin', 'Admin edit']]).toContainEqual([v.updatedBy, v.title])
  })

  it('an edit racing the browser’s SUBMIT: one of the two lands, and a submitted variation never carries the losing edit', async () => {
    await create('u_qs', createRequest('v1'))
    await clientSignIn('qs@a.test')
    const seen = { id: 'v1', ...(await variation('v1')) }
    const results = await Promise.allSettled([
      update('u_pm', 'v1', 1, { title: 'Edited while being submitted' }),
      runTransitionVariation({ ...appSdk('u_qs'), variationRef: clientVariationRef('v1'), seen, nextStatus: 'submitted', today: '2026-11-20' }),
    ])
    const v = await variation('v1')
    expect(v.revision).toBe(2)
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    if (v.status === 'submitted') expect(v.title).toBe('Additional steel')
    else expect(v).toMatchObject({ status: 'draft', title: 'Edited while being submitted' })
  })

  it('the originating RFI: untouched unless asked; set, changed and removed through the server; an ineligible RFI is refused; a link to a since-CANCELLED RFI survives unrelated edits', async () => {
    await rfiRef('rfiTwo').set({ rfiNumber: 'RFI-0007', title: 'Second question', status: 'closed' })
    await create('u_qs', createRequest('v1'))
    await update('u_qs', 'v1', 1, { changeOriginRfi: true, originRfiId: 'rfiOpen' })
    expect(await variation('v1')).toMatchObject({ originRfiId: 'rfiOpen', originRfiNumber: 'RFI-0001', originRfiTitle: 'Revised connection' })
    await update('u_qs', 'v1', 2, { changeOriginRfi: true, originRfiId: 'rfiTwo' })
    expect(await variation('v1')).toMatchObject({ originRfiId: 'rfiTwo', originRfiNumber: 'RFI-0007', originRfiTitle: 'Second question' })
    for (const originRfiId of ['rfiDraft', 'rfiCancelled', 'noSuchRfi', 'rfiElsewhere']) {
      await expectTeamError(update('u_qs', 'v1', 3, { changeOriginRfi: true, originRfiId }), A.CODE.VARIATION_RFI_INVALID)
    }
    // The RFI is cancelled afterwards: the stored link is history and stays.
    await rfiRef('rfiTwo').update({ status: 'cancelled' })
    await update('u_qs', 'v1', 3, { title: 'Unrelated edit' })
    expect(await variation('v1')).toMatchObject({ title: 'Unrelated edit', originRfiId: 'rfiTwo', originRfiNumber: 'RFI-0007' })
    // …but it cannot be CHOSEN again once removed.
    await update('u_qs', 'v1', 4, { changeOriginRfi: true, originRfiId: null })
    expect(await variation('v1')).toMatchObject({ originRfiId: null, originRfiNumber: null, originRfiTitle: null })
    await expectTeamError(update('u_qs', 'v1', 5, { changeOriginRfi: true, originRfiId: 'rfiTwo' }), A.CODE.VARIATION_RFI_INVALID)
    // Nothing was ever written onto an RFI.
    expect(await data(rfiRef('rfiOpen'))).toEqual({ rfiNumber: 'RFI-0001', title: 'Revised connection', status: 'open' })
  })

  it('lines: a PO line is a line of the variation’s OWN order and inherits its cost code; a manual-mode variation cannot name one; an unknown cost code is refused; a cancelled order does not stop a draft edit', async () => {
    await create('u_pm', linkedRequest('l1'))
    await update('u_pm', 'l1', 1, { lines: [{ poLineIndex: 1, costCodeId: null, description: 'Blockwork', submittedAmount: -250, taxCode: 'gst' }] })
    expect((await variation('l1')).lineItems).toEqual([
      { costCodeId: 'cc4', costCodeName: '04-200 — Masonry', description: 'Blockwork', submittedAmount: -250, submittedGst: -25, approvedAmount: null, approvedGst: null, poLineIndex: 1, taxCode: 'gst' },
    ])
    await expectTeamError(update('u_pm', 'l1', 2, { lines: [{ poLineIndex: 7, costCodeId: null, description: '', submittedAmount: 1, taxCode: 'gst' }] }), A.CODE.VARIATION_COST_CODE_INVALID)
    await expectTeamError(update('u_pm', 'l1', 2, { lines: [{ poLineIndex: null, costCodeId: 'ghost', description: '', submittedAmount: 1, taxCode: 'gst' }] }), A.CODE.VARIATION_COST_CODE_INVALID)
    await expectTeamError(update('u_pm', 'l1', 2, { lines: [{ poLineIndex: null, costCodeId: 'ccB', description: '', submittedAmount: 1, taxCode: 'gst' }] }), A.CODE.VARIATION_COST_CODE_INVALID)   // another tenant's
    await poRef('poSent').update({ status: 'cancelled' })
    expect((await update('u_pm', 'l1', 2, { title: 'Edited after the order was cancelled', lines: [{ poLineIndex: 0, costCodeId: null, description: 'Slab', submittedAmount: 10, taxCode: 'gst' }] })).alreadyApplied).toBe(false)
    await create('u_pm', createRequest('m1'))
    await expectTeamError(update('u_pm', 'm1', 1, { lines: [{ poLineIndex: 0, costCodeId: null, description: '', submittedAmount: 1, taxCode: 'gst' }] }), A.CODE.VARIATION_COST_CODE_INVALID)
    // The reference must be on the variation's own side.
    await expectTeamError(update('u_pm', 'm1', 1, { clientRef: 'CR', supplierRef: null }), A.CODE.VARIATION_INVALID)
    await create('u_pm', clientRequest('c1'))
    expect((await update('u_pm', 'c1', 1, { clientRef: 'CR-9', supplierRef: null })).alreadyApplied).toBe(false)
    expect(await variation('c1')).toMatchObject({ clientRef: 'CR-9', supplierRef: null })
  })
})

describe('legacy variations — historical FACTS are protected; unverified draft CONTENT has no authority', () => {
  // What a financial-role client could store on a legacy draft under the Rules
  // that were live before ADR-90: any line contents, and any header whose
  // subtotal + GST equalled its total. Seeded here with the Admin SDK.
  const forgedSubmitted = (o = {}) => legacyVariation({ ...o })
  const line = (o = {}) => ({ ...legacyVariation().lineItems[0], ...o })
  const approveLegacy = (id, amounts = [40.15, -40.15], notes = '') => approve('u_pm', id, { approvedAmounts: amounts, assessmentNotes: notes })
  const refusedUnchanged = async (id, doc, amounts, code = A.CODE.VARIATION_FIGURES_INCONSISTENT) => {
    await variationRef(id).set(doc)
    const before = await variation(id)
    const err = await expectTeamError(approveLegacy(id, amounts, 'x'), code)
    expect(await variation(id)).toEqual(before)
    return err
  }

  it('B · A LEGITIMATE HISTORICAL SUBMITTED DRAFT is approved, under the legacy calculation it was written with', async () => {
    // The foundation shape: no originating-RFI keys at all.
    await variationRef('legit').set(without(legacyVariation(), 'originRfiId', 'originRfiNumber', 'originRfiTitle'))
    await approveLegacy('legit', [40.15, -40.15])
    const v = await variation('legit')
    expect(v).toMatchObject({ status: 'approved', approvedSubtotal: 0, approvedGst: 0, approvedTotal: 0, revision: 3 })
    expect(v.lineItems.map(l => [l.approvedAmount, l.approvedGst])).toEqual([[40.15, 4.01], [-40.15, -4.01]])
    expect('calcVersion' in v).toBe(false)
  })

  it('B/C · FORGED LEGACY LINE AMOUNTS are refused at approval — nothing is certified, nothing is written', async () => {
    for (const [name, submittedAmount] of [['thirdDecimal', 40.155], ['string', '40.15'], ['huge', 1e15], ['nan', null]]) {
      const err = await refusedUnchanged(`amount_${name}`, forgedSubmitted({ lineItems: [line({ submittedAmount }), legacyVariation().lineItems[1]] }), [40.15, -40.15])
      expect(err.details.reason).toBe('line-amount')
    }
  })

  it('B/C · FORGED LEGACY GST is refused — a GST unrelated to the amount, GST on a GST-free line, none on a taxable line', async () => {
    const cases = [
      forgedSubmitted({ lineItems: [line({ submittedGst: 40.15 }), legacyVariation().lineItems[1]], submittedGst: 36.14, submittedTotal: 36.14 }),
      forgedSubmitted({ lineItems: [line({ submittedGst: 0 }), legacyVariation().lineItems[1]], submittedGst: -4.01, submittedTotal: -4.01 }),
      forgedSubmitted({ lineItems: [line({ taxCode: 'gst_free', submittedGst: 4.01 }), legacyVariation().lineItems[1]] }),
    ]
    for (const [i, doc] of cases.entries()) expect((await refusedUnchanged(`gst_${i}`, doc, [40.15, -40.15])).details.reason).toBe('line-gst')
  })

  it('B/C · FORGED TOTALS are refused — a header that satisfied the old Rules (subtotal + GST = total) but is not the sum of its lines', async () => {
    for (const [i, header] of [{ submittedSubtotal: 5000, submittedGst: 500, submittedTotal: 5500 }, { submittedSubtotal: -100, submittedGst: 0, submittedTotal: -100 }, { submittedSubtotal: 0, submittedGst: 0.01, submittedTotal: 0.01 }].entries()) {
      expect((await refusedUnchanged(`total_${i}`, forgedSubmitted(header), [40.15, -40.15])).details.reason).toBe('header')
    }
  })

  it('B/C · FORGED COST-CODE RELATIONSHIPS are refused — a cost code that does not exist, another tenant’s, a PO line on a variation with no order, a PO line whose cost code is not the order line’s, an index naming no line', async () => {
    expect((await refusedUnchanged('cc_ghost', forgedSubmitted({ lineItems: [line({ costCodeId: 'ghost' }), legacyVariation().lineItems[1]] }), [40.15, -40.15])).details).toMatchObject({ reason: 'cost-code-missing', line: 0 })
    expect((await refusedUnchanged('cc_tenant', forgedSubmitted({ lineItems: [line({ costCodeId: 'ccB' }), legacyVariation().lineItems[1]] }), [40.15, -40.15])).details.reason).toBe('cost-code-missing')
    expect((await refusedUnchanged('po_none', forgedSubmitted({ lineItems: [line({ poLineIndex: 0, costCodeId: 'cc1' }), legacyVariation().lineItems[1]] }), [40.15, -40.15])).details.reason).toBe('po-line-without-order')
    const linked = { poId: 'poSent', poNumber: 'PO-0001' }
    expect((await refusedUnchanged('po_code', forgedSubmitted({ ...linked, lineItems: [line({ poLineIndex: 0, costCodeId: 'cc2' }), legacyVariation().lineItems[1]] }), [40.15, -40.15])).details.reason).toBe('po-line-cost-code')
    expect((await refusedUnchanged('po_index', forgedSubmitted({ ...linked, lineItems: [line({ poLineIndex: 44, costCodeId: 'cc1' }), legacyVariation().lineItems[1]] }), [40.15, -40.15])).details.reason).toBe('po-line-missing')
    // None of them reached the commitment.
    for (const id of ['po_code', 'po_index']) expect('commitmentAppliedAt' in (await variation(id))).toBe(false)
  })

  it('B/C · FORGED LINE SHAPE is refused — a junk element, a smuggled key, a missing key, a bad tax code, a certified value planted on a submitted line', async () => {
    const rest = legacyVariation().lineItems[1]
    const without = (l, k) => { const c = { ...l }; delete c[k]; return c }
    const cases = [
      ['junk', forgedSubmitted({ lineItems: ['junk', rest] }), 'line'],
      ['extra', forgedSubmitted({ lineItems: [line({ hidden: 'payload' }), rest] }), 'line-keys'],
      ['missing', forgedSubmitted({ lineItems: [without(line(), 'taxCode'), rest] }), 'line-keys'],
      ['tax', forgedSubmitted({ lineItems: [line({ taxCode: 'vat' }), rest] }), 'line-tax-code'],
      ['planted', forgedSubmitted({ lineItems: [line({ approvedAmount: 999999, approvedGst: 99999.9 }), rest] }), 'line-approved'],
    ]
    for (const [name, doc, reason] of cases) expect((await refusedUnchanged(`shape_${name}`, doc, [40.15, -40.15])).details.reason, name).toBe(reason)
  })

  it('FORGED CALCULATION VERSION — no client can write it (Rules), an unknown one is refused, and a legacy document relabelled as exact (or the reverse) does not reconcile', async () => {
    // A legacy document relabelled version 2: its 4.01 is not what version 2 derives.
    expect((await refusedUnchanged('relabelled', forgedSubmitted({ calcVersion: 2 }), [40.15, -40.15])).details.reason).toBe('line-gst')
    await refusedUnchanged('unknown', forgedSubmitted({ calcVersion: 7 }), [40.15, -40.15], A.CODE.VARIATION_UNSUPPORTED_RECORD)
    // MIXED INPUTS: a version-2 document with one legacy-figure line among exact ones.
    await submitted('mixed', createRequest('mixed', { lines: [
      { poLineIndex: null, costCodeId: 'cc2', description: 'A', submittedAmount: 40.15, taxCode: 'gst' },
      { poLineIndex: null, costCodeId: 'cc2', description: 'B', submittedAmount: 80.25, taxCode: 'gst' },
    ] }))
    const good = await variation('mixed')
    expect(good.lineItems.map(l => l.submittedGst)).toEqual([4.02, 8.03])
    await variationRef('mixed').update({ lineItems: [good.lineItems[0], { ...good.lineItems[1], submittedGst: 8.02 }], submittedGst: 12.04, submittedTotal: 132.44 })
    expect((await expectTeamError(approve('u_pm', 'mixed', { approvedAmounts: [40.15, 80.25] }), A.CODE.VARIATION_FIGURES_INCONSISTENT)).details.reason).toBe('line-gst')
    // The Rules refuse the write that would forge the version in the first place.
    await clientSignIn('qs@a.test')
    const err = await updateDoc(clientVariationRef('mixed'), { calcVersion: 1, revision: 4, updatedAt: serverTimestamp(), updatedBy: 'u_qs' }).then(() => null, e => e)
    expect(err?.code).toBe('permission-denied')
  })

  it('C · A LEGACY DRAFT THAT IS EDITED is saved by the backend as VERSION 2 — re-derived in full, forged content gone — and is then approved exactly', async () => {
    // A legacy draft carrying forged content from before the boundary existed.
    await variationRef('old').set(legacyVariation({
      status: 'draft', revision: 1, submittedAt: null, submittedBy: null, submittedDate: '',
      lineItems: [line({ submittedGst: 999, costCodeName: 'FORGED NAME', smuggled: true }), legacyVariation().lineItems[1]],
      submittedSubtotal: 123456, submittedGst: 0, submittedTotal: 123456,
    }))
    await update('u_qs', 'old', 1, { title: 'Legacy variation', supplierRef: '', lines: [
      { poLineIndex: null, costCodeId: 'cc2', description: 'Bolts', submittedAmount: 40.15, taxCode: 'gst' },
      { poLineIndex: null, costCodeId: 'cc2', description: 'Credit', submittedAmount: -40.15, taxCode: 'gst' },
    ] })
    const v = await variation('old')
    expect(v).toMatchObject({ calcVersion: 2, revision: 2, submittedSubtotal: 0, submittedGst: 0, submittedTotal: 0, variationNumber: 'SV-0901' })
    expect(v.lineItems).toEqual([
      { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Bolts', submittedAmount: 40.15, submittedGst: 4.02, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
      { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Credit', submittedAmount: -40.15, submittedGst: -4.02, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
    ])
    await submitAs('qs@a.test', 'u_qs', 'old')
    await approve('u_pm', 'old', { expectedRevision: 3, approvedAmounts: [40.15, 0], assessmentNotes: 'credit not agreed' })
    expect(await variation('old')).toMatchObject({ status: 'approved', approvedSubtotal: 40.15, approvedGst: 4.02, approvedTotal: 44.17, calcVersion: 2 })
  })

  it('a forged cost-code NAME on a real cost code never becomes a certified fact: approval stores the authoritative name', async () => {
    await variationRef('named').set(legacyVariation({ lineItems: [line({ costCodeName: 'Client-forged display name' }), legacyVariation().lineItems[1]] }))
    await approveLegacy('named', [40.15, -40.15])
    expect((await variation('named')).lineItems.map(l => l.costCodeName)).toEqual(['05-100 — Structural steel', '05-100 — Structural steel'])
  })

  it('STALE SUBMITTED REVISIONS — a legacy variation edited or re-submitted underneath the assessor is refused on the revision, before anything is assessed', async () => {
    await variationRef('stale').set(legacyVariation({ revision: 5 }))
    await expectTeamError(approveLegacy('stale'), A.CODE.VARIATION_STALE)                      // the assessor reviewed revision 2
    await expectTeamError(approve('u_pm', 'stale', { expectedRevision: 4, approvedAmounts: [40.15, -40.15] }), A.CODE.VARIATION_STALE)
    expect((await approve('u_pm', 'stale', { expectedRevision: 5, approvedAmounts: [40.15, -40.15] })).alreadyApplied).toBe(false)
  })

  it('A · EXISTING APPROVED LEGACY VARIATIONS are never rewritten: a legitimate one is applied and only gains its stamps; a forged one is REFUSED commitment and left exactly as it is', async () => {
    const approvedLegacy = (o = {}) => legacyVariation({
      status: 'approved', poId: 'poSent', poNumber: 'PO-0001', revision: 3,
      lineItems: [
        { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', submittedAmount: 40.15, submittedGst: 4.01, approvedAmount: 40.15, approvedGst: 4.01, poLineIndex: 0, taxCode: 'gst' },
        { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'New', submittedAmount: 250, submittedGst: 25, approvedAmount: 250, approvedGst: 25, poLineIndex: null, taxCode: 'gst' },
      ],
      submittedSubtotal: 290.15, submittedGst: 29.01, submittedTotal: 319.16, approvedSubtotal: 290.15, approvedGst: 29.01, approvedTotal: 319.16,
      approvedAt: A.Timestamp.fromDate(new Date('2026-09-05T00:00:00Z')), approvedBy: 'u_pm', approvedDate: '2026-09-05',
      ...o,
    })
    const lines = approvedLegacy().lineItems
    // Legitimate: applied; the legacy 4.01 is NOT recalculated to 4.02.
    await variationRef('ok').set(approvedLegacy())
    expect((await apply('u_pm', 'ok', 3)).applied).toBe(true)
    const ok = await variation('ok')
    expect(ok).toMatchObject({ approvedGst: 29.01, approvedTotal: 319.16, commitmentAppliedBy: 'u_pm', scopeCommittedBy: 'u_pm' })
    expect(ok.lineItems).toEqual(lines)
    // Forged, each refused with the document untouched and unstamped.
    const forged = {
      header:   approvedLegacy({ approvedSubtotal: 29015, approvedGst: 2901.5, approvedTotal: 31916.5 }),
      amount:   approvedLegacy({ lineItems: [{ ...lines[0], approvedAmount: 4015000 }, lines[1]] }),
      gst:      approvedLegacy({ lineItems: [{ ...lines[0], approvedGst: 0 }, lines[1]], approvedGst: 25, approvedTotal: 315.15 }),
      relabel:  approvedLegacy({ calcVersion: 2 }),
      poCode:   approvedLegacy({ lineItems: [{ ...lines[0], costCodeId: 'cc2' }, lines[1]] }),
      poIndex:  approvedLegacy({ lineItems: [{ ...lines[0], poLineIndex: 12 }, lines[1]] }),
      newScope: approvedLegacy({ lineItems: [lines[0], { ...lines[1], costCodeId: 'ghost' }] }),
      smuggle:  approvedLegacy({ lineItems: [lines[0], { ...lines[1], extra: 1 }] }),
    }
    for (const [name, doc] of Object.entries(forged)) {
      await variationRef(`f_${name}`).set(doc)
      const before = await variation(`f_${name}`)
      await expectTeamError(apply('u_pm', `f_${name}`, 3), A.CODE.VARIATION_FIGURES_INCONSISTENT)
      expect(await variation(`f_${name}`), name).toEqual(before)
    }
    expect((await audits()).filter(e => e.type === 'variation.commitment_applied')).toHaveLength(1)
  })

  it('DOWNSTREAM COMMITMENT INTEGRITY — after every refusal above the purchase order’s commitment figures are exactly those of the legitimate variations', async () => {
    const po = { id: 'poSent', ...purchaseOrder('sent') }
    // One legitimate PO-linked variation, created, submitted and approved through the boundary.
    await submitted('good', linkedRequest('good'))
    await approve('u_pm', 'good', { approvedAmounts: [40.15, 250] })
    // A forged legacy submitted variation that tries to move 1,000,000.00 onto PO line 0 through a mismatched cost code.
    await variationRef('bad').set(legacyVariation({
      poId: 'poSent', poNumber: 'PO-0001',
      lineItems: [{ ...legacyVariation().lineItems[0], poLineIndex: 0, costCodeId: 'cc2', submittedAmount: 1000000, submittedGst: 100000 }],
      submittedSubtotal: 1000000, submittedGst: 100000, submittedTotal: 1100000,
    }))
    await expectTeamError(approve('u_pm', 'bad', { approvedAmounts: [1000000] }), A.CODE.VARIATION_FIGURES_INCONSISTENT)
    const all = (await project().collection('variations').get()).docs.map(d => ({ id: d.id, ...d.data() }))
    const adjustments = appliedSupplierVariationAdjustments(all, [po])
    expect(adjustments.byPoLine).toEqual({ poSent: { 0: 40.15 } })
    expect(adjustments.committedNewScopeByCostCode).toEqual({ cc2: 250 })
    expect(adjustments.exceptions).toEqual([])
    expect(approvedSupplierVariationsByCostCode(all)).toEqual({ cc1: 40.15, cc2: 250 })
    expect(all.find(v => v.id === 'bad').status).toBe('submitted')
  })
})

describe('approveVariation — the certification point', () => {
  it('writes the certified lines, the SIGNED approved header, the notes, the dates and the stamps on the reviewed revision — and the variation is then terminal', async () => {
    await submitted('v1', createRequest('v1', {
      lines: [
        { poLineIndex: null, costCodeId: 'cc2', description: 'Bolts', submittedAmount: 40.15, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc3', description: 'Permit', submittedAmount: 500, taxCode: 'gst_free' },
      ],
    }))
    // Certified: 40.15 (GST 4.02) and 450.00 GST-free → 490.15 · 4.02 · 494.17
    const out = await approve('u_pm', 'v1', { approvedAmounts: [40.15, 450], assessmentNotes: '  Permit reduced  ', approvedDate: '2026-11-27' })
    expect(out).toMatchObject({ variationId: 'v1', alreadyApplied: false, commitmentApplied: false })
    const v = await variation('v1')
    expect(v).toMatchObject({
      status: 'approved', approvedBy: 'u_pm', updatedBy: 'u_pm', revision: 3, calcVersion: 2,
      approvedSubtotal: 490.15, approvedGst: 4.02, approvedTotal: 494.17,
      assessmentNotes: 'Permit reduced', approvedDate: '2026-11-27', effectiveDate: '2026-11-27',
      submittedSubtotal: 540.15, submittedGst: 4.02, submittedTotal: 544.17, submittedBy: 'u_qs',
    })
    expect(v.approvedAt).toBeInstanceOf(A.Timestamp)
    expect(v.approvedAt.isEqual(v.updatedAt)).toBe(true)
    expect(v.lineItems.map(l => [l.submittedAmount, l.submittedGst, l.approvedAmount, l.approvedGst, l.costCodeId, l.taxCode])).toEqual([
      [40.15, 4.02, 40.15, 4.02, 'cc2', 'gst'], [500, 0, 450, 0, 'cc3', 'gst_free'],
    ])
    for (const k of ['commitmentAppliedAt', 'commitmentAppliedBy', 'scopeCommittedAt', 'scopeCommittedBy']) expect(k in v).toBe(false)
    // Terminal: nothing approves, rejects or withdraws it again.
    await expectTeamError(approve('u_admin', 'v1', { expectedRevision: 3, approvedAmounts: [1, 1], assessmentNotes: 'again' }), A.CODE.VARIATION_NOT_SUBMITTED)
    await clientSignIn('pm@a.test')
    for (const nextStatus of ['rejected', 'withdrawn']) {
      const err = await updateDoc(clientVariationRef('v1'), { status: nextStatus, [`${nextStatus}At`]: serverTimestamp(), [`${nextStatus}By`]: 'u_pm', revision: 4, updatedAt: serverTimestamp(), updatedBy: 'u_pm' }).then(() => null, e => e)
      expect(err?.code).toBe('permission-denied')
    }
  })

  it('approval is UNBOUNDED against submitted — above, equal, zero and negative certified values are accepted, never clamped; an existing effective date is kept', async () => {
    for (const [id, amount, gst] of [['a', 2500.55, 250.06], ['b', 1000, 100], ['c', 0, 0], ['d', -300, -30]]) {
      await submitted(id, createRequest(id, { effectiveDate: '2026-12-15' }))
      await approve('u_admin', id, { approvedAmounts: [amount], assessmentNotes: amount === 1000 ? '' : 'negotiated' })
      // 2,500.55 × 10% = 250.055 → 250.06 (half up)
      expect(await variation(id)).toMatchObject({ status: 'approved', approvedSubtotal: amount, approvedGst: gst, approvedTotal: Math.round((amount + gst) * 100) / 100, effectiveDate: '2026-12-15' })
    }
  })

  it('certified amounts are normalised to cents by the SERVER and the notes trimmed — 899.999 is stored as 900.00', async () => {
    await submitted('v1')
    await approve('u_pm', 'v1', { approvedAmounts: [899.999], assessmentNotes: '  rounded  ' })
    expect(await variation('v1')).toMatchObject({ approvedSubtotal: 900, approvedGst: 90, approvedTotal: 990, assessmentNotes: 'rounded' })
    expect((await variation('v1')).lineItems[0]).toMatchObject({ approvedAmount: 900, approvedGst: 90 })
    // …and the same on a legacy variation, under the legacy expression.
    await variationRef('legacy').set(legacyVariation())
    await approve('u_pm', 'legacy', { approvedAmounts: [899.999, -40.15], assessmentNotes: ' x ' })
    expect((await variation('legacy')).lineItems.map(l => l.approvedAmount)).toEqual([900, -40.15])
    expect((await variation('legacy')).assessmentNotes).toBe('x')
  })

  it('the business checks the browser used to make alone are the SERVER’S: a count mismatch, and differing amounts without notes, are refused with the reason', async () => {
    await submitted('v1')
    await expectTeamError(approve('u_pm', 'v1', { approvedAmounts: [1000, 5] }), A.CODE.VARIATION_INVALID)
    const err = await expectTeamError(approve('u_pm', 'v1', { approvedAmounts: [900] }), A.CODE.VARIATION_INVALID)
    expect(err.message).toMatch(/Assessment notes are required/)
    expect(err.message).toMatch(/Nothing was changed/)
    expect((await variation('v1')).status).toBe('submitted')
    expect((await audits()).filter(e => e.type === 'variation.approved')).toEqual([])
  })

  it('every financial role approves; a subcontractor, a client, another tenant, a deactivated member and an anonymous caller do not', async () => {
    for (const [uid, id] of [['u_admin', 'r1'], ['u_pm', 'r2'], ['u_qs', 'r3']]) {
      await submitted(id)
      expect((await approve(uid, id)).alreadyApplied).toBe(false)
      expect((await variation(id)).approvedBy).toBe(uid)
    }
    await submitted('v1')
    await expectTeamError(approve('u_sub', 'v1'), A.CODE.VARIATION_FORBIDDEN)
    await expectTeamError(approve('u_client', 'v1'), A.CODE.VARIATION_FORBIDDEN)
    await expectTeamError(approve('u_other', 'v1'), A.CODE.NOT_FOUND)
    await expectTeamError(approve(null, 'v1'), A.CODE.UNAUTHENTICATED)
    await expectTeamError(approve('u_pm', 'noSuchVariation'), A.CODE.NOT_FOUND)
    await A.db.collection('users').doc('u_pm').update({ status: 'deactivated', companyId: null, role: null })
    await expectTeamError(approve('u_pm', 'v1'), A.CODE.MEMBERSHIP_INACTIVE)
    expect((await variation('v1')).status).toBe('submitted')
  })

  it('a membership REMOVED while the approval is in flight is ordered against it: the membership the transaction reads decides', async () => {
    await submitted('v1')
    let pending = null
    hooks.afterRead = async ({ attempt, op }) => {
      if (attempt !== 1 || op !== 'approve') return
      pending = A.db.collection('users').doc('u_pm').update({ status: 'deactivated', companyId: null, role: null }).then(r => ({ ok: true, time: r.writeTime }), e => ({ ok: false, e }))
      await new Promise(r => setTimeout(r, 400))
    }
    const outcome = await approve('u_pm', 'v1').then(v => ({ approved: true, v }), e => ({ approved: false, e }))
    const write = await pending
    expect(write.ok).toBe(true)
    const stored = await variationRef('v1').get()
    if (outcome.approved) {
      // Ordered first, while still a member; the removal committed strictly after.
      expect(stored.data().status).toBe('approved')
      expect(write.time.valueOf() > stored.updateTime.valueOf()).toBe(true)
    } else {
      // Ordered after the removal: refused, nothing written.
      expect([A.CODE.MEMBERSHIP_INACTIVE, A.CODE.NO_MEMBERSHIP]).toContain(outcome.e?.details?.code)
      expect(stored.data().status).toBe('submitted')
      expect((await audits()).filter(e => e.type === 'variation.approved')).toEqual([])
    }
  })

  it('the legal matrix: a draft, a rejected and a withdrawn variation cannot be approved; the reserved under_review can (none is stranded)', async () => {
    await create('u_qs', createRequest('draft1'))
    await expectTeamError(approve('u_pm', 'draft1', { expectedRevision: 1 }), A.CODE.VARIATION_NOT_SUBMITTED)
    for (const status of ['rejected', 'withdrawn', 'disputed', 'superseded', 'nonsense']) {
      await variationRef(`s_${status}`).set(legacyVariation({ status }))
      await expectTeamError(approve('u_pm', `s_${status}`, { approvedAmounts: [1, 1], assessmentNotes: 'x' }), A.CODE.VARIATION_NOT_SUBMITTED)
    }
    await variationRef('review').set(legacyVariation({ status: 'under_review' }))
    expect((await approve('u_pm', 'review', { approvedAmounts: [40.15, -40.15] })).alreadyApplied).toBe(false)
    expect((await variation('review')).status).toBe('approved')
  })

  it('the audit event records the figures in whole cents and WHO the approver is in relation to the document', async () => {
    await submitted('v1')                                   // created and submitted by u_qs
    await approve('u_qs', 'v1')                             // self-approval — permitted, and recorded
    await submitted('v2')
    await approve('u_pm', 'v2')                             // an independent approver
    const events = (await audits()).filter(e => e.type === 'variation.approved')
    const self = events.find(e => e.after.variationId === 'v1')
    const independent = events.find(e => e.after.variationId === 'v2')
    expect(self).toMatchObject({
      actorUid: 'u_qs', source: 'callable',
      before: { status: 'submitted', revision: 2 },
      after: {
        projectId: PROJECT, variationNumber: 'SV-0001', variationType: 'supplier', status: 'approved', calcVersion: 2, revision: 3,
        poId: null, commitmentApplied: false, lineCount: 1,
        submittedSubtotalCents: 100000, approvedSubtotalCents: 100000, approvedGstCents: 10000, approvedTotalCents: 110000,
        approverIsCreator: true, approverIsSubmitter: true, approverIsLastEditor: true,
      },
    })
    expect(independent.after).toMatchObject({ approverIsCreator: false, approverIsSubmitter: false, approverIsLastEditor: false })
  })
})

describe('approveVariation — the approve-time commitment decision (ADR-62 / ADR-63)', () => {
  it('a PO-linked supplier variation whose order is SENT is approved AND applied in one write, with both stamp pairs, the actor and the server time; it then adjusts that PO line', async () => {
    await submitted('v1', linkedRequest('v1'))
    const out = await approve('u_pm', 'v1', { approvedAmounts: [40.15, 250] })
    expect(out.commitmentApplied).toBe(true)
    const v = await variation('v1')
    expect(v).toMatchObject({ status: 'approved', commitmentAppliedBy: 'u_pm', scopeCommittedBy: 'u_pm', approvedSubtotal: 290.15, approvedGst: 29.02, approvedTotal: 319.17 })
    expect(v.commitmentAppliedAt.isEqual(v.approvedAt)).toBe(true)
    expect(v.scopeCommittedAt.isEqual(v.approvedAt)).toBe(true)
    // The read-time consumers see exactly what they saw from the old client write.
    const po = { id: 'poSent', ...(await data(poRef('poSent'))) }
    const stored = { id: 'v1', ...v }
    expect(variationIncorporation(stored, [po]).state).toBe(INCORPORATION_STATE.INCORPORATED)
    const adjustments = appliedSupplierVariationAdjustments([stored], [po])
    expect(adjustments.byPoLine).toEqual({ poSent: { 0: 40.15 } })
    expect(adjustments.committedNewScopeByCostCode).toEqual({ cc2: 250 })
    expect(claimableNewScopeLines([stored], po).map(l => [l.lineIndex, l.amount])).toEqual([[1, 250]])
    // The purchase order itself is never written.
    expect(await data(poRef('poSent'))).toEqual(purchaseOrder('sent'))
  })

  it('a CLOSED order applies too', async () => {
    await submitted('v1', linkedRequest('v1', { poId: 'poClosed' }))
    expect((await approve('u_admin', 'v1', { approvedAmounts: [40.15, 250] })).commitmentApplied).toBe(true)
  })

  it('Correction A — an order cancelled, returned to draft or deleted AFTER the variation was raised REFUSES the approval: nothing written, an actionable message; the variation can still be rejected', async () => {
    await submitted('v1', linkedRequest('v1'))
    for (const status of ['cancelled', 'draft', 'pending_approval']) {
      await poRef('poSent').update({ status })
      const err = await expectTeamError(approve('u_pm', 'v1', { approvedAmounts: [40.15, 250] }), A.CODE.VARIATION_PO_INVALID)
      expect(err.message).toMatch(/PO-0001 is not sent or closed/)
      expect(err.message).toMatch(/Withdraw or reject SV-0001/)
      expect(err.details.poStatus).toBe(status)
    }
    await poRef('poSent').delete()
    const missing = await expectTeamError(approve('u_pm', 'v1', { approvedAmounts: [40.15, 250] }), A.CODE.VARIATION_PO_INVALID)
    expect(missing.message).toMatch(/could not be found in this project/)
    const v = await variation('v1')
    expect(v.status).toBe('submitted')
    expect('commitmentAppliedAt' in v).toBe(false)
    expect((await audits()).filter(e => e.type === 'variation.approved')).toEqual([])
    await clientSignIn('pm@a.test')
    await runTransitionVariation({ ...appSdk('u_pm'), variationRef: clientVariationRef('v1'), seen: { id: 'v1', ...v }, nextStatus: 'rejected' })
    expect((await variation('v1')).status).toBe('rejected')
  })

  it('manual-mode supplier and client variations keep their lifecycle: approved without reading an order, and with NO stamp', async () => {
    await submitted('m1')
    await submitted('c1', clientRequest('c1'))
    expect((await approve('u_pm', 'm1')).commitmentApplied).toBe(false)
    expect((await approve('u_pm', 'c1')).commitmentApplied).toBe(false)
    for (const id of ['m1', 'c1']) {
      const v = await variation(id)
      expect(v.status).toBe('approved')
      for (const k of ['commitmentAppliedAt', 'commitmentAppliedBy', 'scopeCommittedAt', 'scopeCommittedBy']) expect(k in v).toBe(false)
    }
    expect(approvedClientVariationsTotal([{ id: 'c1', ...(await variation('c1')) }])).toBe(1000)
  })

  it('a stored variation whose PO link is malformed is refused as an unsupported record — never approved around', async () => {
    await variationRef('odd1').set(legacyVariation({ variationType: 'client', poId: 'poSent', poNumber: 'PO-0001' }))     // a client variation naming an order
    await expectTeamError(approve('u_pm', 'odd1', { approvedAmounts: [40.15, -40.15] }), A.CODE.VARIATION_UNSUPPORTED_RECORD)
    await variationRef('odd2').set(without(legacyVariation(), 'poId'))                                                                                // no poId key at all
    await expectTeamError(approve('u_pm', 'odd2', { approvedAmounts: [40.15, -40.15] }), A.CODE.VARIATION_UNSUPPORTED_RECORD)
    await variationRef('odd3').set(legacyVariation({ effectiveDate: 'next week' }))
    await expectTeamError(approve('u_pm', 'odd3', { approvedAmounts: [40.15, -40.15] }), A.CODE.VARIATION_UNSUPPORTED_RECORD)
  })
})

describe('approveVariation — each variation under ITS OWN calculation version (ADR-91)', () => {
  it('a LEGACY variation (no calcVersion) is certified with the LEGACY figures — 40.15 → 4.01 — and gains no version', async () => {
    await variationRef('legacy').set(legacyVariation())
    await approve('u_pm', 'legacy', { approvedAmounts: [40.15, 0], assessmentNotes: 'credit not agreed' })
    const v = await variation('legacy')
    expect(v).toMatchObject({ status: 'approved', approvedSubtotal: 40.15, approvedGst: 4.01, approvedTotal: 44.16, revision: 3 })
    expect(v.lineItems.map(l => [l.submittedGst, l.approvedAmount, l.approvedGst])).toEqual([[4.01, 40.15, 4.01], [-4.01, 0, 0]])
    expect('calcVersion' in v).toBe(false)
    // Its submitted side — the historical figures — is exactly as it was stored.
    expect([v.submittedSubtotal, v.submittedGst, v.submittedTotal]).toEqual([0, 0, 0])
  })

  it('the SAME amounts on a version-2 variation are certified exactly — 40.15 → 4.02', async () => {
    await submitted('exact', createRequest('exact', {
      lines: [
        { poLineIndex: null, costCodeId: 'cc2', description: 'Bolts', submittedAmount: 40.15, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc2', description: 'Credit', submittedAmount: -40.15, taxCode: 'gst' },
      ],
    }))
    await approve('u_pm', 'exact', { approvedAmounts: [40.15, 0], assessmentNotes: 'credit not agreed' })
    expect(await variation('exact')).toMatchObject({ approvedSubtotal: 40.15, approvedGst: 4.02, approvedTotal: 44.17, calcVersion: 2 })
  })

  it('SIGNED certification, half away from zero: -40.15 → GST -4.02 under version 2, and the legacy -4.01 under version 1', async () => {
    await variationRef('legacy').set(legacyVariation())
    await approve('u_pm', 'legacy', { approvedAmounts: [0, -40.15], assessmentNotes: 'credit only' })
    expect(await variation('legacy')).toMatchObject({ approvedSubtotal: -40.15, approvedGst: -4.01, approvedTotal: -44.16 })
    await submitted('exact', createRequest('exact', {
      lines: [
        { poLineIndex: null, costCodeId: 'cc2', description: 'Bolts', submittedAmount: 40.15, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc2', description: 'Credit', submittedAmount: -40.15, taxCode: 'gst' },
      ],
    }))
    await approve('u_pm', 'exact', { approvedAmounts: [0, -40.15], assessmentNotes: 'credit only' })
    expect(await variation('exact')).toMatchObject({ approvedSubtotal: -40.15, approvedGst: -4.02, approvedTotal: -44.17 })
    // A certified amount entered to the tenth of a cent is rounded half away from zero first.
    await submitted('third', createRequest('third'))
    await approve('u_pm', 'third', { approvedAmounts: [-4.015], assessmentNotes: 'reduced' })
    expect(await variation('third')).toMatchObject({ approvedSubtotal: -4.02, approvedGst: -0.4, approvedTotal: -4.42 })
  })

  it('a version-2 variation whose submitted side no longer reconciles to its own lines is refused — the gap the Rules cannot see is closed here', async () => {
    await submitted('v1', createRequest('v1', { lines: [{ poLineIndex: null, costCodeId: 'cc2', description: 'Bolts', submittedAmount: 40.15, taxCode: 'gst' }] }))
    const good = await variation('v1')
    const forgeries = [
      { lineItems: [{ ...good.lineItems[0], submittedGst: 4.01 }], submittedGst: 4.01, submittedTotal: 44.16 },   // the legacy figure, header consistent
      { submittedSubtotal: 400.15, submittedTotal: 404.17 },                                                       // a header unrelated to its lines
      { lineItems: [{ ...good.lineItems[0], taxCode: 'vat' }] },
      { lineItems: [{ ...good.lineItems[0], costCodeId: '' }] },
      { lineItems: [{ ...good.lineItems[0], approvedAmount: 5 }] },
    ]
    for (const forged of forgeries) {
      await variationRef('v1').update(forged)
      await expectTeamError(approve('u_pm', 'v1', { approvedAmounts: [40.15] }), A.CODE.VARIATION_FIGURES_INCONSISTENT)
      await variationRef('v1').set(good)
    }
    expect((await approve('u_pm', 'v1', { approvedAmounts: [40.15] })).alreadyApplied).toBe(false)
  })

  it('an UNKNOWN calculation version is refused — never calculated under a guess', async () => {
    for (const calcVersion of [3, '2', 0, 1.5]) {
      await variationRef('odd').set(legacyVariation({ calcVersion }))
      await expectTeamError(approve('u_pm', 'odd', { approvedAmounts: [40.15, -40.15] }), A.CODE.VARIATION_UNSUPPORTED_RECORD)
    }
    await variationRef('one').set(legacyVariation({ calcVersion: 1 }))
    expect((await approve('u_pm', 'one', { approvedAmounts: [40.15, -40.15] })).alreadyApplied).toBe(false)
  })
})

describe('approveVariation — stale reviews, replays and concurrency', () => {
  it('an approval lands only on the revision that was REVIEWED: a draft edited and re-submitted underneath is refused, nothing written', async () => {
    await submitted('v1')
    await expectTeamError(approve('u_pm', 'v1', { expectedRevision: 1 }), A.CODE.VARIATION_STALE)
    await expectTeamError(approve('u_pm', 'v1', { expectedRevision: 3 }), A.CODE.VARIATION_STALE)
    expect((await variation('v1')).status).toBe('submitted')
    expect((await approve('u_pm', 'v1', { expectedRevision: 2 })).alreadyApplied).toBe(false)
    // A legacy document with no revision key is revision 0.
    await variationRef('legacy').set(without(legacyVariation(), 'revision'))
    await expectTeamError(approve('u_pm', 'legacy', { approvedAmounts: [40.15, -40.15] }), A.CODE.VARIATION_STALE)
    expect((await approve('u_pm', 'legacy', { expectedRevision: 0, approvedAmounts: [40.15, -40.15] })).alreadyApplied).toBe(false)
    expect((await variation('legacy')).revision).toBe(1)
  })

  it('a REPEAT by the same approver with the same amounts is answered already-approved — one write, one audit event; anything else is told it is no longer awaiting approval', async () => {
    await submitted('v1', linkedRequest('v1'))
    const first = await approve('u_pm', 'v1', { approvedAmounts: [40.15, 250] })
    const stored = await variationRef('v1').get()
    const again = await approve('u_pm', 'v1', { approvedAmounts: [40.15, 250] })
    expect(first).toMatchObject({ alreadyApplied: false, commitmentApplied: true })
    expect(again).toMatchObject({ alreadyApplied: true, commitmentApplied: true })
    await expectTeamError(approve('u_pm', 'v1', { approvedAmounts: [40.15, 200], assessmentNotes: 'changed my mind' }), A.CODE.VARIATION_NOT_SUBMITTED)
    await expectTeamError(approve('u_admin', 'v1', { approvedAmounts: [40.15, 250] }), A.CODE.VARIATION_NOT_SUBMITTED)
    expect((await variationRef('v1').get()).updateTime.isEqual(stored.updateTime)).toBe(true)
    expect((await audits()).filter(e => e.type === 'variation.approved')).toHaveLength(1)
  })

  it('TWO ASSESSORS AT ONCE with different certified amounts: exactly one approval lands; the other is refused and overwrites nothing', async () => {
    await submitted('v1')
    const results = await Promise.allSettled([
      approve('u_pm', 'v1', { approvedAmounts: [900], assessmentNotes: 'pm view' }),
      approve('u_admin', 'v1', { approvedAmounts: [800], assessmentNotes: 'admin view' }),
    ])
    const won = results.filter(r => r.status === 'fulfilled')
    const lost = results.filter(r => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect([A.CODE.VARIATION_NOT_SUBMITTED, A.CODE.VARIATION_STALE, A.CODE.VARIATION_BUSY]).toContain(lost[0].reason?.details?.code)
    const v = await variation('v1')
    expect(v.revision).toBe(3)
    expect([['u_pm', 900, 'pm view'], ['u_admin', 800, 'admin view']]).toContainEqual([v.approvedBy, v.approvedSubtotal, v.assessmentNotes])
    expect((await audits()).filter(e => e.type === 'variation.approved')).toHaveLength(1)
  })

  it('an approval racing a WITHDRAWAL by the browser: whichever commits first stands, and the variation is never both', async () => {
    await submitted('v1')
    await clientSignIn('qs@a.test')
    const seen = { id: 'v1', ...(await variation('v1')) }
    const results = await Promise.allSettled([
      approve('u_pm', 'v1'),
      runTransitionVariation({ ...appSdk('u_qs'), variationRef: clientVariationRef('v1'), seen, nextStatus: 'withdrawn' }),
    ])
    const v = await variation('v1')
    expect(['approved', 'withdrawn']).toContain(v.status)
    expect(v.revision).toBe(3)
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    if (v.status === 'approved') { expect(v.withdrawnAt).toBeNull() } else { expect(v.approvedAt).toBeNull(); expect(v.approvedSubtotal).toBeNull() }
  })
})

describe('applyVariationCommitment — the one-time legacy Apply / Commit new scope', () => {
  const approvedLegacy = (o = {}) => legacyVariation({
    status: 'approved', poId: 'poSent', poNumber: 'PO-0001', revision: 3,
    lineItems: [
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', submittedAmount: 100, submittedGst: 10, approvedAmount: 100, approvedGst: 10, poLineIndex: 0, taxCode: 'gst' },
      { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'New', submittedAmount: 250, submittedGst: 25, approvedAmount: 250, approvedGst: 25, poLineIndex: null, taxCode: 'gst' },
    ],
    submittedSubtotal: 350, submittedGst: 35, submittedTotal: 385, approvedSubtotal: 350, approvedGst: 35, approvedTotal: 385,
    approvedAt: A.Timestamp.fromDate(new Date('2026-09-05T00:00:00Z')), approvedBy: 'u_pm', approvedDate: '2026-09-05',
    ...o,
  })

  it('every financial role applies an approved, unstamped PO-linked variation ONCE: both pairs + revision + audit stamps, and nothing else moves', async () => {
    for (const [uid, id] of [['u_admin', 'a1'], ['u_pm', 'a2'], ['u_qs', 'a3']]) {
      await variationRef(id).set(approvedLegacy())
      const before = await variation(id)
      expect(await apply(uid, id, 3)).toMatchObject({ alreadyApplied: false, byCaller: true, applied: true, scopeCommitted: true })
      const after = await variation(id)
      expect(after).toMatchObject({ commitmentAppliedBy: uid, scopeCommittedBy: uid, updatedBy: uid, revision: 4 })
      expect(after.commitmentAppliedAt.isEqual(after.updatedAt)).toBe(true)
      expect(after.scopeCommittedAt.isEqual(after.updatedAt)).toBe(true)
      const strip = (v) => without(v, 'commitmentAppliedAt', 'commitmentAppliedBy', 'scopeCommittedAt', 'scopeCommittedBy', 'revision', 'updatedAt', 'updatedBy')
      expect(strip(after)).toEqual(strip(before))
    }
    expect((await audits()).filter(e => e.type === 'variation.commitment_applied')).toHaveLength(3)
  })

  it('ADR-63 — a variation applied under M3-B1 (applied pair stored, no scope pair) takes the SCOPE pair alone; the applied pair is untouched', async () => {
    const appliedAt = A.Timestamp.fromDate(new Date('2026-10-30T00:00:00Z'))
    await variationRef('v1').set(approvedLegacy({ commitmentAppliedAt: appliedAt, commitmentAppliedBy: 'u_admin' }))
    expect(await apply('u_qs', 'v1', 3)).toMatchObject({ applied: false, scopeCommitted: true, alreadyApplied: false })
    const v = await variation('v1')
    expect(v.commitmentAppliedBy).toBe('u_admin')
    expect(v.commitmentAppliedAt.isEqual(appliedAt)).toBe(true)
    expect(v.scopeCommittedBy).toBe('u_qs')
    // …and with only existing-line amounts there is nothing left to commit.
    await variationRef('v2').set(approvedLegacy({ commitmentAppliedAt: appliedAt, commitmentAppliedBy: 'u_admin', lineItems: [approvedLegacy().lineItems[0]] }))
    expect(await apply('u_qs', 'v2', 3)).toMatchObject({ alreadyApplied: true, byCaller: false })
    expect('scopeCommittedAt' in (await variation('v2'))).toBe(false)
  })

  it('a REPEAT is answered already-applied with nothing written — by the same user or another — and the first stamps stand', async () => {
    await variationRef('v1').set(approvedLegacy())
    await apply('u_pm', 'v1', 3)
    const stored = await variationRef('v1').get()
    expect(await apply('u_pm', 'v1', 3)).toMatchObject({ alreadyApplied: true, byCaller: true, applied: false, scopeCommitted: false })
    expect(await apply('u_pm', 'v1', 4)).toMatchObject({ alreadyApplied: true, byCaller: true })
    expect(await apply('u_admin', 'v1', 4)).toMatchObject({ alreadyApplied: true, byCaller: false })
    expect((await variationRef('v1').get()).updateTime.isEqual(stored.updateTime)).toBe(true)
    expect((await audits()).filter(e => e.type === 'variation.commitment_applied')).toHaveLength(1)
    // A variation approved through the callable (both pairs written then) cannot be re-applied either.
    await submitted('v2', linkedRequest('v2'))
    await approve('u_pm', 'v2', { approvedAmounts: [40.15, 250] })
    expect(await apply('u_admin', 'v2', 3)).toMatchObject({ alreadyApplied: true, byCaller: false })
  })

  it('TWO CONCURRENT applies by two users: exactly one writes; the other is answered already-applied (or busy) and the winner’s stamps stand', async () => {
    await variationRef('v1').set(approvedLegacy())
    const results = await Promise.allSettled([apply('u_pm', 'v1', 3), apply('u_admin', 'v1', 3)])
    const values = results.filter(r => r.status === 'fulfilled').map(r => r.value)
    expect(values.filter(r => r.alreadyApplied === false)).toHaveLength(1)
    for (const r of results.filter(x => x.status === 'rejected')) expect([A.CODE.VARIATION_STALE, A.CODE.VARIATION_BUSY]).toContain(r.reason?.details?.code)
    const v = await variation('v1')
    expect(v.revision).toBe(4)
    expect(v.commitmentAppliedBy).toBe(v.scopeCommittedBy)
    expect((await audits()).filter(e => e.type === 'variation.commitment_applied')).toHaveLength(1)
  })

  it('only an APPROVED, PO-linked SUPPLIER variation can be applied, and only while its order is sent or closed on the server', async () => {
    for (const status of ['draft', 'submitted', 'under_review', 'rejected', 'withdrawn']) {
      await variationRef('v1').set(approvedLegacy({ status }))
      await expectTeamError(apply('u_pm', 'v1', 3), A.CODE.VARIATION_NOT_APPLICABLE)
    }
    await variationRef('manual').set(approvedLegacy({ poId: null, poNumber: null }))
    await expectTeamError(apply('u_pm', 'manual', 3), A.CODE.VARIATION_NOT_APPLICABLE)
    await variationRef('client').set(approvedLegacy({ variationType: 'client' }))
    await expectTeamError(apply('u_pm', 'client', 3), A.CODE.VARIATION_NOT_APPLICABLE)
    for (const poId of ['poCancelled', 'poDraft', 'noSuchPo']) {
      await variationRef('v2').set(approvedLegacy({ poId }))
      const err = await expectTeamError(apply('u_pm', 'v2', 3), A.CODE.VARIATION_NOT_APPLICABLE)
      expect(err.message).toMatch(/Nothing was changed/)
    }
    await variationRef('closed').set(approvedLegacy({ poId: 'poClosed', poNumber: 'PO-0002' }))
    expect((await apply('u_pm', 'closed', 3)).applied).toBe(true)
    expect((await audits()).filter(e => e.type === 'variation.commitment_applied')).toHaveLength(1)
  })

  it('a STALE reviewed copy, a missing document, non-financial roles, another tenant and an anonymous caller are refused with nothing written', async () => {
    await variationRef('v1').set(approvedLegacy())
    await expectTeamError(apply('u_pm', 'v1', 2), A.CODE.VARIATION_STALE)
    await expectTeamError(apply('u_pm', 'gone', 3), A.CODE.NOT_FOUND)
    await expectTeamError(apply('u_sub', 'v1', 3), A.CODE.VARIATION_FORBIDDEN)
    await expectTeamError(apply('u_client', 'v1', 3), A.CODE.VARIATION_FORBIDDEN)
    await expectTeamError(apply('u_other', 'v1', 3), A.CODE.NOT_FOUND)
    await expectTeamError(apply(null, 'v1', 3), A.CODE.UNAUTHENTICATED)
    expect('commitmentAppliedAt' in (await variation('v1'))).toBe(false)
    // A legacy approved document with no revision key applies at revision 0 → 1.
    await variationRef('old').set(without(approvedLegacy(), 'revision'))
    expect((await apply('u_pm', 'old', 0)).applied).toBe(true)
    expect((await variation('old')).revision).toBe(1)
  })
})

describe('downstream figures are unchanged — approval is still the only counting point, signed, never clamped', () => {
  it('a supplier variation raised, submitted and approved through the supported path feeds Commitment Exposure exactly once, by cost code, signed; pending is exposure only', async () => {
    await submitted('v1', createRequest('v1', {
      lines: [
        { poLineIndex: null, costCodeId: 'cc2', description: 'Steel', submittedAmount: 1000, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc3', description: 'Omission', submittedAmount: -300, taxCode: 'gst' },
      ],
    }))
    const pending = [{ id: 'v1', ...(await variation('v1')) }]
    expect(approvedSupplierVariationsByCostCode(pending)).toEqual({})
    expect(pendingSupplierVariationExposureTotal(pending)).toBe(700)
    await approve('u_pm', 'v1', { approvedAmounts: [900, -300], assessmentNotes: 'steel reduced' })
    const approved = [{ id: 'v1', ...(await variation('v1')) }]
    expect(approvedSupplierVariationsByCostCode(approved)).toEqual({ cc2: 900, cc3: -300 })
    expect(pendingSupplierVariationExposureTotal(approved)).toBe(0)
    // Nothing but the variation, the counter, the project lock and the audit events was written.
    for (const name of ['budgetLines', 'progressClaims', 'supplierInvoices', 'forecastLines']) expect((await project().collection(name).get()).size, name).toBe(0)
    expect(await data(poRef('poSent'))).toEqual(purchaseOrder('sent'))
  })
})

describe('through the deployed callables (App Check, ID token, the emulator’s own switch)', () => {
  it('no App Check token, or no ID token, is refused before the handler; a real call creates, approves and applies', async () => {
    const qs = await clientSignIn('qs@a.test')
    const idToken = await qs.getIdToken()
    const noAppCheck = await callFunction('createVariation', linkedRequest('h1'), { idToken, appCheck: null })
    expect(noAppCheck.error?.status).toBe('UNAUTHENTICATED')
    const anonymous = await callFunction('createVariation', linkedRequest('h1'))
    expect(anonymous.error?.status).toBe('UNAUTHENTICATED')
    expect(await variation('h1')).toBeNull()

    const forged = await callFunction('createVariation', { ...linkedRequest('h1'), submittedTotal: 1 }, { idToken })
    expect(forged.error?.status).toBe('INVALID_ARGUMENT')

    const created = await callFunction('createVariation', linkedRequest('h1'), { idToken })
    expect(created.error).toBeNull()
    expect(created.result).toMatchObject({ variationId: 'h1', variationNumber: 'SV-0001', alreadyApplied: false })
    expect((await callFunction('createVariation', linkedRequest('h1'), { idToken })).result.alreadyApplied).toBe(true)

    await submitAs('qs@a.test', 'u_qs', 'h1')
    const stale = await callFunction('approveVariation', { projectId: PROJECT, variationId: 'h1', expectedRevision: 1, approvedAmounts: [40.15, 250], assessmentNotes: '', approvedDate: '2026-11-27' }, { idToken })
    expect(stale.error?.details?.code).toBe('variation-stale')
    const approved = await callFunction('approveVariation', { projectId: PROJECT, variationId: 'h1', expectedRevision: 2, approvedAmounts: [40.15, 250], assessmentNotes: '', approvedDate: '2026-11-27' }, { idToken })
    expect(approved.result).toMatchObject({ alreadyApplied: false, commitmentApplied: true })
    const v = await variation('h1')
    expect(v).toMatchObject({ status: 'approved', approvedBy: 'u_qs', approvedSubtotal: 290.15, approvedGst: 29.02, approvedTotal: 319.17, commitmentAppliedBy: 'u_qs' })

    const applied = await callFunction('applyVariationCommitment', { projectId: PROJECT, variationId: 'h1', expectedRevision: 3 }, { idToken })
    expect(applied.result).toMatchObject({ alreadyApplied: true, byCaller: true })

    const sub = await clientSignIn('sub@a.test')
    const denied = await callFunction('createVariation', createRequest('h2'), { idToken: await sub.getIdToken() })
    expect(denied.error?.details?.code).toBe('variation-forbidden')
    expect(await variation('h2')).toBeNull()
  })
})
