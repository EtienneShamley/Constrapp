import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { admin, resetEmulators, seedCompany, activateCommercial, seedUser, req, expectTeamError, clock, silentLog, COMPANY_A, COMPANY_B } from './_harness.js'

// ── Phase 2 steps 3–4 (ADR-93 / ADR-94) — the supplier-finance callables ─────
//
// Handlers are called directly against the Auth / Firestore emulators (the
// variation-suite pattern). Every expected figure is computed in this file
// from integers (ORACLE below) — never by the modules under test.

const PROJECT = 'projectA'
const PAYMENT_METHOD = 'bank_transfer'
let A, handlersMod, H, now

const company = (c = COMPANY_A) => A.db.collection('companies').doc(c)
const project = (p = PROJECT, c = COMPANY_A) => company(c).collection('projects').doc(p)
const col = (name, p = PROJECT) => project(p).collection(name)
const data = (ref) => ref.get().then(s => (s.exists ? s.data() : null))
const claim = (id) => data(col('progressClaims').doc(id))
const invoice = (id) => data(col('supplierInvoices').doc(id))
const ledger = (id) => data(col('supplierInvoiceLedgers').doc(id))
const poLedger = (id) => data(col('poClaimLedgers').doc(id))
const audits = async () => (await company().collection('auditEvents').get()).docs.map(d => d.data().type).filter(t => /^(progress_claim|supplier_|retention_release|supplier_finance)/.test(t)).sort()

// ── ORACLE ───────────────────────────────────────────────────────────────────
const gstHalfUp = (centsNet) => (centsNet < 0 ? -Math.floor((-centsNet + 5) / 10) : Math.floor((centsNet + 5) / 10))
const share = (t, p, w) => (w <= 0 || p <= 0 || t <= 0 ? 0 : Number((2n * BigInt(t) * BigInt(p) + BigInt(w)) / (2n * BigInt(w))))
const $ = (cents) => cents / 100

