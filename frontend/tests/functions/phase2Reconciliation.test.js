import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { admin, resetEmulators, seedCompany, activateCommercial, seedUser, req, expectTeamError, clock, silentLog, COMPANY_A } from './_harness.js'

// ── Phase 2 — ONE supplier lifecycle, reconciled to the cent (final batch, 2C) ─
//
// PO → claim (with retention) → claim-sourced invoice → credit on the retained
// invoice → retention release → payment with an unallocated part → refused and
// permitted voids — through the trusted callables, then the read-time
// selectors the pages use (Forecast actual / remaining committed, the payment
// reconciliation, the retention register, Cash Flow cash out).
//
// EVERY expected figure below is written out by hand, in cents, with its
// arithmetic — nothing is computed by the modules under test. Rounding rules
// used: GST = 10 % half-up on whole cents; a share = round-half-up(total × part
// ÷ whole) (ADR-91).

const PROJECT = 'projectA'
let A, handlersMod, H

const company = () => A.db.collection('companies').doc(COMPANY_A)
const col = (name) => company().collection('projects').doc(PROJECT).collection(name)
const data = (ref) => ref.get().then(s => (s.exists ? s.data() : null))
const docs = async (name) => (await col(name).get()).docs.map(d => ({ id: d.id, ...d.data() }))
const cents = (v) => Math.round(v * 100)

const claimOp = (uid, operation, request) => H.progressClaimOperation(req(uid, { operation, request }))
const invoiceOp = (uid, operation, request) => H.supplierInvoiceOperation(req(uid, { operation, request }))
const settleOp = (uid, operation, request) => H.supplierSettlementOperation(req(uid, { operation, request }))
const post = (uid, operation, documentId, expectedRevision = 1) => settleOp(uid, operation, { projectId: PROJECT, documentId, expectedRevision })
const voidDoc = (uid, operation, documentId, expectedRevision) => settleOp(uid, operation, { projectId: PROJECT, documentId, expectedRevision, voidReason: 'Recorded in error' })
const savePayment = (id, allocatedAmount, amount) => settleOp('u_qs', 'savePayment', {
  projectId: PROJECT, paymentId: id, expectedRevision: null, supplierId: 's1', paymentDate: '2026-11-28', amount, paymentMethod: 'bank_transfer',
  paymentMethodOther: '', bankReference: 'BR-1', remittanceReference: '', externalReference: '', notes: '', allocations: [{ supplierInvoiceId: 'inv1', allocatedAmount }],
})

// The figures, in cents — the reviewed oracle.
const O = {
  poLine0: 2500000,                 // 10 m3 × 2,500.00
  claimed: 100015,                  // 1,000.15 claimed to date on line 0
  retention: 10000,                 // 100.00 withheld on the claim
  net: 90015,                       // 1,000.15 − 100.00
  claimGst: 9002,                   // 10 % of 900.15 = 90.015 → half-up 90.02
  claimTotal: 99017,                // 900.15 + 90.02
  invRetentionGst: 1000,            // 10 % of 100.00
  invGst: 10002,                    // certified 90.02 + retention GST 10.00
  invGross: 110017,                 // 1,000.15 + 100.02
  invPayable: 99017,                // 1,100.17 − 100.00 − 10.00  (= the certified total)
  creditEx: 20000,                  // credit 200.00 on cost code cc1 / gst
  creditGst: 2000,                  // share(10,002, 20,000, 100,015) = 2,000.10 → 2,000
  creditRet: 2000,                  // share(10,000, 20,000, 100,015) = 1,999.70 → 2,000 (retention held × credit ÷ still billed)
  creditRetGst: 200,                // share(1,000, 2,000, 10,000) = 200
  releaseEx: 5000,                  // release 50.00
  releaseGst: 500,                  // share(1,000, 2,000 + 5,000, 10,000) − 200 = 700 − 200
}
O.creditPayable = O.creditEx + O.creditGst - O.creditRet - O.creditRetGst   // 22,000 − 2,200 = 19,800
O.basisAfterCredit = O.invPayable - O.creditPayable                       // 99,017 − 19,800 = 79,217
O.basisAfterRelease = O.basisAfterCredit + O.releaseEx + O.releaseGst      // 79,217 + 5,500 = 84,717
O.paymentAmount = 100000                                                 // 1,000.00 paid
O.allocated = O.basisAfterRelease                                        // 847.17
O.unallocated = O.paymentAmount - O.allocated                            // 152.83
O.heldEx = O.retention - O.creditRet - O.releaseEx                       // 10,000 − 2,000 − 5,000 = 3,000
O.heldGst = O.invRetentionGst - O.creditRetGst - O.releaseGst            // 1,000 − 200 − 500 = 300
O.actualCc1 = O.claimed - O.creditEx                                     // 100,015 − 20,000 = 80,015
O.remainingCommittedCc1 = O.poLine0 - O.claimed                          // 2,500,000 − 100,015 = 2,399,985

