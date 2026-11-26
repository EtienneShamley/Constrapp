import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  admin, resetEmulators, seedCompany, seedUser, req, expectTeamError, clock, silentLog, clientSignOutAll, COMPANY_A, COMPANY_B,
} from './_harness.js'
import {
  runClientCreditCreate, runClientReleaseCreate,
} from '../../src/lib/clientLedgerActions'
import { LEDGER_TOTAL_KEYS, ledgerRemainingCents, readLedger } from '../../src/lib/clientLedger'
import { issuedInvoice, draftReceipt } from '../fixtures/clientReceivableDocs'

// ── postClientReceipt / voidClientReceipt, and what they make possible ───────
// (ADR-89) — against the Auth + Firestore emulators, handlers called directly
// with the real Admin SDK.
//
// What is proven here:
//   · a receipt is posted only as EXACTLY the document the app writes, with its
//     totals re-derived and every allocated invoice checked;
//   · THE OVER-ALLOCATION POLICY is the server's: an allocation above what an
//     invoice is still owed needs an acknowledgement, so a receipt prepared in
//     a stale tab is never silently over-allocated;
//   · each posted allocation moves `receivedCents` in its invoice's ledger, and
//     a void takes exactly that back;
//   · A RELEASE VOID READS NO RECEIPT: with more than 5,000 unrelated posted
//     receipts in the project, every operation reads the same handful of
//     documents as with none;
//   · a receipt and a release void on one invoice are always ordered — the
//     state "release void AND more received than the invoice is owed" is never
//     produced without an acknowledgement;
//   · the two kill switches are independent.
//
// Every test here starts on a project whose historical receipt baseline is
// ALREADY established (as every project is after its first call). Receipts
// posted before the backend took over — the baseline itself, their voids,
// concurrent first calls — are in clientReceiptBaseline.test.js.

const PROJECT = 'projectA'
let A, handlersMod, baselineMod, H, now, hooks
const MARKER = `companies/${COMPANY_A}/projects/${PROJECT}/clientFinanceState/receiptBaseline`
// Which serial order each race took, for the record (printed after the run).
const BRANCHES = []
const took = (race, branch) => BRANCHES.push(`${race}: ${branch}`)

const company = (c = COMPANY_A) => A.db.collection('companies').doc(c)
const base = (c = COMPANY_A, p = PROJECT) => company(c).collection('projects').doc(p)
const invoiceRef = (id) => base().collection('clientInvoices').doc(id)
const ledgerRef = (id) => base().collection('clientInvoiceLedgers').doc(id)
const receiptRef = (id) => base().collection('clientReceipts').doc(id)
const creditRef = (id) => base().collection('clientCreditNotes').doc(id)
const releaseRef = (id) => base().collection('clientRetentionReleases').doc(id)
const data = (ref) => ref.get().then(s => (s.exists ? s.data() : null))
const ledger = (id) => data(ledgerRef(id))
const receipt = (id) => data(receiptRef(id))
const audits = async (type) => (await company().collection('auditEvents').get()).docs.map(d => d.data()).filter(e => (type ? e.type === type : e.type.startsWith('client_')))

const postReceipt = (uid, receiptId, acknowledgeOverAllocation = false) => H.postClientReceipt(req(uid, { projectId: PROJECT, receiptId, acknowledgeOverAllocation }))
const voidReceipt = (uid, receiptId, reason = 'Keyed twice') => H.voidClientReceipt(req(uid, { projectId: PROJECT, receiptId, reason }))
const postCredit = (uid, creditNoteId) => H.postClientCreditNote(req(uid, { projectId: PROJECT, creditNoteId }))
const voidCredit = (uid, creditNoteId, reason = 'Raised in error') => H.voidClientCreditNote(req(uid, { projectId: PROJECT, creditNoteId, reason }))
const postRelease = (uid, releaseId) => H.postClientRetentionRelease(req(uid, { projectId: PROJECT, releaseId }))
const voidRelease = (uid, releaseId, reason = 'Agreed in error') => H.voidClientRetentionRelease(req(uid, { projectId: PROJECT, releaseId, reason }))

async function fresh({ finance = true, receipts = true, receiptsAllCompanies = true, db = null, at = '2026-11-26T02:00:00Z' } = {}) {
  now = clock(at)
  hooks = {}
  H = handlersMod.createClientFinanceHandlers({ db: db ?? A.db, now, log: silentLog, config: () => ({ finance, receipts, receiptsAllCompanies }), hooks })
}

// The real database, recording every document a transaction READS: one entry
// per document for get / getAll, and every document a QUERY returned. Reset at
// the start of each attempt, so what remains is what the committed attempt read.
// `history` keeps one record per transaction attempt (never reset by a
// transaction): a callable runs TWO — the baseline check, then the operation.
function recordingDb() {
  const state = { reads: [], queries: 0, transactions: 0, history: [] }
  const db = new Proxy(A.db, {
    get(target, prop) {
      if (prop !== 'runTransaction') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v }
      return (fn, opts) => target.runTransaction((tx) => {
        state.reads = []
        state.queries = 0
        state.transactions += 1
        const record = { reads: [], queries: 0 }
        state.history.push(record)
        const recording = new Proxy(tx, {
          get(t, p) {
            const v = t[p]
            if (p === 'get') {
              return async (refOrQuery) => {
                const out = await t.get(refOrQuery)
                if (Array.isArray(out.docs)) { state.queries += 1; record.queries += 1; for (const d of out.docs) { state.reads.push(d.ref.path); record.reads.push(d.ref.path) } } else { state.reads.push(refOrQuery.path); record.reads.push(refOrQuery.path) }
                return out
              }
            }
            if (p === 'getAll') return async (...refs) => { for (const r of refs) { state.reads.push(r.path); record.reads.push(r.path) } return t.getAll(...refs) }
            return typeof v === 'function' ? v.bind(t) : v
          },
        })
        return fn(recording)
      }, opts)
    },
  })
  return { db, state }
}

const stamps = (uid = 'u_qs') => ({ createdAt: A.FieldValue.serverTimestamp(), createdBy: uid, updatedAt: A.FieldValue.serverTimestamp(), updatedBy: uid })
const alloc = (invoiceId, allocatedAmount, invoiceNumber = 'CI-0001') => ({ clientInvoiceId: invoiceId, invoiceNumber, allocatedAmount })
let receiptSeq = 0
async function draft(id, amount, allocations, over = {}) {
  receiptSeq += 1
  await receiptRef(id).set({ ...draftReceipt({ receiptNumber: `CR-${String(receiptSeq).padStart(4, '0')}`, amount, allocations, ...over }), ...stamps() })
}

