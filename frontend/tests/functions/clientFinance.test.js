import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  admin, resetEmulators, seedCompany, seedUser, req, expectTeamError, clock, silentLog,
  callFunction, clientSignIn, clientSignOutAll, COMPANY_A, COMPANY_B,
} from './_harness.js'
import {
  runClientCreditCreate, runClientCreditUpdate, runClientReleaseCreate, runClientReleaseUpdate,
} from '../../src/lib/clientLedgerActions'
import { invoiceTotals } from '../../src/lib/clientInvoices'
import { LEDGER_TOTAL_KEYS } from '../../src/lib/clientLedger'
import { issuedInvoice, draftReceipt } from '../fixtures/clientReceivableDocs'

// ── The four client-finance callables against the Auth + Firestore (+ Functions)
// emulators (ADR-89)
//
// The handlers are called DIRECTLY with the real Admin SDK — real transactions,
// real queries inside them — and, at the end, through the deployed onCall
// wrappers over HTTP (App Check, ID token).
//
// Every DRAFT in this file is written by the app's own action functions
// (src/lib/clientLedgerActions.js) over a thin Admin-SDK adapter, so a draft is
// exactly what a browser stores and is valid by construction. A forged draft
// is that draft with one thing changed by the Admin SDK.
//
// What is proven here:
//   · WHO may post and void, and that the company never comes from the request;
//   · that NO client figure becomes authoritative: the ledger moves by the
//     server's own derivation, and a draft that is not that derivation — stale
//     or forged — is refused with nothing written (release blocker A);
//   · the exact ledger document after every operation;
//   · that a release cannot be voided from under receipts that rely on it, with
//     the receipts read inside the transaction (release blocker B);
//   · concurrency: two requests against one invoice are always ordered;
//   · idempotent retries: one ledger movement, one audit event.

const PROJECT = 'projectA'
const AUDIT_TYPES = ['client_credit_note.posted', 'client_credit_note.voided', 'client_retention_release.posted', 'client_retention_release.voided', 'client_receipt.posted', 'client_receipt.voided']
const FINANCE_NAMES = ['postClientCreditNote', 'voidClientCreditNote', 'postClientRetentionRelease', 'voidClientRetentionRelease']
let A, handlersMod, baselineMod, H, now, hooks

const company = (c = COMPANY_A) => A.db.collection('companies').doc(c)
const base = (c = COMPANY_A, p = PROJECT) => company(c).collection('projects').doc(p)
const invoiceRef = (id) => base().collection('clientInvoices').doc(id)
const ledgerRef = (id) => base().collection('clientInvoiceLedgers').doc(id)
const creditRef = (id) => base().collection('clientCreditNotes').doc(id)
const releaseRef = (id) => base().collection('clientRetentionReleases').doc(id)
const data = (ref) => ref.get().then(s => (s.exists ? s.data() : null))
const ledger = (id) => data(ledgerRef(id))
const credit = (id) => data(creditRef(id))
const release = (id) => data(releaseRef(id))
const audits = async (c = COMPANY_A) => (await company(c).collection('auditEvents').get()).docs.map(d => d.data()).filter(e => AUDIT_TYPES.includes(e.type))

const postCredit = (uid, creditNoteId, extra = {}) => H.postClientCreditNote(req(uid, { projectId: PROJECT, creditNoteId, ...extra }))
const voidCredit = (uid, creditNoteId, reason = 'Raised in error') => H.voidClientCreditNote(req(uid, { projectId: PROJECT, creditNoteId, reason }))
const postRelease = (uid, releaseId) => H.postClientRetentionRelease(req(uid, { projectId: PROJECT, releaseId }))
const voidRelease = (uid, releaseId, reason = 'Agreed in error') => H.voidClientRetentionRelease(req(uid, { projectId: PROJECT, releaseId, reason }))

async function fresh({ finance = true, receipts = true } = {}) {
  now = clock('2026-11-26T02:00:00Z')
  hooks = {}
  // Phase 2 step 5: the settlement switch ON too, so every handler is past its gate.
  H = handlersMod.createClientFinanceHandlers({ db: A.db, now, log: silentLog, config: () => ({ finance, receipts, receiptsAllCompanies: true, settlement: true }), hooks })
}

// The app's own draft writes, run through the Admin SDK: the Web SDK shapes the
// action functions expect (`snap.exists()`, `runTransaction(db, fn)`).
const appSdk = (uid) => ({
  db: A.db, uid,
  serverTimestamp: () => A.FieldValue.serverTimestamp(),
  runTransaction: (db, fn) => db.runTransaction((tx) => fn({
    get: async (ref) => { const s = await tx.get(ref); return { id: s.id, exists: () => s.exists, data: () => s.data() } },
    set: (ref, value, options) => (options ? tx.set(ref, value, options) : tx.set(ref, value)),
    update: (ref, value) => tx.update(ref, value),
  })),
})
const noLock = async () => () => {}
const target = (invoiceId) => ({ invoiceRef: invoiceRef(invoiceId), ledgerRef: ledgerRef(invoiceId) })
const creditInput = (rows) => ({ creditDate: '2026-11-20', reason: 'Over-billed', clientCreditReference: 'REF-1', notes: '', rows })
const releaseInput = (amount) => ({ releaseDate: '2026-11-21', reason: 'Practical completion', notes: '', amount })

const draftCredit = (id, invoiceId, rows, uid = 'u_qs') => runClientCreditCreate({
  ...appSdk(uid), currency: 'AUD', counterRef: company().collection('counters').doc('clientCreditNotes'),
  creditRef: creditRef(id), ...target(invoiceId), stageCurrencyLock: noLock, input: creditInput(rows),
})
const resaveCredit = (id, invoiceId, rows, uid = 'u_qs') => runClientCreditUpdate({
  ...appSdk(uid), creditRef: creditRef(id), ...target(invoiceId), input: creditInput(rows),
})
const draftRelease = (id, invoiceId, amount, uid = 'u_qs') => runClientReleaseCreate({
  ...appSdk(uid), currency: 'AUD', counterRef: company().collection('counters').doc('clientRetentionReleases'),
  releaseRef: releaseRef(id), ...target(invoiceId), stageCurrencyLock: noLock, input: releaseInput(amount),
})
const resaveRelease = (id, invoiceId, amount, uid = 'u_qs') => runClientReleaseUpdate({
  ...appSdk(uid), releaseRef: releaseRef(id), ...target(invoiceId), input: releaseInput(amount),
})

// ── Invoices ─────────────────────────────────────────────────────────────────
//
// A — one taxable line: 9,000.00 + 900.00 GST, 900.00 withheld (+ 90.00 GST).
//     Everything is a clean tenth, so the figures below can be read by eye.
// M — mixed tax: 1,000.00 gst + 40.15 gst + 300.00 GST-free; 134.02 withheld
//     (retention GST 10.40).
const mixedLines = () => [
  { description: 'Contract works', amount: 1000, taxCode: 'gst', gstAmount: 100, variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
  { description: 'Variation works', amount: 40.15, taxCode: 'gst', gstAmount: 4.02, variationId: 'v1', variationNumber: 'CV-0001', costCodeId: 'cc1', costCodeName: '03-100 — Concrete' },
  { description: 'GST-free supply', amount: 300, taxCode: 'gst_free', gstAmount: 0, variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
]
const invoiceOf = (lineItems, retention, over = {}) => ({
  invoiceNumber: 'CI-0002', status: 'issued', clientId: 'c1', clientName: 'Owner Pty Ltd', currency: 'AUD',
  invoiceDate: '2026-09-01', dueDate: '2026-10-01', lineItems, ...invoiceTotals(lineItems, retention), ...over,
})

async function seedInvoice(id, doc) {
  const { id: _fixtureId, ...rest } = doc
  void _fixtureId
  await invoiceRef(id).set({ ...rest, createdAt: A.Timestamp.fromMillis(1_760_000_000_000), createdBy: 'seed' })
}
const seedA = (id = 'invA', over = {}) => seedInvoice(id, issuedInvoice({ subtotal: 9000, retention: 900, ...over }))
const seedM = (id = 'invM') => seedInvoice(id, invoiceOf(mixedLines(), 134.02))

// A receipt of `amount` allocated in full to one invoice, drafted as the app
// drafts it and POSTED THROUGH THE CALLABLE — the only way a receipt reaches an
// invoice's ledger.
const receiptRef = (id) => base().collection('clientReceipts').doc(id)
const stamps = (uid = 'u_qs') => ({ createdAt: A.FieldValue.serverTimestamp(), createdBy: uid, updatedAt: A.FieldValue.serverTimestamp(), updatedBy: uid })
async function draftReceiptFor(id, invoiceId, amount, over = {}) {
  const invoiceNumber = (await data(invoiceRef(invoiceId)))?.invoiceNumber ?? ''
  await receiptRef(id).set({ ...draftReceipt({ receiptNumber: `CR-${String(1000 + Number(id.replace(/\D/g, '') || 0))}`, amount, allocations: [{ clientInvoiceId: invoiceId, invoiceNumber, allocatedAmount: amount }], ...over }), ...stamps() })
}
const postReceipt = (uid, receiptId, acknowledgeOverAllocation = false) => H.postClientReceipt(req(uid, { projectId: PROJECT, receiptId, acknowledgeOverAllocation }))
const voidReceipt = (uid, receiptId, reason = 'Keyed twice') => H.voidClientReceipt(req(uid, { projectId: PROJECT, receiptId, reason }))
async function receive(id, invoiceId, amount, { acknowledge = false } = {}) {
  await draftReceiptFor(id, invoiceId, amount)
  return postReceipt('u_qs', id, acknowledge)
}

const totalsOf = (doc) => Object.fromEntries(LEDGER_TOTAL_KEYS.map(k => [k, doc[k]]))
const ZERO = { creditedSubtotalCents: 0, creditedGstCents: 0, creditedRetentionCents: 0, creditedRetentionGstCents: 0, releasedRetentionCents: 0, releasedRetentionGstCents: 0 }

// Every document in the database, by path — for "nothing else was written".
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

// Asserts the request is refused with `code` and that NOTHING was written.
async function refusedUnchanged(promise, code) {
  const before = await dumpAll()
  const err = await expectTeamError(promise(), code)
  expect(changedPaths(before, await dumpAll())).toEqual([])
  return err
}

// Company A is ACTIVATED for credit notes and releases, and the project's
// historical receipt baseline is established (empty: no receipt exists yet) —
// the state of any live project after its first call. Activation itself, and
// the baseline, are proven in clientReceiptBaseline.test.js.
const activate = (c = COMPANY_A) => company(c).update({ clientFinanceEnabled: true })
const establishBaseline = (c = COMPANY_A) => baselineMod.ensureReceiptBaseline(A.db, { companyId: c, projectId: PROJECT, uid: 'seed' })

async function seedPeople() {
  await seedCompany(COMPANY_A, 'Acme Builders')
  await activate()
  await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A, name: 'Ada Admin' })
  await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A, name: 'Pat PM' })
  await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A, name: 'Quin QS' })
  await base().set({ name: 'Harbour Road Units', currency: 'AUD', currencyLocked: true, createdAt: A.Timestamp.fromMillis(1_759_000_000_000), createdBy: 'seed' })
  expect(await establishBaseline()).toEqual({ established: true, attempts: 1 })
}