const PO_LINES = [
  { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', qty: 10, unit: 'm3', unitPrice: 2500, lineTotal: 25000 },
  { costCodeId: 'cc4', costCodeName: '04-200 — Masonry', description: 'Blockwork', qty: 1, unit: 'item', unitPrice: 9000, lineTotal: 9000 },
]
const purchaseOrder = (status, o = {}) => ({ poNumber: 'PO-0001', status, supplierName: 'Steel Co', supplierId: 'contactS1', lineItems: PO_LINES, subtotal: 34000, gst: 3400, total: 37400, ...o })

const claimOp = (uid, operation, request) => H.progressClaimOperation(req(uid, { operation, request }))
const invoiceOp = (uid, operation, request) => H.supplierInvoiceOperation(req(uid, { operation, request }))
const settleOp = (uid, operation, request) => H.supplierSettlementOperation(req(uid, { operation, request }))

const createClaim = (uid, claimId, o = {}) => claimOp(uid, 'create', {
  projectId: PROJECT, claimId, poId: 'poSent', periodEnding: '2026-11-30', claimRef: 'C-1', notes: '', retention: 0,
  lines: [
    { poLineIndex: 0, variationId: null, variationLineIndex: null, claimedToDate: 10000.15 },
    { poLineIndex: 1, variationId: null, variationLineIndex: null, claimedToDate: 0 },
  ],
  ...o,
})
const approveClaim = (uid, claimId, expectedRevision, approvedAmounts, o = {}) => claimOp(uid, 'approve', { projectId: PROJECT, claimId, expectedRevision, approvedAmounts, assessmentNotes: '', ...o })

async function submitClaim(id) {
  // Submit stays a client Rules transition; here the Admin SDK stands in for
  // it (the Rules suite proves the client path).
  const c = await claim(id)
  await col('progressClaims').doc(id).update({ status: 'submitted', submittedAt: new Date(), submittedBy: 'u_qs', revision: c.revision + 1, updatedBy: 'u_qs' })
  return c.revision + 1
}

async function fresh({ enabled = true } = {}) {
  now = clock('2026-11-28T02:00:00Z')
  H = handlersMod.createSupplierFinanceHandlers({ db: A.db, now, log: silentLog, config: () => ({ enabled }), clock: () => Date.parse('2026-11-28T02:00:00Z') })
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
  await seedUser({ uid: 'u_other', email: 'admin@b.test', role: 'company_admin', companyId: COMPANY_B })
  await project().set({ name: 'Project A', status: 'active', currency: 'AUD' })
  await project('projectZ', COMPANY_B).set({ name: 'Other tenant', status: 'active' })
  await col('purchaseOrders').doc('poSent').set(purchaseOrder('sent'))
  await col('purchaseOrders').doc('poDraft').set(purchaseOrder('draft', { poNumber: 'PO-0002' }))
  await company().collection('contacts').doc('contactS1').set({ displayName: 'Steel Co', isActive: true, paymentTerms: { days: 30, basis: 'invoice' } })
}

beforeAll(async () => {
  A = await admin()
  handlersMod = await import('../../functions/src/supplierFinance/handlers.js')
})

beforeEach(async () => {
  await resetEmulators()
  await seedA()
  await fresh()
})

describe('Phase 2 company activation (final release batch)', () => {
  it('an INACTIVE company is refused before any baseline is written; TEST active while another company stays inactive', async () => {
    await activateCommercial(COMPANY_A, false)
    await expectTeamError(createClaim('u_qs', 'c1'), 'commercial-completion-not-activated')
    expect(await claim('c1')).toBeNull()
    expect((await col('supplierFinanceState').doc('baseline').get()).exists).toBe(false)
    expect((await col('poClaimLedgers').get()).size).toBe(0)
    await activateCommercial(COMPANY_A, true)
    expect((await createClaim('u_qs', 'c1')).alreadyApplied).toBe(false)
    expect((await col('supplierFinanceState').doc('baseline').get()).data().state).toBe('complete')
  })
  it('the global switch is the brake: switch off + active company is refused as disabled', async () => {
    await fresh({ enabled: false })
    await expectTeamError(createClaim('u_qs', 'c1'), 'supplier-finance-disabled')
  })
})

describe('the switch, the caller and the envelope', () => {
  it('fails closed while the switch is off; refuses unauthenticated, external roles, another tenant; refuses an unknown operation or an extra key', async () => {
    await fresh({ enabled: false })
    await expectTeamError(createClaim('u_qs', 'c1'), 'supplier-finance-disabled')
    await fresh()
    await expectTeamError(H.progressClaimOperation(req(null, { operation: 'create', request: {} })), 'unauthenticated')
    await expectTeamError(createClaim('u_sub', 'c1'), 'supplier-finance-forbidden')
    await expectTeamError(H.progressClaimOperation(req('u_qs', { operation: 'drop', request: {} })), 'invalid-argument')
    await expectTeamError(H.progressClaimOperation(req('u_qs', { operation: 'create', request: {}, extra: 1 })), 'invalid-argument')
    const request = { projectId: PROJECT, claimId: 'c1', poId: 'poSent', periodEnding: '', claimRef: '', notes: '', retention: 0, lines: [], claimedSubtotal: 5 }
    await expectTeamError(claimOp('u_qs', 'create', request), 'invalid-argument')
    // Another tenant's admin: the project is not found under THEIR company.
    await expectTeamError(createClaim('u_other', 'c1'), 'not-found')
    expect(await claim('c1')).toBeNull()
  })
})

describe('progress claims — created, edited, approved and rejected only by the backend', () => {
  it('a claim is derived exactly (version 2): previously approved from the PO ledger, period amounts, GST on the net, one open claim per PO', async () => {
    const out = await createClaim('u_qs', 'c1', { retention: 500.05 })
    expect(out).toMatchObject({ alreadyApplied: false, claimNumber: 'PC-0001' })
    const c = await claim('c1')
    // ORACLE: subtotal 10,000.15; retention 500.05; net 9,500.10; GST half-up of 950,010 tenths → 95,001 cents.
    const net = 1000015 - 50005
    expect(c).toMatchObject({
      status: 'draft', calcVersion: 2, revision: 1, poId: 'poSent', supplierId: 'contactS1', supplierInvoiceId: null,
      claimedSubtotal: $(1000015), retention: $(50005), claimedGst: $(gstHalfUp(net)), claimedTotal: $(net + gstHalfUp(net)),
    })
    expect(c.lineItems.map(l => [l.poLineIndex, l.costCodeId, l.previouslyApproved, l.claimedToDate, l.claimedThisPeriod, l.approvedThisPeriod]))
      .toEqual([[0, 'cc1', 0, 10000.15, 10000.15, null], [1, 'cc4', 0, 0, 0, null]])
    expect(await poLedger('poSent')).toMatchObject({ openClaimIds: ['c1'], state: 'established' })
    // One open claim per PO — now authoritative.
    await expectTeamError(createClaim('u_pm', 'c2'), 'supplier-finance-open-claim')
    // A repeat of the same create is recognised; somebody else's id is a conflict.
    expect(await createClaim('u_qs', 'c1')).toMatchObject({ alreadyApplied: true, claimNumber: 'PC-0001' })
    await expectTeamError(createClaim('u_pm', 'c1'), 'supplier-finance-id-conflict')
    expect(await audits()).toEqual(['progress_claim.created', 'supplier_finance.baseline_established'])
  })

  it('a claim against a draft PO, a missing PO line, PO lines out of order or a negative period are refused; nothing is written', async () => {
    await expectTeamError(createClaim('u_qs', 'x1', { poId: 'poDraft' }), 'supplier-finance-invalid')
    await expectTeamError(createClaim('u_qs', 'x2', { lines: [{ poLineIndex: 0, variationId: null, variationLineIndex: null, claimedToDate: 5 }] }), 'supplier-finance-invalid')
    await expectTeamError(createClaim('u_qs', 'x3', { lines: [
      { poLineIndex: 1, variationId: null, variationLineIndex: null, claimedToDate: 5 },
      { poLineIndex: 0, variationId: null, variationLineIndex: null, claimedToDate: 5 },
    ] }), 'supplier-finance-invalid')
    await expectTeamError(createClaim('u_qs', 'x4', { lines: [
      { poLineIndex: 0, variationId: null, variationLineIndex: null, claimedToDate: -5 },
      { poLineIndex: 1, variationId: null, variationLineIndex: null, claimedToDate: 0 },
    ] }), 'supplier-finance-invalid')
    expect((await col('progressClaims').get()).size).toBe(0)
  })

  it('TWO creates on one PO at once: exactly one claim, one number, one open claim', async () => {
    const results = await Promise.allSettled([createClaim('u_qs', 'r1'), createClaim('u_pm', 'r2')])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await col('progressClaims').get()).size).toBe(1)
    expect((await poLedger('poSent')).openClaimIds).toHaveLength(1)
  })

  it('draft edit re-derives from the ledger; stale and not-draft are refused; approval certifies under the claim’s version and moves the ledger', async () => {
    await createClaim('u_qs', 'c1')
    await claimOp('u_pm', 'update', { projectId: PROJECT, claimId: 'c1', expectedRevision: 1, periodEnding: '2026-11-30', claimRef: 'C-1b', notes: 'n', retention: 0, claimedToDate: [12000.25, 100] })
    await expectTeamError(claimOp('u_qs', 'update', { projectId: PROJECT, claimId: 'c1', expectedRevision: 1, periodEnding: '', claimRef: '', notes: '', retention: 0, claimedToDate: [1, 1] }), 'supplier-finance-stale')
    const rev = await submitClaim('c1')
    await expectTeamError(claimOp('u_qs', 'update', { projectId: PROJECT, claimId: 'c1', expectedRevision: rev, periodEnding: '', claimRef: '', notes: '', retention: 0, claimedToDate: [1, 1] }), 'supplier-finance-invalid')
    await expectTeamError(approveClaim('u_pm', 'c1', rev, [12000.26, 100]), 'supplier-finance-invalid')     // above the claimed amount
    await expectTeamError(approveClaim('u_pm', 'c1', rev - 1, [12000.25, 100]), 'supplier-finance-stale')
    await approveClaim('u_pm', 'c1', rev, [12000.25, 50])
    const c = await claim('c1')
    // ORACLE: approved subtotal 12,050.25; GST 1,205.03 (half-up of 1,205,025 tenths); total 13,255.28
    expect(c).toMatchObject({ status: 'approved', approvedSubtotal: 12050.25, approvedGst: $(gstHalfUp(1205025)), approvedTotal: $(1205025 + gstHalfUp(1205025)), supplierInvoiceId: null, approvedBy: 'u_pm' })
    expect(await poLedger('poSent')).toMatchObject({ openClaimIds: [], approvedPoLineCents: { 0: 1200025, 1: 5000 } })
    // A repeat of the same approval is recognised.
    expect(await approveClaim('u_pm', 'c1', rev, [12000.25, 50])).toMatchObject({ alreadyApplied: true })
    // The NEXT claim's previously-approved comes from the ledger.
    await createClaim('u_qs', 'c2', { lines: [
      { poLineIndex: 0, variationId: null, variationLineIndex: null, claimedToDate: 20000 },
      { poLineIndex: 1, variationId: null, variationLineIndex: null, claimedToDate: 50 },
    ] })
    const c2 = await claim('c2')
    expect(c2.lineItems.map(l => [l.previouslyApproved, l.claimedThisPeriod])).toEqual([[12000.25, 7999.75], [50, 0]])
  })

  it('reject closes the claim and frees the PO; the reject of an already-rejected claim is recognised', async () => {
    await createClaim('u_qs', 'c1')
    await claimOp('u_pm', 'reject', { projectId: PROJECT, claimId: 'c1', expectedRevision: 1, assessmentNotes: 'Wrong period' })
    expect(await claim('c1')).toMatchObject({ status: 'rejected', rejectedBy: 'u_pm', assessmentNotes: 'Wrong period', revision: 2 })
    expect((await poLedger('poSent')).openClaimIds).toEqual([])
    expect(await claimOp('u_pm', 'reject', { projectId: PROJECT, claimId: 'c1', expectedRevision: 1, assessmentNotes: '' })).toMatchObject({ alreadyApplied: true })
    expect((await createClaim('u_qs', 'c2')).claimNumber).toBe('PC-0002')
  })
})

