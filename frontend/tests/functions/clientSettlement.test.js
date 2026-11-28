import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  admin, resetEmulators, seedCompany, activateCommercial, seedUser, req, expectTeamError, clock, silentLog, clientSignOutAll, COMPANY_A, COMPANY_B,
} from './_harness.js'
import { runClientCreditCreate } from '../../src/lib/clientLedgerActions'
import { issuedInvoice, draftReceipt } from '../fixtures/clientReceivableDocs'

// ── Phase 2 step 5 (ADR-95) — client refunds, receipt applications and the
// trusted void of an issued client invoice — against the Auth + Firestore
// emulators, handlers called directly with the real Admin SDK.
//
// INDEPENDENT ORACLE: every expected figure is integer cents written in the
// test from the amounts it seeds (`$('1,234.56')` parses the text). Nothing is
// computed with the module under test.

const $ = (text) => { const [w, f = ''] = text.replace(/,/g, '').split('.'); return Number(w) * 100 + Number((f + '00').slice(0, 2)) }
const PROJECT = 'projectA'
let A, handlersMod, baselineMod, H, hooks

const company = (c = COMPANY_A) => A.db.collection('companies').doc(c)
const base = (c = COMPANY_A, p = PROJECT) => company(c).collection('projects').doc(p)
const invoiceRef = (id, c, p) => base(c, p).collection('clientInvoices').doc(id)
const ledgerRef = (id) => base().collection('clientInvoiceLedgers').doc(id)
const receiptRef = (id, c, p) => base(c, p).collection('clientReceipts').doc(id)
const receiptLedgerRef = (id) => base().collection('clientReceiptLedgers').doc(id)
const refundRef = (id) => base().collection('clientRefunds').doc(id)
const appRef = (id) => base().collection('clientReceiptApplications').doc(id)
const data = (ref) => ref.get().then(s => (s.exists ? s.data() : null))
const audits = async (type) => (await company().collection('auditEvents').get()).docs.map(d => d.data()).filter(e => e.type === type)

const day = '2026-11-25'
const refundReq = (refundId, over = {}) => ({ projectId: PROJECT, refundId, source: 'receipt', receiptId: 'r1', clientInvoiceId: null, amount: 100, refundDate: day, method: 'bank_transfer', reference: 'EFT 77', reason: 'Client overpaid', ...over })
const appReq = (applicationId, over = {}) => ({ projectId: PROJECT, applicationId, receiptId: 'r1', clientInvoiceId: 'invN', amount: 100, applicationDate: day, notes: '', ...over })
const postRefund = (uid, id, over) => H.postClientRefund(req(uid, refundReq(id, over)))
const voidRefund = (uid, refundId, reason = 'Keyed in error') => H.voidClientRefund(req(uid, { projectId: PROJECT, refundId, reason }))
const postApp = (uid, id, over) => H.postClientReceiptApplication(req(uid, appReq(id, over)))
const voidApp = (uid, applicationId, reason = 'Wrong invoice') => H.voidClientReceiptApplication(req(uid, { projectId: PROJECT, applicationId, reason }))
const postReceipt = (uid, receiptId, ack = false) => H.postClientReceipt(req(uid, { projectId: PROJECT, receiptId, acknowledgeOverAllocation: ack }))
const voidReceipt = (uid, receiptId, reason = 'Keyed twice') => H.voidClientReceipt(req(uid, { projectId: PROJECT, receiptId, reason }))
const voidInvoice = (uid, invoiceId, reason = 'Issued in error') => H.voidClientInvoice(req(uid, { projectId: PROJECT, invoiceId, reason }))

function fresh({ finance = true, receipts = true, settlement = true } = {}) {
  hooks = {}
  H = handlersMod.createClientFinanceHandlers({ db: A.db, now: clock('2026-11-26T02:00:00Z'), log: silentLog, config: () => ({ finance, receipts, receiptsAllCompanies: true, settlement }), hooks })
}