beforeAll(async () => {
  A = await admin()
  handlersMod = await import('../../functions/src/clientFinance/handlers.js')
  baselineMod = await import('../../functions/src/clientFinance/baseline.js')
})
beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  await fresh()
  await seedPeople()
})
afterAll(async () => { await clientSignOutAll() })

// ── 1. Authorisation ─────────────────────────────────────────────────────────

describe('who may post and void', () => {
  beforeEach(async () => { await seedA(); await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }]) })

  it('an unauthenticated request is refused before validation and before any read', async () => {
    for (const name of handlersMod.CLIENT_FINANCE_HANDLER_NAMES) await expectTeamError(H[name](req(null, { nonsense: true })), A.CODE.UNAUTHENTICATED)
  })
  it('a signed-in uid with no membership is refused', async () => {
    await A.auth.createUser({ uid: 'u_bare', email: 'bare@x.test', password: 'correct-horse-battery' })
    await refusedUnchanged(() => postCredit('u_bare', 'cn1'), A.CODE.NO_MEMBERSHIP)
  })
  it('a deactivated member is refused', async () => {
    await A.db.collection('users').doc('u_pm').update({ status: 'deactivated', companyId: null })
    await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.MEMBERSHIP_INACTIVE)
    await refusedUnchanged(() => voidCredit('u_pm', 'cn1'), A.CODE.MEMBERSHIP_INACTIVE)
  })
  it('subcontractor, client and super_admin roles are refused for all four operations', async () => {
    await seedUser({ uid: 'u_sub', email: 'sub@x.test', role: 'subcontractor', companyId: COMPANY_A })
    await seedUser({ uid: 'u_client', email: 'client@x.test', role: 'client', companyId: COMPANY_A })
    await seedUser({ uid: 'u_super', email: 'super@x.test', role: 'super_admin', companyId: COMPANY_A })
    await draftRelease('rr1', 'invA', 100)
    for (const uid of ['u_sub', 'u_client', 'u_super']) {
      await expectTeamError(postCredit(uid, 'cn1'), A.CODE.CLIENT_FINANCE_FORBIDDEN)
      await expectTeamError(voidCredit(uid, 'cn1'), A.CODE.CLIENT_FINANCE_FORBIDDEN)
      await expectTeamError(postRelease(uid, 'rr1'), A.CODE.CLIENT_FINANCE_FORBIDDEN)
      await expectTeamError(voidRelease(uid, 'rr1'), A.CODE.CLIENT_FINANCE_FORBIDDEN)
    }
    expect((await credit('cn1')).status).toBe('draft')
    expect((await release('rr1')).status).toBe('draft')
    expect(await ledger('invA')).toBeNull()
    expect(await audits()).toHaveLength(0)
  })
  it('company_admin, project_manager and qs each post — and a role lost while the request is in flight is caught inside the transaction', async () => {
    expect((await postCredit('u_admin', 'cn1')).status).toBe('posted')
    await draftCredit('cn2', 'invA', [{ invoiceLineIndex: 0, amount: 500 }])
    expect((await postCredit('u_pm', 'cn2')).status).toBe('posted')
    await draftCredit('cn3', 'invA', [{ invoiceLineIndex: 0, amount: 250 }])
    expect((await postCredit('u_qs', 'cn3')).status).toBe('posted')
    expect((await audits()).map(e => e.actorUid).sort()).toEqual(['u_admin', 'u_pm', 'u_qs'])

  })
  it('a role withdrawn WHILE the request is in flight is ordered against it: the membership the transaction reads decides', async () => {
    let pending = null
    hooks.afterRead = async ({ attempt }) => {
      if (attempt !== 1) return
      pending = A.db.collection('users').doc('u_qs').update({ role: 'client' }).then(r => ({ ok: true, time: r.writeTime }), e => ({ ok: false, e }))
      await new Promise(r => setTimeout(r, 400))
    }
    const outcome = await postCredit('u_qs', 'cn1').then(v => ({ posted: true, v }), e => ({ posted: false, e }))
    const write = await pending
    expect(write.ok).toBe(true)
    const entry = await creditRef('cn1').get()
    if (outcome.posted) {
      // Ordered first, while still a qs; the role change committed strictly after.
      expect(write.time.valueOf() > entry.updateTime.valueOf()).toBe(true)
    } else {
      // The role change is ordered first: the retry read it and refused — past the handler's own fail-fast check.
      expect(outcome.e.details.code).toBe(A.CODE.CLIENT_FINANCE_FORBIDDEN)
      expect(entry.data().status).toBe('draft')
      expect(await ledger('invA')).toBeNull()
    }
  })
  it("another company's admin gets NOT FOUND for this project's ids — the company is never taken from the request", async () => {
    await seedCompany(COMPANY_B, 'Other Co')
    await seedUser({ uid: 'u_adminB', email: 'admin@other.test', role: 'company_admin', companyId: COMPANY_B })
    for (const run of [() => postCredit('u_adminB', 'cn1'), () => voidCredit('u_adminB', 'cn1'), () => postRelease('u_adminB', 'cn1'), () => voidRelease('u_adminB', 'cn1')]) {
      const err = await refusedUnchanged(run, A.CODE.NOT_FOUND)
      expect(err.code).toBe('not-found')
    }
    // Even with a project of the SAME id in their own company they reach only their own records:
    // first their own company's activation (it has none)…
    await base(COMPANY_B).set({ name: 'Theirs', currency: 'AUD' })
    await refusedUnchanged(() => postCredit('u_adminB', 'cn1'), A.CODE.CLIENT_FINANCE_NOT_ACTIVATED)
    // …and, once activated, their own (empty) register.
    await activate(COMPANY_B)
    await establishBaseline(COMPANY_B)
    const err = await refusedUnchanged(() => postCredit('u_adminB', 'cn1'), A.CODE.CLIENT_ENTRY_NOT_FOUND)
    expect(err.code).toBe('not-found')
    expect((await credit('cn1')).status).toBe('draft')
    expect(await audits(COMPANY_B)).toHaveLength(0)
    // A companyId in the request is not a way in: it is refused as an unknown key.
    await expectTeamError(H.postClientCreditNote(req('u_adminB', { projectId: PROJECT, creditNoteId: 'cn1', companyId: COMPANY_A })), A.CODE.INVALID_ARGUMENT)
  })
  it('the kill switch answers client-finance-disabled before authentication or any read, for all four', async () => {
    await fresh({ finance: false })
    for (const name of FINANCE_NAMES) {
      await expectTeamError(H[name](req('u_pm', { projectId: PROJECT, creditNoteId: 'cn1', releaseId: 'cn1', reason: 'x' })), A.CODE.CLIENT_FINANCE_DISABLED)
      await expectTeamError(H[name](req(null, {})), A.CODE.CLIENT_FINANCE_DISABLED)
    }
    expect((await credit('cn1')).status).toBe('draft')
  })
})

// ── 2. The request carries identifiers and a reason only ─────────────────────

describe('request validation', () => {
  beforeEach(async () => { await seedA(); await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }]); await draftRelease('rr1', 'invA', 100) })

  const post = { projectId: PROJECT, creditNoteId: 'cn1' }
  const bad = [
    ['postClientCreditNote', 'an amount', { ...post, amount: 1 }],
    ['postClientCreditNote', 'a subtotal', { ...post, subtotal: 1000 }],
    ['postClientCreditNote', 'a companyId', { ...post, companyId: COMPANY_A }],
    ['postClientCreditNote', 'line items', { ...post, lineItems: [] }],
    ['postClientCreditNote', 'a reason on a post', { ...post, reason: 'x' }],
    ['postClientCreditNote', 'a path-like project id', { ...post, projectId: 'a/b' }],
    ['postClientCreditNote', 'a path-like entry id', { ...post, creditNoteId: '../x' }],
    ['postClientCreditNote', 'a numeric entry id', { ...post, creditNoteId: 7 }],
    ['postClientCreditNote', 'a missing entry id', { projectId: PROJECT }],
    ['postClientCreditNote', 'the other kind of id', { projectId: PROJECT, releaseId: 'cn1' }],
    ['postClientCreditNote', 'null data', null],
    ['postClientCreditNote', 'an array', []],
    ['voidClientCreditNote', 'no reason', post],
    ['voidClientCreditNote', 'a blank reason', { ...post, reason: '   ' }],
    ['voidClientCreditNote', 'an over-long reason', { ...post, reason: 'x'.repeat(501) }],
    ['voidClientCreditNote', 'a non-string reason', { ...post, reason: 5 }],
    ['voidClientCreditNote', 'an amount', { ...post, reason: 'x', amount: 1 }],
    ['postClientRetentionRelease', 'an amount', { projectId: PROJECT, releaseId: 'rr1', amount: 900 }],
    ['postClientRetentionRelease', 'a gstAmount', { projectId: PROJECT, releaseId: 'rr1', gstAmount: 0 }],
    ['voidClientRetentionRelease', 'receipt figures', { projectId: PROJECT, releaseId: 'rr1', reason: 'x', receivedCents: 0 }],
    ['voidClientRetentionRelease', 'a blank reason', { projectId: PROJECT, releaseId: 'rr1', reason: '\n' }],
  ]
  it.each(bad)('%s refused as invalid-argument: %s', async (name, _label, body) => {
    await refusedUnchanged(() => H[name](req('u_pm', body)), A.CODE.INVALID_ARGUMENT)
  })
  it('a reason of exactly 500 characters is accepted and stored trimmed', async () => {
    await H.voidClientCreditNote(req('u_pm', { ...post, reason: ` ${'x'.repeat(500)} ` }))
    expect((await credit('cn1')).voidReason).toHaveLength(500)
  })
})