describe('legacy claims — historical facts kept; forged content never certified', () => {
  const legacyClaim = (o = {}) => ({
    claimNumber: 'PC-0900', status: 'submitted', poId: 'poSent', poNumber: 'PO-0001', supplierName: 'Steel Co', supplierId: 'contactS1',
    claimRef: '', periodEnding: '', variationId: null, variationLineCount: 0, currency: 'AUD', revision: 2,
    lineItems: [
      { poLineIndex: 0, poLineTotal: 25000, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', previouslyApproved: 0, claimedToDate: 40.15, claimedThisPeriod: 40.15, approvedThisPeriod: null },
      { poLineIndex: 1, poLineTotal: 9000, costCodeId: 'cc4', costCodeName: '04-200 — Masonry', description: 'Blockwork', previouslyApproved: 0, claimedToDate: 0, claimedThisPeriod: 0, approvedThisPeriod: null },
    ],
    retention: 0, claimedSubtotal: 40.15, claimedGst: 4.01, claimedTotal: 44.16,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null, notes: '', assessmentNotes: '',
    createdBy: 'u_qs', updatedBy: 'u_qs', submittedBy: 'u_qs',
    ...o,
  })

  it('a legitimate legacy submitted claim is certified with the LEGACY calculation (40.15 → GST 4.01), never recalculated', async () => {
    await col('progressClaims').doc('L1').set(legacyClaim())
    await approveClaim('u_pm', 'L1', 2, [40.15, 0])
    const c = await claim('L1')
    expect(c).toMatchObject({ status: 'approved', approvedSubtotal: 40.15, approvedGst: 4.01, approvedTotal: 44.16 })
    expect('calcVersion' in c).toBe(false)
  })

  it('forged legacy content is refused at approval: header, period amount, previously-approved, cost code, a certified figure planted on a submitted line', async () => {
    const lines = legacyClaim().lineItems
    const forged = {
      header: legacyClaim({ claimedSubtotal: 5000, claimedGst: 500, claimedTotal: 5500 }),
      period: legacyClaim({ lineItems: [{ ...lines[0], claimedThisPeriod: 400.15 }, lines[1]] }),
      prev: legacyClaim({ lineItems: [{ ...lines[0], previouslyApproved: -1000, claimedThisPeriod: 1040.15, claimedToDate: 40.15 }, lines[1]] }),
      costCode: legacyClaim({ lineItems: [{ ...lines[0], costCodeId: 'cc4' }, lines[1]] }),
      planted: legacyClaim({ lineItems: [{ ...lines[0], approvedThisPeriod: 99999 }, lines[1]] }),
      missingLine: legacyClaim({ lineItems: [lines[0]] }),
    }
    for (const [name, doc] of Object.entries(forged)) {
      await col('progressClaims').doc(name).set(doc)
      const before = await claim(name)
      await expectTeamError(approveClaim('u_pm', name, 2, doc.lineItems.map(() => 0)), 'supplier-finance-figures-inconsistent')
      expect(await claim(name), name).toEqual(before)
    }
  })
})

describe('supplier invoices — pairing, verification and posting', () => {
  async function approvedClaim(id = 'c1', amounts = [10000.15, 0], o = {}) {
    await createClaim('u_qs', id, o)
    const rev = await submitClaim(id)
    await approveClaim('u_pm', id, rev, amounts)
    return (await claim(id)).revision
  }
  const createFromClaim = (uid, invoiceId, claimId, expectedSourceRevision, taxCodes = ['gst']) => invoiceOp(uid, 'create', {
    projectId: PROJECT, invoiceId, source: 'progress_claim', sourceId: claimId, expectedSourceRevision,
    supplierInvoiceNumber: 'INV-1', invoiceDate: '2026-11-28', receivedDate: '', dueDate: '', notes: '', retention: null,
    lines: taxCodes.map((taxCode, lineIndex) => ({ lineIndex, amount: null, taxCode })),
  })
  const transition = (uid, operation, invoiceId, expectedRevision) => invoiceOp(uid, operation, { projectId: PROJECT, invoiceId, expectedRevision })

  it('a claim-sourced invoice pays exactly the certified claim; the claim links it; a second invoice for the claim is refused, also when both race', async () => {
    const rev = await approvedClaim('c1', [10000.15, 0], { retention: 1000 })
    const results = await Promise.allSettled([createFromClaim('u_qs', 'i1', 'c1', rev), createFromClaim('u_pm', 'i2', 'c1', rev)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const winner = (await invoice('i1')) ? 'i1' : 'i2'
    const inv = await invoice(winner)
    const c = await claim('c1')
    expect(c.supplierInvoiceId).toBe(winner)
    // ORACLE: approved 10,000.15, retention 1,000.00 → net 9,000.15, certified GST 900.02 (half-up of 900,015 tenths);
    // the invoice's retention GST is 100.00 and its line GST the certified GST + retention GST.
    const certified = gstHalfUp(900015)
    expect(inv).toMatchObject({ calcVersion: 2, sourceCalcVersion: 2, retention: 1000, retentionGst: 100, payableGst: $(certified), payableTotal: $(900015 + certified), gstTotal: $(certified + 10000), paymentTerms: { days: 30, basis: 'invoice' } })
    expect(inv.lineItems).toHaveLength(1)
    await expectTeamError(createFromClaim('u_qs', 'i3', 'c1', c.revision), 'supplier-finance-already-invoiced')
  })

  it('approve → post: verified under the invoice’s version; a forged stored figure is refused; posting requires the claim to link the invoice', async () => {
    const rev = await approvedClaim()
    await createFromClaim('u_qs', 'i1', 'c1', rev)
    await col('supplierInvoices').doc('i1').update({ payableTotal: 1 })
    await expectTeamError(transition('u_pm', 'approve', 'i1', 1), 'supplier-finance-figures-inconsistent')
    const good = await invoice('i1')
    await col('supplierInvoices').doc('i1').update({ payableTotal: Math.round((good.grossTotal - good.retentionTotal) * 100) / 100 })
    await transition('u_pm', 'approve', 'i1', 1)
    // Unlink the claim behind the backend's back (a legacy-state stand-in): posting is refused.
    await col('progressClaims').doc('c1').update({ supplierInvoiceId: null })
    await expectTeamError(transition('u_pm', 'post', 'i1', 2), 'supplier-finance-not-linked')
    await col('progressClaims').doc('c1').update({ supplierInvoiceId: 'i1' })
    await transition('u_pm', 'post', 'i1', 2)
    expect(await invoice('i1')).toMatchObject({ status: 'posted', postedBy: 'u_pm', revision: 3 })
  })

  it('cancelling a claim-sourced invoice unlinks its claim in the same commit, so the claim can be invoiced again', async () => {
    const rev = await approvedClaim()
    await createFromClaim('u_qs', 'i1', 'c1', rev)
    await transition('u_pm', 'cancel', 'i1', 1)
    expect(await invoice('i1')).toMatchObject({ status: 'cancelled' })
    const c = await claim('c1')
    expect(c.supplierInvoiceId).toBeNull()
    expect((await createFromClaim('u_qs', 'i2', 'c1', c.revision)).alreadyApplied).toBe(false)
  })

  it('a direct invoice is exact (40.15 → 4.02), priced lines only, edited by the backend (re-derived), stale edits refused', async () => {
    const out = await invoiceOp('u_qs', 'create', {
      projectId: PROJECT, invoiceId: 'd1', source: 'direct_po', sourceId: 'poSent', expectedSourceRevision: null,
      supplierInvoiceNumber: 'INV-9', invoiceDate: '2026-11-28', receivedDate: '', dueDate: '', notes: '', retention: 0,
      lines: [{ lineIndex: 0, amount: 40.15, taxCode: 'gst' }, { lineIndex: 1, amount: 0, taxCode: 'gst' }],
    })
    expect(out.invoiceNumber).toBe('SI-0001')
    expect(await invoice('d1')).toMatchObject({ subtotal: 40.15, gstTotal: 4.02, payableTotal: 44.17, calcVersion: 2, sourceCalcVersion: null })
    await invoiceOp('u_pm', 'update', { projectId: PROJECT, invoiceId: 'd1', expectedRevision: 1, supplierInvoiceNumber: 'INV-9', invoiceDate: '2026-11-28', receivedDate: '', dueDate: '', notes: 'x', retention: 0, lines: [{ lineIndex: 0, amount: 80.25, taxCode: 'gst' }] })
    expect(await invoice('d1')).toMatchObject({ subtotal: 80.25, gstTotal: 8.03, revision: 2 })
    await expectTeamError(invoiceOp('u_qs', 'update', { projectId: PROJECT, invoiceId: 'd1', expectedRevision: 1, supplierInvoiceNumber: 'INV-9', invoiceDate: '2026-11-28', receivedDate: '', dueDate: '', notes: '', retention: 0, lines: [{ lineIndex: 0, amount: 1, taxCode: 'gst' }] }), 'supplier-finance-stale')
  })
})

describe('supplier settlement — ledgers, caps (G1, G2, DC18) and dependency-safe voids (G3)', () => {
  // A posted retained invoice seeded as history: S 10,000.00 G 1,000.00, retention 500.00 + 50.00, payable 10,450.00.
  async function postedRetainedInvoice(id = 'inv1') {
    await col('supplierInvoices').doc(id).set({
      invoiceNumber: 'SI-0100', status: 'posted', source: 'direct_po', poId: 'poSent', supplierId: 'contactS1', supplierName: 'Steel Co',
      lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: '', amount: 10000, taxCode: 'gst', gstAmount: 1000 }],
      subtotal: 10000, gstTotal: 1000, grossTotal: 11000, retention: 500, retentionGst: 50, retentionTotal: 550,
      net: 9500, payableGst: 950, payableTotal: 10450, currency: 'AUD', revision: 3, createdBy: 'u_qs',
    })
  }
  const saveCredit = (uid, id, amount, expectedRevision = null) => settleOp(uid, 'saveCredit', {
    projectId: PROJECT, creditNoteId: id, expectedRevision, supplierInvoiceId: 'inv1', supplierCreditReference: 'CN-1', creditDate: '2026-11-28', reason: 'Defect', notes: '',
    lines: [{ costCodeId: 'cc1', taxCode: 'gst', description: 'Defective slab', amount }],
  })
  const saveRelease = (uid, id, amount, expectedRevision = null) => settleOp(uid, 'saveRelease', { projectId: PROJECT, releaseId: id, expectedRevision, supplierInvoiceId: 'inv1', amount, releaseDate: '2026-11-28', reason: 'PC', notes: '' })
  const savePayment = (uid, id, allocations, amount, expectedRevision = null) => settleOp(uid, 'savePayment', {
    projectId: PROJECT, paymentId: id, expectedRevision, supplierId: 'contactS1', paymentDate: '2026-11-28', amount, paymentMethod: PAYMENT_METHOD, paymentMethodOther: '',
    bankReference: '', remittanceReference: '', externalReference: '', notes: '', allocations,
  })
  const post = (uid, op, documentId, expectedRevision = 1) => settleOp(uid, op, { projectId: PROJECT, documentId, expectedRevision })
  const voidDoc = (uid, op, documentId, expectedRevision = 2) => settleOp(uid, op, { projectId: PROJECT, documentId, expectedRevision, voidReason: 'Recorded in error' })

  it('a credit on a RETAINED invoice (G1) takes its retained share; the payable basis falls only by the rest; the ledger records it', async () => {
    await postedRetainedInvoice()
    await saveCredit('u_qs', 'cn1', 2000)
    const draft = await data(col('supplierCreditNotes').doc('cn1'))
    // ORACLE: retention part share(50,000, 200,000, 1,000,000) = 10,000; its GST share(5,000, 10,000, 50,000) = 1,000; line GST share(100,000, 200,000, 1,000,000) = 20,000.
    expect(draft).toMatchObject({ status: 'draft', subtotal: 2000, gstTotal: $(share(100000, 200000, 1000000)), retentionAmount: $(share(50000, 200000, 1000000)), retentionGst: $(share(5000, 10000, 50000)), calcVersion: 2, sourceCalcVersion: null })
    await post('u_pm', 'postCredit', 'cn1')
    expect(await ledger('inv1')).toMatchObject({ creditedSubtotalCents: 200000, creditedGstCents: 20000, creditedRetentionCents: 10000, creditedRetentionGstCents: 1000, state: 'established' })
    expect(await audits()).toContain('supplier_credit_note.posted')
  })

  it('payments: an allocation beyond what remains payable is refused (DC18); a release raises the basis; a release that payments depend on cannot be voided until they are (G3)', async () => {
    await postedRetainedInvoice()
    await expectTeamError(savePayment('u_qs', 'p1', [{ supplierInvoiceId: 'inv1', allocatedAmount: 10450.01 }], 10450.01), 'supplier-finance-cap-exceeded')
    await savePayment('u_qs', 'p1', [{ supplierInvoiceId: 'inv1', allocatedAmount: 10450 }], 11000)
    expect(await data(col('supplierPayments').doc('p1'))).toMatchObject({ allocatedTotal: 10450, unallocatedAmount: 550, paymentNumber: 'SP-0001' })
    await post('u_pm', 'postPayment', 'p1')
    expect((await ledger('inv1')).paidCents).toBe(1045000)
    await saveRelease('u_qs', 'r1', 100)
    await post('u_pm', 'postRelease', 'r1')
    await savePayment('u_qs', 'p2', [{ supplierInvoiceId: 'inv1', allocatedAmount: 110 }], 110)
    await post('u_pm', 'postPayment', 'p2')
    await expectTeamError(voidDoc('u_pm', 'voidRelease', 'r1'), 'supplier-finance-dependency')
    await voidDoc('u_pm', 'voidPayment', 'p2')
    await voidDoc('u_pm', 'voidRelease', 'r1')
    expect(await ledger('inv1')).toMatchObject({ paidCents: 1045000, releasedRetentionCents: 0, releasedRetentionGstCents: 0 })
  })

  it('two payments racing for the last dollar payable: exactly one posts', async () => {
    await postedRetainedInvoice()
    await savePayment('u_qs', 'p1', [{ supplierInvoiceId: 'inv1', allocatedAmount: 10000 }], 10000)
    await savePayment('u_qs', 'p2', [{ supplierInvoiceId: 'inv1', allocatedAmount: 10000 }], 10000)
    const results = await Promise.allSettled([post('u_pm', 'postPayment', 'p1'), post('u_admin', 'postPayment', 'p2')])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await ledger('inv1')).paidCents).toBe(1000000)
  })

  it('a draft whose figures moved since it was saved is not posted until it is saved again', async () => {
    await postedRetainedInvoice()
    // ORACLE: 3,333.33 alone takes GST share(100,000, 333,333, 1,000,000) = 33,333; after an identical
    // credit is posted the second takes share(100,000, 666,666, 1,000,000) − 33,333 = 33,334 — one cent more.
    await saveCredit('u_qs', 'cn1', 3333.33)
    await saveCredit('u_qs', 'cn2', 3333.33)
    expect((await data(col('supplierCreditNotes').doc('cn2'))).gstTotal).toBe($(share(100000, 333333, 1000000)))
    await post('u_pm', 'postCredit', 'cn1')
    await expectTeamError(post('u_pm', 'postCredit', 'cn2'), 'supplier-finance-figures-moved')
    await saveCredit('u_qs', 'cn2', 3333.33, 1)
    expect((await data(col('supplierCreditNotes').doc('cn2'))).gstTotal).toBe($(share(100000, 666666, 1000000) - share(100000, 333333, 1000000)))
    await post('u_pm', 'postCredit', 'cn2', 2)
    const L = await ledger('inv1')
    expect(L.creditedSubtotalCents).toBe(666666)
    expect(L.creditedGstCents).toBe(share(100000, 666666, 1000000))
  })

  it('the historical baseline: legacy postings are in the ledger before the first operation; an over-released invoice is inconsistent and refuses postings, a corrective void brings it back', async () => {
    await postedRetainedInvoice()
    await col('retentionReleases').doc('h1').set({ releaseNumber: 'RR-0001', status: 'posted', supplierInvoiceId: 'inv1', amount: 300, gstAmount: 30, releaseTotal: 330, revision: 2 })
    await col('retentionReleases').doc('h2').set({ releaseNumber: 'RR-0002', status: 'posted', supplierInvoiceId: 'inv1', amount: 300, gstAmount: 30, releaseTotal: 330, revision: 2 })
    await col('supplierPayments').doc('hp').set({ paymentNumber: 'SP-0001', status: 'posted', supplierId: 'contactS1', allocations: [{ supplierInvoiceId: 'inv1', allocatedAmount: 1000 }], amount: 1000 })
    await expectTeamError(saveRelease('u_qs', 'r9', 1), 'supplier-finance-ledger-inconsistent')
    const L = await ledger('inv1')
    expect(L).toMatchObject({ state: 'inconsistent', releasedRetentionCents: 60000, paidCents: 100000 })
    expect(L.problem).toMatch(/exceed the retention withheld/)
    await voidDoc('u_pm', 'voidRelease', 'h2')
    expect(await ledger('inv1')).toMatchObject({ state: 'established', problem: null, releasedRetentionCents: 30000 })
  })
})