const stamps = (uid = 'u_qs') => ({ createdAt: A.FieldValue.serverTimestamp(), createdBy: uid, updatedAt: A.FieldValue.serverTimestamp(), updatedBy: uid })
let receiptSeq = 0
async function draft(id, amount, allocations, over = {}, c, p) {
  receiptSeq += 1
  await receiptRef(id, c, p).set({ ...draftReceipt({ receiptNumber: `CR-${String(receiptSeq).padStart(4, '0')}`, amount, allocations, ...over }), ...stamps() })
}
const alloc = (clientInvoiceId, allocatedAmount, invoiceNumber) => ({ clientInvoiceId, invoiceNumber, allocatedAmount })
async function seedInvoice(id, doc, c, p) {
  const rest = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'id'))
  await invoiceRef(id, c, p).set({ ...rest, createdAt: A.Timestamp.fromMillis(1_760_000_000_000), createdBy: 'seed' })
}
// M — 1,000.00 + 100.00 GST = 1,100.00 receivable (CI-0001). N — 9,000.00 + 900.00 = 9,900.00 (CI-0002).
const seedM = () => seedInvoice('invM', issuedInvoice({ subtotal: 1000, invoiceNumber: 'CI-0001' }))
const seedN = (over = {}) => seedInvoice('invN', issuedInvoice({ subtotal: 9000, invoiceNumber: 'CI-0002', ...over }))

const settle = async (calls) => {
  const results = await Promise.allSettled(Object.values(calls))
  return Object.fromEntries(Object.keys(calls).map((k, i) => [k, results[i].status === 'fulfilled' ? { ok: true } : { ok: false, code: results[i].reason?.details?.code ?? `UNTYPED:${results[i].reason?.message}` }]))
}

beforeAll(async () => {
  A = await admin()
  handlersMod = await import('../../functions/src/clientFinance/handlers.js')
  baselineMod = await import('../../functions/src/clientFinance/baseline.js')
})
beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  receiptSeq = 0
  fresh()
  await seedCompany(COMPANY_A, 'Acme Builders')
  await activateCommercial(COMPANY_A)
  await company().update({ clientFinanceEnabled: true })
  await base().set({ name: 'Harbour Road Units', currency: 'AUD', currencyLocked: true })
  await baselineMod.ensureReceiptBaseline(A.db, { companyId: COMPANY_A, projectId: PROJECT, uid: 'seed' })
  for (const [uid, role] of [['u_admin', 'company_admin'], ['u_pm', 'project_manager'], ['u_qs', 'qs']]) {
    await seedUser({ uid, email: `${uid}@acme.test`, role, companyId: COMPANY_A })
  }
  await seedM()
  await seedN()
  // R1 — 1,500.00 received: 1,000.00 to CI-0001 (owed 1,100.00), 500.00 UNALLOCATED.
  await draft('r1', 1500, [alloc('invM', 1000, 'CI-0001')])
  await postReceipt('u_qs', 'r1')
})
afterAll(async () => { await clientSignOutAll() })