// ── 3. Happy paths ───────────────────────────────────────────────────────────

describe('the four operations', () => {
  it('post → void → release → void on one invoice: the exact ledger, the stamps and one audit event after each', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    const draft = await credit('cn1')
    expect(draft).toMatchObject({ subtotal: 1000, gstTotal: 100, grossTotal: 1100, retentionAmount: 100, retentionGst: 10, retentionTotal: 110, receivableTotal: 990 })

    // POST the credit note — by a different person than drafted it.
    let before = await dumpAll()
    expect(await postCredit('u_pm', 'cn1')).toEqual({ status: 'posted', creditNoteId: 'cn1', invoiceId: 'invA', seq: 1, alreadyApplied: false, attempts: 1 })
    let after = await dumpAll()
    let l = await ledger('invA')
    expect(l).toEqual({
      seq: 1, lastEntryId: 'cn1', lastEntryKind: 'credit',
      lines: { 0: { amountCents: 100000, gstCents: 10000 } },
      creditedSubtotalCents: 100000, creditedGstCents: 10000, creditedRetentionCents: 10000, creditedRetentionGstCents: 1000,
      releasedRetentionCents: 0, releasedRetentionGstCents: 0, receivedCents: 0,
      createdAt: expect.any(A.Timestamp), createdBy: 'u_pm', updatedAt: expect.any(A.Timestamp), updatedBy: 'u_pm',
    })
    let entry = await credit('cn1')
    expect(entry).toEqual({ ...draft, status: 'posted', postedAt: expect.any(A.Timestamp), postedBy: 'u_pm', updatedAt: expect.any(A.Timestamp), updatedBy: 'u_pm' })
    expect(entry.postedAt.toMillis()).toBe(entry.updatedAt.toMillis())
    expect(entry.postedAt.toMillis()).toBe(l.updatedAt.toMillis())   // one commit
    // 12. Nothing but the entry, the ledger and ONE audit event.
    let changed = changedPaths(before, after)
    expect(changed).toHaveLength(3)
    expect(changed).toEqual(expect.arrayContaining([creditRef('cn1').path, ledgerRef('invA').path]))
    expect(changed.filter(p => p.startsWith(`companies/${COMPANY_A}/auditEvents/`))).toHaveLength(1)
    let events = await audits()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'client_credit_note.posted', actorUid: 'u_pm', source: 'callable',
      before: { status: 'draft', ledger: { seq: 0, ...ZERO } },
      after: {
        projectId: PROJECT, invoiceId: 'invA', creditNoteId: 'cn1', number: 'CCN-0001', status: 'posted', currency: 'AUD', seq: 1,
        ledger: { seq: 1, creditedSubtotalCents: 100000, creditedGstCents: 10000, creditedRetentionCents: 10000, creditedRetentionGstCents: 1000, releasedRetentionCents: 0, releasedRetentionGstCents: 0 },
      },
    })

    // VOID it.
    before = after
    expect(await voidCredit('u_admin', 'cn1', '  Raised in error  ')).toEqual({ status: 'void', creditNoteId: 'cn1', invoiceId: 'invA', seq: 2, alreadyApplied: false, attempts: 1 })
    after = await dumpAll()
    l = await ledger('invA')
    expect(l).toEqual({
      seq: 2, lastEntryId: 'cn1', lastEntryKind: 'credit_void', lines: { 0: { amountCents: 0, gstCents: 0 } }, ...ZERO, receivedCents: 0,
      createdAt: expect.any(A.Timestamp), createdBy: 'u_pm', updatedAt: expect.any(A.Timestamp), updatedBy: 'u_admin',
    })
    entry = await credit('cn1')
    expect(entry).toMatchObject({ status: 'void', voidedBy: 'u_admin', voidReason: 'Raised in error', postedBy: 'u_pm', updatedBy: 'u_admin', subtotal: 1000 })
    expect(entry.voidedAt).toBeInstanceOf(A.Timestamp)
    changed = changedPaths(before, after)
    expect(changed).toHaveLength(3)
    expect(changed).toEqual(expect.arrayContaining([creditRef('cn1').path, ledgerRef('invA').path]))
    events = (await audits()).filter(e => e.type === 'client_credit_note.voided')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorUid: 'u_admin',
      before: { status: 'posted', ledger: { seq: 1, creditedSubtotalCents: 100000, creditedGstCents: 10000, creditedRetentionCents: 10000, creditedRetentionGstCents: 1000 } },
      after: { invoiceId: 'invA', creditNoteId: 'cn1', number: 'CCN-0001', status: 'void', reason: 'Raised in error', ledgerMoved: true, seq: 2, ledger: { seq: 2, ...ZERO } },
    })

    // POST a release — 300.00 of the 900.00 held again, with its 30.00 of GST.
    await draftRelease('rr1', 'invA', 300)
    const releaseDraft = await release('rr1')
    expect(releaseDraft).toMatchObject({ amount: 300, gstAmount: 30, releaseTotal: 330, ledgerSeq: 2 })
    before = await dumpAll()
    expect(await postRelease('u_qs', 'rr1')).toEqual({ status: 'posted', releaseId: 'rr1', invoiceId: 'invA', seq: 3, alreadyApplied: false, attempts: 1 })
    after = await dumpAll()
    l = await ledger('invA')
    expect(l).toEqual({
      seq: 3, lastEntryId: 'rr1', lastEntryKind: 'release', lines: { 0: { amountCents: 0, gstCents: 0 } },
      ...ZERO, releasedRetentionCents: 30000, releasedRetentionGstCents: 3000, receivedCents: 0,
      createdAt: expect.any(A.Timestamp), createdBy: 'u_pm', updatedAt: expect.any(A.Timestamp), updatedBy: 'u_qs',
    })
    expect(await release('rr1')).toEqual({ ...releaseDraft, status: 'posted', postedAt: expect.any(A.Timestamp), postedBy: 'u_qs', updatedAt: expect.any(A.Timestamp), updatedBy: 'u_qs' })
    changed = changedPaths(before, after)
    expect(changed).toHaveLength(3)
    expect(changed).toEqual(expect.arrayContaining([releaseRef('rr1').path, ledgerRef('invA').path]))
    events = (await audits()).filter(e => e.type === 'client_retention_release.posted')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorUid: 'u_qs', before: { status: 'draft', ledger: { seq: 2, ...ZERO } },
      after: { invoiceId: 'invA', releaseId: 'rr1', number: 'CRR-0001', status: 'posted', seq: 3, ledger: { seq: 3, ...ZERO, releasedRetentionCents: 30000, releasedRetentionGstCents: 3000 } },
    })

    // VOID the release (no receipt relies on it).
    before = after
    expect(await voidRelease('u_pm', 'rr1')).toEqual({ status: 'void', releaseId: 'rr1', invoiceId: 'invA', seq: 4, alreadyApplied: false, attempts: 1 })
    after = await dumpAll()
    l = await ledger('invA')
    expect(l).toEqual({
      seq: 4, lastEntryId: 'rr1', lastEntryKind: 'release_void', lines: { 0: { amountCents: 0, gstCents: 0 } }, ...ZERO, receivedCents: 0,
      createdAt: expect.any(A.Timestamp), createdBy: 'u_pm', updatedAt: expect.any(A.Timestamp), updatedBy: 'u_pm',
    })
    expect(await release('rr1')).toMatchObject({ status: 'void', voidedBy: 'u_pm', voidReason: 'Agreed in error', postedBy: 'u_qs' })
    changed = changedPaths(before, after)
    expect(changed).toHaveLength(3)
    events = (await audits()).filter(e => e.type === 'client_retention_release.voided')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      before: { status: 'posted', ledger: { seq: 3, releasedRetentionCents: 30000, releasedRetentionGstCents: 3000 } },
      after: { releaseId: 'rr1', status: 'void', reason: 'Agreed in error', ledgerMoved: true, seq: 4, ledger: { seq: 4, ...ZERO } },
    })
    expect(await audits()).toHaveLength(4)
    // The invoice was never written.
    expect((await invoiceRef('invA').get()).updateTime.toMillis()).toBe((await invoiceRef('invA').get()).createTime.toMillis())
  })

  it('a mixed-tax invoice: credit, release, credit — the exact ledger after each, per line', async () => {
    await seedM()
    await draftCredit('cnA', 'invM', [{ invoiceLineIndex: 0, amount: 200 }, { invoiceLineIndex: 1, amount: 20.07 }])
    await postCredit('u_pm', 'cnA')
    expect(await ledger('invM')).toMatchObject({
      seq: 1, lastEntryId: 'cnA', lastEntryKind: 'credit',
      lines: { 0: { amountCents: 20000, gstCents: 2000 }, 1: { amountCents: 2007, gstCents: 201 } },
      creditedSubtotalCents: 22007, creditedGstCents: 2201, creditedRetentionCents: 2201, creditedRetentionGstCents: 220,
      releasedRetentionCents: 0, releasedRetentionGstCents: 0,
    })
    await draftRelease('rrA', 'invM', 50)
    expect(await release('rrA')).toMatchObject({ amount: 50, gstAmount: 3.66, releaseTotal: 53.66, ledgerSeq: 1 })
    await postRelease('u_pm', 'rrA')
    await draftCredit('cnB', 'invM', [{ invoiceLineIndex: 2, amount: 300 }])
    // A GST-free line frees no retention GST.
    expect(await credit('cnB')).toMatchObject({ subtotal: 300, gstTotal: 0, retentionAmount: 16.61, retentionGst: 0 })
    expect((await postCredit('u_qs', 'cnB')).seq).toBe(3)
    const l = await ledger('invM')
    expect(l.lines).toEqual({ 0: { amountCents: 20000, gstCents: 2000 }, 1: { amountCents: 2007, gstCents: 201 }, 2: { amountCents: 30000, gstCents: 0 } })
    expect({ seq: l.seq, lastEntryId: l.lastEntryId, lastEntryKind: l.lastEntryKind, ...totalsOf(l) }).toEqual({
      seq: 3, lastEntryId: 'cnB', lastEntryKind: 'credit',
      creditedSubtotalCents: 52007, creditedGstCents: 2201, creditedRetentionCents: 3862, creditedRetentionGstCents: 220,
      releasedRetentionCents: 5000, releasedRetentionGstCents: 366,
    })
    expect(l.createdBy).toBe('u_pm')
    expect(l.updatedBy).toBe('u_qs')
  })

  it('a DRAFT is voided through the callable with no ledger write, and still one audit event', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    await draftRelease('rr1', 'invA', 100)
    const before = await dumpAll()
    expect(await voidCredit('u_pm', 'cn1')).toEqual({ status: 'void', creditNoteId: 'cn1', invoiceId: 'invA', seq: null, alreadyApplied: false, attempts: 1 })
    expect(await voidRelease('u_pm', 'rr1')).toMatchObject({ status: 'void', releaseId: 'rr1', seq: null })
    const changed = changedPaths(before, await dumpAll())
    expect(changed).toHaveLength(4)   // two entries, two audit events — no ledger
    expect(await ledger('invA')).toBeNull()
    expect(await credit('cn1')).toMatchObject({ status: 'void', voidedBy: 'u_pm', voidReason: 'Raised in error', postedAt: null, postedBy: null })
    const events = await audits()
    expect(events.map(e => e.type).sort()).toEqual(['client_credit_note.voided', 'client_retention_release.voided'])
    for (const e of events) expect(e).toMatchObject({ before: { status: 'draft', ledger: { seq: 0, ...ZERO } }, after: { status: 'void', ledgerMoved: false, seq: null, ledger: { seq: 0, ...ZERO } } })
  })

  it('a missing entry, and an entry of the other kind, are not found', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    await refusedUnchanged(() => postCredit('u_pm', 'nope'), A.CODE.CLIENT_ENTRY_NOT_FOUND)
    await refusedUnchanged(() => voidCredit('u_pm', 'nope'), A.CODE.CLIENT_ENTRY_NOT_FOUND)
    await refusedUnchanged(() => postRelease('u_pm', 'cn1'), A.CODE.CLIENT_ENTRY_NOT_FOUND)   // a credit note id is not a release
    await refusedUnchanged(() => H.postClientCreditNote(req('u_pm', { projectId: 'otherProject', creditNoteId: 'cn1' })), A.CODE.NOT_FOUND)
  })
})