async function seedInvoice(id, doc) {
  const rest = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'id'))
  await invoiceRef(id).set({ ...rest, createdAt: A.Timestamp.fromMillis(1_760_000_000_000), createdBy: 'seed' })
}
// A — 9,000.00 + 900.00 GST = 9,900.00; 900.00 (+ 90.00 GST) withheld → 8,910.00 receivable.
const seedA = (id = 'invA', over = {}) => seedInvoice(id, issuedInvoice({ subtotal: 9000, retention: 900, ...over }))
// N — the same billing with NO retention: 9,900.00 receivable.
const seedN = (id = 'invN', over = {}) => seedInvoice(id, issuedInvoice({ subtotal: 9000, invoiceNumber: 'CI-0002', ...over }))

// The app's own draft writes for credit notes and releases, over the Admin SDK.
const appSdk = (uid) => ({
  db: A.db, uid, serverTimestamp: () => A.FieldValue.serverTimestamp(),
  runTransaction: (db, fn) => db.runTransaction((tx) => fn({
    get: async (ref) => { const s = await tx.get(ref); return { id: s.id, exists: () => s.exists, data: () => s.data() } },
    set: (ref, value, options) => (options ? tx.set(ref, value, options) : tx.set(ref, value)),
    update: (ref, value) => tx.update(ref, value),
  })),
})
const noLock = async () => () => {}
const draftCredit = (id, invoiceId, amount) => runClientCreditCreate({
  ...appSdk('u_qs'), currency: 'AUD', counterRef: company().collection('counters').doc('clientCreditNotes'), creditRef: creditRef(id),
  invoiceRef: invoiceRef(invoiceId), ledgerRef: ledgerRef(invoiceId), stageCurrencyLock: noLock,
  input: { creditDate: '2026-11-20', reason: 'Over-billed', clientCreditReference: '', notes: '', rows: [{ invoiceLineIndex: 0, amount }] },
})
const draftRelease = (id, invoiceId, amount) => runClientReleaseCreate({
  ...appSdk('u_qs'), currency: 'AUD', counterRef: company().collection('counters').doc('clientRetentionReleases'), releaseRef: releaseRef(id),
  invoiceRef: invoiceRef(invoiceId), ledgerRef: ledgerRef(invoiceId), stageCurrencyLock: noLock,
  input: { releaseDate: '2026-11-21', reason: 'Practical completion', notes: '', amount },
})

const ZERO = Object.fromEntries(LEDGER_TOTAL_KEYS.map(k => [k, 0]))
const remaining = async (invoiceId) => ledgerRemainingCents({ id: invoiceId, ...(await data(invoiceRef(invoiceId))) }, readLedger(await ledger(invoiceId)))

async function dumpAll() {
  const out = new Map()
  const walk = async (collections) => {
    for (const col of collections) {
      for (const ref of await col.listDocuments()) {
        const snap = await ref.get()
        if (snap.exists) out.set(ref.path, JSON.stringify(snap.data()))
        await walk(await ref.listCollections())
      }
    }
  }
  await walk(await A.db.listCollections())
  return out
}
const changedPaths = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort()
async function refusedUnchanged(promise, code) {
  const before = await dumpAll()
  const err = await expectTeamError(promise(), code)
  expect(changedPaths(before, await dumpAll())).toEqual([])
  return err
}
const settle = async (calls) => {
  const results = await Promise.allSettled(Object.values(calls))
  return Object.fromEntries(Object.keys(calls).map((k, i) => [k, results[i].status === 'fulfilled' ? { ok: true, value: results[i].value } : { ok: false, code: results[i].reason?.details?.code ?? `UNTYPED:${results[i].reason?.message}`, details: results[i].reason?.details }]))
}

// The company ACTIVATED for credit notes and releases, the project, and its
// receipt baseline established (an empty one: no receipt exists yet).
async function seedProject() {
  await seedCompany(COMPANY_A, 'Acme Builders')
  await company().update({ clientFinanceEnabled: true })
  await base().set({ name: 'Harbour Road Units', currency: 'AUD', currencyLocked: true })
  expect(await baselineMod.ensureReceiptBaseline(A.db, { companyId: COMPANY_A, projectId: PROJECT, uid: 'seed' })).toEqual({ established: true, attempts: 1 })
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
  await fresh()
  await seedProject()
  await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
  await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A })
  await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A })
})
afterAll(async () => {
  await clientSignOutAll()
  process.stdout.write(`\nRACE BRANCHES TAKEN THIS RUN\n${BRANCHES.map(b => `  ${b}`).join('\n')}\n`)
})

// ── Posting ──────────────────────────────────────────────────────────────────