describe('refunds from a receipt’s unallocated money', () => {
  it('records the refund, moves the receipt ledger, numbers it, audits it — and the derived client and currency are the receipt’s', async () => {
    const out = await postRefund('u_qs', 'f1', { amount: 120.45 })
    expect(out).toMatchObject({ status: 'posted', refundId: 'f1', refundNumber: 'CRF-0001', alreadyApplied: false })
    expect(await data(refundRef('f1'))).toMatchObject({
      docType: 'client_refund', status: 'posted', source: 'receipt', receiptId: 'r1', receiptNumber: 'CR-0001', clientInvoiceId: null,
      clientId: 'c1', currency: 'AUD', amount: 120.45, refundDate: day, method: 'bank_transfer', reference: 'EFT 77', reason: 'Client overpaid',
      postedBy: 'u_qs', createdBy: 'u_qs',
    })
    expect(await data(receiptLedgerRef('r1'))).toMatchObject({ seq: 1, appliedCents: 0, refundedCents: $('120.45'), lastEntryId: 'f1', lastEntryKind: 'refund' })
    expect(await data(company().collection('counters').doc('clientRefunds'))).toEqual({ next: 2 })
    const [ev] = await audits('client_refund.posted')
    expect(ev.after).toMatchObject({ number: 'CRF-0001', amountCents: $('120.45'), availableAfterCents: $('500.00') - $('120.45'), source: 'receipt' })
    expect(ev.before.availableCents).toBe($('500.00'))
    // The invoice ledger is untouched by a receipt-sourced refund.
    expect((await data(ledgerRef('invM'))).receivedCents).toBe($('1000.00'))
    expect('refundedCents' in (await data(ledgerRef('invM')))).toBe(false)
  })

  it('OVER-REFUND is refused; exactly the remainder is accepted; nothing more', async () => {
    await postRefund('u_qs', 'f1', { amount: 400 })
    const err = await expectTeamError(postRefund('u_qs', 'f2', { amount: 100.01 }), 'client-settlement-funds-unavailable')
    expect(err.details).toMatchObject({ availableCents: $('100.00'), requestedCents: $('100.01') })
    await postRefund('u_qs', 'f3', { amount: 100 })
    await expectTeamError(postRefund('u_qs', 'f4', { amount: 0.01 }), 'client-settlement-funds-unavailable')
    expect(await data(refundRef('f2'))).toBeNull()
    expect((await data(receiptLedgerRef('r1'))).refundedCents).toBe($('500.00'))
  })

  it('a REPEAT after a lost response is answered without a second record; the same id with other content is a conflict', async () => {
    await postRefund('u_qs', 'f1')
    expect(await postRefund('u_qs', 'f1')).toMatchObject({ alreadyApplied: true, refundNumber: 'CRF-0001' })
    await expectTeamError(postRefund('u_qs', 'f1', { amount: 99 }), 'client-settlement-id-conflict')
    await expectTeamError(postRefund('u_pm', 'f1'), 'client-settlement-id-conflict')
    expect((await data(receiptLedgerRef('r1'))).refundedCents).toBe($('100.00'))
    expect(await audits('client_refund.posted')).toHaveLength(1)
  })

  it('CONCURRENT refunds of the same money: the receipt ledger orders them; the total never exceeds 500.00', async () => {
    const r = await settle({ a: postRefund('u_qs', 'fa', { amount: 300 }), b: postRefund('u_pm', 'fb', { amount: 300 }), c: postRefund('u_admin', 'fc', { amount: 300 }) })
    const ok = Object.values(r).filter(x => x.ok).length
    expect(ok).toBe(1)
    for (const x of Object.values(r).filter(x => !x.ok)) expect(['client-settlement-funds-unavailable', 'client-finance-busy']).toContain(x.code)
    expect((await data(receiptLedgerRef('r1'))).refundedCents).toBe($('300.00'))
  })

  it('a refund and an application RACING for the same money: both cannot win beyond what is there', async () => {
    const r = await settle({ refund: postRefund('u_qs', 'fx', { amount: 400 }), app: postApp('u_pm', 'ax', { amount: 400 }) })
    expect(Object.values(r).filter(x => x.ok)).toHaveLength(1)
    const L = await data(receiptLedgerRef('r1'))
    expect(L.appliedCents + L.refundedCents).toBe($('400.00'))
  })

  it('a receipt that is not posted, or another tenant’s receipt, is refused; a future date is refused', async () => {
    await draft('rd', 50, [])
    await expectTeamError(postRefund('u_qs', 'f1', { receiptId: 'rd', amount: 10 }), 'client-receipt-not-posted')
    await expectTeamError(postRefund('u_qs', 'f2', { receiptId: 'nope', amount: 10 }), 'client-receipt-not-posted')
    await seedCompany(COMPANY_B, 'Other')
    await activateCommercial(COMPANY_B)
    await base(COMPANY_B).set({ name: 'B', currency: 'AUD' })
    await draft('rB', 50, [], {}, COMPANY_B)
    await expectTeamError(postRefund('u_qs', 'f3', { receiptId: 'rB', amount: 10 }), 'client-receipt-not-posted')
    const err = await expectTeamError(postRefund('u_qs', 'f4', { refundDate: '2026-12-31' }), 'client-settlement-invalid')
    expect(err.details.field).toBe('refundDate')
  })
})