// ── 4. Blocker A — a forged draft can never be posted ────────────────────────

describe('a draft that is not the server derivation is refused and nothing is written', () => {
  const ROWS = [{ invoiceLineIndex: 0, amount: 200 }, { invoiceLineIndex: 1, amount: 20.07 }]
  const line = (d, i, over) => d.lineItems.map((li, n) => (n === i ? { ...li, ...over } : li))

  // [label, what the forger changes, the typed refusal, the detail it carries]
  const FORGED_FIGURES = [
    ['a line GST that is not the derived share', d => ({ lineItems: line(d, 0, { gstAmount: 19.99 }), gstTotal: 22 }), { field: 'lineItems[0].gstAmount' }],
    ['a line GST of zero on a taxable line', d => ({ lineItems: line(d, 1, { gstAmount: 0 }) }), { field: 'lineItems[1].gstAmount' }],
    ['a line amount above the invoice line', d => ({ lineItems: line(d, 0, { amount: 1000.01 }) }), { reason: /only 1000\.00 of 1000\.00 remains/ }],
    ['a duplicated line index', d => ({ lineItems: [d.lineItems[0], { ...d.lineItems[1], invoiceLineIndex: 0 }] }), { reason: /credited twice/ }],
    ['a line index the invoice does not have', d => ({ lineItems: line(d, 1, { invoiceLineIndex: 7 }) }), { reason: /does not name a line/ }],
    ['a negative line index', d => ({ lineItems: line(d, 0, { invoiceLineIndex: -1 }) }), { reason: /does not name a line/ }],
    ['a tax code differing from the invoice line', d => ({ lineItems: line(d, 0, { taxCode: 'gst_free' }) }), { field: 'lineItems[0].taxCode' }],
    ['a variationId differing from the invoice line', d => ({ lineItems: line(d, 1, { variationId: 'v9' }) }), { field: 'lineItems[1].variationId' }],
    ['a variationId invented on a line that has none', d => ({ lineItems: line(d, 0, { variationId: 'v1' }) }), { field: 'lineItems[0].variationId' }],
    ['a description differing from the invoice line', d => ({ lineItems: line(d, 0, { description: 'Something else' }) }), { field: 'lineItems[0].description' }],
    ['a cost code differing from the invoice line', d => ({ lineItems: line(d, 1, { costCodeId: 'cc9' }) }), { field: 'lineItems[1].costCodeId' }],
    ['a subtotal that is not the sum of the lines', () => ({ subtotal: 220.08 }), { field: 'subtotal' }],
    ['a GST total that is not the sum of the lines', () => ({ gstTotal: 0 }), { field: 'gstTotal' }],
    ['a gross that is not subtotal + GST', () => ({ grossTotal: 220.07 }), { field: 'grossTotal' }],
    ['a retention split that is not the derived one', () => ({ retentionAmount: 0, retentionGst: 0, retentionTotal: 0, receivableTotal: 242.08 }), { field: 'retentionAmount' }],
    ['a retention GST that is not the derived one', () => ({ retentionGst: 1.71, retentionTotal: 23.72, receivableTotal: 218.36 }), { field: 'retentionGst' }],
    ['a subtotal above the invoice', d => ({ lineItems: [{ ...d.lineItems[0], amount: 5000, gstAmount: 500 }], subtotal: 5000, gstTotal: 500, grossTotal: 5500 }), { reason: /remains to credit/ }],
    ['a figure stored as a string', () => ({ subtotal: '220.07' }), { field: 'subtotal' }],
    ['a figure carrying a fraction of a cent', () => ({ gstTotal: 22.0100001 }), { field: 'gstTotal' }],
  ]
  it.each(FORGED_FIGURES)('figures-changed: %s', async (_label, forge, detail) => {
    await seedM()
    await draftCredit('cn1', 'invM', ROWS)
    await creditRef('cn1').update(forge(await credit('cn1')))
    const err = await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_FIGURES_CHANGED)
    if (detail.field) expect(err.details.field).toBe(detail.field)
    else expect(err.details.reason).toMatch(detail.reason)
    expect((await credit('cn1')).status).toBe('draft')
    expect(await ledger('invM')).toBeNull()
    expect(await audits()).toHaveLength(0)
  })

  // The Rules validate very little of a draft, so the WHOLE document is untrusted.
  const FORGED_DOCUMENT = [
    ['an unknown key', () => ({ approved: true }), 'approved'],
    ['an invoice number that is not the invoice\'s', () => ({ invoiceNumber: 'CI-9999' }), 'invoiceNumber'],
    ['a client name that is not the invoice\'s', () => ({ clientName: 'Somebody Else' }), 'clientName'],
    ['a malformed number', () => ({ creditNumber: 'CCN-1' }), 'creditNumber'],
    ['a number of the other kind', () => ({ creditNumber: 'CRR-0001' }), 'creditNumber'],
    ['a date that is not YYYY-MM-DD', () => ({ creditDate: '20 Nov 2026' }), 'creditDate'],
    ['a blank reason', () => ({ reason: '   ' }), 'reason'],
    ['an over-long reason', () => ({ reason: 'x'.repeat(1001) }), 'reason'],
    ['notes that are not a string', () => ({ notes: 5 }), 'notes'],
    ['an unbounded reference', () => ({ clientCreditReference: 'x'.repeat(501) }), 'clientCreditReference'],
    ['a revision that is not a number', () => ({ revision: '1' }), 'revision'],
    ['a pre-set voidReason', () => ({ voidReason: 'planted' }), 'voidReason'],
    ['a pre-set postedBy', () => ({ postedBy: 'u_admin' }), 'postedBy'],
    ['a pre-set postedAt', () => ({ postedAt: new Date('2020-01-01T00:00:00Z') }), 'postedAt'],
    ['a pre-set voidedBy', () => ({ voidedBy: 'u_admin' }), 'voidedBy'],
    ['a line with an extra key', d => ({ lineItems: line(d, 1, { markup: 0.5 }) }), 'lineItems[1]'],
    ['a line missing a key', d => ({ lineItems: [Object.fromEntries(Object.entries(d.lineItems[0]).filter(([k]) => k !== 'costCodeName')), d.lineItems[1]] }), 'lineItems[0]'],
    ['no lines', () => ({ lineItems: [] }), 'lineItems'],
    ['more than 100 lines', d => ({ lineItems: Array.from({ length: 101 }, () => d.lineItems[0]) }), 'lineItems'],
  ]
  it.each(FORGED_DOCUMENT)('entry-invalid: %s', async (_label, forge, field) => {
    await seedM()
    await draftCredit('cn1', 'invM', ROWS)
    await creditRef('cn1').update(forge(await credit('cn1')))
    const err = await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_ENTRY_INVALID)
    expect(err.details.field).toBe(field)
    expect((await credit('cn1')).status).toBe('draft')
    expect(await ledger('invM')).toBeNull()
    expect(await audits()).toHaveLength(0)
  })

  it('a missing key is refused; a wrong docType is refused before anything else', async () => {
    await seedM()
    await draftCredit('cn1', 'invM', ROWS)
    await creditRef('cn1').update({ clientCreditReference: A.FieldValue.delete() })
    expect((await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_ENTRY_INVALID)).details.field).toBe('clientCreditReference')
    await creditRef('cn1').update({ clientCreditReference: '', docType: 'client_retention_release' })
    await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_ENTRY_INVALID)
    await refusedUnchanged(() => voidCredit('u_pm', 'cn1'), A.CODE.CLIENT_ENTRY_INVALID)
  })

  it('a forged retention release — its GST, its total, its amount, its shape — is refused the same way', async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 300)
    const good = await release('rr1')
    const cases = [
      [{ gstAmount: 0, releaseTotal: 300 }, A.CODE.CLIENT_FIGURES_CHANGED, d => expect(d.field).toBe('gstAmount')],
      [{ releaseTotal: 300 }, A.CODE.CLIENT_FIGURES_CHANGED, d => expect(d.field).toBe('releaseTotal')],
      [{ amount: 900.01 }, A.CODE.CLIENT_FIGURES_CHANGED, d => expect(d.reason).toMatch(/Only 900\.00 of retention/)],
      [{ amount: -5 }, A.CODE.CLIENT_FIGURES_CHANGED, d => expect(d.reason).toMatch(/greater than zero/)],
      [{ amount: '300' }, A.CODE.CLIENT_FIGURES_CHANGED, d => expect(d.field).toBe('amount')],
      [{ approvedBy: 'u_admin' }, A.CODE.CLIENT_ENTRY_INVALID, d => expect(d.field).toBe('approvedBy')],
      [{ releaseNumber: 'CCN-0001' }, A.CODE.CLIENT_ENTRY_INVALID, d => expect(d.field).toBe('releaseNumber')],
      [{ releaseDate: '' }, A.CODE.CLIENT_ENTRY_INVALID, d => expect(d.field).toBe('releaseDate')],
      [{ voidReason: 'planted' }, A.CODE.CLIENT_ENTRY_INVALID, d => expect(d.field).toBe('voidReason')],
      [{ invoiceNumber: 'CI-9' }, A.CODE.CLIENT_ENTRY_INVALID, d => expect(d.field).toBe('invoiceNumber')],
    ]
    for (const [forge, code, check] of cases) {
      const { approvedBy: _extra, ...clean } = { ...good, ...forge }
      void _extra
      await releaseRef('rr1').set('approvedBy' in forge ? { ...good, ...forge } : clean)
      check((await refusedUnchanged(() => postRelease('u_pm', 'rr1'), code)).details)
    }
    await releaseRef('rr1').set(good)
    expect((await postRelease('u_pm', 'rr1')).seq).toBe(1)   // …and the honest draft posts
  })

  it('the ledger advances by the SERVER\'S derivation: an honest draft posts and the figures are the derived ones', async () => {
    await seedM()
    await draftCredit('cn1', 'invM', ROWS)
    await postCredit('u_pm', 'cn1')
    expect(totalsOf(await ledger('invM'))).toEqual({ ...ZERO, creditedSubtotalCents: 22007, creditedGstCents: 2201, creditedRetentionCents: 2201, creditedRetentionGstCents: 220 })
  })
})

