import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  admin, resetEmulators, seedCompany, seedUser, req, expectTeamError, clock, silentLog, clientSignIn, clientSignOutAll, callFunction,
  COMPANY_A, COMPANY_B,
} from './_harness.js'
import { runClientCreditCreate, runClientReleaseCreate } from '../../src/lib/clientLedgerActions'
import { LEDGER_TOTAL_KEYS, ledgerRemainingCents, readLedger } from '../../src/lib/clientLedger'
import { invoiceTotals } from '../../src/lib/clientInvoices'
import { CLIENT_RECEIPT_KEYS } from '../../src/lib/clientEntryShape'
import { toCents, gstExact, MAX_SUPPORTED_AMOUNT_CENTS, MAX_SUPPORTED_RECEIPT_CENTS } from '../../src/lib/money'
import { issuedInvoice, draftReceipt } from '../fixtures/clientReceivableDocs'

// ── The historical receipt baseline, company activation and the supported
// monetary range (ADR-89, final pass) — against the Auth + Firestore (+
// Functions) emulators, handlers called directly with the real Admin SDK.
//
// A "legacy" receipt here is EXACTLY what the released browser build wrote
// when it posted a receipt itself: the 28-key document, `status: 'posted'`,
// its stamps — and no `allocatedInvoiceIds`.
//
// What is proven here:
//   · `receivedCents` is EXACT on an invoice with history: the first call on a
//     project brings every legacy posted receipt into the invoice ledgers,
//     once, atomically, and records that it did;
//   · a missing baseline is never read as zero: without the marker every
//     operation is refused, and a history that cannot be read strictly is
//     refused whole, naming the receipt;
//   · a legacy receipt's void takes its allocations back out, exactly once;
//   · concurrent first calls produce one marker, one audit event, one baseline;
//   · credit notes and retention releases act only for an ACTIVATED company;
//   · the server refuses amounts above the supported range, and a ledger
//     figure that is not a whole, non-negative, safe number of cents.

const PROJECT = 'projectA'
let A, handlersMod, baselineMod, txMod, receiptsMod, H, now, hooks, deps
const OUTCOMES = []
const noted = (what, outcome) => OUTCOMES.push(`${what}: ${outcome}`)

const company = (c = COMPANY_A) => A.db.collection('companies').doc(c)
const base = (c = COMPANY_A, p = PROJECT) => company(c).collection('projects').doc(p)
const invoiceRef = (id, c) => base(c).collection('clientInvoices').doc(id)
const ledgerRef = (id, c) => base(c).collection('clientInvoiceLedgers').doc(id)
const receiptRef = (id, c) => base(c).collection('clientReceipts').doc(id)
const creditRef = (id, c) => base(c).collection('clientCreditNotes').doc(id)
const releaseRef = (id, c) => base(c).collection('clientRetentionReleases').doc(id)
const markerRef = (c, p) => base(c, p).collection('clientFinanceState').doc('receiptBaseline')
const data = (ref) => ref.get().then(s => (s.exists ? s.data() : null))
const ledger = (id, c) => data(ledgerRef(id, c))
const receipt = (id) => data(receiptRef(id))
const marker = (c, p) => data(markerRef(c, p))
const audits = async (type, c = COMPANY_A) => (await company(c).collection('auditEvents').get()).docs.map(d => d.data()).filter(e => e.type === type)
const BASELINE = 'client_receipt.baseline_established'

const postReceipt = (uid, receiptId, acknowledgeOverAllocation = false) => H.postClientReceipt(req(uid, { projectId: PROJECT, receiptId, acknowledgeOverAllocation }))
const voidReceipt = (uid, receiptId, reason = 'Keyed twice') => H.voidClientReceipt(req(uid, { projectId: PROJECT, receiptId, reason }))
const postCredit = (uid, creditNoteId) => H.postClientCreditNote(req(uid, { projectId: PROJECT, creditNoteId }))
const voidCredit = (uid, creditNoteId, reason = 'Raised in error') => H.voidClientCreditNote(req(uid, { projectId: PROJECT, creditNoteId, reason }))
const postRelease = (uid, releaseId) => H.postClientRetentionRelease(req(uid, { projectId: PROJECT, releaseId }))
const voidRelease = (uid, releaseId, reason = 'Agreed in error') => H.voidClientRetentionRelease(req(uid, { projectId: PROJECT, releaseId, reason }))
const ensure = (uid = 'u_admin', c = COMPANY_A, p = PROJECT, db = A.db) => baselineMod.ensureReceiptBaseline(db, { companyId: c, projectId: p, uid }, { now })

function fresh({ finance = true, receipts = true, receiptsAllCompanies = true, db = null } = {}) {
  now = clock('2026-11-26T02:00:00Z')
  hooks = {}
  deps = { db: db ?? A.db, now, log: silentLog, config: () => ({ finance, receipts, receiptsAllCompanies }), hooks }
  H = handlersMod.createClientFinanceHandlers(deps)
}

// The real database, recording — per transaction — every document read (get /
// getAll, and every document a query returned) and every document written.
function recordingDb() {
  const state = { transactions: [] }
  const db = new Proxy(A.db, {
    get(target, prop) {
      if (prop !== 'runTransaction') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v }
      return (fn, opts) => target.runTransaction((tx) => {
        const record = { reads: [], queries: 0, writes: [] }
        state.transactions.push(record)
        const recording = new Proxy(tx, {
          get(t, p) {
            const v = t[p]
            if (p === 'get') {
              return async (refOrQuery) => {
                const out = await t.get(refOrQuery)
                if (Array.isArray(out.docs)) { record.queries += 1; for (const d of out.docs) record.reads.push(d.ref.path) } else record.reads.push(refOrQuery.path)
                return out
              }
            }
            if (p === 'getAll') return async (...refs) => { for (const r of refs) record.reads.push(r.path); return t.getAll(...refs) }
            if (['create', 'update', 'set', 'delete'].includes(p)) return (ref, ...rest) => { record.writes.push(ref.path); return v.call(t, ref, ...rest) }
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
const alloc = (invoiceId, allocatedAmount, invoiceNumber = 'CI-0002') => ({ clientInvoiceId: invoiceId, invoiceNumber, allocatedAmount })
let receiptSeq = 0
const nextNumber = () => { receiptSeq += 1; return `CR-${String(receiptSeq).padStart(4, '0')}` }
// A draft, as the app writes one.
const draft = (id, amount, allocations, over = {}) => receiptRef(id).set({ ...draftReceipt({ receiptNumber: nextNumber(), amount, allocations, ...over }), ...stamps() })
// A LEGACY POSTED receipt: the same 28 keys, posted by the browser itself.
const legacyDoc = (amount, allocations, over = {}) => ({
  ...draftReceipt({ receiptNumber: nextNumber(), amount, allocations }),
  status: 'posted', postedAt: A.FieldValue.serverTimestamp(), postedBy: 'u_qs', ...stamps(), ...over,
})
const legacy = (id, amount, allocations = [alloc('invN', amount)], over = {}) => receiptRef(id).set(legacyDoc(amount, allocations, over))

async function seedInvoice(id, doc, c) {
  const rest = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'id'))
  await invoiceRef(id, c).set({ ...rest, createdAt: A.Timestamp.fromMillis(1_760_000_000_000), createdBy: 'seed' })
}
// A — 9,000.00 + 900.00 GST = 9,900.00; 900.00 (+ 90.00 GST) withheld → 8,910.00 receivable.
const seedA = (id = 'invA', over = {}) => seedInvoice(id, issuedInvoice({ subtotal: 9000, retention: 900, ...over }))
// N — the same billing with NO retention: 9,900.00 receivable.
const seedN = (id = 'invN', over = {}) => seedInvoice(id, issuedInvoice({ subtotal: 9000, invoiceNumber: 'CI-0002', ...over }))

const appSdk = (uid) => ({
  db: A.db, uid, serverTimestamp: () => A.FieldValue.serverTimestamp(),
  runTransaction: (db, fn) => db.runTransaction((tx) => fn({
    get: async (ref) => { const s = await tx.get(ref); return { id: s.id, exists: () => s.exists, data: () => s.data() } },
    set: (ref, value, options) => (options ? tx.set(ref, value, options) : tx.set(ref, value)),
    update: (ref, value) => tx.update(ref, value),
  })),
})
const noLock = async () => () => {}
const draftCredit = (id, invoiceId, amount, c) => runClientCreditCreate({
  ...appSdk('u_qs'), currency: 'AUD', counterRef: company(c).collection('counters').doc('clientCreditNotes'), creditRef: creditRef(id, c),
  invoiceRef: invoiceRef(invoiceId, c), ledgerRef: ledgerRef(invoiceId, c), stageCurrencyLock: noLock,
  input: { creditDate: '2026-11-20', reason: 'Over-billed', clientCreditReference: '', notes: '', rows: [{ invoiceLineIndex: 0, amount }] },
})
const draftRelease = (id, invoiceId, amount, c) => runClientReleaseCreate({
  ...appSdk('u_qs'), currency: 'AUD', counterRef: company(c).collection('counters').doc('clientRetentionReleases'), releaseRef: releaseRef(id, c),
  invoiceRef: invoiceRef(invoiceId, c), ledgerRef: ledgerRef(invoiceId, c), stageCurrencyLock: noLock,
  input: { releaseDate: '2026-11-21', reason: 'Practical completion', notes: '', amount },
})

const ZERO = Object.fromEntries(LEDGER_TOTAL_KEYS.map(k => [k, 0]))
const remaining = async (invoiceId) => ledgerRemainingCents({ id: invoiceId, ...(await data(invoiceRef(invoiceId))) }, readLedger(await ledger(invoiceId)))
const baselineOf = (legacyCents, legacyReceipts) => ({ legacyCents, legacyReceipts, establishedAt: expect.any(A.Timestamp) })

// THE INDEPENDENT CHECK. What every invoice has received, summed from the
// posted receipts THEMSELVES — the project-wide scan the callables must never
// need — against what the ledgers say. Exact equality, both directions.
async function ledgersAgreeWithReceipts() {
  const expected = {}
  for (const d of (await base().collection('clientReceipts').where('status', '==', 'posted').get()).docs) {
    for (const a of d.data().allocations) expected[a.clientInvoiceId] = (expected[a.clientInvoiceId] ?? 0) + toCents(a.allocatedAmount)
  }
  const stored = {}
  for (const d of (await base().collection('clientInvoiceLedgers').get()).docs) if (d.data().receivedCents !== 0) stored[d.id] = d.data().receivedCents
  expect(stored).toEqual(expected)
  return expected
}

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

async function seedCompanyA() {
  await seedCompany(COMPANY_A, 'Acme Builders')
  await company().update({ clientFinanceEnabled: true })
  await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
  await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A })
  await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A })
  await base().set({ name: 'Harbour Road Units', currency: 'AUD', currencyLocked: true })
}

beforeAll(async () => {
  A = await admin()
  handlersMod = await import('../../functions/src/clientFinance/handlers.js')
  baselineMod = await import('../../functions/src/clientFinance/baseline.js')
  txMod = await import('../../functions/src/clientFinance/transactions.js')
  receiptsMod = await import('../../functions/src/clientFinance/receipts.js')
})
// NOTE: no baseline is established here — every test starts on a project the
// backend has never touched.
beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  receiptSeq = 0
  fresh()
  await seedCompanyA()
})
afterAll(async () => {
  await clientSignOutAll()
  process.stdout.write(`\nBASELINE — CONCURRENCY OUTCOMES AND MEASUREMENTS THIS RUN (emulator only)\n${OUTCOMES.map(b => `  ${b}`).join('\n')}\n`)
})