describe('posting a receipt', () => {
  it('one allocation: the receipt, ONE ledger and ONE audit event — exactly', async () => {
    await seedA()
    await draft('cr1', 5000, [alloc('invA', 4000)])
    const stored = await receipt('cr1')
    const before = await dumpAll()
    expect(await postReceipt('u_pm', 'cr1')).toEqual({ status: 'posted', receiptId: 'cr1', allocatedInvoiceIds: ['invA'], overAllocationAcknowledged: false, alreadyApplied: false, attempts: 1 })
    const changed = changedPaths(before, await dumpAll())
    expect(changed).toHaveLength(3)
    expect(changed).toEqual(expect.arrayContaining([receiptRef('cr1').path, ledgerRef('invA').path]))
    expect(await ledger('invA')).toEqual({
      seq: 1, lastEntryId: 'cr1', lastEntryKind: 'receipt', lines: {}, ...ZERO, receivedCents: 400000,
      createdAt: expect.any(A.Timestamp), createdBy: 'u_pm', updatedAt: expect.any(A.Timestamp), updatedBy: 'u_pm',
    })
    // Status, stamps and the server-written lookup array — nothing else of the receipt moves.
    expect(await receipt('cr1')).toEqual({ ...stored, status: 'posted', allocatedInvoiceIds: ['invA'], postedAt: expect.any(A.Timestamp), postedBy: 'u_pm', updatedAt: expect.any(A.Timestamp), updatedBy: 'u_pm' })
    const events = await audits('client_receipt.posted')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorUid: 'u_pm', source: 'callable', before: { status: 'draft' },
      after: {
        projectId: PROJECT, receiptId: 'cr1', number: 'CR-0001', status: 'posted', currency: 'AUD', clientId: 'c1', receiptDate: '2026-11-20',
        amountCents: 500000, allocatedCents: 400000, unallocatedCents: 100000,
        allocations: [{ invoiceId: 'invA', invoiceNumber: 'CI-0001', allocatedCents: 400000, receivedBeforeCents: 0, receivedAfterCents: 400000, seq: 1 }],
        overAllocationAcknowledged: false, overAllocated: [],
      },
    })
    expect(await remaining('invA')).toBe(491000)   // 8,910.00 receivable − 4,000.00
  })

  it('several invoices: one ledger write each; `allocatedInvoiceIds` sorted; a second receipt UPDATES the ledger', async () => {
    await seedA()
    await seedN()
    await draft('cr1', 3000, [alloc('invN', 2000, 'CI-0002'), alloc('invA', 1000)])
    expect((await postReceipt('u_qs', 'cr1')).allocatedInvoiceIds).toEqual(['invA', 'invN'])
    await draft('cr2', 500, [alloc('invA', 500)])
    await postReceipt('u_pm', 'cr2')
    expect(await ledger('invA')).toMatchObject({ seq: 2, lastEntryId: 'cr2', lastEntryKind: 'receipt', receivedCents: 150000, createdBy: 'u_qs', updatedBy: 'u_pm' })
    expect(await ledger('invN')).toMatchObject({ seq: 1, lastEntryId: 'cr1', receivedCents: 200000 })
    expect((await audits('client_receipt.posted')).find(e => e.after.receiptId === 'cr2').after.allocations).toEqual([
      { invoiceId: 'invA', invoiceNumber: 'CI-0001', allocatedCents: 50000, receivedBeforeCents: 100000, receivedAfterCents: 150000, seq: 2 },
    ])
  })

  it('a receipt with NO allocations posts with no ledger write', async () => {
    await seedA()
    await draft('cr1', 750, [])
    const before = await dumpAll()
    expect(await postReceipt('u_pm', 'cr1')).toMatchObject({ status: 'posted', allocatedInvoiceIds: [] })
    const changed = changedPaths(before, await dumpAll())
    expect(changed).toHaveLength(2)   // the receipt and its audit event
    expect(await ledger('invA')).toBeNull()
    expect(await receipt('cr1')).toMatchObject({ status: 'posted', allocatedInvoiceIds: [], unallocatedAmount: 750 })
    expect((await audits('client_receipt.posted'))[0].after).toMatchObject({ amountCents: 75000, allocatedCents: 0, unallocatedCents: 75000, allocations: [] })
  })

  it('a receipt already on an invoice with credit notes and a release: the ledger keeps every other figure', async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 300)
    await postRelease('u_pm', 'rr1')
    await draft('cr1', 100, [alloc('invA', 100)])
    await postReceipt('u_pm', 'cr1')
    expect(await ledger('invA')).toMatchObject({ seq: 2, ...ZERO, releasedRetentionCents: 30000, releasedRetentionGstCents: 3000, receivedCents: 10000, lastEntryKind: 'receipt' })
  })

  const FORGED = [
    ['an unknown key', () => ({ approved: true }), 'approved'],
    ['a pre-set allocatedInvoiceIds', () => ({ allocatedInvoiceIds: [] }), 'allocatedInvoiceIds'],
    ['a pre-set postedBy', () => ({ postedBy: 'u_admin' }), 'postedBy'],
    ['a pre-set voidReason', () => ({ voidReason: 'planted' }), 'voidReason'],
    ['a malformed number', () => ({ receiptNumber: 'CR-1' }), 'receiptNumber'],
    ['a date that is not YYYY-MM-DD', () => ({ receiptDate: '20/11/2026' }), 'receiptDate'],
    ['an unknown payment method', () => ({ paymentMethod: 'barter' }), 'paymentMethod'],
    ['a non-empty reserved field', () => ({ externalRefs: { xero: 'x' } }), 'externalRefs'],
    ['an amount of zero', () => ({ amount: 0, allocations: [], allocatedTotal: 0, unallocatedAmount: 0 }), 'amount'],
    ['a negative amount', () => ({ amount: -5000 }), 'amount'],
    ['an amount with a fraction of a cent', () => ({ amount: 5000.001 }), 'amount'],
    ['an allocated total that is not the sum of the allocations', () => ({ allocatedTotal: 3000, unallocatedAmount: 2000 }), 'allocatedTotal'],
    ['an unallocated amount that is not amount − allocated', () => ({ unallocatedAmount: 0 }), 'unallocatedAmount'],
    ['an allocation of zero', () => ({ allocations: [alloc('invA', 0)], allocatedTotal: 0, unallocatedAmount: 5000 }), 'allocations[0].allocatedAmount'],
    ['a negative allocation', () => ({ allocations: [alloc('invA', -4000)], allocatedTotal: -4000, unallocatedAmount: 9000 }), 'allocations[0].allocatedAmount'],
    ['the same invoice allocated twice', () => ({ allocations: [alloc('invA', 2000), alloc('invA', 2000)] }), 'allocations[1].clientInvoiceId'],
    ['allocations above the amount', () => ({ allocations: [alloc('invA', 5000.01)], allocatedTotal: 5000.01, unallocatedAmount: -0.01 }), 'allocations'],
    ['an allocation with an extra key', () => ({ allocations: [{ ...alloc('invA', 4000), settled: true }] }), 'allocations[0]'],
    ['a path-like invoice id', () => ({ allocations: [alloc('a/b', 4000)] }), 'allocations'],
    ['more than 100 allocations', () => ({ amount: 101, allocations: Array.from({ length: 101 }, (_x, i) => alloc(`inv${i}`, 1)), allocatedTotal: 101, unallocatedAmount: 0 }), 'allocations'],
  ]
  it.each(FORGED)('a draft that is not the document the app writes is refused, nothing written: %s', async (_label, forge, field) => {
    await seedA()
    await draft('cr1', 5000, [alloc('invA', 4000)])
    await receiptRef('cr1').update(forge())
    const err = await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_ENTRY_INVALID)
    expect(err.details.field).toBe(field)
    expect((await receipt('cr1')).status).toBe('draft')
    expect(await ledger('invA')).toBeNull()
  })
  it('a missing key is refused', async () => {
    await seedA()
    await draft('cr1', 5000, [alloc('invA', 4000)])
    await receiptRef('cr1').update({ attachments: A.FieldValue.delete() })
    expect((await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_ENTRY_INVALID)).details.field).toBe('attachments')
  })

  it('every allocated invoice is checked: missing, not issued, another client, another currency, a number that is not the invoice\'s', async () => {
    await seedA()
    await seedN()
    await draft('cr1', 5000, [alloc('invN', 1000, 'CI-0002'), alloc('invA', 4000)])
    const refused = async (code, check) => check((await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), code)).details)

    await invoiceRef('invA').update({ status: 'void' })
    await refused(A.CODE.CLIENT_INVOICE_NOT_ISSUED, d => expect(d).toMatchObject({ invoiceId: 'invA', invoiceNumber: 'CI-0001', invoiceStatus: 'void' }))
    await invoiceRef('invA').update({ status: 'draft' })
    await refused(A.CODE.CLIENT_INVOICE_NOT_ISSUED, d => expect(d.invoiceStatus).toBe('draft'))
    await invoiceRef('invA').update({ status: 'issued', clientId: 'c2' })
    await refused(A.CODE.CLIENT_INVOICE_MISMATCH, d => expect(d).toMatchObject({ invoiceId: 'invA', field: 'clientId' }))
    await invoiceRef('invA').update({ clientId: 'c1', currency: 'NZD' })
    await refused(A.CODE.CLIENT_INVOICE_MISMATCH, d => expect(d.field).toBe('currency'))
    await invoiceRef('invA').update({ currency: 'AUD', invoiceNumber: 'CI-0099' })
    await refused(A.CODE.CLIENT_INVOICE_MISMATCH, d => expect(d.field).toBe('invoiceNumber'))
    await invoiceRef('invA').delete()
    await refused(A.CODE.CLIENT_INVOICE_NOT_ISSUED, d => expect(d).toMatchObject({ invoiceId: 'invA', invoiceStatus: null }))
    // The other invoice was fine throughout — and was never written.
    expect(await ledger('invN')).toBeNull()
  })

  it('a receipt dated more than one day ahead of the server is refused; one day ahead (a timezone east of UTC) and any past date post', async () => {
    await seedA()
    await draft('cr1', 100, [alloc('invA', 100)], { receiptDate: '2026-11-28' })   // the server's date is 2026-11-26
    const err = await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_FUTURE_DATED)
    expect(err.details).toMatchObject({ receiptDate: '2026-11-28', latest: '2026-11-27' })
    await draft('cr2', 100, [alloc('invA', 100)], { receiptDate: '2026-11-27' })
    expect((await postReceipt('u_pm', 'cr2')).status).toBe('posted')
    await draft('cr3', 100, [alloc('invA', 100)], { receiptDate: '2019-03-01' })
    expect((await postReceipt('u_pm', 'cr3')).status).toBe('posted')
    // …and the refused one posts once the day arrives.
    now.set('2026-11-27T00:00:01Z')
    expect((await postReceipt('u_pm', 'cr1')).status).toBe('posted')
  })

  it('who may post: the same roles, the caller\'s company only', async () => {
    await seedA()
    await draft('cr1', 100, [alloc('invA', 100)])
    await seedUser({ uid: 'u_client', email: 'client@x.test', role: 'client', companyId: COMPANY_A })
    await seedCompany(COMPANY_B, 'Other Co')
    await seedUser({ uid: 'u_adminB', email: 'admin@other.test', role: 'company_admin', companyId: COMPANY_B })
    await refusedUnchanged(() => postReceipt('u_client', 'cr1'), A.CODE.CLIENT_FINANCE_FORBIDDEN)
    await refusedUnchanged(() => voidReceipt('u_client', 'cr1'), A.CODE.CLIENT_FINANCE_FORBIDDEN)
    await refusedUnchanged(() => postReceipt('u_adminB', 'cr1'), A.CODE.NOT_FOUND)
    await refusedUnchanged(() => voidReceipt('u_adminB', 'cr1'), A.CODE.NOT_FOUND)
    await expectTeamError(H.postClientReceipt(req(null, {})), A.CODE.UNAUTHENTICATED)
    await refusedUnchanged(() => postReceipt('u_pm', 'nope'), A.CODE.CLIENT_ENTRY_NOT_FOUND)
    for (const body of [{ projectId: PROJECT, receiptId: 'cr1' }, { projectId: PROJECT, receiptId: 'cr1', acknowledgeOverAllocation: 'true' }, { projectId: PROJECT, receiptId: 'cr1', acknowledgeOverAllocation: true, amount: 5 }, { projectId: PROJECT, receiptId: 'cr1', acknowledgeOverAllocation: true, companyId: COMPANY_A }]) {
      await refusedUnchanged(() => H.postClientReceipt(req('u_pm', body)), A.CODE.INVALID_ARGUMENT)
    }
    expect((await postReceipt('u_admin', 'cr1')).status).toBe('posted')
  })
})