// ── 5. Stale drafts ──────────────────────────────────────────────────────────

describe('a draft prepared before another posting', () => {
  it('two credit drafts against the same ledger: the second is refused as figures-changed, and posts once re-saved', async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 450)
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    expect(await credit('cn1')).toMatchObject({ retentionAmount: 100, retentionGst: 10, ledgerSeq: 0 })
    await postRelease('u_pm', 'rr1')

    // Half the retention is no longer held, so this credit would now take 50.00 of it, not 100.00.
    const err = await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_FIGURES_CHANGED)
    expect(err.details.field).toBe('retentionAmount')
    expect(err.code).toBe('failed-precondition')
    expect((await credit('cn1')).status).toBe('draft')
    expect(await ledger('invA')).toMatchObject({ seq: 1, lastEntryId: 'rr1' })

    await resaveCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    expect(await credit('cn1')).toMatchObject({ retentionAmount: 50, retentionGst: 5, ledgerSeq: 1, creditNumber: 'CCN-0001' })
    expect(await postCredit('u_pm', 'cn1')).toMatchObject({ status: 'posted', seq: 2 })
    expect(totalsOf(await ledger('invA'))).toEqual({
      creditedSubtotalCents: 100000, creditedGstCents: 10000, creditedRetentionCents: 5000, creditedRetentionGstCents: 500,
      releasedRetentionCents: 45000, releasedRetentionGstCents: 4500,
    })
  })

  it('two release drafts: the second no longer fits once the first is posted, and posts once re-saved for what is left', async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 600)
    await draftRelease('rr2', 'invA', 600)
    await postRelease('u_pm', 'rr1')
    const err = await refusedUnchanged(() => postRelease('u_pm', 'rr2'), A.CODE.CLIENT_FIGURES_CHANGED)
    expect(err.details.reason).toMatch(/Only 300\.00 of retention/)
    await resaveRelease('rr2', 'invA', 300)
    expect((await postRelease('u_pm', 'rr2')).seq).toBe(2)
    // Released in two postings, exactly the retention withheld — nothing held, no GST stranded.
    expect(totalsOf(await ledger('invA'))).toEqual({ ...ZERO, releasedRetentionCents: 90000, releasedRetentionGstCents: 9000 })
  })

  it('a draft whose figures are UNCHANGED by an unrelated posting still posts (figures decide, not the sequence number)', async () => {
    await seedInvoice('invN', issuedInvoice({ subtotal: 500 }))   // a second invoice, no retention
    await seedInvoice('invP', invoiceOf(mixedLines(), 0))
    await draftCredit('cn1', 'invP', [{ invoiceLineIndex: 0, amount: 100 }])
    await draftCredit('cn2', 'invP', [{ invoiceLineIndex: 2, amount: 100 }])
    await postCredit('u_pm', 'cn1')
    expect((await credit('cn2')).ledgerSeq).toBe(0)
    expect((await postCredit('u_pm', 'cn2')).seq).toBe(2)
  })
})

// ── 6. The invoice ───────────────────────────────────────────────────────────

describe('the invoice is checked before anything is posted against it', () => {
  beforeEach(async () => { await seedA(); await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }]); await draftRelease('rr1', 'invA', 100) })

  const both = async (code, check = () => {}) => {
    check((await refusedUnchanged(() => postCredit('u_pm', 'cn1'), code)).details)
    check((await refusedUnchanged(() => postRelease('u_pm', 'rr1'), code)).details)
    expect(await ledger('invA')).toBeNull()
  }

  it.each(['draft', 'void', 'sent'])('an invoice that is %s is not issued', async (status) => {
    await invoiceRef('invA').update({ status })
    await both(A.CODE.CLIENT_INVOICE_NOT_ISSUED, d => expect(d.invoiceStatus).toBe(status))
  })
  it('a missing invoice', async () => {
    await invoiceRef('invA').delete()
    await both(A.CODE.CLIENT_INVOICE_NOT_ISSUED, d => expect(d.invoiceStatus).toBeNull())
  })
  it('an invoice of another client, or in another currency', async () => {
    await invoiceRef('invA').update({ clientId: 'c2' })
    await both(A.CODE.CLIENT_INVOICE_MISMATCH, d => expect(d.field).toBe('clientId'))
    await invoiceRef('invA').update({ clientId: 'c1', currency: 'NZD' })
    await both(A.CODE.CLIENT_INVOICE_MISMATCH, d => expect(d.field).toBe('currency'))
  })
  it.each([
    ['a subtotal that is not the sum of its lines', { subtotal: 9000.01 }, 'subtotal'],
    ['a GST total that is not the sum of its lines', { gstTotal: 899.99 }, 'gstTotal'],
    ['a gross that is not subtotal + GST', { grossTotal: 9900.01 }, 'grossTotal'],
    ['a retention total that is not retention + its GST', { retentionTotal: 990.01 }, 'retentionTotal'],
    ['a receivable that is not gross − retention', { receivableTotal: 8910.01 }, 'receivableTotal'],
    ['retention above the subtotal', { retention: 9000.01 }, 'retentionGst'],
    ['negative retention', { retention: -1 }, 'retention'],
  ])('an inconsistent invoice — %s', async (_label, over, field) => {
    await invoiceRef('invA').update(over)
    await both(A.CODE.CLIENT_INVOICE_INCONSISTENT, d => expect(d.field).toBe(field))
  })
  it('retention GST one cent off the exact share — which the Rules\' half-cent tolerance admits at a tie — is refused', async () => {
    // 10.00 GST × 0.05 ÷ 100.00 = exactly half a cent: the Rules admit 0.00 and 0.01; only 0.01 is the share.
    const lines = [{ description: 'Tie', amount: 100, taxCode: 'gst', gstAmount: 10, variationId: null, variationNumber: '', costCodeId: null, costCodeName: null }]
    expect(invoiceTotals(lines, 0.05)).toMatchObject({ retentionGst: 0.01, retentionTotal: 0.06, receivableTotal: 109.94 })
    await seedInvoice('invT', invoiceOf(lines, 0.05, { invoiceNumber: 'CI-0003' }))
    await draftRelease('rrT', 'invT', 0.05)
    await draftCredit('cnT', 'invT', [{ invoiceLineIndex: 0, amount: 10 }])
    // The other value the tolerance admits, internally consistent in every other field.
    await invoiceRef('invT').update({ retentionGst: 0, retentionTotal: 0.05, receivableTotal: 109.95 })
    expect((await refusedUnchanged(() => postRelease('u_pm', 'rrT'), A.CODE.CLIENT_INVOICE_INCONSISTENT)).details.field).toBe('retentionGst')
    expect((await refusedUnchanged(() => postCredit('u_pm', 'cnT'), A.CODE.CLIENT_INVOICE_INCONSISTENT)).details.field).toBe('retentionGst')
    await invoiceRef('invT').update({ retentionGst: 0.01, retentionTotal: 0.06, receivableTotal: 109.94 })
    expect((await postRelease('u_pm', 'rrT')).status).toBe('posted')
    expect(totalsOf(await ledger('invT'))).toEqual({ ...ZERO, releasedRetentionCents: 5, releasedRetentionGstCents: 1 })
  })
  it('an invoice written before client retention existed (no retention fields) can be credited, and has nothing to release', async () => {
    const { retention: _a, retentionGst: _b, retentionTotal: _c, receivableTotal: _d, ...legacy } = issuedInvoice({ subtotal: 500 })
    void _a; void _b; void _c; void _d
    await seedInvoice('invL', legacy)
    await draftCredit('cnL', 'invL', [{ invoiceLineIndex: 0, amount: 500 }])
    expect((await postCredit('u_pm', 'cnL')).seq).toBe(1)
    expect(totalsOf(await ledger('invL'))).toEqual({ ...ZERO, creditedSubtotalCents: 50000, creditedGstCents: 5000 })
  })
})

// ── 7. Cumulative caps and invariants ────────────────────────────────────────