describe('refunds of an invoice’s overpayment', () => {
  beforeEach(async () => {
    // R2 over-allocates CI-0001 (owed 100.00 after R1) by 250.00, with acknowledgement.
    await draft('r2', 350, [alloc('invM', 350, 'CI-0001')])
    await postReceipt('u_qs', 'r2', true)
  })

  it('refunds at most the overpayment, recorded in the invoice ledger; S1 holds', async () => {
    const over = $('1000.00') + $('350.00') - $('1100.00')
    expect(over).toBe($('250.00'))
    await expectTeamError(postRefund('u_qs', 'f1', { source: 'invoice', receiptId: null, clientInvoiceId: 'invM', amount: 250.01 }), 'client-settlement-funds-unavailable')
    await postRefund('u_qs', 'f2', { source: 'invoice', receiptId: null, clientInvoiceId: 'invM', amount: 250 })
    const L = await data(ledgerRef('invM'))
    expect(L).toMatchObject({ receivedCents: $('1350.00'), refundedCents: $('250.00'), lastEntryKind: 'refund' })
    await expectTeamError(postRefund('u_qs', 'f3', { source: 'invoice', receiptId: null, clientInvoiceId: 'invM', amount: 0.01 }), 'client-settlement-funds-unavailable')
    // An invoice that is not overpaid has nothing to refund.
    await expectTeamError(postRefund('u_qs', 'f4', { source: 'invoice', receiptId: null, clientInvoiceId: 'invN', amount: 1 }), 'client-settlement-funds-unavailable')
  })

  it('VOIDING the receipt that made the overpayment is refused while the refund depends on it', async () => {
    await postRefund('u_qs', 'f2', { source: 'invoice', receiptId: null, clientInvoiceId: 'invM', amount: 250 })
    await expectTeamError(voidReceipt('u_qs', 'r2'), 'client-refunds-depend')
    expect((await data(receiptRef('r2'))).status).toBe('posted')
    // Correcting the refund record first lets the receipt be voided.
    await voidRefund('u_qs', 'f2')
    await voidReceipt('u_qs', 'r2')
    expect(await data(ledgerRef('invM'))).toMatchObject({ receivedCents: $('1000.00'), refundedCents: 0 })
  })

  it('a CREDIT NOTE void that would leave refunded money uncovered is refused (settlement invalidated)', async () => {
    // A credit of 100.00 (+10.00 GST) on N after full payment creates a 110.00 overpayment, refunded.
    await draft('r3', 9900, [alloc('invN', 9900, 'CI-0002')])
    await postReceipt('u_qs', 'r3')
    await runClientCreditCreate({
      db: A.db, uid: 'u_qs', serverTimestamp: () => A.FieldValue.serverTimestamp(), currency: 'AUD',
      runTransaction: (db, fn) => db.runTransaction((tx) => fn({
        get: async (ref) => { const s = await tx.get(ref); return { id: s.id, exists: () => s.exists, data: () => s.data() } },
        set: (ref, v, o) => (o ? tx.set(ref, v, o) : tx.set(ref, v)), update: (ref, v) => tx.update(ref, v),
      })),
      counterRef: company().collection('counters').doc('clientCreditNotes'), creditRef: base().collection('clientCreditNotes').doc('cn1'),
      invoiceRef: invoiceRef('invN'), ledgerRef: ledgerRef('invN'), stageCurrencyLock: async () => () => {},
      input: { creditDate: '2026-11-20', reason: 'Over-billed', clientCreditReference: '', notes: '', rows: [{ invoiceLineIndex: 0, amount: 100 }] },
    })
    await H.postClientCreditNote(req('u_qs', { projectId: PROJECT, creditNoteId: 'cn1' }))
    await postRefund('u_qs', 'f5', { source: 'invoice', receiptId: null, clientInvoiceId: 'invN', amount: 110 })
    await expectTeamError(H.voidClientCreditNote(req('u_qs', { projectId: PROJECT, creditNoteId: 'cn1', reason: 'Raised in error' })), 'client-refunds-depend')
    expect((await data(base().collection('clientCreditNotes').doc('cn1'))).status).toBe('posted')
    // The client repays the refunded money: a new receipt; then the credit may be voided.
    await draft('r4', 110, [alloc('invN', 110, 'CI-0002')])
    await postReceipt('u_qs', 'r4', true)
    await H.voidClientCreditNote(req('u_qs', { projectId: PROJECT, creditNoteId: 'cn1', reason: 'Raised in error' }))
  })
})