// ── The over-allocation policy ───────────────────────────────────────────────

describe('over-allocating an invoice needs an acknowledgement — decided by the server', () => {
  it('exactly what is owed needs none; one cent more is refused naming the invoice, what remains and the excess', async () => {
    await seedA()
    await draft('cr1', 8910, [alloc('invA', 8910)])
    expect((await postReceipt('u_pm', 'cr1')).overAllocationAcknowledged).toBe(false)
    await draft('cr2', 0.01, [alloc('invA', 0.01)])
    const err = await refusedUnchanged(() => postReceipt('u_pm', 'cr2'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    expect(err.details.invoices).toEqual([{ invoiceId: 'invA', invoiceNumber: 'CI-0001', allocatedCents: 1, remainingCents: 0, excessCents: 1 }])
    expect(err.code).toBe('failed-precondition')
  })

  it('retention still held is NOT receivable: allocating it is an over-allocation until it is released', async () => {
    await seedA()
    await draft('cr1', 9900, [alloc('invA', 9900)])
    const err = await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    expect(err.details.invoices).toEqual([{ invoiceId: 'invA', invoiceNumber: 'CI-0001', allocatedCents: 990000, remainingCents: 891000, excessCents: 99000 }])
    await draftRelease('rr1', 'invA', 900)
    await postRelease('u_pm', 'rr1')
    expect((await postReceipt('u_pm', 'cr1')).overAllocationAcknowledged).toBe(false)
  })

  it('STALE TAB: a receipt prepared for the full balance, then a credit note is posted — refused without the acknowledgement, posted with it', async () => {
    await seedN()
    // The tab: the full 9,900.00 remaining, no warning shown, nothing acknowledged.
    await draft('cr1', 9900, [alloc('invN', 9900, 'CI-0002')])
    // Meanwhile, elsewhere: 1,000.00 + GST is credited.
    await draftCredit('cn1', 'invN', 1000)
    await postCredit('u_admin', 'cn1')

    const err = await refusedUnchanged(() => postReceipt('u_qs', 'cr1'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    expect(err.details.invoices).toEqual([{ invoiceId: 'invN', invoiceNumber: 'CI-0002', allocatedCents: 990000, remainingCents: 880000, excessCents: 110000 }])
    expect((await receipt('cr1')).status).toBe('draft')
    expect((await ledger('invN')).receivedCents).toBe(0)
    expect(await audits('client_receipt.posted')).toHaveLength(0)

    // Shown the new position, the user acknowledges it.
    expect(await postReceipt('u_qs', 'cr1', true)).toMatchObject({ status: 'posted', overAllocationAcknowledged: true })
    expect((await ledger('invN')).receivedCents).toBe(990000)
    // The invoice now shows 1,100.00 OWED TO THE CLIENT — reported, never clamped.
    expect(await remaining('invN')).toBe(-110000)
    expect((await audits('client_receipt.posted'))[0].after).toMatchObject({
      overAllocationAcknowledged: true, overAllocated: [{ invoiceId: 'invN', remainingCents: 880000, excessCents: 110000 }],
    })
  })

  it('STALE TAB: a receipt prepared against released retention, then the release is voided', async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 900)
    await postRelease('u_pm', 'rr1')
    await draft('cr1', 9900, [alloc('invA', 9900)])
    await voidRelease('u_pm', 'rr1')
    const err = await refusedUnchanged(() => postReceipt('u_qs', 'cr1'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    expect(err.details.invoices[0]).toMatchObject({ invoiceNumber: 'CI-0001', remainingCents: 891000, excessCents: 99000 })
  })

  it('an acknowledgement that was not needed changes nothing; several invoices are each named', async () => {
    await seedA()
    await seedN()
    await draft('cr1', 100, [alloc('invA', 100)])
    expect(await postReceipt('u_pm', 'cr1', true)).toMatchObject({ overAllocationAcknowledged: false })
    expect((await audits('client_receipt.posted'))[0].after.overAllocationAcknowledged).toBe(false)
    await draft('cr2', 30000, [alloc('invA', 10000), alloc('invN', 20000, 'CI-0002')])
    const err = await refusedUnchanged(() => postReceipt('u_pm', 'cr2'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    expect(err.details.invoices.map(i => [i.invoiceNumber, i.remainingCents, i.excessCents])).toEqual([['CI-0001', 881000, 119000], ['CI-0002', 990000, 1010000]])
  })

  it('a LEGITIMATE client credit balance (a credit note after the receipt) is not an invariant error and blocks only a further unacknowledged receipt', async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 900)
    await postRelease('u_pm', 'rr1')
    await draft('cr1', 9900, [alloc('invA', 9900)])
    await postReceipt('u_pm', 'cr1')
    // The credit posts: receipts are no ledger invariant.
    await draftCredit('cn1', 'invA', 1000)
    expect((await postCredit('u_pm', 'cn1')).status).toBe('posted')
    expect(await remaining('invA')).toBe(-110000)
    // A second credit note posts too, and one can be voided again.
    await draftCredit('cn2', 'invA', 500)
    expect((await postCredit('u_pm', 'cn2')).status).toBe('posted')
    expect((await voidCredit('u_pm', 'cn2')).status).toBe('void')
    // What it DOES block: more money allocated without saying so…
    await draft('cr2', 1, [alloc('invA', 1)])
    expect((await refusedUnchanged(() => postReceipt('u_pm', 'cr2'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)).details.invoices[0]).toMatchObject({ remainingCents: 0, excessCents: 100 })
    // …and taking the release back from under the receipt.
    const err = await refusedUnchanged(() => voidRelease('u_pm', 'rr1'), A.CODE.CLIENT_RECEIPTS_DEPEND)
    expect(err.details).toMatchObject({ receivedCents: 990000, receivableBasisAfterCents: 781000 })
    expect(err.details.blockingReceipts.map(x => x.number)).toEqual(['CR-0001'])
    // The receipt itself can always be voided, which clears the balance owed.
    expect((await voidReceipt('u_pm', 'cr1')).status).toBe('void')
    expect(await remaining('invA')).toBe(880000)
  })
})

// ── Voiding ──────────────────────────────────────────────────────────────────

describe('voiding a receipt', () => {
  it('a posted receipt: each ledger gives back exactly what it took; the receipt is stamped; one audit event', async () => {
    await seedA()
    await seedN()
    await draft('cr1', 3000, [alloc('invA', 1000), alloc('invN', 2000, 'CI-0002')])
    await draft('cr2', 400, [alloc('invA', 400)])
    await postReceipt('u_qs', 'cr1')
    await postReceipt('u_qs', 'cr2')
    const before = await dumpAll()
    expect(await voidReceipt('u_pm', 'cr1', '  Keyed twice ')).toEqual({ status: 'void', receiptId: 'cr1', alreadyApplied: false, attempts: 1 })
    const changed = changedPaths(before, await dumpAll())
    expect(changed).toHaveLength(4)   // the receipt, two ledgers, one audit event
    expect(await ledger('invA')).toMatchObject({ seq: 3, lastEntryId: 'cr1', lastEntryKind: 'receipt_void', receivedCents: 40000, updatedBy: 'u_pm' })
    expect(await ledger('invN')).toMatchObject({ seq: 2, lastEntryId: 'cr1', lastEntryKind: 'receipt_void', receivedCents: 0 })
    expect(await receipt('cr1')).toMatchObject({ status: 'void', voidedBy: 'u_pm', voidReason: 'Keyed twice', postedBy: 'u_qs', allocatedInvoiceIds: ['invA', 'invN'], amount: 3000 })
    const events = await audits('client_receipt.voided')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorUid: 'u_pm', before: { status: 'posted' },
      after: {
        receiptId: 'cr1', number: 'CR-0001', status: 'void', reason: 'Keyed twice', amountCents: 300000, ledgerMoved: true, fromBaseline: false,
        allocations: [
          { invoiceId: 'invA', allocatedCents: 100000, receivedBeforeCents: 140000, receivedAfterCents: 40000, seq: 3 },
          { invoiceId: 'invN', allocatedCents: 200000, receivedBeforeCents: 200000, receivedAfterCents: 0, seq: 2 },
        ],
      },
    })
  })

  it('the invoice need not still be issued, or exist', async () => {
    await seedA()
    await draft('cr1', 100, [alloc('invA', 100)])
    await postReceipt('u_qs', 'cr1')
    await invoiceRef('invA').update({ status: 'void' })
    expect((await voidReceipt('u_pm', 'cr1')).status).toBe('void')
    expect((await ledger('invA')).receivedCents).toBe(0)
  })

  it('a DRAFT is voided with no ledger write, and still one audit event', async () => {
    await seedA()
    await draft('cr1', 100, [alloc('invA', 100)])
    const before = await dumpAll()
    expect((await voidReceipt('u_pm', 'cr1')).status).toBe('void')
    expect(changedPaths(before, await dumpAll())).toHaveLength(2)
    expect(await ledger('invA')).toBeNull()
    expect((await audits('client_receipt.voided'))[0]).toMatchObject({ before: { status: 'draft' }, after: { ledgerMoved: false, fromBaseline: false, allocations: [] } })
    await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_ENTRY_NOT_DRAFT)
  })
})

// (Receipts posted BEFORE the backend took over — the historical baseline, their
// voids and the invoices they settle — are in clientReceiptBaseline.test.js.)

// ── Idempotent retries ───────────────────────────────────────────────────────

describe('idempotent retry of an uncertain outcome', () => {
  beforeEach(async () => { await seedA() })

  it('post: the same caller gets the same answer with one ledger movement and one audit event; another caller is refused', async () => {
    await draft('cr1', 8910, [alloc('invA', 8910)])
    const first = await postReceipt('u_pm', 'cr1')
    const before = await dumpAll()
    // The repeat is an ANSWER: it is not re-judged against the invoice it has itself filled.
    expect(await postReceipt('u_pm', 'cr1')).toEqual({ ...first, alreadyApplied: true })
    expect(await postReceipt('u_pm', 'cr1', true)).toEqual({ ...first, alreadyApplied: true })
    expect(changedPaths(before, await dumpAll())).toEqual([])
    await refusedUnchanged(() => postReceipt('u_admin', 'cr1'), A.CODE.CLIENT_ENTRY_NOT_DRAFT)
    expect(await ledger('invA')).toMatchObject({ seq: 1, receivedCents: 891000 })
    expect(await audits('client_receipt.posted')).toHaveLength(1)
  })

  it('void: same caller and reason → the same answer; another reason or caller → already void', async () => {
    await draft('cr1', 100, [alloc('invA', 100)])
    await postReceipt('u_pm', 'cr1')
    const first = await voidReceipt('u_pm', 'cr1', 'Keyed twice')
    const before = await dumpAll()
    expect(await voidReceipt('u_pm', 'cr1', ' Keyed twice ')).toEqual({ ...first, alreadyApplied: true })
    expect(changedPaths(before, await dumpAll())).toEqual([])
    await refusedUnchanged(() => voidReceipt('u_pm', 'cr1', 'Something else'), A.CODE.CLIENT_ENTRY_NOT_POSTED)
    await refusedUnchanged(() => voidReceipt('u_admin', 'cr1', 'Keyed twice'), A.CODE.CLIENT_ENTRY_NOT_POSTED)
    await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_ENTRY_NOT_DRAFT)
    expect(await ledger('invA')).toMatchObject({ seq: 2, receivedCents: 0 })
    expect(await audits('client_receipt.voided')).toHaveLength(1)
  })

  it('contention on every attempt is a typed busy with nothing written; a timeout is rethrown untyped and a retry is safe', async () => {
    await draft('cr1', 100, [alloc('invA', 100)])
    hooks.afterRead = async () => { throw Object.assign(new Error('contention'), { code: 10 }) }
    expect((await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_FINANCE_BUSY)).details.attempts).toBe(5)
    hooks.afterRead = async () => { throw Object.assign(new Error('deadline exceeded'), { code: 4 }) }
    const err = await postReceipt('u_pm', 'cr1').then(() => null, e => e)
    expect(err.details?.code).toBeUndefined()
    hooks.afterRead = undefined
    expect((await postReceipt('u_pm', 'cr1')).alreadyApplied).toBe(false)
    expect((await postReceipt('u_pm', 'cr1')).alreadyApplied).toBe(true)
    expect(await audits('client_receipt.posted')).toHaveLength(1)
  })
})