describe('cumulative caps and ledger invariants', () => {
  it('over-credit across two entries: the second is refused and the ledger holds the first only', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 6000 }])
    await draftCredit('cn2', 'invA', [{ invoiceLineIndex: 0, amount: 6000 }])
    await postCredit('u_pm', 'cn1')
    const err = await refusedUnchanged(() => postCredit('u_pm', 'cn2'), A.CODE.CLIENT_FIGURES_CHANGED)
    expect(err.details.reason).toMatch(/only 3000\.00 of 9000\.00 remains to credit/)
    expect(totalsOf(await ledger('invA'))).toMatchObject({ creditedSubtotalCents: 600000, creditedGstCents: 60000 })
    // The rest can be credited, and that credit takes ALL the retention still held.
    await resaveCredit('cn2', 'invA', [{ invoiceLineIndex: 0, amount: 3000 }])
    await postCredit('u_pm', 'cn2')
    expect(totalsOf(await ledger('invA'))).toEqual({ ...ZERO, creditedSubtotalCents: 900000, creditedGstCents: 90000, creditedRetentionCents: 90000, creditedRetentionGstCents: 9000 })
  })

  it('a full credit reverses the STORED GST exactly on a legacy invoice whose line GST is one cent low (40.15 / 4.01)', async () => {
    const lines = [{ description: 'Old line', amount: 40.15, taxCode: 'gst', gstAmount: 4.01, variationId: null, variationNumber: '', costCodeId: null, costCodeName: null }]
    await seedInvoice('invL', { invoiceNumber: 'CI-0009', status: 'issued', clientId: 'c1', clientName: 'Owner Pty Ltd', currency: 'AUD', lineItems: lines, subtotal: 40.15, gstTotal: 4.01, grossTotal: 44.16 })
    // In two parts: 20.07 then the remaining 20.08 — the parts sum to the stored 4.01, never 4.02.
    await draftCredit('cn1', 'invL', [{ invoiceLineIndex: 0, amount: 20.07 }])
    await postCredit('u_pm', 'cn1')
    await draftCredit('cn2', 'invL', [{ invoiceLineIndex: 0, amount: 20.08 }])
    await postCredit('u_pm', 'cn2')
    const l = await ledger('invL')
    expect(l.lines).toEqual({ 0: { amountCents: 4015, gstCents: 401 } })
    expect(totalsOf(l)).toEqual({ ...ZERO, creditedSubtotalCents: 4015, creditedGstCents: 401 })
    expect((await credit('cn1')).gstTotal + (await credit('cn2')).gstTotal).toBeCloseTo(4.01, 10)
  })

  it('retention held never goes negative: a release above what is held, and a release after a full credit', async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 900)
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 9000 }])
    await postCredit('u_pm', 'cn1')   // a full credit clears the retention held
    expect(totalsOf(await ledger('invA'))).toMatchObject({ creditedRetentionCents: 90000, creditedRetentionGstCents: 9000 })
    const err = await refusedUnchanged(() => postRelease('u_pm', 'rr1'), A.CODE.CLIENT_FIGURES_CHANGED)
    expect(err.details.reason).toMatch(/Only 0\.00 of retention/)
  })

  it('a posting whose result breaks an invariant is refused by name even when the draft matches its derivation', async () => {
    await seedA()
    // A ledger no posting could have produced (written here with the Admin SDK): GST credited with no amount.
    await ledgerRef('invA').set({ seq: 5, lines: {}, lastEntryId: 'x', lastEntryKind: 'credit', ...ZERO, creditedGstCents: 85000 })
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    const err = await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_LEDGER_INVARIANT)
    expect(err.details.invariant).toBe('Credited GST exceeds the invoice GST.')
    expect((await ledger('invA')).seq).toBe(5)
  })
})

// ── 8. Concurrency ───────────────────────────────────────────────────────────

describe('concurrent requests against one invoice', () => {
  const settle = async (...calls) => {
    const results = await Promise.allSettled(calls)
    return { won: results.filter(r => r.status === 'fulfilled').map(r => r.value), lost: results.filter(r => r.status === 'rejected').map(r => r.reason) }
  }

  it('two postings that cannot both fit: exactly one lands', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 6000 }])
    await draftCredit('cn2', 'invA', [{ invoiceLineIndex: 0, amount: 6000 }])
    const { won, lost } = await settle(postCredit('u_pm', 'cn1'), postCredit('u_admin', 'cn2'))
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0].details.code).toBe(A.CODE.CLIENT_FIGURES_CHANGED)
    const l = await ledger('invA')
    expect({ seq: l.seq, ...totalsOf(l) }).toEqual({ seq: 1, ...ZERO, creditedSubtotalCents: 600000, creditedGstCents: 60000, creditedRetentionCents: 60000, creditedRetentionGstCents: 6000 })
    expect(l.lastEntryId).toBe(won[0].creditNoteId)
    expect([(await credit('cn1')).status, (await credit('cn2')).status].sort()).toEqual(['draft', 'posted'])
    expect(await audits()).toHaveLength(1)
  })

  it('two INDEPENDENT postings both land, at seq 1 and seq 2, each derived against the state it found', async () => {
    await seedInvoice('invP', invoiceOf(mixedLines(), 0))   // no retention: a credit on one line does not move another's figures
    await draftCredit('cn1', 'invP', [{ invoiceLineIndex: 0, amount: 400 }])
    await draftCredit('cn2', 'invP', [{ invoiceLineIndex: 1, amount: 40.15 }])
    const { won, lost } = await settle(postCredit('u_pm', 'cn1'), postCredit('u_admin', 'cn2'))
    expect(lost).toEqual([])
    expect(won.map(w => w.seq).sort()).toEqual([1, 2])
    const l = await ledger('invP')
    expect(l.seq).toBe(2)
    expect(l.lines).toEqual({ 0: { amountCents: 40000, gstCents: 4000 }, 1: { amountCents: 4015, gstCents: 402 } })
    expect(totalsOf(l)).toEqual({ ...ZERO, creditedSubtotalCents: 44015, creditedGstCents: 4402 })
    expect(await audits()).toHaveLength(2)
    // The second to commit recorded the first's totals as its `before`.
    const second = (await audits()).find(e => e.after.seq === 2)
    expect(second.before.ledger.seq).toBe(1)
  })

  it('a credit and a release together: the ledger is exactly what landed, and a loser is told its figures changed', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    await draftRelease('rr1', 'invA', 450)
    const { won, lost } = await settle(postCredit('u_pm', 'cn1'), postRelease('u_admin', 'rr1'))
    const l = await ledger('invA')
    const credited = { creditedSubtotalCents: 100000, creditedGstCents: 10000, creditedRetentionCents: 10000, creditedRetentionGstCents: 1000 }
    const released = { releasedRetentionCents: 45000, releasedRetentionGstCents: 4500 }
    if (lost.length === 0) {
      // The credit was ordered FIRST. A release of 450.00 carries 45.00 of GST against
      // either state, so its draft still equals its derivation and it lands second.
      expect(won.map(w => w.seq).sort()).toEqual([1, 2])
      expect(l).toMatchObject({ seq: 2, lastEntryId: 'rr1' })
      expect(totalsOf(l)).toEqual({ ...ZERO, ...credited, ...released })
      expect(await audits()).toHaveLength(2)
    } else {
      // The release was ordered first: less retention is held, the credit's retention
      // part is no longer the derivation, and it is refused.
      expect(won).toHaveLength(1)
      expect(won[0].releaseId).toBe('rr1')
      expect(lost[0].details).toMatchObject({ code: A.CODE.CLIENT_FIGURES_CHANGED, field: 'retentionAmount' })
      expect(l.seq).toBe(1)
      expect(totalsOf(l)).toEqual({ ...ZERO, ...released })
      expect((await credit('cn1')).status).toBe('draft')
      expect(await audits()).toHaveLength(1)
    }
  })

  it('the SAME draft posted by two callers at once: one write, one audit event, the other told it is no longer a draft', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    const { won, lost } = await settle(postCredit('u_pm', 'cn1'), postCredit('u_admin', 'cn1'))
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0].details.code).toBe(A.CODE.CLIENT_ENTRY_NOT_DRAFT)
    const l = await ledger('invA')
    expect({ seq: l.seq, ...totalsOf(l) }).toMatchObject({ seq: 1, creditedSubtotalCents: 100000 })
    const events = await audits()
    expect(events).toHaveLength(1)
    expect(events[0].actorUid).toBe((await credit('cn1')).postedBy)
  })

  it('the SAME caller double-submitting: one write, one audit event, both calls answered as posted', async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 300)
    const { won, lost } = await settle(postRelease('u_pm', 'rr1'), postRelease('u_pm', 'rr1'))
    expect(lost).toEqual([])
    expect(won.map(w => w.alreadyApplied).sort()).toEqual([false, true])
    expect(won.map(w => w.seq)).toEqual([1, 1])
    expect((await ledger('invA')).seq).toBe(1)
    expect(await audits()).toHaveLength(1)
  })

  it('a post and a void of two entries at once never lose a movement', async () => {
    await seedInvoice('invP', invoiceOf(mixedLines(), 0))
    await draftCredit('cn1', 'invP', [{ invoiceLineIndex: 0, amount: 400 }])
    await postCredit('u_pm', 'cn1')
    await draftCredit('cn2', 'invP', [{ invoiceLineIndex: 2, amount: 300 }])
    const { lost } = await settle(voidCredit('u_pm', 'cn1'), postCredit('u_admin', 'cn2'))
    expect(lost).toEqual([])
    const l = await ledger('invP')
    expect(l.seq).toBe(3)
    expect(totalsOf(l)).toEqual({ ...ZERO, creditedSubtotalCents: 30000, creditedGstCents: 0 })
    expect(l.lines).toEqual({ 0: { amountCents: 0, gstCents: 0 }, 2: { amountCents: 30000, gstCents: 0 } })
  })

  it('a posting racing an Admin-SDK invoice void is ordered against it: never posted against an invoice it saw as void', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    let pending = null
    hooks.afterRead = async ({ attempt }) => {
      if (attempt !== 1) return
      pending = invoiceRef('invA').update({ status: 'void' }).then(r => ({ ok: true, time: r.writeTime }), e => ({ ok: false, e }))
      await new Promise(r => setTimeout(r, 400))
    }
    const outcome = await postCredit('u_pm', 'cn1').then(v => ({ posted: true, v }), e => ({ posted: false, e }))
    const write = await pending
    expect(write.ok).toBe(true)
    const entry = await creditRef('cn1').get()
    if (outcome.posted) {
      // The posting is ordered FIRST; the void committed strictly after it.
      expect(entry.data().status).toBe('posted')
      expect(write.time.valueOf() > entry.updateTime.valueOf()).toBe(true)
      expect((await ledger('invA')).seq).toBe(1)
    } else {
      // The void is ordered first: the retry saw it and refused; nothing was written.
      expect(outcome.e.details.code).toBe(A.CODE.CLIENT_INVOICE_NOT_ISSUED)
      expect(entry.data().status).toBe('draft')
      expect(await ledger('invA')).toBeNull()
      expect(await audits()).toHaveLength(0)
    }
  })

  it('a transaction aborted by contention is retried and still writes exactly once', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    hooks.afterRead = async ({ attempt }) => { if (attempt === 1) throw Object.assign(new Error('forced contention'), { code: 10 }) }
    const res = await postCredit('u_pm', 'cn1')
    expect(res).toMatchObject({ attempts: 2, alreadyApplied: false, seq: 1 })
    expect(await audits()).toHaveLength(1)
  })

  it('contention on EVERY attempt: a typed client-finance-busy after five attempts; certainly nothing written', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    let seen = 0
    hooks.afterRead = async ({ attempt }) => { seen = attempt; throw Object.assign(new Error('contention'), { code: 10 }) }
    const err = await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_FINANCE_BUSY)
    expect(seen).toBe(5)
    expect(err.details.attempts).toBe(5)
    expect(err.code).toBe('aborted')
    hooks.afterRead = undefined
    expect((await postCredit('u_pm', 'cn1')).alreadyApplied).toBe(false)
  })

  it('a timeout (DEADLINE_EXCEEDED) is NOT turned into a typed refusal: it is rethrown as-is, and a retry is safe', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    hooks.afterRead = async () => { throw Object.assign(new Error('deadline exceeded'), { code: 4 }) }
    for (const run of [() => postCredit('u_pm', 'cn1'), () => voidCredit('u_pm', 'cn1')]) {
      const err = await run().then(() => null, e => e)
      expect(err).not.toBeNull()
      expect(err.details?.code).toBeUndefined()   // the onCall wrapper reports it as a bare `internal`
    }
    expect((await credit('cn1')).status).toBe('draft')
    expect(await audits()).toHaveLength(0)
    hooks.afterRead = undefined
    expect((await postCredit('u_pm', 'cn1')).status).toBe('posted')
    expect((await postCredit('u_pm', 'cn1')).alreadyApplied).toBe(true)
    expect(await audits()).toHaveLength(1)
  })
})