// ── The baseline itself ──────────────────────────────────────────────────────

describe('ensureReceiptBaseline — the contract', () => {
  it('the legacy fixture is exactly the 28-key document the released build wrote, with no allocatedInvoiceIds', async () => {
    await legacy('old1', 500)
    const doc = await receipt('old1')
    expect(Object.keys(doc).sort()).toEqual([...CLIENT_RECEIPT_KEYS].sort())
    expect(Object.keys(doc)).toHaveLength(28)
    expect(doc).not.toHaveProperty('allocatedInvoiceIds')
    expect(doc).toMatchObject({ status: 'posted', postedBy: 'u_qs', postedAt: expect.any(A.Timestamp), voidedAt: null, voidReason: '' })
  })

  it('one transaction: a ledger per invoice with history, the marker and ONE audit event — exactly, and nothing else', async () => {
    await seedN()
    await seedA()
    await legacy('old1', 500)                                                   // invN
    await legacy('old2', 800.05)                                                // invN
    await legacy('old3', 1500, [alloc('invA', 1000, 'CI-0001'), alloc('invN', 250.1)])   // two invoices, 249.90 unallocated
    await legacy('old4', 75, [])                                                // unallocated: counted, moves no ledger
    await legacy('old5', 40, [alloc('ghost', 40, 'CI-0404')])                   // an invoice that no longer exists: history is recorded as it is
    await draft('draft1', 999, [alloc('invN', 999)])                            // a draft: not history
    await legacy('void1', 300, [alloc('invN', 300)], { status: 'void', voidedAt: A.FieldValue.serverTimestamp(), voidedBy: 'u_qs', voidReason: 'Keyed twice' })
    const before = await dumpAll()

    expect(await ensure('u_pm')).toEqual({ established: true, attempts: 1 })

    const changed = changedPaths(before, await dumpAll())
    expect(changed).toHaveLength(5)
    expect(changed).toEqual(expect.arrayContaining([markerRef().path, ledgerRef('invN').path, ledgerRef('invA').path, ledgerRef('ghost').path]))
    expect(changed.filter(p => p.includes('/auditEvents/'))).toHaveLength(1)
    // No receipt and no invoice was written.
    expect(changed.filter(p => p.includes('/clientReceipts/') || p.includes('/clientInvoices/'))).toEqual([])

    const stampsOf = { createdAt: expect.any(A.Timestamp), createdBy: 'u_pm', updatedAt: expect.any(A.Timestamp), updatedBy: 'u_pm' }
    expect(await ledger('invN')).toEqual({ seq: 0, lines: {}, ...ZERO, receivedCents: 155015, receiptBaseline: baselineOf(155015, 3), ...stampsOf })
    expect(await ledger('invA')).toEqual({ seq: 0, lines: {}, ...ZERO, receivedCents: 100000, receiptBaseline: baselineOf(100000, 1), ...stampsOf })
    expect(await ledger('ghost')).toEqual({ seq: 0, lines: {}, ...ZERO, receivedCents: 4000, receiptBaseline: baselineOf(4000, 1), ...stampsOf })
    expect(await marker()).toEqual({
      version: 1, establishedAt: expect.any(A.Timestamp), establishedBy: 'u_pm',
      legacyPostedReceipts: 5, legacyAllocations: 5, invoices: 3, legacyCents: 259015,
    })
    const events = await audits(BASELINE)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: BASELINE, actorUid: 'u_pm', targetUid: null, targetEmail: null, inviteId: null, requestId: null, source: 'callable',
      before: null, after: { projectId: PROJECT, version: 1, legacyPostedReceipts: 5, legacyAllocations: 5, invoices: 3, legacyCents: 259015 },
      at: expect.any(A.Timestamp),
    })
    for (const key of ['legacyCents', 'legacyPostedReceipts', 'legacyAllocations', 'invoices']) expect(Number.isSafeInteger((await marker())[key])).toBe(true)
    await ledgersAgreeWithReceipts()

    // A second call — by anyone — reads the marker and writes nothing.
    const again = await dumpAll()
    expect(await ensure('u_admin')).toEqual({ established: false, attempts: 1 })
    expect(changedPaths(again, await dumpAll())).toEqual([])
  })

  it('a project with NO receipts: the marker is written with zeros, no ledger, and operations proceed', async () => {
    await seedN()
    await draft('cr1', 100, [alloc('invN', 100)])
    expect(await marker()).toBeNull()
    expect((await postReceipt('u_pm', 'cr1')).status).toBe('posted')
    expect(await marker()).toEqual({ version: 1, establishedAt: expect.any(A.Timestamp), establishedBy: 'u_pm', legacyPostedReceipts: 0, legacyAllocations: 0, invoices: 0, legacyCents: 0 })
    expect(await audits(BASELINE)).toHaveLength(1)
    const l = await ledger('invN')
    expect(l).toMatchObject({ seq: 1, receivedCents: 10000 })
    expect(l).not.toHaveProperty('receiptBaseline')
    await ledgersAgreeWithReceipts()
  })

  it('a ledger that credit notes created BEFORE the baseline is updated, not replaced: its totals stand and the legacy sum is added once', async () => {
    await seedA()
    await legacy('old1', 500, [alloc('invA', 500, 'CI-0001')])
    // Privileged seed of a ledger with no received figure at all (the pre-receipt-tracking shape).
    await ledgerRef('invA').set({ seq: 2, lines: { 0: { amountCents: 10000, gstCents: 1000 } }, ...ZERO, creditedSubtotalCents: 10000, creditedGstCents: 1000, creditedRetentionCents: 1000, creditedRetentionGstCents: 100, lastEntryId: 'cnX', lastEntryKind: 'credit', createdBy: 'seed' })
    expect((await ensure()).established).toBe(true)
    expect(await ledger('invA')).toEqual({
      seq: 2, lines: { 0: { amountCents: 10000, gstCents: 1000 } }, ...ZERO, creditedSubtotalCents: 10000, creditedGstCents: 1000, creditedRetentionCents: 1000, creditedRetentionGstCents: 100,
      lastEntryId: 'cnX', lastEntryKind: 'credit', createdBy: 'seed', receivedCents: 50000, receiptBaseline: baselineOf(50000, 1), updatedAt: expect.any(A.Timestamp), updatedBy: 'u_admin',
    })
  })

  it('INCONSISTENT — nothing written: a receipt posted by the backend where no marker exists; a ledger that already carries receipts', async () => {
    await seedN()
    await legacy('old1', 500)
    await legacy('tracked', 300, [alloc('invN', 300)], { allocatedInvoiceIds: ['invN'] })
    const err = await refusedUnchanged(() => ensure(), A.CODE.CLIENT_RECEIPT_BASELINE_INCONSISTENT)
    expect(err.details).toMatchObject({ receiptId: 'tracked', number: 'CR-0002', reason: 'posted-by-the-backend-without-a-baseline' })
    expect(err.code).toBe('failed-precondition')
    // …and so is every callable, with nothing written (not even for an unrelated receipt).
    await draft('cr1', 10, [alloc('invN', 10)])
    await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_BASELINE_INCONSISTENT)
    await refusedUnchanged(() => voidReceipt('u_pm', 'old1'), A.CODE.CLIENT_RECEIPT_BASELINE_INCONSISTENT)
    expect(await marker()).toBeNull()

    // An EMPTY allocatedInvoiceIds is still the backend's mark.
    await receiptRef('tracked').update({ allocatedInvoiceIds: [] })
    await refusedUnchanged(() => ensure(), A.CODE.CLIENT_RECEIPT_BASELINE_INCONSISTENT)

    // A ledger that already holds received money, or an earlier baseline record: adding the sum would count it twice.
    await receiptRef('tracked').delete()
    for (const stored of [{ receivedCents: 1 }, { receivedCents: 0, receiptBaseline: { legacyCents: 0, legacyReceipts: 0 } }, { receivedCents: 1.5 }]) {
      await ledgerRef('invN').set({ seq: 0, lines: {}, ...ZERO, ...stored })
      const e = await refusedUnchanged(() => ensure(), A.CODE.CLIENT_RECEIPT_BASELINE_INCONSISTENT)
      expect(e.details).toMatchObject({ invoiceId: 'invN', reason: 'ledger-already-carries-receipts' })
    }
    await ledgerRef('invN').delete()
    expect((await ensure()).established).toBe(true)
    expect((await ledger('invN')).receivedCents).toBe(50000)
  })

  const MALFORMED = [
    ['a fraction of a cent', () => ({ allocations: [alloc('invN', 100), alloc('invA', 10.005, 'CI-0001')] }), 'allocations[1].allocatedAmount'],
    ['an allocation of zero', () => ({ allocations: [alloc('invN', 0)] }), 'allocations[0].allocatedAmount'],
    ['a negative allocation', () => ({ allocations: [alloc('invN', -50)] }), 'allocations[0].allocatedAmount'],
    ['an amount stored as text', () => ({ allocations: [alloc('invN', '50.00')] }), 'allocations[0].allocatedAmount'],
    ['an allocation with no invoice', () => ({ allocations: [{ invoiceNumber: 'CI-0002', allocatedAmount: 50 }] }), 'allocations[0].clientInvoiceId'],
    ['an allocation that is not an object', () => ({ allocations: ['invN:50'] }), 'allocations[0]'],
    ['allocations that are not a list', () => ({ allocations: { invN: 50 } }), 'allocations'],
    ['no allocations field', () => ({ allocations: A.FieldValue.delete() }), 'allocations'],
    ['an invoice id that is not a document id', () => ({ allocations: [alloc('a/b', 50)] }), 'allocations'],
  ]
  it.each(MALFORMED)('INVALID — nothing written, the receipt named, never skipped: %s', async (_label, over, field) => {
    await seedN()
    await legacy('old1', 500)
    await legacy('bad', 100)
    await legacy('old2', 800)
    await receiptRef('bad').update(over())
    const number = (await receipt('bad')).receiptNumber
    const err = await refusedUnchanged(() => ensure(), A.CODE.CLIENT_RECEIPT_BASELINE_INVALID)
    expect(err.details).toEqual({ code: 'client-receipt-baseline-invalid', receiptId: 'bad', number, field })
    await draft('cr1', 10, [alloc('invN', 10)])
    const viaCallable = await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_BASELINE_INVALID)
    expect(viaCallable.details).toMatchObject({ receiptId: 'bad', number })
    expect(await marker()).toBeNull()
    expect(await ledger('invN')).toBeNull()
  })

  it('TOO LARGE — nothing written: history touching more than 448 invoices needs an operator baseline; exactly 448 is established', async () => {
    const batch = A.db.batch()
    for (let r = 0; r < 5; r += 1) {
      const count = r < 4 ? 100 : 49
      batch.set(receiptRef(`big${r}`), legacyDoc(count, Array.from({ length: count }, (_x, i) => alloc(`h${r}x${i}`, 1, 'CI-9000'))))
    }
    await batch.commit()
    const err = await refusedUnchanged(() => ensure(), A.CODE.CLIENT_RECEIPT_BASELINE_TOO_LARGE)
    expect(err.details).toMatchObject({ invoices: 449, maxInvoices: 448 })
    expect(err.message).toContain('needs an operator baseline')
    await draft('cr1', 10, [])
    await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_BASELINE_TOO_LARGE)
    // One invoice fewer: 448 ledgers + the marker + the audit event = 450 writes, in one transaction.
    await receiptRef('big4').set(legacyDoc(48, Array.from({ length: 48 }, (_x, i) => alloc(`h4x${i}`, 1, 'CI-9000'))))
    expect((await ensure()).established).toBe(true)
    expect(await marker()).toMatchObject({ legacyPostedReceipts: 5, legacyAllocations: 448, invoices: 448, legacyCents: 44800 })
    expect((await base().collection('clientInvoiceLedgers').count().get()).data().count).toBe(448)
    await ledgersAgreeWithReceipts()
  }, 120000)

  it("another company's project is not found, and no marker is written anywhere", async () => {
    await seedCompany(COMPANY_B, 'Other Co')
    await refusedUnchanged(() => ensure('u_admin', COMPANY_B, PROJECT), A.CODE.NOT_FOUND)
    await refusedUnchanged(() => ensure('u_admin', COMPANY_A, 'nope'), A.CODE.NOT_FOUND)
    await refusedUnchanged(() => ensure('u_admin', 'ghostCo', PROJECT), A.CODE.NOT_FOUND)
  })
})