// ── The two kill switches ────────────────────────────────────────────────────

describe('the two switches are independent', () => {
  beforeEach(async () => {
    await seedA()
    await draft('cr1', 100, [alloc('invA', 100)])
    await draftCredit('cn1', 'invA', 100)
    await draftRelease('rr1', 'invA', 100)
  })

  it('receipts ON, credit notes and releases OFF (the staged production start): receipts post and void; the other four answer "temporarily unavailable"', async () => {
    await fresh({ finance: false, receipts: true })
    expect((await postReceipt('u_pm', 'cr1')).status).toBe('posted')
    for (const run of [() => postCredit('u_pm', 'cn1'), () => voidCredit('u_pm', 'cn1'), () => postRelease('u_pm', 'rr1'), () => voidRelease('u_pm', 'rr1')]) {
      const err = await refusedUnchanged(run, A.CODE.CLIENT_FINANCE_DISABLED)
      expect(err.message).toBe('Posting and voiding client credit notes and retention releases is temporarily unavailable. Nothing was changed.')
      expect(err.code).toBe('unavailable')
    }
    expect((await voidReceipt('u_pm', 'cr1')).status).toBe('void')
    expect((await data(creditRef('cn1'))).status).toBe('draft')
  })

  it('the reverse: credit notes and releases work; receipts answer their own "temporarily unavailable"', async () => {
    await fresh({ finance: true, receipts: false })
    for (const run of [() => postReceipt('u_pm', 'cr1'), () => voidReceipt('u_pm', 'cr1')]) {
      const err = await refusedUnchanged(run, A.CODE.CLIENT_RECEIPT_DISABLED)
      expect(err.message).toBe('Posting and voiding client receipts is temporarily unavailable. Nothing was changed.')
    }
    expect((await postCredit('u_pm', 'cn1')).status).toBe('posted')
    expect((await receipt('cr1')).status).toBe('draft')
  })
})