describe('receipt applications', () => {
  it('applies unallocated money to an invoice of the same client: both ledgers move, nothing else; not cash', async () => {
    const out = await postApp('u_pm', 'a1', { amount: 300.25 })
    expect(out).toMatchObject({ status: 'posted', applicationNumber: 'CRA-0001', alreadyApplied: false })
    expect(await data(appRef('a1'))).toMatchObject({ receiptId: 'r1', clientInvoiceId: 'invN', invoiceNumber: 'CI-0002', clientId: 'c1', currency: 'AUD', amount: 300.25, status: 'posted' })
    expect(await data(receiptLedgerRef('r1'))).toMatchObject({ appliedCents: $('300.25'), refundedCents: 0 })
    expect(await data(ledgerRef('invN'))).toMatchObject({ receivedCents: $('300.25'), lastEntryKind: 'application' })
    expect((await data(receiptRef('r1'))).allocations).toHaveLength(1)   // the receipt itself is never rewritten
    const [ev] = await audits('client_receipt_application.posted')
    expect(ev.after).toMatchObject({ cash: false, amountCents: $('300.25'), receiptAvailableAfterCents: $('500.00') - $('300.25'), invoiceReceivedAfterCents: $('300.25') })
  })

  it('never creates an overpayment: at most what the invoice still owes', async () => {
    // CI-0001 is owed 100.00 after R1.
    const err = await expectTeamError(postApp('u_qs', 'a1', { clientInvoiceId: 'invM', amount: 100.01 }), 'client-settlement-funds-unavailable')
    expect(err.details).toMatchObject({ invoiceRemainingCents: $('100.00') })
    await postApp('u_qs', 'a2', { clientInvoiceId: 'invM', amount: 100 })
    expect((await data(ledgerRef('invM'))).receivedCents).toBe($('1100.00'))
  })

  it('D7 boundaries: another client, another currency, another project, a draft or void invoice are refused', async () => {
    await seedInvoice('invOther', issuedInvoice({ id: 'invOther', subtotal: 100, invoiceNumber: 'CI-0003', clientId: 'c2' }))
    await seedInvoice('invNzd', issuedInvoice({ id: 'invNzd', subtotal: 100, invoiceNumber: 'CI-0004', currency: 'NZD' }))
    await seedInvoice('invDraft', issuedInvoice({ id: 'invDraft', subtotal: 100, invoiceNumber: 'CI-0005', status: 'draft' }))
    await base(COMPANY_A, 'projectB').set({ name: 'Other project', currency: 'AUD' })
    await seedInvoice('invP2', issuedInvoice({ id: 'invP2', subtotal: 100, invoiceNumber: 'CI-0006' }), COMPANY_A, 'projectB')
    expect((await expectTeamError(postApp('u_qs', 'a1', { clientInvoiceId: 'invOther', amount: 1 }), 'client-settlement-mismatch')).details.field).toBe('clientId')
    expect((await expectTeamError(postApp('u_qs', 'a2', { clientInvoiceId: 'invNzd', amount: 1 }), 'client-settlement-mismatch')).details.field).toBe('currency')
    await expectTeamError(postApp('u_qs', 'a3', { clientInvoiceId: 'invDraft', amount: 1 }), 'client-invoice-not-issued')
    // The project is the path: an invoice of another project is simply not found under this one.
    await expectTeamError(postApp('u_qs', 'a4', { clientInvoiceId: 'invP2', amount: 1 }), 'client-invoice-not-issued')
    expect(await data(receiptLedgerRef('r1'))).toBeNull()
  })

  it('a receipt with applications or refunds cannot be voided until they are corrected; then it voids cleanly', async () => {
    await postApp('u_qs', 'a1', { amount: 200 })
    await postRefund('u_qs', 'f1', { amount: 100 })
    const err = await expectTeamError(voidReceipt('u_qs', 'r1'), 'client-receipt-has-settlements')
    expect(err.details).toMatchObject({ appliedCents: $('200.00'), refundedCents: $('100.00') })
    await voidApp('u_qs', 'a1')
    await expectTeamError(voidReceipt('u_qs', 'r1'), 'client-receipt-has-settlements')
    await voidRefund('u_qs', 'f1')
    await voidReceipt('u_qs', 'r1')
    expect(await data(ledgerRef('invN'))).toMatchObject({ receivedCents: 0 })
    expect(await data(ledgerRef('invM'))).toMatchObject({ receivedCents: 0 })
  })

  it('an application CORRECTION is refused when it would leave money refunded out of that invoice uncovered', async () => {
    // Apply 300.00 to M (owed 100.00)? refused — so first make M overpaid by a later acknowledged receipt.
    await postApp('u_qs', 'a1', { clientInvoiceId: 'invM', amount: 100 })                    // M now holds 1,100.00 = owed
    await draft('r5', 60, [alloc('invM', 60, 'CI-0001')])
    await postReceipt('u_qs', 'r5', true)                                                     // M holds 1,160.00 → 60.00 over
    await postRefund('u_qs', 'f9', { source: 'invoice', receiptId: null, clientInvoiceId: 'invM', amount: 60 })
    await expectTeamError(voidApp('u_qs', 'a1'), 'client-refunds-depend')
    expect((await data(appRef('a1'))).status).toBe('posted')
  })

  it('replay; double application of the same id; concurrent applications of the same money', async () => {
    await postApp('u_qs', 'a1')
    expect(await postApp('u_qs', 'a1')).toMatchObject({ alreadyApplied: true })
    await expectTeamError(postApp('u_qs', 'a1', { amount: 5 }), 'client-settlement-id-conflict')
    const r = await settle({ x: postApp('u_qs', 'ax', { amount: 300 }), y: postApp('u_pm', 'ay', { amount: 300 }) })
    expect(Object.values(r).filter(v => v.ok)).toHaveLength(1)
    expect((await data(receiptLedgerRef('r1'))).appliedCents).toBe($('100.00') + $('300.00'))
  })
})