describe('step 3–4 acceptance — legacy sources, mixed tax, replays, boundaries and downstream parity', () => {
  const legacyApprovedClaim = (o = {}) => ({
    claimNumber: 'PC-0800', status: 'approved', poId: 'poSent', poNumber: 'PO-0001', supplierName: 'Steel Co', supplierId: 'contactS1',
    claimRef: '', periodEnding: '', variationId: null, variationLineCount: 0, currency: 'AUD', revision: 3,
    lineItems: [
      { poLineIndex: 0, poLineTotal: 25000, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', previouslyApproved: 0, claimedToDate: 40.15, claimedThisPeriod: 40.15, approvedThisPeriod: 40.15 },
      { poLineIndex: 1, poLineTotal: 9000, costCodeId: 'cc4', costCodeName: '04-200 — Masonry', description: 'Blockwork', previouslyApproved: 0, claimedToDate: 20, claimedThisPeriod: 20, approvedThisPeriod: 20 },
    ],
    retention: 0, claimedSubtotal: 60.15, claimedGst: 6.01, claimedTotal: 66.16,
    approvedSubtotal: 60.15, approvedGst: 6.01, approvedTotal: 66.16, notes: '', assessmentNotes: '',
    supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null,
    createdBy: 'u_qs', updatedBy: 'u_pm', approvedBy: 'u_pm', ...o,
  })
  const fromClaim = (uid, invoiceId, claimId, rev, taxCodes) => invoiceOp(uid, 'create', {
    projectId: PROJECT, invoiceId, source: 'progress_claim', sourceId: claimId, expectedSourceRevision: rev,
    supplierInvoiceNumber: 'INV-L', invoiceDate: '2026-11-28', receivedDate: '', dueDate: '', notes: '', retention: null,
    lines: taxCodes.map((taxCode, lineIndex) => ({ lineIndex, amount: null, taxCode })),
  })

  it('an invoice derived from a LEGACY approved claim keeps the claim’s stored obligation (66.16, GST 6.01) and the legacy policy', async () => {
    await col('progressClaims').doc('L1').set(legacyApprovedClaim())
    await fromClaim('u_qs', 'iL', 'L1', 3, ['gst', 'gst'])
    const inv = await invoice('iL')
    expect(inv).toMatchObject({ calcVersion: 1, sourceCalcVersion: null, payableGst: 6.01, payableTotal: 66.16, subtotal: 60.15 })
    // The certified 6.01 is apportioned — never recomputed to 6.02.
    expect(Math.round(inv.lineItems.reduce((s, l) => s + l.gstAmount, 0) * 100)).toBe(601)
    await invoiceOp('u_pm', 'approve', { projectId: PROJECT, invoiceId: 'iL', expectedRevision: 1 })
    await invoiceOp('u_pm', 'post', { projectId: PROJECT, invoiceId: 'iL', expectedRevision: 2 })
    expect((await invoice('iL')).status).toBe('posted')
  })

  it('MIXED TAX: a GST-free certified line carries no GST; the certified GST falls on the taxable line', async () => {
    await col('progressClaims').doc('L1').set(legacyApprovedClaim({ approvedGst: 4.01, approvedTotal: 64.16, claimedGst: 4.01, claimedTotal: 64.16 }))
    await fromClaim('u_qs', 'iM', 'L1', 3, ['gst', 'gst_free'])
    const inv = await invoice('iM')
    expect(inv.lineItems.map(l => [l.taxCode, l.gstAmount])).toEqual([['gst', 4.01], ['gst_free', 0]])
    expect(inv).toMatchObject({ payableGst: 4.01, payableTotal: 64.16 })
  })

  it('a legacy claim with NO link keys is not invoiced through the pairing (it must be reconciled first)', async () => {
    const c = legacyApprovedClaim()
    delete c.supplierInvoiceId
    delete c.supplierInvoiceLinkedAt
    delete c.supplierInvoiceLinkedBy
    await col('progressClaims').doc('L2').set(c)
    await expectTeamError(fromClaim('u_qs', 'iX', 'L2', 3, ['gst', 'gst']), 'supplier-finance-legacy-claim')
  })

  it('REPLAY: posting a payment twice (a lost response) moves the ledger once and writes one audit event', async () => {
    await col('supplierInvoices').doc('inv1').set({
      invoiceNumber: 'SI-0100', status: 'posted', source: 'direct_po', poId: 'poSent', supplierId: 'contactS1', supplierName: 'Steel Co',
      lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: 'C', description: '', amount: 100, taxCode: 'gst', gstAmount: 10 }],
      subtotal: 100, gstTotal: 10, grossTotal: 110, retention: 0, retentionGst: 0, retentionTotal: 0, net: 100, payableGst: 10, payableTotal: 110, currency: 'AUD', revision: 3,
    })
    await settleOp('u_qs', 'savePayment', { projectId: PROJECT, paymentId: 'p1', expectedRevision: null, supplierId: 'contactS1', paymentDate: '2026-11-28', amount: 110, paymentMethod: PAYMENT_METHOD, paymentMethodOther: '', bankReference: '', remittanceReference: '', externalReference: '', notes: '', allocations: [{ supplierInvoiceId: 'inv1', allocatedAmount: 110 }] })
    const post = () => settleOp('u_pm', 'postPayment', { projectId: PROJECT, documentId: 'p1', expectedRevision: 1 })
    expect((await post()).alreadyApplied).toBe(false)
    expect((await post()).alreadyApplied).toBe(true)
    expect((await ledger('inv1')).paidCents).toBe(11000)
    expect((await audits()).filter(t => t === 'supplier_payment.posted')).toHaveLength(1)
    // Another user repeating it is stale, not a repeat.
    await expectTeamError(settleOp('u_admin', 'postPayment', { projectId: PROJECT, documentId: 'p1', expectedRevision: 1 }), 'supplier-finance-invalid')
  })

  it('INVALID SOURCES: a credit on a draft invoice, a release on an invoice without retention, a payment to another supplier’s invoice are refused', async () => {
    const base = { status: 'posted', source: 'direct_po', poId: 'poSent', supplierName: 'Steel Co', lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: 'C', description: '', amount: 100, taxCode: 'gst', gstAmount: 10 }],
      subtotal: 100, gstTotal: 10, grossTotal: 110, retention: 0, retentionGst: 0, retentionTotal: 0, net: 100, payableGst: 10, payableTotal: 110, currency: 'AUD', revision: 1 }
    await col('supplierInvoices').doc('draftInv').set({ ...base, invoiceNumber: 'SI-1', status: 'draft', supplierId: 'contactS1' })
    await col('supplierInvoices').doc('plain').set({ ...base, invoiceNumber: 'SI-2', supplierId: 'contactS1' })
    await col('supplierInvoices').doc('otherSupplier').set({ ...base, invoiceNumber: 'SI-3', supplierId: 'contactS2', supplierName: 'Other' })
    await expectTeamError(settleOp('u_qs', 'saveCredit', { projectId: PROJECT, creditNoteId: 'cx', expectedRevision: null, supplierInvoiceId: 'draftInv', supplierCreditReference: '', creditDate: '2026-11-28', reason: 'x', notes: '', lines: [{ costCodeId: 'cc1', taxCode: 'gst', description: 'x', amount: 1 }] }), 'supplier-finance-invalid')
    await expectTeamError(settleOp('u_qs', 'saveRelease', { projectId: PROJECT, releaseId: 'rx', expectedRevision: null, supplierInvoiceId: 'plain', amount: 1, releaseDate: '2026-11-28', reason: 'x', notes: '' }), 'supplier-finance-invalid')
    await expectTeamError(settleOp('u_qs', 'savePayment', { projectId: PROJECT, paymentId: 'px', expectedRevision: null, supplierId: 'contactS1', paymentDate: '2026-11-28', amount: 10, paymentMethod: PAYMENT_METHOD, paymentMethodOther: '', bankReference: '', remittanceReference: '', externalReference: '', notes: '', allocations: [{ supplierInvoiceId: 'otherSupplier', allocatedAmount: 10 }] }), 'supplier-finance-invalid')
    expect((await col('supplierCreditNotes').get()).size + (await col('retentionReleases').get()).size + (await col('supplierPayments').get()).size).toBe(0)
  })

  it('a FUTURE-DATED payment is saved as a draft but not posted', async () => {
    await col('supplierInvoices').doc('inv1').set({
      invoiceNumber: 'SI-0100', status: 'posted', source: 'direct_po', poId: 'poSent', supplierId: 'contactS1', supplierName: 'Steel Co',
      lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: 'C', description: '', amount: 100, taxCode: 'gst', gstAmount: 10 }],
      subtotal: 100, gstTotal: 10, grossTotal: 110, retention: 0, retentionGst: 0, retentionTotal: 0, net: 100, payableGst: 10, payableTotal: 110, currency: 'AUD', revision: 3,
    })
    await settleOp('u_qs', 'savePayment', { projectId: PROJECT, paymentId: 'pf', expectedRevision: null, supplierId: 'contactS1', paymentDate: '2026-12-31', amount: 10, paymentMethod: PAYMENT_METHOD, paymentMethodOther: '', bankReference: '', remittanceReference: '', externalReference: '', notes: '', allocations: [{ supplierInvoiceId: 'inv1', allocatedAmount: 10 }] })
    await expectTeamError(settleOp('u_pm', 'postPayment', { projectId: PROJECT, documentId: 'pf', expectedRevision: 1 }), 'supplier-finance-future-dated')
  })

  it('MEMBERSHIP: a member deactivated before the call is refused (the membership is read inside the transaction); another tenant’s admin never finds the project', async () => {
    await createClaim('u_qs', 'c1')
    await A.db.collection('users').doc('u_pm').update({ status: 'deactivated', companyId: null, role: null })
    await expectTeamError(claimOp('u_pm', 'reject', { projectId: PROJECT, claimId: 'c1', expectedRevision: 1, assessmentNotes: '' }), 'membership-inactive')
    await expectTeamError(settleOp('u_other', 'postPayment', { projectId: PROJECT, documentId: 'x', expectedRevision: 1 }), 'not-found')
    await expectTeamError(invoiceOp('u_other', 'approve', { projectId: PROJECT, invoiceId: 'x', expectedRevision: 1 }), 'not-found')
    expect((await claim('c1')).status).toBe('draft')
  })

  it('DOWNSTREAM PARITY: after a credit (retained), a release and a payment, the read-time selectors the pages use agree with the ledger to the cent', async () => {
    const { supplierInvoiceReconciliationRows } = await import('../../src/lib/supplierPayments')
    const { retentionInvoiceRows } = await import('../../src/lib/retention')
    await col('supplierInvoices').doc('inv1').set({
      invoiceNumber: 'SI-0100', status: 'posted', source: 'direct_po', poId: 'poSent', supplierId: 'contactS1', supplierName: 'Steel Co',
      lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: 'C', description: '', amount: 10000, taxCode: 'gst', gstAmount: 1000 }],
      subtotal: 10000, gstTotal: 1000, grossTotal: 11000, retention: 500, retentionGst: 50, retentionTotal: 550, net: 9500, payableGst: 950, payableTotal: 10450, currency: 'AUD', revision: 3,
    })
    await settleOp('u_qs', 'saveCredit', { projectId: PROJECT, creditNoteId: 'cn1', expectedRevision: null, supplierInvoiceId: 'inv1', supplierCreditReference: '', creditDate: '2026-11-28', reason: 'Defect', notes: '', lines: [{ costCodeId: 'cc1', taxCode: 'gst', description: 'x', amount: 1234.56 }] })
    await settleOp('u_pm', 'postCredit', { projectId: PROJECT, documentId: 'cn1', expectedRevision: 1 })
    await settleOp('u_qs', 'saveRelease', { projectId: PROJECT, releaseId: 'r1', expectedRevision: null, supplierInvoiceId: 'inv1', amount: 100.01, releaseDate: '2026-11-28', reason: 'PC', notes: '' })
    await settleOp('u_pm', 'postRelease', { projectId: PROJECT, documentId: 'r1', expectedRevision: 1 })
    await settleOp('u_qs', 'savePayment', { projectId: PROJECT, paymentId: 'p1', expectedRevision: null, supplierId: 'contactS1', paymentDate: '2026-11-28', amount: 5000, paymentMethod: PAYMENT_METHOD, paymentMethodOther: '', bankReference: '', remittanceReference: '', externalReference: '', notes: '', allocations: [{ supplierInvoiceId: 'inv1', allocatedAmount: 5000 }] })
    await settleOp('u_pm', 'postPayment', { projectId: PROJECT, documentId: 'p1', expectedRevision: 1 })
    const docs = async (name) => (await col(name).get()).docs.map(d => ({ id: d.id, ...d.data() }))
    const [invoices, credits, releases, payments] = await Promise.all([docs('supplierInvoices'), docs('supplierCreditNotes'), docs('retentionReleases'), docs('supplierPayments')])
    const L = await ledger('inv1')
    const releasedGross = releases.reduce((s, r) => s + r.releaseTotal, 0)
    const row = supplierInvoiceReconciliationRows(invoices, payments, credits, { inv1: releasedGross })[0]
    // ORACLE from the ledger's own integers.
    const basis = 1045000 + L.releasedRetentionCents + L.releasedRetentionGstCents - (L.creditedSubtotalCents + L.creditedGstCents - L.creditedRetentionCents - L.creditedRetentionGstCents)
    expect(Math.round(row.payableTotal * 100) - Math.round(row.credited * 100)).toBe(basis)
    expect(Math.round(row.remaining * 100)).toBe(basis - L.paidCents)
    const heldGross = 55000 - L.releasedRetentionCents - L.releasedRetentionGstCents - L.creditedRetentionCents - L.creditedRetentionGstCents
    expect(Math.round(row.retentionHeld * 100)).toBe(heldGross)
    expect(Math.round(retentionInvoiceRows(invoices, releases, credits)[0].retentionHeld * 100)).toBe(heldGross)
  })
})