// ── What is read, and what is written ────────────────────────────────────────

describe('a growing project never loses the ability to post or void', () => {
  // Posted receipts that have NOTHING to do with the invoice under test, exactly
  // as a busy project accumulates them: allocated to other invoices (with and
  // without the lookup array) or unallocated.
  async function seedUnrelatedReceipts(count) {
    for (let start = 0; start < count; start += 400) {
      const batch = A.db.batch()
      for (let i = start; i < Math.min(count, start + 400); i += 1) {
        const allocations = i % 3 === 0 ? [] : [alloc(`other${i % 7}`, 10, 'CI-9000')]
        batch.set(receiptRef(`bulk${i}`), {
          ...draftReceipt({ receiptNumber: `CR-${String(10000 + i)}`, amount: 10, allocations }),
          status: 'posted', postedBy: 'seed', createdAt: A.Timestamp.fromMillis(1_761_000_000_000 + i),
          ...(i % 2 === 0 ? { allocatedInvoiceIds: allocations.map(a => a.clientInvoiceId) } : {}),
        })
      }
      await batch.commit()
    }
  }

  // The four operations on the invoice under test, with every document each
  // of its transactions read: the baseline check, then the operation itself.
  async function measure() {
    const { db, state } = recordingDb()
    await fresh({ db })
    const run = async (operation) => {
      const from = state.history.length
      const t0 = Date.now()
      await operation()
      const ms = Date.now() - t0
      const transactions = state.history.slice(from)
      return { transactions: transactions.length, ensure: transactions[0], reads: [...transactions.at(-1).reads].sort(), queries: transactions.at(-1).queries, ms }
    }
    await seedA()
    await draftRelease('rr1', 'invA', 900)
    await run(() => postRelease('u_pm', 'rr1'))
    await draftCredit('cn1', 'invA', 100)
    await run(() => postCredit('u_pm', 'cn1'))
    await draft('cr1', 500, [alloc('invA', 500)])
    const out = {}
    out.postReceipt = await run(() => postReceipt('u_pm', 'cr1'))
    out.voidCredit = await run(() => voidCredit('u_pm', 'cn1'))
    out.voidRelease = await run(() => voidRelease('u_pm', 'rr1'))
    out.voidReceipt = await run(() => voidReceipt('u_pm', 'cr1'))
    return out
  }

  it('with MORE THAN 5,000 unrelated posted receipts and the baseline already established, each operation reads the same few documents as with none — and succeeds', async () => {
    const empty = await measure()
    await resetEmulators()
    // The baseline is established FIRST (as on any live project), then the register grows.
    await seedProject()
    await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A })
    await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A })
    await seedUnrelatedReceipts(5200)
    expect((await base().collection('clientReceipts').count().get()).data().count).toBe(5200)
    receiptSeq = 0
    const full = await measure()

    const P = `companies/${COMPANY_A}/projects/${PROJECT}`
    // The caller, the company, the project and the project's receipt-baseline marker.
    const caller = ['users/u_pm', `companies/${COMPANY_A}`, P, MARKER]
    const expected = {
      postReceipt: [...caller, `${P}/clientReceipts/cr1`, `${P}/clientInvoices/invA`, `${P}/clientInvoiceLedgers/invA`],
      voidCredit: [...caller, `${P}/clientCreditNotes/cn1`, `${P}/clientInvoices/invA`, `${P}/clientInvoiceLedgers/invA`],
      voidRelease: [...caller, `${P}/clientRetentionReleases/rr1`, `${P}/clientInvoices/invA`, `${P}/clientInvoiceLedgers/invA`],
      voidReceipt: [...caller, `${P}/clientReceipts/cr1`, `${P}/clientInvoiceLedgers/invA`],
    }
    for (const op of Object.keys(expected)) {
      // The SAME documents, by path, with 5,200 receipts as with none; no query at all.
      expect(full[op].reads, op).toEqual([...expected[op]].sort())
      expect(empty[op].reads, op).toEqual(full[op].reads)
      expect(full[op].queries, op).toBe(0)
      expect(full[op].reads.some(p => p.includes('/clientReceipts/bulk')), op).toBe(false)
      // Before it, ONE more transaction: the baseline check — the marker alone, no query, whatever the register holds.
      for (const m of [empty, full]) {
        expect(m[op].transactions, op).toBe(2)
        expect(m[op].ensure, op).toEqual({ reads: [MARKER], queries: 0 })
      }
    }
    process.stdout.write(`\nREADS PER OPERATION TRANSACTION (documents) — empty register vs 5,200 unrelated posted receipts (emulator only)\n${Object.keys(expected).map(op => `  ${op}: ${empty[op].reads.length} vs ${full[op].reads.length} documents, 0 queries (+ 1 marker read by the baseline check before it); ${empty[op].ms} ms vs ${full[op].ms} ms`).join('\n')}\n`)
    expect((await data(releaseRef('rr1'))).status).toBe('void')
  }, 240000)

  it('a refused release void on that project still names its blocking receipt, by an indexed lookup — not a scan', async () => {
    await seedUnrelatedReceipts(1200)
    await seedA()
    await draftRelease('rr1', 'invA', 900)
    await postRelease('u_pm', 'rr1')
    await draft('cr1', 9900, [alloc('invA', 9900)])
    await postReceipt('u_pm', 'cr1')
    const err = await expectTeamError(voidRelease('u_pm', 'rr1'), A.CODE.CLIENT_RECEIPTS_DEPEND)
    expect(err.details.blockingReceipts).toEqual([{ number: 'CR-0001', id: 'cr1', allocatedCents: 990000, postedAt: expect.any(String) }])
  }, 120000)

  it('the callables write nothing but the receipt, the allocated invoices\' ledgers and the audit event', async () => {
    await seedA()
    await seedN()
    await seedInvoice('invX', issuedInvoice({ subtotal: 100, invoiceNumber: 'CI-0003' }))
    await base().collection('budgetLines').doc('bl1').set({ costCodeId: 'cc1', budgeted: 100 })
    await draftCredit('cn1', 'invA', 100)
    await draft('cr0', 50, [alloc('invX', 50, 'CI-0003')])
    await draft('cr1', 3000, [alloc('invA', 1000), alloc('invN', 2000, 'CI-0002')])
    const before = await dumpAll()
    await postReceipt('u_pm', 'cr1')
    await voidReceipt('u_pm', 'cr1')
    const changed = changedPaths(before, await dumpAll())
    const allowed = [/\/clientReceipts\/cr1$/, /\/clientInvoiceLedgers\/inv[AN]$/, /^companies\/companyA\/auditEvents\/[^/]+$/]
    expect(changed.filter(p => !allowed.some(re => re.test(p)))).toEqual([])
    expect(changed).toHaveLength(5)
  })
})