describe('corrections (voids) are not cash reversals', () => {
  it('a refund void restores availability, is audited as a correction, and is idempotent for the same caller and reason', async () => {
    await postRefund('u_qs', 'f1', { amount: 200 })
    await voidRefund('u_qs', 'f1', 'Recorded twice')
    expect(await data(refundRef('f1'))).toMatchObject({ status: 'void', voidedBy: 'u_qs', voidReason: 'Recorded twice', amount: 200 })
    expect((await data(receiptLedgerRef('r1'))).refundedCents).toBe(0)
    expect(await voidRefund('u_qs', 'f1', 'Recorded twice')).toMatchObject({ alreadyApplied: true })
    await expectTeamError(voidRefund('u_pm', 'f1', 'Recorded twice'), 'client-entry-not-posted')
    const [ev] = await audits('client_refund.voided')
    expect(ev.after).toMatchObject({ correction: true, cashReversed: false, amountCents: $('200.00') })
    // The money is available again.
    await postRefund('u_qs', 'f2', { amount: 500 })
  })
})

describe('the trusted void of an ISSUED invoice (D8)', () => {
  it('refused while receipts are allocated to it — including receipts from BEFORE the backend (baseline) — and the reason names the money', async () => {
    const err = await expectTeamError(voidInvoice('u_qs', 'invM'), 'client-invoice-has-money')
    expect(err.details).toMatchObject({ invoiceNumber: 'CI-0001', receivedCents: $('1000.00') })
    expect((await data(invoiceRef('invM'))).status).toBe('issued')
  })
  it('refused while an application or a refund is recorded against it', async () => {
    await postApp('u_qs', 'a1', { amount: 10 })
    expect((await expectTeamError(voidInvoice('u_qs', 'invN'), 'client-invoice-has-money')).details.receivedCents).toBe($('10.00'))
  })
  it('allowed once nothing is recorded against it; audited; idempotent; a draft is not the backend’s', async () => {
    await seedInvoice('invE', issuedInvoice({ id: 'invE', subtotal: 50, invoiceNumber: 'CI-0009' }))
    const out = await voidInvoice('u_pm', 'invE', 'Duplicate')
    expect(out).toMatchObject({ status: 'void', alreadyApplied: false })
    expect(await data(invoiceRef('invE'))).toMatchObject({ status: 'void', voidedBy: 'u_pm', voidReason: 'Duplicate' })
    expect(await voidInvoice('u_pm', 'invE', 'Duplicate')).toMatchObject({ alreadyApplied: true })
    expect(await audits('client_invoice.voided')).toHaveLength(1)
    await seedInvoice('invD', issuedInvoice({ id: 'invD', subtotal: 50, invoiceNumber: 'CI-0010', status: 'draft' }))
    await expectTeamError(voidInvoice('u_pm', 'invD'), 'client-invoice-not-issued')
  })
  it('a historical receipt posted before the backend (no allocatedInvoiceIds) still blocks — through the project baseline', async () => {
    // A second project whose ONLY receipt was posted the old way, then its baseline established by the first call.
    const P2 = 'projectLegacy'
    await base(COMPANY_A, P2).set({ name: 'Legacy', currency: 'AUD' })
    await seedInvoice('invL', issuedInvoice({ id: 'invL', subtotal: 100, invoiceNumber: 'CI-0100' }), COMPANY_A, P2)
    await receiptRef('rL', COMPANY_A, P2).set({ ...draftReceipt({ receiptNumber: 'CR-0100', amount: 110, allocations: [alloc('invL', 110, 'CI-0100')] }), status: 'posted', postedAt: A.Timestamp.fromMillis(1_760_000_000_000), postedBy: 'old', ...stamps() })
    const err = await expectTeamError(H.voidClientInvoice(req('u_qs', { projectId: P2, invoiceId: 'invL', reason: 'x' })), 'client-invoice-has-money')
    expect(err.details.receivedCents).toBe($('110.00'))
  })
})