beforeAll(async () => {
  A = await admin()
  handlersMod = await import('../../functions/src/supplierFinance/handlers.js')
})

beforeEach(async () => {
  await resetEmulators()
  await seedCompany(COMPANY_A)
  await activateCommercial(COMPANY_A)
  for (const [uid, role] of [['u_qs', 'qs'], ['u_pm', 'project_manager']]) await seedUser({ uid, email: `${uid}@a.test`, role, companyId: COMPANY_A })
  await company().collection('projects').doc(PROJECT).set({ name: 'A', status: 'active', currency: 'AUD' })
  await company().collection('contacts').doc('s1').set({ displayName: 'Steel Co', isActive: true, paymentTerms: { days: 30, basis: 'invoice' } })
  await company().collection('costCodes').doc('cc1').set({ code: '03-100', name: 'Concrete', isActive: true })
  await company().collection('costCodes').doc('cc4').set({ code: '04-200', name: 'Masonry', isActive: true })
  await col('purchaseOrders').doc('po1').set({
    poNumber: 'PO-0001', status: 'sent', supplierName: 'Steel Co', supplierId: 's1', subtotal: 34000, gst: 3400, total: 37400,
    lineItems: [
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', qty: 10, unit: 'm3', unitPrice: 2500, lineTotal: 25000 },
      { costCodeId: 'cc4', costCodeName: '04-200 — Masonry', description: 'Blockwork', qty: 1, unit: 'item', unitPrice: 9000, lineTotal: 9000 },
    ],
  })
  H = handlersMod.createSupplierFinanceHandlers({ db: A.db, now: clock('2026-11-28T02:00:00Z'), log: silentLog, config: () => ({ enabled: true }), clock: () => Date.parse('2026-11-28T02:00:00Z') })
})