// ── A missing baseline is never zero ─────────────────────────────────────────

describe('a missing baseline is never treated as zero', () => {
  it('each of the six operations, run WITHOUT the handler having ensured it, is refused by its own transaction — nothing written', async () => {
    await seedA()
    await legacy('old1', 500, [alloc('invA', 500, 'CI-0001')])
    await draft('cr1', 100, [alloc('invA', 100, 'CI-0001')])
    await draftCredit('cn1', 'invA', 100)
    await draftRelease('rr1', 'invA', 100)
    const input = (entryId, extra = {}) => ({ uid: 'u_pm', projectId: PROJECT, entryId, ...extra })
    const runs = [
      () => txMod.postClientCreditNote(deps, input('cn1')),
      () => txMod.voidClientCreditNote(deps, input('cn1', { reason: 'x' })),
      () => txMod.postClientRetentionRelease(deps, input('rr1')),
      () => txMod.voidClientRetentionRelease(deps, input('rr1', { reason: 'x' })),
      () => receiptsMod.postClientReceipt(deps, input('cr1', { acknowledgeOverAllocation: true })),
      () => receiptsMod.voidClientReceipt(deps, input('old1', { reason: 'x' })),
    ]
    for (const run of runs) {
      const err = await refusedUnchanged(run, A.CODE.CLIENT_RECEIPT_BASELINE_MISSING)
      expect(err.code).toBe('failed-precondition')
    }
    expect(await marker()).toBeNull()
    // With the baseline, the same six calls run.
    await ensure()
    expect((await runs[4]()).status).toBe('posted')
    expect((await ledger('invA')).receivedCents).toBe(60000)
  })

  it('a switch that is OFF refuses BEFORE any baseline is written; so does a company that is not activated', async () => {
    await seedA()
    await legacy('old1', 500, [alloc('invA', 500, 'CI-0001')])
    await draft('cr1', 100, [alloc('invA', 100, 'CI-0001')])
    await draftCredit('cn1', 'invA', 100)
    await draftRelease('rr1', 'invA', 100)
    fresh({ finance: false, receipts: false })
    await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_DISABLED)
    await refusedUnchanged(() => voidReceipt('u_pm', 'old1'), A.CODE.CLIENT_RECEIPT_DISABLED)
    for (const run of [() => postCredit('u_pm', 'cn1'), () => voidCredit('u_pm', 'cn1'), () => postRelease('u_pm', 'rr1'), () => voidRelease('u_pm', 'rr1')]) {
      await refusedUnchanged(run, A.CODE.CLIENT_FINANCE_DISABLED)
    }
    expect(await marker()).toBeNull()
    expect(await ledger('invA')).toBeNull()

    // Finance ON, but the company not activated: refused, still no baseline.
    fresh()
    await company().update({ clientFinanceEnabled: false })
    for (const run of [() => postCredit('u_pm', 'cn1'), () => voidCredit('u_pm', 'cn1'), () => postRelease('u_pm', 'rr1'), () => voidRelease('u_pm', 'rr1')]) {
      await refusedUnchanged(run, A.CODE.CLIENT_FINANCE_NOT_ACTIVATED)
    }
    expect(await marker()).toBeNull()

    // Receipts are not company-gated: the first receipt call establishes it.
    expect((await postReceipt('u_pm', 'cr1')).status).toBe('posted')
    expect(await marker()).toMatchObject({ legacyPostedReceipts: 1, invoices: 1, legacyCents: 50000 })
    expect((await ledger('invA')).receivedCents).toBe(60000)
  })

  it('a caller who may not post, and an invalid request, establish nothing', async () => {
    await seedN()
    await legacy('old1', 500)
    await seedUser({ uid: 'u_client', email: 'client@x.test', role: 'client', companyId: COMPANY_A })
    await refusedUnchanged(() => voidReceipt('u_client', 'old1'), A.CODE.CLIENT_FINANCE_FORBIDDEN)
    await refusedUnchanged(() => H.voidClientReceipt(req('u_pm', { projectId: PROJECT, receiptId: 'old1' })), A.CODE.INVALID_ARGUMENT)
    await expectTeamError(H.voidClientReceipt(req(null, {})), A.CODE.UNAUTHENTICATED)
    expect(await marker()).toBeNull()
  })
})

// ── Posting against an invoice with history ──────────────────────────────────