// ── Concurrency ──────────────────────────────────────────────────────────────

describe('a receipt and a release void on one invoice are always ordered', () => {
  // All 900.00 released: 9,900.00 receivable. Without the release: 8,910.00.
  beforeEach(async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 900)
    await postRelease('u_pm', 'rr1')
  })

  // The state that must never exist without an acknowledgement.
  async function assertConsistent() {
    const l = await ledger('invA')
    const voided = (await data(releaseRef('rr1'))).status === 'void'
    const basis = voided ? 891000 : 990000
    expect(l.receivedCents <= basis, `release ${voided ? 'void' : 'posted'}, received ${l.receivedCents}, basis ${basis}`).toBe(true)
    return { voided, receivedCents: l.receivedCents }
  }

  it('receipt post ∥ release void: never "the void committed AND more is received than the invoice is owed"', async () => {
    await draft('cr1', 9900, [alloc('invA', 9900)])
    const r = await settle({ receipt: postReceipt('u_qs', 'cr1'), release: voidRelease('u_pm', 'rr1') })
    const state = await assertConsistent()
    // Exactly one of them lands: each makes the other impossible.
    expect([r.receipt.ok, r.release.ok].filter(Boolean)).toHaveLength(1)
    if (r.receipt.ok) {
      expect(r.release.code).toBe(A.CODE.CLIENT_RECEIPTS_DEPEND)
      expect(r.release.details.blockingReceipts.map(x => x.id)).toEqual(['cr1'])
      expect(state).toEqual({ voided: false, receivedCents: 990000 })
      took('receipt post ∥ release void', 'the receipt landed; the void was refused naming it')
    } else {
      expect(r.receipt.code).toBe(A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
      expect(r.receipt.details.invoices[0]).toMatchObject({ remainingCents: 891000, excessCents: 99000 })
      expect(state).toEqual({ voided: true, receivedCents: 0 })
      expect((await receipt('cr1')).status).toBe('draft')
      took('receipt post ∥ release void', 'the void landed; the receipt was refused for want of an acknowledgement')
    }
  })

  it('a draft receipt AMENDED and then posted ∥ release void', async () => {
    await draft('cr1', 5000, [alloc('invA', 5000)])
    // The amendment a user makes in the editor: now the full 9,900.00.
    await receiptRef('cr1').update({ amount: 9900, allocations: [alloc('invA', 9900)], allocatedTotal: 9900, unallocatedAmount: 0, updatedAt: A.FieldValue.serverTimestamp() })
    const r = await settle({ receipt: postReceipt('u_qs', 'cr1'), release: voidRelease('u_pm', 'rr1') })
    const state = await assertConsistent()
    expect([r.receipt.ok, r.release.ok].filter(Boolean)).toHaveLength(1)
    // What was posted is the AMENDED receipt, never the earlier 5,000.00.
    if (r.receipt.ok) expect(state.receivedCents).toBe(990000)
    took('amended receipt post ∥ release void', r.receipt.ok ? 'the receipt landed (9,900.00); the void was refused' : 'the void landed; the receipt was refused')
  })

  it('a receipt that FITS without the release ∥ release void: both land', async () => {
    await draft('cr1', 8910, [alloc('invA', 8910)])
    const r = await settle({ receipt: postReceipt('u_qs', 'cr1'), release: voidRelease('u_pm', 'rr1') })
    expect(r.receipt.ok && r.release.ok).toBe(true)
    expect(await assertConsistent()).toEqual({ voided: true, receivedCents: 891000 })
    expect((await ledger('invA')).seq).toBe(3)
    took('fitting receipt post ∥ release void', `both landed (${(await ledger('invA')).lastEntryKind} second)`)
  })

  it('receipt void ∥ release void: the receipt void always lands; the release void lands when ordered after it', async () => {
    await draft('cr1', 9900, [alloc('invA', 9900)])
    await postReceipt('u_qs', 'cr1')
    const r = await settle({ receipt: voidReceipt('u_qs', 'cr1'), release: voidRelease('u_pm', 'rr1') })
    expect(r.receipt.ok).toBe(true)
    const state = await assertConsistent()
    expect(state.receivedCents).toBe(0)
    if (r.release.ok) {
      expect(state.voided).toBe(true)
      took('receipt void ∥ release void', 'both landed (the release void ordered after the receipt void)')
    } else {
      expect(r.release.code).toBe(A.CODE.CLIENT_RECEIPTS_DEPEND)
      expect(state.voided).toBe(false)
      // …and the same request now succeeds.
      expect((await voidRelease('u_pm', 'rr1')).status).toBe('void')
      took('receipt void ∥ release void', 'the receipt void landed; the release void was ordered first and refused, then succeeded on a repeat')
    }
  })
})