describe('D3 #47 — refund voids (architect decision)', () => {
  const policy = (on) => company().collection('approvalPolicy').doc('current').set({ segregationEnabled: on, version: 1, changedBy: 'operator', reason: 'test' })
  it('STRICT: recording stays single-person; the RECORDER cannot void the posted refund; an independent member can — a correction, not a cash reversal', async () => {
    await policy(true)
    await postRefund('u_qs', 'f1', { amount: 120 })
    const err = await expectTeamError(voidRefund('u_qs', 'f1'), 'approval-segregation-required')
    expect(err.message).toMatch(/void of a posted client refund/)
    expect((await data(refundRef('f1'))).status).toBe('posted')
    expect((await data(receiptLedgerRef('r1'))).refundedCents).toBe($('120.00'))
    await voidRefund('u_pm', 'f1')
    expect((await data(refundRef('f1'))).status).toBe('void')
    expect((await data(receiptLedgerRef('r1'))).refundedCents).toBe(0)
    const [ev] = await audits('client_refund.voided')
    expect(ev.after).toMatchObject({ correction: true, cashReversed: false, segregation: { policyEnabled: true, independent: true } })
  })
  it('NOT STRICT: single-person correction is preserved and recorded as such in the audit', async () => {
    await postRefund('u_qs', 'f1', { amount: 50 })
    await voidRefund('u_qs', 'f1')
    const [ev] = await audits('client_refund.voided')
    expect(ev.after.segregation).toMatchObject({ policyEnabled: false, isCreator: true, independent: false })
  })
  it('a policy ENABLED between the recording and the void applies to the void', async () => {
    await postRefund('u_qs', 'f1', { amount: 50 })
    await policy(true)
    await expectTeamError(voidRefund('u_qs', 'f1'), 'approval-segregation-required')
  })
})

describe('Phase 2 company activation (final release batch)', () => {
  it('an INACTIVE company: refunds, applications and the void of an issued invoice are refused, nothing written — while its Phase 1 receipts still post', async () => {
    await activateCommercial(COMPANY_A, false)
    await expectTeamError(postRefund('u_qs', 'f1'), 'commercial-completion-not-activated')
    await expectTeamError(postApp('u_qs', 'a1'), 'commercial-completion-not-activated')
    await expectTeamError(voidInvoice('u_qs', 'invN'), 'commercial-completion-not-activated')
    expect(await data(refundRef('f1'))).toBeNull()
    expect(await data(appRef('a1'))).toBeNull()
    expect((await data(invoiceRef('invN'))).status).toBe('issued')
    // Phase 1 is untouched by the Phase 2 marker.
    await draft('r2', 50, [alloc('invN', 50, 'CI-0002')])
    expect((await postReceipt('u_qs', 'r2')).status).toBe('posted')
  })

  it('the flag is STRICT: "true", 1 and a map are not activation', async () => {
    for (const v of ['true', 1, { on: true }]) {
      await activateCommercial(COMPANY_A, v)
      await expectTeamError(postRefund('u_qs', 'f1'), 'commercial-completion-not-activated')
    }
    expect(await data(refundRef('f1'))).toBeNull()
  })

  it('the GLOBAL switch stays the brake: switch off + active company is refused as disabled', async () => {
    fresh({ settlement: false })
    await expectTeamError(postRefund('u_qs', 'f1'), 'client-settlement-disabled')
  })

  it('a DEACTIVATION racing an operation in flight is ordered by the transaction: posted before it, or refused after it — never half', async () => {
    let pending = null
    hooks.afterRead = async ({ attempt }) => {
      if (attempt !== 1) return
      pending = company().set({ commercialCompletionEnabled: false }, { merge: true }).then(r => ({ ok: true, time: r.writeTime }), e => ({ ok: false, e }))
      await new Promise(r => setTimeout(r, 400))
    }
    const outcome = await postRefund('u_qs', 'f1').then(v => ({ posted: true, v }), e => ({ posted: false, e }))
    const write = await pending
    expect(write.ok).toBe(true)
    const snap = await refundRef('f1').get()
    if (outcome.posted) expect(write.time.valueOf() > snap.updateTime.valueOf()).toBe(true)
    else { expect(outcome.e.details.code).toBe('commercial-completion-not-activated'); expect(snap.exists).toBe(false) }
    hooks.afterRead = undefined
    await expectTeamError(postRefund('u_qs', 'f2'), 'commercial-completion-not-activated')
  })
})