describe('a new receipt on an invoice that already has legacy receipts', () => {
  beforeEach(async () => { await seedN() })   // 9,900.00 receivable

  it('HISTORICAL PARTIAL: the remainder posts without acknowledgement; one cent more is refused without it', async () => {
    await legacy('old1', 4000)
    await draft('over', 5900.01, [alloc('invN', 5900.01)])
    await draft('exact', 5900, [alloc('invN', 5900)])
    // The first call on the project establishes the baseline, then judges the receipt against it.
    const err = await expectTeamError(postReceipt('u_pm', 'over'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    expect(err.details.invoices).toEqual([{ invoiceId: 'invN', invoiceNumber: 'CI-0002', allocatedCents: 590001, remainingCents: 590000, excessCents: 1 }])
    expect(await ledger('invN')).toMatchObject({ seq: 0, receivedCents: 400000, receiptBaseline: baselineOf(400000, 1) })
    expect((await receipt('over')).status).toBe('draft')
    // The same refusal again changes nothing at all.
    await refusedUnchanged(() => postReceipt('u_pm', 'over'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)

    expect(await postReceipt('u_pm', 'exact')).toMatchObject({ status: 'posted', overAllocationAcknowledged: false, alreadyApplied: false })
    expect(await ledger('invN')).toMatchObject({ seq: 1, lastEntryId: 'exact', lastEntryKind: 'receipt', receivedCents: 990000, receiptBaseline: baselineOf(400000, 1) })
    expect(await remaining('invN')).toBe(0)
    expect((await audits('client_receipt.posted'))[0].after.allocations).toEqual([
      { invoiceId: 'invN', invoiceNumber: 'CI-0002', allocatedCents: 590000, receivedBeforeCents: 400000, receivedAfterCents: 990000, seq: 1 },
    ])
    await ledgersAgreeWithReceipts()
  })

  it('HISTORICAL FULL: the invoice is settled by history — ANY new allocation needs the acknowledgement', async () => {
    await legacy('old1', 9900)
    await draft('cr1', 0.01, [alloc('invN', 0.01)])
    const err = await expectTeamError(postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    expect(err.details.invoices).toEqual([{ invoiceId: 'invN', invoiceNumber: 'CI-0002', allocatedCents: 1, remainingCents: 0, excessCents: 1 }])
    expect(await remaining('invN')).toBe(0)
    expect(await postReceipt('u_pm', 'cr1', true)).toMatchObject({ status: 'posted', overAllocationAcknowledged: true })
    expect(await remaining('invN')).toBe(-1)
    await ledgersAgreeWithReceipts()
  })

  it('HISTORICAL OVER-ALLOCATION: history already exceeds the invoice — remaining is negative, a new receipt is refused without acknowledgement and posts with it', async () => {
    await legacy('old1', 6000)
    await legacy('old2', 6000)
    await ensure()
    expect((await ledger('invN')).receivedCents).toBe(1200000)
    // Owed to the client: 9,900.00 − 12,000.00. Reported signed, never clamped.
    expect(await remaining('invN')).toBe(-210000)
    await draft('cr1', 100, [alloc('invN', 100)])
    const err = await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    // An invoice that owes the client has NOTHING available: the whole allocation is excess.
    expect(err.details.invoices).toEqual([{ invoiceId: 'invN', invoiceNumber: 'CI-0002', allocatedCents: 10000, remainingCents: 0, excessCents: 10000 }])
    expect(await postReceipt('u_pm', 'cr1', true)).toMatchObject({ status: 'posted', overAllocationAcknowledged: true })
    expect((await ledger('invN')).receivedCents).toBe(1210000)
    expect(await remaining('invN')).toBe(-220000)   // basis − received: the same arithmetic as ever
    expect((await audits('client_receipt.posted'))[0].after).toMatchObject({
      overAllocationAcknowledged: true, overAllocated: [{ invoiceId: 'invN', remainingCents: 0, excessCents: 10000 }],
      allocations: [{ receivedBeforeCents: 1200000, receivedAfterCents: 1210000 }],
    })
    await ledgersAgreeWithReceipts()
  })

  it('MIXED historical and new receipts, across two invoices, with a credit note and a release between them: every total exact', async () => {
    await seedA()
    await legacy('old1', 1500, [alloc('invN', 1000.1), alloc('invA', 499.9, 'CI-0001')])
    await legacy('old2', 0.2)
    await draft('cr1', 2000.3, [alloc('invN', 2000.3)])
    expect((await postReceipt('u_pm', 'cr1')).allocatedInvoiceIds).toEqual(['invN'])
    await draftCredit('cn1', 'invA', 100)
    await postCredit('u_pm', 'cn1')
    await draftRelease('rr1', 'invA', 90)
    await postRelease('u_pm', 'rr1')
    await draft('cr2', 700, [alloc('invA', 300.1, 'CI-0001'), alloc('invN', 0.1)])
    await postReceipt('u_qs', 'cr2')
    // invN: 1,000.10 + 0.20 (history) + 2,000.30 + 0.10 = 3,000.70. invA: 499.90 (history) + 300.10 = 800.00.
    expect(await ledger('invN')).toMatchObject({ seq: 2, receivedCents: 300070, receiptBaseline: baselineOf(100030, 2), ...ZERO })
    expect(await ledger('invA')).toMatchObject({
      seq: 3, receivedCents: 80000, receiptBaseline: baselineOf(49990, 1),
      creditedSubtotalCents: 10000, creditedGstCents: 1000, releasedRetentionCents: 9000,
    })
    expect(await ledgersAgreeWithReceipts()).toEqual({ invN: 300070, invA: 80000 })
    expect(await marker()).toMatchObject({ legacyPostedReceipts: 2, legacyAllocations: 3, invoices: 2, legacyCents: 150020 })
    // Voiding the credit note and the release leaves the received figure and the baseline record alone.
    await voidRelease('u_pm', 'rr1')
    await voidCredit('u_pm', 'cn1')
    expect(await ledger('invA')).toMatchObject({ seq: 5, receivedCents: 80000, receiptBaseline: baselineOf(49990, 1), ...ZERO })
  })

  it('STALE TAB on a historical invoice: prepared for the remainder, then a credit note is posted — refused without the acknowledgement, posted with it', async () => {
    await legacy('old1', 4000)
    await ensure()
    // The tab: 5,900.00 is what remains; no warning shown, nothing acknowledged.
    await draft('cr1', 5900, [alloc('invN', 5900)])
    // Meanwhile, elsewhere: 1,000.00 + GST is credited.
    await draftCredit('cn1', 'invN', 1000)
    await postCredit('u_admin', 'cn1')
    const err = await refusedUnchanged(() => postReceipt('u_qs', 'cr1'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    expect(err.details.invoices).toEqual([{ invoiceId: 'invN', invoiceNumber: 'CI-0002', allocatedCents: 590000, remainingCents: 480000, excessCents: 110000 }])
    expect((await receipt('cr1')).status).toBe('draft')
    // EXPLICIT SURPLUS ACKNOWLEDGEMENT: shown the new position, the user accepts the surplus.
    expect(await postReceipt('u_qs', 'cr1', true)).toMatchObject({ status: 'posted', overAllocationAcknowledged: true })
    expect((await ledger('invN')).receivedCents).toBe(990000)
    expect(await remaining('invN')).toBe(-110000)
    expect((await audits('client_receipt.posted'))[0].after).toMatchObject({
      overAllocationAcknowledged: true, overAllocated: [{ invoiceId: 'invN', remainingCents: 480000, excessCents: 110000 }],
    })
    // An acknowledgement that was not needed is recorded as not given.
    await draft('cr2', 1, [])
    expect((await postReceipt('u_qs', 'cr2', true)).overAllocationAcknowledged).toBe(false)
  })
})

// ── Voiding a legacy receipt ─────────────────────────────────────────────────

describe('voiding a receipt posted before the backend took over', () => {
  beforeEach(async () => { await seedN() })

  it('HISTORICAL VOID: the ledger is reduced exactly once; a repeat is alreadyApplied and changes nothing', async () => {
    await legacy('old1', 500)
    await legacy('old2', 800)
    const stored = await receipt('old1')
    // The first call on the project: the baseline (1,300.00), then the void (−500.00).
    expect(await voidReceipt('u_pm', 'old1', '  Keyed twice ')).toEqual({ status: 'void', receiptId: 'old1', alreadyApplied: false, attempts: 1 })
    expect(await ledger('invN')).toMatchObject({ seq: 1, lastEntryId: 'old1', lastEntryKind: 'receipt_void', receivedCents: 80000, receiptBaseline: baselineOf(130000, 2), updatedBy: 'u_pm' })
    // Status and void stamps only: no `allocatedInvoiceIds` is added, no figure moves.
    expect(await receipt('old1')).toEqual({ ...stored, status: 'void', voidedAt: expect.any(A.Timestamp), voidedBy: 'u_pm', voidReason: 'Keyed twice', updatedAt: expect.any(A.Timestamp), updatedBy: 'u_pm' })
    const events = await audits('client_receipt.voided')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorUid: 'u_pm', before: { status: 'posted' },
      after: {
        receiptId: 'old1', status: 'void', reason: 'Keyed twice', amountCents: 50000, ledgerMoved: true, fromBaseline: true,
        allocations: [{ invoiceId: 'invN', invoiceNumber: 'CI-0002', allocatedCents: 50000, receivedBeforeCents: 130000, receivedAfterCents: 80000, seq: 1 }],
      },
    })
    await ledgersAgreeWithReceipts()

    const before = await dumpAll()
    expect(await voidReceipt('u_pm', 'old1', 'Keyed twice')).toEqual({ status: 'void', receiptId: 'old1', alreadyApplied: true, attempts: 1 })
    expect(await voidReceipt('u_pm', 'old1', ' Keyed twice ')).toMatchObject({ alreadyApplied: true })
    expect(changedPaths(before, await dumpAll())).toEqual([])
    // Another caller, or another reason, is told it is already void — and still nothing moves.
    await refusedUnchanged(() => voidReceipt('u_admin', 'old1', 'Keyed twice'), A.CODE.CLIENT_ENTRY_NOT_POSTED)
    await refusedUnchanged(() => voidReceipt('u_pm', 'old1', 'Another reason'), A.CODE.CLIENT_ENTRY_NOT_POSTED)
    expect(await ledger('invN')).toMatchObject({ seq: 1, receivedCents: 80000 })
    expect(await audits('client_receipt.voided')).toHaveLength(1)
    expect(await audits(BASELINE)).toHaveLength(1)
  })

  it('a legacy receipt whose invoice ALSO has new receipts: each void takes back exactly its own money, in either order', async () => {
    await seedA()
    await legacy('old1', 500)
    await legacy('old2', 900, [alloc('invN', 800), alloc('invA', 100, 'CI-0001')])
    await draft('cr1', 300, [alloc('invN', 300)])
    await postReceipt('u_pm', 'cr1')
    expect((await ledger('invN')).receivedCents).toBe(160000)
    await voidReceipt('u_pm', 'old2')
    expect(await ledger('invN')).toMatchObject({ seq: 2, receivedCents: 80000, lastEntryId: 'old2', lastEntryKind: 'receipt_void' })
    expect(await ledger('invA')).toMatchObject({ seq: 1, receivedCents: 0, receiptBaseline: baselineOf(10000, 1) })
    await ledgersAgreeWithReceipts()
    await voidReceipt('u_pm', 'cr1')
    expect((await ledger('invN')).receivedCents).toBe(50000)
    await ledgersAgreeWithReceipts()
    await voidReceipt('u_pm', 'old1')
    expect(await ledger('invN')).toMatchObject({ seq: 4, receivedCents: 0, receiptBaseline: baselineOf(130000, 2) })
    expect(await ledgersAgreeWithReceipts()).toEqual({})
    // What was received and voided can be received again.
    await draft('cr2', 9900, [alloc('invN', 9900)])
    expect((await postReceipt('u_pm', 'cr2')).overAllocationAcknowledged).toBe(false)
  })

  it('two allocations of one legacy receipt to the SAME invoice are one ledger movement of their sum', async () => {
    await legacy('old1', 700, [alloc('invN', 300), alloc('invN', 400)])
    await ensure()
    expect(await ledger('invN')).toMatchObject({ receivedCents: 70000, receiptBaseline: baselineOf(70000, 1) })
    await voidReceipt('u_pm', 'old1')
    expect(await ledger('invN')).toMatchObject({ seq: 1, receivedCents: 0 })
    expect((await audits('client_receipt.voided'))[0].after.allocations).toEqual([
      { invoiceId: 'invN', invoiceNumber: 'CI-0002', allocatedCents: 70000, receivedBeforeCents: 70000, receivedAfterCents: 0, seq: 1 },
    ])
  })

  it('NEVER CLAMPED: a ledger that records less than the void would take back — or is missing — is an invariant refusal, nothing written', async () => {
    await seedA()
    await legacy('old1', 900, [alloc('invN', 500), alloc('invA', 400, 'CI-0001')])
    await draft('cr1', 300, [alloc('invN', 300)])
    await postReceipt('u_pm', 'cr1')
    // A privileged write corrupts one ledger: 100.00 where 800.00 was received.
    await ledgerRef('invN').update({ receivedCents: 10000 })
    for (const id of ['old1', 'cr1']) {
      const err = await refusedUnchanged(() => voidReceipt('u_pm', id), A.CODE.CLIENT_LEDGER_INVARIANT)
      expect(err.details).toMatchObject({
        invariant: 'The invoice ledger records less received than this receipt allocated to it.',
        invoiceId: 'invN', receivedCents: 10000, allocatedCents: id === 'old1' ? 50000 : 30000,
      })
      expect((await receipt(id)).status).toBe('posted')
    }
    // The OTHER ledger of the two-invoice receipt was not moved either: all or nothing.
    expect(await ledger('invA')).toMatchObject({ seq: 0, receivedCents: 40000 })
    // A missing ledger records zero — it is not created by a void.
    await ledgerRef('invN').delete()
    const err = await refusedUnchanged(() => voidReceipt('u_pm', 'cr1'), A.CODE.CLIENT_LEDGER_INVARIANT)
    expect(err.details).toMatchObject({ receivedCents: 0, allocatedCents: 30000 })
    expect(await ledger('invN')).toBeNull()
  })

  it('a posted receipt whose allocations cannot be read strictly is not voided', async () => {
    await legacy('old1', 500)
    await ensure()
    await receiptRef('old1').update({ allocations: [alloc('invN', 500.001)] })
    const err = await refusedUnchanged(() => voidReceipt('u_pm', 'old1'), A.CODE.CLIENT_ENTRY_INVALID)
    expect(err.details.field).toBe('allocations[0].allocatedAmount')
  })

  it('a legacy-shaped receipt stamped as posted AFTER the baseline never passed through a ledger: its void is refused, and the ledger — not the receipt — decides everything else', async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 900)
    await postRelease('u_pm', 'rr1')            // the baseline is established here
    // A privileged write no client can make (the Rules refuse a browser every path to `posted`).
    await new Promise(r => setTimeout(r, 20))
    await receiptRef('rogue').set(legacyDoc(9900, [alloc('invA', 9900, 'CI-0001')]))
    const err = await refusedUnchanged(() => voidReceipt('u_pm', 'rogue'), A.CODE.CLIENT_RECEIPT_BASELINE_INCONSISTENT)
    expect(err.details).toMatchObject({ receiptId: 'rogue', reason: 'legacy-receipt-posted-after-the-baseline' })
    expect((await ledger('invA')).receivedCents).toBe(0)
    expect((await voidRelease('u_pm', 'rr1')).status).toBe('void')
  })

  it('a legacy DRAFT posted after the cutover is an ordinary post; a legacy draft voided through the callable moves no ledger', async () => {
    await legacy('old1', 500)
    await draft('d1', 300, [alloc('invN', 300)])
    await draft('d2', 100, [alloc('invN', 100)])
    expect(await postReceipt('u_pm', 'd1')).toMatchObject({ status: 'posted', allocatedInvoiceIds: ['invN'], alreadyApplied: false })
    expect((await receipt('d1')).allocatedInvoiceIds).toEqual(['invN'])
    expect((await voidReceipt('u_pm', 'd2')).status).toBe('void')
    expect((await audits('client_receipt.voided'))[0].after).toMatchObject({ ledgerMoved: false, fromBaseline: false, allocations: [] })
    expect(await ledger('invN')).toMatchObject({ seq: 1, receivedCents: 80000 })
    await ledgersAgreeWithReceipts()
  })
})

// ── A release void on an invoice with history ────────────────────────────────

describe('voiding a retention release when the received figure includes history', () => {
  // All 900.00 released: 9,900.00 receivable. Without the release: 8,910.00.
  beforeEach(async () => { await seedA() })
  const release = async () => { await draftRelease('rr1', 'invA', 900); await postRelease('u_pm', 'rr1') }

  it('REFUSED when history alone exceeds what would be receivable — and the message does not pretend to list it', async () => {
    await legacy('old1', 8910.01, [alloc('invA', 8910.01, 'CI-0001')])
    await release()
    const err = await refusedUnchanged(() => voidRelease('u_pm', 'rr1'), A.CODE.CLIENT_RECEIPTS_DEPEND)
    expect(err.details).toEqual({
      code: 'client-receipts-depend-on-release', receivedCents: 891001, receivableBasisAfterCents: 891000, number: 'CRR-0001',
      blockingReceipts: [], unlistedReceivedCents: 891001, receiptBaselineAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
    // The legacy receipt's own void clears it.
    await voidReceipt('u_pm', 'old1')
    expect((await voidRelease('u_pm', 'rr1')).status).toBe('void')
  })

  it('ALLOWED at the boundary: history of exactly what stays receivable', async () => {
    await legacy('old1', 8910, [alloc('invA', 8910, 'CI-0001')])
    await release()
    expect((await ledger('invA')).receivedCents).toBe(891000)
    expect((await voidRelease('u_pm', 'rr1')).status).toBe('void')
    expect(await ledger('invA')).toMatchObject({ seq: 2, receivedCents: 891000, receiptBaseline: baselineOf(891000, 1), ...ZERO })
  })

  it('history AND a new receipt: the new one is named, the rest is reported as unlisted with the baseline date', async () => {
    await legacy('old1', 5000, [alloc('invA', 5000, 'CI-0001')])
    await release()
    await draft('cr1', 3910.01, [alloc('invA', 3910.01, 'CI-0001')])
    await postReceipt('u_qs', 'cr1')
    const err = await refusedUnchanged(() => voidRelease('u_pm', 'rr1'), A.CODE.CLIENT_RECEIPTS_DEPEND)
    expect(err.details).toMatchObject({
      receivedCents: 891001, receivableBasisAfterCents: 891000,
      blockingReceipts: [{ id: 'cr1', allocatedCents: 391001 }], unlistedReceivedCents: 500000,
    })
    expect(typeof err.details.receiptBaselineAt).toBe('string')
    await voidReceipt('u_qs', 'cr1')
    expect((await voidRelease('u_pm', 'rr1')).status).toBe('void')
  })

  it('a complete list carries no "unlisted" remainder', async () => {
    await release()
    await draft('cr1', 9900, [alloc('invA', 9900, 'CI-0001')])
    await postReceipt('u_qs', 'cr1')
    const err = await refusedUnchanged(() => voidRelease('u_pm', 'rr1'), A.CODE.CLIENT_RECEIPTS_DEPEND)
    expect(err.details).not.toHaveProperty('unlistedReceivedCents')
    expect(err.details).not.toHaveProperty('receiptBaselineAt')
    expect(err.details.blockingReceipts.map(r => r.id)).toEqual(['cr1'])
  })
})

// ── Concurrency ──────────────────────────────────────────────────────────────

describe('concurrent first calls on a project that has never been baselined', () => {
  async function exactlyOneBaseline(expectedLegacy) {
    expect((await base().collection('clientFinanceState').get()).size).toBe(1)
    expect(await audits(BASELINE)).toHaveLength(1)
    for (const [invoiceId, [cents, receipts]] of Object.entries(expectedLegacy)) {
      expect((await ledger(invoiceId)).receiptBaseline, invoiceId).toEqual(baselineOf(cents, receipts))
    }
    return ledgersAgreeWithReceipts()
  }

  it('eight ensure calls at once: exactly one establishes it; one marker, one audit event, each ledger baselined once', async () => {
    await legacy('old1', 500)
    await legacy('old2', 800, [alloc('invN', 300), alloc('invA', 500, 'CI-0001')])
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_x, i) => ensure(['u_admin', 'u_pm', 'u_qs'][i % 3])))
    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value)
    const refused = results.filter(r => r.status === 'rejected').map(r => r.reason?.details?.code ?? `UNTYPED:${r.reason?.message}`)
    expect(ok.filter(v => v.established)).toHaveLength(1)
    // A caller that lost every attempt to contention is told so (typed, nothing written) — never anything else.
    for (const code of refused) expect(code).toBe(A.CODE.CLIENT_FINANCE_BUSY)
    expect(await exactlyOneBaseline({ invN: [80000, 2], invA: [50000, 1] })).toEqual({ invN: 80000, invA: 50000 })
    expect(await marker()).toMatchObject({ legacyPostedReceipts: 2, legacyAllocations: 3, invoices: 2, legacyCents: 130000 })
    noted('8 × ensureReceiptBaseline ∥', `${ok.length} resolved (1 established, ${ok.length - 1} found it), ${refused.length} refused busy; attempts ${ok.map(v => v.attempts).join(',')}`)
  })

  it('TWO DIFFERENT CALLABLES at once on a fresh legacy project (a receipt post ∥ a legacy void ∥ a credit-note post)', async () => {
    await seedN()
    await seedA()
    await legacy('old1', 500)
    await legacy('old2', 800)
    await legacy('old3', 1000, [alloc('invA', 1000, 'CI-0001')])
    await draft('cr1', 300, [alloc('invN', 300)])
    await draftCredit('cn1', 'invA', 100)
    const r = await settle({ post: postReceipt('u_pm', 'cr1'), void: voidReceipt('u_qs', 'old1'), credit: postCredit('u_admin', 'cn1') })
    // Each lands, or is told (typed) that contention beat it — nothing else, and never a half-applied state.
    for (const [name, x] of Object.entries(r)) if (!x.ok) expect(x.code, name).toBe(A.CODE.CLIENT_FINANCE_BUSY)
    const received = await exactlyOneBaseline({ invN: [130000, 2], invA: [100000, 1] })
    expect(received.invN).toBe(130000 + (r.post.ok ? 30000 : 0) - (r.void.ok ? 50000 : 0))
    expect(received.invA).toBe(100000)
    expect((await ledger('invN')).seq).toBe([r.post.ok, r.void.ok].filter(Boolean).length)
    expect((await ledger('invA')).creditedSubtotalCents).toBe(r.credit.ok ? 10000 : 0)
    expect(await audits('client_receipt.posted')).toHaveLength(r.post.ok ? 1 : 0)
    expect(await audits('client_receipt.voided')).toHaveLength(r.void.ok ? 1 : 0)
    noted('receipt post ∥ legacy void ∥ credit-note post (fresh legacy project)', Object.entries(r).map(([k, x]) => `${k} ${x.ok ? `landed (attempts ${x.value.attempts})` : x.code}`).join('; '))
    // Whatever was beaten by contention succeeds on a repeat, and the totals stay exact.
    if (!r.post.ok) await postReceipt('u_pm', 'cr1')
    if (!r.void.ok) await voidReceipt('u_qs', 'old1')
    if (!r.credit.ok) await postCredit('u_admin', 'cn1')
    expect(await exactlyOneBaseline({ invN: [130000, 2], invA: [100000, 1] })).toEqual({ invN: 110000, invA: 100000 })
  })

  it('TWO RECEIPT POSTS ON DIFFERENT INVOICES at once on a fresh legacy project', async () => {
    await seedN()
    await seedA()
    await legacy('old1', 4000)
    await legacy('old2', 1000, [alloc('invA', 1000, 'CI-0001')])
    await draft('crN', 5900, [alloc('invN', 5900)])                 // exactly the remainder of invN
    await draft('crA', 7910, [alloc('invA', 7910, 'CI-0001')])      // exactly the remainder of invA (8,910.00 receivable)
    const r = await settle({ n: postReceipt('u_pm', 'crN'), a: postReceipt('u_qs', 'crA') })
    for (const [name, x] of Object.entries(r)) if (!x.ok) expect(x.code, name).toBe(A.CODE.CLIENT_FINANCE_BUSY)
    noted('two receipt posts ∥ on different invoices (fresh legacy project)', Object.entries(r).map(([k, x]) => `${k} ${x.ok ? `landed (attempts ${x.value.attempts})` : x.code}`).join('; '))
    if (!r.n.ok) await postReceipt('u_pm', 'crN')
    if (!r.a.ok) await postReceipt('u_qs', 'crA')
    // Neither needed an acknowledgement: each was judged against history that was already in its ledger.
    for (const e of await audits('client_receipt.posted')) expect(e.after.overAllocationAcknowledged).toBe(false)
    expect(await exactlyOneBaseline({ invN: [400000, 1], invA: [100000, 1] })).toEqual({ invN: 990000, invA: 891000 })
    expect(await remaining('invN')).toBe(0)
    expect(await remaining('invA')).toBe(0)
    // One cent more on either now needs the acknowledgement.
    await draft('cr3', 0.01, [alloc('invA', 0.01, 'CI-0001')])
    await refusedUnchanged(() => postReceipt('u_pm', 'cr3'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
  })

  it('two receipts that cannot both fit beside the history, at once on a fresh project: exactly one lands', async () => {
    await seedN()
    await legacy('old1', 4000)
    await draft('cr1', 5900, [alloc('invN', 5900)])
    await draft('cr2', 5900, [alloc('invN', 5900)])
    const r = await settle({ a: postReceipt('u_pm', 'cr1'), b: postReceipt('u_qs', 'cr2') })
    expect([r.a.ok, r.b.ok].filter(Boolean)).toHaveLength(1)
    const lost = r.a.ok ? r.b : r.a
    expect([A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED, A.CODE.CLIENT_FINANCE_BUSY]).toContain(lost.code)
    if (lost.code === A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED) expect(lost.details.invoices[0]).toMatchObject({ remainingCents: 0, excessCents: 590000 })
    expect(await exactlyOneBaseline({ invN: [400000, 1] })).toEqual({ invN: 990000 })
    noted('two receipts ∥ that cannot both fit beside history', `${r.a.ok ? 'cr1' : 'cr2'} landed; the other: ${lost.code}`)
  })
})

// ── Company-scoped activation ────────────────────────────────────────────────

describe('client credit notes and retention releases act only for an ACTIVATED company', () => {
  const B_PROJECT = 'projectB'
  const callB = (name, body) => H[name](req('u_adminB', body))
  const FOUR = (projectId) => [
    ['postClientCreditNote', { projectId, creditNoteId: 'cn1' }],
    ['voidClientCreditNote', { projectId, creditNoteId: 'cn1', reason: 'x' }],
    ['postClientRetentionRelease', { projectId, releaseId: 'rr1' }],
    ['voidClientRetentionRelease', { projectId, releaseId: 'rr1', reason: 'x' }],
  ]

  beforeEach(async () => {
    await seedA()
    await draftCredit('cn1', 'invA', 100)
    await draftRelease('rr1', 'invA', 100)
    // Company B — "Apex": a real, working company that has NOT been activated.
    await seedCompany(COMPANY_B, 'Apex Constructions')
    await seedUser({ uid: 'u_adminB', email: 'admin@apex.test', role: 'company_admin', companyId: COMPANY_B })
    await base(COMPANY_B, B_PROJECT).set({ name: 'Theirs', currency: 'AUD', currencyLocked: true })
  })

  it('B is refused all four on its OWN project — typed, failed-precondition, the exact message, nothing written (no baseline either)', async () => {
    for (const [name, body] of FOUR(B_PROJECT)) {
      const err = await refusedUnchanged(() => callB(name, body), A.CODE.CLIENT_FINANCE_NOT_ACTIVATED)
      expect(err.code, name).toBe('failed-precondition')
      expect(err.message, name).toBe('Client credit notes and retention releases are not yet available for this company. Nothing was changed.')
    }
    expect(await marker(COMPANY_B, B_PROJECT)).toBeNull()
    expect(await audits(BASELINE, COMPANY_B)).toHaveLength(0)
  })

  it("B naming A's project is NOT FOUND (the company comes from the membership) — A's activation is no way in", async () => {
    for (const [name, body] of FOUR(PROJECT)) await refusedUnchanged(() => callB(name, body), A.CODE.NOT_FOUND)
    await expectTeamError(callB('postClientCreditNote', { projectId: PROJECT, creditNoteId: 'cn1', companyId: COMPANY_A }), A.CODE.INVALID_ARGUMENT)
    expect((await data(creditRef('cn1'))).status).toBe('draft')
    expect(await marker()).toBeNull()
  })

  it('A, activated, works — while B stays refused; and B\'s RECEIPTS work (they are not company-gated)', async () => {
    expect((await postCredit('u_pm', 'cn1')).status).toBe('posted')
    await draftRelease('rr2', 'invA', 100)
    expect((await postRelease('u_pm', 'rr2')).status).toBe('posted')
    expect((await voidRelease('u_pm', 'rr2')).status).toBe('void')
    expect((await voidCredit('u_pm', 'cn1')).status).toBe('void')

    const theirs = base(COMPANY_B, B_PROJECT)
    const { id: _id, ...invB } = issuedInvoice({ subtotal: 1000, invoiceNumber: 'CI-0001' })
    void _id
    await theirs.collection('clientInvoices').doc('invB').set(invB)
    await theirs.collection('clientReceipts').doc('crB').set({ ...draftReceipt({ receiptNumber: 'CR-0001', amount: 100, allocations: [alloc('invB', 100, 'CI-0001')] }), ...stamps('u_adminB') })
    expect(await callB('postClientReceipt', { projectId: B_PROJECT, receiptId: 'crB', acknowledgeOverAllocation: false })).toMatchObject({ status: 'posted', allocatedInvoiceIds: ['invB'] })
    expect((await data(theirs.collection('clientInvoiceLedgers').doc('invB'))).receivedCents).toBe(10000)
    expect(await marker(COMPANY_B, B_PROJECT)).toMatchObject({ establishedBy: 'u_adminB', legacyPostedReceipts: 0 })
    expect(await callB('voidClientReceipt', { projectId: B_PROJECT, receiptId: 'crB', reason: 'Keyed twice' })).toMatchObject({ status: 'void' })
    // …and with its baseline in place B is STILL refused the four, with nothing written.
    for (const [name, body] of FOUR(B_PROJECT)) await refusedUnchanged(() => callB(name, body), A.CODE.CLIENT_FINANCE_NOT_ACTIVATED)
  })

  it('strictly `=== true`: anything else on the company document is OFF; and the operation\'s OWN transaction refuses, past the handler', async () => {
    await ensure()
    for (const value of [false, 'true', 1, null, { on: true }]) {
      await company().update({ clientFinanceEnabled: value })
      await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_FINANCE_NOT_ACTIVATED)
    }
    await company().update({ clientFinanceEnabled: A.FieldValue.delete() })
    await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_FINANCE_NOT_ACTIVATED)
    // Called directly (no handler pre-check): the transaction's own read of the company decides.
    const input = (entryId, extra = {}) => ({ uid: 'u_pm', projectId: PROJECT, entryId, ...extra })
    for (const run of [
      () => txMod.postClientCreditNote(deps, input('cn1')), () => txMod.voidClientCreditNote(deps, input('cn1', { reason: 'x' })),
      () => txMod.postClientRetentionRelease(deps, input('rr1')), () => txMod.voidClientRetentionRelease(deps, input('rr1', { reason: 'x' })),
    ]) await refusedUnchanged(run, A.CODE.CLIENT_FINANCE_NOT_ACTIVATED)
    // The global switch is the brake, checked first — even for an activated company.
    await company().update({ clientFinanceEnabled: true })
    fresh({ finance: false })
    await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_FINANCE_DISABLED)
    fresh()
    expect((await postCredit('u_pm', 'cn1')).status).toBe('posted')
  })

  it('deactivated WHILE a request is in flight: the transaction reads the company itself', async () => {
    await ensure()
    let pending = null
    hooks.afterRead = async ({ attempt }) => {
      if (attempt !== 1) return
      pending = company().update({ clientFinanceEnabled: false }).then(() => true, () => false)
      await new Promise(r => setTimeout(r, 400))
    }
    const outcome = await postCredit('u_pm', 'cn1').then(v => ({ posted: true, v }), e => ({ posted: false, e }))
    expect(await pending).toBe(true)
    if (outcome.posted) noted('deactivation ∥ credit-note post', 'the post was ordered first and landed')
    else {
      expect(outcome.e.details.code).toBe(A.CODE.CLIENT_FINANCE_NOT_ACTIVATED)
      expect((await data(creditRef('cn1'))).status).toBe('draft')
      expect(await ledger('invA')).toBeNull()
      noted('deactivation ∥ credit-note post', 'the deactivation was ordered first; the retry read it and refused')
    }
  })

  it('no client can set the flag: a company admin\'s own write is denied by the Rules', async () => {
    const { clientSdk } = await import('./_harness.js')
    const { doc, updateDoc, setDoc } = await import('firebase/firestore')
    await clientSignIn('admin@apex.test')
    const ref = doc(clientSdk().db, 'companies', COMPANY_B)
    await expect(updateDoc(ref, { clientFinanceEnabled: true })).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(setDoc(ref, { clientFinanceEnabled: true }, { merge: true })).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await data(company(COMPANY_B))).clientFinanceEnabled).toBeUndefined()
    // …and the baseline marker is unreadable and unwritable to every client.
    const { getDoc } = await import('firebase/firestore')
    const markerDoc = doc(clientSdk().db, 'companies', COMPANY_B, 'projects', B_PROJECT, 'clientFinanceState', 'receiptBaseline')
    await expect(getDoc(markerDoc)).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(setDoc(markerDoc, { version: 1 })).rejects.toMatchObject({ code: 'permission-denied' })
  })
})