describe('receipts racing other postings on one invoice', () => {
  it('credit-note post ∥ receipt post: both land only when the receipt was ordered FIRST — never a silent over-allocation', async () => {
    await seedN()
    await draftCredit('cn1', 'invN', 1000)
    await draft('cr1', 9900, [alloc('invN', 9900, 'CI-0002')])
    const r = await settle({ credit: postCredit('u_pm', 'cn1'), receipt: postReceipt('u_qs', 'cr1') })
    expect(r.credit.ok).toBe(true)   // a credit note is never blocked by a receipt
    const l = await ledger('invN')
    if (r.receipt.ok) {
      // The receipt saw the invoice BEFORE the credit: 9,900.00 was owed, nothing to acknowledge.
      const posted = (await audits('client_receipt.posted'))[0].after
      const credited = (await audits('client_credit_note.posted'))[0].after
      expect(posted.overAllocationAcknowledged).toBe(false)
      expect(posted.allocations[0].seq).toBe(1)
      expect(credited.seq).toBe(2)
      expect(l).toMatchObject({ seq: 2, receivedCents: 990000, creditedSubtotalCents: 100000 })
      took('credit-note post ∥ receipt post', 'both landed, the receipt first (a legitimate balance owed to the client)')
    } else {
      expect(r.receipt.code).toBe(A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
      expect(r.receipt.details.invoices[0]).toMatchObject({ remainingCents: 880000, excessCents: 110000 })
      expect(l).toMatchObject({ seq: 1, receivedCents: 0, creditedSubtotalCents: 100000 })
      expect((await receipt('cr1')).status).toBe('draft')
      took('credit-note post ∥ receipt post', 'the credit note landed first; the receipt was refused for want of an acknowledgement')
    }
  })

  it('two receipts ∥ that cannot both fit: exactly one lands', async () => {
    await seedN()
    await draft('cr1', 6000, [alloc('invN', 6000, 'CI-0002')])
    await draft('cr2', 6000, [alloc('invN', 6000, 'CI-0002')])
    const r = await settle({ a: postReceipt('u_qs', 'cr1'), b: postReceipt('u_pm', 'cr2') })
    expect([r.a.ok, r.b.ok].filter(Boolean)).toHaveLength(1)
    const lost = r.a.ok ? r.b : r.a
    expect(lost.code).toBe(A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    expect(lost.details.invoices[0]).toMatchObject({ remainingCents: 390000, excessCents: 210000 })
    expect(await ledger('invN')).toMatchObject({ seq: 1, receivedCents: 600000 })
    expect(await audits('client_receipt.posted')).toHaveLength(1)
    took('two receipts ∥ (cannot both fit)', `${r.a.ok ? 'cr1' : 'cr2'} landed; the other was refused`)
  })

  it('two receipts ∥ that both fit: both land, at seq 1 and 2, and the received figure is their sum', async () => {
    await seedN()
    await draft('cr1', 4000, [alloc('invN', 4000, 'CI-0002')])
    await draft('cr2', 5000, [alloc('invN', 5000, 'CI-0002')])
    const r = await settle({ a: postReceipt('u_qs', 'cr1'), b: postReceipt('u_pm', 'cr2') })
    expect(r.a.ok && r.b.ok).toBe(true)
    expect(await ledger('invN')).toMatchObject({ seq: 2, receivedCents: 900000 })
    const seqs = (await audits('client_receipt.posted')).map(e => e.after.allocations[0].seq).sort()
    expect(seqs).toEqual([1, 2])
    took('two receipts ∥ (both fit)', 'both landed')
  })

  it('the SAME receipt posted twice at once: one ledger movement, one audit event', async () => {
    await seedN()
    await draft('cr1', 4000, [alloc('invN', 4000, 'CI-0002')])
    const r = await settle({ a: postReceipt('u_qs', 'cr1'), b: postReceipt('u_qs', 'cr1'), c: postReceipt('u_pm', 'cr1') })
    expect(r.a.ok && r.b.ok).toBe(r.c.ok === false)   // the same caller twice, OR the other caller — never both
    expect(await ledger('invN')).toMatchObject({ seq: 1, receivedCents: 400000 })
    expect(await audits('client_receipt.posted')).toHaveLength(1)
    for (const x of [r.a, r.b, r.c]) if (!x.ok) expect(x.code).toBe(A.CODE.CLIENT_ENTRY_NOT_DRAFT)
  })
})