// ── 9. Blocker B — a release cannot be voided from under receipts ────────────
// (the receipt operations themselves, the races between a receipt and a release
// void, and a register of more than 5,000 receipts: clientReceipts.test.js)

describe('voiding a posted release against the receipts that rely on it', () => {
  // All 900.00 of retention released: the invoice is receivable in full, 9,900.00.
  // Voiding the release takes that back to 8,910.00.
  beforeEach(async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 900)
    await postRelease('u_pm', 'rr1')
  })

  it('refused when what posted receipts have allocated exceeds what is receivable after the void — naming the receipts', async () => {
    await receive('cr1', 'invA', 5000)
    await receive('cr2', 'invA', 3910.01)
    expect(await ledger('invA')).toMatchObject({ seq: 3, receivedCents: 891001, lastEntryKind: 'receipt' })
    const err = await refusedUnchanged(() => voidRelease('u_pm', 'rr1'), A.CODE.CLIENT_RECEIPTS_DEPEND)
    expect(err.details).toMatchObject({ receivedCents: 891001, receivableBasisAfterCents: 891000, number: 'CRR-0001' })
    expect(err.details.blockingReceipts.map(r => ({ number: r.number, id: r.id, allocatedCents: r.allocatedCents }))).toEqual([
      { number: 'CR-1002', id: 'cr2', allocatedCents: 391001 },   // newest first
      { number: 'CR-1001', id: 'cr1', allocatedCents: 500000 },
    ])
    expect(err.code).toBe('failed-precondition')
    expect((await release('rr1')).status).toBe('posted')
    expect(await ledger('invA')).toMatchObject({ seq: 3, releasedRetentionCents: 90000 })
  })

  it('allowed when it does not — at the boundary, exactly equal; drafts, voided receipts and other invoices count nothing', async () => {
    await seedInvoice('invOther', issuedInvoice({ subtotal: 9000, invoiceNumber: 'CI-0007' }))
    await receive('cr1', 'invA', 5000)
    await receive('cr2', 'invA', 3910)
    await draftReceiptFor('cr3', 'invA', 500)                 // a draft: never posted
    await receive('cr4', 'invA', 500)
    await voidReceipt('u_qs', 'cr4')                          // posted, then voided
    await receive('cr5', 'invOther', 9900)
    expect((await ledger('invA')).receivedCents).toBe(891000)
    expect(await voidRelease('u_pm', 'rr1')).toMatchObject({ status: 'void' })
    expect(totalsOf(await ledger('invA'))).toEqual(ZERO)
    expect((await ledger('invA')).receivedCents).toBe(891000)   // the void moves no received figure
  })

  it('a receipt posted afterwards makes the same void refusable; voiding the receipt allows it again', async () => {
    await receive('cr1', 'invA', 9900)
    const err = await refusedUnchanged(() => voidRelease('u_pm', 'rr1'), A.CODE.CLIENT_RECEIPTS_DEPEND)
    expect(err.details.blockingReceipts).toEqual([{ number: 'CR-1001', id: 'cr1', allocatedCents: 990000, postedAt: expect.any(String) }])
    await voidReceipt('u_qs', 'cr1')
    expect((await voidRelease('u_pm', 'rr1')).status).toBe('void')
  })

  // (An invoice whose received figure includes receipts posted BEFORE the backend
  // took over, and a legacy-shaped receipt written after it: clientReceiptBaseline.test.js.)
})

// ── 10. Idempotent retries ───────────────────────────────────────────────────

describe('idempotent retry of an uncertain outcome', () => {
  beforeEach(async () => { await seedA() })

  it('post credit note: the same caller gets the same answer, one ledger movement, one audit event; another caller is refused', async () => {
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    const first = await postCredit('u_pm', 'cn1')
    const before = await dumpAll()
    const again = await postCredit('u_pm', 'cn1')
    expect(again).toEqual({ ...first, alreadyApplied: true })
    expect(changedPaths(before, await dumpAll())).toEqual([])
    await refusedUnchanged(() => postCredit('u_admin', 'cn1'), A.CODE.CLIENT_ENTRY_NOT_DRAFT)
    expect((await ledger('invA')).seq).toBe(1)
    expect(await audits()).toHaveLength(1)
  })

  it('void credit note: same caller and reason → the same answer; a different reason or caller → already void', async () => {
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    await postCredit('u_pm', 'cn1')
    const first = await voidCredit('u_pm', 'cn1', 'Raised in error')
    const before = await dumpAll()
    expect(await voidCredit('u_pm', 'cn1', '  Raised in error ')).toEqual({ ...first, alreadyApplied: true })
    expect(changedPaths(before, await dumpAll())).toEqual([])
    await refusedUnchanged(() => voidCredit('u_pm', 'cn1', 'Another reason'), A.CODE.CLIENT_ENTRY_NOT_POSTED)
    await refusedUnchanged(() => voidCredit('u_admin', 'cn1', 'Raised in error'), A.CODE.CLIENT_ENTRY_NOT_POSTED)
    // A void entry can never be posted, by anyone.
    await refusedUnchanged(() => postCredit('u_pm', 'cn1'), A.CODE.CLIENT_ENTRY_NOT_DRAFT)
    expect((await ledger('invA')).seq).toBe(2)
    expect(await audits()).toHaveLength(2)
  })

  it('post retention release: the same', async () => {
    await draftRelease('rr1', 'invA', 300)
    const first = await postRelease('u_qs', 'rr1')
    const before = await dumpAll()
    expect(await postRelease('u_qs', 'rr1')).toEqual({ ...first, alreadyApplied: true })
    expect(changedPaths(before, await dumpAll())).toEqual([])
    await refusedUnchanged(() => postRelease('u_pm', 'rr1'), A.CODE.CLIENT_ENTRY_NOT_DRAFT)
    expect(await ledger('invA')).toMatchObject({ seq: 1, releasedRetentionCents: 30000 })
    expect(await audits()).toHaveLength(1)
  })

  it('void retention release: the same — and the repeat does not read the receipts again to decide', async () => {
    await draftRelease('rr1', 'invA', 900)
    await postRelease('u_pm', 'rr1')
    const first = await voidRelease('u_pm', 'rr1')
    // A receipt posted since would refuse a NEW void; the repeat is an answer, not a new void.
    await receive('cr1', 'invA', 9900, { acknowledge: true })
    const before = await dumpAll()
    // The receipt has moved the ledger since, so the repeat reports no sequence number.
    expect(await voidRelease('u_pm', 'rr1')).toEqual({ ...first, alreadyApplied: true, seq: null })
    expect(changedPaths(before, await dumpAll())).toEqual([])
    await refusedUnchanged(() => voidRelease('u_admin', 'rr1'), A.CODE.CLIENT_ENTRY_NOT_POSTED)
    expect((await ledger('invA')).seq).toBe(3)   // post, void, then the receipt
    expect(await audits()).toHaveLength(3)
  })

  it('once another entry has moved the ledger, a repeat still answers — with no sequence number it cannot vouch for', async () => {
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    await postCredit('u_pm', 'cn1')
    await draftCredit('cn2', 'invA', [{ invoiceLineIndex: 0, amount: 500 }])
    await postCredit('u_pm', 'cn2')
    expect(await postCredit('u_pm', 'cn1')).toMatchObject({ status: 'posted', creditNoteId: 'cn1', alreadyApplied: true, seq: null })
    expect((await ledger('invA')).seq).toBe(2)
    expect(await audits()).toHaveLength(2)
  })

  it('a draft voided directly by the browser (as the Rules allow) is answered the same way to its own author', async () => {
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    await creditRef('cn1').update({ status: 'void', voidedAt: A.FieldValue.serverTimestamp(), voidedBy: 'u_qs', voidReason: 'Raised in error' })
    expect(await voidCredit('u_qs', 'cn1')).toMatchObject({ status: 'void', alreadyApplied: true, seq: null })
    await refusedUnchanged(() => voidCredit('u_pm', 'cn1'), A.CODE.CLIENT_ENTRY_NOT_POSTED)
    expect(await audits()).toHaveLength(0)
  })
})

// ── 11. A release a later credit depends on ──────────────────────────────────