// ── The supported monetary range ─────────────────────────────────────────────

// ── ADR-89 S6 — the cutover scope: receipts for operator-activated companies only
//
// `receiptsAllCompanies` false is the state between "receipts on" and general
// availability. Company A plays the production customer (posted history, NOT
// activated for receipts); company T plays the acceptance company.
describe('receipt processing scoped to an activated company (cutover)', () => {
  const T = COMPANY_B
  const callT = (name, body) => H[name](req('u_adminT', body))
  const seedT = async () => {
    await seedCompany(T, 'Acceptance Test Co')
    await seedUser({ uid: 'u_adminT', email: 'admin@test.test', role: 'company_admin', companyId: T })
    await base(T).set({ name: 'Acceptance project', currency: 'AUD', currencyLocked: true })
    await seedInvoice('invT', issuedInvoice({ subtotal: 1000, invoiceNumber: 'CI-0001' }), T)   // 1,100.00 receivable
    await receiptRef('oldT', T).set(legacyDoc(600, [alloc('invT', 600, 'CI-0001')]))
    await receiptRef('crT', T).set({ ...draftReceipt({ receiptNumber: 'CR-0900', amount: 500, allocations: [alloc('invT', 500, 'CI-0001')] }), ...stamps('u_adminT') })
  }
  const seedHistoryA = async () => {
    await seedA()
    await legacy('old1', 500, [alloc('invA', 500, 'CI-0001')])
    await draft('cr1', 100, [alloc('invA', 100, 'CI-0001')])
  }
  const scoped = (over = {}) => fresh({ receiptsAllCompanies: false, ...over })

  it('a company WITHOUT the receipt flag: post and void are refused exactly as with the switch off — nothing written, no baseline; the credit-note flag does not open receipts', async () => {
    await seedHistoryA()
    scoped()
    expect((await data(company())).clientFinanceEnabled).toBe(true)   // activated for credit notes — irrelevant here
    for (const stored of [undefined, false, null, 'true', 1, {}]) {
      if (stored !== undefined) await company().update({ clientReceiptsEnabled: stored })
      for (const run of [() => postReceipt('u_pm', 'cr1'), () => postReceipt('u_admin', 'cr1', true), () => voidReceipt('u_pm', 'old1')]) {
        const err = await refusedUnchanged(run, A.CODE.CLIENT_RECEIPT_DISABLED)
        expect(err.code).toBe('unavailable')
        expect(err.message).toBe('Posting and voiding client receipts is temporarily unavailable. Nothing was changed.')
      }
    }
    expect(await marker()).toBeNull()
    expect(await ledger('invA')).toBeNull()
    expect(await audits(BASELINE)).toHaveLength(0)
    expect((await data(receiptRef('old1'))).status).toBe('posted')
  })

  it('fail closed: the scope is open to all ONLY on an explicit true', async () => {
    await seedHistoryA()
    for (const value of [undefined, false, null, 'true', 1]) {
      now = clock('2026-11-26T02:00:00Z')
      H = handlersMod.createClientFinanceHandlers({ db: A.db, now, log: silentLog, config: () => ({ finance: true, receipts: true, receiptsAllCompanies: value }), hooks: {} })
      await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_DISABLED)
    }
    expect(await marker()).toBeNull()
  })

  it('the ACTIVATED company: a non-zero historical baseline is established on its first receipt, the ledger reconciles exactly, and a historical void takes back exactly its own money', async () => {
    await seedHistoryA()
    await seedT()
    await company(T).update({ clientReceiptsEnabled: true })
    scoped()
    expect(await callT('postClientReceipt', { projectId: PROJECT, receiptId: 'crT', acknowledgeOverAllocation: false })).toMatchObject({ status: 'posted', allocatedInvoiceIds: ['invT'] })
    expect(await marker(T)).toMatchObject({ version: 1, establishedBy: 'u_adminT', legacyPostedReceipts: 1, legacyAllocations: 1, invoices: 1, legacyCents: 60000 })
    expect(await ledger('invT', T)).toMatchObject({ receivedCents: 110000, receiptBaseline: baselineOf(60000, 1) })
    // Independent reconciliation: the ledger equals the sum of the posted receipts themselves.
    const posted = (await base(T).collection('clientReceipts').where('status', '==', 'posted').get()).docs.map(d => d.data())
    expect(posted.flatMap(r => r.allocations).filter(a => a.clientInvoiceId === 'invT').reduce((n, a) => n + toCents(a.allocatedAmount), 0)).toBe(110000)
    expect(await audits(BASELINE, T)).toHaveLength(1)
    // Fully paid now: one more cent needs the acknowledgement.
    await receiptRef('crT2', T).set({ ...draftReceipt({ receiptNumber: 'CR-0901', amount: 0.01, allocations: [alloc('invT', 0.01, 'CI-0001')] }), ...stamps('u_adminT') })
    await expectTeamError(callT('postClientReceipt', { projectId: PROJECT, receiptId: 'crT2', acknowledgeOverAllocation: false }), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)
    // The historical receipt voided: exactly once.
    expect(await callT('voidClientReceipt', { projectId: PROJECT, receiptId: 'oldT', reason: 'Keyed twice' })).toMatchObject({ status: 'void' })
    expect((await ledger('invT', T)).receivedCents).toBe(50000)
    await callT('voidClientReceipt', { projectId: PROJECT, receiptId: 'oldT', reason: 'Keyed twice' }).catch(() => {})
    expect((await ledger('invT', T)).receivedCents).toBe(50000)

    // Meanwhile the non-activated company is still refused and still untouched.
    await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_DISABLED)
    await refusedUnchanged(() => voidReceipt('u_pm', 'old1'), A.CODE.CLIENT_RECEIPT_DISABLED)
    expect(await marker()).toBeNull()
    expect(await ledger('invA')).toBeNull()
  })

  it('the receipt flag does NOT open credit notes or releases, and an activated company cannot reach another company\'s project', async () => {
    await seedHistoryA()
    await seedT()
    await company(T).update({ clientReceiptsEnabled: true })
    scoped()
    for (const [name, body] of [
      ['postClientCreditNote', { projectId: PROJECT, creditNoteId: 'x' }],
      ['voidClientCreditNote', { projectId: PROJECT, creditNoteId: 'x', reason: 'Raised in error' }],
      ['postClientRetentionRelease', { projectId: PROJECT, releaseId: 'x' }],
      ['voidClientRetentionRelease', { projectId: PROJECT, releaseId: 'x', reason: 'Agreed in error' }],
    ]) await refusedUnchanged(() => callT(name, body), A.CODE.CLIENT_FINANCE_NOT_ACTIVATED)
    expect(await marker(T)).toBeNull()
    // A project that exists only in company A: not found for T — nothing of A's is read or written.
    await base(COMPANY_A, 'onlyA').set({ name: 'Theirs', currency: 'AUD', currencyLocked: true })
    await refusedUnchanged(() => callT('postClientReceipt', { projectId: 'onlyA', receiptId: 'cr1', acknowledgeOverAllocation: false }), A.CODE.NOT_FOUND)
    await refusedUnchanged(() => callT('voidClientReceipt', { projectId: 'onlyA', receiptId: 'old1', reason: 'Keyed twice' }), A.CODE.NOT_FOUND)
  })

  it('the global receipt switch is still the brake over an activated company; deactivation closes it again', async () => {
    await seedT()
    await company(T).update({ clientReceiptsEnabled: true })
    scoped({ receipts: false })
    await refusedUnchanged(() => callT('postClientReceipt', { projectId: PROJECT, receiptId: 'crT', acknowledgeOverAllocation: false }), A.CODE.CLIENT_RECEIPT_DISABLED)
    expect(await marker(T)).toBeNull()
    scoped()
    await company(T).update({ clientReceiptsEnabled: false })
    await refusedUnchanged(() => callT('postClientReceipt', { projectId: PROJECT, receiptId: 'crT', acknowledgeOverAllocation: false }), A.CODE.CLIENT_RECEIPT_DISABLED)
    expect(await marker(T)).toBeNull()
  })

  it('general availability: with receipts open to all, the company that was held back posts, and ITS baseline is established then — exact', async () => {
    await seedHistoryA()
    scoped()
    await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_RECEIPT_DISABLED)
    fresh()   // receiptsAllCompanies: true — no company flag consulted
    expect((await data(company())).clientReceiptsEnabled).toBeUndefined()
    expect((await postReceipt('u_pm', 'cr1')).status).toBe('posted')
    expect(await marker()).toMatchObject({ legacyPostedReceipts: 1, invoices: 1, legacyCents: 50000 })
    expect((await ledger('invA')).receivedCents).toBe(60000)
  })
})