describe('who may act, and the switches', () => {
  it('subcontractor, client, another tenant and the unauthenticated are refused; nothing is written', async () => {
    await seedUser({ uid: 'u_sub', email: 'sub@acme.test', role: 'subcontractor', companyId: COMPANY_A })
    await seedUser({ uid: 'u_client', email: 'c@acme.test', role: 'client', companyId: COMPANY_A })
    await seedCompany(COMPANY_B, 'Other')
    await activateCommercial(COMPANY_B)
    await seedUser({ uid: 'u_other', email: 'o@other.test', role: 'company_admin', companyId: COMPANY_B })
    for (const uid of ['u_sub', 'u_client']) {
      await expectTeamError(postRefund(uid, `f_${uid}`), 'client-finance-forbidden')
      await expectTeamError(postApp(uid, `a_${uid}`), 'client-finance-forbidden')
      await expectTeamError(voidInvoice(uid, 'invM'), 'client-finance-forbidden')
    }
    // Another company's admin: the project id resolves under THEIR company — not found or not activated, never our data.
    const other = await postRefund('u_other', 'f_o').catch(e => e)
    expect(['not-found', 'client-finance-not-activated']).toContain(other?.details?.code)
    await expectTeamError(H.postClientRefund(req(null, refundReq('f_anon'))), 'unauthenticated')
    expect(await data(receiptLedgerRef('r1'))).toBeNull()
  })
  it('a role withdrawn WHILE the request is in flight is ordered against it: the membership the transaction reads decides', async () => {
    let pending = null
    hooks.afterRead = async ({ attempt }) => {
      if (attempt !== 1) return
      // Not awaited: the write queues behind the transaction's read of the membership.
      pending = A.db.collection('users').doc('u_pm').update({ role: 'client' }).then(r => ({ ok: true, time: r.writeTime }), e => ({ ok: false, e }))
      await new Promise(r => setTimeout(r, 400))
    }
    const outcome = await postRefund('u_pm', 'f1').then(v => ({ posted: true, v }), e => ({ posted: false, e }))
    const write = await pending
    expect(write.ok).toBe(true)
    const refundSnap = await refundRef('f1').get()
    if (outcome.posted) {
      expect(write.time.valueOf() > refundSnap.updateTime.valueOf()).toBe(true)
    } else {
      expect(outcome.e.details.code).toBe('client-finance-forbidden')
      expect(refundSnap.exists).toBe(false)
      expect(await data(receiptLedgerRef('r1'))).toBeNull()
    }
  })
  it('the settlement switch OFF refuses refunds and applications; the invoice void follows the receipt switch', async () => {
    fresh({ settlement: false })
    await expectTeamError(postRefund('u_qs', 'f1'), 'client-settlement-disabled')
    await expectTeamError(postApp('u_qs', 'a1'), 'client-settlement-disabled')
    await expectTeamError(voidInvoice('u_qs', 'invM'), 'client-invoice-has-money')   // past its gate
    fresh({ receipts: false })
    await expectTeamError(voidInvoice('u_qs', 'invM'), 'client-receipt-disabled')
  })
  it('a company not activated for client finance is refused refunds and applications', async () => {
    await company().update({ clientFinanceEnabled: false })
    await expectTeamError(postRefund('u_qs', 'f1'), 'client-finance-not-activated')
    await expectTeamError(postApp('u_qs', 'a1'), 'client-finance-not-activated')
  })
  it('a tampered counter is refused (fail closed); the receipt counter is not involved', async () => {
    for (const [i, next] of [0, -1, 1.5, 'x', 1_000_000_000].entries()) {
      await company().collection('counters').doc('clientRefunds').set({ next })
      await expectTeamError(postRefund('u_qs', `fbad${i}`), 'client-settlement-counter-invalid')
    }
    expect(await data(receiptLedgerRef('r1'))).toBeNull()
  })
})