describe('a release void that a later credit depends on', () => {
  it('is refused by the ledger invariant, and allowed once that credit is voided', async () => {
    await seedA()
    await draftRelease('rr1', 'invA', 900)
    await postRelease('u_pm', 'rr1')
    // With all retention released the whole invoice is receivable, and a full credit falls on the receivable.
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 9000 }])
    expect(await credit('cn1')).toMatchObject({ retentionAmount: 0, retentionGst: 0, receivableTotal: 9900 })
    await postCredit('u_pm', 'cn1')

    const err = await refusedUnchanged(() => voidRelease('u_pm', 'rr1'), A.CODE.CLIENT_LEDGER_INVARIANT)
    expect(err.details.invariant).toBe('Credits against the receivable part exceed what is receivable.')
    // The refusal NAMES what blocks it: the credit note posted after this release.
    expect(err.details.number).toBe('CRR-0001')
    expect(err.details.blockingEntries).toEqual([{ kind: 'credit_note', number: 'CCN-0001', id: 'cn1', postedAt: expect.any(String) }])
    expect((await release('rr1')).status).toBe('posted')
    expect((await ledger('invA')).seq).toBe(2)

    expect((await voidCredit('u_pm', 'cn1')).seq).toBe(3)
    expect((await voidRelease('u_pm', 'rr1')).seq).toBe(4)
    const l = await ledger('invA')
    expect({ seq: l.seq, lastEntryId: l.lastEntryId, lastEntryKind: l.lastEntryKind, ...totalsOf(l) }).toEqual({ seq: 4, lastEntryId: 'rr1', lastEntryKind: 'release_void', ...ZERO })
  })

  it('a posted entry whose ledger is missing cannot be voided (the ledger would go negative)', async () => {
    await seedA()
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    await creditRef('cn1').update({ status: 'posted', postedBy: 'u_pm' })   // not by the backend: no ledger exists
    const err = await refusedUnchanged(() => voidCredit('u_pm', 'cn1'), A.CODE.CLIENT_LEDGER_INVARIANT)
    expect(err.details.invariant).toMatch(/not a whole, non-negative number of cents/)
    expect(err.details.blockingEntries).toEqual([])   // nothing to name: the browser falls back to its generic wording
    expect(await ledger('invA')).toBeNull()
  })

  it('several later entries are named newest first, entries posted BEFORE it and void ones are not; a stale tab gets the same named refusal', async () => {
    await seedA()
    await draftCredit('cn0', 'invA', [{ invoiceLineIndex: 0, amount: 100 }])
    await postCredit('u_pm', 'cn0')                                  // BEFORE the release: never a blocker
    await draftRelease('rr1', 'invA', 890)                           // all the retention still held
    await postRelease('u_pm', 'rr1')
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 8500 }])
    await postCredit('u_pm', 'cn1')
    await draftCredit('cn2', 'invA', [{ invoiceLineIndex: 0, amount: 400 }])
    await postCredit('u_admin', 'cn2')
    // The "stale tab": the caller still believes rr1 is voidable. The answer does not depend on what the tab shows.
    const err = await refusedUnchanged(() => voidRelease('u_qs', 'rr1'), A.CODE.CLIENT_LEDGER_INVARIANT)
    expect(err.details.blockingEntries.map(e => `${e.kind}:${e.number}`)).toEqual(['credit_note:CCN-0003', 'credit_note:CCN-0002'])
    // Void the newest: it is no longer named.
    await voidCredit('u_pm', 'cn2')
    const again = await refusedUnchanged(() => voidRelease('u_qs', 'rr1'), A.CODE.CLIENT_LEDGER_INVARIANT)
    expect(again.details.blockingEntries.map(e => e.number)).toEqual(['CCN-0002'])
    await voidCredit('u_pm', 'cn1')
    expect((await voidRelease('u_qs', 'rr1')).status).toBe('void')
  })
})

// ── 12. Nothing else is written ──────────────────────────────────────────────

describe('what an operation writes', () => {
  it('across all four operations on a populated project: only entries, ledgers and audit events ever change', async () => {
    await seedA()
    await seedM()
    await receive('cr1', 'invA', 100)
    await base().collection('budgetLines').doc('bl1').set({ costCodeId: 'cc1', budgeted: 100, committed: 0, actual: 0 })
    await base().collection('commercial').doc('baseline').set({ originalContractValue: 10000 })
    await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }])
    await draftCredit('cn2', 'invM', [{ invoiceLineIndex: 1, amount: 40.15 }])
    await draftRelease('rr1', 'invM', 10)
    const before = await dumpAll()

    await postCredit('u_pm', 'cn1')
    await postCredit('u_pm', 'cn2')
    await voidCredit('u_pm', 'cn1')
    await draftRelease('rr2', 'invA', 100)
    await resaveRelease('rr1', 'invM', 10)   // cn2 moved invM's ledger: refresh the draft, as a user would
    await postRelease('u_pm', 'rr1')
    await postRelease('u_pm', 'rr2')
    await voidRelease('u_pm', 'rr2')

    const changed = changedPaths(before, await dumpAll())
    const allowed = [/\/clientCreditNotes\/cn[12]$/, /\/clientRetentionReleases\/rr[12]$/, /\/clientInvoiceLedgers\/inv[AM]$/, /^companies\/companyA\/auditEvents\/[^/]+$/, /^companies\/companyA\/counters\/clientRetentionReleases$/]
    expect(changed.filter(p => !allowed.some(re => re.test(p)))).toEqual([])
    // The counter moved only because THIS TEST drafted rr2 through the app's own write.
    expect(changed.filter(p => p.includes('/auditEvents/'))).toHaveLength(6)
    expect(changed.filter(p => p.includes('/clientInvoices/') || p.includes('/clientReceipts/') || p.includes('/budgetLines/') || p.includes('/commercial/') || p.startsWith('users/'))).toEqual([])
  })
})

// ── The callables as deployed ────────────────────────────────────────────────

describe('the callables as deployed (Functions emulator)', () => {
  beforeEach(async () => { await seedA(); await draftCredit('cn1', 'invA', [{ invoiceLineIndex: 0, amount: 1000 }]); await draftRelease('rr1', 'invA', 450) })
  const post = { projectId: PROJECT, creditNoteId: 'cn1' }

  it('a request without an App Check token is refused before the handler runs', async () => {
    const user = await clientSignIn('pm@acme.test')
    for (const name of [...FINANCE_NAMES, 'postClientReceipt', 'voidClientReceipt']) {
      const r = await callFunction(name, post, { idToken: await user.getIdToken(), appCheck: null })
      expect(r.status, name).toBe(401)
      expect(r.error).toMatchObject({ status: 'UNAUTHENTICATED' })
    }
    expect((await credit('cn1')).status).toBe('draft')
  })
  it('an unauthenticated request with App Check gets the typed refusal', async () => {
    const r = await callFunction('postClientCreditNote', post)
    expect(r.status).toBe(401)
    expect(r.error).toMatchObject({ details: { code: 'unauthenticated' } })
  })
  it('an amount in the request is invalid-argument; a draft the server does not derive is figures-changed', async () => {
    const pm = await clientSignIn('pm@acme.test')
    const idToken = await pm.getIdToken()
    const bad = await callFunction('postClientCreditNote', { ...post, amount: 1 }, { idToken })
    expect(bad.status).toBe(400)
    expect(bad.error).toMatchObject({ status: 'INVALID_ARGUMENT', details: { code: 'invalid-argument' } })
    await creditRef('cn1').update({ gstTotal: 0 })
    const forged = await callFunction('postClientCreditNote', post, { idToken })
    expect(forged.status).toBe(400)
    expect(forged.error).toMatchObject({ status: 'FAILED_PRECONDITION', details: { code: 'client-entry-figures-changed', field: 'gstTotal' } })
    expect((await credit('cn1')).status).toBe('draft')
    expect(await ledger('invA')).toBeNull()
  })
  it('a qs posts a release, is refused the now-stale credit note, and voids the release — end to end', async () => {
    const qs = await clientSignIn('qs@acme.test')
    const idToken = await qs.getIdToken()
    const posted = await callFunction('postClientRetentionRelease', { projectId: PROJECT, releaseId: 'rr1' }, { idToken })
    expect(posted.status).toBe(200)
    expect(posted.result).toMatchObject({ status: 'posted', releaseId: 'rr1', invoiceId: 'invA', seq: 1, alreadyApplied: false })
    expect(await ledger('invA')).toMatchObject({ seq: 1, releasedRetentionCents: 45000, releasedRetentionGstCents: 4500, updatedBy: 'u_qs' })

    const stale = await callFunction('postClientCreditNote', post, { idToken })
    expect(stale.error).toMatchObject({ details: { code: 'client-entry-figures-changed', field: 'retentionAmount' } })

    await draftReceiptFor('cr1', 'invA', 9000)
    const noFlag = await callFunction('postClientReceipt', { projectId: PROJECT, receiptId: 'cr1' }, { idToken })
    expect(noFlag.error).toMatchObject({ details: { code: 'invalid-argument' } })
    const received = await callFunction('postClientReceipt', { projectId: PROJECT, receiptId: 'cr1', acknowledgeOverAllocation: false }, { idToken })
    expect(received.status).toBe(200)
    expect(received.result).toMatchObject({ status: 'posted', receiptId: 'cr1', allocatedInvoiceIds: ['invA'], overAllocationAcknowledged: false, alreadyApplied: false })
    const blocked = await callFunction('voidClientRetentionRelease', { projectId: PROJECT, releaseId: 'rr1', reason: 'Agreed in error' }, { idToken })
    expect(blocked.status).toBe(400)
    expect(blocked.error).toMatchObject({ details: {
      code: 'client-receipts-depend-on-release', receivedCents: 900000, receivableBasisAfterCents: 891000, number: 'CRR-0001',
      blockingReceipts: [{ number: 'CR-1001', id: 'cr1', allocatedCents: 900000 }],
    } })
    const unreceived = await callFunction('voidClientReceipt', { projectId: PROJECT, receiptId: 'cr1', reason: 'Keyed twice' }, { idToken })
    expect(unreceived.result).toMatchObject({ status: 'void', receiptId: 'cr1', alreadyApplied: false })
    const voided = await callFunction('voidClientRetentionRelease', { projectId: PROJECT, releaseId: 'rr1', reason: 'Agreed in error' }, { idToken })
    expect(voided.result).toMatchObject({ status: 'void', releaseId: 'rr1', seq: 4 })

    const voidedDraft = await callFunction('voidClientCreditNote', { ...post, reason: 'Not needed' }, { idToken })
    expect(voidedDraft.result).toMatchObject({ status: 'void', creditNoteId: 'cn1', seq: null })
    expect(await audits()).toHaveLength(5)
  })
})