describe('the server is the authority for the supported monetary range', () => {
  const MAX = 999999999999.99          // MAX_SUPPORTED_AMOUNT_CENTS
  const RECEIPT_MAX = 9999999999999.9  // MAX_SUPPORTED_RECEIPT_CENTS
  const big = (subtotal, retention = 0, over = {}) => {
    const lineItems = [{ description: 'Contract works', amount: subtotal, taxCode: 'gst', gstAmount: gstExact(subtotal), variationId: null }]
    return { invoiceNumber: 'CI-0009', status: 'issued', clientId: 'c1', clientName: 'Owner Pty Ltd', currency: 'AUD', invoiceDate: '2026-09-01', dueDate: '2026-10-01', lineItems, ...invoiceTotals(lineItems, retention), ...over }
  }
  const bigAlloc = (amount) => alloc('invBig', amount, 'CI-0009')

  it('the constants', () => {
    expect(toCents(MAX)).toBe(MAX_SUPPORTED_AMOUNT_CENTS)
    expect(toCents(RECEIPT_MAX)).toBe(MAX_SUPPORTED_RECEIPT_CENTS)
  })

  it('an invoice AT the maximum: a credit note, a release and a receipt allocation all post, to the cent', async () => {
    await seedInvoice('invBig', big(MAX, 1000))
    await draftCredit('cn1', 'invBig', 1000)
    expect((await postCredit('u_pm', 'cn1')).status).toBe('posted')
    await draftRelease('rr1', 'invBig', 500)
    expect((await postRelease('u_pm', 'rr1')).status).toBe('posted')
    const owed = await remaining('invBig')
    expect(Number.isSafeInteger(owed)).toBe(true)
    await draft('cr1', owed / 100, [bigAlloc(owed / 100)])
    expect(await postReceipt('u_pm', 'cr1')).toMatchObject({ status: 'posted', overAllocationAcknowledged: false })
    expect(await remaining('invBig')).toBe(0)
    const l = await ledger('invBig')
    expect(l.receivedCents).toBe(owed)
    for (const key of ['receivedCents', ...LEDGER_TOTAL_KEYS]) expect(Number.isSafeInteger(l[key]), key).toBe(true)
    // One cent more is an over-allocation, exactly.
    await draft('cr2', 0.01, [bigAlloc(0.01)])
    expect((await refusedUnchanged(() => postReceipt('u_pm', 'cr2'), A.CODE.CLIENT_RECEIPT_OVER_ALLOCATED)).details.invoices[0]).toMatchObject({ remainingCents: 0, excessCents: 1 })
  })

  it('ONE CENT ABOVE: nothing is posted against the invoice — credit note, release or receipt — typed, nothing written', async () => {
    await seedInvoice('invBig', big(MAX, 1000))
    await ensure()
    await draftCredit('cn1', 'invBig', 1000)
    await draftRelease('rr1', 'invBig', 500)
    await draft('cr1', 100, [bigAlloc(100)])
    // The invoice now stores a subtotal one cent above the maximum (still internally consistent).
    const over = big(1000000000000, 1000)
    await invoiceRef('invBig').update(over)
    for (const run of [() => postCredit('u_pm', 'cn1'), () => postRelease('u_pm', 'rr1')]) {
      const err = await refusedUnchanged(run, A.CODE.CLIENT_AMOUNT_OUT_OF_RANGE)
      expect(err.details).toEqual({ code: 'client-amount-out-of-range', field: 'subtotal', maxCents: 99_999_999_999_999 })
      expect(err.code).toBe('failed-precondition')
    }
    const err = await refusedUnchanged(() => postReceipt('u_pm', 'cr1'), A.CODE.CLIENT_AMOUNT_OUT_OF_RANGE)
    expect(err.details).toEqual({ code: 'client-amount-out-of-range', invoiceId: 'invBig', invoiceNumber: 'CI-0009', field: 'subtotal', maxCents: 99_999_999_999_999 })
    expect(await ledger('invBig')).toBeNull()
    // Back at the maximum, the same three post.
    await invoiceRef('invBig').update(big(MAX, 1000))
    expect((await postReceipt('u_pm', 'cr1')).status).toBe('posted')
  })

  it('a receipt AT the receipt maximum posts; one cent above is refused — typed, nothing written', async () => {
    await ensure()
    await draft('at', RECEIPT_MAX, [])
    await draft('above', 9999999999999.91, [])
    const err = await refusedUnchanged(() => postReceipt('u_pm', 'above'), A.CODE.CLIENT_AMOUNT_OUT_OF_RANGE)
    expect(err.details).toEqual({ code: 'client-amount-out-of-range', field: 'amount', maxCents: 999_999_999_999_990 })
    expect(await postReceipt('u_pm', 'at')).toMatchObject({ status: 'posted', allocatedInvoiceIds: [] })
    expect((await audits('client_receipt.posted'))[0].after).toMatchObject({ amountCents: 999_999_999_999_990, unallocatedCents: 999_999_999_999_990 })
  })

  it('CUMULATIVE: nine maximum receipts on one invoice stay exact and safe; the tenth would not be — refused, nothing written', async () => {
    await seedN()
    for (let i = 1; i <= 9; i += 1) {
      await draft(`cr${i}`, RECEIPT_MAX, [alloc('invN', RECEIPT_MAX)])
      await postReceipt('u_pm', `cr${i}`, true)
      const received = (await ledger('invN')).receivedCents
      expect(BigInt(received)).toBe(999_999_999_999_990n * BigInt(i))
      expect(Number.isSafeInteger(received)).toBe(true)
    }
    expect((await ledger('invN')).receivedCents).toBe(8_999_999_999_999_910)
    await draft('cr10', RECEIPT_MAX, [alloc('invN', RECEIPT_MAX)])
    const err = await refusedUnchanged(() => postReceipt('u_pm', 'cr10', true), A.CODE.CLIENT_LEDGER_INVARIANT)
    expect(err.details).toMatchObject({ invariant: 'The ledger figure receivedCents is not a whole, non-negative number of cents.', invoiceId: 'invN' })
    // Every one of them comes back out exactly.
    for (let i = 9; i >= 1; i -= 1) await voidReceipt('u_pm', `cr${i}`)
    expect((await ledger('invN')).receivedCents).toBe(0)
  }, 120000)

  it('a baseline whose history sums past the safe range is refused whole', async () => {
    for (let i = 0; i < 10; i += 1) await legacy(`h${i}`, RECEIPT_MAX, [alloc('invN', RECEIPT_MAX)])
    const err = await refusedUnchanged(() => ensure(), A.CODE.CLIENT_AMOUNT_OUT_OF_RANGE)
    expect(err.details).toMatchObject({ receiptId: expect.stringMatching(/^h\d$/), field: 'allocations' })
    await receiptRef('h9').delete()
    expect((await ensure()).established).toBe(true)
    expect(await ledger('invN')).toMatchObject({ receivedCents: 8_999_999_999_999_910, receiptBaseline: baselineOf(8_999_999_999_999_910, 9) })
  })

  it.each([
    ['a fraction', 1.5], ['a negative', -1], ['text', '500'], ['null', null], ['past the safe range', 2 ** 53], ['a float far past it', 1e20],
  ])('a STORED ledger whose receivedCents is %s is refused, not coerced — post, void and release alike', async (_label, bad) => {
    await seedA()
    await draftRelease('rr1', 'invA', 900)
    await postRelease('u_pm', 'rr1')
    await draft('cr1', 100, [alloc('invA', 100, 'CI-0001')])
    await postReceipt('u_pm', 'cr1')
    await draft('cr2', 50, [alloc('invA', 50, 'CI-0001')])
    await draftCredit('cn1', 'invA', 100)
    await ledgerRef('invA').update({ receivedCents: bad })
    for (const run of [() => postReceipt('u_pm', 'cr2', true), () => voidReceipt('u_pm', 'cr1'), () => voidRelease('u_pm', 'rr1'), () => postCredit('u_pm', 'cn1')]) {
      const err = await refusedUnchanged(run, A.CODE.CLIENT_LEDGER_INVARIANT)
      expect(err.details).toMatchObject({ invariant: 'The ledger figure receivedCents is not a whole, non-negative number of cents.', invoiceId: 'invA' })
    }
    // Repaired, everything runs again.
    await ledgerRef('invA').update({ receivedCents: 10000 })
    expect((await voidReceipt('u_pm', 'cr1')).status).toBe('void')
  })

  it('a stored ledger with a corrupt credited total is refused the same way', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', 100)
    await postCredit('u_pm', 'cn1')
    await draftCredit('cn2', 'invA', 50)
    await ledgerRef('invA').update({ creditedGstCents: 1000.5 })
    const err = await refusedUnchanged(() => voidCredit('u_pm', 'cn1'), A.CODE.CLIENT_LEDGER_INVARIANT)
    expect(err.details.invariant).toBe('The ledger figure creditedGstCents is not a whole, non-negative number of cents.')
  })

  it('FIRESTORE ROUND TRIP at the maximum: integers are stored and read back exactly, strictly equal and safe', async () => {
    const figures = {
      receivedCents: 8_999_999_999_999_910, creditedSubtotalCents: MAX_SUPPORTED_AMOUNT_CENTS, creditedGstCents: 10_000_000_000_000,
      creditedRetentionCents: MAX_SUPPORTED_AMOUNT_CENTS - 1, creditedRetentionGstCents: 9_999_999_999_999,
      releasedRetentionCents: 1, releasedRetentionGstCents: 0, seq: Number.MAX_SAFE_INTEGER,
    }
    await ledgerRef('roundTrip').set({ ...figures, lines: { 0: { amountCents: MAX_SUPPORTED_AMOUNT_CENTS, gstCents: 10_000_000_000_000 } }, receiptBaseline: { legacyCents: 8_999_999_999_999_910, legacyReceipts: 9 } })
    const back = await ledger('roundTrip')
    for (const [key, value] of Object.entries(figures)) {
      expect(back[key], key).toBe(value)
      expect(Number.isSafeInteger(back[key]), key).toBe(true)
      expect(Number.isInteger(back[key]), key).toBe(true)
    }
    expect(back.lines['0']).toEqual({ amountCents: MAX_SUPPORTED_AMOUNT_CENTS, gstCents: 10_000_000_000_000 })
    expect(back.receiptBaseline.legacyCents).toBe(8_999_999_999_999_910)
    // …and through JSON, as a callable's response or an export would carry it.
    expect(JSON.parse(JSON.stringify(back.receivedCents))).toBe(8_999_999_999_999_910)
    expect(readLedger(back).receivedCents).toBe(8_999_999_999_999_910)
    // On the wire it is a Firestore INTEGER (64-bit), not a double — as every ledger figure the Admin SDK writes is.
    const raw = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-constrap-test/databases/(default)/documents/${ledgerRef('roundTrip').path}`, { headers: { Authorization: 'Bearer owner' } }).then(r => r.json())
    expect(raw.fields.receivedCents).toEqual({ integerValue: '8999999999999910' })
    expect(raw.fields.seq).toEqual({ integerValue: '9007199254740991' })
  })
})

// ── Reads ────────────────────────────────────────────────────────────────────

describe('what the baseline reads, once', () => {
  it('MEASUREMENT (emulator only): the one-time baseline of a project with 300 legacy posted receipts across some thirty invoices', async () => {
    const expected = {}
    for (let start = 0; start < 300; start += 100) {
      const batch = A.db.batch()
      for (let i = start; i < start + 100; i += 1) {
        // One in five is unallocated; one in four of the rest settles two invoices.
        const first = `inv${i % 40}`
        const second = `inv${(i * 7 + 3) % 40}`
        const allocations = i % 5 === 0 ? [] : (i % 4 === 0 && second !== first ? [alloc(first, 10.1, 'CI-9000'), alloc(second, 0.25, 'CI-9000')] : [alloc(first, 33.33, 'CI-9000')])
        for (const a of allocations) expected[a.clientInvoiceId] = (expected[a.clientInvoiceId] ?? 0) + toCents(a.allocatedAmount)
        batch.set(receiptRef(`leg${i}`), legacyDoc(100, allocations))
      }
      await batch.commit()
    }
    // …among drafts and voids that are not history.
    await draft('d1', 5, [alloc('inv1', 5, 'CI-9000')])
    await legacy('v1', 5, [alloc('inv1', 5, 'CI-9000')], { status: 'void' })
    const invoices = Object.keys(expected).length

    const { db, state } = recordingDb()
    const t0 = Date.now()
    expect(await ensure('u_admin', COMPANY_A, PROJECT, db)).toEqual({ established: true, attempts: 1 })
    const ms = Date.now() - t0
    expect(state.transactions).toHaveLength(1)
    const tx = state.transactions[0]
    const P = `companies/${COMPANY_A}/projects/${PROJECT}`
    // The marker, the company, the project, the 300 posted receipts (one query) and one ledger per invoice.
    expect(tx.queries).toBe(1)
    expect(tx.reads.filter(p => p.startsWith(`${P}/clientReceipts/`))).toHaveLength(300)
    expect(tx.reads.filter(p => p.startsWith(`${P}/clientInvoiceLedgers/`))).toHaveLength(invoices)
    expect(tx.reads).toHaveLength(3 + 300 + invoices)
    expect(tx.reads.slice(0, 3)).toEqual([`${P}/clientFinanceState/receiptBaseline`, `companies/${COMPANY_A}`, P])
    expect(tx.reads.some(p => p.endsWith('/d1') || p.endsWith('/v1'))).toBe(false)
    expect(tx.writes).toHaveLength(invoices + 2)
    expect(await ledgersAgreeWithReceipts()).toEqual(expected)
    expect(await marker()).toMatchObject({ legacyPostedReceipts: 300, invoices })

    // Afterwards: ONE document, however much history there is.
    const again = recordingDb()
    const t1 = Date.now()
    expect(await ensure('u_pm', COMPANY_A, PROJECT, again.db)).toEqual({ established: false, attempts: 1 })
    const ms2 = Date.now() - t1
    expect(again.state.transactions).toEqual([{ reads: [`${P}/clientFinanceState/receiptBaseline`], queries: 0, writes: [] }])
    noted('one-time baseline, 300 legacy posted receipts / ' + invoices + ' invoices', `${tx.reads.length} documents read (1 query), ${tx.writes.length} written, ${ms} ms; every later call: 1 document read, 0 written, ${ms2} ms`)
  }, 120000)
})

// ── As deployed ──────────────────────────────────────────────────────────────

describe('through the deployed callables (Functions emulator)', () => {
  it('the first receipt call on a legacy project establishes the baseline; a company that is not activated gets the typed refusal over HTTP', async () => {
    await seedN()
    await seedA()
    await legacy('old1', 4000)
    await draft('cr1', 5900.01, [alloc('invN', 5900.01)])
    await draftCredit('cn1', 'invA', 100)
    const pm = await clientSignIn('pm@acme.test')
    const idToken = await pm.getIdToken()
    const refusedPost = await callFunction('postClientReceipt', { projectId: PROJECT, receiptId: 'cr1', acknowledgeOverAllocation: false }, { idToken })
    expect(refusedPost.status).toBe(400)
    expect(refusedPost.error).toMatchObject({ status: 'FAILED_PRECONDITION', details: { code: 'client-receipt-over-allocated', invoices: [{ invoiceId: 'invN', remainingCents: 590000, excessCents: 1 }] } })
    expect(await marker()).toMatchObject({ establishedBy: 'u_pm', legacyPostedReceipts: 1, legacyCents: 400000 })
    const voided = await callFunction('voidClientReceipt', { projectId: PROJECT, receiptId: 'old1', reason: 'Keyed twice' }, { idToken })
    expect(voided.result).toMatchObject({ status: 'void', receiptId: 'old1', alreadyApplied: false })
    expect((await ledger('invN')).receivedCents).toBe(0)

    await company().update({ clientFinanceEnabled: false })
    const gated = await callFunction('postClientCreditNote', { projectId: PROJECT, creditNoteId: 'cn1' }, { idToken })
    expect(gated.status).toBe(400)
    expect(gated.error).toMatchObject({
      status: 'FAILED_PRECONDITION', message: 'Client credit notes and retention releases are not yet available for this company. Nothing was changed.',
      details: { code: 'client-finance-not-activated' },
    })
    await company().update({ clientFinanceEnabled: true })
    const posted = await callFunction('postClientCreditNote', { projectId: PROJECT, creditNoteId: 'cn1' }, { idToken })
    expect(posted.result).toMatchObject({ status: 'posted', creditNoteId: 'cn1', seq: 1 })
  })
})