describe('one supplier lifecycle reconciled to the cent', () => {
  it('PO → claim → invoice → credit → release → payment (unallocated part) → refused / permitted voids; every register and selector agrees with the oracle', async () => {
    const { buildForecastRows } = await import('../../src/lib/forecast')
    const { supplierInvoiceReconciliationRows, cashOutRows } = await import('../../src/lib/supplierPayments')
    const { retentionInvoiceRows, releasedByInvoiceId } = await import('../../src/lib/retention')
    const forecastCc1 = async () => {
      const rows = buildForecastRows({
        costCodes: [{ id: 'cc1', code: '03-100', name: 'Concrete' }, { id: 'cc4', code: '04-200', name: 'Masonry' }],
        purchaseOrders: await docs('purchaseOrders'), progressClaims: await docs('progressClaims'),
        supplierInvoices: await docs('supplierInvoices'), supplierCreditNotes: await docs('supplierCreditNotes'),
      })
      return rows.find(r => r.costCodeId === 'cc1')
    }
    const reconciliation = async () => {
      const [invoices, payments, credits, releases] = await Promise.all([docs('supplierInvoices'), docs('supplierPayments'), docs('supplierCreditNotes'), docs('retentionReleases')])
      return { row: supplierInvoiceReconciliationRows(invoices, payments, credits, releasedByInvoiceId(releases))[0], ret: retentionInvoiceRows(invoices, releases, credits)[0], cash: cashOutRows(payments) }
    }

    // 1. CLAIM — 1,000.15 claimed, retention 100.00.
    await claimOp('u_qs', 'create', {
      projectId: PROJECT, claimId: 'c1', poId: 'po1', periodEnding: '2026-11-30', claimRef: 'C-1', notes: '', retention: 100,
      lines: [{ poLineIndex: 0, variationId: null, variationLineIndex: null, claimedToDate: 1000.15 }, { poLineIndex: 1, variationId: null, variationLineIndex: null, claimedToDate: 0 }],
    })
    expect(await data(col('progressClaims').doc('c1'))).toMatchObject({ claimedSubtotal: O.claimed / 100, retention: O.retention / 100, claimedGst: O.claimGst / 100, claimedTotal: O.claimTotal / 100, calcVersion: 2 })
    await col('progressClaims').doc('c1').update({ status: 'submitted', submittedBy: 'u_qs', submittedAt: new Date(), revision: 2 })
    await claimOp('u_pm', 'approve', { projectId: PROJECT, claimId: 'c1', expectedRevision: 2, approvedAmounts: [1000.15, 0], assessmentNotes: '' })
    const approved = await data(col('progressClaims').doc('c1'))
    expect([cents(approved.approvedSubtotal), cents(approved.approvedGst), cents(approved.approvedTotal)]).toEqual([O.claimed, O.claimGst, O.claimTotal])
    // An approved claim is Actual until its invoice posts; remaining committed falls by it.
    expect([cents((await forecastCc1()).actual), cents((await forecastCc1()).remainingCommitted)]).toEqual([O.claimed, O.remainingCommittedCc1])

    // 2. INVOICE from the claim: the certified obligation, never recomputed.
    await invoiceOp('u_qs', 'create', {
      projectId: PROJECT, invoiceId: 'inv1', source: 'progress_claim', sourceId: 'c1', expectedSourceRevision: approved.revision,
      supplierInvoiceNumber: 'STEEL-77', invoiceDate: '2026-11-28', receivedDate: '', dueDate: '', notes: '', retention: null,
      // Only the certified line is invoiced; a line certified at zero is not an invoice line.
      lines: [{ lineIndex: 0, amount: null, taxCode: 'gst' }],
    })
    const inv = await data(col('supplierInvoices').doc('inv1'))
    expect([cents(inv.subtotal), cents(inv.gstTotal), cents(inv.grossTotal), cents(inv.retention), cents(inv.retentionGst), cents(inv.payableGst), cents(inv.payableTotal)])
      .toEqual([O.claimed, O.invGst, O.invGross, O.retention, O.invRetentionGst, O.claimGst, O.invPayable])
    // The due date is what the request carries (the page pre-fills it from the supplier's terms); none was sent.
    expect(inv).toMatchObject({ calcVersion: 2, dueDate: '' })
    await invoiceOp('u_pm', 'approve', { projectId: PROJECT, invoiceId: 'inv1', expectedRevision: 1 })
    await invoiceOp('u_pm', 'post', { projectId: PROJECT, invoiceId: 'inv1', expectedRevision: 2 })
    // The invoice supersedes the claim in Actual — no double count.
    expect([cents((await forecastCc1()).actual), cents((await forecastCc1()).remainingCommitted)]).toEqual([O.claimed, O.remainingCommittedCc1])

    // 3. CREDIT on the retained invoice (G1).
    await settleOp('u_qs', 'saveCredit', {
      projectId: PROJECT, creditNoteId: 'cn1', expectedRevision: null, supplierInvoiceId: 'inv1', supplierCreditReference: 'CN-9', creditDate: '2026-11-28', reason: 'Defect', notes: '',
      lines: [{ costCodeId: 'cc1', taxCode: 'gst', description: 'Defective slab', amount: 200 }],
    })
    const cn = await data(col('supplierCreditNotes').doc('cn1'))
    expect([cents(cn.subtotal), cents(cn.gstTotal), cents(cn.retentionAmount), cents(cn.retentionGst)]).toEqual([O.creditEx, O.creditGst, O.creditRet, O.creditRetGst])
    await post('u_pm', 'postCredit', 'cn1')
    expect(cents((await forecastCc1()).actual)).toBe(O.actualCc1)

    // 4. RELEASE 50.00.
    await settleOp('u_qs', 'saveRelease', { projectId: PROJECT, releaseId: 'r1', expectedRevision: null, supplierInvoiceId: 'inv1', amount: 50, releaseDate: '2026-11-28', reason: 'PC', notes: '' })
    expect(cents((await data(col('retentionReleases').doc('r1'))).gstAmount)).toBe(O.releaseGst)
    await post('u_pm', 'postRelease', 'r1')

    // 5. PAYMENT 1,000.00: one cent over what is payable is refused; the exact remainder is allocated, the rest unallocated.
    await expectTeamError(savePayment('p0', (O.allocated + 1) / 100, O.paymentAmount / 100), 'supplier-finance-cap-exceeded')
    await savePayment('p1', O.allocated / 100, O.paymentAmount / 100)
    expect(cents((await data(col('supplierPayments').doc('p1'))).unallocatedAmount)).toBe(O.unallocated)
    await post('u_qs', 'postPayment', 'p1')

    let ledger = await data(col('supplierInvoiceLedgers').doc('inv1'))
    expect(ledger).toMatchObject({ paidCents: O.allocated, creditedSubtotalCents: O.creditEx, creditedGstCents: O.creditGst, creditedRetentionCents: O.creditRet, creditedRetentionGstCents: O.creditRetGst, releasedRetentionCents: O.releaseEx, releasedRetentionGstCents: O.releaseGst, state: 'established' })
    let r = await reconciliation()
    expect(cents(r.row.remaining)).toBe(0)
    expect(cents(r.ret.retentionHeld)).toBe(O.heldEx + O.heldGst)
    expect(r.cash.map(c => [cents(c.amount), cents(c.allocatedTotal), cents(c.unallocatedAmount)])).toEqual([[O.paymentAmount, O.allocated, O.unallocated]])
    // Cash, settlement and retention never move cost.
    expect(cents((await forecastCc1()).actual)).toBe(O.actualCc1)

    // 6. VOIDS. The release is paid out: its void is refused. Void the payment, then the release.
    await expectTeamError(voidDoc('u_pm', 'voidRelease', 'r1', 2), 'supplier-finance-dependency')
    await voidDoc('u_pm', 'voidPayment', 'p1', 2)
    r = await reconciliation()
    expect(cents(r.row.remaining)).toBe(O.basisAfterRelease)
    expect(r.cash).toEqual([])
    await voidDoc('u_pm', 'voidRelease', 'r1', 2)
    ledger = await data(col('supplierInvoiceLedgers').doc('inv1'))
    expect(ledger).toMatchObject({ paidCents: 0, releasedRetentionCents: 0, releasedRetentionGstCents: 0, state: 'established' })
    r = await reconciliation()
    expect(cents(r.row.remaining)).toBe(O.basisAfterCredit)
    expect(cents(r.ret.retentionHeld)).toBe(O.retention - O.creditRet + O.invRetentionGst - O.creditRetGst) // 80.00 + 8.00
    // Every fact is audited once; the voided documents are kept with their figures.
    const types = (await company().collection('auditEvents').get()).docs.map(d => d.data().type).filter(t => /^(progress_claim|supplier_|retention_release)/.test(t)).sort()
    expect(types).toEqual([
      'progress_claim.approved', 'progress_claim.created', 'retention_release.posted', 'retention_release.voided',
      'supplier_credit_note.posted', 'supplier_finance.baseline_established', 'supplier_invoice.approved', 'supplier_invoice.created', 'supplier_invoice.posted',
      'supplier_payment.posted', 'supplier_payment.voided',
    ])
    expect(await data(col('supplierPayments').doc('p1'))).toMatchObject({ status: 'void', amount: 1000, allocatedTotal: O.allocated / 100 })
  })
})
